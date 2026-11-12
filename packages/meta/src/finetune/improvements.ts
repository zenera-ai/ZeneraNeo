import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { writeApplyBrief } from './apply-brief.ts';
import { type Cost, costChanges, type Gate, limits, measure, overLimits } from './cost.ts';
import { errorIn, sizeOf } from './failure.ts';
import { type Feedback, forProse, type Improvement } from './feedback.ts';
import { patchFiles, writeApply } from './report.ts';
import type { Run } from './train.ts';
import { readJson, type Seat, Stopped, type Tuning } from './tuning.ts';
import { applyTokens, spent } from './usage.ts';

// ---------------------------------------------------------------------------
// The improvement queue
//
// A case that has feedback parks here until an apply has taken it, and gives its
// worker back meanwhile, so another case runs in its place. Applies are
// batched: one fires when `applyAt` cases are parked, or once nothing is running
// and no case is left to start - waiting longer would wait for nothing.
//
// An apply edits the prose runs read, so no run starts while one is pending and
// those already going are let finish first. Analyses carry on; what they find
// joins the next batch. A woken case takes a worker before any new case does.
// Each apply that changed the prose queues a few completed cases to run again
// on it - see recheck.ts - and what they find broken joins the queue too.
// ---------------------------------------------------------------------------

export interface AppliedFile {
    ids: string[];
    from: number;
    to: number;
    at: string;
    startedAt?: string;
    skipped?: boolean;
    /** why the edit was undone: it failed `zen check`, or went over a limit */
    discarded?: string;
    /** a consolidation, from before an apply tidied up after itself */
    kind?: 'consolidate';
    /** what the agents always read, before and after */
    bytes?: { before: number; after: number };
}

export interface Decision {
    decision?: string;
    note?: string;
    disposition?: string;
    /** the skill the improvement created or changed */
    skill?: string;
}

export type Decisions = Record<string, Record<string, Decision>>;

export interface Deferred {
    request: string;
    case: string;
    apply: string;
    improvement: Improvement;
    note?: string;
}

const pad = (n: number): string => String(n).padStart(3, '0');

const kept = (d: Decision | undefined): boolean =>
    d?.decision === 'applied' || d?.decision === 'merged';

const DECIDED = new Set(['applied', 'merged', 'rejected', 'deferred', 'structural']);

/** `<request> <improvement>` for each improvement of inputs.json that decisions.json gives no valid decision. */
export function undecided(dir: string): string[] {
    const inputs = readJson<Feedback[]>(join(dir, 'inputs.json')) ?? [];
    const decided = readJson<Decisions>(join(dir, 'decisions.json')) ?? {};
    return inputs.flatMap((f) =>
        forProse(f)
            .filter((i) => !DECIDED.has(decided[f.id]?.[i.id]?.decision ?? ''))
            .map((i) => `${f.id} ${i.id}`),
    );
}

export class Improvements {
    readonly #t: Tuning;
    readonly pending: Feedback[] = [];
    /** the batch an apply is working on */
    inApply: Feedback[] = [];
    readonly #applied = new Set<string>();
    /** cases parked right now */
    parked = 0;
    /** `zen run`s in flight */
    runs = 0;
    applying = false;
    /** the apply under way; `name` once it has a folder, before that it waits for runs */
    current:
        | {
              since: number;
              name?: string;
              dir?: string;
              requests?: number;
              /** which gate the edit is at; absent while it waits for runs */
              step?: 'edit' | 'check';
          }
        | undefined;
    /** applies started in this process */
    started = 0;
    /** applies finished in this process - an analysis spanning one may see edits */
    count = 0;

    constructor(t: Tuning) {
        this.#t = t;
        this.reload();
    }

    /** Re-reads which requests the applies took - a recovery may have removed one. */
    reload(): void {
        this.#applied.clear();
        for (const name of this.#names()) {
            for (const id of readJson<AppliedFile>(join(this.dir, name, 'applied.json'))?.ids ??
                []) {
                this.#applied.add(id);
            }
        }
    }

    get dir(): string {
        return join(this.#t.dir, 'applies');
    }

    #names(): string[] {
        try {
            return readdirSync(this.dir)
                .filter((n) => /^\d{3}$/.test(n))
                .sort();
        } catch {
            return [];
        }
    }

