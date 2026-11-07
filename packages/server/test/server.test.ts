/**
 * Vitest end-to-end coverage for the multi-user HTTP runtime and standalone-chat API.
 * start creates test servers; signed/call create per-request JWT requests, and
 * events/turn consume AG-UI runs against a scripted local model and fake sandbox.
 * The server suite checks authentication, private state, sessions, run lifecycle,
 * insecure HTTP chat serving, local-file CORS and optional live bwrap execution.
 */
import { EventType, type AGUIEvent } from '@ag-ui/core';
import {
    probeBwrap,
    runProcess,
    RootedFs,
    type Sandbox,
    type SandboxFactory,
    type SandboxOptions,
} from '@zenera/sandbox';
import { MemoryStore, isMemory } from '@zenera/neo';
import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { once } from 'node:events';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
    createServer,
    LAYOUT_VERSION,
    openLayout,
    SEED_FILE,
    stopAllRuns,
    unsignedToken,
    userFolder,
    userMemory,
    type AgentServer,
    type ServerOptions,
} from '../src/index.ts';

// The server end to end: a project whose one agent runs a command, a model that is a local
// OpenAI-compatible endpoint scripted to call `run_command` once and then answer, and a sandbox
// that records what it was asked. Over real HTTP, with tokens signed per request as zenera-app
// signs them, for more than one user.

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
const roots: string[] = [];
const fakeSandbox: SandboxFactory = (opts: SandboxOptions): Sandbox => {
    let started = false;
    roots.push(opts.root);
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
// One signing key, as zenera-app has; the server is given only its public half.
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const PROJECT = 'p1';
const ANN = 'ann';
const BOB = '00000000-0000-4000-8000-0000000000b0';

function signed(claims: Record<string, unknown>, key: KeyObject = privateKey): string {
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const head = b64({ alg: 'EdDSA', typ: 'JWT' });
    const body = b64({
        iss: 'zenera-app',
        aud: 'zenera-runtime',
        iat: now,
        exp: now + 60,
        prj: PROJECT,
        ...claims,
    });
    return `${head}.${body}.${sign(null, Buffer.from(`${head}.${body}`), key).toString('base64url')}`;
}

let running: { server: AgentServer; http: Server; url: string; insecure: boolean } | undefined;

/** fetch, as `user`, with a token for exactly this request: signed, or not for --insecure. */
function call(url: string, init: RequestInit & { as?: string; claims?: object } = {}) {
    const { as = ANN, claims = {}, ...rest } = init;
    const target = new URL(url);
    const req = `${rest.method ?? 'GET'} ${target.pathname}${target.search}`;
    const token = running?.insecure
        ? unsignedToken({ sub: as, ...claims })
        : signed({ sub: as, req, ...claims });
    return fetch(url, {
        ...rest,
        headers: { authorization: `Bearer ${token}`, ...(rest.headers as Record<string, string>) },
    });
}

async function start(opts: Partial<ServerOptions> = {}) {
    await running?.server.stop(1000);
    const serverRoot = mkdtempSync(join(root, 'root-'));
    const server = createServer({
        projectId: PROJECT,
        projectDir,
        root: serverRoot,
        auth: {
            mode: 'jwt',
            publicKey: PUBLIC_PEM,
            issuer: 'zenera-app',
            audience: 'zenera-runtime',
        },
        sandbox: fakeSandbox,
        sandboxProvider: 'fake',
        ...opts,
    });
    const http = await server.listen({ port: 0 });
    running = {
        server,
        http,
        url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
        insecure: server.settings.auth.mode === 'insecure',
    };
    return { ...running, serverRoot };
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

const textOf = (evs: AGUIEvent[]) =>
    evs
        .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
        .map((e) => (e as { delta: string }).delta)
        .join('');

async function turn(url: string, thread: string, as = ANN, content = 'say hello') {
    const res = await call(`${url}/api/sessions/${thread}/runs`, {
        method: 'POST',
        as,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ id: 'm1', role: 'user', content }] }),
    });
    const evs = await events(res);
    // The stream ends with the run's last event; the run lets go of the thread just after.
    for (let i = 0; i < 50 && running && (await activity(url)); i++) {
        await new Promise((r) => setTimeout(r, 20));
    }
    return { status: res.status, evs };
}

