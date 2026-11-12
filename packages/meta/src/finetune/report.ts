import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { safe } from '../host.ts';
import { DatasetStore } from './dataset/store.ts';
import { type Case, DATASET_DIR } from './dataset/types.ts';
import {
    type Feedback,
    feedbackId,
    forDataset,
    lead,
    type Phase,
    readFeedback,
} from './feedback.ts';
import type { AppliedFile, Decisions, Deferred } from './improvements.ts';
import type { NowRow } from './live.ts';
import { type Recheck, RECHECK_TRIES } from './recheck.ts';
import { resultOf, selection } from './sampler.ts';
import type { Run } from './train.ts';
import { readJson, type Tuning, type Worker } from './tuning.ts';
import {
    applyTokens,
    type ByModel,
    type ByStage,
    envelopesIn,
    mergeModels,
    mergeStages,
    type ModelMetrics,
    type RunMetrics,
    runMetrics,
    runTokens,
    short,
    STAGES,
    total,
} from './usage.ts';

// ---------------------------------------------------------------------------
// What a person reads
//
// Two pages, both written by code from what is on disk and in hand, never by
// an agent: STATUS.md for the whole tuning, FEEDBACK.md for one case. Diagrams
// carry ids, numbers, fixed words and live lines passed through `safe` - other
// free text goes in tables, escaped - so nothing a model wrote can break a render.
// ---------------------------------------------------------------------------

export interface Attempt {
    phase: Phase;
    attempt: number;
    dir: string;
    run?: Run;
    feedback?: Feedback;
}

const PHASE_WORD: Record<Phase, string> = { nomem: 'no memory', mem: 'with memory' };

function atomic(file: string, text: string): void {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, text);
    renameSync(`${file}.tmp`, file);
}

/** A table cell: one line, no column breaks. */
export const cell = (text: string | number | undefined): string =>
    String(text ?? '')
        .replace(/\s*\n\s*/g, ' ')
        .replace(/\|/g, '\\|')
        .trim() || '-';

/** Markdown as a blockquote, paragraphs kept. */
const quote = (text: string): string =>
    text
        .trim()
        .split('\n')
        .map((l) => (l.trim() ? `> ${l}` : '>'))
        .join('\n');

/** A link from `from` (a directory) to `to`, safe for spaces. */
const link = (label: string, from: string, to: string): string =>
    `[${label}](<${relative(from, to).split(sep).join('/')}>)`;

export function since(ms: number): string {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) {
        return `${s}s`;
    }
    const m = Math.floor(s / 60);
    if (m < 60) {
        return `${m}m ${String(s % 60).padStart(2, '0')}s`;
    }
    return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** The analyze session of one try, kept in its folder. */
export function analyzeSession(dir: string): string | undefined {
    try {
        return readFileSync(join(dir, 'session'), 'utf8').trim() || undefined;
    } catch {
        return undefined;
    }
}

export function attemptsOf(t: Tuning, c: Case): Attempt[] {
    const dir = t.caseDir(c);
    let names: string[] = [];
    try {
        names = readdirSync(dir).filter((n) => /^\d{2}-(nomem|mem)$/.test(n));
    } catch {
        return [];
    }
    return names
        .map((name) => {
            const [n, phase] = name.split('-') as [string, Phase];
            const at = join(dir, name);
            const read = readFeedback(join(at, 'feedback.json'), t.known(c, phase, Number(n)));
            return {
                phase,
                attempt: Number(n),
                dir: at,
                run: readJson<Run>(join(at, 'run.json')),
                ...('feedback' in read ? { feedback: read.feedback } : {}),
            };
        })
        .sort(
            (a, b) =>
                Number(a.phase === 'mem') - Number(b.phase === 'mem') || a.attempt - b.attempt,
        );
}

function decisions(t: Tuning): Decisions {
    return t.improvements.decisions();
}

/** A run's tokens per model: recorded at the run, or read from its trajectory. */
function runByModel(run: Run | undefined): ByModel | undefined {
    if (!run) {
        return undefined;
    }
    const by = run.tokens ?? runTokens(run.dir);
    if (by && Object.keys(by).length > 0) {
        return by;
    }
    return run.usage
        ? {
              '?': {
                  calls: run.turns ?? 0,
                  input: run.usage.inputTokens,
                  cached: run.usage.cachedInputTokens ?? 0,
                  output: run.usage.outputTokens,
                  reasoning: run.usage.reasoningTokens ?? 0,
              },
          }
        : undefined;
}

/** Every try of a case, per stage and model. Applies serve many cases at once, so they are not split. */
export function caseTokens(t: Tuning, c: Case): ByStage {
    const attempts = attemptsOf(t, c);
    return mergeStages(
        ...attempts.map((a) => ({
            run: runByModel(a.run),
            analyze: envelopesIn(a.dir, 'analyze'),
        })),
    );
}

/** `in / out`, the input counting cached tokens. */
const inOut = (by: ByModel | undefined): string => {
    const s = total(by);
    return s.input + s.output > 0 ? `${short(s.input)} / ${short(s.output)}` : '-';
};

function tokenTable(by: ByStage): string[] {
    const rows: string[] = [];
    for (const stage of STAGES) {
        const models = Object.entries(by[stage] ?? {}).sort(([a], [b]) => a.localeCompare(b));
        for (const [model, s] of models) {
            rows.push(
                `| ${stage} | ${cell(model)} | ${s.calls} | ${short(s.input)} | ${short(s.cached)} | ${short(s.output)} | ${short(s.reasoning)} |`,
            );
        }
    }
    if (rows.length === 0) {
        return [];
    }
    return [
        '| Stage | Model | Calls | Input | Cached | Output | Reasoning |',
        '| --- | --- | --- | --- | --- | --- | --- |',
        ...rows,
        '',
    ];
}

export const rubricScore = (f: Attempt['feedback']): string => {
    const r = Object.values(f?.rubric ?? {});
    const invalid = r.filter((x) => x === 'invalid').length;
    const graded = r.length - invalid;
    if (!r.length) {
        return '-';
    }
    return `${r.filter((x) => x === 'pass').length}/${graded}${invalid ? ` (${invalid} invalid)` : ''}`;
};

// ---------------------------------------------------------------------------
// What a run did, and how it moved from the try it is compared with
// ---------------------------------------------------------------------------

const FLAT_KEYS = [
    'calls',
    'input',
    'cached',
    'output',
    'reasoning',
    'peak',
    'llmMs',
    'wallMs',
    'toolMs',
    'tools',
    'toolErrors',
    'recall',
    'load',
    'grep',
    'commit',
    'forget',
    'forks',
    'branches',
    'compactions',
    'handoffs',
] as const;

/** One run, one model of it, or a sum of several. */
type Flat = Record<(typeof FLAT_KEYS)[number], number>;

const blank = (): Flat => Object.fromEntries(FLAT_KEYS.map((k) => [k, 0])) as Flat;

function addFlat(...all: (Flat | undefined)[]): Flat {
    const out = blank();
    for (const f of all) {
        for (const k of FLAT_KEYS) {
            out[k] += f?.[k] ?? 0;
        }
    }
    return out;
}

/** Recorded at the run, or read from its trajectory when the run predates that. */
const metricsOf = (run: Run | undefined): RunMetrics | undefined =>
    run ? (run.metrics ?? runMetrics(run.dir)) : undefined;

const modelFlat = (x: ModelMetrics | undefined): Flat => ({
    ...blank(),
    ...(x
        ? {
              calls: x.calls,
              input: x.input,
              cached: x.cached,
              output: x.output,
              reasoning: x.reasoning,
              peak: x.peak,
              llmMs: x.ms,
          }
        : {}),
});

function runFlat(run: Run | undefined): Flat | undefined {
    const m = metricsOf(run);
    if (!run || !m) {
        return undefined;
    }
    const models = Object.values(m.models);
    return {
        ...addFlat(...models.map(modelFlat)),
        peak: Math.max(0, ...models.map((x) => x.peak)),
        llmMs: m.llmMs,
        wallMs: run.durationMs ?? 0,
        toolMs: m.toolMs,
        tools: m.toolCalls,
        toolErrors: m.toolErrors,
        ...m.memory,
        forks: m.forks,
        branches: m.branches,
        compactions: m.compactions,
        handoffs: m.handoffs,
    };
}

type Kind = 'tokens' | 'time' | 'count' | 'share';

interface Metric {
    label: string;
    kind: Kind;
    /** absent where a move either way is not by itself good or bad */
    better?: 'lower' | 'higher';
    of: (f: Flat) => number;
}

const tokensIn = (f: Flat): number => f.input + f.output;

const MODEL_METRICS: Metric[] = [
    { label: 'LLM calls', kind: 'count', better: 'lower', of: (f) => f.calls },
    { label: 'Input', kind: 'tokens', better: 'lower', of: (f) => f.input },
    { label: 'Cached', kind: 'tokens', of: (f) => f.cached },
    { label: 'Uncached input', kind: 'tokens', better: 'lower', of: (f) => f.input - f.cached },
    {
        label: 'Cache hit',
        kind: 'share',
        better: 'higher',
        of: (f) => (f.input ? (f.cached / f.input) * 100 : 0),
    },
    { label: 'Output', kind: 'tokens', better: 'lower', of: (f) => f.output },
    { label: 'Reasoning', kind: 'tokens', better: 'lower', of: (f) => f.reasoning },
    { label: 'Peak input', kind: 'tokens', better: 'lower', of: (f) => f.peak },
    { label: 'LLM time', kind: 'time', better: 'lower', of: (f) => f.llmMs },
];

