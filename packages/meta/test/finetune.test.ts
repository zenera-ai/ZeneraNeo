import { MemoryStore } from '@zenera/neo';
import { type ChildProcess, spawn } from 'node:child_process';
import {
    appendFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { remember } from '../src/finetune/children.ts';
import { readConfig, runFinetune } from '../src/finetune/command.ts';
import { measure, overLimits } from '../src/finetune/cost.ts';
import { runDataset } from '../src/dataset/command.ts';
import { readFeedback } from '../src/finetune/feedback.ts';
import { Journal } from '../src/finetune/journal.ts';
import { SystemVersions } from '../src/finetune/system.ts';
import { FAILURES_IN_A_ROW, type Zen } from '../src/finetune/tuning.ts';
import { runMetrics } from '../src/finetune/usage.ts';

/** A real memory of this size, which is all the tuning reads of one. */
async function fakeMemory(dir: string, nodes: number, edges: number): Promise<void> {
    const store = await MemoryStore.open(dir);
    const at = '2026-01-01T00:00:00.000Z';
    store.write(() => {
        for (let i = 0; i < nodes; i++) {
            if (!store.graph.has(`n${i}`)) {
                store.graph.add(
                    { id: `n${i}`, kind: 'fact', text: `fact ${i}`, audience: ['*'] },
                    at,
                );
            }
        }
        for (let i = 0; i < edges; i++) {
            store.graph.link(`n${i}`, `n${i + 1}`, 'INFORMED', at);
        }
    });
    store.release();
}

let root: string;

beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'zen-finetune-')));
    writeFileSync(join(root, 'agents.yaml'), 'agents:\n  - name: default\n');
    mkdirSync(join(root, 'agents'));
    writeFileSync(join(root, 'agents', 'instructions.md'), '# Rules\n');
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
        return await fn();
    } finally {
        out.mockRestore();
        err.mockRestore();
    }
};

async function dataset(ids: string[]): Promise<void> {
    writeFileSync(
        join(root, 'proposal.json'),
        JSON.stringify({
            cases: ids.map((id) => ({
                id,
                class: id[0],
                input: `question ${id}`,
                rubric: ['answers it'],
            })),
        }),
    );
    await quiet(() =>
        runDataset(
            { args: ['apply', 'proposal.json', '--why', 'test'], json: true, cwd: root },
            { dir: root, name: 'acme' },
        ),
    );
}

interface Verdict {
    done: boolean;
    improvements?: number;
    /** milliseconds the run takes */
    slow?: number;
    /** milliseconds the analysis takes */
    slowAnalyze?: number;
    /** the analysis dies before it writes feedback, as on a provider outage */
    broken?: boolean;
    /** `zen run` exits with this code before it starts, as when podman is down */
    exit?: number;
    /** a sandbox tool got this error from the container engine mid-run */
    sandbox?: string;
    /** the analysis finds the run void, for this reason */
    infra?: string;
    /** `zen meta run` started this session instead, as when the meta model changed */
    newSession?: string;
    /** skills the run loads */
    loads?: string[];
    /** the rubric line is broken: graded `invalid`, the one finding a `specification` improvement */
    spec?: boolean;
}

/** What `zen meta run --json` reports about itself. */
const META_ENVELOPE = {
    model: 'vertex/gemini-meta',
    tokens: {
        calls: 2,
        inputTokens: 500,
        cachedInputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 10,
    },
};

/**
 * A stand-in for the `zen` binary. `decide` says how each try's analysis comes
 * out, given the case, phase, attempt, how many applies have happened, and
 * whether the try is a recheck.
 */
function fakeZen(
    decide: (
        c: string,
        phase: string,
        attempt: number,
        applies: number,
        recheck: boolean,
    ) => Verdict,
) {
    const calls: string[][] = [];
    let runs = 0;
    let applies = 0;
    let failChecks = 0;
    let forgetDecisions = 0;
    let applyMs = 0;
    let applyText = (n: number) => `- rule ${n}\n`;
    let decision = (_request: string, _improvement: string, _apply: number): object => ({
        decision: 'applied',
        note: 'agents/instructions.md',
    });
    let editDuringAnalyze = false;
    const zen: Zen = async (args, log) => {
        calls.push(args);
        if (args[0] === 'run') {
            const input = JSON.parse(readFileSync(args[args.indexOf('--input') + 1], 'utf8'))
                .input as string;
            const v = decideFor(args, decide, applies, input.replace('question ', ''));
            if (v.exit) {
                appendFileSync(log, 'error   podman is installed but not responding\n');
                return { code: v.exit, stdout: '' };
            }
            if (v.slow) {
                await new Promise((r) => setTimeout(r, v.slow));
            }
            const dir = join(root, 'sessions', 's', 'runs', String(++runs));
            mkdirSync(dir, { recursive: true });
            // With memory the run recalls instead of researching: one call and one error fewer.
            const withMemory = /\/\d{2}-mem\//.test(args[args.indexOf('--input') + 1]);
            writeFileSync(
                join(dir, 'meta.json'),
                JSON.stringify({
                    turns: 5,
                    durationMs: withMemory ? 600 : 1200,
                    usage: { inputTokens: 900, outputTokens: 100 },
                }),
            );
            writeFileSync(join(dir, 'graph.mmd'), 'flowchart TD\n');
            const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
            const call = (id: string, model: string, s = 0) => ({
                id,
                ts: at(s),
                type: 'llm_call',
                model,
                usage: { inputTokens: 300, outputTokens: 30 },
            });
            // c1 appears again inside a branch: it must be counted once.
            writeFileSync(
                join(dir, 'state.json'),
                JSON.stringify({
                    trajectory: [
                        ...(v.loads
                            ? [
                                  {
                                      id: 'ls',
                                      ts: at(1),
                                      type: 'load_skills',
                                      skills: v.loads.map((name) => ({ name })),
                                  },
                              ]
                            : []),
                        call('c1', 'gemini-a', 2),
                        ...(v.sandbox
                            ? [
                                  {
                                      id: 'tb',
                                      ts: at(3),
                                      type: 'tool_result',
                                      isError: true,
                                      result: {
                                          store: 'mem',
                                          sha256: 'x',
                                          size: 1,
                                          preview: JSON.stringify({ error: v.sandbox }),
                                      },
                                  },
                              ]
                            : []),
                        {
                            id: 't1',
                            ts: at(5),
                            type: 'tool_result',
                            isError: !withMemory,
                            durationMs: 3000,
                        },
                        ...(withMemory
                            ? [{ id: 'm1', ts: at(5), type: 'memory_recall' }]
                            : [call('c2', 'gemini-a', 7)]),
                        call('c3', 'gemini-b', 9),
                        {
                            id: 'j1',
                            ts: at(9),
                            type: 'join',
                            branches: [{ nodes: [call('c1', 'gemini-a', 2)] }],
                        },
                    ],
                }),
            );
            writeFileSync(join(dir, 'report.html'), '<html></html>');
            const memory = args[args.indexOf('--memory') + 1];
            await fakeMemory(memory, 1, 0);
            writeFileSync(args[args.indexOf('--out') + 1], JSON.stringify({ run: { dir } }));
            return { code: 0, stdout: '' };
        }
        if (args[0] === 'check') {
            return { code: failChecks-- > 0 ? 3 : 0, stdout: '' };
        }
        if (args[0] === 'memory' && args[1] === 'merge') {
            const target = args[args.indexOf('--dir') + 1];
            const sources = args.slice(2, args.indexOf('--dir'));
            await fakeMemory(target, sources.length * 10, sources.length);
            return { code: 0, stdout: '' };
        }
        if (args[0] === 'meta' && args.includes('/zen-finetune-apply')) {
            const dir = args.at(-1)!;
            appendFileSync(join(root, 'agents', 'instructions.md'), applyText(++applies));
            if (applyMs) {
                await new Promise((r) => setTimeout(r, applyMs));
            }
            if (forgetDecisions-- > 0) {
                return { code: 0, stdout: JSON.stringify(META_ENVELOPE) };
            }
            const inputs = JSON.parse(readFileSync(join(dir, 'inputs.json'), 'utf8')) as {
                id: string;
                improvements: { id: string }[];
            }[];
            writeFileSync(
                join(dir, 'decisions.json'),
                JSON.stringify(
                    Object.fromEntries(
                        inputs.map((f) => [
                            f.id,
                            Object.fromEntries(
                                f.improvements.map((i) => [i.id, decision(f.id, i.id, applies)]),
                            ),
                        ]),
                    ),
                ),
            );
            writeFileSync(join(dir, 'changes.md'), '# changes\n');
            return { code: 0, stdout: JSON.stringify(META_ENVELOPE) };
        }
        if (args[0] === 'meta' && args.includes('/analyze')) {
            const word = (k: string) =>
                args.find((a) => a.startsWith(`${k}=`))!.slice(k.length + 1);
            const v = decide(
                word('case'),
                word('phase'),
                Number(word('attempt')),
                applies,
                args.some((a) => a.startsWith('recheck=')),
            );
            if (v.slowAnalyze) {
                await new Promise((r) => setTimeout(r, v.slowAnalyze));
            }
            if (editDuringAnalyze) {
                appendFileSync(join(root, 'agents', 'instructions.md'), '- sneaky\n');
            }
            if (v.broken) {
                appendFileSync(
                    log,
                    [
                        'log  /tmp/meta.20261008-x.log',
                        '"404 Not Found" (404)',
                        "Model 'claude-x' not found on provider at http://127.0.0.1:1 (HTTP 404).",
                        'error the meta agent exited 1',
                        '        resume it: zen meta resume acme x',
                        '',
                    ].join('\n'),
                );
                return { code: 1, stdout: '' };
            }
            if (v.infra) {
                writeFileSync(
                    word('feedback'),
                    JSON.stringify({
                        verdict: 'void',
                        infra: v.infra,
                        rubric: {},
                        done: false,
                        summary: '',
                        improvements: [],
                    }),
                );
                return { code: 0, stdout: JSON.stringify(META_ENVELOPE) };
            }
            writeFileSync(
                word('feedback'),
                JSON.stringify({
                    verdict: v.done ? 'right' : 'wrong',
                    rubric: { r1: v.spec ? 'invalid' : v.done ? 'pass' : 'fail' },
                    done: v.done,
                    summary: v.done ? 'fine' : 'misses it | badly',
                    improvements: v.spec
                        ? [
                              {
                                  id: 'i1',
                                  kind: 'specification',
                                  change: 'r1 names one implementation',
                              },
                          ]
                        : Array.from({ length: v.improvements ?? (v.done ? 0 : 1) }, (_, i) => ({
                              id: `i${i + 1}`,
                              change: `say it ${i + 1}`,
                          })),
                }),
            );
            const answer = join(root, '.tmp', `answer-${calls.length}.md`);
            mkdirSync(join(root, '.tmp'), { recursive: true });
            writeFileSync(answer, '**Run** - fine.\n');
            const session =
                args[args.indexOf(args.includes('--session-id') ? '--session-id' : '--resume') + 1];
            return {
                code: 0,
                stdout: JSON.stringify({
                    ...META_ENVELOPE,
                    sessionId: v.newSession ?? session,
                    answerFile: answer,
                }),
            };
        }
        return { code: 0, stdout: '{}' };
    };
    return {
        zen,
        calls,
        get applies() {
            return applies;
        },
        failChecks(n: number) {
            failChecks = n;
        },
        /** The next n applies edit, then end without writing decisions.json - as a cut-off agent does. */
        forgetDecisions(n: number) {
            forgetDecisions = n;
        },
        slowApply(ms: number) {
            applyMs = ms;
        },
        applyWrites(text: (n: number) => string) {
            applyText = text;
        },
        decides(fn: (request: string, improvement: string, apply: number) => object) {
            decision = fn;
        },
        editDuringAnalyze() {
            editDuringAnalyze = true;
        },
    };
}

