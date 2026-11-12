import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runDataset } from '../src/meta/finetune/dataset/command.ts';
import { CliError, EXIT } from '../src/term.ts';
import { META_PROMPT_ENV, META_SESSION_ENV } from '../src/usage.ts';

let root: string;

beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'zen-dataset-')));
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    delete process.env[META_SESSION_ENV];
    delete process.env[META_PROMPT_ENV];
});

/** Runs a verb with --json and gives back stdout, parsed. */
async function zen(...args: string[]): Promise<any> {
    const out: string[] = [];
    const write = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation((chunk: string | Uint8Array) => {
            out.push(String(chunk));
            return true;
        });
    const quiet = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
        await runDataset({ args, json: true, cwd: root }, { dir: root, name: 'acme' });
    } finally {
        write.mockRestore();
        quiet.mockRestore();
    }
    const text = out.join('');
    try {
        return text ? JSON.parse(text) : undefined;
    } catch {
        return text;
    }
}

const put = (file: string, text: string): void => {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), text);
};

const putJson = (file: string, value: unknown): void => put(file, JSON.stringify(value));

const SPEC = `# Examples

Intro text.

## Query: organize my day

"organize my day"

## Query: find invoice

"find the invoice"

\`\`\`md
## not a heading
\`\`\`
`;

const planDay = (rubric: unknown[] = ['calls api /mail/list', 'proposes a schedule']) => ({
    id: 'plan-day',
    class: 'planning',
    complexity: 'complex',
    input: 'organize my day',
    rubric,
    source: { file: 'SPEC.md', anchor: { heading: 'Query: organize my day' } },
});

const findInvoice = {
    id: 'find-invoice',
    class: 'search',
    complexity: 'simple',
    input: 'find the invoice',
    rubric: ['searches the mailbox'],
    source: { file: 'SPEC.md', anchor: { heading: ['Examples', 'Query: find invoice'] } },
};

async function seed(): Promise<void> {
    put('SPEC.md', SPEC);
    putJson('proposal.json', { cases: [planDay(), findInvoice] });
    await zen('apply', 'proposal.json', '--why', 'first extraction');
}

