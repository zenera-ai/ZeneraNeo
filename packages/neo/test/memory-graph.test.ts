import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryGraph, RevisionMismatch, edgeKey } from '../src/memory/graph.ts';
import { MemoryStore } from '../src/memory/store.ts';
import { ALL_AGENTS, MemoryError, visible } from '../src/memory/types.ts';
import { VectorBlock, recencyDecay } from '../src/memory/vectors.ts';

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-02T00:00:00.000Z';

function seeded(): MemoryGraph {
    const g = new MemoryGraph();
    g.add({ id: 'ask', kind: 'task', text: 'audit the rules', audience: ['*'] }, T0);
    g.add({ id: 'script', kind: 'file', text: 'report generator', audience: ['*'] }, T0);
    g.add({ id: 'note', kind: 'fact', text: 'paging uses a cursor', audience: ['triage'] }, T0);
    g.link('ask', 'script', 'PRODUCED', T0);
    g.link('note', 'script', 'INFORMED', T0);
    return g;
}

describe('the memory graph', () => {
    it('adds nodes with timestamps and a first revision', () => {
        const g = seeded();
        const node = g.get('ask');
        expect(node).toMatchObject({ kind: 'task', revision: 1, useCount: 0 });
        expect(node?.createdAt).toBe(T0);
        expect(node?.lastUsedAt).toBe(T0);
    });

    it('defaults a node with no audience to everyone', () => {
        const g = new MemoryGraph();
        const node = g.add({ id: 'n', kind: 'fact', text: 'x', audience: [] }, T0);
        expect(node.audience).toEqual([ALL_AGENTS]);
    });

    it('keeps one edge when the same link is committed twice', () => {
        const g = seeded();
        g.link('ask', 'script', 'PRODUCED', T1);
        expect(g.size).toBe(2);
        expect(edgeKey('ask', 'script', 'PRODUCED')).toBe('ask|PRODUCED|script');
    });

    it('bumps the revision on update and refuses a stale expectation', () => {
        const g = seeded();
        const next = g.update('ask', { text: 'audit them all' }, T1);
        expect(next).toMatchObject({ revision: 2, text: 'audit them all', updatedAt: T1 });
        expect(() => g.update('ask', { text: 'again', expectedRevision: 1 }, T1)).toThrow(
            RevisionMismatch,
        );
    });

    it('counts a load as use, and only a load', () => {
        const g = seeded();
        const node = g.touch('ask', T1);
        expect(node).toMatchObject({ useCount: 1, lastUsedAt: T1 });
        // The write path never touches these, so recency reflects reading.
        expect(g.get('script')).toMatchObject({ useCount: 0 });
    });

    it('drops the edges of a forgotten node', () => {
        const g = seeded();
        expect(g.forget('script')?.kind).toBe('file');
        expect(g.has('script')).toBe(false);
        expect(g.size).toBe(0);
        expect(g.neighbors('ask')).toEqual([]);
    });

    it('walks neighbours in both directions', () => {
        const g = seeded();
        expect(
            g
                .neighbors('script')
                .map((e) => e.source)
                .sort(),
        ).toEqual(['ask', 'note']);
    });
});

describe('memory masking', () => {
    it('denies a labelled node to a reader without the label', () => {
        const g = seeded();
        expect(
            g
                .nodes(['*'])
                .map((n) => n.id)
                .sort(),
        ).toEqual(['ask', 'script']);
        expect(
            g
                .nodes(['triage'])
                .map((n) => n.id)
                .sort(),
        ).toEqual(['ask', 'note', 'script']);
    });

    it('hides an edge whose endpoint is masked', () => {
        const g = seeded();
        expect(g.edges(['*'])).toEqual([{ source: 'ask', target: 'script', relation: 'PRODUCED' }]);
        expect(g.edges(['triage'])).toHaveLength(2);
    });

    it('treats a public node as visible whatever the reader holds', () => {
        const node = seeded().get('ask')!;
        expect(visible(node, [])).toBe(true);
    });

    it('reports what a visible node supersedes', () => {
        const g = seeded();
        g.add({ id: 'fixed', kind: 'file', text: 'fixed generator', audience: ['*'] }, T1);
        g.link('fixed', 'script', 'SUPERSEDES', T1);
        expect([...g.superseded(['*'])]).toEqual(['script']);
    });
});

