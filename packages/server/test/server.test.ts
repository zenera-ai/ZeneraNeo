import { EventType, type AGUIEvent } from '@ag-ui/core';
import {
    bwrapSandbox,
    probeBwrap,
    RootedFs,
    type Sandbox,
    type SandboxFactory,
    type SandboxOptions,
} from '@zenera/sandbox';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
    createServer,
    openState,
    STATE_VERSION,
    stopAllRuns,
    type AgentServer,
} from '../src/index.ts';

// The server end to end: a project whose one agent runs a command, a model that is a local
// OpenAI-compatible endpoint scripted to call `run_command` once and then answer, and a sandbox
// that records what it was asked. Over real HTTP, as zenera-app or ZeneraSrv would call it.

const root = mkdtempSync(join(tmpdir(), 'zen-server-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
process.env.ZENERA_HOME = join(root, 'zenera-home');

const USER = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';

// --- a model: call run_command, then answer with what it printed ---------------------------
let script = 'echo hello';
const model = createHttpServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as {
        messages: { role: string; content?: unknown }[];
        stream?: boolean;
    };
    const tool = body.messages.findLast((m) => m.role === 'tool');
    const delta = tool
        ? { role: 'assistant', content: `done: ${String(tool.content).slice(0, 200)}` }
        : {
              role: 'assistant',
              tool_calls: [
                  {
                      index: 0,
                      id: 'call_1',
                      type: 'function',
                      function: {
                          name: 'run_command',
                          arguments: JSON.stringify({ command: script }),
                      },
                  },
              ],
          };
    const finish = tool ? 'stop' : 'tool_calls';
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = (choices: unknown[], extra = {}) =>
            res.write(
                `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'fake', choices, ...extra })}\n\n`,
            );
        chunk([{ index: 0, delta, finish_reason: null }]);
        chunk([{ index: 0, delta: {}, finish_reason: finish }]);
        chunk([], { usage });
        res.end('data: [DONE]\n\n');
        return;
    }
    const message = { ...delta, content: (delta as { content?: string }).content ?? null };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
        JSON.stringify({
            id: 'c1',
            object: 'chat.completion',
            created: 1,
            model: 'fake',
            choices: [{ index: 0, message, finish_reason: finish }],
            usage,
        }),
    );
});
model.listen(0, '127.0.0.1');
await once(model, 'listening');
afterAll(() => model.close());
const modelUrl = `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`;
process.env.ZEN_TEST_MODEL_KEY = 'test';
// The engine refuses to start with no provider key at all; the project's own is named above.
process.env.OPENAI_API_KEY ??= 'test';

// --- a project ------------------------------------------------------------------------------
const projectDir = join(root, 'project');
mkdirSync(projectDir, { recursive: true });
writeFileSync(
    join(projectDir, 'agents.yaml'),
    [
        'version: 1',
        'providers:',
        '    local:',
        '        kind: openai-compatible',
        `        baseURL: ${modelUrl}`,
        '        apiKeyEnv: ZEN_TEST_MODEL_KEY',
        'agents:',
        '    - name: main',
        '      model: local:fake',
        '      tools: [run_command]',
        '',
    ].join('\n'),
);

// --- a sandbox that records the commands ----------------------------------------------------
const commands: string[] = [];
const fakeSandbox: SandboxFactory = (opts: SandboxOptions): Sandbox => {
    let started = false;
    return {
        name: `fake-${opts.key}`,
        fs: new RootedFs([{ at: opts.workdir ?? '/workspace', dir: opts.root }]),
        get started() {
            return started;
        },
        prepare: async () => undefined,
        start: async () => {
            started = true;
        },
        exec: async (command) => {
            started = true;
            commands.push(command);
            return { exit_code: 0, stdout: 'hello\n', stderr: '', duration_ms: 1 };
        },
        startJob: async () => 'job-1',
        readJob: async () => {
            throw new Error('no jobs');
        },
        stopJob: async () => ({ job_id: 'job-1', stopped: true }),
        close: async () => {
            started = false;
        },
    };
};

// --- servers ---------------------------------------------------------------------------------
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

function jwt(claims: Record<string, unknown>): string {
    const now = Math.floor(Date.now() / 1000);
    const head = b64({ alg: 'EdDSA', typ: 'JWT' });
    const body = b64({
        iss: 'zenera-app',
        aud: 'zenera-runtime',
        iat: now,
        exp: now + 60,
        ...claims,
    });
    const sig = sign(null, Buffer.from(`${head}.${body}`), privateKey).toString('base64url');
    return `${head}.${body}.${sig}`;
}

let running: { server: AgentServer; http: Server; url: string } | undefined;