describe('the dataset store', () => {
    it('writes a first revision and reports it clean', async () => {
        await seed();
        expect(existsSync(join(root, 'dataset', 'cases', 'plan-day.json'))).toBe(true);
        const status = await zen('status');
        expect(status).toMatchObject({
            revision: 1,
            cases: { active: 2, retired: 0 },
            classes: { planning: 1, search: 1 },
            drift: { clean: true },
        });
        const shown = (await zen('show', 'plan-day'))[0];
        expect(shown.rubric).toEqual([
            { id: 'r1', text: 'calls api /mail/list' },
            { id: 'r2', text: 'proposes a schedule' },
        ]);
        expect(shown.source.sha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it('applies the same proposal twice as no change at all', async () => {
        await seed();
        const again = await zen('apply', 'proposal.json', '--why', 'again');
        expect(again).toMatchObject({ revision: 1, added: [], updated: [], unchanged: 2 });
    });

    it('finds the one case whose section moved, and only that one', async () => {
        await seed();
        put('SPEC.md', SPEC.replace('"find the invoice"', '"find the invoice from March"'));
        const report = await zen('drift');
        expect(report.files).toEqual([{ file: 'SPEC.md', state: 'changed' }]);
        expect(report.cases).toEqual([
            expect.objectContaining({ id: 'find-invoice', state: 'changed' }),
        ]);
        expect(report.unchanged).toBe(1);
    });

    it('refreshes a hash without a revision when the case reads the same', async () => {
        await seed();
        put('SPEC.md', SPEC.replace('"find the invoice"', '"find the invoice."'));
        putJson('partial.json', { cases: [findInvoice] });
        const applied = await zen('apply', 'partial.json', '--partial', '--why', 'reworded');
        expect(applied).toMatchObject({ revision: 1, refreshed: ['find-invoice'], updated: [] });
        expect((await zen('drift')).clean).toBe(true);
    });

    it('keeps a file looking moved while one of its cases is still drifted', async () => {
        await seed();
        put(
            'SPEC.md',
            SPEC.replace('"find the invoice"', '"find it"').replace(
                '"organize my day"',
                '"plan it"',
            ),
        );
        putJson('partial.json', { cases: [findInvoice] });
        await zen('apply', 'partial.json', '--partial', '--why', 'one of two');
        const report = await zen('drift');
        expect(report.cases.map((c: { id: string }) => c.id)).toEqual(['plan-day']);
    });

    it('restarts a case whose rubric changed, keeping the ids of the lines that did not', async () => {
        await seed();
        putJson('partial.json', { cases: [planDay(['calls api /mail/list', 'proposes a plan'])] });
        const applied = await zen('apply', 'partial.json', '--partial', '--why', 'rubric reworded');
        expect(applied).toMatchObject({
            revision: 2,
            updated: ['plan-day'],
            restarted: ['plan-day'],
        });
        const now = (await zen('show', 'plan-day'))[0];
        expect(now.rev).toBe(2);
        expect(now.rubric).toEqual([
            { id: 'r1', text: 'calls api /mail/list' },
            { id: 'r3', text: 'proposes a plan' },
        ]);
        const then = (await zen('show', 'plan-day@1'))[0];
        expect(then.rubric[1].text).toBe('proposes a schedule');
    });

    it('does not restart a case for a change that is not to what it asks', async () => {
        await seed();
        putJson('partial.json', { cases: [{ ...findInvoice, notes: 'from §4' }] });
        const applied = await zen('apply', 'partial.json', '--partial', '--why', 'a note');
        expect(applied).toMatchObject({ updated: ['find-invoice'], restarted: [] });
    });

    it('retires what a whole proposal leaves out, and never deletes it', async () => {
        await seed();
        putJson('proposal.json', { cases: [planDay()] });
        const applied = await zen('apply', 'proposal.json', '--why', 'dropped from the spec');
        expect(applied.retired).toEqual(['find-invoice']);
        expect((await zen('ls')).map((c: { id: string }) => c.id)).toEqual(['plan-day']);
        expect((await zen('ls', '--status', 'all')).length).toBe(2);
    });

    it('reports a new section as uncovered until it is a case or ignored', async () => {
        await seed();
        put('SPEC.md', `${SPEC}\n## Notes for readers\n\nNot a query.\n`);
        const report = await zen('drift');
        expect(report.uncovered).toEqual([
            { file: 'SPEC.md', anchor: { heading: ['Examples', 'Notes for readers'] } },
        ]);
        await zen('ignore', 'SPEC.md', '--heading', 'Notes for readers', '--why', 'no query');
        expect((await zen('drift')).clean).toBe(true);
    });

    it('refuses an anchor that does not resolve, writing nothing', async () => {
        put('SPEC.md', SPEC);
        putJson('proposal.json', {
            cases: [{ ...findInvoice, source: { file: 'SPEC.md', anchor: { heading: 'Nope' } } }],
        });
        await expect(zen('apply', 'proposal.json', '--why', 'x')).rejects.toMatchObject({
            code: EXIT.invalid,
        });
        expect(existsSync(join(root, 'dataset', 'manifest.json'))).toBe(false);
    });

    it('keeps an override through a later re-extraction', async () => {
        await seed();
        await zen(
            'update',
            'plan-day',
            '--set',
            'class=calendar',
            '--override',
            '--why',
            'by hand',
        );
        await zen('apply', 'proposal.json', '--why', 're-extract');
        expect((await zen('show', 'plan-day'))[0]).toMatchObject({
            class: 'calendar',
            overrides: ['class'],
        });
    });

    it('stamps changes and notes with the meta session that made them', async () => {
        process.env[META_SESSION_ENV] = '6f1c0000-0000-4000-8000-000000000000';
        process.env[META_PROMPT_ENV] = 'dataset';
        await seed();
        process.env[META_PROMPT_ENV] = 'analyze';
        await zen(
            'note',
            'plan-day',
            '--verdict',
            'wrong',
            '--rubric',
            'r1=pass,r2=fail',
            '--run',
            'b1',
            '-m',
            'no plan',
        );
        const rows = await zen('log', 'plan-day');
        expect(rows.map((r: { type: string }) => r.type)).toEqual(['change', 'note']);
        expect(rows[0].by).toMatchObject({
            session: expect.stringMatching(/^6f1c/),
            prompt: 'dataset',
        });
        expect(rows[1]).toMatchObject({
            kind: 'graded',
            caseRev: 1,
            verdict: 'wrong',
            rubric: { r1: 'pass', r2: 'fail' },
            by: { prompt: 'analyze' },
        });
    });

    it('refuses a rubric line the case does not have', async () => {
        await seed();
        await expect(
            zen('note', 'plan-day', '--rubric', 'r9=pass', '-m', 'x'),
        ).rejects.toMatchObject({
            code: EXIT.usage,
        });
    });

    it('refuses to write while another live process holds the dataset', async () => {
        await seed();
        writeFileSync(
            join(root, 'dataset', '.lock'),
            JSON.stringify({ pid: process.pid, host: hostname(), startedAt: 'now' }),
        );
        await expect(zen('retire', 'plan-day', '--why', 'x')).rejects.toBeInstanceOf(CliError);
        rmSync(join(root, 'dataset', '.lock'));
    });

    it('wants a reason for every write', async () => {
        await seed();
        await expect(zen('retire', 'plan-day')).rejects.toMatchObject({ code: EXIT.usage });
    });

    it('follows a JSON pointer into YAML, and ignores a reordering', async () => {
        put('cases.yaml', 'cases:\n  - q: one\n    a: 1\n  - q: two\n    a: 2\n');
        putJson('proposal.json', {
            cases: [
                {
                    id: 'one',
                    input: 'one',
                    source: { file: 'cases.yaml', anchor: { pointer: '/cases/0' } },
                },
                {
                    id: 'two',
                    input: 'two',
                    source: { file: 'cases.yaml', anchor: { pointer: '/cases/1' } },
                },
            ],
        });
        await zen('apply', 'proposal.json', '--why', 'yaml');
        put('cases.yaml', 'cases:\n  - a: 1\n    q: one\n  - q: two\n    a: 3\n');
        const report = await zen('drift');
        expect(report.cases.map((c: { id: string }) => c.id)).toEqual(['two']);
    });

    it('imports an old dataset.json, rebasing media paths onto the project', async () => {
        put('finetune/assets/receipt.jpg', 'jpeg');
        putJson('finetune/dataset.json', {
            version: 1,
            samples: [
                {
                    id: 'receipt',
                    class: 'extraction',
                    input: ['file this', { image: './assets/receipt.jpg' }],
                    rubric: ['reads the total'],
                },
            ],
        });
        await zen('apply', 'finetune/dataset.json', '--why', 'import');
        const stored = JSON.parse(
            readFileSync(join(root, 'dataset', 'cases', 'receipt.json'), 'utf8'),
        );
        expect(stored.input[1]).toEqual({ image: 'finetune/assets/receipt.jpg' });

        await zen('export', '--format', 'batch', '-o', 'runs/b1/cases.json');
        const batch = JSON.parse(readFileSync(join(root, 'runs', 'b1', 'cases.json'), 'utf8'));
        expect(batch).toEqual({
            batch: [
                {
                    id: 'receipt',
                    input: ['file this', { image: '../../finetune/assets/receipt.jpg' }],
                },
            ],
        });
    });
});

describe('drawing a sample', () => {
    const CASES = [
        { id: 'a1', class: 'alpha', complexity: 'complex', rubric: ['x'], tags: ['mail'] },
        { id: 'a2', class: 'alpha', complexity: 'simple', rubric: ['x'] },
        { id: 'a3', class: 'alpha', complexity: 'medium' },
        { id: 'a4', class: 'alpha', complexity: 'complex', rubric: ['x'] },
        { id: 'b1', class: 'beta', complexity: 'simple', rubric: ['x'], tags: ['mail'] },
        { id: 'b2', class: 'beta', complexity: 'complex' },
        { id: 'b3', class: 'beta', complexity: 'medium', rubric: ['x'] },
        { id: 'c1', class: 'gamma', complexity: 'medium', rubric: ['y'] },
        { id: 'c2', class: 'gamma', complexity: 'simple' },
    ].map((c) => ({ ...c, input: `question ${c.id}` }));

    beforeEach(async () => {
        putJson('proposal.json', { cases: CASES });
        await zen('apply', 'proposal.json', '--why', 'seed');
    });

    const ids = async (...args: string[]): Promise<string[]> =>
        (await zen('sample', '--format', 'json', ...args)).ids;

    it('takes classes in turn, graded and complex cases first', async () => {
        const drawn = await ids();
        // a1 and a4 tie on rubric and complexity: the seed decides between them.
        expect(['a1', 'a4']).toContain(drawn[0]);
        expect(drawn.slice(1, 3)).toEqual(['b3', 'c1']);
        expect(drawn).toHaveLength(9);
        expect(drawn.indexOf('a2')).toBeGreaterThan(drawn.indexOf('a4'));
        expect(drawn.indexOf('a3')).toBeGreaterThan(drawn.indexOf('a2'));
    });

    it('is the same twice, and a longer draw starts with the shorter one', async () => {
        expect(await ids('--seed', '7')).toEqual(await ids('--seed', '7'));
        const short = await ids('-n', '4', '--seed', '3');
        expect((await ids('-n', '8', '--seed', '3')).slice(0, 4)).toEqual(short);
    });

    it('gives a heavier stratum more turns', async () => {
        const drawn = await ids('-n', '4', '--weight', 'alpha=2');
        expect(drawn.filter((id) => id.startsWith('a'))).toHaveLength(2);
    });

    it('stratifies by several fields at once', async () => {
        const out = await zen('sample', '--format', 'json', '--by', 'class,rubric');
        expect(out.strata.map((s: { key: string }) => s.key)).toContain('alpha · no rubric');
    });

    it('filters by tag, rubric, text, id and exclusion', async () => {
        expect(await ids('--tag', 'mail')).toEqual(['a1', 'b1']);
        expect((await ids('--rubric', 'no')).sort()).toEqual(['a3', 'b2', 'c2']);
        expect(await ids('--grep', 'question c')).toHaveLength(2);
        expect((await ids('--id', 'b*', '--exclude', 'b2')).sort()).toEqual(['b1', 'b3']);
    });

    it('takes ids from a file of any of the shapes that carry them', async () => {
        putJson('pick.json', { batch: [{ id: 'c2' }, { id: 'a3' }] });
        expect((await ids('--ids-from', 'pick.json')).sort()).toEqual(['a3', 'c2']);
    });

    it('refuses a class the dataset does not have rather than drawing nothing', async () => {
        await expect(zen('sample', '--class', 'alfa')).rejects.toMatchObject({ code: EXIT.usage });
    });

    it('reads verdicts off the current revision only', async () => {
        await zen('note', 'b1', '--verdict', 'wrong', '-m', 'missed it');
        expect(await ids('--verdict', 'wrong')).toEqual(['b1']);
        await zen('update', 'b1', '--rubric-add', 'also checks the date', '--why', 'stricter');
        expect(await ids('--verdict', 'wrong')).toEqual([]);
        expect(await ids('--never-graded')).toContain('b1');
        expect(await ids('--restarted')).toEqual(['b1']);
        expect(await ids('--changed-since', '1')).toEqual(['b1']);
    });

    it('samples the dataset as it stood at a revision', async () => {
        await zen('update', 'c2', '--set', 'input=something else', '--why', 'reworded');
        expect(await ids('--grep', 'question c2')).toEqual([]);
        expect(await ids('--grep', 'question c2', '--at', '1')).toEqual(['c2']);
    });

    it('writes batch input with no rubric in it', async () => {
        const batch = await zen('sample', '--format', 'batch', '--class', 'gamma');
        expect(batch.batch).toEqual([
            { id: 'c1', input: 'question c1' },
            { id: 'c2', input: 'question c2' },
        ]);
    });
});
