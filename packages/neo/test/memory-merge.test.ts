import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MergeConflicts, mergeMemories } from '../src/memory/merge.ts';
import { FILES_DIR, MemoryStore, type MemoryEmbedding } from '../src/memory/store.ts';
import type { MemoryFile, MemoryNode, Relation } from '../src/memory/types.ts';

const DIMS = 8;
const EMBEDDING: MemoryEmbedding = { model: 'stub', dimensions: DIMS };
const SCRIPT = 'print("risky ports")\n';

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-02-01T00:00:00.000Z';
const T2 = '2026-03-01T00:00:00.000Z';

/** One dimension per term, set by hand: a hash would invent similarity here too. */
function unit(...dims: number[]): Float32Array {
    const v = new Float32Array(DIMS);
    for (const d of dims) {
        v[d] = 1;
    }
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
}

function node(id: string, over: Partial<MemoryNode> = {}): MemoryNode {
    return {
        id,
        kind: 'task',
        text: `remembered ${id}`,
        audience: ['*'],
        createdAt: T0,
        updatedAt: T0,
        lastUsedAt: T0,
        useCount: 0,
        revision: 1,
        ...over,
    };
}

interface Built {
    edges?: [string, string, Relation][];
    vectors?: Record<string, Float32Array>;
    /** node id -> file body */
    files?: Record<string, string>;
    /** `null` builds a memory with no embedder at all */
    embedding?: MemoryEmbedding | null;
}