describe('the vector block', () => {
    it('scans for the nearest unit vectors', () => {
        const b = new VectorBlock(3);
        b.set('x', [1, 0, 0]);
        b.set('y', [0, 1, 0]);
        b.set('z', [0.8, 0.6, 0]);
        const hits = b.topK([1, 0, 0], 2);
        expect(hits.map((h) => h.id)).toEqual(['x', 'z']);
        expect(hits[0].score).toBeCloseTo(1);
        expect(hits[1].score).toBeCloseTo(0.8);
    });

    it('honours the filter', () => {
        const b = new VectorBlock(3);
        b.set('x', [1, 0, 0]);
        b.set('y', [0, 1, 0]);
        expect(b.topK([1, 0, 0], 5, (id) => id !== 'x').map((h) => h.id)).toEqual(['y']);
    });

    it('keeps the block dense and correct across a swap-remove', () => {
        const b = new VectorBlock(2, 2);
        b.set('a', [1, 0]);
        b.set('b', [0, 1]);
        b.set('c', [0.6, 0.8]);
        expect(b.remove('a')).toBe(true);
        expect(b.rows).toBe(2);
        expect(b.has('a')).toBe(false);
        // 'c' was moved into the hole; its vector must have moved with it.
        expect(b.topK([0.6, 0.8], 1)[0]).toMatchObject({ id: 'c' });
        expect(b.topK([0, 1], 1)[0]).toMatchObject({ id: 'b' });
        expect(b.remove('a')).toBe(false);
    });

    it('overwrites in place rather than appending', () => {
        const b = new VectorBlock(2);
        b.set('a', [1, 0]);
        b.set('a', [0, 1]);
        expect(b.rows).toBe(1);
        expect(b.topK([0, 1], 1)[0].score).toBeCloseTo(1);
    });

    it('refuses a vector of the wrong width', () => {
        const b = new VectorBlock(3);
        expect(() => b.set('a', [1, 0])).toThrow(/3-dimension/);
    });
});

describe('recency decay', () => {
    it('is one for something just used and halves over the half-life', () => {
        const now = Date.parse('2026-03-01T00:00:00.000Z');
        expect(recencyDecay('2026-03-01T00:00:00.000Z', now)).toBeCloseTo(1);
        expect(recencyDecay('2026-01-30T00:00:00.000Z', now)).toBeCloseTo(0.5, 2);
    });
});

describe('the memory store', () => {
    let dir: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'neo-memory-'));
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it('opens an empty directory as an empty graph', async () => {
        const store = await MemoryStore.open(dir);
        expect(store.graph.order).toBe(0);
        store.release();
    });

    it('round trips the graph and the vectors', async () => {
        const embedding = { model: 'stub', dimensions: 3 };
        const a = await MemoryStore.open(dir, { embedding });
        a.graph.add({ id: 'ask', kind: 'task', text: 'audit', audience: ['*'] }, T0);
        a.graph.add({ id: 'script', kind: 'file', text: 'gen', audience: ['triage'] }, T0);
        a.graph.link('ask', 'script', 'PRODUCED', T0);
        a.vectors!.set('ask', [1, 0, 0]);
        a.vectors!.set('script', [0, 1, 0]);
        await a.commit();
        a.release();

        const b = await MemoryStore.open(dir, { embedding });
        expect(b.graph.order).toBe(2);
        expect(b.graph.size).toBe(1);
        expect(b.graph.get('script')?.audience).toEqual(['triage']);
        expect(b.vectors!.rows).toBe(2);
        expect(b.vectors!.topK([1, 0, 0], 1)[0].id).toBe('ask');
        b.release();
    });

    it('refuses a graph embedded with another model', async () => {
        const a = await MemoryStore.open(dir, { embedding: { model: 'one', dimensions: 3 } });
        a.graph.add({ id: 'n', kind: 'fact', text: 't', audience: ['*'] }, T0);
        await a.commit();
        a.release();

        await expect(
            MemoryStore.open(dir, { embedding: { model: 'two', dimensions: 3 } }),
        ).rejects.toThrow(MemoryError);
    });

    it('lets two writers share one directory, each seeing the other', async () => {
        const a = await MemoryStore.open(dir);
        const b = await MemoryStore.open(dir);
        try {
            a.write(() => a.graph.add({ id: 'A', kind: 'fact', text: 'a', audience: ['*'] }, T0));
            b.write(() => b.graph.add({ id: 'B', kind: 'fact', text: 'b', audience: ['*'] }, T0));
            a.refresh();
            expect(a.graph.has('B')).toBe(true);
            expect(b.graph.has('A')).toBe(true);
        } finally {
            a.release();
            b.release();
        }
        const c = await MemoryStore.open(dir);
        expect(c.graph.order).toBe(2);
        c.release();
    });
});
