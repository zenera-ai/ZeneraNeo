import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IdClock } from '../src/ids.ts';
import { hostFile } from '../src/memory/files.ts';
import { MemoryGraph, RevisionMismatch } from '../src/memory/graph.ts';
import { MemoryIndex } from '../src/memory/index.ts';
import { LEGACY_DIR, migrateMemory } from '../src/memory/migrate.ts';
import { MEMORY_DB, MemoryStore } from '../src/memory/store.ts';

/**
 * Several runs, one memory. Everything here is a way two writers could lose
 * each other's work, or a crash could leave half of one behind.
 */

const AT = '2026-01-01T00:00:00.000Z';
const ALL = ['*'];
const WRITER = fileURLToPath(new URL('./memory-writer.ts', import.meta.url));

function clock(prefix: string): IdClock {
    let n = 1;
    return { newId: () => `${prefix}${n++}`, now: () => AT };
}

function opts(prefix: string) {
    return { writes: ALL, sees: ALL, clock: clock(prefix) };
}

function writer(dir: string, prefix: string, commits: number) {
    const child = spawn(process.execPath, [WRITER, dir, prefix, String(commits)], {
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const done = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
        child.on('exit', (code, signal) => resolve({ code, signal })),
    );
    return { child, done, out: () => out, err: () => err };
}

describe('one memory, several writers', () => {
    let dir: string;
    const open: MemoryStore[] = [];

    async function index(): Promise<MemoryIndex> {
        const store = await MemoryStore.open(dir);
        open.push(store);
        return new MemoryIndex({ store });
    }

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'neo-sqlite-'));
    });

    afterEach(async () => {
        open.splice(0).forEach((s) => s.release());
        await rm(dir, { recursive: true, force: true });
    });

    it('keeps both commits, and each sees the other without reopening', async () => {
        const a = await index();
        const b = await index();

        await a.commit(
            { nodes: [{ ref: 'x', kind: 'fact', text: 'deploys go through staging' }] },
            opts('A'),
        );
        await b.commit(
            { nodes: [{ ref: 'y', kind: 'fact', text: 'invoices close on friday' }] },
            opts('B'),
        );

        const seen = await a.search({ text: 'invoices friday' }, ALL);
        expect(seen.nodes.map((n) => n.node.id)).toContain('B1');
        expect(b.graph.has('A1')).toBe(true);

        const fresh = await index();
        expect(fresh.graph.order).toBe(2);
    });

    it('applies two updates to different fields of one node, last writer per field', async () => {
        const a = await index();
        await a.commit({ nodes: [{ ref: 'x', kind: 'fact', text: 'first' }] }, opts('A'));
        const b = await index();

        await a.commit({ nodes: [{ id: 'A1', text: 'second' }] }, opts('A'));
        await b.commit({ nodes: [{ id: 'A1', metadata: { source: 'b' } }] }, opts('B'));

        a.refresh();
        expect(a.graph.get('A1')).toMatchObject({
            text: 'second',
            metadata: { source: 'b' },
            revision: 3,
        });
    });

    it('refuses an update made against a revision another run has moved past', async () => {
        const a = await index();
        await a.commit({ nodes: [{ ref: 'x', kind: 'fact', text: 'first' }] }, opts('A'));
        const b = await index();

        await a.commit({ nodes: [{ id: 'A1', text: 'second', expectedRevision: 1 }] }, opts('A'));
        await expect(
            b.commit({ nodes: [{ id: 'A1', text: 'third', expectedRevision: 1 }] }, opts('B')),
        ).rejects.toThrow(RevisionMismatch);
        expect(b.graph.get('A1')?.text).toBe('second');
    });

    it('refuses an edge to a node another run forgot mid-commit, and writes nothing', async () => {
        const a = await index();
        await a.commit({ nodes: [{ ref: 'x', kind: 'fact', text: 'doomed' }] }, opts('A'));
        // The embedding call is the slow part a commit makes outside the lock;
        // another run forgets the node the plan links to while it is out.
        const store = await MemoryStore.open(dir);
        open.push(store);
        const b = new MemoryIndex({
            store,
            embedder: {
                id: 'stub',
                embed: async (req) => {
                    await a.forget(['A1'], ALL);
                    return { vectors: req.input.map(() => [1, 0]), dimensions: 2 };
                },
            },
        });

        const work = await mkdtemp(join(tmpdir(), 'neo-sqlite-work-'));
        try {
            const source = join(work, 'notes.md');
            await writeFile(source, 'notes');
            await expect(
                b.commit(
                    {
                        nodes: [
                            {
                                ref: 'y',
                                kind: 'fact',
                                text: 'points at it',
                                file: { source: hostFile(source) },
                            },
                        ],
                        edges: [{ from: 'y', to: 'A1', relation: 'INFORMED' }],
                    },
                    opts('B'),
                ),
            ).rejects.toThrow(/no longer a memory/);
            expect(b.graph.order).toBe(0);
            expect(existsSync(join(dir, 'files', 'B1.md'))).toBe(false);
        } finally {
            await rm(work, { recursive: true, force: true });
        }
    });

    it('persists a use count bumped by one run where another reads it', async () => {
        const a = await index();
        await a.commit({ nodes: [{ ref: 'x', kind: 'fact', text: 'used' }] }, opts('A'));
        const b = await index();

        await a.load(['A1'], ALL, clock('A'));
        b.refresh();
        expect(b.graph.get('A1')?.useCount).toBe(1);
    });

    it('rolls a failed write back, on disk and in the cache', async () => {
        const a = await index();
        await a.commit({ nodes: [{ ref: 'x', kind: 'fact', text: 'stays' }] }, opts('A'));

        expect(() =>
            a.store.write(() => {
                a.graph.add({ id: 'Z', kind: 'fact', text: 'goes', audience: ALL }, AT);
                a.graph.forget('A1');
                throw new Error('changed my mind');
            }),
        ).toThrow(/changed my mind/);

        expect(a.graph.has('A1')).toBe(true);
        expect(a.graph.has('Z')).toBe(false);
        const fresh = await index();
        expect(fresh.graph.has('A1')).toBe(true);
        expect(fresh.graph.has('Z')).toBe(false);
    });

    it('refuses an asynchronous write, which would hold the lock across an await', async () => {
        const a = await index();
        expect(() => a.store.write((async () => undefined) as () => unknown)).toThrow(
            /synchronous/,
        );
    });

    it('loses nothing to writers in other processes committing at the same time', async () => {
        const runs = ['p', 'q', 'r', 's'].map((prefix) => writer(dir, prefix, 15));
        const ended = await Promise.all(runs.map((r) => r.done));
        for (const [i, end] of ended.entries()) {
            expect(end.code, runs[i]!.err()).toBe(0);
        }

        const store = await MemoryStore.open(dir);
        open.push(store);
        expect(store.graph.order).toBe(60);
        expect(store.graph.size).toBe(56);
    }, 30_000);

    it('opens whole after a writer is killed mid-commit', async () => {
        const run = writer(dir, 'k', 0);
        const until = Date.now() + 20_000;
        while (run.out().split('\n').length < 30 && Date.now() < until) {
            await new Promise((r) => setTimeout(r, 20));
        }
        run.child.kill('SIGKILL');
        const end = await run.done;
        expect(end.signal).toBe('SIGKILL');

        const db = new DatabaseSync(join(dir, MEMORY_DB));
        expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
        db.close();

        const store = await MemoryStore.open(dir);
        open.push(store);
        const n = store.graph.order;
        expect(n).toBeGreaterThanOrEqual(29);
        // Every commit is a node plus the edge to its predecessor, or neither.
        expect(store.graph.size).toBe(n - 1);
        for (let i = 0; i < n; i++) {
            expect(store.graph.has(`k-${i}`)).toBe(true);
        }
    }, 30_000);
});

