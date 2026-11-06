import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll as after, test } from 'vitest';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherUserId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const threadId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const emptyUserId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const testRoot = join(tmpdir(), `zen-memory-runtime-${randomUUID()}`);
const dataDir = join(testRoot, 'data');
const projectDir = join(testRoot, 'project');

const { configure, DEFAULTS } = await import('../src/config.ts');
// One server per user: each request is served as the user it names, from that user's own state.
const serveAs = (id: string) =>
    configure({
        ...DEFAULTS,
        token: 'x'.repeat(32),
        projectId: 'memory-test',
        user: { id },
        stateDir: join(dataDir, 'users', id),
        projectDir,
    });
const memoryOf = (id: string) => join(dataDir, 'users', id, 'data', 'memory');
serveAs(userId);
process.env.ZENERA_HOME = join(testRoot, 'zenera-home');

const { MAX_CONTENT_BYTES, MAX_GREP_FILE_BYTES, MemoryStore } = await import('@zenera/neo');
const express = (await import('express')).default;
const { errorHandler } = await import('../src/http.ts');
const { memoryRouter, setRecallEmbedderFactory } = await import('../src/memory.ts');
const { privateStore } = await import('../src/store.ts');
const { MemoryIndex, embeddingResponse } = await import('@zenera/neo');

after(() => rmSync(testRoot, { recursive: true, force: true }));

type Caller = { userId?: string };

function snapshot(dir: string): Record<string, string> {
    const result: Record<string, string> = {};
    if (!existsSync(dir)) return result;
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        // SQLite's write-ahead log and shared-memory index appear on any open,
        // a read-only one included; what must not change is the database and files/.
        if (name.endsWith('.db-wal') || name.endsWith('.db-shm')) continue;
        if (name === 'files') {
            Object.assign(
                result,
                Object.fromEntries(
                    readdirSync(path).map((child) => [
                        `files/${child}`,
                        readFileSync(join(path, child), 'base64'),
                    ]),
                ),
            );
        } else {
            result[name] = readFileSync(path, 'base64');
        }
    }
    return result;
}

async function seedMemory(dir: string): Promise<void> {
    const store = await MemoryStore.open(dir);
    const older = '2025-01-01T00:00:00.000Z';
    const newer = '2025-01-02T00:00:00.000Z';
    store.graph.add({ id: 'old', kind: 'fact', text: 'needle old entry', audience: ['*'] }, older);
    store.graph.add(
        {
            id: 'new',
            kind: 'fact',
            text: 'needle current entry',
            audience: ['*'],
            metadata: { ref: 'needle-42' },
        },
        newer,
    );
    store.graph.add(
        {
            id: 'file-node',
            kind: 'file',
            text: 'file summary',
            audience: ['team'],
            file: {
                path: '/memory/file-node.txt',
                bytes: 15,
                sha256: '0'.repeat(64),
                format: 'txt',
            },
        },
        newer,
    );
    store.graph.add(
        {
            id: 'missing-file',
            kind: 'file',
            text: 'missing body summary',
            audience: ['*'],
            file: {
                path: '/memory/missing.txt',
                bytes: 12,
                sha256: '1'.repeat(64),
                format: 'txt',
            },
        },
        newer,
    );
    for (const id of ['binary-file', 'oversized-file']) {
        store.graph.add(
            {
                id,
                kind: 'file',
                text: `${id} summary`,
                audience: ['*'],
                file: {
                    path: `/memory/${id}.txt`,
                    // Deliberately false: the readers must bound actual bytes.
                    bytes: 1,
                    sha256: '2'.repeat(64),
                    format: 'txt',
                },
            },
            newer,
        );
    }
    store.graph.link('new', 'old', 'SUPERSEDES', newer);
    store.graph.link('new', 'file-node', 'INFORMED', newer);
    mkdirSync(join(dir, 'files'), { recursive: true });
    writeFileSync(join(dir, 'files', 'file-node.txt'), 'a readable file');
    writeFileSync(join(dir, 'files', 'binary-file.txt'), Buffer.from('needle\0binary'));
    writeFileSync(
        join(dir, 'files', 'oversized-file.txt'),
        'needle'.padEnd(Math.max(MAX_CONTENT_BYTES, MAX_GREP_FILE_BYTES) + 1, 'x'),
    );
    await store.commit();
    store.release();
}