async function activity(url: string): Promise<boolean> {
    const a = (await (await call(`${url}/api/activity`)).json()) as { busy: boolean };
    return a.busy;
}

describe('a turn', () => {
    it('runs end to end: the model calls run_command, the sandbox runs it', async () => {
        const { url, serverRoot } = await start();
        const thread = randomUUID();
        commands.length = 0;
        const { status, evs } = await turn(url, thread);
        expect(status).toBe(200);
        const types = evs.map((e) => e.type);
        expect(types[0]).toBe(EventType.RUN_STARTED);
        expect(types).toContain(EventType.TOOL_CALL_START);
        expect(types.at(-1)).toBe(EventType.RUN_FINISHED);
        expect(textOf(evs)).toContain('done:');
        expect(commands).toEqual(['echo hello']);

        // Under the user's own folder, a session laid out as `zen run` lays one out.
        const session = join(serverRoot, 'users', ANN, 'sessions', thread);
        expect(existsSync(join(session, '.data', 'state.json'))).toBe(true);
        expect(existsSync(join(session, 'workspace'))).toBe(true);
        expect(existsSync(join(session, 'agui'))).toBe(true);
        expect(JSON.parse(readFileSync(join(serverRoot, 'server.json'), 'utf8'))).toMatchObject({
            version: LAYOUT_VERSION,
            projectId: PROJECT,
        });

        const history = await call(`${url}/api/sessions/${thread}`);
        const body = (await history.json()) as { events: AGUIEvent[]; running: unknown };
        expect(body.running).toBeNull();
        expect(body.events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);
    });

    describe('session listing', () => {
        it('lists only real sessions belonging to the caller, newest first, with metadata', async () => {
            const { url, serverRoot } = await start();
            const empty = await call(`${url}/api/sessions`);
            expect(await empty.json()).toEqual({ sessions: [] });
            expect(existsSync(join(serverRoot, 'users', ANN))).toBe(false);
            const first = randomUUID();
            const second = randomUUID();
            const other = randomUUID();
            await turn(url, first, ANN, 'First chat');
            await turn(url, second, ANN, 'Second chat');
            await turn(url, other, BOB, 'Private chat');
            const path = join(serverRoot, 'users', ANN, 'sessions', first, '.data', 'session.json');
            const meta = JSON.parse(readFileSync(path, 'utf8'));
            writeFileSync(path, JSON.stringify({ ...meta, lastRunAt: '2000-01-01T00:00:00.000Z' }));
            mkdirSync(join(serverRoot, 'users', ANN, 'sessions', 'not-a-session'));
            const listed = await call(`${url}/api/sessions`);
            const { sessions } = await listed.json();
            expect(sessions.map((s: { id: string }) => s.id)).toEqual([second, first]);
            expect(sessions[0]).toMatchObject({ title: 'Second chat', running: null });
            expect(sessions[0].createdAt).toEqual(expect.any(String));
            expect(sessions[0].updatedAt).toEqual(expect.any(String));
            const scoped = await call(`${url}/api/sessions`, { claims: { thr: first } });
            expect((await scoped.json()).sessions.map((s: { id: string }) => s.id)).toEqual([
                first,
            ]);
            await call(`${url}/api/sessions/${second}`, { method: 'DELETE' });
            expect((await (await call(`${url}/api/sessions`)).json()).sessions).toHaveLength(1);
            expect((await fetch(`${url}/api/sessions`)).status).toBe(401);
        });
        it('reports a run that is still active', async () => {
            let release!: () => void;
            let notify!: () => void;
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            const entered = new Promise<void>((resolve) => {
                notify = resolve;
            });
            const { url } = await start({
                sandbox: (opts) => ({
                    ...fakeSandbox(opts),
                    exec: async () => {
                        notify();
                        await gate;
                        return { exit_code: 0, stdout: 'hello\n', stderr: '', duration_ms: 1 };
                    },
                }),
            });
            const thread = randomUUID();
            const response = await call(`${url}/api/sessions/${thread}/runs`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ messages: [{ id: 'm1', role: 'user', content: 'hello' }] }),
            });
            try {
                await entered;
                const { sessions } = await (await call(`${url}/api/sessions`)).json();
                expect(sessions).toHaveLength(1);
                expect(sessions[0]).toMatchObject({
                    id: thread,
                    running: { runId: expect.any(String) },
                });
            } finally {
                release();
                await events(response);
            }
        });
    });

    describe('local-file CORS', () => {
        const headers = {
            origin: 'null',
            'access-control-request-method': 'POST',
            'access-control-request-headers': 'authorization, content-type',
            'access-control-request-private-network': 'true',
        };
        it('allows local-file preflights only in insecure mode; actual requests still need a token', async () => {
            const { url } = await start({ auth: { mode: 'insecure' } });
            const preflight = await fetch(`${url}/api/sessions/test/runs`, {
                method: 'OPTIONS',
                headers,
            });
            expect(preflight.status).toBe(204);
            expect(preflight.headers.get('access-control-allow-origin')).toBe('null');
            expect(preflight.headers.get('access-control-allow-headers')).toContain(
                'authorization',
            );
            expect(preflight.headers.get('access-control-allow-private-network')).toBe('true');
            expect(preflight.headers.get('access-control-allow-credentials')).toBeNull();
            const missing = await fetch(`${url}/api/sessions`, { headers: { origin: 'null' } });
            expect(missing.status).toBe(401);
            expect(missing.headers.get('access-control-allow-origin')).toBe('null');
            const valid = await call(`${url}/api/sessions`, { headers: { origin: 'null' } });
            expect(valid.status).toBe(200);
            expect(valid.headers.get('access-control-allow-origin')).toBe('null');
            const web = await fetch(`${url}/api/sessions`, {
                method: 'OPTIONS',
                headers: { ...headers, origin: 'https://example.com' },
            });
            expect(web.status).toBe(401);
            expect(web.headers.get('access-control-allow-origin')).toBeNull();
            const unsupported = await fetch(`${url}/api/sessions`, {
                method: 'OPTIONS',
                headers: { ...headers, 'access-control-request-method': 'PUT' },
            });
            expect(unsupported.status).toBe(403);
            const unsupportedHeader = await fetch(`${url}/api/sessions`, {
                method: 'OPTIONS',
                headers: { ...headers, 'access-control-request-headers': 'x-secret' },
            });
            expect(unsupportedHeader.status).toBe(403);
        });
        it('does not bypass JWT authentication or enable CORS in secure mode', async () => {
            const { url } = await start();
            const preflight = await fetch(`${url}/api/sessions`, { method: 'OPTIONS', headers });
            expect(preflight.status).toBe(401);
            expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
            const valid = await call(`${url}/api/sessions`, { headers: { origin: 'null' } });
            expect(valid.status).toBe(200);
            expect(valid.headers.get('access-control-allow-origin')).toBeNull();
        });
    });

    it('keeps each user’s chats in their own folder: another user finds nothing', async () => {
        const { url, serverRoot } = await start();
        const thread = randomUUID();
        await turn(url, thread, ANN);
        const theirs = (await (
            await call(`${url}/api/sessions/${thread}`, { as: BOB })
        ).json()) as {
            events: unknown[];
        };
        expect(theirs.events).toEqual([]);
        await turn(url, thread, BOB);
        expect(existsSync(join(serverRoot, 'users', ANN, 'sessions', thread))).toBe(true);
        expect(existsSync(join(serverRoot, 'users', BOB, 'sessions', thread))).toBe(true);
        // Deleting Bob's thread leaves Ann's.
        expect(
            (await call(`${url}/api/sessions/${thread}`, { method: 'DELETE', as: BOB })).status,
        ).toBe(204);
        expect(existsSync(join(serverRoot, 'users', ANN, 'sessions', thread))).toBe(true);
    });

    it('keeps the debug routes off unless asked for', async () => {
        const thread = randomUUID();
        let { url } = await start();
        expect((await call(`${url}/api/sessions/${thread}/runs`)).status).toBe(404);
        ({ url } = await start({ debug: true }));
        expect((await call(`${url}/api/sessions/${thread}/runs`)).status).toBe(200);
    });

    it('reports itself', async () => {
        const { url, serverRoot } = await start();
        const status = (await (await call(`${url}/api/status`)).json()) as Record<string, unknown>;
        expect(status).toMatchObject({
            project: { id: PROJECT, dir: projectDir },
            auth: 'jwt',
            listen: expect.stringMatching(/^127\.0\.0\.1:\d+$/),
            debug: false,
            sandbox: { provider: 'fake', ok: true },
            root: { dir: serverRoot, version: LAYOUT_VERSION, supported: LAYOUT_VERSION },
        });
    });
});