describe('a version 1 memory', () => {
    let dir: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'neo-migrate-'));
        const graph = new MemoryGraph();
        graph.add({ id: 'a', kind: 'task', text: 'audit', audience: ALL }, AT);
        graph.add({ id: 'b', kind: 'fact', text: 'result', audience: ALL }, AT);
        graph.link('a', 'b', 'PRODUCED', AT);
        const data = new Float32Array([1, 0, 0, 1]);
        await writeFile(join(dir, 'graph.json'), JSON.stringify(graph.export()));
        await writeFile(join(dir, 'vectors.json'), JSON.stringify({ dims: 2, ids: ['a', 'b'] }));
        await writeFile(join(dir, 'vectors.f32'), new Uint8Array(data.buffer));
        await writeFile(
            join(dir, 'manifest.json'),
            JSON.stringify({
                version: 1,
                embedding: { model: 'stub', dimensions: 2 },
                nodes: 2,
                edges: 1,
            }),
        );
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it('is refused until migrated, with the command that does it', async () => {
        await expect(MemoryStore.open(dir)).rejects.toThrow(/version 1/);
        await expect(MemoryStore.open(dir)).rejects.toMatchObject({
            hint: expect.stringMatching(/zen memory migrate/),
        });
    });

    it('converts graph, edges and vectors, and keeps the old files aside', async () => {
        const report = await migrateMemory(dir);
        expect(report).toMatchObject({ nodes: 2, edges: 1, vectors: 2 });

        const store = await MemoryStore.open(dir, { readOnly: true });
        expect(store.graph.order).toBe(2);
        expect(store.graph.edges()).toEqual([{ source: 'a', target: 'b', relation: 'PRODUCED' }]);
        expect(store.embedding).toEqual({ model: 'stub', dimensions: 2 });
        expect(store.vectors?.topK([0, 1], 1)[0]?.id).toBe('b');
        store.release();

        expect(existsSync(join(dir, 'graph.json'))).toBe(false);
        expect(
            JSON.parse(await readFile(join(dir, LEGACY_DIR, 'manifest.json'), 'utf8')),
        ).toMatchObject({
            version: 1,
        });
        await expect(migrateMemory(dir)).rejects.toThrow(/already/);
    });
});