const RUN_METRICS: Metric[] = [
    { label: 'Wall clock', kind: 'time', better: 'lower', of: (f) => f.wallMs },
    ...MODEL_METRICS,
    { label: 'Tool calls', kind: 'count', better: 'lower', of: (f) => f.tools },
    { label: 'Tool errors', kind: 'count', better: 'lower', of: (f) => f.toolErrors },
    { label: 'Tool time', kind: 'time', better: 'lower', of: (f) => f.toolMs },
    { label: 'Memory recalls', kind: 'count', of: (f) => f.recall },
    { label: 'Memory loads', kind: 'count', of: (f) => f.load },
    { label: 'Memory greps', kind: 'count', of: (f) => f.grep },
    { label: 'Memory commits', kind: 'count', of: (f) => f.commit },
    { label: 'Memory forgets', kind: 'count', of: (f) => f.forget },
    { label: 'Forks', kind: 'count', of: (f) => f.forks },
    { label: 'Branches', kind: 'count', of: (f) => f.branches },
    { label: 'Compactions', kind: 'count', of: (f) => f.compactions },
    { label: 'Handoffs', kind: 'count', of: (f) => f.handoffs },
];

const SUMMARY_METRICS = RUN_METRICS.filter((m) =>
    [
        'Wall clock',
        'LLM calls',
        'Tool calls',
        'Tool errors',
        'Input',
        'Uncached input',
        'Cache hit',
        'Output',
        'LLM time',
        'Tool time',
    ].includes(m.label),
);

function show(kind: Kind, n: number): string {
    switch (kind) {
        case 'tokens':
            return short(n);
        case 'time':
            return since(n);
        case 'share':
            return `${Math.round(n)}%`;
        default:
            return String(n);
    }
}

/** Percent for amounts, points for a share, a plain difference for a count unless `relative`. */
function change(kind: Kind, now: number, before: number, relative = kind !== 'count'): string {
    const signed = (d: number, unit: string): string =>
        d === 0 ? '=' : `${d > 0 ? '+' : ''}${d}${unit}`;
    if (kind === 'share') {
        return signed(Math.round(now - before), 'pt');
    }
    if (!relative) {
        return signed(now - before, '');
    }
    if (before === 0) {
        return now === 0 ? '=' : 'new';
    }
    return signed(Math.round(((now - before) / before) * 100), '%');
}

/** Within this many percent (points, for a share) is noise, not a trend. */
const SAME = 5;

function trend(m: Metric, now: number, before: number): string {
    if (!m.better) {
        return '';
    }
    const d =
        m.kind === 'share'
            ? now - before
            : before === 0
              ? Math.sign(now) * Infinity
              : ((now - before) / before) * 100;
    if (Number.isNaN(d) || Math.abs(d) < SAME) {
        return 'same';
    }
    return d < 0 === (m.better === 'lower') ? 'better' : 'worse';
}

interface Column {
    label: string;
    now?: Flat;
    base?: Flat;
}

interface Pair {
    now?: Flat;
    base?: Flat;
}

/** Rows are metrics, columns tries; a metric that is zero everywhere is left out. */
function matrix(metrics: Metric[], cols: Column[], effect?: Pair): string[] {
    const all = [...cols.map((c) => c.now), effect?.now, effect?.base];
    const shown = metrics.filter((m) => all.some((f) => f && m.of(f) !== 0));
    if (shown.length === 0) {
        return [];
    }
    const both = effect?.now && effect.base ? { now: effect.now, base: effect.base } : undefined;
    const head = ['Metric', ...cols.map((c) => c.label), ...(both ? ['Memory effect'] : [])];
    const rows = shown.map((m) => {
        const cells = cols.map((c) => {
            if (!c.now) {
                return '-';
            }
            const v = show(m.kind, m.of(c.now));
            return c.base ? `${v} (${change(m.kind, m.of(c.now), m.of(c.base))})` : v;
        });
        if (both) {
            const now = m.of(both.now);
            const before = m.of(both.base);
            const word = trend(m, now, before);
            cells.push(`${change(m.kind, now, before, true)}${word ? ` ${word}` : ''}`);
        }
        return `| ${m.label} | ${cells.join(' | ')} |`;
    });
    return [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows, ''];
}

/** The no-memory try that passed: the one every try with memory is measured against. */
const passedWithout = (attempts: Attempt[]): Attempt | undefined =>
    attempts.find((a) => a.phase === 'nomem' && a.feedback?.done);

const latestWith = (attempts: Attempt[]): Attempt | undefined =>
    [...attempts].reverse().find((a) => a.phase === 'mem' && a.run);

/** Each try against the one before it in its phase; the first with memory against the passing one without. */
function tryColumns(
    attempts: Attempt[],
    flat: (a: Attempt) => Flat | undefined,
): { cols: Column[]; effect?: Pair } {
    const passed = passedWithout(attempts);
    const cols = attempts.map((a, i) => {
        const base =
            attempts
                .slice(0, i)
                .reverse()
                .find((b) => b.phase === a.phase) ?? (a.phase === 'mem' ? passed : undefined);
        return {
            label: `${PHASE_WORD[a.phase]}, try ${a.attempt}`,
            now: flat(a),
            base: base && flat(base),
        };
    });
    const mem = latestWith(attempts);
    return {
        cols,
        ...(passed && mem ? { effect: { now: flat(mem), base: flat(passed) } } : {}),
    };
}

/** Before and after, one row per metric, with whether it moved the right way. */
function compareTable(before: string, after: string, a: Flat, b: Flat): string[] {
    const rows = SUMMARY_METRICS.filter((m) => m.of(a) !== 0 || m.of(b) !== 0).map(
        (m) =>
            `| ${m.label} | ${show(m.kind, m.of(a))} | ${show(m.kind, m.of(b))} | ${change(m.kind, m.of(b), m.of(a), true)} | ${trend(m, m.of(b), m.of(a)) || '-'} |`,
    );
    return [
        `| Metric | ${before} | ${after} | Change | Trend |`,
        '| --- | --- | --- | --- | --- |',
        ...rows,
        '',
    ];
}

function stateOf(t: Tuning, c: Case): string {
    const r = resultOf(t, c);
    if (r) {
        if (r.state === 'failed') {
            return `failed (${r.reason ?? r.phase}) - resumes at the next start`;
        }
        return r.state === 'completed' ? 'completed' : `difficult (${r.reason ?? r.phase})`;
    }
    const w = t.workers.find((x) => x.case?.id === c.id);
    if (w) {
        return `${PHASE_WORD[w.phase ?? 'nomem']} · try ${w.attempt} · ${w.step}`;
    }
    const parked = t.improvements.pending.find((f) => f.case === c.id);
    if (parked) {
        return `${PHASE_WORD[parked.phase]} · try ${parked.attempt} · parked`;
    }
    const applying = t.improvements.inApply.find((f) => f.case === c.id);
    if (applying) {
        return `${PHASE_WORD[applying.phase]} · try ${applying.attempt} · parked, being applied`;
    }
    if (t.claimed.has(c.id)) {
        return 'waiting for a worker';
    }
    return attemptsOf(t, c).length > 0 ? 'stopped' : 'queued';
}

// ---------------------------------------------------------------------------
// FEEDBACK.md - one case
// ---------------------------------------------------------------------------

export function feedbackPath(t: Tuning, c: { id: string }): string {
    return join(t.dir, 'cases', c.id, 'FEEDBACK.md');
}