describe('jwt', () => {
    const get = async (url: string, token?: string) =>
        (await fetch(url, token ? { headers: { authorization: `Bearer ${token}` } } : {})).status;

    it('takes a token signed for this project and this very request, and nothing else', async () => {
        const { url } = await start();
        const target = `/api/sessions/${randomUUID()}`;
        const req = `GET ${target}`;
        expect(await get(`${url}/healthz`)).toBe(200);
        expect(await get(`${url}${target}`)).toBe(401);
        expect(await get(`${url}${target}`, signed({ sub: ANN, req }))).toBe(200);
        // Another key, project, request, issuer or audience; too old; no user; not signed.
        const other = generateKeyPairSync('ed25519').privateKey;
        expect(await get(`${url}${target}`, signed({ sub: ANN, req }, other))).toBe(401);
        expect(await get(`${url}${target}`, signed({ sub: ANN, req, prj: 'p2' }))).toBe(403);
        expect(await get(`${url}${target}`, signed({ sub: ANN, req: 'GET /api/status' }))).toBe(
            401,
        );
        expect(await get(`${url}${target}`, signed({ sub: ANN, req, iss: 'evil' }))).toBe(401);
        expect(await get(`${url}${target}`, signed({ sub: ANN, req, aud: 'other' }))).toBe(401);
        const old = Math.floor(Date.now() / 1000) - 600;
        expect(
            await get(`${url}${target}`, signed({ sub: ANN, req, iat: old, exp: old + 60 })),
        ).toBe(401);
        expect(await get(`${url}${target}`, signed({ req }))).toBe(401);
        expect(await get(`${url}${target}`, unsignedToken({ sub: ANN, req, prj: PROJECT }))).toBe(
            401,
        );
    });

    it('holds a token to its thread when it names one', async () => {
        const { url } = await start();
        const thread = randomUUID();
        expect(
            (await call(`${url}/api/sessions/${thread}`, { claims: { thr: thread } })).status,
        ).toBe(200);
        expect(
            (await call(`${url}/api/sessions/${thread}`, { claims: { thr: randomUUID() } })).status,
        ).toBe(403);
    });

    it('turns any user id into one safe folder', () => {
        expect(userFolder('ann')).toBe('ann');
        expect(userFolder(BOB.toUpperCase())).toBe(BOB);
        for (const id of ['../x', 'a/b', '.hidden', 'x'.repeat(200), 'ann smith']) {
            expect(userFolder(id)).toMatch(/^u-[0-9a-f]{32}$/);
        }
    });

    it('refuses to start without the key its tokens are signed for', () => {
        expect(() =>
            createServer({
                projectId: PROJECT,
                projectDir,
                root: mkdtempSync(join(root, 'nokey-')),
                auth: { mode: 'jwt', publicKey: '', issuer: 'i', audience: 'a' },
            }),
        ).toThrow(/public key/);
    });
});