describe('merging memories', () => {
    let root: string;
    let intoDir: string;
    let into: MemoryStore;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'neo-merge-'));
        intoDir = join(root, 'into');
        into = await MemoryStore.open(intoDir);
    });

    afterEach(async () => {
        into.release();
        await rm(root, { recursive: true, force: true });
    });

    async function memory(name: string, nodes: MemoryNode[], opts: Built = {}): Promise<string> {
        const dir = join(root, name);
        const embedding = opts.embedding === null ? undefined : (opts.embedding ?? EMBEDDING);
        const store = await MemoryStore.open(dir, embedding ? { embedding } : {});
        for (const n of nodes) {
            const body = opts.files?.[n.id];
            store.graph.adopt(body === undefined ? n : { ...n, file: await keep(dir, n.id, body) });
            const vector = opts.vectors?.[n.id];
            if (vector) {
                store.vectors?.set(n.id, vector);
            }
        }
        for (const [source, target, relation] of opts.edges ?? []) {
            store.graph.adoptEdge(source, target, { relation, createdAt: T0 });
        }
        await store.commit();
        store.release();
        return dir;
    }

    it('carries nodes, edges and vectors across from every source', async () => {
        const a = await memory('a', [node('A1'), node('A2')], {
            edges: [['A1', 'A2', 'PRODUCED']],
            vectors: { A1: unit(0), A2: unit(1) },
        });
        const b = await memory('b', [node('B1')], { vectors: { B1: unit(2) } });

        const report = await mergeMemories(into, [a, b]);

        expect(report).toMatchObject({ added: 3, shared: 0, twins: 0, edges: 1, dryRun: false });
        expect(report.sources.map((s) => s.added)).toEqual([2, 1]);
        expect(report.embedding).toEqual(EMBEDDING);

        const back = await MemoryStore.open(intoDir, { readOnly: true });
        expect(back.graph.order).toBe(3);
        expect(back.graph.edges()).toEqual([{ source: 'A1', target: 'A2', relation: 'PRODUCED' }]);
        expect(back.vectors?.rows).toBe(3);
        expect(back.embedding).toEqual(EMBEDDING);
    });

    it('reconciles a shared ancestor instead of duplicating it', async () => {
        const shared = node('S1', { useCount: 2, createdAt: T1, lastUsedAt: T1 });
        const a = await memory('a', [{ ...shared, useCount: 5, lastUsedAt: T2 }], {
            vectors: { S1: unit(0) },
        });
        const b = await memory('b', [{ ...shared, useCount: 3, createdAt: T0 }], {
            vectors: { S1: unit(0) },
        });

        const report = await mergeMemories(into, [a, b]);

        expect(report).toMatchObject({ added: 1, shared: 1, twins: 0 });
        expect(into.graph.order).toBe(1);
        // MAX, not sum: merging the same work twice must not inflate its use.
        expect(into.graph.get('S1')).toMatchObject({
            useCount: 5,
            lastUsedAt: T2,
            createdAt: T0,
            revision: 1,
        });
    });

    it('is a no-op the second time the same memory is merged', async () => {
        const a = await memory('a', [node('A1'), node('A2')], {
            edges: [['A1', 'A2', 'PRODUCED']],
            vectors: { A1: unit(0), A2: unit(1) },
        });

        const first = await mergeMemories(into, [a]);
        const second = await mergeMemories(into, [a]);

        expect(first).toMatchObject({ added: 2, edges: 1 });
        expect(second).toMatchObject({ added: 0, shared: 2, twins: 0, edges: 0 });
        expect(into.graph.order).toBe(2);
        expect(into.graph.size).toBe(1);
    });

    it('refuses the whole merge when the same memory diverged, and writes nothing', async () => {
        const a = await memory('a', [node('D1', { text: 'the left answer', revision: 2 })]);
        const b = await memory('b', [
            node('D1', { text: 'the right answer', revision: 3, updatedAt: T1 }),
        ]);

        const err = await mergeMemories(into, [a, b]).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(MergeConflicts);
        expect((err as MergeConflicts).conflicts).toEqual([
            { id: 'D1', dir: b, mine: 2, theirs: 3, text: 'the right answer' },
        ]);
        expect(into.graph.order).toBe(0);
        expect(existsSync(join(intoDir, 'manifest.json'))).toBe(false);
    });

    it('takes the highest revision under force', async () => {
        const a = await memory('a', [node('D1', { text: 'the left answer', revision: 2 })]);
        const b = await memory('b', [
            node('D1', { text: 'the right answer', revision: 3, updatedAt: T1, useCount: 4 }),
        ]);

        const report = await mergeMemories(into, [a, b], { force: true });

        expect(report).toMatchObject({ added: 1, shared: 1 });
        expect(into.graph.get('D1')).toMatchObject({
            text: 'the right answer',
            revision: 3,
            useCount: 4,
        });
    });

    it('folds a memory the target already holds onto the one that is there', async () => {
        const a = await memory('a', [node('A1'), node('A2', { kind: 'file' })], {
            edges: [['A1', 'A2', 'PRODUCED']],
            vectors: { A1: unit(0, 1), A2: unit(2) },
        });
        const b = await memory('b', [node('B1'), node('B2', { kind: 'file' })], {
            edges: [['B1', 'B2', 'PRODUCED']],
            vectors: { B1: unit(0, 1), B2: unit(2) },
        });

        const report = await mergeMemories(into, [a, b]);

        expect(report).toMatchObject({ added: 2, twins: 2, edges: 1 });
        expect(into.graph.order).toBe(2);
        // The second source's edge was re-pointed onto the surviving pair.
        expect(into.graph.size).toBe(1);
    });

    it('keeps both when dedupe is off', async () => {
        const a = await memory('a', [node('A1')], { vectors: { A1: unit(0) } });
        const b = await memory('b', [node('B1')], { vectors: { B1: unit(0) } });

        const report = await mergeMemories(into, [a, b], { dedupe: false });

        expect(report).toMatchObject({ added: 2, twins: 0 });
        expect(into.graph.order).toBe(2);
    });

    it('drops an edge whose ends both folded onto the same memory', async () => {
        const a = await memory('a', [node('A1')], { vectors: { A1: unit(0) } });
        const b = await memory('b', [node('B1'), node('B2')], {
            edges: [['B1', 'B2', 'INFORMED']],
            vectors: { B1: unit(0), B2: unit(0) },
        });

        const report = await mergeMemories(into, [a, b]);

        expect(report).toMatchObject({ added: 1, twins: 2, edges: 0 });
        expect(into.graph.size).toBe(0);
    });

    it('never folds a memory that remembers a file, and copies the bytes', async () => {
        const a = await memory('a', [node('A1', { kind: 'file' })], {
            files: { A1: SCRIPT },
            vectors: { A1: unit(0) },
        });
        const b = await memory('b', [node('B1', { kind: 'file' })], {
            files: { B1: SCRIPT },
            vectors: { B1: unit(0) },
        });

        const report = await mergeMemories(into, [a, b]);

        expect(report).toMatchObject({ added: 2, twins: 0, files: 2 });
        expect(await readFile(join(intoDir, FILES_DIR, 'A1.py'), 'utf8')).toBe(SCRIPT);
        expect(await readFile(join(intoDir, FILES_DIR, 'B1.py'), 'utf8')).toBe(SCRIPT);
    });

    it('refuses a file whose bytes no longer match what its memory records', async () => {
        const a = await memory('a', [node('A1', { kind: 'file' })], { files: { A1: SCRIPT } });
        await writeFile(join(a, FILES_DIR, 'A1.py'), 'print("tampered")\n');

        await expect(mergeMemories(into, [a])).rejects.toThrow(/does not match the digest/);
        expect(existsSync(join(intoDir, 'manifest.json'))).toBe(false);
        expect(existsSync(join(intoDir, FILES_DIR, 'A1.py'))).toBe(false);
    });

    it('refuses a file a memory names but does not have', async () => {
        const a = await memory('a', [node('A1', { kind: 'file' })], { files: { A1: SCRIPT } });
        await rm(join(a, FILES_DIR, 'A1.py'));

        await expect(mergeMemories(into, [a])).rejects.toThrow(/is missing from/);
        expect(into.graph.order).toBe(0);
    });

    it('folds by flattened text when there is no embedder', async () => {
        const a = await memory('a', [node('A1', { text: 'Audit  the firewall   RULES' })], {
            embedding: null,
        });
        const b = await memory('b', [node('B1', { text: 'audit the firewall rules' })], {
            embedding: null,
        });

        const report = await mergeMemories(into, [a, b]);

        expect(report).toMatchObject({ added: 1, twins: 1 });
        expect(report.embedding).toBeUndefined();
        expect(into.graph.order).toBe(1);
    });

    it('does not fold memories that different agents can see', async () => {
        const a = await memory('a', [node('A1', { text: 'the same thing' })], {
            vectors: { A1: unit(0) },
        });
        const b = await memory('b', [node('B1', { text: 'the same thing', audience: ['audit'] })], {
            vectors: { B1: unit(0) },
        });

        const report = await mergeMemories(into, [a, b]);

        expect(report).toMatchObject({ added: 2, twins: 0 });
    });

    it('refuses sources embedded with different models', async () => {
        const a = await memory('a', [node('A1')], { vectors: { A1: unit(0) } });
        const b = await memory('b', [node('B1')], {
            embedding: { model: 'other', dimensions: DIMS },
        });

        await expect(mergeMemories(into, [a, b])).rejects.toThrow(/embedded with other/);
    });

    it('refuses a source with no embedder when the merge has one', async () => {
        const a = await memory('a', [node('A1')], { vectors: { A1: unit(0) } });
        const b = await memory('b', [node('B1')], { embedding: null });

        await expect(mergeMemories(into, [a, b])).rejects.toThrow(/has no embedder/);
    });

    it('refuses a directory that is not a memory, rather than creating one', async () => {
        const missing = join(root, 'nope');

        await expect(mergeMemories(into, [missing])).rejects.toThrow(/is not a memory/);
        expect(existsSync(missing)).toBe(false);
    });

    it('refuses the target as one of its own sources, and repeated sources', async () => {
        const a = await memory('a', [node('A1')]);

        await expect(mergeMemories(into, [intoDir])).rejects.toThrow(/being merged into/);
        await expect(mergeMemories(into, [a, a])).rejects.toThrow(/named twice/);
    });

    it('merges a source a run is still writing to', async () => {
        const a = await memory('a', [node('A1')]);
        const live = await MemoryStore.open(a);
        try {
            const report = await mergeMemories(into, [a]);
            expect(report).toMatchObject({ added: 1 });
        } finally {
            live.release();
        }
    });

    it('reports a dry run without writing anything', async () => {
        const a = await memory('a', [node('A1', { kind: 'file' })], {
            files: { A1: SCRIPT },
            vectors: { A1: unit(0) },
        });

        const report = await mergeMemories(into, [a], { dryRun: true });

        expect(report).toMatchObject({ added: 1, files: 1, dryRun: true });
        expect(existsSync(join(intoDir, 'manifest.json'))).toBe(false);
        expect(existsSync(join(intoDir, FILES_DIR, 'A1.py'))).toBe(false);
    });
});

async function keep(dir: string, id: string, body: string): Promise<MemoryFile> {
    await writeFile(join(dir, FILES_DIR, `${id}.py`), body);
    return {
        path: `${id}.py`,
        bytes: Buffer.byteLength(body),
        sha256: createHash('sha256').update(body).digest('hex'),
        format: 'py',
    };
}