export function writeFeedback(t: Tuning, c: Case): void {
    const file = feedbackPath(t, c);
    const here = dirname(file);
    const attempts = attemptsOf(t, c);
    const latest = [...attempts].reverse().find((a) => a.feedback);
    const decided = decisions(t);
    const session = [...attempts]
        .reverse()
        .map((a) => analyzeSession(a.dir))
        .find(Boolean);
    const lines: string[] = [];
    const say = (...more: string[]): void => {
        lines.push(...more);
    };

    say(`# ${c.id}`, '', `${link('← status', here, join(t.dir, 'STATUS.md'))}`, '');
    say(
        '| Class | Complexity | Dataset rev | State | System | Session |',
        '| --- | --- | --- | --- | --- | --- |',
        `| ${cell(c.class)} | ${cell(c.complexity)} | ${c.rev} | ${cell(stateOf(t, c))} | v${t.system.version()} | ${
            session ? `\`zen meta resume ${basename(t.root)} ${session}\`` : '-'
        } |`,
        '',
    );
    if (c.rubric.length > 0) {
        say('## Rubric', '', ...c.rubric.map((r) => `- **${r.id}** ${r.text}`), '');
    }
    const input =
        typeof c.input === 'string'
            ? c.input
            : c.input
                  .map((p) =>
                      typeof p === 'string' ? p : 'text' in p ? p.text : `[${Object.keys(p)[0]}]`,
                  )
                  .join(' ');
    say(
        '## Input',
        '',
        ...input
            .slice(0, 800)
            .split('\n')
            .map((l) => `> ${l}`),
        '',
    );

    if (latest?.feedback) {
        const f = latest.feedback;
        say(
            `## Latest analysis - ${PHASE_WORD[latest.phase]}, try ${latest.attempt}: ${f.verdict ?? '?'}, rubric ${rubricScore(f)}${f.done ? ', done' : ''}`,
            '',
        );
        if (f.summary) {
            say(quote(f.summary), '');
        }
        if (latest.run?.missedSkills?.length) {
            say(
                `Never loaded the skill(s) an apply made for it: ${latest.run.missedSkills.map((s) => `\`${s}\``).join(', ')}.`,
                '',
            );
        }
        const id = feedbackId(c.id, latest.phase, latest.attempt, t.round(c));
        const improvements = f.improvements ?? [];
        if (improvements.length > 0) {
            say(
                '### Improvements',
                '',
                '| # | Change | File | Decision |',
                '| --- | --- | --- | --- |',
            );
            for (const i of improvements) {
                const d = decided[id]?.[i.id];
                const decision = forDataset(i)
                    ? 'for the dataset - `zen meta dataset`, never an apply'
                    : d?.decision
                      ? `${d.decision}${d.note ? `: ${d.note}` : ''}`
                      : t.improvements.isApplied(id)
                        ? 'applied (no decision recorded)'
                        : 'waiting for an apply';
                say(`| ${cell(i.id)} | ${cell(i.change)} | ${cell(i.file)} | ${cell(decision)} |`);
            }
            say('');
        }
        const analysis = join(latest.dir, 'analysis.md');
        if (existsSync(analysis)) {
            say('### The analysis', '', readFileSync(analysis, 'utf8').trim(), '');
        }
    }

    if (attempts.length > 0) {
        say(
            '## History',
            '',
            '| Phase | Try | Verdict | Rubric | LLM calls | Tool calls | Run tokens | Analyze tokens | Seconds | System | Links |',
            '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        );
        for (const a of [...attempts].reverse()) {
            const links = [
                a.run ? link('run', here, a.run.dir) : '',
                a.run?.report ? link('report', here, a.run.report) : '',
                existsSync(join(a.dir, 'analysis.md'))
                    ? link('analysis', here, join(a.dir, 'analysis.md'))
                    : '',
                existsSync(join(a.dir, 'feedback.json'))
                    ? link('feedback', here, join(a.dir, 'feedback.json'))
                    : '',
            ].filter(Boolean);
            say(
                `| ${PHASE_WORD[a.phase]} | ${a.attempt} | ${cell(a.feedback?.verdict ?? (a.run ? 'analyzing' : 'running'))} | ${rubricScore(a.feedback)} | ${cell(a.run?.turns)} | ${cell(metricsOf(a.run)?.toolCalls)} | ${inOut(runByModel(a.run))} | ${inOut(envelopesIn(a.dir, 'analyze'))} | ${a.run?.durationMs ? Math.round(a.run.durationMs / 1000) : '-'} | ${a.run ? `v${a.run.system}` : '-'} | ${links.join(' · ') || '-'} |`,
            );
        }
        say('');
    }
    const byRun = tryColumns(attempts, (a) => runFlat(a.run));
    const runRows = matrix(RUN_METRICS, byRun.cols, byRun.effect);
    if (runRows.length > 0) {
        say(
            '## Metrics',
            '',
            'Each try against the one before it in its phase, the first try with memory against the passing try without; Memory effect is the latest try with memory against that same passing try. LLM and tool time are summed over parallel branches.',
            '',
            ...runRows,
        );
        const models = [
            ...new Set(attempts.flatMap((a) => Object.keys(metricsOf(a.run)?.models ?? {}))),
        ].sort();
        if (models.length > 1) {
            for (const model of models) {
                const per = tryColumns(attempts, (a) => {
                    const m = metricsOf(a.run);
                    return m && modelFlat(m.models[model]);
                });
                say(`### ${cell(model)}`, '', ...matrix(MODEL_METRICS, per.cols, per.effect));
            }
        }
    }
    const byStage = caseTokens(t, c);
    if (Object.keys(byStage).length > 0) {
        say('## Tokens', '', ...tokenTable(byStage));
    }
    const submitted = t.memories.submissions().find((s) => s.key === `${c.id}@r${c.rev}`);
    if (submitted) {
        const merges = t.memories
            .merges()
            .filter((m) => m.ok && m.includes.includes(submitted.key));
        say(
            '## Memory',
            '',
            submitted.empty
                ? `The passing run with memory (try ${submitted.attempt}) committed nothing, so there was nothing to keep.`
                : `Kept ${submitted.at.slice(0, 16).replace('T', ' ')} from the passing run with memory (try ${submitted.attempt}): ${link('the copy', here, submitted.dir)}.`,
            '',
        );
        if (!submitted.empty) {
            say(
                merges.length > 0
                    ? `In merges: ${merges.map((m) => link(m.name, here, m.dir)).join(', ')}.`
                    : 'Not merged yet.',
                '',
            );
        }
    }
    const md = `${lines.join('\n')}\n`;
    atomic(file, md);
}

// ---------------------------------------------------------------------------
// APPLY.md - one apply: every request, every decision, every file it changed
// ---------------------------------------------------------------------------

/** A fence longer than any run of backticks in `text`, so nothing inside can close it. */
export function fence(text: string): string {
    const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));
    return '`'.repeat(Math.max(3, longest + 1));
}

