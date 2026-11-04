import {
    frontmatter,
    MEMORY_COMMIT_TOOL,
    MEMORY_COPY_FILE_TOOL,
    MEMORY_FORGET_TOOL,
    MEMORY_GREP_TOOL,
    MEMORY_LOAD_TOOL,
    MEMORY_SEARCH_TOOL,
    renderRecollection,
    toList,
    type MemoryNode,
    type Recollection,
} from '@zenera/neo';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { refreshShared, scaffold, SHARED_RULES } from '../src/scaffold.ts';
import { validateProject, type Finding } from '../src/validate.ts';

// ---------------------------------------------------------------------------
// The memory house rules
//
// `agents/memory-instructions.md` is the only place memory is explained to a
// model: the runtime composes the preference block and nothing else, so text
// that has fallen behind the code is not caught by a compiler, a type or a
// missing import. It used to be a template literal in `packages/neo`, where
// renaming a tool broke the build. These tests are what replaced that.
//
// Two things are checked. That every tool the document names exists and every
// tool that exists is named — a rename is otherwise silent. And that the layout
// it describes is the layout `renderRecollection` emits, by rendering one and
// reading the claims off the prose beside it.
// ---------------------------------------------------------------------------

const TEMPLATE = fileURLToPath(
    new URL('../templates/project/agents/memory-instructions.md', import.meta.url),
);

const rules = readFileSync(TEMPLATE, 'utf8');

const TOOLS = [
    MEMORY_SEARCH_TOOL,
    MEMORY_GREP_TOOL,
    MEMORY_LOAD_TOOL,
    MEMORY_COMMIT_TOOL,
    MEMORY_FORGET_TOOL,
    MEMORY_COPY_FILE_TOOL,
];

describe('the tools the house rules name', () => {
    it('all exist', () => {
        const named = new Set(rules.match(/memory_[a-z_]+/g) ?? []);
        named.delete('memory_');
        expect([...named].filter((n) => !TOOLS.includes(n))).toEqual([]);
    });

    it('cover every memory tool there is, so a new one is not left undocumented', () => {
        expect(TOOLS.filter((t) => !rules.includes(t))).toEqual([]);
    });

    it('gate writing on having the tool, since the file is read by agents that cannot', () => {
        const end = rules.indexOf('## Read');
        expect(end).toBeGreaterThan(0);
        const gate = rules.slice(0, end);
        expect(gate).toContain(MEMORY_COMMIT_TOOL);
        expect(gate).toContain(MEMORY_FORGET_TOOL);
    });

    // The gate above narrows read to write; this one keeps the document away
    // from an agent with no memory at all, which the prose cannot do.
    it('are delivered on the capability they are about', () => {
        expect(toList(frontmatter(rules).data.requires)).toEqual(['memory']);
    });
});

/**
 * The prose describes a layout that lives in another package. Nothing but this
 * stops the renderer moving and the document staying behind, still confidently
 * telling the model to look for something that is no longer there.
 */
describe('the house rules match what the renderer emits', () => {
    const T0 = '2025-01-01T00:00:00.000Z';

    const node = (id: string, kind: string, extra: Partial<MemoryNode> = {}): MemoryNode => ({
        id,
        kind,
        text: 'risk report generator',
        audience: ['*'],
        createdAt: T0,
        updatedAt: T0,
        lastUsedAt: T0,
        useCount: 0,
        revision: 1,
        ...extra,
    });

    const rec: Recollection = {
        nodes: [
            { node: node('T1', 'task'), score: 0.9, seed: true },
            {
                node: node('F1', 'file', {
                    file: {
                        path: '/memory/F1.py',
                        bytes: 4312,
                        sha256: 'a'.repeat(64),
                        format: 'py',
                    },
                }),
                score: 0,
                seed: false,
                via: { from: 'T1', relation: 'PRODUCED', outbound: true },
            },
        ],
        edges: [{ source: 'T1', target: 'F1', relation: 'PRODUCED' }],
        seeds: ['T1'],
        truncated: false,
    };

    const out = renderRecollection(rec, { now: Date.parse(T0) });

    it('claims the block is tagged, and it is', () => {
        expect(rules).toContain('<memory-recollection>');
        expect(out.startsWith('<memory-recollection>')).toBe(true);
    });

    it('claims a matched root reads `score kind id`, and it does', () => {
        expect(rules).toContain('`score kind id`');
        expect(out).toContain('0.90  task  T1');
    });

    it('claims an unmatched root carries `--`, and it does', () => {
        expect(rules).toContain('`--`');
        const only: Recollection = {
            ...rec,
            nodes: [{ node: node('T1', 'task'), score: 0, seed: false }],
            edges: [],
            seeds: [],
        };
        expect(renderRecollection(only, { now: Date.parse(T0) })).toContain('--  task  T1');
    });

    it('claims an arrow names the relation, and it does', () => {
        expect(rules).toContain('\u2192produced');
        expect(rules).toContain('\u2190informed');
        expect(out).toContain('  \u2192produced  file  F1');
    });

    it('claims a file shows name, size and use, and it does', () => {
        expect(rules).toContain('`<id>.<ext>` name, size, and use count');
        expect(out).toContain(' F1.py \u00b7 4.2 KB \u00b7 unused');
        expect(out).not.toContain('/memory/');
    });

    it('claims indentation is the graph, and the child is indented under its parent', () => {
        const [root, , child] = out.split('\n').slice(1);
        expect(root?.startsWith('0.90')).toBe(true);
        expect(child?.startsWith('  \u2192')).toBe(true);
    });

    // The number is written out in three places in the prose and nowhere in a
    // header the document can import, so it is the one most likely to drift.
    it('states the clip length the renderer actually applies', () => {
        const stated = [...rules.matchAll(/(\d+) characters/g)].map((m) => Number(m[1]));
        expect(stated.length).toBeGreaterThan(0);
        expect(new Set(stated).size).toBe(1);

        const clip = stated[0]!;
        const long: Recollection = {
            ...rec,
            nodes: [
                {
                    node: node('T1', 'task', { text: 'x'.repeat(clip + 50) }),
                    score: 0.9,
                    seed: true,
                },
            ],
            edges: [],
        };
        const line = renderRecollection(long, { now: Date.parse(T0), tagged: false })
            .split('\n')
            .find((l) => l.includes('x'));
        expect(line?.trim().length).toBe(clip);
    });
});

