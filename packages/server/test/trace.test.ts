import { createSessionAt, runPaths } from '@zenera/engine';
import { FilePayloadStore, type AgentState, type TrajectoryNode } from '@zenera/neo';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll as after, test } from 'vitest';
import express from 'express';

const root = mkdtempSync(join(tmpdir(), 'trace-'));
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const { configure, DEFAULTS } = await import('../src/config.ts');
configure({
    ...DEFAULTS,
    projectId: 'project',
    auth: { mode: 'jwt', publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() },
    stateDir: root,
});
const { requireCaller } = await import('../src/auth.ts');
const { errorHandler } = await import('../src/http.ts');
const { traceRouter, MAX_PART_CHARS } = await import('../src/trace.ts');
const { privateStore } = await import('../src/store.ts');
const { startRecord, saveRecord } = await import('../src/runRecords.ts');

const user = '00000000-0000-0000-0000-000000000001';
const thread = '00000000-0000-0000-0000-000000000002';
const other = '00000000-0000-0000-0000-000000000003';
const dir = join(root, 'users', user, 'runs', thread);
const sessionDir = join(root, 'users', user, 'sessions', thread);
const session = createSessionAt(sessionDir, join(sessionDir, 'workspace'));
const blobs = new FilePayloadStore({ dir: session.blobs, id: 'file' });
const put = (text: string) => blobs.put(text);

const usage = { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, reasoningTokens: 0 };
const ts = new Date().toISOString();
const base = (id: string, agent = 'main') => ({ id, ts, agent });
const big = 'x'.repeat(MAX_PART_CHARS + 10);

// Turn 1: two trunk nodes. Turn 2 starts at trunk index 2 and forks into one branch.
const trajectory: TrajectoryNode[] = [
    {
        ...base('a1'),
        type: 'user_input',
        content: [{ type: 'text', text: await put('first question') }],
    },
    {
        ...base('a2'),
        type: 'llm_call',
        model: 'test/model',
        requestDigest: 'd',
        text: await put('first answer'),
        toolCalls: [],
        usage,
        stopReason: 'stop',
    },
    {
        ...base('b1'),
        type: 'user_input',
        content: [
            { type: 'text', text: await put('second question') },
            {
                type: 'image',
                url: `data:image/png;base64,${'A'.repeat(5000)}`,
                mimeType: 'image/png',
            },
        ],
    },
    {
        ...base('b2'),
        type: 'llm_call',
        model: 'test/model',
        requestDigest: 'd',
        request: await put(JSON.stringify({ messages: ['whole conversation'] })),
        text: await put(''),
        thinking: await put('let me look'),
        toolCalls: [{ callId: 'c1', name: 'read_file', args: await put('{"path":"a.txt"}') }],
        usage,
        stopReason: 'tool_calls',
    },
    {
        ...base('b3'),
        type: 'tool_call',
        callId: 'c1',
        name: 'read_file',
        args: await put('{"path":"a.txt"}'),
    },
    {
        ...base('b4'),
        type: 'tool_result',
        callId: 'c1',
        name: 'read_file',
        result: await put(big),
        isError: true,
        durationMs: 12,
    },
    {
        ...base('b5'),
        type: 'join',
        callId: 'f1',
        usage,
        branches: [
            {
                name: 'research',
                agent: 'helper',
                status: 'ok',
                output: await put('branch output'),
                usage,
                nodes: [
                    // Same id as a trunk node: steps are addressed by index, never by id.
                    { ...base('b2', 'helper'), type: 'handoff', from: 'helper', to: 'main' },
                ],
            },
        ],
    },
    {
        ...base('b6'),
        type: 'llm_call',
        model: 'test/model',
        requestDigest: 'd',
        request: { store: 'file', sha256: 'f'.repeat(64), size: 99 },
        text: await put('final answer'),
        toolCalls: [],
        usage,
        stopReason: 'stop',
    },
];