describe('insecure', () => {
    const chatPage = join(root, 'chat.html');
    const chatHtml = '<!doctype html><title>Test chat fixture</title>';
    writeFileSync(chatPage, chatHtml);

    it('serves only the configured chat file without a token; APIs still require one', async () => {
        const { url } = await start({ auth: { mode: 'insecure' }, chatPage });
        const response = await fetch(`${url}/chat`);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('text/html');
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(await response.text()).toBe(chatHtml);
        expect((await fetch(`${url}/api/sessions`)).status).toBe(401);
        expect((await fetch(`${url}/chat.html`)).status).toBe(401);
        expect((await call(`${url}/chat/other-file`, { as: 'alice' })).status).toBe(404);
    });

    it('does not expose the chat page in secure mode, even when configured', async () => {
        const { url } = await start({ chatPage });
        expect((await fetch(`${url}/chat`)).status).toBe(401);
        expect((await call(`${url}/chat`, { as: 'alice' })).status).toBe(404);
    });

    it('does not expose a chat route without a configured page', async () => {
        const { url } = await start({ auth: { mode: 'insecure' } });
        expect((await fetch(`${url}/chat`)).status).toBe(401);
        expect((await call(`${url}/chat`, { as: 'alice' })).status).toBe(404);
    });

    it('reads a token without checking it, and still wants a user', async () => {
        const { url } = await start({ auth: { mode: 'insecure' } });
        const target = `${url}/api/sessions/${randomUUID()}`;
        const as = (token: string) =>
            fetch(target, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.status);
        expect(await as(unsignedToken({ sub: 'carol' }))).toBe(200);
        // Any signature, any key, any age, any request: only read.
        const other = generateKeyPairSync('ed25519').privateKey;
        expect(await as(signed({ sub: 'carol', req: 'GET /nowhere', exp: 1, iat: 0 }, other))).toBe(
            200,
        );
        expect(await as(unsignedToken({ role: 'owner' }))).toBe(401);
        expect(await as('not-a-token')).toBe(401);
    });

    it('listens on loopback only', async () => {
        const server = createServer({
            projectId: PROJECT,
            projectDir,
            root: mkdtempSync(join(root, 'insecure-')),
            auth: { mode: 'insecure' },
        });
        await expect(server.listen({ port: 0, host: '0.0.0.0' })).rejects.toThrow(/loopback/);
    });
});