describe('the copies a scaffold leaves behind', () => {
    const dirs: string[] = [];

    afterAll(() => {
        for (const dir of dirs) {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('are byte-identical to the template', () => {
        const dir = mkdtempSync(join(tmpdir(), 'zen-mem-rules-'));
        dirs.push(dir);
        scaffold({ dir, model: 'openai:gpt-5', embedding: 'openai:text-embedding-3-small' });

        expect(readFileSync(join(dir, 'agents', 'memory-instructions.md'), 'utf8')).toBe(rules);
    });

    // `requires: [memory]` is only worth writing if the scaffolded agent still
    // gets the document — an over-tight condition is a silent loss.
    it('still reach the agent a scaffold turns memory on for', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'zen-mem-reach-'));
        dirs.push(dir);
        scaffold({ dir, model: 'openai:gpt-5', embedding: 'openai:text-embedding-3-small' });

        const report = await validateProject({ dir });
        expect(report.agents[0]?.instructions).toContain('agents/memory-instructions.md');
    });

    // Nothing else notices the loss: the project still loads and the tools are
    // still granted, so the check has to be the thing that fails the build.
    it('are what stops `zen check` failing on uninstructed memory', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'zen-mem-check-'));
        dirs.push(dir);
        scaffold({ dir, model: 'openai:gpt-5', embedding: 'openai:text-embedding-3-small' });

        const uninstructed = async (): Promise<Finding | undefined> => {
            const report = await validateProject({ dir });
            return report.findings.find((f) => f.code === 'memory.uninstructed');
        };

        expect(await uninstructed()).toBeUndefined();

        rmSync(join(dir, 'agents', 'memory-instructions.md'));
        expect((await uninstructed())?.severity).toBe('error');

        writeFileSync(join(dir, 'agents', 'memory-instructions.md'), '');
        expect((await uninstructed())?.severity).toBe('error');
    });

    // The other half of `keep: true`: a scaffold never overwrites, which is
    // right for the files a project makes its own and wrong for these.
    it('are what `refreshShared` puts back, edits and all', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'zen-mem-fix-'));
        dirs.push(dir);
        scaffold({ dir, model: 'openai:gpt-5', embedding: 'openai:text-embedding-3-small' });

        const own = join(dir, 'agents', 'instructions.md');
        const mine = 'these are mine\n';
        writeFileSync(own, mine);
        for (const rel of SHARED_RULES) {
            writeFileSync(join(dir, rel), 'drifted\n');
        }

        const written = refreshShared(dir);

        expect(written.slice(0, SHARED_RULES.length)).toEqual([...SHARED_RULES]);
        expect(readFileSync(join(dir, 'agents', 'memory-instructions.md'), 'utf8')).toBe(rules);
        expect(readFileSync(join(dir, 'agents', 'tools-instructions.md'), 'utf8')).not.toBe(
            'drifted\n',
        );
        // The project's own house rules are not ours to replace.
        expect(readFileSync(own, 'utf8')).toBe(mine);

        const report = await validateProject({ dir });
        expect(report.findings.some((f) => f.code === 'memory.uninstructed')).toBe(false);

        // A second pass has nothing left to change, so it reports nothing.
        expect(refreshShared(dir)).toEqual([]);
    });

    // A copy from before `requires:` existed is the stale one in the wild, and
    // it is invisible to every other check: it loads, it is not empty, and the
    // missing condition only makes it reach *more* agents than it should.
    it('are reported stale when the bytes are an older `zen`\u2019s', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'zen-mem-stale-'));
        dirs.push(dir);
        scaffold({ dir, model: 'openai:gpt-5', embedding: 'openai:text-embedding-3-small' });

        const stale = async (): Promise<Finding[]> =>
            (await validateProject({ dir })).findings.filter((f) => f.code === 'rules.stale');

        expect(await stale()).toEqual([]);

        writeFileSync(
            join(dir, 'agents', 'memory-instructions.md'),
            `${frontmatter(rules).body}\n`,
        );
        const found = await stale();
        expect(found.map((f) => f.where)).toEqual(['agents/memory-instructions.md']);
        expect(found[0]?.severity).toBe('warning');

        refreshShared(dir);
        expect(await stale()).toEqual([]);
    });
});