    isApplied(id: string): boolean {
        return this.#applied.has(id);
    }

    /**
     * Every apply's decisions, later ones over earlier, per improvement. An edit
     * that was undone kept nothing, so what it applied or merged reads `discarded`.
     */
    decisions(): Decisions {
        const all: Decisions = {};
        for (const a of this.applies()) {
            const undone = a.applied?.discarded;
            for (const [id, byImprovement] of Object.entries(
                readJson<Decisions>(join(a.dir, 'decisions.json')) ?? {},
            )) {
                for (const [i, d] of Object.entries(byImprovement ?? {})) {
                    (all[id] ??= {})[i] =
                        undone && kept(d)
                            ? {
                                  ...d,
                                  decision: 'discarded',
                                  note: `${d.note ?? ''} - undone: ${undone}`.trim(),
                              }
                            : d;
                }
            }
        }
        return all;
    }

    /** Improvements held back for want of a second case, and not taken up since. */
    deferred(): Deferred[] {
        const open = new Map<string, Deferred>();
        for (const a of this.applies()) {
            const inputs = new Map((a.inputs ?? []).map((f) => [f.id, f]));
            const undone = Boolean(a.applied?.discarded);
            for (const [id, byImprovement] of Object.entries(
                readJson<Decisions>(join(a.dir, 'decisions.json')) ?? {},
            )) {
                for (const [i, d] of Object.entries(byImprovement ?? {})) {
                    const key = `${id} ${i}`;
                    if (d?.decision === 'deferred') {
                        const improvement =
                            inputs.get(id)?.improvements.find((x) => x.id === i) ??
                            open.get(key)?.improvement;
                        if (improvement) {
                            open.set(key, {
                                request: id,
                                case:
                                    inputs.get(id)?.case ?? open.get(key)?.case ?? id.split('@')[0],
                                apply: a.name,
                                improvement,
                                ...(d.note ? { note: d.note } : {}),
                            });
                        }
                    } else if (!undone) {
                        open.delete(key);
                    }
                }
            }
        }
        return [...open.values()];
    }

    /** The skills an apply made or changed for this request: the case's next run should load them. */
    skillsFor(id: string): string[] {
        const mine = this.decisions()[id] ?? {};
        return [
            ...new Set(
                Object.values(mine)
                    .filter((d) => kept(d) && d.skill)
                    .map((d) => d.skill!),
            ),
        ];
    }