describe('memory', () => {
    const seedDir = join(root, 'seed');

    async function seed(): Promise<void> {
        const store = await MemoryStore.open(seedDir);
        await store.commit();
        store.release();
        writeFileSync(join(seedDir, 'marker'), 'seed');
    }

    it('copies the seed once per user, the first time they need it, and never touches it', async () => {
        await seed();
        const { serverRoot } = await start({ memorySeed: seedDir });
        // SQLite's write-ahead files appear on any open, a read-only one included.
        const listing = () =>
            readdirSync(seedDir)
                .filter((n) => !/-(wal|shm)$/.test(n))
                .sort();
        const before = listing();
        const [a1, a2] = await Promise.all([userMemory('ann'), userMemory('ann')]);
        expect(a1).toBe(join(serverRoot, 'users', 'ann', 'memory'));
        expect(a2).toBe(a1);
        expect(isMemory(a1)).toBe(true);
        expect(JSON.parse(readFileSync(join(a1, SEED_FILE), 'utf8'))).toMatchObject({
            seed: seedDir,
        });
        const bob = await userMemory('bob');
        expect(bob).not.toBe(a1);
        expect(isMemory(bob)).toBe(true);
        // Ann's graph is hers: a change to it is not Bob's, nor the seed's.
        writeFileSync(join(a1, 'mine'), 'ann');
        expect(existsSync(join(bob, 'mine'))).toBe(false);
        expect(listing()).toEqual(before);
        expect(readFileSync(join(seedDir, 'marker'), 'utf8')).toBe('seed');
        expect(
            readdirSync(join(serverRoot, 'users', 'ann')).filter((n) => n.includes('.copy-')),
        ).toEqual([]);
    });

    it('leaves a user with nothing when there is no seed', async () => {
        const { serverRoot } = await start({ memorySeed: null });
        const dir = await userMemory('dan');
        expect(dir).toBe(join(serverRoot, 'users', 'dan', 'memory'));
        expect(existsSync(dir)).toBe(false);
    });

    it('refuses a seed in the old layout', async () => {
        const old = mkdtempSync(join(root, 'old-seed-'));
        writeFileSync(join(old, 'graph.json'), '{}');
        await start({ memorySeed: old });
        await expect(userMemory('eve')).rejects.toThrow(/version 1/);
    });
});

