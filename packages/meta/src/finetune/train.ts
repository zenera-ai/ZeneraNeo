import type { TokenUsage } from '@zenera/neo';
import { randomUUID } from 'node:crypto';
import {
    copyFileSync,
    cpSync,
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { EXIT } from '../host.ts';
import { sessionKept } from '../tokens.ts';
import { writeAnalyzeBrief } from './analyze-brief.ts';
import { batchInput } from './dataset/export.ts';
import { DatasetStore } from './dataset/store.ts';
import type { Case } from './dataset/types.ts';
import { errorIn, sizeOf, StepError } from './failure.ts';
import {
    type Feedback,
    feedbackId,
    forDataset,
    forProse,
    lead,
    type Phase,
    readFeedback,
} from './feedback.ts';
import { attemptsOf, caseTokens, rubricScore, writeFeedback } from './report.ts';
import type { Result } from './sampler.ts';
import { readJson, type Seat, type Tuning } from './tuning.ts';
import {
    type ByModel,
    envelopesIn,
    type RunMetrics,
    runMetrics,
    spent,
    tokensOf,
} from './usage.ts';

// ---------------------------------------------------------------------------
// One case, start to finish
//
// `train` is the whole method: tries without memory until the case passes,
// then tries with the memory that passing run wrote. Every step leaves its
// result in the attempt's folder and is skipped when that result is already
// there, so calling `train` again after a stop carries on where it was.
// ---------------------------------------------------------------------------

export async function train(t: Tuning, s: Seat, c: Case): Promise<void> {
    let passed: Run | undefined;
    for (let attempt = 1; attempt <= t.config.tries; attempt++) {
        const { run, feedback } = await tryOnce(t, s, c, 'nomem', attempt);
        if (feedback.done) {
            passed = run;
            break;
        }
        const rubricOnly = datasetOnly(feedback);
        if (rubricOnly) {
            return markDifficult(t, c, 'nomem', rubricOnly);
        }
        if (attempt < t.config.tries) {
            const { structural } = await t.improvements.apply(feedback, s);
            if (structural) {
                return markDifficult(t, c, 'nomem', `structural: ${structural}`);
            }
        }
    }
    if (!passed) {
        return markDifficult(t, c, 'nomem', 'wrong');
    }

    let cheaper = false;
    for (let attempt = 1; attempt <= t.config.memTries; attempt++) {
        const { run, feedback } = await tryOnce(t, s, c, 'mem', attempt, passed.memory);
        if (feedback.done) {
            cheaper = true;
            t.memories.submit(c, attempt, run);
            break;
        }
        const rubricOnly = datasetOnly(feedback);
        if (rubricOnly) {
            return markDifficult(t, c, 'mem', rubricOnly);
        }
        if (attempt < t.config.memTries) {
            const { structural } = await t.improvements.apply(feedback, s);
            if (structural) {
                return markDifficult(t, c, 'mem', `structural: ${structural}`);
            }
        }
    }
    if (!cheaper) {
        return markDifficult(t, c, 'mem', 'memory');
    }

    markCompleted(t, c);
}

/** Not done, and every finding is about the case itself: another try on the same prose learns nothing. */
function datasetOnly(f: Feedback): string | undefined {
    const dataset = f.improvements.filter(forDataset);
    if (dataset.length === 0 || forProse(f).length > 0) {
        return undefined;
    }
    return `specification: ${dataset.map((i) => lead(i.change)).join('; ')}`;
}

/** A run its analysis finds void is set aside and run again: it says nothing about the prose. */
async function tryOnce(
    t: Tuning,
    s: Seat,
    c: Case,
    phase: Phase,
    attempt: number,
    memory?: string,
): Promise<{ run: Run; feedback: Feedback }> {
    for (let voids = 1; ; voids++) {
        const run = await zenRun(t, s, c, phase, attempt, memory);
        const feedback = await analyze(t, s, c, phase, attempt, run);
        if (feedback.verdict !== 'void') {
            return { run, feedback };
        }
        const dir = t.attemptDir(c, phase, attempt);
        let n = 1;
        while (existsSync(`${dir}.void-${n}`)) {
            n++;
        }
        renameSync(dir, `${dir}.void-${n}`);
        t.event({
            what: 'set aside',
            worker: s.worker?.slot,
            case: c.id,
            phase,
            attempt,
            detail: `void, kept in ${basename(dir)}.void-${n} - running the try again`,
        });
        if (voids >= VOIDS) {
            throw new VoidRun(
                `${VOIDS} analyses in a row found the run void - the last: ${feedback.infra}`,
                join(`${dir}.void-${n}`, 'analysis.md'),
            );
        }
        t.checkStopping();
    }
}

// ---------------------------------------------------------------------------
// zen run
// ---------------------------------------------------------------------------

export interface Run {
    /** the run directory under sessions/ */
    dir: string;
    /** the memory it ran with and committed into */
    memory: string;
    /** its own empty directory, the root of the agent's file tools */
    workspace?: string;
    /** the system version it ran on */
    system: number;
    report?: string;
    graph?: string;
    /** the run's own error, when it failed - still worth analyzing */
    failed?: string;
    turns?: number;
    usage?: TokenUsage;
    /** per model, from the run's trajectory */
    tokens?: ByModel;
    metrics?: RunMetrics;
    durationMs?: number;
    /** skills an apply made for this case that the run never loaded */
    missedSkills?: string[];
}

export class VoidRun extends StepError {}

/** The container engine failed: every run after this one would fail the same way. */
export class SandboxDown extends StepError {}

/** Killed for memory, or nothing to show for it: the run says nothing about the prose. */
const VOIDS = 3;

async function zenRun(
    t: Tuning,
    s: Seat,
    c: Case,
    phase: Phase,
    attempt: number,
    memory?: string,
): Promise<Run> {
    const dir = t.attemptDir(c, phase, attempt);
    const file = join(dir, 'run.json');
    for (let tries = 1; !existsSync(file); tries++) {
        if (tries > VOIDS) {
            throw new VoidRun(`${VOIDS} runs in a row were void`, join(dir, 'run.log'));
        }
        await t.improvements.notApplying();
        t.at(s, phase, attempt, 'run');
        t.improvements.runs++;
        const began = Date.now();
        // The skills the apply after the last try made for this case: this run should load them.
        const expect =
            attempt > 1
                ? t.improvements.skillsFor(feedbackId(c.id, phase, attempt - 1, t.round(c)))
                : [];
        try {
            const why = await t.journal.step({ kind: 'run', dir }, () =>
                runOnce(t, c, dir, memory, expect),
            );
            const ran = why ? undefined : readJson<Run>(file);
            t.ended(s, {
                what: why ? 'void' : 'ran',
                phase,
                attempt,
                result:
                    why ?? (ran?.failed ? `failed: ${ran.failed}` : `${ran?.turns ?? '?'} turns`),
                took: Date.now() - began,
                tokens: spent(ran?.tokens),
            });
        } finally {
            t.improvements.runs--;
        }
    }
    return readJson<Run>(file)!;
}

/** One `zen run`. Writes run.json, or says why the run was void. */
export async function runOnce(
    t: Tuning,
    c: Case,
    dir: string,
    memory?: string,
    expect: string[] = [],
): Promise<string | undefined> {
    mkdirSync(dir, { recursive: true });
    const mem = join(dir, 'memory');
    rmSync(mem, { recursive: true, force: true });
    if (memory && existsSync(memory)) {
        cpSync(memory, mem, { recursive: true, filter: (src) => basename(src) !== '.lock' });
    }
    // Else `zen run` roots the agent's files at its cwd: the project, shared by every run.
    const workspace = join(dir, 'workspace');
    rmSync(workspace, { recursive: true, force: true });
    mkdirSync(workspace, { recursive: true });
    const request = join(dir, 'request.json');
    const envelope = join(dir, 'envelope.json');
    const events = join(dir, 'events.jsonl');
    rmSync(envelope, { force: true });
    rmSync(events, { force: true });
    writeFileSync(
        request,
        `${JSON.stringify({ input: batchInput([c], t.root, request).batch[0].input }, null, 2)}\n`,
    );

    const log = join(dir, 'run.log');
    const from = existsSync(log) ? statSync(log).size : 0;
    const said = (): string =>
        existsSync(log) ? readFileSync(log).subarray(from).toString('utf8') : '';
    const res = await t.zen(
        [
            'run',
            '--plain',
            '--new',
            '--yes',
            '--json',
            // A try is never continued: its containers would only hold podman's locks.
            '--disposable',
            '--input',
            request,
            '--memory',
            mem,
            '--workspace',
            workspace,
            '--out',
            envelope,
            '--events',
            events,
        ],
        log,
    );
    if (res.code === EXIT.sandbox) {
        throw new SandboxDown(
            /error\s+(.+)/.exec(said())?.[1]?.trim() ?? 'the sandbox is not ready',
            log,
        );
    }

    const out = readJson<{ run?: { dir: string; report?: string; graph?: string } }>(envelope);
    let runDir = out?.run?.dir;
    let failed: string | undefined;
    if (!runDir) {
        // A failed run throws before the envelope; its directory is in the hint.
        const text = said();
        const report = /report: (\S+report\.html)/.exec(text)?.[1];
        if (!report) {
            return 'no run directory';
        }
        runDir = dirname(report);
        failed = /error\s+(.+)/.exec(text)?.[1]?.trim() ?? 'the run failed';
    }
    const graph = join(runDir, 'graph.mmd');
    if (existsSync(graph) && /exit code 137/.test(readFileSync(graph, 'utf8'))) {
        return 'a command was killed for memory (exit 137)';
    }
    const meta = readJson<{
        turns?: number;
        usage?: TokenUsage;
        durationMs?: number;
        error?: string;
    }>(join(runDir, 'meta.json'));
    const metrics = runMetrics(runDir);
    if (metrics?.sandbox) {
        throw new SandboxDown(metrics.sandbox, join(runDir, 'graph.mmd'));
    }
    const missed = expect.filter((name) => !metrics?.skills.includes(name));
    const run: Run = {
        dir: runDir,
        memory: mem,
        workspace,
        system: t.system.version(),
        ...(existsSync(join(runDir, 'report.html')) ? { report: join(runDir, 'report.html') } : {}),
        ...(existsSync(graph) ? { graph } : {}),
        ...(failed || meta?.error ? { failed: failed ?? meta?.error } : {}),
        ...(meta?.turns !== undefined ? { turns: meta.turns } : {}),
        ...(meta?.usage ? { usage: meta.usage } : {}),
        ...(metrics ? { tokens: tokensOf(metrics), metrics } : {}),
        ...(meta?.durationMs !== undefined ? { durationMs: meta.durationMs } : {}),
        ...(missed.length > 0 ? { missedSkills: missed } : {}),
    };
    writeFileSync(join(dir, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
    return undefined;
}

// ---------------------------------------------------------------------------
// zen meta run /analyze
// ---------------------------------------------------------------------------

/** One analyze session per try, kept in its folder: the brief carries the earlier tries. */
async function analyze(
    t: Tuning,
    s: Seat,
    c: Case,
    phase: Phase,
    attempt: number,
    run: Run,
): Promise<Feedback> {
    const dir = t.attemptDir(c, phase, attempt);
    const file = join(dir, 'feedback.json');
    const known = t.known(c, phase, attempt);
    const kept = readFeedback(file, known);
    let feedback: Feedback;
    if ('feedback' in kept) {
        feedback = kept.feedback;
    } else {
        t.checkStopping();
        t.at(s, phase, attempt, 'analyze');
        const began = Date.now();
        feedback = await t.journal.step({ kind: 'analyze', dir }, () =>
            analyzeOnce(t, s, c, phase, attempt, run, file),
        );
        const graded = Object.values(feedback.rubric);
        t.ended(s, {
            what: 'analyzed',
            phase,
            attempt,
            result:
                feedback.verdict === 'void'
                    ? `void: ${feedback.infra}`
                    : `${feedback.verdict}${graded.length ? ` ${rubricScore(feedback)}` : ''}${feedback.done ? ', done' : ''}`,
            took: Date.now() - began,
            tokens: spent(envelopesIn(dir, 'analyze')),
        });
        // Only a try that went all the way through says the sandbox and the providers are up:
        // a run can pass on one provider while the analysis fails on another.
        if (feedback.verdict !== 'void') {
            t.succeeded();
        }
    }
    writeFeedback(t, c);
    return feedback;
}

async function analyzeOnce(
    t: Tuning,
    s: Seat,
    c: Case,
    phase: Phase,
    attempt: number,
    run: Run,
    file: string,
): Promise<Feedback> {
    const dir = dirname(file);
    const known = t.known(c, phase, attempt);
    let session: string = randomUUID();
    writeFileSync(join(dir, 'session'), `${session}\n`);
    const all = attemptsOf(t, c);
    const at = all.findIndex((a) => a.phase === phase && a.attempt === attempt);
    const brief = await writeAnalyzeBrief(t, dir, {
        run,
        case: c,
        phase,
        attempt,
        earlier: at >= 0 ? all.slice(0, at) : all,
        ...(run.missedSkills?.length ? { missed: run.missedSkills } : {}),
    });
    const hash = t.system.hash();
    const applies = t.improvements.started;
    const events = join(dir, 'analyze.events.jsonl');
    rmSync(events, { force: true });
    const continuing = (): string[] => [
        'meta',
        'run',
        '--no-refresh',
        '--json',
        '--events',
        events,
        ...(sessionKept(session) ? ['--resume', session] : ['--session-id', session]),
    ];

    const log = join(dir, 'analyze.log');
    const from = sizeOf(log);
    const res = await t.zen(
        [
            ...continuing(),
            '--prompt-file',
            brief,
            '/analyze',
            run.dir,
            `case=${c.id}`,
            `rev=${c.rev}`,
            `phase=${phase}`,
            `attempt=${attempt}`,
            `feedback=${file}`,
            ...(run.missedSkills?.length ? [`missed-skills=${run.missedSkills.join(',')}`] : []),
        ],
        log,
    );
    keepAnalysis(dir, res.stdout);
    // `zen meta run` starts a new session when the meta model changed since this one; follow it.
    const started = sessionIn(res.stdout);
    if (started && started !== session) {
        session = started;
        writeFileSync(join(dir, 'session'), `${session}\n`);
    }

    const rubricIds = c.rubric.map((r) => r.id);
    let read = readFeedback(file, known, rubricIds);
    // An agent that exited on an error would only meet it again; one that wrote a bad file can fix it.
    if (!('feedback' in read) && res.code === 0) {
        const again = await t.zen(
            [
                ...continuing(),
                `The feedback file ${file} is ${read.problem}. Write it again exactly as section 7 of the zen-analyze-run skill describes, then stop.`,
            ],
            log,
        );
        keepAnalysis(dir, again.stdout, false);
        read = readFeedback(file, known, rubricIds);
    }
    // Any apply that overlapped this analysis owns the change; undoing it would gut the apply.
    const overlapped = t.improvements.applying || t.improvements.started !== applies;
    if (t.system.hash() !== hash && !overlapped) {
        t.system.restore(t.system.version());
        t.event({
            what: 'analyze edited the system - undone',
            worker: s.worker?.slot,
            case: c.id,
            phase,
            attempt,
        });
    }
    if (!('feedback' in read)) {
        const e = errorIn(log, from);
        throw new StepError(
            `analysis wrote no usable feedback (${read.problem})${e.message ? `: ${e.message}` : ''}`,
            e.log,
        );
    }
    note(t, c, read.feedback, run, session);
    return read.feedback;
}

function sessionIn(stdout: string): string | undefined {
    try {
        const id = (JSON.parse(stdout) as { sessionId?: unknown }).sessionId;
        return typeof id === 'string' && id ? id : undefined;
    } catch {
        return undefined;
    }
}

/** The meta agent's answer is the human report: kept as analysis.md beside the feedback. A retry keeps its own envelope, so its tokens are counted too. */
export function keepAnalysis(dir: string, stdout: string, replace = true): void {
    let envelope: { answerFile?: string } | undefined;
    try {
        envelope = JSON.parse(stdout) as { answerFile?: string };
    } catch {
        return;
    }
    writeFileSync(join(dir, replace ? 'analyze.json' : 'analyze-2.json'), stdout);
    if (
        envelope.answerFile &&
        existsSync(envelope.answerFile) &&
        (replace || !existsSync(join(dir, 'analysis.md')))
    ) {
        copyFileSync(envelope.answerFile, join(dir, 'analysis.md'));
    }
}

function note(t: Tuning, c: Case, f: Feedback, run: Run, session: string): void {
    const ids = new Set(c.rubric.map((r) => r.id));
    const rubric = Object.fromEntries(Object.entries(f.rubric).filter(([id]) => ids.has(id)));
    DatasetStore.open(t.root).note(c.id, {
        type: 'note',
        at: new Date().toISOString(),
        kind: 'graded',
        caseRev: c.rev,
        run: run.dir,
        verdict: f.verdict,
        ...(Object.keys(rubric).length > 0 ? { rubric } : {}),
        text: f.verdict === 'void' ? `void: ${f.infra}` : lead(f.summary) || f.verdict,
        by: { session, prompt: 'analyze', host: hostname() },
    });
}

// ---------------------------------------------------------------------------
// The end of a case
// ---------------------------------------------------------------------------

function finish(t: Tuning, c: Case, result: Omit<Result, 'caseRev' | 'at'>): void {
    const full: Result = {
        ...result,
        caseRev: c.rev,
        at: new Date().toISOString(),
        tokens: caseTokens(t, c),
    };
    mkdirSync(t.caseDir(c), { recursive: true });
    writeFileSync(join(t.caseDir(c), 'result.json'), `${JSON.stringify(full, null, 2)}\n`);
    t.event({
        what: result.state,
        case: c.id,
        rev: c.rev,
        phase: result.phase,
        detail: result.reason,
    });
    writeFeedback(t, c);
}

export function markCompleted(t: Tuning, c: Case): void {
    finish(t, c, { state: 'completed', phase: 'mem' });
}

export function markDifficult(t: Tuning, c: Case, phase: Phase, reason: string): void {
    finish(t, c, { state: 'difficult', phase, reason });
    DatasetStore.open(t.root).note(c.id, {
        type: 'note',
        at: new Date().toISOString(),
        kind: 'difficult',
        caseRev: c.rev,
        text: `${phase === 'nomem' ? 'without memory' : 'with memory'}: ${reason}`,
        by: { prompt: 'finetune', host: hostname() },
    });
}

/** Something outside the prose broke. The case keeps its tries and runs again at the next start. */
export function markFailed(t: Tuning, c: Case, phase: Phase, reason: string): void {
    finish(t, c, { state: 'failed', phase, reason });
}