    /** Nothing of this request was applied, merged or deferred, and some of it is structural: prose cannot fix it. */
    #structural(id: string): string | undefined {
        const mine = Object.values(this.decisions()[id] ?? {});
        const structural = mine.filter((d) => d.decision === 'structural');
        if (
            structural.length === 0 ||
            mine.some((d) => kept(d) || d.decision === 'deferred' || d.decision === 'discarded')
        ) {
            return undefined;
        }
        return structural.map((d) => d.note || 'structural').join('; ');
    }

    /**
     * Parks until an apply has taken this feedback, the worker free meanwhile. Taken already - after a restart - returns at once.
     * `structural` when the apply found nothing prose can fix.
     */
    async apply(feedback: Feedback, s: Seat): Promise<{ structural?: string }> {
        if (this.#applied.has(feedback.id)) {
            return this.#outcome(feedback.id);
        }
        if (!this.pending.some((f) => f.id === feedback.id)) {
            this.pending.push(feedback);
        }
        this.parked++;
        this.#t.event({
            what: 'parked',
            worker: s.worker?.slot,
            case: feedback.case,
            phase: feedback.phase,
            attempt: feedback.attempt,
            detail: `${forProse(feedback).length} improvement(s), worker freed`,
        });
        this.#t.unseat(s);
        try {
            while (!this.#applied.has(feedback.id)) {
                if (this.#t.stopping) {
                    throw new Stopped();
                }
                await this.#t.tick();
            }
        } finally {
            this.parked--;
        }
        const outcome = this.#outcome(feedback.id);
        if (outcome.structural) {
            return outcome;
        }
        await this.#t.seat(s, true);
        return outcome;
    }

    #outcome(id: string): { structural?: string } {
        const structural = this.#structural(id);
        return structural ? { structural } : {};
    }

    /** A recheck's request: queued like a parked case's, with no case waiting on it. */
    regressed(feedback: Feedback): void {
        if (
            !this.#applied.has(feedback.id) &&
            !this.pending.some((f) => f.id === feedback.id) &&
            !this.inApply.some((f) => f.id === feedback.id)
        ) {
            this.pending.push(feedback);
        }
    }

    /** Before a run starts: wait out an apply, or stop. */
    async notApplying(): Promise<void> {
        while (this.applying) {
            this.#t.checkStopping();
            await this.#t.tick();
        }
        this.#t.checkStopping();
    }

    /** The applier: runs until the tuning is finished. */
    async loop(): Promise<void> {
        while (!this.#t.finished) {
            await this.#t.tick();
            if (this.#t.stopping) {
                continue;
            }
            if (this.pending.length === 0) {
                continue;
            }
            if (
                this.pending.length < this.#t.config.applyAt &&
                (this.#t.busy() > 0 || !this.#t.drained)
            ) {
                continue;
            }
            try {
                await this.#applyNow();
            } catch (err) {
                this.#t.fatal = err as Error;
                this.#t.stop(`apply failed: ${(err as Error).message}`);
            }
        }
    }

    /** What the agents read when the tuning began - its first version, even for a tuning begun before this was kept. */
    async baseline(): Promise<Cost> {
        const file = join(this.#t.dir, 'baseline.json');
        const saved = readJson<{ cost: Cost }>(file)?.cost;
        if (saved) {
            return saved;
        }
        const first = this.#t.system.rows()[0];
        const at = first ? this.#t.system.snapshotDir(first.v) : undefined;
        const cost = await measure(at && existsSync(at) ? at : this.#t.root);
        mkdirSync(this.#t.dir, { recursive: true });
        writeFileSync(
            file,
            `${JSON.stringify({ at: new Date().toISOString(), version: first?.v ?? 0, cost }, null, 2)}\n`,
        );
        return cost;
    }

    async #applyNow(): Promise<void> {
        const t = this.#t;
        this.applying = true;
        this.current = { since: Date.now() };
        this.started++;
        t.event({ what: 'apply waiting', detail: `${this.runs} run(s) to finish` });
        try {
            while (this.runs > 0) {
                await t.tick();
            }
            const batch = this.pending.splice(0);
            this.inApply = batch;
            const name = pad(Math.max(0, ...this.#names().map(Number)) + 1);
            const dir = join(this.dir, name);
            const from = t.system.record('external').v;
            await t.journal.step({ kind: 'apply', dir, from }, () =>
                this.#applyBatch(batch, name, dir, from),
            );
        } finally {
            this.applying = false;
            this.current = undefined;
            this.inApply = [];
        }
    }

    async #applyBatch(batch: Feedback[], name: string, dir: string, from: number): Promise<void> {
        const t = this.#t;
        const startedAt = new Date().toISOString();
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, 'inputs.json'),
            `${JSON.stringify(
                batch.map((f) => {
                    const at =
                        f.dir ?? t.attemptDir({ id: f.case, rev: f.caseRev }, f.phase, f.attempt);
                    const missed = readJson<Run>(join(at, 'run.json'))?.missedSkills;
                    const { dir: _, ...rest } = f;
                    return {
                        ...rest,
                        improvements: forProse(f),
                        file: join(at, 'feedback.json'),
                        ...(missed?.length ? { missedSkills: missed } : {}),
                    };
                }),
                null,
                2,
            )}\n`,
        );
        writeFileSync(join(dir, 'deferred.json'), `${JSON.stringify(this.deferred(), null, 2)}\n`);
        const total = batch.reduce((n, f) => n + forProse(f).length, 0);
        this.current = { since: Date.now(), name, dir, requests: batch.length };
        let to = from;
        let discarded: string | undefined;
        let bytes: AppliedFile['bytes'];
        if (total > 0) {
            t.event({
                what: 'apply',
                detail: `${name}: ${batch.length} request(s), ${total} improvement(s)`,
            });
            writeApply(t, dir);
            try {
                const done = await this.#edit(dir, from);
                bytes = done.bytes;
                if ('discarded' in done) {
                    discarded = done.discarded;
                } else {
                    to = done.to;
                }
            } catch (err) {
                writeFileSync(
                    join(dir, 'failed.json'),
                    `${JSON.stringify({ at: new Date().toISOString(), startedAt, error: (err as Error).message }, null, 2)}\n`,
                );
                writeApply(t, dir);
                throw err;
            }
        }
        const applied: AppliedFile = {
            ids: batch.map((f) => f.id),
            from,
            to,
            at: new Date().toISOString(),
            startedAt,
            ...(total === 0 ? { skipped: true } : {}),
            ...(discarded ? { discarded } : {}),
            ...(bytes ? { bytes } : {}),
        };
        writeFileSync(join(dir, 'applied.json'), `${JSON.stringify(applied, null, 2)}\n`);
        writeApply(t, dir);
        for (const f of batch) {
            this.#applied.add(f.id);
        }
        this.count++;
        this.current = undefined;
        t.event({
            what: discarded ? 'apply undone' : 'applied',
            detail: `${name}: ${discarded ? `undone - ${discarded}` : `v${from} -> v${to}`}, see applies/${name}/APPLY.md`,
            result: total === 0 ? 'nothing to change' : discarded ? 'undone' : `v${from} → v${to}`,
            took: Date.now() - Date.parse(startedAt),
            tokens: spent(applyTokens(dir)),
        });
        if (!discarded && to !== from) {
            t.rechecks.queue(name);
        }
    }

    /** What an apply is handed about the prose: sizes, limits, and which files grew. */
    async #writeBudget(dir: string, now: Cost): Promise<void> {
        const start = await this.baseline();
        const { files: _, ...rest } = now;
        writeFileSync(
            join(dir, 'budget.json'),
            `${JSON.stringify(
                {
                    ...rest,
                    start: { total: start.total, alwaysRead: start.alwaysRead },
                    ...limits(start, this.#t.config),
                },
                null,
                2,
            )}\n`,
        );
        const touched = new Map<string, string[]>();
        for (const a of this.applies()) {
            if (!a.applied || a.applied.discarded || !existsSync(join(a.dir, 'diff.patch'))) {
                continue;
            }
            for (const f of patchFiles(readFileSync(join(a.dir, 'diff.patch'), 'utf8'))) {
                touched.set(f.file, [...(touched.get(f.file) ?? []), a.name]);
            }
        }
        const growth = Object.keys(now.files)
            .map((file) => ({
                file,
                start: start.files[file] ?? 0,
                now: now.files[file],
                changes: touched.get(file)?.length ?? 0,
                recent: (touched.get(file) ?? []).slice(-5),
            }))
            .sort((a, b) => b.now - b.start - (a.now - a.start));
        writeFileSync(join(dir, 'growth.json'), `${JSON.stringify(growth, null, 2)}\n`);
    }

    /**
     * The meta agent edits, then two gates: `zen check` and the budget. A failed
     * gate undoes the edit and the agent tries once more, told why. `zen check`
     * failing twice is fatal - the agent cannot leave the project loadable; the
     * budget failing twice only undoes it. What the edit broke elsewhere is the
     * rechecks' to find, after it.
     */
    async #edit(
        dir: string,
        from: number,
    ): Promise<
        ({ to: number } | { discarded: string }) & { bytes: { before: number; after: number } }
    > {
        const t = this.#t;
        const name = basename(dir);
        const before = await measure(t.root);
        await this.#writeBudget(dir, before);
        const bound = limits(await this.baseline(), t.config);
        const gate: Gate = { before, limits: bound };
        writeFileSync(join(dir, 'gate.json'), `${JSON.stringify(gate)}\n`);
        const unchanged = { before: before.total, after: before.total };
        const at = (step: 'edit' | 'check'): void => {
            if (this.current) {
                this.current.step = step;
            }
        };
        for (let attempt = 1; ; attempt++) {
            at('edit');
            const session = randomUUID();
            writeFileSync(join(dir, 'session'), `${session}\n`);
            const applyLog = join(dir, 'apply.log');
            const checkLog = join(dir, 'check.log');
            const offset = { apply: sizeOf(applyLog), check: sizeOf(checkLog) };
            // An undone attempt's record must not pass for this one's.
            for (const f of ['decisions.json', 'changes.md']) {
                rmSync(join(dir, f), { force: true });
            }
            const brief = await writeApplyBrief(t, dir, attempt);
            const res = await t.zen(
                [
                    'meta',
                    'run',
                    '--no-refresh',
                    '--json',
                    '--session-id',
                    session,
                    '--events',
                    join(dir, 'apply.events.jsonl'),
                    '--prompt-file',
                    brief,
                    '/zen-finetune-apply',
                    dir,
                ],
                applyLog,
            );
            writeFileSync(
                join(dir, attempt === 1 ? 'apply.json' : `apply-${attempt}.json`),
                res.stdout,
            );
            // An agent cut off by its provider can still exit 0, having decided nothing.
            const missing = res.code === 0 ? undecided(dir) : [];
            if (missing.length > 0) {
                writeFileSync(
                    join(dir, 'missing.md'),
                    [
                        `# Attempt ${attempt} was undone: decisions missing`,
                        '',
                        'Written by the tuning loop: the apply ended without a decision for these improvements, so the project was put back. This attempt must write `decisions.json` with every one of them, and `changes.md`.',
                        '',
                        ...missing.map((m) => `- ${m}`),
                        '',
                    ].join('\n'),
                );
                t.error(
                    `apply ${name}${attempt > 1 ? ` try ${attempt}` : ''}`,
                    `the apply ended without a decision for ${missing.length} improvement(s)`,
                    applyLog,
                );
                t.system.restore(from);
                if (attempt === 2) {
                    throw new Error(
                        `apply ${dir} ended twice without deciding every improvement - see missing.md`,
                    );
                }
                t.event({
                    what: 'apply retry',
                    detail: `no decision for ${missing.length} improvement(s)`,
                });
                continue;
            }
            at('check');
            const check = await t.zen(['check', '--no-models', '--no-sandbox'], checkLog);
            if (res.code !== 0 || check.code !== 0) {
                const e =
                    res.code !== 0
                        ? errorIn(applyLog, offset.apply)
                        : errorIn(checkLog, offset.check);
                t.error(
                    `apply ${name}${attempt > 1 ? ` try ${attempt}` : ''}`,
                    `${res.code !== 0 ? 'the apply failed' : 'zen check failed after the apply'}${e.message ? `: ${e.message}` : ''}`,
                    e.log,
                );
                t.system.restore(from);
                if (attempt === 2) {
                    throw new Error(`apply ${dir} left the project broken twice - see check.log`);
                }
                t.event({
                    what: 'apply retry',
                    detail: res.code !== 0 ? 'the apply failed' : 'zen check failed',
                });
                continue;
            }

            const after = await measure(t.root);
            const over = overLimits(before, after, bound);
            if (over.length > 0) {
                writeFileSync(
                    join(dir, 'budget.md'),
                    [
                        `# Attempt ${attempt} was undone: over the limits`,
                        '',
                        'Written by the tuning loop: this edit grew what the agents read past a limit, so the project was put back. The next attempt reads this file to know what to cut.',
                        '',
                        ...over.map((o) => `- ${o}`),
                        '',
                        '## What moved',
                        '',
                        ...costChanges(before, after),
                        '',
                    ].join('\n'),
                );
                t.system.restore(from);
                if (attempt === 2) {
                    return { discarded: `over the limits: ${over[0]}`, bytes: unchanged };
                }
                t.event({ what: 'apply retry', detail: `over the limits: ${over[0]}` });
                continue;
            }

            const to = t.system.record('apply', name).v;
            if (to === from) {
                return { to, bytes: unchanged };
            }
            writeFileSync(join(dir, 'diff.patch'), t.system.diff(from, to));
            const moved = costChanges(before, after);
            writeFileSync(
                join(dir, 'cost.md'),
                [
                    '# What moved',
                    '',
                    'Written by the tuning loop once this apply passed its gates: bytes before and after it - what each agent reads on every call, each skill body, each file under agents/.',
                    '',
                    ...(moved.length > 0 ? moved : ['Nothing the agents read changed size.']),
                    '',
                ].join('\n'),
            );
            return { to, bytes: { before: before.total, after: after.total } };
        }
    }

    /** Requests every apply so far took, for the report. */
    applies(): { name: string; dir: string; applied?: AppliedFile; inputs?: Feedback[] }[] {
        return this.#names().map((name) => {
            const dir = join(this.dir, name);
            return {
                name,
                dir,
                applied: readJson<AppliedFile>(join(dir, 'applied.json')),
                inputs: existsSync(join(dir, 'inputs.json'))
                    ? readJson<Feedback[]>(join(dir, 'inputs.json'))
                    : undefined,
            };
        });
    }
}