test('memory inspection is signed, isolated, bounded, and read-only', async () => {
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
        join(projectDir, 'agents.yaml'),
        'agents:\n  - name: memory-agent\n    memory:\n      access: read\n',
    );
    const memoryDir = memoryOf(userId);
    await seedMemory(memoryDir);
    const before = snapshot(memoryDir);
    const emptyStore = await MemoryStore.open(memoryOf(emptyUserId));
    await emptyStore.commit();
    emptyStore.release();

    const app = express();
    app.use('/api/sessions', memoryRouter(privateStore));
    app.use(errorHandler);
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;

    async function get(path: string, caller: Caller = {}) {
        serveAs(caller.userId ?? userId);
        const response = await fetch(`${origin}${path}`);
        return {
            status: response.status,
            body: (await response.json()) as Record<string, any>,
        };
    }

    try {
        const overview = await get(`/api/sessions/${threadId}/memory`);
        assert.equal(overview.status, 200);
        assert.deepEqual(overview.body.status, 'ready');
        assert.deepEqual(overview.body.stats, {
            nodes: 6,
            edges: 2,
            superseded: 1,
            files: 4,
        });
        assert.deepEqual(overview.body.kinds, ['fact', 'file']);
        assert.deepEqual(overview.body.audiences, ['*', 'team']);
        const emptyOverview = await get(`/api/sessions/${threadId}/memory`, {
            userId: emptyUserId,
        });
        assert.equal(emptyOverview.body.status, 'ready');
        assert.deepEqual(emptyOverview.body.stats, {
            nodes: 0,
            edges: 0,
            superseded: 0,
            files: 0,
        });

        const page = await get(`/api/sessions/${threadId}/memory/nodes?kind=fact&limit=1`);
        assert.equal(page.body.found, 1);
        assert.equal(page.body.truncated, false);
        assert.equal(page.body.nodes[0].id, 'new');
        const auditPage = await get(
            `/api/sessions/${threadId}/memory/nodes?kind=fact&includeSuperseded=true&limit=1`,
        );
        assert.equal(auditPage.body.found, 2);
        assert.equal(auditPage.body.truncated, true);
        const offsetPage = await get(
            `/api/sessions/${threadId}/memory/nodes?kind=fact&all=true&limit=1&offset=1`,
        );
        assert.equal(offsetPage.body.offset, 1);
        assert.equal(offsetPage.body.found, 2);
        assert.equal(offsetPage.body.nodes[0].id, 'old');
        assert.equal(offsetPage.body.nodes[0].stale, true);
        assert.equal(offsetPage.body.truncated, false);

        const detail = await get(`/api/sessions/${threadId}/memory/nodes/file-node`);
        assert.equal(detail.status, 200);
        assert.equal(detail.body.node.content, 'a readable file');
        assert.equal(detail.body.edges.length, 1);
        const missing = await get(`/api/sessions/${threadId}/memory/nodes/missing-file`);
        assert.equal(missing.body.node.omitted, 'missing');
        for (const [nodeId, reason] of [
            ['binary-file', 'binary'],
            ['oversized-file', 'too-big'],
        ]) {
            const omitted = await get(`/api/sessions/${threadId}/memory/nodes/${nodeId}`);
            assert.equal(omitted.status, 200);
            assert.equal(omitted.body.node.omitted, reason);
            assert.equal(omitted.body.node.content, undefined);
            assert.equal(omitted.body.node.image, undefined);
        }
        const absent = await get(`/api/sessions/${threadId}/memory/nodes/not-there`);
        assert.equal(absent.status, 404);

        const grep = await get(
            `/api/sessions/${threadId}/memory/grep?query=needle&in=text&limit=1`,
        );
        assert.equal(grep.status, 200);
        assert.equal(grep.body.found, 1);
        assert.equal(grep.body.matches.length, 1);
        assert.equal(grep.body.truncated, false);
        const allGrep = await get(
            `/api/sessions/${threadId}/memory/grep?query=needle&in=text&all=true&limit=1`,
        );
        assert.equal(allGrep.body.found, 2);
        assert.equal(allGrep.body.truncated, true);
        assert.equal(allGrep.body.matches[0].stale, false);
        const metadataGrep = await get(
            `/api/sessions/${threadId}/memory/grep?query=needle-42&in=metadata`,
        );
        assert.equal(metadataGrep.body.found, 1);
        assert.equal(metadataGrep.body.matches[0].hits[0].where, 'metadata');
        const fileGrep = await get(`/api/sessions/${threadId}/memory/grep?query=readable&in=file`);
        assert.equal(fileGrep.body.found, 1);
        assert.equal(fileGrep.body.matches[0].hits[0].where, 'file');
        const caseSensitive = await get(
            `/api/sessions/${threadId}/memory/grep?query=NEEDLE&in=text&caseSensitive=true`,
        );
        assert.equal(caseSensitive.body.found, 0);
        const caseInsensitive = await get(
            `/api/sessions/${threadId}/memory/grep?query=NEEDLE&in=text`,
        );
        assert.equal(caseInsensitive.body.found, 1);
        const skipped = await get(
            `/api/sessions/${threadId}/memory/grep?query=nothing&in=file&kind=file`,
        );
        assert.equal(skipped.body.found, 0);
        assert.deepEqual(
            skipped.body.skipped.map((file: { id: string; reason: string }) => ({
                id: file.id,
                reason: file.reason,
            })),
            [
                { id: 'missing-file', reason: 'missing' },
                { id: 'binary-file', reason: 'binary' },
                { id: 'oversized-file', reason: 'too-big' },
            ],
        );

        assert.equal(
            (await get(`/api/sessions/${threadId}/memory/grep?query=%28%3F%3D&regex=true`)).status,
            400,
        );
        assert.equal((await get(`/api/sessions/${threadId}/memory/nodes?limit=1000`)).status, 400);
        assert.equal((await get(`/api/sessions/${threadId}/memory/grep?query=%20`)).status, 400);
        for (const suffix of [
            '/nodes?limit=0',
            '/nodes?offset=-1',
            '/nodes?all=yes',
            '/nodes?limit=1&limit=2',
            '/nodes?dir=arbitrary',
            '/grep?query=x&in=unknown',
            '/grep?query=x&in=text,text',
            '/grep?query=x&caseSensitive=1',
            `/grep?query=${'x'.repeat(201)}`,
        ]) {
            assert.equal((await get(`/api/sessions/${threadId}/memory${suffix}`)).status, 400);
        }
        for (const suffix of ['/nodes', '/nodes/new', '/grep?query=x', '/report']) {
            assert.equal(
                (await get(`/api/sessions/${threadId}/memory${suffix}`, { userId: otherUserId }))
                    .status,
                suffix === '/nodes/new' || suffix === '/report' ? 404 : 200,
            );
        }

        const otherUser = await get(`/api/sessions/${threadId}/memory`, { userId: otherUserId });
        assert.equal(otherUser.status, 200);
        assert.equal(otherUser.body.status, 'not-created');
        assert.equal(existsSync(memoryOf(otherUserId)), false);
        assert.equal(existsSync(join(dataDir, 'users', otherUserId)), false);

        const report = await get(`/api/sessions/${threadId}/memory/report`);
        assert.equal(report.status, 200);
        assert.match(report.body.html, /memory-data/);
        assert.equal(report.body.html.includes(memoryDir), false);

        writeFileSync(join(projectDir, 'agents.yaml'), 'agents:\n  - name: memory-agent\n');
        const disabled = await get(`/api/sessions/${threadId}/memory`);
        assert.equal(disabled.body.status, 'disabled');

        assert.deepEqual(snapshot(memoryDir), before);
        assert.equal(existsSync(join(memoryDir, '.lock')), false);

        writeFileSync(
            join(projectDir, 'agents.yaml'),
            'agents:\n  - name: memory-agent\n    memory:\n      access: read\n',
        );
        const writer = await MemoryStore.open(memoryDir);
        try {
            const lockedSnapshot = snapshot(memoryDir);
            assert.equal((await get(`/api/sessions/${threadId}/memory`)).status, 200);
            assert.equal((await get(`/api/sessions/${threadId}/memory/nodes/new`)).status, 200);
            assert.deepEqual(snapshot(memoryDir), lockedSnapshot);
        } finally {
            writer.release();
        }
        assert.deepEqual(snapshot(memoryDir), before);

        writeFileSync(join(projectDir, 'agents.yaml'), 'agents: invalid');
        const invalidConfig = await get(`/api/sessions/${threadId}/memory`);
        assert.equal(invalidConfig.status, 422);
        assert.match(invalidConfig.body.error, /invalid project configuration/);

        const corruptDir = memoryOf(otherUserId);
        mkdirSync(corruptDir, { recursive: true });
        writeFileSync(
            join(projectDir, 'agents.yaml'),
            'agents:\n  - name: memory-agent\n    memory:\n      access: read\n',
        );
        writeFileSync(join(corruptDir, 'memory.db'), 'not a database');
        const corrupt = await get(`/api/sessions/${threadId}/memory`, { userId: otherUserId });
        assert.ok(corrupt.status >= 422, `status ${corrupt.status}`);
        assert.ok(corrupt.body.error);
    } finally {
        await new Promise<void>((resolve, reject) =>
            server.close((err) => (err ? reject(err) : resolve())),
        );
        rmSync(testRoot, { recursive: true, force: true });
    }
});