export function patchFiles(
    patch: string,
): { file: string; added: number; removed: number; text: string }[] {
    return patch
        .split(/^(?=diff --git )/m)
        .filter((p) => p.startsWith('diff --git '))
        .map((text) => {
            const m = /^diff --git a\/(\S+) b\/(\S+)/.exec(text);
            const file = (m?.[2] ?? '?').replace(/^v\d+\//, '');
            let added = 0;
            let removed = 0;
            for (const line of text.split('\n')) {
                if (line.startsWith('+++') || line.startsWith('---')) {
                    continue;
                }
                if (line.startsWith('+')) {
                    added++;
                } else if (line.startsWith('-')) {
                    removed++;
                }
            }
            return { file, added, removed, text: text.trimEnd() };
        });
}

export function applyPath(dir: string): string {
    return join(dir, 'APPLY.md');
}

export function writeApply(t: Tuning, dir: string): void {
    const name = basename(dir);
    const here = dir;
    const inputs = readJson<(Feedback & { file?: string })[]>(join(dir, 'inputs.json')) ?? [];
    const applied = readJson<AppliedFile>(join(dir, 'applied.json'));
    const failed = readJson<{ at: string; startedAt?: string; error: string }>(
        join(dir, 'failed.json'),
    );
    const decided = readJson<Decisions>(join(dir, 'decisions.json')) ?? {};
    const envelope = readJson<{ sessionId?: string; answer?: string }>(join(dir, 'apply.json'));
    const retried = existsSync(join(dir, 'apply-2.json'));
    const patch = existsSync(join(dir, 'diff.patch'))
        ? readFileSync(join(dir, 'diff.patch'), 'utf8')
        : '';
    const files = patchFiles(patch);
    const improvements = inputs.reduce((n, f) => n + f.improvements.length, 0);
    const consolidation =
        applied?.kind === 'consolidate' || existsSync(join(dir, 'consolidate.json'));
    const status = failed
        ? 'failed - the project was put back as it was'
        : applied
          ? applied.discarded
              ? `undone - ${applied.discarded}`
              : applied.skipped
                ? 'nothing to change'
                : 'applied'
          : 'in progress';
    const started =
        applied?.startedAt ??
        failed?.startedAt ??
        (existsSync(join(dir, 'inputs.json'))
            ? statSync(join(dir, 'inputs.json')).mtime.toISOString()
            : undefined);
    const finished = applied?.at ?? failed?.at;
    const when = (iso: string | undefined): string =>
        iso ? iso.slice(0, 19).replace('T', ' ') : '-';
    const took = started && finished ? since(Date.parse(finished) - Date.parse(started)) : '-';

    const tally: Record<string, number> = {};
    for (const f of inputs) {
        for (const i of f.improvements) {
            const d = decided[f.id]?.[i.id]?.decision ?? 'undecided';
            tally[d] = (tally[d] ?? 0) + 1;
        }
    }

    const out: string[] = [
        `# ${consolidation ? 'Consolidation' : 'Apply'} ${name}${applied && !applied.discarded ? ` - v${applied.from} → v${applied.to}` : ''}`,
        '',
        link('← status', here, join(t.dir, 'STATUS.md')),
        '',
        '| Status | Started | Finished | Took | Requests | Improvements | Files changed | Retried |',
        '| --- | --- | --- | --- | --- | --- | --- | --- |',
        `| ${cell(status)} | ${when(started)} | ${when(finished)} | ${took} | ${inputs.length} | ${improvements} | ${files.length} | ${retried ? 'yes - the first attempt was undone' : 'no'} |`,
        '',
    ];
    if (consolidation) {
        out.push(
            'A consolidation answers no request: it may only shrink what the agents read, and change no rule.',
            '',
        );
    }
    if (failed) {
        out.push(`> ${cell(failed.error)}`, '');
    }
    if (envelope?.sessionId) {
        out.push(
            `The apply session: \`zen meta resume ${basename(t.root)} ${envelope.sessionId}\` - ask it why it changed what it changed.`,
            '',
        );
    }
    if (!consolidation) {
        const deferred = readJson<Deferred[]>(join(dir, 'deferred.json')) ?? [];
        out.push(
            '## Decisions',
            '',
            '| Applied | Merged | Rejected | Deferred | Structural | Undecided |',
            '| --- | --- | --- | --- | --- | --- |',
            `| ${tally.applied ?? 0} | ${tally.merged ?? 0} | ${tally.rejected ?? 0} | ${tally.deferred ?? 0} | ${tally.structural ?? 0} | ${tally.undecided ?? 0} |`,
            '',
        );
        if (deferred.length > 0) {
            out.push(
                `${deferred.length} improvement(s) held back by earlier applies were offered again: ${link('deferred.json', here, join(dir, 'deferred.json'))}.`,
                '',
            );
        }
        out.push('## Requests', '');
    }
    inputs.forEach((f, n) => {
        const tryDir = f.file
            ? dirname(f.file)
            : t.attemptDir({ id: f.case, rev: f.caseRev }, f.phase, f.attempt);
        const run = readJson<Run>(join(tryDir, 'run.json'));
        const links = [
            link('case', here, feedbackPath(t, { id: f.case })),
            existsSync(join(tryDir, 'analysis.md'))
                ? link('analysis', here, join(tryDir, 'analysis.md'))
                : '',
            existsSync(join(tryDir, 'feedback.json'))
                ? link('feedback', here, join(tryDir, 'feedback.json'))
                : '',
            run ? link('run', here, run.dir) : '',
            run?.report ? link('report', here, run.report) : '',
        ].filter(Boolean);
        out.push(
            `### ${n + 1}. ${f.case} - ${f.recheck ? `recheck after ${f.recheck}` : PHASE_WORD[f.phase]}, try ${f.attempt}: ${f.verdict}, rubric ${rubricScore(f)}`,
            '',
            `\`${f.id}\` · ${links.join(' · ')}`,
            '',
        );
        if (f.summary) {
            out.push(quote(f.summary), '');
        }
        if (f.improvements.length === 0) {
            out.push('No improvements asked for.', '');
            return;
        }
        out.push(
            '| # | Kind | File | Change | Why | Expect | Decision | Note |',
            '| --- | --- | --- | --- | --- | --- | --- | --- |',
        );
        for (const i of f.improvements) {
            const d = decided[f.id]?.[i.id];
            out.push(
                `| ${cell(i.id)} | ${cell(i.kind)} | ${cell(i.file)} | ${cell(i.change)} | ${cell(i.why)} | ${cell(i.expect)} | ${cell(d?.decision ?? (applied || failed ? 'undecided' : 'pending'))} | ${cell(d?.note)} |`,
            );
        }
        out.push('');
    });

    out.push('## What the apply agent did', '');
    const changes = join(dir, 'changes.md');
    out.push(
        existsSync(changes)
            ? readFileSync(changes, 'utf8').trim().replace(/^#/gm, '###')
            : '_The apply agent wrote no changes.md._',
        '',
    );
    if (envelope?.answer) {
        out.push(
            '### Its answer',
            '',
            ...envelope.answer
                .trim()
                .split('\n')
                .map((l) => `> ${l}`),
            '',
        );
    }

    out.push('## Files changed', '');
    if (files.length === 0) {
        out.push(applied ? '_None: the system is unchanged._' : '_Not yet._', '');
    } else {
        out.push(
            '| File | Added | Removed |',
            '| --- | --- | --- |',
            ...files.map((f) => `| \`${f.file}\` | +${f.added} | -${f.removed} |`),
            '',
        );
        for (const f of files) {
            const tick = fence(f.text);
            out.push(`### \`${f.file}\``, '', `${tick}diff`, f.text, tick, '');
        }
    }

    out.push('## zen check', '');
    const check = join(dir, 'check.log');
    if (existsSync(check)) {
        const tail = readFileSync(check, 'utf8').trimEnd().split('\n').slice(-40).join('\n');
        const verdict = failed ? 'failed on both attempts' : applied ? 'passed' : 'running';
        const tick = fence(tail);
        out.push(verdict, '', `${tick}text`, tail || '(no output)', tick, '');
    } else {
        out.push(applied?.skipped ? '_Not run: nothing was changed._' : '_Not run yet._', '');
    }

    out.push(...gates(t, dir, applied));

    if (applied && !consolidation) {
        out.push(
            '## Cases sent back to run',
            '',
            ...inputs.map((f) =>
                f.recheck
                    ? `- ${link(f.case, here, feedbackPath(t, { id: f.case }))} - regressed after ${f.recheck}; rechecked first on v${applied.to}`
                    : `- ${link(f.case, here, feedbackPath(t, { id: f.case }))} - ${PHASE_WORD[f.phase]}, try ${f.attempt + 1} on v${applied.to}`,
            ),
            '',
        );
    }
    out.push(...recheckSection(t, here, (r) => r.apply === name));
    atomic(applyPath(dir), `${out.join('\n')}\n`);
}

/** The budget: what the edit cost every later call. */
function gates(t: Tuning, dir: string, applied: AppliedFile | undefined): string[] {
    const out: string[] = [];
    const budget = readJson<{
        total: number;
        start: { total: number };
        budget: number;
        ceiling: number;
    }>(join(dir, 'budget.json'));
    if (budget) {
        out.push(
            '## The prose',
            '',
            'What every call reads, in bytes, summed over the agents: house rules, prompt, preloaded skills, skill index lines.',
            '',
            '| At the start | Before | After | Budget | Ceiling |',
            '| --- | --- | --- | --- | --- |',
            `| ${budget.start.total} | ${budget.total} | ${applied?.bytes?.after ?? '-'} | +${budget.budget} | ${budget.ceiling} |`,
            '',
        );
        const over = join(dir, 'budget.md');
        if (existsSync(over)) {
            out.push(readFileSync(over, 'utf8').trim().replace(/^#/gm, '###'), '');
        }
        const moved = join(dir, 'cost.md');
        if (existsSync(moved)) {
            out.push(readFileSync(moved, 'utf8').trim().replace(/^#/gm, '###'), '');
        }
    }
    return out;
}

const RECHECK_WORD: Record<Recheck['state'], string> = {
    queued: 'queued',
    running: 'running',
    passed: 'passed',
    regressed: 'regressed',
    void: 'void',
};

/** Rechecks, newest first: on an apply's page its own, on STATUS.md the latest. */
function recheckSection(
    t: Tuning,
    here: string,
    which: (r: Recheck) => boolean,
    limit = 50,
): string[] {
    const all = t.rechecks.all().filter(which);
    if (all.length === 0) {
        return [];
    }
    const n = (s: Recheck['state']): number => all.filter((r) => r.state === s).length;
    const out = [
        '## Rechecks',
        '',
        `Cases that passed before, run again without memory on the version an apply made. One that fails both of its ${RECHECK_TRIES} tries has regressed, and its fixes join the improvement queue.`,
        '',
        `passed **${n('passed')}** · regressed **${n('regressed')}** · void **${n('void')}** · queued or running **${n('queued') + n('running')}**`,
        '',
        '| Apply | Case | State | Tries | Request | Note |',
        '| --- | --- | --- | --- | --- | --- |',
    ];
    for (const r of [...all].reverse().slice(0, limit)) {
        const tries = t.rechecks
            .tryDirs(r)
            .map((d, i) => {
                const word = r.tries?.[i] ?? 'running';
                return existsSync(join(d, 'analysis.md'))
                    ? link(word, here, join(d, 'analysis.md'))
                    : link(word, here, d);
            })
            .join(', ');
        out.push(
            `| ${link(r.apply, here, applyPath(join(t.improvements.dir, r.apply)))} | ${link(r.case, here, feedbackPath(t, { id: r.case }))} | ${RECHECK_WORD[r.state]} | ${tries || '-'} | ${cell(r.request)} | ${cell(r.note)} |`,
        );
    }
    out.push('');
    return out;
}

// ---------------------------------------------------------------------------
// The memory section of STATUS.md
// ---------------------------------------------------------------------------

function memorySection(t: Tuning, here: string): string[] {
    const m = t.memories;
    const submissions = m.submissions();
    const merges = m.merges();
    if (submissions.length === 0 && merges.length === 0) {
        return [];
    }
    const caseLink = (key: string): string => {
        const id = key.replace(/@r\d+$/, '');
        return link(id, here, feedbackPath(t, { id }));
    };
    const waiting = m.unmerged();
    const out = [
        '## Memory',
        '',
        'No run shares a memory: every try runs on its own private directory. A case whose',
        `with-memory run passes keeps a copy of that memory; every ${t.config.mergeEvery} kept memories are`,
        'merged, with the last merge, into a new numbered graph.',
        '',
        `kept **${submissions.length}** (${submissions.filter((s) => s.empty).length} committed nothing) · merges **${merges.filter((x) => x.ok).length}** · waiting to merge **${waiting.length} of ${t.config.mergeEvery}**${waiting.length ? `: ${waiting.map((s) => caseLink(s.key)).join(', ')}` : ''}`,
        '',
    ];
    if (merges.length > 0) {
        out.push(
            '| Merge | At | Cases in it | New in this merge | Nodes | Edges | Graph | Log |',
            '| --- | --- | --- | --- | --- | --- | --- | --- |',
        );
        for (const x of [...merges].reverse()) {
            out.push(
                `| ${x.name}${x.ok ? '' : ' (failed)'} | ${x.at.slice(11, 16)} | ${x.includes.length}: ${x.includes.map(caseLink).join(', ')} | ${x.added.map(caseLink).join(', ')} | ${x.nodes ?? '-'} | ${x.edges ?? '-'} | ${x.ok ? link('graph', here, x.dir) : '-'} | ${link('log', here, x.log)} |`,
            );
        }
        out.push('');
    }
    return out;
}

// ---------------------------------------------------------------------------
// STATUS.md - the whole tuning
// ---------------------------------------------------------------------------

/** Longest live line in a sentence, and in a diagram box. */
const NOW_CELL = 100;
const NOW_LABEL = 60;

const cut = (text: string, max: number): string =>
    text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

/** One line, every mark that would style it escaped. */
const escaped = (text: string): string =>
    text
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[\\`*_[\]<>|~&]/g, '\\$&');

/** A live line in running text: cut, and escaped. */
export const liveCell = (text: string | undefined): string =>
    text ? escaped(cut(text.replace(/\s+/g, ' ').trim(), NOW_CELL)) : '-';

/**
 * Several live lines in one cell, oldest first. Each ends in `<br>`, so zen view draws
 * one row per line, cut at the width the column gets rather than wrapped.
 */
const liveCells = (lines: string[] | undefined): string =>
    lines?.length ? lines.map((l) => `${escaped(l)}<br>`).join('') : '-';

/** A live line in a diagram label: only what `safe` lets through, so it cannot break out. */
const liveLabel = (text: string | undefined): string =>
    text ? cut(safe(text, Number.MAX_SAFE_INTEGER), NOW_LABEL) : '';

/** What a worker's agent is doing, if the live snapshot has it on the step the worker is on. */
function nowOf(t: Tuning, w: Worker): string | undefined {
    return liveRow(t, w)?.now;
}

const liveRow = (t: Tuning, w: Worker) =>
    t.live?.now.find((r) => r.key === `w${w.slot}` && r.step === w.step);

const applierRow = (t: Tuning) => t.live?.now.find((r) => r.key === 'apply');

/** What a step under way has spent so far; it reaches the files only when the step ends. */
const inFlight = (row: NowRow | undefined): ByStage =>
    row?.stage && row.act ? { [row.stage]: row.act.byModel } : {};

const applierNow = (t: Tuning): string | undefined => applierRow(t)?.now;

function idleWord(t: Tuning): string {
    if (t.improvements.applying) {
        return 'idle - no run starts during an apply';
    }
    return t.drained ? 'idle - no case left to start' : 'idle';
}

const DIAGRAM_HEAD = [
    '```mermaid',
    '---',
    'config:',
    // Only the base theme takes theme variables.
    '  theme: base',
    '  flowchart:',
    '    wrappingWidth: 480',
    '  themeVariables:',
    "    lineColor: '#8c959f'",
    "    edgeLabelBackground: '#ffffff'",
    '---',
];

// One palette for every diagram: solid fills for what is moving now, tints for the rest.
const PALETTE = [
    '    classDef case fill:#ffffff,stroke:#57606a,color:#24292f',
    '    classDef idle fill:#f6f8fa,stroke:#d0d7de,color:#8c959f',
    '    classDef run fill:#0969da,stroke:#0550ae,color:#ffffff',
    '    classDef analyze fill:#8250df,stroke:#6639ba,color:#ffffff',
    '    classDef off fill:#ffffff,stroke:#d0d7de,color:#57606a',
    '    classDef busy fill:#e16f24,stroke:#bc4c00,color:#ffffff',
    '    classDef full fill:#fff8c5,stroke:#d4a72c,color:#4d2d00',
    '    classDef empty fill:#ffffff,stroke:#d0d7de,stroke-dasharray:4 3,color:#8c959f',
    '    classDef kept fill:#d8f3f1,stroke:#1b7c83,color:#0b3d40',
    '    classDef done fill:#dafbe1,stroke:#1a7f37,color:#116329',
    '    classDef bad fill:#ffebe9,stroke:#cf222e,color:#a40e26',
    '    classDef warn fill:#fff1e5,stroke:#e16f24,color:#953800',
    '    classDef store fill:#ddf4ff,stroke:#54aeff,color:#0a3069',
    '    classDef hub fill:#eaeef2,stroke:#8c959f,color:#24292f',
];

/** `click` lines for a diagram: only to an anchor or to a file that exists, relative to the page. */
function clickable(t: Tuning): {
    clicks: string[];
    click: (id: string, to: string | undefined, tip: string) => void;
} {
    const clicks: string[] = [];
    return {
        clicks,
        click: (id, to, tip) => {
            if (to && (to.startsWith('#') || existsSync(to))) {
                const url = to.startsWith('#')
                    ? to
                    : encodeURI(relative(t.dir, to).split(sep).join('/'));
                clicks.push(`    click ${id} href "${url}" "${tip}"`);
            }
        },
    };
}

// Where every case is now: each step of its path, with how many cases are on it.
function pathDiagram(t: Tuning, counts: Record<string, number>): string[] {
    const q = t.improvements;
    const at = (phase: Phase) => {
        const mine = t.workers.filter((w) => w.case && (w.phase ?? 'nomem') === phase);
        return {
            run: mine.filter((w) => w.step !== 'analyze').length,
            grade: mine.filter((w) => w.step === 'analyze').length,
            wait: [...q.pending, ...q.inApply].filter((f) => f.phase === phase).length,
        };
    };
    const nomem = at('nomem');
    const mem = at('mem');
    const paint: Record<string, string[]> = {};
    const step = (id: string, text: string, n: number, cls: string): string => {
        (paint[n > 0 ? cls : 'off'] ??= []).push(id);
        return `${id}("${text} · ${n}")`;
    };
    const { clicks, click } = clickable(t);
    const queue = anchor(`Improvement queue - ${q.pending.length} of ${t.config.applyAt} parked`);
    click('NS', join(t.root, DATASET_DIR), 'the dataset');
    click('NW', queue, 'the cases waiting for a fix');
    click('MW', queue, 'the cases waiting for a fix');
    click('CD', '#cases', 'every case');
    if (counts.difficult > 0) {
        click('DF', '#difficult-cases', 'the difficult cases');
    }
    if (counts.failed > 0) {
        click('FL', '#failed-cases', 'the failed cases');
    }
    return [
        'Where every case is right now. A case goes through two rounds, first **without memory**, then **with memory**. In each round it is run, then graded; a case that failed waits for a fix to the instructions and runs again.',
        '',
        ...DIAGRAM_HEAD,
        // Edges end on the round boxes, never inside them, so each round keeps its own row.
        'flowchart TB',
        `    NS[("not started · ${counts.queued}")]`,
        '    subgraph NOMEM["1 · without memory"]',
        '        direction LR',
        `        ${step('NR', 'running', nomem.run, 'run')} --> ${step('NA', 'grading', nomem.grade, 'analyze')}`,
        `        NA -->|"failed, tries left"| ${step('NW', 'waiting for a fix', nomem.wait, 'full')}`,
        '        NW -->|"fixed"| NR',
        '    end',
        '    subgraph MEM["2 · with memory"]',
        '        direction LR',
        `        ${step('MR', 'running', mem.run, 'run')} --> ${step('MA', 'grading', mem.grade, 'analyze')}`,
        `        MA -->|"failed, tries left"| ${step('MW', 'waiting for a fix', mem.wait, 'full')}`,
        '        MW -->|"fixed"| MR',
        '    end',
        '    NS --> NOMEM',
        '    NOMEM -->|"passed"| MEM',
        `    MEM -->|"passed"| CD("completed · ${counts.completed}")`,
        `    NOMEM -->|"out of tries"| DF("difficult · ${counts.difficult}")`,
        '    MEM -->|"out of tries"| DF',
        ...(counts.stopped > 0
            ? [`    ST("stopped part-way · ${counts.stopped}") -.->|"next start"| NOMEM`]
            : []),
        ...(counts.failed > 0
            ? [
                  `    NOMEM -.->|"sandbox or provider broke"| FL("${lines(`failed · ${counts.failed}`, 'resumes at the next start')}")`,
              ]
            : []),
        ...clicks,
        ...PALETTE,
        ...Object.entries(paint).map(([cls, ids]) => `    class ${ids.join(',')} ${cls}`),
        '    class NS store',
        '    class CD done',
        '    class DF bad',
        ...(counts.stopped > 0 ? ['    class ST idle'] : []),
        ...(counts.failed > 0 ? ['    class FL warn'] : []),
        '    style NOMEM fill:#ffffff,stroke:#d0d7de',
        '    style MEM fill:#ffffff,stroke:#d0d7de',
        '```',
    ];
}

const STEP_WORD: Record<Worker['step'], string> = {
    idle: 'idle',
    run: 'running',
    analyze: 'grading',
    parked: 'parked',
};

// Edges end on the box, so it keeps LR; the invisible chain keeps the slots in order.
const inOrder = (prefix: string, n: number): string[] =>
    n > 1
        ? [`        ${Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`).join(' ~~~ ')}`]
        : [];

// A markdown label: real newlines, since some previews swallow `<br/>` before Mermaid sees it.
const lines = (...parts: string[]): string => `\`${parts.filter(Boolean).join('\n')}\``;

// The page's own heading ids, so a box can link to the section listing it in full.
const anchor = (heading: string): string =>
    `#${heading
        .trim()
        .toLowerCase()
        .replace(/[^\w\s-]/g, '')
        .replace(/\s/g, '-')}`;

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

// The whole machine right now: plain words first, then one box per moving part.
// Each box links to what it is working on, or to the section that lists it.
function systemDiagram(
    t: Tuning,
    counts: Record<string, number>,
    last: { name: string; dir: string } | undefined,
): string[] {
    const q = t.improvements;
    const m = t.memories;
    const { applyAt, mergeEvery } = t.config;
    const applying = q.applying;
    const took = q.current ? since(Date.now() - q.current.since) : '';
    const waiting = m.unmerged();
    const merged = m.merges().filter((x) => x.ok);
    const running = t.workers.filter((w) => w.case && w.step === 'run').length;
    const grading = t.workers.filter((w) => w.case && w.step === 'analyze').length;
    const rechecking = t.workers.filter((w) => w.case && w.recheck).length;
    const rechecksQueued = t.rechecks.all().filter((r) => r.state === 'queued').length;
    const paint: Record<string, string[]> = {};
    const fill = (id: string, cls: string): void => {
        (paint[cls] ??= []).push(id);
    };
    const { clicks, click } = clickable(t);
    const out = [
        ...DIAGRAM_HEAD,
        'flowchart TB',
        `    DS[("${lines('**cases**', `${counts.queued} not started`)}")]`,
        `    DS -->|"next case"| WORKERS`,
        `    subgraph WORKERS["workers · ${t.busy()} of ${t.workers.length} busy"]`,
        '        direction LR',
    ];
    click('DS', join(t.root, DATASET_DIR), 'the dataset');
    const paused = applying ? 'paused · fixes' : t.drained ? 'nothing left to start' : 'idle';
    for (const w of t.workers) {
        const id = `W${w.slot}`;
        if (!w.case) {
            out.push(`        ${id}("${lines(`**worker ${w.slot}**`, paused)}")`);
            fill(id, 'idle');
            continue;
        }
        const tries = w.recheck
            ? RECHECK_TRIES
            : w.phase === 'mem'
              ? t.config.memTries
              : t.config.tries;
        const started = w.attempt !== undefined;
        const what = w.recheck
            ? `recheck after ${w.recheck.apply}`
            : PHASE_WORD[w.phase ?? 'nomem'];
        out.push(
            `        ${id}("${lines(
                `**worker ${w.slot}** · ${started ? `${STEP_WORD[w.step]} ${since(Date.now() - w.since)}` : 'starting'}`,
                safe(w.case.id, 36),
                started ? `${what} · try ${w.attempt} of ${tries}` : '',
                started ? liveLabel(nowOf(t, w)) : '',
            )}")`,
        );
        fill(id, w.step === 'run' ? 'run' : w.step === 'analyze' ? 'analyze' : 'case');
        click(
            id,
            w.recheck ? w.recheck.dir : feedbackPath(t, w.case),
            w.recheck ? 'this recheck try' : 'the case: rubric, tries, decisions',
        );
    }

    const queued = q.pending
        .slice(0, 8)
        .map((f) => `${safe(f.case, 32)} · ${plural(f.improvements.length, 'fix', 'fixes')}`);
    if (q.pending.length > 8) {
        queued.push(`and ${q.pending.length - 8} more`);
    }
    const applier = applying
        ? q.runs > 0
            ? `waiting for ${plural(q.runs, 'run')} to finish`
            : [
                  `${plural(q.inApply.length, 'case')} · ${took}`,
                  liveLabel(applierNow(t)) || (q.current?.step === 'check' ? 'zen check' : ''),
              ]
                  .filter(Boolean)
                  .join('\n')
        : `idle${last ? ` · last ${last.name}` : ''}`;
    out.push(
        ...inOrder('W', t.workers.length),
        '    end',
        '    WORKERS --> V(["graded"])',
        `    V -.->|"${lines('passed without memory:', 'again with memory')}"| WORKERS`,
        `    V -->|"out of tries"| X("difficult · ${counts.difficult}")`,
        `    V -->|"${lines('failed, tries left,', 'or a recheck failed')}"| Q`,
        `    V -->|"passed with memory"| CD`,
        '    subgraph LEARN["fixing the instructions"]',
        `        Q("${lines(`**waiting for a fix · ${q.pending.length} of ${applyAt}**`, ...(queued.length ? queued : ['empty']))}")`,
        `        Q -->|"${lines(`${applyAt} waiting, or`, 'nothing else to run')}"| P("${lines('**apply fixes**', 'an agent edits the instructions', 'and tidies what it touched', applier)}")`,
        `        P -->|"new version"| S[("${lines(`**instructions · v${t.system.version()}**`, 'every new run reads these')}")]`,
        '    end',
        ...(t.config.recheck > 0
            ? [
                  `    S -.->|"${lines(`recheck ${t.config.recheck} cases that passed`, `${rechecksQueued} queued`)}"| WORKERS`,
              ]
            : []),
    );
    fill('Q', q.pending.length > 0 ? 'full' : 'empty');
    fill('P', applying ? 'busy' : 'off');
    click(
        'Q',
        anchor(`Improvement queue - ${q.pending.length} of ${applyAt} parked`),
        'every case waiting, with what it asks for',
    );
    const applied = applying && q.current?.dir ? q.current.dir : last?.dir;
    if (applied) {
        click('P', applyPath(applied), applying ? 'this apply' : 'the last apply');
    }
    click('S', t.system.snapshotDir(t.system.version()), 'this version of the instructions');

    const kept = waiting.slice(0, 6).map((s) => safe(s.case, 32));
    if (waiting.length > 6) {
        kept.push(`and ${waiting.length - 6} more`);
    }
    out.push(
        '    subgraph KEEP["keeping memory"]',
        `        CD("completed · ${counts.completed}") -->|"keep its memory"| M("${lines(`**memory to merge · ${waiting.length} of ${mergeEvery}**`, ...(kept.length ? kept : ['empty']))}")`,
        `        M -->|"${lines(`${mergeEvery} waiting, or`, 'the tuning ends')}"| MG[("${lines('**merged memory**', plural(merged.length, 'graph'))}")]`,
        '    end',
    );
    fill('M', waiting.length > 0 ? 'kept' : 'empty');
    if (m.submissions().length > 0 || m.merges().length > 0) {
        click('M', '#memory', 'every kept memory and merge');
    }
    click('MG', merged.at(-1)?.dir, 'the latest merged graph');
    if (counts.difficult > 0) {
        click('X', '#difficult-cases', 'the difficult cases');
    }
    click('CD', '#cases', 'every case');
    out.push(
        ...clicks,
        ...PALETTE,
        ...Object.entries(paint).map(([cls, ids]) => `    class ${ids.join(',')} ${cls}`),
        '    class CD done',
        '    class X bad',
        '    class DS,S,MG store',
        '    class V hub',
        '    style WORKERS fill:#ffffff,stroke:#d0d7de',
        '    style LEARN fill:#fffdf5,stroke:#e6d9a8',
        '    style KEEP fill:#f5fbfa,stroke:#a8d8d3',
        ...(q.pending.length >= applyAt ? ['    style Q stroke-width:3px'] : []),
        '```',
    );

    const now: string[] = [];
    const workers = t.workers.length;
    if (applying) {
        now.push(
            q.runs > 0
                ? `- **About to write fixes into the instructions** (orange): waiting for the ${plural(q.runs, 'run')} in progress to finish, so none of them reads half-edited instructions. No new case starts meanwhile.`
                : `- **Writing fixes into the instructions** (orange) for ${plural(q.inApply.length, 'case')} - running for ${took}. No case starts until it is done; then those cases run again on the new version, and ${plural(t.config.recheck, 'case')} that passed before are rechecked on it.`,
        );
    }
    if (running + grading > 0) {
        const doing = [
            running > 0 ? `${running} running a case (blue)` : '',
            grading > 0 ? `${grading} grading a finished run (purple)` : '',
        ].filter(Boolean);
        now.push(
            `- **${t.busy()} of ${workers} workers busy**: ${doing.join(', ')}${rechecking > 0 ? ` - ${rechecking} of them rechecking a case that passed before` : ''}.`,
        );
    }
    if (rechecksQueued > 0) {
        now.push(
            `- **${plural(rechecksQueued, 'recheck')} queued**: cases that passed, to run again on the latest instructions before any new case starts.`,
        );
    }
    if (q.pending.length > 0) {
        now.push(
            `- **${plural(q.pending.length, 'case')} waiting for a fix** (yellow). Their fixes are written once ${applyAt} are waiting, or when nothing else is left to run${applying ? ' - in the round after this one' : ''}.`,
        );
    }
    if (counts.queued > 0) {
        now.push(`- **${plural(counts.queued, 'case')} not started yet.**`);
    }
    if (waiting.length > 0) {
        now.push(
            `- **${plural(waiting.length, 'finished case')} with memory to merge** (teal); memories are merged ${mergeEvery} at a time.`,
        );
    }
    return [
        ...(now.length > 0 ? ['**Right now**', '', ...now] : ['Nothing is running right now.']),
        '',
        '<details>',
        '<summary>How this works</summary>',
        '',
        `1. A worker takes a case and runs the agents on it **without memory**; then another agent grades the run against the case's rubric.`,
        `2. **Failed:** the grader suggests fixes to the agents' instructions. The case waits for a fix (yellow) and its worker takes another case.`,
        `3. Once ${applyAt} cases are waiting, or nothing else is left to run, one agent writes their fixes into the instructions - an **apply** (orange) - and tidies up the files it touched: repeated rules merged, contradictions cut. No case starts while the instructions change; afterwards the waiting cases run again on the new version.`,
        ...(t.config.recheck > 0
            ? [
                  `4. After each apply, ${plural(t.config.recheck, 'case')} that passed before **run again** on the new version, as ordinary work - a recheck. One that fails ${RECHECK_TRIES} tries has regressed: its fixes wait for the next apply like any other.`,
              ]
            : []),
        `${t.config.recheck > 0 ? 5 : 4}. **Passed:** the case runs again **with memory**. When that passes too, the case is completed and its memory is kept; kept memories are merged ${mergeEvery} at a time (teal).`,
        `${t.config.recheck > 0 ? 6 : 5}. A case still failing after ${plural(t.config.tries, 'try', 'tries')} without memory, or ${t.config.memTries} with, is marked **difficult**.`,
        '',
        '</details>',
        '',
        'Click a box to open it.',
        '',
        ...out,
    ];
}

function summarySection(
    spent: Record<Phase, { runs: number; f: Flat }>,
    tuning: { passed: number; first: number; before: Flat; after: Flat },
    memory: { cases: number; cheaper: number; before: Flat; after: Flat },
): string[] {
    const phases = (['nomem', 'mem'] as const).filter((p) => spent[p].runs > 0);
    if (phases.length === 0) {
        return [];
    }
    const row = (label: string, runs: number, f: Flat): string =>
        `| ${label} | ${runs} | ${since(f.wallMs)} | ${f.calls} | ${f.tools} | ${short(f.input)} | ${short(f.cached)} | ${short(f.output)} | ${short(Math.round(tokensIn(f) / runs))} / ${since(f.wallMs / runs)} |`;
    const out = [
        '## Summary',
        '',
        `Trend compares totals over the same cases; within ${SAME}% is \`same\`. Run time is the wall clock of \`zen run\`.`,
        '',
        '| Phase | Runs | Run time | LLM calls | Tool calls | Input | Cached | Output | Per run: tokens / time |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        ...phases.map((p) => row(PHASE_WORD[p], spent[p].runs, spent[p].f)),
        ...(phases.length > 1
            ? [
                  row(
                      '**total**',
                      spent.nomem.runs + spent.mem.runs,
                      addFlat(spent.nomem.f, spent.mem.f),
                  ),
              ]
            : []),
        '',
    ];
    if (tuning.passed > 0) {
        const fixed = tuning.passed - tuning.first;
        out.push(
            '### Tuning effect - first try without memory → passing try',
            '',
            `${tuning.passed} case(s) passed without memory, ${tuning.first} on the first try.${fixed > 0 ? ` The ${fixed} that needed fixes, totalled:` : ''}`,
            '',
            ...(fixed > 0
                ? compareTable('First try', 'Passing try', tuning.before, tuning.after)
                : []),
        );
    }
    if (memory.cases > 0) {
        out.push(
            '### Memory effect - passing try without memory → passing try with memory',
            '',
            `${memory.cases} completed case(s), cheaper in tokens with memory in ${memory.cheaper}. Totalled:`,
            '',
            ...compareTable('Without memory', 'With memory', memory.before, memory.after),
        );
    }
    return out;
}

/** What a status page reads from every case and every apply: kept between the live rewrites. */
interface Slow {
    total: number;
    revision: number;
    counts: Record<
        'queued' | 'nomem' | 'mem' | 'completed' | 'difficult' | 'failed' | 'stopped',
        number
    >;
    summary: string[];
    applies: number;
    lastApply: { name: string; dir: string } | undefined;
    /** tokens per case, keyed `<id>@<rev>` */
    byCase: Map<string, ByStage>;
    /** tokens of every step that ended */
    spent: ByStage;
    /** the sections between the improvement queue and Tokens */
    later: string[];
    /** the sections after Tokens */
    rest: string[];
}

function slowStatus(t: Tuning): Slow {
    const here = t.dir;
    const q = t.improvements;
    const cases = selection(t);
    const store = DatasetStore.open(t.root);
    const byCase = new Map<string, ByStage>();
    const counts = {
        queued: 0,
        nomem: 0,
        mem: 0,
        completed: 0,
        difficult: 0,
        failed: 0,
        stopped: 0,
    };
    const rows: string[] = [];
    const difficult: string[] = [];
    const rubricProblems: string[] = [];
    const failed: string[] = [];
    let everything: ByStage = {};
    const spent: Record<Phase, { runs: number; f: Flat }> = {
        nomem: { runs: 0, f: blank() },
        mem: { runs: 0, f: blank() },
    };
    const tuning = { passed: 0, first: 0, before: blank(), after: blank() };
    const memory = { cases: 0, cheaper: 0, before: blank(), after: blank() };
    const lastRun = (a: Attempt | undefined): string => {
        if (!a) {
            return '-';
        }
        const links = [
            a.run ? link('run', here, a.run.dir) : '',
            a.run?.report ? link('report', here, a.run.report) : '',
            existsSync(join(a.dir, 'run.log')) ? link('run log', here, join(a.dir, 'run.log')) : '',
            existsSync(join(a.dir, 'analysis.md'))
                ? link('analysis', here, join(a.dir, 'analysis.md'))
                : '',
            existsSync(join(a.dir, 'analyze.log'))
                ? link('analyze log', here, join(a.dir, 'analyze.log'))
                : '',
        ].filter(Boolean);
        return `${PHASE_WORD[a.phase]} try ${a.attempt}: ${links.join(' · ') || '-'}`;
    };
    const stamp = (iso: string): string => `${iso.slice(0, 19).replace('T', ' ')} UTC`;
    for (const c of cases) {
        const w = t.workers.find((x) => x.case?.id === c.id);
        const parked =
            t.improvements.pending.find((f) => f.case === c.id) ??
            t.improvements.inApply.find((f) => f.case === c.id);
        const r = resultOf(t, c);
        const attempts = attemptsOf(t, c);
        if (r) {
            counts[r.state]++;
        } else if (w) {
            counts[w.phase ?? 'nomem']++;
        } else if (parked) {
            counts[parked.phase]++;
        } else if (attempts.length > 0 && !t.claimed.has(c.id)) {
            counts.stopped++;
        } else {
            counts.queued++;
        }
        const nomem = attempts.filter((a) => a.phase === 'nomem');
        const mem = attempts.filter((a) => a.phase === 'mem');
        const last = [...attempts].reverse().find((a) => a.feedback);
        const calls = nomem.map((a) => a.run?.turns).filter((n) => n !== undefined);
        const memCalls = mem.map((a) => a.run?.turns).filter((n) => n !== undefined);
        const caseBy = caseTokens(t, c);
        byCase.set(`${c.id}@${c.rev}`, caseBy);
        everything = mergeStages(everything, caseBy);
        for (const a of attempts) {
            const f = runFlat(a.run);
            if (f) {
                spent[a.phase].runs++;
                spent[a.phase].f = addFlat(spent[a.phase].f, f);
            }
        }
        const passed = passedWithout(attempts);
        const firstFlat = runFlat(nomem[0]?.run);
        const passedFlat = runFlat(passed?.run);
        if (passed) {
            tuning.passed++;
        }
        if (passed?.attempt === 1) {
            tuning.first++;
        } else if (firstFlat && passedFlat) {
            tuning.before = addFlat(tuning.before, firstFlat);
            tuning.after = addFlat(tuning.after, passedFlat);
        }
        const withMem = runFlat(
            r?.state === 'completed'
                ? mem.find((a) => a.feedback?.done)?.run
                : latestWith(attempts)?.run,
        );
        if (r?.state === 'completed' && withMem && passedFlat) {
            memory.cases++;
            memory.cheaper += tokensIn(withMem) < tokensIn(passedFlat) ? 1 : 0;
            memory.before = addFlat(memory.before, passedFlat);
            memory.after = addFlat(memory.after, withMem);
        }
        const effect =
            withMem && passedFlat
                ? `${change('tokens', tokensIn(withMem), tokensIn(passedFlat))} tokens · ${change('time', withMem.wallMs, passedFlat.wallMs)} time${r?.state === 'completed' ? '' : ' (so far)'}`
                : '-';
        rows.push(
            `| ${link(c.id, here, feedbackPath(t, c))} | ${cell(c.class)} | ${c.rubric.length} | ${cell(stateOf(t, c))} | ${nomem.length} / ${mem.length} | ${cell(last?.feedback?.verdict)} ${rubricScore(last?.feedback)} | ${calls.length ? `${calls[0]} → ${calls.at(-1)}` : '-'} | ${memCalls.length ? memCalls.at(-1) : '-'} | ${effect} | ${inOut(caseBy.run)} | ${inOut(caseBy.analyze)} | ${attempts.at(-1)?.run ? `v${attempts.at(-1)!.run!.system}` : '-'} |`,
        );
        if (r?.state === 'difficult') {
            difficult.push(
                `| ${link(c.id, here, feedbackPath(t, c))} | ${PHASE_WORD[r.phase]} | ${cell(r.reason)} | ${r.phase === 'nomem' ? nomem.length : mem.length} | ${stamp(r.at)} | ${cell(lead(last?.feedback?.summary ?? ''))} | ${lastRun(attempts.at(-1))} |`,
            );
        }
        const broken = Object.entries(last?.feedback?.rubric ?? {})
            .filter(([, g]) => g === 'invalid')
            .map(([id]) => id);
        if (broken.length > 0) {
            const why = (last?.feedback?.improvements ?? []).filter(forDataset);
            rubricProblems.push(
                `| ${link(c.id, here, feedbackPath(t, c))} | ${broken.join(', ')} | ${cell(why.map((i) => i.change).join(' / '))} |`,
            );
        }
        if (r?.state === 'failed') {
            failed.push(
                `| ${link(c.id, here, feedbackPath(t, c))} | ${PHASE_WORD[r.phase]}, try ${(r.phase === 'nomem' ? nomem : mem).length || 1} | ${cell(r.reason)} | ${stamp(r.at)} | ${lastRun(attempts.at(-1))} |`,
            );
        }
    }

    const later: string[] = [];
    const applies = q.applies();
    if (applies.length > 0) {
        later.push(
            '## Applies',
            '',
            'Each apply links to its own page: every request, every decision, every file changed and why. Prose is the change in what every call reads, in bytes, summed over the agents.',
            '',
            '| Apply | Versions | At | Requests | Applied | Merged | Rejected | Deferred | Structural | Prose | Files changed | Tokens | Details |',
            '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        );
        for (const a of [...applies].reverse()) {
            const d = readJson<Decisions>(join(a.dir, 'decisions.json')) ?? {};
            const tally: Record<string, number> = {};
            for (const byImprovement of Object.values(d)) {
                for (const x of Object.values(byImprovement)) {
                    tally[x.decision ?? '?'] = (tally[x.decision ?? '?'] ?? 0) + 1;
                }
            }
            const patch = join(a.dir, 'diff.patch');
            const files = existsSync(patch)
                ? (readFileSync(patch, 'utf8').match(/^diff --git /gm) ?? []).length
                : 0;
            const details = [
                existsSync(join(a.dir, 'changes.md'))
                    ? link('changes', here, join(a.dir, 'changes.md'))
                    : '',
                existsSync(patch) ? link('diff', here, patch) : '',
                existsSync(join(a.dir, 'decisions.json'))
                    ? link('decisions', here, join(a.dir, 'decisions.json'))
                    : '',
            ].filter(Boolean);
            const versions = a.applied
                ? a.applied.discarded
                    ? `undone at v${a.applied.from}`
                    : `v${a.applied.from} → v${a.applied.to}`
                : existsSync(join(a.dir, 'failed.json'))
                  ? 'failed'
                  : 'in progress';
            const prose = a.applied?.bytes
                ? `${a.applied.bytes.after - a.applied.bytes.before > 0 ? '+' : ''}${a.applied.bytes.after - a.applied.bytes.before}`
                : '-';
            const what =
                a.applied?.kind === 'consolidate' || existsSync(join(a.dir, 'consolidate.json'))
                    ? `${link(a.name, here, applyPath(a.dir))} consolidation`
                    : link(a.name, here, applyPath(a.dir));
            later.push(
                `| ${what} | ${versions} | ${a.applied?.at.slice(11, 16) ?? '-'} | ${a.inputs?.length ?? 0} | ${tally.applied ?? 0} | ${tally.merged ?? 0} | ${tally.rejected ?? 0} | ${tally.deferred ?? 0} | ${tally.structural ?? 0} | ${prose} | ${files} | ${inOut(applyTokens(a.dir))} | ${details.join(' · ') || (a.applied?.skipped ? 'nothing to change' : '-')} |`,
            );
        }
        later.push('');
    }

    later.push(...recheckSection(t, here, () => true, 30));
    const allStages = mergeStages(everything, t.rechecks.tokens(), {
        apply: mergeModels(...applies.map((a) => applyTokens(a.dir))),
    });
    t.progress = { counts, total: cases.length, spent: allStages };

    const rest = [...memorySection(t, here)];

    rest.push(
        '## Cases',
        '',
        '| Case | Class | Rubric | State | Tries without / with | Last verdict | LLM calls without memory | With memory | Memory effect | Run tokens | Analyze tokens | System |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        ...rows,
        '',
    );
    if (difficult.length > 0) {
        rest.push(
            '## Difficult cases',
            '',
            '| Case | Phase | Reason | Tries | Difficult since | Last summary | Last run |',
            '| --- | --- | --- | --- | --- | --- | --- |',
            ...difficult,
            '',
        );
    }
    if (rubricProblems.length > 0) {
        rest.push(
            '## Rubric problems',
            '',
            'Lines the latest analysis graded `invalid`: they say how one implementation did it, not what a right answer is. No apply touches them - fix the case with `zen meta dataset`.',
            '',
            '| Case | Lines | What is wrong |',
            '| --- | --- | --- |',
            ...rubricProblems,
            '',
        );
    }
    if (failed.length > 0) {
        rest.push(
            '## Failed cases',
            '',
            'Something outside the prose broke - the sandbox, a provider, a key - so these taught nothing. They keep their tries and carry on from the step that failed at the next `zen meta finetune start`.',
            '',
            '| Case | Stopped at | Reason | Failed at | Last run |',
            '| --- | --- | --- | --- | --- |',
            ...failed,
            '',
        );
    }
    return {
        total: cases.length,
        revision: store.manifest.revision,
        counts,
        summary: summarySection(spent, tuning, memory),
        applies: applies.length,
        lastApply: applies.at(-1),
        byCase,
        spent: allStages,
        later,
        rest,
    };
}

const slowParts = new WeakMap<Tuning, Slow>();

/** `live` reuses the parts read from every case and apply; only what moves by the second is read. */
export function writeStatus(t: Tuning, live = false): void {
    const here = t.dir;
    let s = live ? slowParts.get(t) : undefined;
    if (!s) {
        s = slowStatus(t);
        slowParts.set(t, s);
    }
    const counts = s.counts;
    const done = counts.completed + counts.difficult;
    const bar = s.total ? Math.round((done / s.total) * 20) : 0;
    const state = t.finished ? 'finished' : t.stopping ? 'stopping' : 'running';
    const q = t.improvements;
    const out: string[] = [
        `# Fine-tuning - ${basename(t.root)}`,
        '',
        `**${state}** · started ${new Date(t.startedAt).toISOString().slice(0, 16).replace('T', ' ')} · elapsed ${since(Date.now() - t.startedAt)} · updated ${new Date().toISOString().slice(11, 19)}`,
        `system **v${t.system.version()}** (applies: ${s.applies}) · dataset rev **${s.revision}** · workers **${t.workers.filter((w) => w.case).length} / ${t.workers.length}** · apply at **${t.config.applyAt}** · tries ${t.config.tries} without memory, ${t.config.memTries} with`,
        '',
        `\`${'█'.repeat(bar)}${'░'.repeat(20 - bar)}\` ${done} of ${s.total} cases done - ${counts.completed} completed, ${counts.difficult} difficult${counts.failed ? ` · ${counts.failed} failed, they resume at the next start` : ''}`,
        '',
        ...s.summary,
        '## Overview',
        '',
        ...pathDiagram(t, counts),
        '',
        '## System',
        '',
        ...systemDiagram(t, counts, s.lastApply),
        '',
        '## Workers',
        '',
        '| Worker | Case | Class | Phase | Try | Step | Since | Run | Analysis | Session | Now |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ];
    for (const w of t.workers) {
        if (!w.case) {
            out.push(`| ${w.slot} | - | - | - | - | ${idleWord(t)} | - | - | - | - | - |`);
            continue;
        }
        const dir = t.workDir({ ...w, case: w.case });
        const run = readJson<Run>(join(dir, 'run.json'));
        const session = analyzeSession(dir);
        const phase = w.recheck
            ? `recheck after ${w.recheck.apply}`
            : PHASE_WORD[w.phase ?? 'nomem'];
        const tries = w.recheck
            ? RECHECK_TRIES
            : w.phase === 'mem'
              ? t.config.memTries
              : t.config.tries;
        out.push(
            `| ${w.slot} | ${link(w.case.id, here, feedbackPath(t, w.case))} | ${cell(w.case.class)} | ${phase} | ${w.attempt} / ${tries} | ${w.step} | ${since(Date.now() - w.since)} | ${run ? `${link('run', here, run.dir)}${run.report ? ` · ${link('report', here, run.report)}` : ''}` : '-'} | ${existsSync(join(dir, 'analysis.md')) ? link('analysis', here, join(dir, 'analysis.md')) : '-'} | ${session ? `\`zen meta resume ${basename(t.root)} ${session}\`` : '-'} | ${liveCells(liveRow(t, w)?.recent)} |`,
        );
    }
    for (const w of t.workers) {
        const by = w.case
            ? tokenTable(
                  mergeStages(
                      s.byCase.get(`${w.case.id}@${w.case.rev}`) ?? caseTokens(t, w.case),
                      inFlight(liveRow(t, w)),
                  ),
              )
            : [];
        if (w.case && by.length > 0) {
            out.push(
                '',
                `### Worker ${w.slot} - ${link(w.case.id, here, feedbackPath(t, w.case))}`,
                '',
                ...by,
            );
        }
    }

    out.push('', `## Improvement queue - ${q.pending.length} of ${t.config.applyAt} parked`, '');
    out.push(
        q.applying
            ? `Applying now: no new run starts until it is done.${applierNow(t) ? ` Now: ${liveCell(applierNow(t))}` : ''}`
            : `A parked case gives its worker back, so another case runs meanwhile. The next apply comes when ${Math.max(0, t.config.applyAt - q.pending.length)} more park, or once nothing is running and no case is left to start; woken cases take a worker before new ones.`,
        '',
    );
    if (q.pending.length > 0) {
        out.push(
            '| Request | Case | Phase | Try | Improvements | Summary |',
            '| --- | --- | --- | --- | --- | --- |',
        );
        for (const f of q.pending) {
            out.push(
                `| ${cell(f.id)} | ${link(f.case, here, feedbackPath(t, { id: f.case }))} | ${PHASE_WORD[f.phase]} | ${f.attempt} | ${f.improvements.length} | ${cell(lead(f.summary))} |`,
            );
        }
        out.push('');
    }

    out.push(...s.later);
    const tokenRows = tokenTable(
        mergeStages(
            s.spent,
            ...t.workers.map((w) => inFlight(liveRow(t, w))),
            inFlight(t.improvements.current?.dir ? applierRow(t) : undefined),
        ),
    );
    if (tokenRows.length > 0) {
        out.push(
            '## Tokens',
            '',
            'Every try of every case so far, every recheck, and every apply - the steps under way included.',
            '',
            ...tokenRows,
        );
    }
    out.push(...s.rest);
    out.push('## Recent events', '');
    for (const e of t.recent.slice(0, 20)) {
        const who = [
            e.worker ? `worker ${e.worker}` : '',
            e.case ?? '',
            e.phase ? `${PHASE_WORD[e.phase]}${e.attempt ? ` try ${e.attempt}` : ''}` : '',
        ].filter(Boolean);
        out.push(
            `- ${e.at.slice(11, 19)} · ${[...who, e.what].join(' · ')}${e.detail ? ` - ${cell(e.detail)}` : ''}`,
        );
    }
    out.push(
        `- … everything in ${link('events.jsonl', here, join(t.dir, 'events.jsonl'))}`,
        '',
        '## Files',
        '',
        '- `cases/<id>/FEEDBACK.md` - one case: rubric, latest analysis, decisions, history',
        '- `cases/<id>/r<rev>/<NN>-<phase>/` - one try: `request.json`, `run.json`, `memory/`, `workspace/`, `brief.md`, `feedback.json`, `analysis.md`, logs',
        '- `applies/<NNN>/APPLY.md` - one apply: requests, decisions, files changed with their diffs, zen check',
        '- `applies/<NNN>/` - `inputs.json`, `brief.md`, `apply.log`, `check.log`, `changes.md`, `decisions.json`, `diff.patch`',
        '- `memories/` - `submissions.jsonl`, `merges.jsonl`, `submitted/<case>@r<rev>/`, `merged/mNN/`',
        '- `systems/` - `systems.jsonl` and a copy of `agents.yaml` + `agents/` per version',
        '- `events.jsonl` - every step, in order; `loop.json` - the settings',
        '- `journal.jsonl` - steps begun and not yet closed; a restart rolls back what a kill cut off',
        '- `view.json` - where `zen meta finetune start` or `serve` shows these pages live',
        '',
    );
    atomic(join(t.dir, 'STATUS.md'), `${out.join('\n')}\n`);
}