const state: AgentState = {
    version: 1,
    runId: 'session-run',
    spec: { startAgent: 'main', forkDepth: 0, maxForkDepth: 4 },
    agentName: 'main',
    phase: 'done',
    trajectory,
    pendingToolCalls: [],
    usage,
};

function recordRun(runId: string, engineRunId: string, trajectoryStart?: number) {
    const record = startRecord(dir, runId);
    record.status = 'finished';
    record.engineRunId = engineRunId;
    if (trajectoryStart !== undefined) record.trajectoryStart = trajectoryStart;
    saveRecord(dir, record);
    const paths = runPaths(session, engineRunId);
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.state, JSON.stringify(state));
}
recordRun('turn-2', '20261027-120000-abcd', 2);
recordRun('legacy', '20261027-120000-beef');
const unrecorded = startRecord(dir, 'unrecorded');
unrecorded.status = 'error';
saveRecord(dir, unrecorded);
recordRun('corrupt', '20261027-120000-dead', 0);
writeFileSync(runPaths(session, '20261027-120000-dead').state, '{"not":"a state"}');

const app = express();
app.use(requireCaller('zenera-runtime'));
app.use('/api/sessions', traceRouter(privateStore));
app.use(errorHandler);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address !== 'string');
const origin = `http://127.0.0.1:${address.port}`;
after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
    );
    rmSync(root, { recursive: true, force: true });
});

function token(target: string, sub = user, thr = thread): string {
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const data = `${encode({ alg: 'EdDSA', typ: 'JWT' })}.${encode({
        iss: 'zenera-app',
        aud: 'zenera-runtime',
        sub,
        thr,
        prj: 'project',
        role: 'editor',
        req: `GET ${target}`,
        iat: now,
        exp: now + 60,
    })}`;
    return `${data}.${sign(null, Buffer.from(data), privateKey).toString('base64url')}`;
}

function get(target: string, sub = user, thr = thread) {
    const headers = new Headers();
    headers.set('authorization', `Bearer ${token(target, sub, thr)}`);
    return fetch(`${origin}${target}`, { headers });
}

const path = (run: string, rest = '') => `/api/sessions/${thread}/runs/${run}/trace${rest}`;

test('turn scope lists only this turn, fork branches nested under their join', async () => {
    const res = await get(path('turn-2'));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const page = await res.json();
    assert.equal(page.scope, 'turn');
    assert.equal(page.turnAvailable, true);
    assert.equal(page.engineRunId, '20261027-120000-abcd');
    assert.deepEqual(
        page.steps.map((s: { id: string; index: number; depth: number }) => [
            s.id,
            s.index,
            s.depth,
        ]),
        [
            ['b1', 2, 0],
            ['b2', 3, 0],
            ['b3', 4, 0],
            ['b4', 5, 0],
            ['b5', 6, 0],
            ['b2', 7, 1],
            ['b6', 8, 0],
        ],
    );
    const branchStep = page.steps[5];
    assert.equal(branchStep.branch, 'research');
    assert.equal(branchStep.type, 'handoff');
    const call = page.steps[1];
    assert.deepEqual(call.tools, ['read_file']);
    assert.equal(call.model, 'test/model');
    assert.deepEqual(call.usage, usage);
    assert.equal(page.steps[3].isError, true);
    assert.equal(page.steps[3].durationMs, 12);
    assert.equal(page.counts.llm_call, 2);
    assert.equal(page.total, 7);
    // Listing carries no payload content.
    assert.doesNotMatch(JSON.stringify(page), /second question|let me look|xxxx/);
});

test('session scope, type filter and paging', async () => {
    const session = await (await get(path('turn-2', '?scope=session'))).json();
    assert.equal(session.total, 9);
    assert.equal(session.steps[0].id, 'a1');
    const calls = await (await get(path('turn-2', '?scope=session&types=llm_call'))).json();
    assert.deepEqual(
        calls.steps.map((s: { id: string }) => s.id),
        ['a2', 'b2', 'b6'],
    );
    assert.equal(calls.counts.user_input, 2);
    const paged = await (await get(path('turn-2', '?scope=session&offset=2&limit=2'))).json();
    assert.deepEqual(
        paged.steps.map((s: { index: number }) => s.index),
        [2, 3],
    );
    assert.equal(paged.total, 9);
});