const recallUserId = '11111111-1111-4111-8111-111111111111';
const vectorUserId = '22222222-2222-4222-8222-222222222222';
const MEMORY_AGENTS = 'agents:\n  - name: memory-agent\n    memory:\n      access: read\n';

async function seedRecallMemory(dir: string): Promise<void> {
    const store = await MemoryStore.open(dir);
    const older = '2025-01-01T00:00:00.000Z';
    const newer = '2025-01-02T00:00:00.000Z';
    const add = (id: string, kind: string, text: string, audience: string[], at = newer) =>
        store.graph.add({ id, kind, text, audience }, at);
    add('deploy-old', 'fact', 'deploy uses blue green rollout', ['*'], older);
    add('deploy-new', 'fact', 'deploy uses canary rollout', ['*']);
    add('runbook', 'snippet', 'kubectl rollout restart for deploy', ['ops']);
    add('secret', 'fact', 'deploy credentials rotate weekly', ['team']);
    add('checklist', 'plan', 'preflight steps before shipping', ['*']);
    add('lunch', 'fact', 'lunch menu on tuesday', ['*']);
    store.graph.link('deploy-new', 'deploy-old', 'SUPERSEDES', newer);
    store.graph.link('deploy-new', 'checklist', 'INFORMED', newer);
    await store.commit();
    store.release();
}

