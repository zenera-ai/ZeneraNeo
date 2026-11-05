import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Embedder, EmbeddingRequest, EmbeddingResponse } from '../src/embedding.ts';
import type { IdClock } from '../src/ids.ts';
import { hostFile, hostPath, type FileSource } from '../src/memory/files.ts';
import { MemoryIndex, type MemoryTransaction } from '../src/memory/index.ts';
import { MemoryStore } from '../src/memory/store.ts';
import { memoryTools } from '../src/memory/tools.ts';
import { MemoryError } from '../src/memory/types.ts';
import { isToolReturn, MEMORY_COMMIT_TOOL, type AnyTool, type ToolContext } from '../src/types.ts';

const DIMS = 64;
const EMBEDDING = { model: 'stub', dimensions: DIMS };
const SCRIPT = 'print("risky ports")\n';

/** One dimension per term; a hash would invent similarity between unrelated text. */
class StubEmbedder implements Embedder {
    readonly id = 'stub';
    calls = 0;
    texts: string[] = [];
    readonly #vocab = new Map<string, number>();

    async embed(req: EmbeddingRequest): Promise<EmbeddingResponse> {
        this.calls++;
        this.texts.push(...req.input);
        return { vectors: req.input.map((t) => this.#one(t)), dimensions: DIMS };
    }

    #one(text: string): number[] {
        const v = new Array(DIMS).fill(0);
        for (const term of text
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter(Boolean)) {
            let dim = this.#vocab.get(term);
            if (dim === undefined) {
                dim = this.#vocab.size % DIMS;
                this.#vocab.set(term, dim);
            }
            v[dim] += 1;
        }
        const norm = Math.hypot(...v) || 1;
        return v.map((x) => x / norm);
    }
}

function clockFrom(start = 1): IdClock {
    let n = start;
    return {
        newId: () => `ID${n++}`,
        now: () => '2026-01-01T00:00:00.000Z',
    };
}

describe('committing a subgraph', () => {
    let dir: string;
    let work: string;
    let source: string;
    let index: MemoryIndex;
    let embedder: StubEmbedder;
    let clock: IdClock;

    const WRITES = ['*', 'triage'];

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'neo-index-'));
        work = await mkdtemp(join(tmpdir(), 'neo-work-'));
        source = join(work, 'audit.py');
        await writeFile(source, SCRIPT);
        embedder = new StubEmbedder();
        clock = clockFrom();
        index = new MemoryIndex({
            store: await MemoryStore.open(dir, { embedding: EMBEDDING }),
            embedder,
        });
    });

    afterEach(async () => {
        index.store.release();
        await rm(dir, { recursive: true, force: true });
        await rm(work, { recursive: true, force: true });
    });

    const commit = (tx: MemoryTransaction) =>
        index.commit(tx, { writes: WRITES, sees: WRITES, clock });

    const audit: MemoryTransaction = {
        nodes: [
            { ref: 'ask', kind: 'task', text: 'audit the firewall rules for risky ports' },
            { ref: 'script', kind: 'file', text: 'risk report generator' },
            { ref: 'call', kind: 'operation', text: 'GET /api/v1/domains' },
        ],
        edges: [
            { from: 'ask', to: 'script', relation: 'PRODUCED' },
            { from: 'script', to: 'call', relation: 'CALLS' },
        ],
    };

    it('writes a whole subgraph in one call and maps refs to minted ids', async () => {
        const res = await commit(audit);
        expect(res).toMatchObject({ created: 3, updated: 0, edges: 2, files: 0 });
        expect(res.ids).toEqual({ ask: 'ID1', script: 'ID2', call: 'ID3' });
        expect(index.graph.order).toBe(3);
        expect(index.graph.edges(['*'])).toContainEqual({
            source: 'ID1',
            target: 'ID2',
            relation: 'PRODUCED',
        });
    });

    it('joins a new node to one that was already there', async () => {
        const first = await commit(audit);
        const res = await commit({
            nodes: [{ ref: 'fix', kind: 'file', text: 'corrected generator' }],
            edges: [{ from: 'fix', to: first.ids.script, relation: 'SUPERSEDES' }],
        });
        expect(index.graph.edges(['*'])).toContainEqual({
            source: res.ids.fix,
            target: first.ids.script,
            relation: 'SUPERSEDES',
        });
    });

    it('copies a remembered file and records it on the node', async () => {
        const res = await commit({
            nodes: [
                {
                    ref: 'script',
                    kind: 'file',
                    text: 'risk report generator',
                    file: { source: hostFile(source) },
                },
            ],
        });
        const node = index.graph.get(res.ids.script)!;
        expect(node.file).toMatchObject({ path: 'ID1.py', format: 'py' });
        expect(await readFile(hostPath(dir, node.file!), 'utf8')).toBe(SCRIPT);
    });

    it('embeds every new node once, in a single call', async () => {
        await commit(audit);
        expect(embedder.calls).toBe(1);
        expect(embedder.texts).toHaveLength(3);
    });

    it('re-embeds a changed text but not a changed label', async () => {
        const res = await commit(audit);
        embedder.calls = 0;

        await commit({ nodes: [{ id: res.ids.ask, audience: ['triage'] }] });
        expect(embedder.calls).toBe(0);

        await commit({ nodes: [{ id: res.ids.ask, text: 'audit the rules, quietly' }] });
        expect(embedder.calls).toBe(1);
    });

    it('bumps the revision on an update and honours a stale expectation', async () => {
        const res = await commit(audit);
        await commit({ nodes: [{ id: res.ids.ask, text: 'audit them all' }] });
        expect(index.graph.get(res.ids.ask)).toMatchObject({ revision: 2, text: 'audit them all' });
        await expect(
            commit({ nodes: [{ id: res.ids.ask, text: 'again', expectedRevision: 1 }] }),
        ).rejects.toThrow();
    });

    /** Two runs of one job used to leave two copies of it and split the edges. */
    it('folds a node that already exists into it and re-points the edges', async () => {
        const first = await commit(audit);
        const again = await commit(audit);

        expect(again).toMatchObject({ created: 0, merged: 3 });
        expect(again.ids).toEqual(first.ids);
        expect(index.graph.order).toBe(3);
        expect(index.graph.size).toBe(2);
    });

    it('leaves a node that merely resembles one alone', async () => {
        await commit(audit);
        const res = await commit({
            nodes: [{ ref: 'ask', kind: 'task', text: 'audit the routing tables for open relays' }],
        });
        expect(res).toMatchObject({ created: 1, merged: 0 });
        expect(index.graph.order).toBe(4);
    });

    it('never folds two artifacts whose summaries happen to read alike', async () => {
        const twin = join(work, 'twin.py');
        await writeFile(twin, 'print("other")\n');
        const text = 'risk report generator';
        const first = await commit({
            nodes: [{ ref: 'a', kind: 'file', text, file: { source: hostFile(source) } }],
        });
        const second = await commit({
            nodes: [{ ref: 'b', kind: 'file', text, file: { source: hostFile(twin) } }],
        });
        expect(second.ids.b).not.toBe(first.ids.a);
        expect(second).toMatchObject({ created: 1, merged: 0 });
    });

    it('accepts a new node when the caller supplies both ref and id with the same value', async () => {
        const res = await commit({
            nodes: [
                {
                    ref: 'task_node',
                    id: 'task_node',
                    kind: 'task',
                    text: 'audit firewall rules',
                },
                {
                    ref: 'file_node',
                    id: 'file_node',
                    kind: 'file',
                    text: 'firewall report',
                },
            ],
            edges: [{ from: 'task_node', to: 'file_node', relation: 'PRODUCED' }],
        });
        expect(res).toMatchObject({ created: 2, updated: 0, edges: 1 });
        expect(res.ids.task_node).toBeDefined();
        expect(res.ids.file_node).toBeDefined();
        expect(index.graph.edges(['*'])).toContainEqual({
            source: res.ids.task_node,
            target: res.ids.file_node,
            relation: 'PRODUCED',
        });
    });

    it('accepts a new node when the caller uses id instead of ref', async () => {
        const res = await commit({
            nodes: [
                { id: 't1', kind: 'task', text: 'audit firewall rules' },
                { id: 'f1', kind: 'file', text: 'firewall report' },
            ],
            edges: [{ from: 't1', to: 'f1', relation: 'PRODUCED' }],
        });
        expect(res).toMatchObject({ created: 2, updated: 0, edges: 1 });
        expect(res.ids.t1).toBeDefined();
        expect(res.ids.f1).toBeDefined();
        expect(index.graph.edges(['*'])).toContainEqual({
            source: res.ids.t1,
            target: res.ids.f1,
            relation: 'PRODUCED',
        });
    });

    it('handles model-generated payloads where nodes use id or both ref and id', async () => {
        // Scenario 1: ref and id both provided with same string
        const res1 = await commit({
            nodes: [
                {
                    ref: 'task_node',
                    id: 'task_node',
                    kind: 'task',
                    text: 'Query API for virtual machine rules',
                },
                {
                    ref: 'file_node',
                    id: 'file_node',
                    kind: 'file',
                    text: 'Full system state report',
                },
            ],
            edges: [{ from: 'task_node', to: 'file_node', relation: 'PRODUCED' }],
        });
        expect(res1.created).toBe(2);

        // Scenario 2: id used instead of ref, with edges
        const res2 = await commit({
            edges: [{ from: 't1', to: 'f1', relation: 'PRODUCED' }],
            nodes: [
                { id: 't1', kind: 'task', text: 'Query API for security rules' },
                { id: 'f1', kind: 'file', text: 'Security report' },
            ],
        });
        expect(res2.created).toBe(2);

        // Scenario 3: hyphenated ids used instead of ref
        const res3 = await commit({
            nodes: [
                { id: 'task-1010', kind: 'task', text: 'Query API for network rules' },
                { id: 'report-1010', kind: 'file', text: 'Network report' },
            ],
            edges: [{ from: 'task-1010', to: 'report-1010', relation: 'PRODUCED' }],
        });
        expect(res3.created).toBe(2);
    });
});

