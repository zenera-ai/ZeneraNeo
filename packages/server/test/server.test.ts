import { EventType, type AGUIEvent } from '@ag-ui/core';
import {
    probeBwrap,
    RootedFs,
    type Sandbox,
    type SandboxFactory,
    type SandboxOptions,
} from '@zenera/sandbox';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, request, type Server } from 'node:http';
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
let running: { server: AgentServer; http: Server; url: string } | undefined;

async function start(opts: Partial<Parameters<typeof createServer>[0]> = {}) {
    await running?.server.stop(1000);
    const stateDir = mkdtempSync(join(root, 'state-'));
    const server = createServer({
        projectId: 'p1',
        projectDir,
        stateDir,
        user: { id: 'local' },
        sandbox: fakeSandbox,
        sandboxProvider: 'fake',
        ...opts,
    });
    const http = await server.listen({ port: 0 });
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

describe('the server', () => {
    it('answers on loopback TCP when asked', async () => {
        const { url, http } = await start();
        expect((http.address() as AddressInfo).address).toBe('127.0.0.1');
        expect((await fetch(`${url}/healthz`)).status).toBe(200);
        expect(await (await fetch(`${url}/api/activity`)).json()).toEqual({ busy: false, runs: 0 });
    });

    it('runs a turn end to end: the model calls run_command, the sandbox runs it', async () => {
        const { url, stateDir } = await start();
        const thread = randomUUID();
        commands.length = 0;
        const res = await fetch(`${url}/api/sessions/${thread}/runs`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
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
        for (let i = 0; i < 50; i++) {
            const a = (await (await fetch(`${url}/api/activity`)).json()) as {
                busy: boolean;
            };
            if (!a.busy) break;
            await new Promise((r) => setTimeout(r, 20));
        }
        const history = await fetch(`${url}/api/sessions/${thread}`);
        const body = (await history.json()) as { events: AGUIEvent[]; running: unknown };
        expect(body.running).toBeNull();
        expect(body.events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);
    });

    it('keeps the debug routes off unless asked for', async () => {
        const thread = randomUUID();
        let { url } = await start();
        expect((await fetch(`${url}/api/sessions/${thread}/runs`)).status).toBe(404);
        ({ url } = await start({ debug: true }));
        expect((await fetch(`${url}/api/sessions/${thread}/runs`)).status).toBe(200);
    });

    it('reports itself', async () => {
        const { url } = await start();
        const status = (await (await fetch(`${url}/api/status`)).json()) as Record<string, unknown>;
        expect(status).toMatchObject({
            project: { id: 'p1', dir: projectDir },
            user: 'local',
            listen: expect.stringMatching(/^tcp:127\.0\.0\.1:\d+$/),
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
            const { url, stateDir } = await start({ sandbox: 'bwrap', sandboxProvider: 'bwrap' });
            // Not under /tmp, which every command has its own of anyway.
            const visible = join(process.cwd(), `.zen-live-state-${randomUUID().slice(0, 8)}`);
            mkdirSync(visible);
            writeFileSync(join(visible, 'state.json'), '{}');
            running!.server.settings.hidden.push(visible);
            script =
                'echo hello; env | grep -c ZEN_SERVER_LIVE_SECRET || true; ' +
                `test -e ${visible}/state.json && echo STATE-SEEN; test -e ${stateDir}/state.json && echo OWN-STATE-SEEN; true`;
            const res = await fetch(`${url}/api/sessions/${randomUUID()}/runs`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ messages: [{ role: 'user', content: 'go' }] }),
            });
            const text = (await events(res))
                .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
                .map((e) => (e as { delta: string }).delta)
                .join('');
            expect(text).toContain('hello');
            expect(text).not.toContain('leaked');
            expect(text).toMatch(/hello\\n0/);
            expect(text).not.toContain('STATE-SEEN');
            rmSync(visible, { recursive: true, force: true });
        } finally {
            script = 'echo hello';
            delete process.env.ZEN_SERVER_LIVE_SECRET;
        }
    });
});

describe('on a Unix socket', () => {
    it('is its owner’s alone, answers there, and is gone when it stops', async () => {
        await running?.server.stop(1000);
        running = undefined;
        const stateDir = mkdtempSync(join(root, 'state-'));
        const socket = join(root, `run-${randomUUID().slice(0, 8)}`, 'server.sock');
        const server = createServer({
            projectId: 'p1',
            projectDir,
            stateDir,
            user: { id: 'local' },
            sandbox: fakeSandbox,
            sandboxProvider: 'fake',
        });
        await server.listen({ socket });
        try {
            expect(statSync(socket).mode & 0o777).toBe(0o600);
            expect(statSync(join(socket, '..')).mode & 0o777).toBe(0o700);
            // Every command the server runs is kept from the socket's directory.
            expect(server.settings.hidden).toContain(join(socket, '..'));
            const answer = await new Promise<{ status?: number; body: string }>((done, fail) => {
                const req = request({ socketPath: socket, path: '/api/status' }, (res) => {
                    let body = '';
                    res.on('data', (c) => (body += c));
                    res.on('end', () => done({ status: res.statusCode, body }));
                });
                req.on('error', fail);
                req.end();
            });
            expect(answer.status).toBe(200);
            expect(JSON.parse(answer.body)).toMatchObject({ listen: `unix:${socket}` });
        } finally {
            await server.stop(1000);
        }
        expect(existsSync(socket)).toBe(false);
    });

    it('refuses a user that is not one', () => {
        expect(() =>
            createServer({ projectId: 'p1', projectDir, stateDir: root, user: { id: '../x' } }),
        ).toThrow(/not a user id/);
    });
});

describe('state.json', () => {
    it('is written once, and refuses a newer layout, another user or another project', () => {
        const dir = mkdtempSync(join(root, 'layout-'));
        const first = openState(dir, { userId: 'a', projectId: 'p' })!;
        expect(first).toMatchObject({ version: STATE_VERSION, userId: 'a', projectId: 'p' });
        expect(openState(dir, { userId: 'a', projectId: 'p' })!.createdAt).toBe(first.createdAt);
        expect(() => openState(dir, { userId: 'b', projectId: 'p' })).toThrow(/belongs to user a/);
        expect(() => openState(dir, { userId: 'a', projectId: 'q' })).toThrow(/project p/);
        writeFileSync(join(dir, 'state.json'), JSON.stringify({ version: STATE_VERSION + 1 }));
        expect(() => openState(dir, { userId: 'a', projectId: 'p' })).toThrow(/newer server/);
    });

    it('is only read by a check, which claims nothing', () => {
        const dir = mkdtempSync(join(root, 'unclaimed-'));
        expect(openState(dir, { userId: 'a', projectId: 'p' }, { create: false })).toBeUndefined();
        expect(existsSync(join(dir, 'state.json'))).toBe(false);
    });

    it('refuses new runs once the server is stopping, and a new server takes them again', async () => {
        const post = (url: string) =>
            fetch(`${url}/api/sessions/${randomUUID()}/runs`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
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