function decideFor(
    args: string[],
    decide: (
        c: string,
        phase: string,
        attempt: number,
        applies: number,
        recheck: boolean,
    ) => Verdict,
    applies: number,
    id: string,
): Verdict {
    const input = args[args.indexOf('--input') + 1];
    const m = /(\d{2})-(nomem|mem)/.exec(input)!;
    return decide(id, m[2], Number(m[1]), applies, input.includes('/rechecks/'));
}

async function start(zen: Zen, ...flags: string[]): Promise<void> {
    await quiet(() =>
        runFinetune(
            { args: ['start', ...flags], json: true, cwd: root },
            { dir: root, name: 'acme' },
            { zen, tickMs: 5 },
        ),
    );
}

const result = (id: string): { state: string; reason?: string } | undefined => {
    const file = join(root, 'finetune', 'cases', id, 'r1', 'result.json');
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
};

const runsOf = (calls: string[][], id: string) =>
    calls.filter((a) => a[0] === 'run' && a[a.indexOf('--input') + 1].includes(`/cases/${id}/`));

// An analysis once graded memory "ok" on a run that saved nothing; a rubric
// left half-graded is the same failure, and the loop is where it is caught.
describe('feedback', () => {
    const known = { case: 'a1', caseRev: 2, phase: 'nomem' as const, attempt: 1 };
    const read = (body: object, ids: string[] = ['r1', 'r2']) => {
        const file = join(root, 'feedback.json');
        writeFileSync(file, JSON.stringify({ improvements: [], summary: 's', ...body }));
        return readFeedback(file, known, ids);
    };

    it('refuses a rubric line left ungraded, naming it and the command', () => {
        const r = read({ verdict: 'right', done: true, rubric: { r1: 'pass' } });
        expect(r).toEqual({ problem: expect.stringContaining('rubric lines r2') });
        expect(r).toEqual({ problem: expect.stringContaining('zen meta dataset show a1@2') });
    });

    it('is never done while a rubric line fails', () => {
        const r = read({ verdict: 'right', done: true, rubric: { r1: 'pass', r2: 'fail' } });
        expect('feedback' in r && r.feedback.done).toBe(false);
    });

    it('lets a void run go ungraded, but not unexplained', () => {
        expect(read({ verdict: 'void', done: false, rubric: {} })).toEqual({
            problem: expect.stringContaining('"infra"'),
        });
        const r = read({ verdict: 'void', done: false, rubric: {}, infra: 'n4: no DNS' });
        expect('feedback' in r && r.feedback.infra).toBe('n4: no DNS');
    });

    // A rubric that says how one implementation did it is the dataset's fault, not the run's.
    it('takes an invalid rubric line only with a specification improvement naming it', () => {
        const rubric = { r1: 'pass', r2: 'invalid' };
        expect(read({ verdict: 'right', done: true, rubric })).toEqual({
            problem: expect.stringContaining('rubric lines r2 are graded "invalid"'),
        });
        const spec = { id: 'i1', kind: 'specification', change: 'r2 names a JS helper' };
        const r = read({ verdict: 'right', done: false, rubric, improvements: [spec] });
        expect('feedback' in r && r.feedback.rubric.r2).toBe('invalid');
        // Nothing is left for the prose, so the run is done whatever the file said.
        expect('feedback' in r && r.feedback.done).toBe(true);
        const prose = { id: 'i2', kind: 'prompt', change: 'say it' };
        const more = read({ verdict: 'right', done: false, rubric, improvements: [spec, prose] });
        expect('feedback' in more && more.feedback.done).toBe(false);
    });
});