describe('a commit that cannot be honoured', () => {
    let dir: string;
    let work: string;
    let source: string;
    let index: MemoryIndex;
    let clock: IdClock;

    const WRITES = ['*'];

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'neo-index-'));
        work = await mkdtemp(join(tmpdir(), 'neo-work-'));
        source = join(work, 'audit.py');
        await writeFile(source, SCRIPT);
        clock = clockFrom();
        index = new MemoryIndex({ store: await MemoryStore.open(dir) });
    });

    afterEach(async () => {
        index.store.release();
        await rm(dir, { recursive: true, force: true });
        await rm(work, { recursive: true, force: true });
    });

    const commit = (tx: MemoryTransaction) =>
        index.commit(tx, { writes: WRITES, sees: WRITES, clock });

    /** The whole point of one transactional tool: no half-built graphs. */
    it('leaves nothing behind when a later edge is bad', async () => {
        await expect(
            commit({
                nodes: [
                    { ref: 'a', kind: 'task', text: 'one' },
                    { ref: 'b', kind: 'file', text: 'two', file: { source: hostFile(source) } },
                ],
                edges: [
                    { from: 'a', to: 'b', relation: 'PRODUCED' },
                    { from: 'a', to: 'ghost', relation: 'INFORMED' },
                ],
            }),
        ).rejects.toThrow(/neither a ref in this commit nor an existing memory id/);

        expect(index.graph.order).toBe(0);
        expect(index.graph.size).toBe(0);
        await expect(readFile(join(dir, 'files', 'ID2.py'))).rejects.toThrow();
    });

    it('names the offending node in the message', async () => {
        await expect(
            commit({ nodes: [{ ref: 'a', kind: 'nonsense', text: 'x' }] }),
        ).rejects.toThrow(/a: unknown kind "nonsense"/);
        await expect(commit({ nodes: [{ ref: 'a', kind: 'task', text: ' ' }] })).rejects.toThrow(
            /a: a new node needs text/,
        );
    });

    it('refuses a label the agent was not granted', async () => {
        await expect(
            commit({ nodes: [{ ref: 'a', kind: 'fact', text: 'x', audience: ['secret'] }] }),
        ).rejects.toThrow(/not allowed to label a memory "secret"/);
        expect(index.graph.order).toBe(0);
    });

    it('refuses two nodes with the same ref', async () => {
        await expect(
            commit({
                nodes: [
                    { ref: 'a', kind: 'fact', text: 'x' },
                    { ref: 'a', kind: 'fact', text: 'y' },
                ],
            }),
        ).rejects.toThrow(/two nodes share the ref "a"/);
    });

    it('refuses a node that is both a create and an update', async () => {
        await expect(
            commit({ nodes: [{ ref: 'a', id: 'ID9', kind: 'fact', text: 'x' }] }),
        ).rejects.toThrow(/either a ref .* or an id/);
        await expect(commit({ nodes: [{ kind: 'fact', text: 'x' }] })).rejects.toThrow(
            /either a ref .* or an id/,
        );
    });

    it('refuses an update to a non-existent memory id', async () => {
        await expect(commit({ nodes: [{ id: 'ghost' }] })).rejects.toThrow(/ghost: no such memory/);
    });

    it('reports a missing file using the passed path rather than the host path', async () => {
        await expect(
            commit({
                nodes: [
                    {
                        ref: 'f',
                        kind: 'file',
                        text: 'missing report',
                        file: {
                            source: hostFile(join(work, 'nonexistent.json')),
                            path: '/workspace/nonexistent.json',
                        },
                    },
                ],
            }),
        ).rejects.toThrow('/workspace/nonexistent.json does not exist');
    });

    it('refuses an empty transaction', async () => {
        await expect(commit({})).rejects.toThrow(MemoryError);
    });
});