test('runs recorded before turn boundaries fall back to the session', async () => {
    const page = await (await get(path('legacy'))).json();
    assert.equal(page.turnAvailable, false);
    assert.equal(page.scope, 'session');
    assert.equal(page.total, 9);
});

test('step detail resolves payloads, defers the request, clips large parts', async () => {
    const input = await (await get(path('turn-2', '/2'))).json();
    assert.equal(input.parts[0].text, 'second question');
    assert.match(input.parts[1].text, /image\/png \(inline data, \d+ characters\)/);
    assert.doesNotMatch(input.parts[1].text, /AAAA/);

    const call = await (await get(path('turn-2', '/3'))).json();
    const byKey = Object.fromEntries(call.parts.map((p: { key: string }) => [p.key, p])) as Record<
        string,
        { text?: string; deferred?: boolean; bytes?: number; json?: unknown }
    >;
    assert.equal(byKey.thinking.text, 'let me look');
    assert.equal(byKey['toolCalls.0'].text, '{"path":"a.txt"}');
    assert.equal(byKey.request.deferred, true);
    assert.equal(byKey.request.text, undefined);
    assert.ok(byKey.request.bytes! > 0);

    const request = await (await get(path('turn-2', '/3?part=request'))).json();
    assert.match(request.part.text, /whole conversation/);

    const result = await (await get(path('turn-2', '/5'))).json();
    const output = result.parts.find((p: { key: string }) => p.key === 'result');
    assert.equal(output.truncated, true);
    assert.equal(output.text.length, MAX_PART_CHARS);
    assert.equal(output.label, 'Error output');

    const branch = await (await get(path('turn-2', '/7'))).json();
    assert.equal(branch.step.branch, 'research');
    assert.equal(branch.step.type, 'handoff');

    const join = await (await get(path('turn-2', '/6'))).json();
    assert.ok(join.parts.some((p: { text?: string }) => p.text === 'branch output'));
});

test('a missing blob is reported on its part, not as a failed step', async () => {
    const res = await get(path('turn-2', '/8?part=request'));
    assert.equal(res.status, 200);
    const { part } = await res.json();
    assert.match(part.error, /payload unavailable/);
    const detail = await (await get(path('turn-2', '/8'))).json();
    assert.equal(detail.parts.find((p: { key: string }) => p.key === 'text').text, 'final answer');
});

test('invalid input and missing recordings are explicit errors', async () => {
    assert.equal((await get(path('turn-2', '?scope=all'))).status, 400);
    assert.equal((await get(path('turn-2', '?types=bogus'))).status, 400);
    assert.equal((await get(path('turn-2', '?limit=0'))).status, 400);
    assert.equal((await get(path('turn-2', '?limit=501'))).status, 400);
    assert.equal((await get(path('turn-2', '?extra=1'))).status, 400);
    assert.equal((await get(path('turn-2', '/abc'))).status, 400);
    assert.equal((await get(path('turn-2', '/99'))).status, 404);
    assert.equal((await get(path('turn-2', '/2?part=request'))).status, 404);
    assert.equal((await get(path('turn-2', '/3?part=text'))).status, 400);
    assert.equal((await get(path('missing'))).status, 404);
    assert.equal((await get(path('unrecorded'))).status, 404);
    assert.equal((await get(path('corrupt'))).status, 500);
    assert.equal((await get(path('bad%2Fid'))).status, 400);
});

test('traces enforce the signed caller and per-user isolation', async () => {
    const target = path('turn-2');
    assert.equal((await fetch(`${origin}${target}`)).status, 401);
    assert.equal((await get(target, user, other)).status, 403);
    // Another user asking for the same thread id finds nothing of this user's.
    assert.equal((await get(target, other)).status, 404);
    assert.equal((await get(path('turn-2', '/3'), other)).status, 404);
});