describe('the root', () => {
    it('is this project’s: another one, or a newer layout, is refused', () => {
        const dir = mkdtempSync(join(root, 'layout-'));
        expect(openLayout(dir, 'p', { create: false })).toBeUndefined();
        expect(existsSync(join(dir, 'server.json'))).toBe(false);
        const first = openLayout(dir, 'p')!;
        expect(openLayout(dir, 'p')!.createdAt).toBe(first.createdAt);
        expect(() => openLayout(dir, 'q')).toThrow(/project p/);
        writeFileSync(
            join(dir, 'server.json'),
            JSON.stringify({ version: LAYOUT_VERSION + 1, projectId: 'p' }),
        );
        expect(() => openLayout(dir, 'p')).toThrow(/newer server/);
    });
});

const bwrap = await probeBwrap();

describe.runIf(bwrap.ok)('with bwrap (Linux)', () => {
    it('runs the model’s command under bwrap, seeing no one’s chats and no token', async () => {
        process.env.ZEN_SERVER_LIVE_SECRET = 'leaked';
        try {
            const { url, serverRoot } = await start({ sandbox: 'bwrap', sandboxProvider: 'bwrap' });
            // Not under /tmp, which every command has its own of anyway.
            const visible = join(process.cwd(), `.zen-live-state-${randomUUID().slice(0, 8)}`);
            mkdirSync(visible);
            writeFileSync(join(visible, 'server.json'), '{}');
            running!.server.settings.hidden.push(visible);
            const port = new URL(url).port;
            script =
                'echo hello; env | grep -c ZEN_SERVER_LIVE_SECRET || true; ' +
                `test -e ${visible}/server.json && echo ROOT-SEEN; test -e ${serverRoot}/server.json && echo OWN-ROOT-SEEN; ` +
                `node -e "fetch('http://127.0.0.1:${port}/api/activity').then(r => console.log('server says', r.status))"; ` +
                'python3 -c "import zenera; print(\'lib\', zenera.identity().id)" 2>&1 || true; ' +
                "node -e \"console.log('nodelib', require('zenera').identity().id)\" 2>&1 || true";
            const { evs } = await turn(url, randomUUID());
            const text = textOf(evs);
            expect(text).toContain('hello');
            expect(text).toMatch(/hello\\n0/);
            expect(text).not.toContain('ROOT-SEEN');
            // The command reaches the port, and is refused: it can make no token.
            expect(text).toContain('server says 401');
            // The one shared library, from /opt/zenera/runtime, answers for the caller.
            expect(text).toContain(`nodelib ${ANN}`);
            rmSync(visible, { recursive: true, force: true });
        } finally {
            script = 'echo hello';
            delete process.env.ZEN_SERVER_LIVE_SECRET;
        }
    });
});

const podman = await runProcess('podman', ['info', '--format', '{{.Host.OS}}'], {
    timeoutMs: 30_000,
}).then(
    (r) => r.code === 0,
    () => false,
);

describe.runIf(podman)('with podman (as zen run)', () => {
    it('runs the model’s command in a container, with the shared library and nothing of the server’s', async () => {
        process.env.ZEN_SERVER_LIVE_SECRET = 'leaked';
        try {
            const { url } = await start({ sandbox: 'podman', sandboxProvider: 'podman' });
            script =
                'echo hello from podman; env | grep -c ZEN_SERVER_LIVE_SECRET || true; ' +
                'python3 -c "import zenera; print(\'lib\', zenera.identity().id)"';
            const { evs } = await turn(url, randomUUID());
            const text = textOf(evs);
            expect(
                text,
                JSON.stringify(evs.filter((e) => e.type === EventType.RUN_ERROR)),
            ).toContain('hello from podman');
            expect(text).toMatch(/podman\\n0/);
            expect(text).toContain(`lib ${ANN}`);
        } finally {
            script = 'echo hello';
            delete process.env.ZEN_SERVER_LIVE_SECRET;
        }
    }, 600_000);
});

describe('stopping', () => {
    it('refuses new runs once the server is stopping, and a new server takes them again', async () => {
        const first = await start();
        await stopAllRuns(10); // what stop() does before the listener is gone
        expect((await turn(first.url, randomUUID())).status).toBe(503);
        const again = await start();
        expect((await turn(again.url, randomUUID())).status).toBe(200);
    });
});