describe('zen meta finetune', () => {
    it('measures a run from its trajectory, branches as their own lanes', () => {
        const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
        const call = (id: string, model: string, s: number, input: number) => ({
            id,
            ts: at(s),
            type: 'llm_call',
            model,
            usage: { inputTokens: input, cachedInputTokens: 100, outputTokens: 10 },
        });
        writeFileSync(
            join(root, 'state.json'),
            JSON.stringify({
                trajectory: [
                    { id: 'u', ts: at(0), type: 'user_input' },
                    call('c1', 'vertex/gemini-a', 2, 300),
                    { id: 'r1', ts: at(5), type: 'tool_result', isError: true, durationMs: 2500 },
                    call('c2', 'gemini-a', 7, 500),
                    { id: 'm1', ts: at(7), type: 'memory_op', op: 'commit' },
                    { id: 'f1', ts: at(7), type: 'fork', branches: [{}, {}] },
                    {
                        id: 'j1',
                        ts: at(12),
                        type: 'join',
                        branches: [
                            {
                                nodes: [
                                    call('c4', 'gemini-b', 10, 200),
                                    call('c1', 'gemini-a', 2, 300),
                                ],
                            },
                            { nodes: [call('c5', 'gemini-b', 11, 100)] },
                        ],
                    },
                    {
                        id: 'k1',
                        ts: at(13),
                        type: 'compaction',
                        usage: { inputTokens: 50, outputTokens: 5 },
                    },
                    { id: 'h1', ts: at(13), type: 'handoff' },
                ],
            }),
        );
        const m = runMetrics(root)!;
        expect(m.models['gemini-a']).toEqual({
            calls: 2,
            input: 800,
            cached: 200,
            output: 20,
            reasoning: 0,
            peak: 500,
            ms: 4000,
        });
        expect(m.models['gemini-b']).toMatchObject({ calls: 2, peak: 200, ms: 7000 });
        expect(m.models.summarizer).toMatchObject({ calls: 1, input: 50, ms: 1000 });
        expect(m).toMatchObject({
            llmMs: 12000,
            toolMs: 2500,
            toolCalls: 1,
            toolErrors: 1,
            memory: { commit: 1, recall: 0 },
            forks: 1,
            branches: 2,
            compactions: 1,
            handoffs: 1,
        });
    });

    it('completes cases that pass first time, without memory and then with it', async () => {
        await dataset(['a1', 'b1']);
        const fake = fakeZen(() => ({ done: true }));
        await start(fake.zen, '-N', '2');
        expect(result('a1')).toMatchObject({ state: 'completed' });
        expect(result('b1')).toMatchObject({ state: 'completed' });
        expect(
            runsOf(fake.calls, 'a1').map((a) => a[a.indexOf('--input') + 1].match(/\d{2}-\w+/)![0]),
        ).toEqual(['01-nomem', '01-mem']);
        expect(fake.applies).toBe(0);
        const run = runsOf(fake.calls, 'a1')[0];
        expect(run[run.indexOf('--events') + 1]).toMatch(
            /\/cases\/a1\/r1\/01-nomem\/events\.jsonl$/,
        );
        const analyze = fake.calls.find((a) => a.includes('/analyze'))!;
        expect(analyze[analyze.indexOf('--events') + 1]).toMatch(
            /\/cases\/\w+\/r1\/01-nomem\/analyze\.events\.jsonl$/,
        );
    });

    it('takes at most --more cases per start, failed ones included, and does not keep it', async () => {
        await dataset(['a1', 'b1', 'c1']);
        let outage = true;
        const fake = fakeZen(() => ({ done: true, broken: outage }));
        const ids = ['a1', 'b1', 'c1'];
        const done = () => ids.filter((id) => result(id)?.state === 'completed').length;
        await start(fake.zen, '-N', '2', '--more', '1');
        expect(ids.map((id) => result(id)?.state).sort()).toEqual(['failed', undefined, undefined]);
        outage = false;
        // The failed case takes the one place; nothing new begins.
        await start(fake.zen, '-N', '2', '--more', '1');
        expect(done()).toBe(1);
        expect(ids.filter((id) => result(id))).toHaveLength(1);
        await start(fake.zen, '-N', '2', '--more', '1');
        expect(done()).toBe(2);
        expect(readFileSync(join(root, 'finetune', 'loop.json'), 'utf8')).not.toContain('more');
        await start(fake.zen, '-N', '2');
        expect(done()).toBe(3);
    });

    it('keeps --limit for one start only, and ignores one an older version saved', async () => {
        await dataset(['a1', 'b1', 'c1']);
        const fake = fakeZen(() => ({ done: true }));
        const done = () => ['a1', 'b1', 'c1'].filter((id) => result(id)).length;
        await start(fake.zen, '-N', '2', '--limit', '1');
        expect(done()).toBe(1);
        const loop = join(root, 'finetune', 'loop.json');
        expect(readFileSync(loop, 'utf8')).not.toContain('limit');
        writeFileSync(
            loop,
            JSON.stringify({ ...JSON.parse(readFileSync(loop, 'utf8')), limit: 1 }),
        );
        await start(fake.zen, '-N', '2');
        expect(done()).toBe(3);
    });

    it('moves a tuning kept in .finetune/ to finetune/ and resumes it', async () => {
        await dataset(['a1', 'b1']);
        const fake = fakeZen(() => ({ done: true }));
        await start(fake.zen, '-N', '2');
        rmSync(join(root, 'finetune', 'loop.lock'), { force: true });
        renameSync(join(root, 'finetune'), join(root, '.finetune'));
        await start(fake.zen, '-N', '2');
        expect(existsSync(join(root, '.finetune'))).toBe(false);
        expect(result('a1')).toMatchObject({ state: 'completed' });
        expect(runsOf(fake.calls, 'a1')).toHaveLength(2);
    });

    it('parks a case, applies its feedback, and runs it again on the new system', async () => {
        await dataset(['a1', 'b1']);
        const fake = fakeZen((c, phase, attempt, applies) => ({ done: c !== 'a1' || applies > 0 }));
        await start(fake.zen, '-N', '2', '-M', '2');
        expect(fake.applies).toBe(1);
        expect(result('a1')).toMatchObject({ state: 'completed' });
        const second = JSON.parse(
            readFileSync(
                join(root, 'finetune', 'cases', 'a1', 'r1', '02-nomem', 'run.json'),
                'utf8',
            ),
        );
        expect(second.system).toBe(2);
        expect(existsSync(join(root, 'finetune', 'applies', '001', 'diff.patch'))).toBe(true);
        const applyCall = fake.calls.find((a) => a.includes('/zen-finetune-apply'))!;
        const applyDir = join(root, 'finetune', 'applies', '001');
        expect(applyCall[applyCall.indexOf('--session-id') + 1]).toBe(
            readFileSync(join(applyDir, 'session'), 'utf8').trim(),
        );
        expect(applyCall[applyCall.indexOf('--events') + 1]).toBe(
            join(applyDir, 'apply.events.jsonl'),
        );
        const page = readFileSync(join(root, 'finetune', 'cases', 'a1', 'FEEDBACK.md'), 'utf8');
        expect(page).toContain('## History');
        expect(page).toContain('**Run** - fine.');
        expect(existsSync(join(root, 'finetune', 'cases', 'a1', 'FEEDBACK.html'))).toBe(false);

        const apply = readFileSync(join(root, 'finetune', 'applies', '001', 'APPLY.md'), 'utf8');
        expect(apply).toContain('# Apply 001 - v1 → v2');
        expect(apply).toMatch(/### 1\. a1 - no memory, try 1: wrong/);
        expect(apply).toMatch(
            /\| i1 \| - \| - \| say it 1 \| - \| - \| applied \| agents\/instructions\.md \|/,
        );
        expect(apply).toContain('## What the apply agent did');
        expect(apply).toContain('| `agents/instructions.md` | +1 | -0 |');
        expect(apply).toMatch(/```diff\n[\s\S]*\+- rule 1/);
        expect(apply).toMatch(/\[a1\]\(<[^>]+>\) - no memory, try 2 on v2/);
        const status = readFileSync(join(root, 'finetune', 'STATUS.md'), 'utf8');
        expect(status).toContain('[001](<applies/001/APPLY.md>)');
    });

    it('applies once M requests wait, while another case is still running', async () => {
        await dataset(['a1', 'b1', 'c1']);
        const fake = fakeZen((c, _phase, _attempt, applies) =>
            c === 'c1' ? { done: true, slow: 300 } : { done: applies > 0 },
        );
        await start(fake.zen, '-N', '3', '-M', '2');
        const inputs = JSON.parse(
            readFileSync(join(root, 'finetune', 'applies', '001', 'inputs.json'), 'utf8'),
        );
        expect(inputs.map((f: { id: string }) => f.id).sort()).toEqual([
            'a1@nomem-1',
            'b1@nomem-1',
        ]);
    });

    it('lets another case use the worker while a case is parked', async () => {
        await dataset(['a1', 'b1']);
        const fake = fakeZen((c, _p, _a, applies) => ({ done: c !== 'a1' || applies > 0 }));
        await start(fake.zen, '-N', '1', '-M', '2');
        const index = (pred: (a: string[]) => boolean) => fake.calls.findIndex(pred);
        const b1Run = index((a) => a[0] === 'run' && a.some((x) => x.includes('/cases/b1/')));
        const apply = index((a) => a.includes('/zen-finetune-apply'));
        expect(b1Run).toBeGreaterThan(-1);
        expect(b1Run).toBeLessThan(apply);
        expect(result('a1')).toMatchObject({ state: 'completed' });
        expect(result('b1')).toMatchObject({ state: 'completed' });
    });

    it('marks a case difficult when its tries run out, and skips the memory phase', async () => {
        await dataset(['a1']);
        const fake = fakeZen(() => ({ done: false }));
        await start(fake.zen, '-N', '1', '--tries', '2');
        expect(result('a1')).toMatchObject({ state: 'difficult', reason: 'wrong' });
        expect(runsOf(fake.calls, 'a1')).toHaveLength(2);
        expect(fake.applies).toBe(1);
        const log = (await quietJson(['log', 'a1'])) as { kind?: string }[];
        expect(log.some((r) => r.kind === 'difficult')).toBe(true);
    });

    it('marks a case failed when its analysis breaks, and resumes it at the next start', async () => {
        await dataset(['a1']);
        let outage = true;
        const fake = fakeZen(() => ({ done: true, broken: outage }));
        await start(fake.zen, '-N', '1');
        expect(result('a1')).toMatchObject({ state: 'failed' });
        expect(result('a1')!.reason).toMatch(
            /^error: analysis wrote no usable feedback \(missing\): Model 'claude-x' not found .*\(HTTP 404\)/,
        );
        // An agent that exited on an error is not asked again to fix its file.
        const analyses = () => fake.calls.filter((a) => a[0] === 'meta' && a.includes('--events'));
        expect(analyses()).toHaveLength(1);
        const live = JSON.parse(readFileSync(join(root, 'finetune', 'live.json'), 'utf8'));
        expect(live.errors[0]).toMatchObject({
            where: 'a1 · no memory try 1',
            message: expect.stringContaining('HTTP 404'),
            log: '/tmp/meta.20261008-x.log',
        });
        expect(live.log.some((r: { action: string }) => r.action === 'error')).toBe(false);
        const session = (a: string[]) => a[a.indexOf('--session-id') + 1];
        const before = session(analyses()[0]);

        outage = false;
        await start(fake.zen, '-N', '1');
        expect(result('a1')).toMatchObject({ state: 'completed' });
        // A failed case's analysis starts a session of its own, never the one that broke.
        expect(session(analyses()[1])).not.toBe(before);
        // The run itself had gone through: only the analysis is done again.
        const first = runsOf(fake.calls, 'a1').filter((a) =>
            a[a.indexOf('--input') + 1].includes('01-nomem'),
        );
        expect(first).toHaveLength(1);
        const events = readFileSync(join(root, 'finetune', 'events.jsonl'), 'utf8');
        expect(events).toContain('"what":"resumed"');
    });

    it('reads an old void or error "difficult" as failed, and resumes it', async () => {
        await dataset(['a1']);
        const dir = join(root, 'finetune', 'cases', 'a1', 'r1');
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, 'result.json'),
            JSON.stringify({
                state: 'difficult',
                phase: 'nomem',
                reason: 'void: 3 runs in a row were void',
            }),
        );
        await start(fakeZen(() => ({ done: true })).zen, '-N', '1');
        expect(result('a1')).toMatchObject({ state: 'completed' });
    });

    it(`stops after ${FAILURES_IN_A_ROW} cases fail in a row, and leaves the rest alone`, async () => {
        await dataset(['a1', 'b1', 'c1', 'd1']);
        const fake = fakeZen(() => ({ done: true, broken: true }));
        await expect(start(fake.zen, '-N', '1')).rejects.toThrow(/3 cases failed in a row/);
        const states = ['a1', 'b1', 'c1', 'd1'].map((id) => result(id)?.state);
        expect(states.filter((s) => s === 'failed')).toHaveLength(3);
        expect(states.filter((s) => s === undefined)).toHaveLength(1);
    });

    it('retries a difficult case as a new round, with feedback ids of its own', async () => {
        await dataset(['a1', 'b1']);
        const first = fakeZen((c) => ({ done: c === 'b1' }));
        await start(first.zen, '-N', '1', '--tries', '2');
        expect(result('a1')).toMatchObject({ state: 'difficult' });
        expect(first.applies).toBe(1);

        await expect(quietJson(['retry'], runFinetune)).rejects.toThrow(/retry which cases/);
        const out = (await quietJson(['retry', '--difficult', 'b1', '--yes'], runFinetune)) as {
            retried: string[];
            skipped: unknown[];
        };
        expect(out.retried).toEqual(['a1']);
        expect(out.skipped).toHaveLength(1);
        const cases = join(root, 'finetune', 'cases');
        expect(existsSync(join(cases, 'a1', 'rounds', 'r1.1', '01-nomem', 'run.json'))).toBe(true);
        expect(result('a1')).toBeUndefined();
        expect(result('b1')).toMatchObject({ state: 'completed' });

        // Round 2 fails its first try too: its feedback must not pass for round 1's, already applied.
        const second = fakeZen((c, _p, _a, applies) => ({ done: c === 'b1' || applies > 0 }));
        await start(second.zen, '-N', '1', '--tries', '2');
        expect(result('a1')).toMatchObject({ state: 'completed' });
        expect(second.applies).toBe(1);
        const apply = second.calls.find((a) => a.includes('/zen-finetune-apply'))!;
        const inputs = JSON.parse(readFileSync(join(apply.at(-1)!, 'inputs.json'), 'utf8'));
        expect(inputs.map((f: { id: string }) => f.id)).toEqual(['a1#2@nomem-1']);
    });

    it('stops at once when the container engine is down, and carries on once it is up', async () => {
        await dataset(['a1', 'b1', 'c1']);
        let down = true;
        const fake = fakeZen(() => ({ done: true, exit: down ? 5 : undefined }));
        await expect(start(fake.zen, '-N', '1')).rejects.toThrow(
            /sandbox failed: podman is installed but not responding/,
        );
        expect(result('a1')?.reason).toMatch(/^sandbox: /);
        expect(result('b1')).toBeUndefined();
        expect(runsOf(fake.calls, 'b1')).toHaveLength(0);

        down = false;
        await start(fake.zen, '-N', '1');
        expect(['a1', 'b1', 'c1'].map((id) => result(id)?.state)).toEqual([
            'completed',
            'completed',
            'completed',
        ]);
    });

    it('stops when a sandbox tool met a broken container engine, before any analysis', async () => {
        await dataset(['a1', 'b1']);
        const fake = fakeZen(() => ({
            done: true,
            sandbox: 'could not create container zn-1: allocating lock: exceeded num_locks (2048)',
        }));
        await expect(start(fake.zen, '-N', '1')).rejects.toThrow(/exceeded num_locks/);
        expect(result('a1')).toMatchObject({ state: 'failed' });
        expect(fake.calls.some((a) => a.includes('/analyze'))).toBe(false);
    });

    it('sets aside a run its analysis finds void, and runs the try again', async () => {
        await dataset(['a1']);
        const analyses = () => fake.calls.filter((a) => a.includes('/analyze')).length;
        const fake = fakeZen(() =>
            analyses() === 1
                ? { done: false, infra: 'n4: run_command - Could not resolve host' }
                : { done: true },
        );
        await start(fake.zen, '-N', '1', '--tries', '1');
        expect(result('a1')).toMatchObject({ state: 'completed' });
        expect(fake.applies).toBe(0);
        const tries = join(root, 'finetune', 'cases', 'a1', 'r1');
        expect(existsSync(join(tries, '01-nomem.void-1', 'run.json'))).toBe(true);
        expect(existsSync(join(tries, '01-nomem', 'feedback.json'))).toBe(true);
        const events = readFileSync(join(root, 'finetune', 'events.jsonl'), 'utf8');
        expect(events).toContain('Could not resolve host');
    });

    it('fails a case whose runs keep coming back void', async () => {
        await dataset(['a1']);
        const fake = fakeZen(() => ({ done: false, infra: 'n4: the mock API answered 503' }));
        await start(fake.zen, '-N', '1');
        expect(result('a1')).toMatchObject({ state: 'failed' });
        expect(result('a1')!.reason).toMatch(/^void: 3 analyses in a row found the run void/);
        expect(fake.applies).toBe(0);
    });

    it('keeps a live snapshot: the steps that ended, with what they came to, took and spent', async () => {
        await dataset(['a1']);
        await start(fakeZen(() => ({ done: true })).zen, '-N', '1');
        const live = JSON.parse(readFileSync(join(root, 'finetune', 'live.json'), 'utf8'));
        expect(live).toMatchObject({ state: 'finished', total: 1, now: [] });
        expect(live.counts.completed).toBe(1);
        const ran = live.log.findLast((r: { action: string }) => r.action === 'ran');
        expect(ran).toMatchObject({ case: 'a1 · no memory try 1', result: '5 turns' });
        expect(ran.tokens).toBeGreaterThan(0);
        expect(typeof ran.took).toBe('number');
        expect(live.log.find((r: { action: string }) => r.action === 'analyzed')).toMatchObject({
            result: 'right 1/1, done',
        });
        expect(live.log.some((r: { action: string }) => r.action === 'run')).toBe(false);
        expect(live.tokens).toContainEqual(
            expect.objectContaining({ stage: 'run', model: 'gemini-a' }),
        );
        expect(live.tokens).toContainEqual(
            expect.objectContaining({ stage: 'analyze', model: 'gemini-meta' }),
        );
    });

    it('keeps the session the meta agent started in the try folder, after a model change', async () => {
        await dataset(['a1']);
        const fresh = '11111111-2222-3333-4444-555555555555';
        const fake = fakeZen((_c, _p, attempt, applies) =>
            attempt === 1 && applies === 0 ? { done: false, newSession: fresh } : { done: true },
        );
        await start(fake.zen, '-N', '1');
        const file = join(root, 'finetune', 'cases', 'a1', 'r1', '01-nomem', 'session');
        expect(readFileSync(file, 'utf8').trim()).toBe(fresh);
    });

    it('analyzes every try in a session of its own, from a brief in the prompt', async () => {
        await dataset(['a1']);
        const fake = fakeZen((_c, _p, _a, applies) => ({ done: applies > 0 }));
        await start(fake.zen, '-N', '1');
        const analyses = fake.calls.filter((a) => a.includes('/analyze'));
        expect(analyses.length).toBeGreaterThan(1);
        const ids = analyses.map((a) => a[a.indexOf('--session-id') + 1]);
        expect(new Set(ids).size).toBe(analyses.length);
        const second = analyses[1];
        const brief = second[second.indexOf('--prompt-file') + 1];
        expect(brief).toBe(join(root, 'finetune', 'cases', 'a1', 'r1', '02-nomem', 'brief.md'));
        const text = readFileSync(brief, 'utf8');
        expect(text).toContain('## The brief');
        const tryDir = dirname(brief);
        expect(existsSync(join(tryDir, 'ask'))).toBe(true);
        expect(text).toContain(`\`${join(tryDir, 'ask')}/<node>-<topic>.md\``);
        expect(text).toContain(`\`${join(tryDir, 'feedback.json')}\`, not written yet`);
        expect(text).toContain('> zen inspect graph --dir');
        expect(text).toContain('> cat agents.yaml');
        expect(text).toContain('#### no memory, try 1 - wrong, rubric 0/1');
        expect(text).toContain('What changed in agents.yaml and agents/ since the last try');
        expect(fake.calls).toContainEqual(['meta', 'dataset', 'show', 'a1@1', '--json']);
        const out: string[] = [];
        const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
            out.push(String(chunk));
            return true;
        });
        try {
            await runFinetune(
                { args: ['session', 'a1'], json: false, cwd: root },
                { dir: root, name: 'acme' },
            );
        } finally {
            write.mockRestore();
        }
        expect(out.join('')).toContain(`zen meta resume acme ${ids.at(-1)}`);
    });

    it('carries on where it stopped, repeating nothing that finished', async () => {
        await dataset(['a1', 'b1']);
        let stopped = false;
        const fake = fakeZen((c, _p, _a, applies) => {
            if (!stopped && c === 'a1') {
                stopped = true;
                writeFileSync(join(root, 'finetune', 'stop'), 'now\n');
            }
            return { done: applies > 0 || c === 'b1' };
        });
        await start(fake.zen, '-N', '1');
        const first = fake.calls.length;
        expect(result('a1')).toBeUndefined();

        await start(fake.zen, '-N', '1');
        expect(result('a1')).toMatchObject({ state: 'completed' });
        expect(result('b1')).toMatchObject({ state: 'completed' });
        const a1First = runsOf(fake.calls, 'a1').filter((a) =>
            a[a.indexOf('--input') + 1].includes('01-nomem'),
        );
        expect(a1First).toHaveLength(1);
        expect(fake.calls.length).toBeGreaterThan(first);
    });

    it('rolls back the steps a kill cut off, and does them again', async () => {
        await dataset(['a1']);
        const ft = join(root, 'finetune');
        const journal = new Journal(join(ft, 'journal.jsonl'));
        // A run that wrote run.json but was killed before it committed.
        const attempt = join(ft, 'cases', 'a1', 'r1', '01-nomem');
        mkdirSync(join(attempt, 'memory'), { recursive: true });
        writeFileSync(join(attempt, 'run.json'), '{"dir":"/nowhere"}');
        writeFileSync(join(attempt, 'events.jsonl'), '{"type":"say","text":"half"}\n');
        journal.begin({ kind: 'run', dir: attempt });
        // An apply killed halfway through its edit.
        new SystemVersions(root, join(ft, 'systems')).record('start');
        const apply = join(ft, 'applies', '001');
        mkdirSync(apply, { recursive: true });
        writeFileSync(join(apply, 'inputs.json'), '[]');
        journal.begin({ kind: 'apply', dir: apply, from: 1 });
        appendFileSync(join(root, 'agents', 'instructions.md'), '- half an edit\n');

        const fake = fakeZen((_c, _p, _a, applies) => ({ done: applies > 0 }));
        await start(fake.zen, '-N', '1');

        expect(result('a1')).toMatchObject({ state: 'completed' });
        expect(
            runsOf(fake.calls, 'a1').filter((a) =>
                a[a.indexOf('--input') + 1].includes('01-nomem'),
            ),
        ).toHaveLength(1);
        expect(readFileSync(join(root, 'agents', 'instructions.md'), 'utf8')).toBe(
            '# Rules\n- rule 1\n',
        );
        const inputs = JSON.parse(readFileSync(join(apply, 'inputs.json'), 'utf8'));
        expect(inputs.map((f: { id: string }) => f.id)).toEqual(['a1@nomem-1']);
        const events = readFileSync(join(ft, 'events.jsonl'), 'utf8');
        expect(events.match(/"what":"rolled back"/g)).toHaveLength(2);
        expect(existsSync(join(attempt, 'events.jsonl'))).toBe(false);
        expect(journal.open()).toEqual([]);
    });

    it('stops what a dead loop left running before it rolls anything back', async () => {
        await dataset(['a1']);
        const ft = join(root, 'finetune');
        const exited = (p: ChildProcess) =>
            new Promise((r) => p.once('exit', (_code, signal) => r(signal)));
        const orphan = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
        const gone = exited(orphan);
        remember(ft, orphan.pid!, 'sleep');
        // Its pid was taken by something else since: never ours to kill.
        const stranger = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
        remember(ft, stranger.pid!, 'not-its-command');
        try {
            await start(fakeZen(() => ({ done: true })).zen, '-N', '1');
            await expect(gone).resolves.toBe('SIGTERM');
            expect(stranger.exitCode).toBeNull();
            expect(stranger.signalCode).toBeNull();
            expect(existsSync(join(ft, 'children'))).toBe(false);
            const log = readFileSync(join(ft, 'events.jsonl'), 'utf8');
            expect(log).toContain('"what":"stopped leftovers"');
        } finally {
            stranger.kill();
        }
    });

    it('undoes an analysis that edited the project', async () => {
        await dataset(['a1']);
        const fake = fakeZen(() => ({ done: true }));
        fake.editDuringAnalyze();
        await start(fake.zen, '-N', '1');
        expect(readFileSync(join(root, 'agents', 'instructions.md'), 'utf8')).toBe('# Rules\n');
    });

    it('keeps an apply in progress when an analysis ends during it', async () => {
        await dataset(['a1', 'b1']);
        const fake = fakeZen((c, _p, _a, applies) =>
            c === 'b1' ? { done: true, slowAnalyze: 150 } : { done: applies > 0 },
        );
        fake.slowApply(400);
        await start(fake.zen, '-N', '2', '-M', '1', '--force');
        expect(readFileSync(join(root, 'agents', 'instructions.md'), 'utf8')).toContain('- rule 1');
        const events = readFileSync(join(root, 'finetune', 'events.jsonl'), 'utf8');
        expect(events).not.toContain('analyze edited the system');
    });

    it('restores the system when an apply breaks the project, and stops after a second time', async () => {
        await dataset(['a1']);
        const fake = fakeZen(() => ({ done: false }));
        fake.failChecks(2);
        await expect(start(fake.zen, '-N', '1')).rejects.toThrow(/broken twice/);
        expect(readFileSync(join(root, 'agents', 'instructions.md'), 'utf8')).toBe('# Rules\n');
    });

    it('undoes an apply that ended without deciding every improvement, and tries once more', async () => {
        await dataset(['a1']);
        const fake = fakeZen((_c, _p, _a, applies) => ({ done: applies > 1 }));
        fake.forgetDecisions(1);
        await start(fake.zen, '-N', '1');
        const dir = join(root, 'finetune', 'applies', '001');
        expect(readFileSync(join(dir, 'missing.md'), 'utf8')).toContain('- a1@nomem-1 i1');
        expect(readFileSync(join(dir, 'brief.md'), 'utf8')).toContain(
            '> cat finetune/applies/001/missing.md',
        );
        expect(readFileSync(join(root, 'agents', 'instructions.md'), 'utf8')).toBe(
            '# Rules\n- rule 2\n',
        );
        expect(JSON.parse(readFileSync(join(dir, 'applied.json'), 'utf8')).ids).toEqual([
            'a1@nomem-1',
        ]);
    });

    it('stops when an apply ends twice without its decisions, leaving its requests unapplied', async () => {
        await dataset(['a1']);
        const fake = fakeZen(() => ({ done: false }));
        fake.forgetDecisions(2);
        await expect(start(fake.zen, '-N', '1')).rejects.toThrow(/without deciding/);
        expect(readFileSync(join(root, 'agents', 'instructions.md'), 'utf8')).toBe('# Rules\n');
        expect(existsSync(join(root, 'finetune', 'applies', '001', 'applied.json'))).toBe(false);
    });

    it('hands the apply a brief: requests by file, skills to load, earlier tries', async () => {
        await dataset(['a1']);
        const fake = fakeZen((_c, _p, _a, applies) => ({ done: applies > 1 }));
        await start(fake.zen, '-N', '1');
        const second = fake.calls.filter((a) => a.includes('/zen-finetune-apply'))[1]!;
        const dir = join(root, 'finetune', 'applies', '002');
        expect(second.at(-1)).toBe(dir);
        expect(second.slice(-4)).toEqual([
            '--prompt-file',
            join(dir, 'brief.md'),
            '/zen-finetune-apply',
            dir,
        ]);
        const brief = readFileSync(join(dir, 'brief.md'), 'utf8');
        expect(brief).toContain('## The brief');
        expect(brief).toContain('This is apply 002, attempt 1.');
        expect(brief).toContain('  - `a1@nomem-2`: i1');
        expect(brief).toContain(`\`zen meta finetune gate ${dir}\``);
        expect(brief).toContain('### Skills to load\n\n- `zen-instructions` - every apply');
        expect(brief).toMatch(/### Requests by file\n\n#### \(no file named\) - 1 case\(s\): a1/);
        expect(brief).toContain('| a1@nomem-2 | i1 | - | say it 1 | - | - | this batch |');
        expect(brief).toContain(
            '- `a1@nomem-1` i1, apply 001, (no file named): say it 1 → applied: agents/instructions.md',
        );
        expect(brief).toContain('> cat finetune/applies/002/budget.json');
        expect(brief).toContain('> cat agents/instructions.md');
        expect(brief).not.toContain('missing.md');
    });

    it('keeps every passing memory privately and merges them every K', async () => {
        await dataset(['a1', 'b1', 'c1']);
        const fake = fakeZen(() => ({ done: true }));
        await start(fake.zen, '-N', '1', '--merge-every', '2');

        const memories = fake.calls
            .filter((a) => a[0] === 'run')
            .map((a) => a[a.indexOf('--memory') + 1]);
        expect(new Set(memories).size).toBe(memories.length);
        for (const m of memories) {
            expect(m).toMatch(/\/cases\/\w+\/r1\/\d{2}-(nomem|mem)\/memory$/);
        }
        const workspaces = fake.calls
            .filter((a) => a[0] === 'run')
            .map((a) => a[a.indexOf('--workspace') + 1]);
        expect(new Set(workspaces).size).toBe(workspaces.length);
        for (const w of workspaces) {
            expect(w).toMatch(/\/cases\/\w+\/r1\/\d{2}-(nomem|mem)\/workspace$/);
        }

        const dir = join(root, 'finetune', 'memories');
        const kept = readFileSync(join(dir, 'submissions.jsonl'), 'utf8').trim().split('\n');
        expect(kept).toHaveLength(3);
        const merges = readFileSync(join(dir, 'merges.jsonl'), 'utf8')
            .trim()
            .split('\n')
            .map((l) => JSON.parse(l));
        expect(merges.map((m) => [m.name, m.includes.length, m.added.length])).toEqual([
            ['m01', 2, 2],
            ['m02', 3, 1],
        ]);
        const second = fake.calls.filter((a) => a[0] === 'memory').at(-1)!;
        expect(second).toContain(merges[0].dir);

        const status = readFileSync(join(root, 'finetune', 'STATUS.md'), 'utf8');
        expect(status).toContain('## Memory');
        expect(status).toMatch(/\| m02 \| [\d:]+ \| 3: /);
        const page = readFileSync(join(root, 'finetune', 'cases', 'a1', 'FEEDBACK.md'), 'utf8');
        expect(page).toMatch(/In merges: \[m0\d\]/);
    });

    it('writes a status page whose diagrams carry no free text', async () => {
        await dataset(['a1', 'b1']);
        const fake = fakeZen((c, _p, _a, applies) => ({ done: c !== 'a1' || applies > 0 }));
        await start(fake.zen, '-N', '2', '-M', '2');
        const status = readFileSync(join(root, 'finetune', 'STATUS.md'), 'utf8');
        expect(status).toContain('## Workers');
        expect(status).toContain('## Applies');
        const diagrams = status.match(/```mermaid[\s\S]*?```/g) ?? [];
        // Where the cases are, and the system.
        expect(diagrams).toHaveLength(2);
        expect(diagrams.join('\n')).not.toContain('misses it');
        expect(status).not.toMatch(/misses it \| badly/);
        expect(readdirSync(join(root, 'finetune', 'cases'))).toEqual(['a1', 'b1']);

        // The browser view is served live by `start`; no HTML copy is written, and no
        // server is started for a fake zen.
        expect(existsSync(join(root, 'finetune', 'STATUS.html'))).toBe(false);
        expect(existsSync(join(root, 'finetune', 'view.json'))).toBe(false);
    });

    it('reports tokens per stage and model, for the tuning and for each case', async () => {
        await dataset(['a1', 'b1']);
        const fake = fakeZen((c, _p, _a, applies) => ({ done: c !== 'a1' || applies > 0 }));
        await start(fake.zen, '-N', '2', '-M', '2');
        const status = readFileSync(join(root, 'finetune', 'STATUS.md'), 'utf8');
        expect(status).toContain('## Tokens');
        expect(status).toMatch(/\| run \| gemini-a \| \d+ \|/);
        expect(status).toMatch(/\| run \| gemini-b \| \d+ \|/);
        expect(status).toMatch(/\| analyze \| gemini-meta \| \d+ \|/);
        expect(status).toMatch(/\| apply \| gemini-meta \| \d+ \|/);

        // b1 passes at once: one run and one analysis per phase.
        const result = JSON.parse(
            readFileSync(join(root, 'finetune', 'cases', 'b1', 'r1', 'result.json'), 'utf8'),
        ) as { tokens: Record<string, Record<string, { calls: number; input: number }>> };
        expect(result.tokens.run['gemini-a']).toMatchObject({ calls: 3, input: 900 });
        expect(result.tokens.run['gemini-b']).toMatchObject({ calls: 2, input: 600 });
        expect(result.tokens.analyze['gemini-meta']).toMatchObject({ calls: 4, input: 1000 });
        expect(result.tokens.apply).toBeUndefined();

        const feedback = readFileSync(join(root, 'finetune', 'cases', 'b1', 'FEEDBACK.md'), 'utf8');
        expect(feedback).toContain('## Tokens');
        expect(feedback).toMatch(/\| run \| gemini-a \| 3 \| 900 \|/);
    });

    it('reports each try against the one it is compared with, and sums the trend', async () => {
        await dataset(['a1', 'b1']);
        const fake = fakeZen((c, _p, _a, applies) => ({ done: c !== 'a1' || applies > 0 }));
        await start(fake.zen, '-N', '2', '-M', '2');

        const b1 = readFileSync(join(root, 'finetune', 'cases', 'b1', 'FEEDBACK.md'), 'utf8');
        expect(b1).toContain('| Metric | no memory, try 1 | with memory, try 1 | Memory effect |');
        expect(b1).toContain('| LLM calls | 3 | 2 (-1) | -33% better |');
        expect(b1).toContain('| Tool errors | 1 | 0 (-1) | -100% better |');
        expect(b1).toContain('| Memory recalls | 0 | 1 (+1) | new |');
        expect(b1).toContain('### gemini-a');
        expect(b1).toMatch(/\| Tool calls \| 1 \|/);

        // a1 needed a fix: its second try is measured against its first.
        const a1 = readFileSync(join(root, 'finetune', 'cases', 'a1', 'FEEDBACK.md'), 'utf8');
        expect(a1).toContain('| LLM calls | 3 | 3 (=) | 2 (-1) | -33% better |');

        const status = readFileSync(join(root, 'finetune', 'STATUS.md'), 'utf8');
        expect(status).toContain('## Summary');
        expect(status).toMatch(/\| no memory \| 3 \| 4s \| 9 \| 3 \|/);
        expect(status).toContain('2 case(s) passed without memory, 1 on the first try.');
        expect(status).toContain('2 completed case(s), cheaper in tokens with memory in 2.');
        expect(status).toContain('| LLM calls | 6 | 4 | -33% | better |');
        expect(status).toContain('| Tool errors | 2 | 0 | -100% | better |');
        expect(status).toMatch(/\| -33% tokens · -50% time \|/);
    });
});

