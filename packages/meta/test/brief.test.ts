import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AnalyzeBrief, renderAnalyzeBrief } from '../src/meta/finetune/analyze-brief.ts';
import { editorSkills } from '../src/meta/finetune/apply-brief.ts';
import { BRIEF_MAX, files, type Step } from '../src/meta/finetune/brief.ts';
import type { Tuning } from '../src/meta/finetune/tuning.ts';

let root: string;
const calls: string[][] = [];

function brief(zen: (args: string[]) => { code: number; stdout: string }): AnalyzeBrief {
    return {
        t: {
            zen: async (args: string[]) => {
                calls.push(args);
                return zen(args);
            },
        } as unknown as Tuning,
        run: { dir: join(root, 'run'), memory: '', system: 3 },
        case: { id: 'c1', rev: 2, status: 'active', input: 'q', rubric: [] } as never,
        phase: 'nomem',
        attempt: 1,
        earlier: [],
        systemDir: root,
        dir: join(root, 'try'),
        project: async () => undefined,
    };
}

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'brief-'));
    calls.length = 0;
    mkdirSync(join(root, 'agents', 'prompts'), { recursive: true });
    writeFileSync(join(root, 'agents.yaml'), 'agents: {}\n');
    writeFileSync(join(root, 'agents', 'prompts', 'a.md'), 'say ``` then stop\n');
    writeFileSync(join(root, 'agents', 'prompts', 'b.md'), 'B\n');
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

describe('renderBrief', () => {
    it('shows each command with its output fenced, a glob as one block per file', async () => {
        const steps: Step<AnalyzeBrief>[] = [
            { zen: (b) => ['inspect', 'graph', '--dir', b.run.dir, '--no-style'] },
            { cat: () => ['agents.yaml', 'agents/prompts/*.md'] },
            { sh: (_b, q) => `printf %s ${q("it's here")}` },
        ];
        const text = await renderAnalyzeBrief(
            brief(() => ({ code: 0, stdout: 'flowchart TB\n' })),
            join(root, 'brief.log'),
            steps,
        );
        expect(text).toContain('## The brief');
        expect(text).toContain('on system v3');
        expect(text).toContain(
            `- each question for \`zen inspect ask\`: \`${join(root, 'try', 'ask')}/`,
        );
        expect(text).toContain(`> zen inspect graph --dir ${join(root, 'run')} --no-style`);
        expect(text).toContain('```text\nflowchart TB\n```');
        expect(text).toContain('> cat agents.yaml\n\n```yaml\nagents: {}\n```');
        // A literal glob path is not a file: it is listed as missing, not expanded.
        expect(text).toContain("> cat 'agents/prompts/*.md'\n\n(no such file)");
        expect(text).toContain("> printf %s 'it'\\''s here'\n\n```text\nit's here\n```");
    });

    it('expands globs with files(), and fences a file holding backticks so it cannot close', async () => {
        const text = await renderAnalyzeBrief(
            brief(() => ({ code: 0, stdout: '' })),
            'log',
            [{ cat: (b) => files(b, 'agents/prompts/*.md') }],
        );
        expect(text).toContain(
            '> cat agents/prompts/a.md\n\n````markdown\nsay ``` then stop\n````',
        );
        expect(text).toContain('> cat agents/prompts/b.md');
    });

    it('skips a step that returns nothing, and says when one failed', async () => {
        const text = await renderAnalyzeBrief(
            brief(() => ({ code: 2, stdout: 'half' })),
            'L',
            [
                { zen: () => undefined },
                { cat: () => undefined },
                { title: 'Nothing', fn: () => undefined },
                { zen: () => ['meta', 'dataset', 'show', 'c1@2', '--json'] },
                { sh: () => 'exit 4' },
            ],
        );
        expect(calls).toEqual([['meta', 'dataset', 'show', 'c1@2', '--json']]);
        expect(text).not.toContain('Nothing');
        expect(text).toContain('```json\nhalf\n```\n(exit 2 - see L)');
        expect(text).toContain('> exit 4\n\n```text\n(no output)\n```\n(exit 4)');
    });

    it('cuts a step at its max, and leaves out what would pass BRIEF_MAX', async () => {
        const big = 'x'.repeat(BRIEF_MAX);
        const text = await renderAnalyzeBrief(
            brief(() => ({ code: 0, stdout: big })),
            'L',
            [
                { zen: () => ['a'], max: 10 },
                { zen: () => ['b'], max: BRIEF_MAX },
                { title: 'After', fn: () => 'small' },
            ],
        );
        expect(text).toContain(`xxxxxxxxxx\n\`\`\`\n(cut at 10 of ${BRIEF_MAX} characters`);
        expect(text).toContain('> zen b\n\n(left out - the brief is full; run it yourself)');
        expect(text).toContain('### After\n\nsmall');
        expect(Buffer.byteLength(text)).toBeLessThan(BRIEF_MAX);
    });
});

describe('editorSkills', () => {
    it('names a skill for each capability the project uses, and memory for a mem run', () => {
        expect(editorSkills(root, [{ phase: 'nomem' }]).map(([n]) => n)).toEqual([
            'zen-instructions',
        ]);
        writeFileSync(
            join(root, 'agents.yaml'),
            'agents:\n  a:\n    handoffs: [b]\n    knowledge:\n      docs: x\n',
        );
        writeFileSync(
            join(root, 'agents', 'prompts', 'b.md'),
            'Use run_command with zen rag schema.\n',
        );
        expect(editorSkills(root, [{ phase: 'mem' }]).map(([n]) => n)).toEqual([
            'zen-instructions',
            'zen-memory',
            'zen-rag-docs',
            'zen-rag-schema',
            'zen-topology',
            'zen-code-python',
        ]);
    });
});