// Two axes, so "meaning" is checkable without a provider: shipping vs food.
function fakeEmbedder(id = 'fake/axes', embed?: () => Promise<never>) {
    return {
        id,
        embed:
            embed ??
            (async (req: { input: string[] }) =>
                embeddingResponse(
                    req.input.map((text) => [
                        /deploy|ship|rollout|release/i.test(text) ? 1 : 0,
                        /lunch|food|eat|menu/i.test(text) ? 1 : 0,
                        0.01,
                    ]),
                    req as never,
                )),
    };
}

async function seedVectorMemory(dir: string): Promise<void> {
    const store = await MemoryStore.open(dir);
    const index = new MemoryIndex({ store, embedder: fakeEmbedder() as never });
    let n = 0;
    await index.commit(
        {
            nodes: [
                { ref: 'a', kind: 'fact', text: 'canary release process', audience: ['*'] },
                { ref: 'b', kind: 'fact', text: 'the cafeteria food options', audience: ['*'] },
            ],
        },
        {
            writes: ['*'],
            sees: ['*'],
            clock: {
                newId: () => `v${++n}`,
                now: () => '2025-01-03T00:00:00.000Z',
            },
        },
    );
    await store.commit();
    store.release();
}

test('memory recall ranks, stitches, masks, and stays read-only', async () => {
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'agents.yaml'), MEMORY_AGENTS);
    const memoryDir = memoryOf(recallUserId);
    const vectorDir = memoryOf(vectorUserId);
    await seedRecallMemory(memoryDir);
    await seedVectorMemory(vectorDir);
    const before = snapshot(memoryDir);
    const vectorsBefore = snapshot(vectorDir);
    // Read through the store: the counters live in its database now.
    const usage = async () => {
        const store = await MemoryStore.open(memoryDir, { readOnly: true });
        try {
            return store.graph.nodes().map((n) => [n.id, n.lastUsedAt, n.useCount]);
        } finally {
            store.release();
        }
    };
    const usageBefore = await usage();

    const app = express();
    app.use('/api/sessions', memoryRouter(privateStore));
    app.use(errorHandler);
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const base = `/api/sessions/${threadId}/memory/recall`;

    async function recall(qs: string, caller: Caller = { userId: recallUserId }) {
        serveAs(caller.userId ?? recallUserId);
        const response = await fetch(`${origin}${base}${qs}`);
        return {
            status: response.status,
            cache: response.headers.get('cache-control'),
            body: (await response.json()) as Record<string, any>,
        };
    }
    const ids = (body: Record<string, any>) =>
        body.nodes.map((n: { node: { id: string } }) => n.node.id).sort();

    try {
        const full = await recall('?query=deploy%20rollout');
        assert.equal(full.status, 200);
        assert.equal(full.cache, 'no-store');
        assert.equal(full.body.status, 'ready');
        assert.deepEqual(full.body.ranking, {
            by: 'term overlap',
            reason: 'this memory holds no vectors',
        });
        assert.deepEqual(full.body.sees, ['*', 'ops', 'team']);
        assert.deepEqual(full.body.query, {
            text: 'deploy rollout',
            limit: 10,
            hops: 2,
            nodes: 25,
        });
        assert.ok(full.body.seeds.includes('deploy-new'));
        assert.ok(full.body.seeds.includes('runbook'));
        assert.ok(full.body.seeds.includes('secret'));
        assert.ok(!ids(full.body).includes('deploy-old'), 'superseded nodes are dropped');
        assert.ok(!ids(full.body).includes('lunch'));
        const checklist = full.body.nodes.find(
            (n: { node: { id: string } }) => n.node.id === 'checklist',
        );
        assert.ok(checklist, 'a hop reaches the linked plan');
        assert.equal(checklist.seed, false);
        assert.deepEqual(checklist.via, {
            from: 'deploy-new',
            relation: 'INFORMED',
            outbound: true,
        });
        assert.ok(
            full.body.edges.some(
                (e: { source: string; target: string }) =>
                    e.source === 'deploy-new' && e.target === 'checklist',
            ),
        );
        assert.ok(full.body.nodes.every((n: { stale: boolean }) => n.stale === false));
        assert.equal(typeof full.body.block, 'string');
        assert.match(full.body.block, /canary/);
        assert.doesNotMatch(full.body.block, /memory-recollection/);

        const seedsOnly = await recall('?query=deploy%20rollout&hops=0');
        assert.equal(seedsOnly.status, 200);
        assert.ok(seedsOnly.body.nodes.length > 0);
        assert.ok(seedsOnly.body.nodes.every((n: { seed: boolean }) => n.seed));
        assert.deepEqual(ids(seedsOnly.body), [...seedsOnly.body.seeds].sort());

        const limited = await recall('?query=deploy%20rollout&hops=0&limit=1');
        assert.equal(limited.body.seeds.length, 1);
        assert.equal(limited.body.nodes.length, 1);

        const snippets = await recall('?query=deploy%20rollout&kind=snippet&hops=0');
        assert.equal(snippets.status, 200);
        assert.deepEqual(snippets.body.seeds, ['runbook']);
        assert.equal(snippets.body.query.kind, 'snippet');

        const masked = await recall('?query=deploy%20rollout&audience=ops');
        assert.equal(masked.status, 200);
        assert.deepEqual(masked.body.sees, ['ops', '*']);
        assert.ok(ids(masked.body).includes('runbook'));
        assert.ok(!ids(masked.body).includes('secret'));
        assert.ok(masked.body.nodes.length < full.body.nodes.length);
        const outsider = await recall('?query=deploy%20rollout&audience=nobody');
        assert.ok(!ids(outsider.body).includes('runbook'));
        assert.ok(!ids(outsider.body).includes('secret'));

        const audit = await recall('?query=deploy%20rollout&all=true');
        const old = audit.body.nodes.find(
            (n: { node: { id: string } }) => n.node.id === 'deploy-old',
        );
        assert.ok(old, 'all=true brings back the superseded node');
        assert.equal(old.stale, true);

        const strict = await recall('?query=deploy%20rollout&minScore=1');
        assert.equal(strict.status, 200);
        assert.equal(strict.body.query.minScore, 1);
        assert.ok(strict.body.nodes.length <= full.body.nodes.length);

        const capped = await recall('?query=deploy%20rollout&nodes=1');
        assert.equal(capped.body.nodes.length, 1);

        for (const qs of [
            '',
            '?query=',
            '?query=%20%20',
            `?query=${'x'.repeat(501)}`,
            '?query=x&query=y',
            '?query=x&limit=0',
            '?query=x&limit=26',
            '?query=x&limit=1.5',
            '?query=x&hops=5',
            '?query=x&hops=-1',
            '?query=x&nodes=0',
            '?query=x&nodes=51',
            '?query=x&minScore=1.5',
            '?query=x&minScore=abc',
            '?query=x&minScore=-0.1',
            '?query=x&all=yes',
            `?query=x&kind=${'k'.repeat(65)}`,
            `?query=x&audience=${'a'.repeat(65)}`,
            '?query=x&audience=',
            '?query=x&kind=unknown',
            '?query=x&dir=/etc',
            '?query=x&text=y',
        ]) {
            assert.equal((await recall(qs)).status, 400, qs);
        }
        assert.equal((await recall(`?query=${'x'.repeat(500)}`)).status, 200);

        const stranger = await recall('?query=deploy', { userId: otherUserId });
        assert.equal(stranger.status, 200);
        assert.deepEqual(stranger.body, {
            status: 'not-created',
            ranking: { by: 'term overlap' },
            sees: [],
            query: { text: 'deploy', limit: 10, hops: 2, nodes: 25 },
            seeds: [],
            truncated: false,
            nodes: [],
            edges: [],
            block: '',
        });
        assert.equal(existsSync(join(dataDir, 'users', otherUserId)), false);

        // Vectors present: the run's resolution finds no declared model.
        const undeclared = await recall('?query=deploy', { userId: vectorUserId });
        assert.equal(undeclared.status, 200);
        assert.deepEqual(undeclared.body.ranking, {
            by: 'term overlap',
            reason: 'the project declares no embedding model',
        });

        setRecallEmbedderFactory(() => {
            throw new Error('no such provider');
        });
        const unbuildable = await recall('?query=deploy', { userId: vectorUserId });
        assert.equal(unbuildable.status, 200);
        assert.equal(unbuildable.body.ranking.by, 'term overlap');
        assert.match(unbuildable.body.ranking.reason, /no such provider/);

        setRecallEmbedderFactory(() => fakeEmbedder() as never);
        const meaning = await recall('?query=shipping&hops=0&limit=1', { userId: vectorUserId });
        assert.equal(meaning.status, 200);
        assert.deepEqual(meaning.body.ranking, { by: 'meaning', model: 'fake/axes' });
        assert.equal(meaning.body.nodes[0].node.text, 'canary release process');
        const food = await recall('?query=eat&hops=0&limit=1', { userId: vectorUserId });
        assert.equal(food.body.nodes[0].node.text, 'the cafeteria food options');

        setRecallEmbedderFactory(
            () =>
                fakeEmbedder('fake/axes', () =>
                    Promise.reject(new Error('provider down')),
                ) as never,
        );
        const down = await recall('?query=deploy', { userId: vectorUserId });
        assert.equal(down.status, 502);
        assert.match(down.body.error, /embedding the query failed: provider down/);

        setRecallEmbedderFactory(() => fakeEmbedder('other/model') as never);
        const mismatch = await recall('?query=deploy', { userId: vectorUserId });
        assert.equal(mismatch.status, 422);

        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        let started!: () => void;
        const entered = new Promise<void>((resolve) => (started = resolve));
        setRecallEmbedderFactory(
            () =>
                ({
                    id: 'fake/axes',
                    embed: async (req: { input: string[] }) => {
                        started();
                        await gate;
                        return embeddingResponse(
                            req.input.map(() => [1, 0, 0.01]),
                            req as never,
                        );
                    },
                }) as never,
        );
        const slow = recall('?query=deploy', { userId: vectorUserId });
        await entered;
        const busy = await recall('?query=deploy', { userId: vectorUserId });
        assert.equal(busy.status, 409);
        assert.match(busy.body.error, /a recall is already running/);
        assert.equal((await recall('?query=deploy')).status, 200, 'other users are not blocked');
        release();
        assert.equal((await slow).status, 200);
        assert.equal((await recall('?query=deploy', { userId: vectorUserId })).status, 200);
        setRecallEmbedderFactory(undefined);

        assert.deepEqual(snapshot(memoryDir), before);
        assert.deepEqual(snapshot(vectorDir), vectorsBefore);
        assert.deepEqual(await usage(), usageBefore);
        assert.equal(existsSync(join(memoryDir, '.lock')), false);

        writeFileSync(join(projectDir, 'agents.yaml'), 'agents:\n  - name: memory-agent\n');
        const disabled = await recall('?query=deploy');
        assert.equal(disabled.status, 200);
        assert.equal(disabled.body.status, 'disabled');
        assert.deepEqual(disabled.body.nodes, []);
        assert.equal(disabled.body.block, '');
        assert.deepEqual(snapshot(memoryDir), before);
    } finally {
        setRecallEmbedderFactory(undefined);
        await new Promise<void>((resolve, reject) =>
            server.close((err) => (err ? reject(err) : resolve())),
        );
        rmSync(testRoot, { recursive: true, force: true });
    }
});