describe('what an apply may cost', () => {
    const appliesDir = () => join(root, 'finetune', 'applies');
    const appliedOf = (n: string) =>
        JSON.parse(readFileSync(join(appliesDir(), n, 'applied.json'), 'utf8'));
    const rules = () => readFileSync(join(root, 'agents', 'instructions.md'), 'utf8');

    it('counts preloaded skills and index lines on every call, skill bodies apart', async () => {
        writeFileSync(
            join(root, 'agents.yaml'),
            'agents:\n  - name: default\n  - name: writer\n    skills:\n      discovery: index\n      preload: [style]\n',
        );
        mkdirSync(join(root, 'agents', 'prompts'), { recursive: true });
        writeFileSync(join(root, 'agents', 'prompts', 'default.md'), 'p'.repeat(100));
        const skill = (name: string, body: string) => {
            mkdirSync(join(root, 'agents', 'skills', name), { recursive: true });
            writeFileSync(
                join(root, 'agents', 'skills', name, 'SKILL.md'),
                `---\nname: ${name}\ndescription: when ${name}\n---\n${body}\n`,
            );
            return statSync(join(root, 'agents', 'skills', name, 'SKILL.md')).size;
        };
        const style = skill('style', 's'.repeat(50));
        const planning = skill('planning', 'q'.repeat(40));
        const index = Buffer.byteLength('- planning: when planning\n- style: when style\n');
        const before = await measure(root);
        expect(before.alwaysRead).toEqual({
            default: 8 + 100 + index,
            writer: 8 + style + index,
        });
        expect(before.skills).toEqual({ planning, style });
        expect(before.visible).toEqual({ default: 2, writer: 2 });

        // A procedure moved out of the prompt into a skill no one preloads: every call reads less.
        writeFileSync(join(root, 'agents', 'prompts', 'default.md'), 'p'.repeat(10));
        skill('planning', 'q'.repeat(130));
        const after = await measure(root);
        expect(after.total).toBe(before.total - 90);
        const l = { budget: 0, ceiling: before.total, skillCap: 1000, maxSkills: 10 };
        expect(overLimits(before, after, l)).toEqual([]);
        expect(overLimits(after, before, l)[0]).toMatch(/over the budget of 0/);
        expect(overLimits(before, after, { ...l, skillCap: 100 })[0]).toMatch(
            /skill planning holds \d+ bytes, over the cap of 100/,
        );
    });

    it('reads a guard setting kept by an older version as --recheck, and drops consolidations', async () => {
        const loop = join(root, 'finetune', 'loop.json');
        mkdirSync(dirname(loop), { recursive: true });
        writeFileSync(loop, JSON.stringify({ guard: 0, consolidateEvery: 5 }));
        const config = readConfig(root);
        expect(config.recheck).toBe(0);
        expect(config).not.toHaveProperty('guard');
        expect(config).not.toHaveProperty('consolidateEvery');
    });

    it('no longer takes -M from -N, and refuses -M 1 without --force', async () => {
        await dataset(['a1']);
        const fake = fakeZen(() => ({ done: true }));
        await expect(start(fake.zen, '-M', '1')).rejects.toThrow(/-M 1/);
        const loop = join(root, 'finetune', 'loop.json');
        mkdirSync(dirname(loop), { recursive: true });
        writeFileSync(loop, JSON.stringify({ applyAt: 1 }));
        await start(fake.zen, '-N', '1');
        expect(JSON.parse(readFileSync(loop, 'utf8'))).toMatchObject({ workers: 1, applyAt: 2 });
    });

    it('undoes an apply that grows the prose past its budget, and carries on', async () => {
        await dataset(['a1']);
        const fake = fakeZen(() => ({ done: false }));
        fake.applyWrites((n) => `${'x'.repeat(2000)} ${n}\n`);
        await start(fake.zen, '-N', '1', '--tries', '2');
        expect(fake.applies).toBe(2);
        expect(rules()).toBe('# Rules\n');
        expect(appliedOf('001')).toMatchObject({
            from: 1,
            to: 1,
            discarded: expect.stringContaining('over the budget of 1500'),
        });
        expect(result('a1')).toMatchObject({ state: 'difficult', reason: 'wrong' });
        const page = readFileSync(join(appliesDir(), '001', 'APPLY.md'), 'utf8');
        expect(page).toContain('undone - over the limits');
        expect(page).toContain('## The prose');
    });

    it('hands an apply the numbers its gate will use, and shows what moved once it passes', async () => {
        await dataset(['a1']);
        const fake = fakeZen((_c, _p, _a, applies) => ({ done: applies > 0 }));
        await start(fake.zen, '-N', '1', '-M', '2');
        const gate = JSON.parse(readFileSync(join(appliesDir(), '001', 'gate.json'), 'utf8'));
        expect(gate.before.total).toBe(Buffer.byteLength('# Rules\n'));
        expect(gate.limits).toMatchObject({ budget: 1500 });
        expect(readFileSync(join(appliesDir(), '001', 'cost.md'), 'utf8')).toContain(
            '| file | agents/instructions.md |',
        );
        expect(readFileSync(join(appliesDir(), '001', 'APPLY.md'), 'utf8')).toContain(
            '### What moved',
        );
    });

    it('gate judges an apply in progress as the loop will, and refuses one that is done', async () => {
        const dir = join(appliesDir(), '001');
        mkdirSync(dir, { recursive: true });
        const limits = { budget: 100, ceiling: 1_000_000, skillCap: 1000, maxSkills: 10 };
        writeFileSync(
            join(dir, 'gate.json'),
            JSON.stringify({ before: await measure(root), limits }),
        );
        const ok: Zen = async () => ({ code: 0, stdout: '' });
        const gate = (zen: Zen) =>
            quiet(() =>
                runFinetune(
                    { args: ['gate', dir], json: true, cwd: root },
                    { dir: root, name: 'acme' },
                    { zen },
                ),
            );
        const instructions = join(root, 'agents', 'instructions.md');

        appendFileSync(instructions, 'x'.repeat(50));
        await expect(gate(ok)).resolves.toBeUndefined();
        appendFileSync(instructions, 'x'.repeat(100));
        await expect(gate(ok)).rejects.toThrow(/over the limits/);

        writeFileSync(instructions, '# Rules\n');
        await expect(gate(async () => ({ code: 3, stdout: '' }))).rejects.toThrow(
            /zen check failed/,
        );

        writeFileSync(join(dir, 'applied.json'), '{}');
        await expect(gate(ok)).rejects.toThrow(/not an apply in progress/);
    });

    it('sends a case that regressed on a recheck to the next apply, and rechecks it first after', async () => {
        await dataset(['a1', 'b1']);
        const fake = fakeZen((c, _p, _a, applies, recheck) =>
            recheck ? { done: applies !== 1 } : { done: c === 'b1' || applies > 0 },
        );
        await start(fake.zen, '-N', '2', '-M', '2');
        // Nothing is undone: the edit stands and the regression is repaired by the next apply.
        expect(appliedOf('001').discarded).toBeUndefined();
        expect(rules()).toContain('- rule 1');
        const rechecks = JSON.parse(
            readFileSync(join(root, 'finetune', 'rechecks.json'), 'utf8'),
        ) as { case: string; apply: string; state: string; request?: string; tries?: string[] }[];
        expect(rechecks).toContainEqual(
            expect.objectContaining({
                case: 'b1',
                apply: '001',
                state: 'regressed',
                request: 'b1@recheck-001',
                tries: ['wrong', 'wrong'],
            }),
        );
        const inputs = JSON.parse(readFileSync(join(appliesDir(), '002', 'inputs.json'), 'utf8'));
        expect(inputs).toContainEqual(
            expect.objectContaining({
                id: 'b1@recheck-001',
                recheck: '001',
                file: join(root, 'finetune', 'rechecks', '001', 'b1', '02-nomem', 'feedback.json'),
            }),
        );
        const after = rechecks.filter((r) => r.apply === '002');
        expect(after[0]).toMatchObject({ case: 'b1', state: 'passed' });
        const analyze = fake.calls.find((a) => a.some((x) => x.startsWith('recheck=')))!;
        expect(analyze.find((x) => x.startsWith('recheck='))).toMatch(/applies\/001\/diff\.patch$/);
        // A recheck is not one of the case's own tries.
        expect(runsOf(fake.calls, 'b1')).toHaveLength(2);
        expect(result('b1')).toMatchObject({ state: 'completed' });
        expect(readFileSync(join(appliesDir(), '002', 'APPLY.md'), 'utf8')).toContain(
            'regressed after 001; rechecked first on v3',
        );
    });

    it('ends when a case keeps regressing: past two requests it is only reported', async () => {
        await dataset(['a1', 'b1']);
        const fake = fakeZen((c, _p, _a, applies, recheck) =>
            recheck ? { done: false } : { done: c === 'b1' || applies > 0 },
        );
        await start(fake.zen, '-N', '2', '-M', '2');
        const rechecks = JSON.parse(
            readFileSync(join(root, 'finetune', 'rechecks.json'), 'utf8'),
        ) as { case: string; state: string; request?: string; note?: string }[];
        for (const id of ['a1', 'b1']) {
            const mine = rechecks.filter((r) => r.case === id);
            expect(mine.every((r) => r.state === 'regressed')).toBe(true);
            expect(mine.filter((r) => r.request)).toHaveLength(2);
            expect(mine.at(-1)?.note).toMatch(/reported, not queued/);
        }
    });

    it('counts a recheck that fails once and passes the second time as passed', async () => {
        await dataset(['a1', 'b1']);
        const fake = fakeZen((c, _p, attempt, applies, recheck) =>
            recheck ? { done: attempt > 1 } : { done: c === 'b1' || applies > 0 },
        );
        await start(fake.zen, '-N', '2', '-M', '2');
        expect(fake.applies).toBe(1);
        const rechecks = JSON.parse(readFileSync(join(root, 'finetune', 'rechecks.json'), 'utf8'));
        expect(rechecks).toEqual([
            expect.objectContaining({
                case: 'b1',
                apply: '001',
                state: 'passed',
                tries: ['wrong', 'right'],
            }),
        ]);
        const page = readFileSync(join(appliesDir(), '001', 'APPLY.md'), 'utf8');
        expect(page).toContain('## Rechecks');
        expect(page).toMatch(
            /\| \[b1\]\([^)]+\) \| passed \| \[wrong\]\([^)]+\), \[right\]\([^)]+\) \|/,
        );
    });

    it('says what each worker is doing now, escaped in the table and safe in the diagram', async () => {
        await dataset(['a1']);
        let page = '';
        const said =
            'Look at "x"]) --> EVIL and `code` | pipe **bold** <b> and then a long tail that runs on past every limit there is';
        const fake = fakeZen((_c, _p, attempt, applies) => {
            if (attempt === 1 && applies === 0 && !page) {
                const run = fake.calls.at(-1)!;
                const at = new Date().toISOString();
                const llm = {
                    t: at,
                    type: 'llm',
                    model: 'vertex/gemini-live',
                    in: 123,
                    cached: 0,
                    out: 4,
                    reasoning: 0,
                };
                writeFileSync(
                    run[run.indexOf('--events') + 1]!,
                    `${JSON.stringify(llm)}\n${JSON.stringify({ t: at, type: 'think', text: 'Planning' })}\n${JSON.stringify({ t: at, type: 'say', text: said })}\n`,
                );
                setTimeout(() => {
                    page = readFileSync(join(root, 'finetune', 'STATUS.md'), 'utf8');
                }, 1500);
                return { done: true, slow: 2500 };
            }
            return { done: true };
        });
        await start(fake.zen, '-N', '1', '-M', '1', '--force');
        expect(page).toContain(
            '| thinks: Planning<br>says: Look at "x"\\]) --\\> EVIL and \\`code\\` \\| pipe \\*\\*bold\\*\\* \\<b\\> and then a long tail',
        );
        expect(page).toMatch(/runs on past every limit there is<br> \|\n/);
        const diagrams = (page.match(/```mermaid[\s\S]*?```/g) ?? []).join('\n');
        expect(diagrams).toContain('says: Look at x ) -- EVIL and code pipe bold b');
        expect(diagrams).not.toContain('EVIL and `');
        expect(diagrams).not.toContain('--> EVIL');
        // The run under way is counted before it writes anything: its worker's table and Tokens.
        expect(page.match(/\| run \| gemini-live \| 1 \| 123 \|/g)).toHaveLength(2);
    }, 15_000);

    it('shows a recheck on its worker in the status page and the live view', async () => {
        await dataset(['a1', 'b1']);
        let page = '';
        let live: { now: object[] } | undefined;
        const fake = fakeZen((c, _p, _a, applies, recheck) => {
            if (recheck && !page) {
                page = readFileSync(join(root, 'finetune', 'STATUS.md'), 'utf8');
                setTimeout(() => {
                    live = JSON.parse(readFileSync(join(root, 'finetune', 'live.json'), 'utf8'));
                }, 1500);
                return { done: true, slow: 2500 };
            }
            return { done: c === 'b1' || applies > 0 };
        });
        await start(fake.zen, '-N', '2', '-M', '2');
        expect(page).toMatch(/\*\*worker \d\*\* · running \S+\nb1\nrecheck after 001 · try 1 of 2/);
        expect(page).toMatch(/S -\.->\|"`recheck 3 cases that passed\n\d queued`"\| WORKERS/);
        expect(live?.now).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ step: 'run', what: 'b1 · recheck try 1' }),
            ]),
        );
        const status = readFileSync(join(root, 'finetune', 'STATUS.md'), 'utf8');
        expect(status).toContain('## Rechecks');
    }, 15_000);

    it('offers a deferred improvement to every later apply, until one takes it', async () => {
        await dataset(['a1']);
        const fake = fakeZen((_c, _p, _a, applies) => ({ done: applies > 1 }));
        fake.decides((_r, _i, apply) =>
            apply === 1 ? { decision: 'deferred', note: 'one case' } : { decision: 'applied' },
        );
        await start(fake.zen, '-N', '1');
        const deferred = (n: string) =>
            JSON.parse(readFileSync(join(appliesDir(), n, 'deferred.json'), 'utf8'));
        expect(deferred('001')).toEqual([]);
        expect(deferred('002')).toMatchObject([
            {
                request: 'a1@nomem-1',
                case: 'a1',
                apply: '001',
                improvement: { id: 'i1', change: 'say it 1' },
            },
        ]);
        expect(result('a1')).toMatchObject({ state: 'completed' });
    });

    it('marks a case difficult when all an apply could say of it is structural', async () => {
        await dataset(['a1']);
        const fake = fakeZen(() => ({ done: false }));
        fake.decides(() => ({ decision: 'structural', note: 'needs a tool in agents.yaml' }));
        await start(fake.zen, '-N', '1');
        expect(result('a1')).toMatchObject({
            state: 'difficult',
            reason: 'structural: needs a tool in agents.yaml',
        });
        expect(runsOf(fake.calls, 'a1')).toHaveLength(1);
    });

    it('ends a case whose only finding is a broken rubric, without an apply', async () => {
        await dataset(['a1']);
        const fake = fakeZen(() => ({ done: false, spec: true }));
        await start(fake.zen, '-N', '1');
        expect(result('a1')).toMatchObject({
            state: 'difficult',
            reason: 'specification: r1 names one implementation',
        });
        expect(fake.applies).toBe(0);
        expect(runsOf(fake.calls, 'a1')).toHaveLength(1);
        const status = readFileSync(join(root, 'finetune', 'STATUS.md'), 'utf8');
        expect(status).toContain('## Rubric problems');
        expect(status).toMatch(/\| r1 \| r1 names one implementation \|/);
        const page = readFileSync(join(root, 'finetune', 'cases', 'a1', 'FEEDBACK.md'), 'utf8');
        expect(page).toContain('rubric 0/0 (1 invalid)');
        expect(page).toContain('for the dataset');
    });

    it('tells the analysis when a case never loaded the skill an apply made for it', async () => {
        await dataset(['a1', 'b1']);
        const fake = fakeZen((c, phase, attempt) => ({
            done: phase === 'mem' || attempt > 1,
            ...(c === 'b1' ? { loads: ['planning'] } : {}),
        }));
        fake.decides(() => ({
            decision: 'applied',
            disposition: 'extract to skill',
            skill: 'planning',
        }));
        await start(fake.zen, '-N', '2', '-M', '2', '--recheck', '0');
        const run = (id: string) =>
            JSON.parse(
                readFileSync(
                    join(root, 'finetune', 'cases', id, 'r1', '02-nomem', 'run.json'),
                    'utf8',
                ),
            );
        expect(run('a1').missedSkills).toEqual(['planning']);
        expect(run('b1').missedSkills).toBeUndefined();
        const analyze = (id: string) =>
            fake.calls.find(
                (a) =>
                    a.includes('/analyze') && a.includes(`case=${id}`) && a.includes('attempt=2'),
            )!;
        expect(analyze('a1')).toContain('missed-skills=planning');
        expect(analyze('b1').some((x) => x.startsWith('missed-skills='))).toBe(false);
    });

    it('hands every apply the growth of each file, and asks no separate tidy-up', async () => {
        await dataset(['a1']);
        const fake = fakeZen((_c, _p, _a, applies) => ({ done: applies > 0 }));
        await start(fake.zen, '-N', '1');
        const growth = JSON.parse(readFileSync(join(appliesDir(), '001', 'growth.json'), 'utf8'));
        expect(growth).toContainEqual(
            expect.objectContaining({ file: 'agents/instructions.md', changes: 0, recent: [] }),
        );
        expect(fake.calls.some((a) => a.includes('/finetune-consolidate'))).toBe(false);
        expect(result('a1')).toMatchObject({ state: 'completed' });
    });
});

async function quietJson(args: string[], run: typeof runDataset = runDataset): Promise<unknown> {
    const out: string[] = [];
    const write = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation((chunk: string | Uint8Array) => {
            out.push(String(chunk));
            return true;
        });
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
        await run({ args, json: true, cwd: root }, { dir: root, name: 'acme' });
    } finally {
        write.mockRestore();
        err.mockRestore();
    }
    return JSON.parse(out.join(''));
}