describe('loading and forgetting', () => {
    let dir: string;
    let work: string;
    let index: MemoryIndex;
    let clock: IdClock;
    let ids: Record<string, string>;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'neo-index-'));
        work = await mkdtemp(join(tmpdir(), 'neo-work-'));
        const source = join(work, 'audit.py');
        await writeFile(source, SCRIPT);
        clock = clockFrom();
        index = new MemoryIndex({
            store: await MemoryStore.open(dir, { embedding: EMBEDDING }),
            embedder: new StubEmbedder(),
        });
        ({ ids } = await index.commit(
            {
                nodes: [
                    { ref: 'ask', kind: 'task', text: 'audit the firewall rules' },
                    {
                        ref: 'script',
                        kind: 'file',
                        text: 'generator',
                        file: { source: hostFile(source) },
                    },
                    {
                        ref: 'note',
                        kind: 'fact',
                        text: 'paging uses a cursor',
                        audience: ['triage'],
                    },
                ],
                edges: [{ from: 'ask', to: 'script', relation: 'PRODUCED' }],
            },
            { writes: ['*', 'triage'], sees: ['*', 'triage'], clock },
        ));
    });

    afterEach(async () => {
        index.store.release();
        await rm(dir, { recursive: true, force: true });
        await rm(work, { recursive: true, force: true });
    });

    it('counts a load as use and inlines a small file', async () => {
        const [loaded] = await index.load([ids.script], ['*'], clock);
        expect(loaded.node).toMatchObject({ useCount: 1 });
        expect(loaded.content).toBe(SCRIPT);
    });

    it('does not count a search as use', async () => {
        await index.search({ text: 'audit the firewall rules' }, ['*']);
        expect(index.graph.get(ids.ask)).toMatchObject({ useCount: 0 });
    });

    it('will not load what the agent cannot see, and does not admit it exists', async () => {
        await expect(index.load([ids.note], ['*'], clock)).rejects.toThrow(`no memory ${ids.note}`);
        await expect(index.load([ids.note], ['triage'], clock)).resolves.toHaveLength(1);
    });

    it('finds the subgraph a later query is about', async () => {
        const rec = await index.search({ text: 'audit the firewall rules' }, ['*']);
        expect(rec.seeds).toContain(ids.ask);
        expect(rec.nodes.map((n) => n.node.id)).toContain(ids.script);
    });

    it('forgets the node, its vector and its bytes', async () => {
        const file = index.graph.get(ids.script)!.file!;
        await index.forget([ids.script], ['*']);
        expect(index.graph.has(ids.script)).toBe(false);
        expect(index.store.vectors!.has(ids.script)).toBe(false);
        await expect(readFile(hostPath(dir, file))).rejects.toThrow();
    });

    it('survives a reopen', async () => {
        index.store.release();
        const reopened = await MemoryStore.open(dir, { embedding: EMBEDDING });
        expect(reopened.graph.order).toBe(3);
        expect(reopened.graph.get(ids.script)?.file?.path).toBe('ID2.py');
        expect(reopened.vectors!.rows).toBe(3);
        reopened.release();
        // the afterEach release must still find a lock it owns
        index = new MemoryIndex({ store: await MemoryStore.open(dir, { embedding: EMBEDDING }) });
    });
});