async function start(opts: Partial<Parameters<typeof createServer>[0]> = {}) {
    await running?.server.stop(1000);
    const stateDir = mkdtempSync(join(root, 'state-'));
    const server = createServer({
        projectId: 'p1',
        projectDir,
        stateDir,
        auth: { mode: 'token', token: 'secret' },
        userId: 'local',
        sandbox: fakeSandbox,
        sandboxProvider: 'fake',
        ...opts,
    });
    const http = await server.listen(0, '127.0.0.1');
    running = { server, http, url: `http://127.0.0.1:${(http.address() as AddressInfo).port}` };
    return { ...running, stateDir };
}
afterEach(async () => {
    await running?.server.stop(1000);
    running = undefined;
});

/** A run's events, read off its server-sent stream to the end. */
async function events(res: Response): Promise<AGUIEvent[]> {
    const text = await res.text();
    return text
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => JSON.parse(l.slice(6)) as AGUIEvent);
}

describe('token auth (ZeneraSrv, a laptop)', () => {
    it('answers /healthz to anyone, everything else only with the token', async () => {
        const { url } = await start();
        expect((await fetch(`${url}/healthz`)).status).toBe(200);
        expect((await fetch(`${url}/api/activity`)).status).toBe(401);
        const wrong = await fetch(`${url}/api/activity`, {
            headers: { authorization: 'Bearer nope' },
        });
        expect(wrong.status).toBe(401);
        const ok = await fetch(`${url}/api/activity`, {
            headers: { authorization: 'Bearer secret' },
        });
        expect(await ok.json()).toEqual({ busy: false, runs: 0 });
    });

    it('runs a turn end to end: the model calls run_command, the sandbox runs it', async () => {
        const { url, stateDir } = await start();
        const thread = randomUUID();
        commands.length = 0;
        const res = await fetch(`${url}/api/sessions/${thread}/runs`, {
            method: 'POST',
            headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
            body: JSON.stringify({ messages: [{ id: 'm1', role: 'user', content: 'say hello' }] }),
        });
        if (res.status !== 200) throw new Error(await res.text());
        const evs = await events(res);
        const types = evs.map((e) => e.type);
        expect(types[0]).toBe(EventType.RUN_STARTED);
        expect(types).toContain(EventType.TOOL_CALL_START);
        expect(types.at(-1)).toBe(EventType.RUN_FINISHED);
        const text = evs
            .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
            .map((e) => (e as { delta: string }).delta)
            .join('');
        expect(text).toContain('done:');
        expect(text).toContain('hello');
        expect(commands).toEqual(['echo hello']);

        // A single-user server keeps everything under data/.
        expect(existsSync(join(stateDir, 'data', 'sessions', thread, '.data', 'state.json'))).toBe(
            true,
        );
        expect(existsSync(join(stateDir, 'data', 'runs', thread))).toBe(true);
        expect(existsSync(join(stateDir, 'users'))).toBe(false);

        // The stream ends with the run's last event; the run lets go of the thread just after.
        const auth = { authorization: 'Bearer secret' };
        for (let i = 0; i < 50; i++) {
            const a = (await (await fetch(`${url}/api/activity`, { headers: auth })).json()) as {
                busy: boolean;
            };
            if (!a.busy) break;
            await new Promise((r) => setTimeout(r, 20));
        }
        const history = await fetch(`${url}/api/sessions/${thread}`, { headers: auth });
        const body = (await history.json()) as { events: AGUIEvent[]; running: unknown };
        expect(body.running).toBeNull();
        expect(body.events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);
    });

    it('keeps the debug routes off unless asked for', async () => {
        const thread = randomUUID();
        let { url } = await start();
        const auth = { authorization: 'Bearer secret' };
        expect((await fetch(`${url}/api/sessions/${thread}/runs`, { headers: auth })).status).toBe(
            404,
        );
        ({ url } = await start({ debug: true }));
        expect((await fetch(`${url}/api/sessions/${thread}/runs`, { headers: auth })).status).toBe(
            200,
        );
    });

    it('reports itself', async () => {
        const { url } = await start();
        const status = (await (
            await fetch(`${url}/api/status`, { headers: { authorization: 'Bearer secret' } })
        ).json()) as Record<string, unknown>;
        expect(status).toMatchObject({
            project: { id: 'p1', dir: projectDir },
            user: 'local',
            auth: 'token',
            debug: false,
            sandbox: { provider: 'fake', ok: true },
            state: { version: STATE_VERSION, supported: STATE_VERSION },
        });
    });
});

const bwrap = await probeBwrap();

describe.runIf(bwrap.ok)('with bwrap (Linux)', () => {
    it('runs the model’s command under bwrap, with nothing of the server’s environment', async () => {
        process.env.ZEN_SERVER_LIVE_SECRET = 'leaked';
        try {
            const { url } = await start({ sandbox: bwrapSandbox, sandboxProvider: 'bwrap' });
            script = 'echo hello; env | grep -c ZEN_SERVER_LIVE_SECRET || true';
            const res = await fetch(`${url}/api/sessions/${randomUUID()}/runs`, {
                method: 'POST',
                headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
                body: JSON.stringify({ messages: [{ role: 'user', content: 'go' }] }),
            });
            const text = (await events(res))
                .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
                .map((e) => (e as { delta: string }).delta)
                .join('');
            expect(text).toContain('hello');
            expect(text).not.toContain('leaked');
            expect(text).toMatch(/hello\\n0/);
        } finally {
            script = 'echo hello';
            delete process.env.ZEN_SERVER_LIVE_SECRET;
        }
    });
});

describe('jwt auth (zenera-app)', () => {
    const target = (thread: string) => `GET /api/sessions/${thread}`;

    it('takes a token for this request, this project and this server’s user', async () => {
        const { url } = await start({ auth: { mode: 'jwt', publicKey: publicPem }, userId: USER });
        const thread = randomUUID();
        const get = (claims: Record<string, unknown>) =>
            fetch(`${url}/api/sessions/${thread}`, {
                headers: { authorization: `Bearer ${jwt(claims)}` },
            });
        const mine = { sub: USER, prj: 'p1', thr: thread, role: 'owner', req: target(thread) };
        expect((await get(mine)).status).toBe(200);
        expect((await get({ ...mine, sub: OTHER })).status).toBe(403);
        expect((await get({ ...mine, prj: 'p2' })).status).toBe(403);
        expect((await get({ ...mine, req: 'GET /api/activity' })).status).toBe(401);
    });

    it('serves any user under users/<id>/ when it has no user of its own', async () => {
        const { url, stateDir } = await start({
            auth: { mode: 'jwt', publicKey: publicPem },
            userId: undefined,
        });
        const thread = randomUUID();
        const res = await fetch(`${url}/api/sessions/${thread}`, {
            method: 'DELETE',
            headers: {
                authorization: `Bearer ${jwt({ sub: OTHER, prj: 'p1', thr: thread, role: 'owner', req: `DELETE /api/sessions/${thread}` })}`,
            },
        });
        if (res.status !== 204) throw new Error(await res.text());
        const state = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'));
        expect(state).toMatchObject({ version: STATE_VERSION, projectId: 'p1', mode: 'shared' });
        expect(state.userId).toBeUndefined();
    });
});

describe('state.json', () => {
    it('is written once, and refuses a newer layout, another user or another project', () => {
        const dir = mkdtempSync(join(root, 'layout-'));
        const first = openState(dir, { userId: 'a', projectId: 'p' })!;
        expect(first).toMatchObject({ version: STATE_VERSION, mode: 'single', userId: 'a' });
        expect(openState(dir, { userId: 'a', projectId: 'p' })!.createdAt).toBe(first.createdAt);
        expect(() => openState(dir, { userId: 'b', projectId: 'p' })).toThrow(/belongs to user a/);
        expect(() => openState(dir, { userId: 'a', projectId: 'q' })).toThrow(/project p/);
        expect(() => openState(dir, { projectId: 'p' })).toThrow(/one user's state/);
        writeFileSync(join(dir, 'state.json'), JSON.stringify({ version: STATE_VERSION + 1 }));
        expect(() => openState(dir, { projectId: 'p' })).toThrow(/newer server/);
    });

    it('keeps a shared directory from any single user, and a read-only look claims nothing', () => {
        const dir = mkdtempSync(join(root, 'shared-'));
        expect(openState(dir, { projectId: 'p' }, { create: false })).toBeUndefined();
        expect(existsSync(join(dir, 'state.json'))).toBe(false);
        expect(openState(dir, { projectId: 'p' })).toMatchObject({ mode: 'shared' });
        expect(() => openState(dir, { userId: 'bob', projectId: 'p' })).toThrow(/many users/);
    });

    it('refuses new runs once the server is stopping, and a new server takes them again', async () => {
        const post = (url: string) =>
            fetch(`${url}/api/sessions/${randomUUID()}/runs`, {
                method: 'POST',
                headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
                body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
            });
        const first = await start();
        await stopAllRuns(10); // what stop() does before the listener is gone
        const refused = await post(first.url);
        expect(refused.status).toBe(503);
        const again = await start();
        const res = await post(again.url);
        expect(res.status).toBe(200);
        await res.text();
    });
});