describe('the memory_commit tool', () => {
    let dir: string;
    let work: string;
    let index: MemoryIndex;
    let clock: IdClock;
    let commitTool: AnyTool;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'neo-index-'));
        work = await mkdtemp(join(tmpdir(), 'neo-work-'));
        await writeFile(join(work, 'audit.py'), SCRIPT);
        clock = clockFrom();
        index = new MemoryIndex({ store: await MemoryStore.open(dir) });
        const tools = memoryTools({
            index,
            binding: { access: 'full', sees: ['*'], writes: ['*'] },
        });
        commitTool = tools.find((t) => t.name === MEMORY_COMMIT_TOOL)!;
    });

    afterEach(async () => {
        index.store.release();
        await rm(dir, { recursive: true, force: true });
        await rm(work, { recursive: true, force: true });
    });

    const tc = (source?: (p: string) => FileSource): ToolContext =>
        ({
            callId: 'call1',
            state: { runId: 'run1' },
            services: {
                clock,
                files: { source: source ?? ((p: string) => hostFile(join(work, p))) },
            },
        }) as unknown as ToolContext;

    const unwrap = (ret: unknown) => (isToolReturn(ret) ? ret.output : ret);

    it('accepts file as a string path', async () => {
        const res = unwrap(
            await commitTool.execute(
                {
                    nodes: [{ ref: 's', kind: 'file', text: 'audit script', file: 'audit.py' }],
                },
                tc(),
            ),
        ) as { summary: string; ids: Record<string, string> };
        expect(res.ids.s).toBeDefined();
        expect(index.graph.get(res.ids.s)?.file?.format).toBe('py');
    });

    it('accepts file as an object with path', async () => {
        const res = unwrap(
            await commitTool.execute(
                {
                    nodes: [
                        {
                            ref: 's',
                            kind: 'file',
                            text: 'audit script',
                            file: { path: 'audit.py' },
                        },
                    ],
                },
                tc(),
            ),
        ) as { summary: string; ids: Record<string, string> };
        expect(res.ids.s).toBeDefined();
        expect(index.graph.get(res.ids.s)?.file?.format).toBe('py');
    });

    it('reports missing file using the passed path, not the host path', async () => {
        const res = unwrap(
            await commitTool.execute(
                {
                    nodes: [
                        {
                            ref: 's',
                            kind: 'file',
                            text: 'missing script',
                            file: { path: '/workspace/app-vm-1011-report.json' },
                        },
                    ],
                },
                tc((p: string) => hostFile(join(work, basename(p)))),
            ),
        ) as { error: string; hint?: string };
        expect(res.error).toBe('/workspace/app-vm-1011-report.json does not exist');
    });

    it('refuses empty file path with a clear hint', async () => {
        const res = unwrap(
            await commitTool.execute(
                {
                    nodes: [{ ref: 's', kind: 'file', text: 'empty path', file: { path: '   ' } }],
                },
                tc(),
            ),
        ) as { error: string; hint?: string };
        expect(res.error).toBe('file path is required');
    });
});
