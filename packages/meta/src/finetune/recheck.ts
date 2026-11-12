import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeAnalyzeBrief } from './analyze-brief.ts';
import type { Case } from './dataset/types.ts';
import { type Feedback, readFeedback } from './feedback.ts';
import { writeApply } from './report.ts';
import { resultOf, selection } from './sampler.ts';
import { keepAnalysis, type Run, runOnce } from './train.ts';
import { readJson, type Seat, type Tuning } from './tuning.ts';
import { type ByStage, envelopesIn, mergeStages, spent } from './usage.ts';

// ---------------------------------------------------------------------------
// Rechecks: cases that passed, run again on a new version
//
// An apply is written for the cases that asked for it; what it may have broken
// is everything else. After each apply that changed the prose, a few completed
// cases are queued to run again without memory - ordinary work on a worker, so
// nothing waits for them. A case that fails both its tries has regressed: its
// feedback joins the improvement queue like any other, and the next apply
// repairs what the last one broke. Nothing is undone.
// ---------------------------------------------------------------------------

export interface Recheck {
    case: string;
    rev: number;
    /** the apply whose version it runs on */
    apply: string;
    state: 'queued' | 'running' | 'passed' | 'regressed' | 'void';
    at: string;
    /** each try's verdict */
    tries?: string[];
    /** the request a regression sent to the improvement queue */
    request?: string;
    /** why it was void, or why a regression sent no request */
    note?: string;
}

/** A case regresses only when every one of these fails: one failure may be the model's noise. */
export const RECHECK_TRIES = 2;

/** Requests one case's regressions may send; past that it is reported, so the tuning ends. */
const REQUESTS_PER_CASE = 2;

const pad = (n: number): string => String(n).padStart(2, '0');

export class Rechecks {
    readonly #t: Tuning;

    constructor(t: Tuning) {
        this.#t = t;
    }

    get file(): string {
        return join(this.#t.dir, 'rechecks.json');
    }

    all(): Recheck[] {
        return readJson<Recheck[]>(this.file) ?? [];
    }

    #save(all: Recheck[]): void {
        mkdirSync(this.#t.dir, { recursive: true });
        writeFileSync(this.file, `${JSON.stringify(all, null, 2)}\n`);
    }

    #update(r: Recheck, change: Partial<Recheck>): void {
        const all = this.all();
        const i = all.findIndex((x) => x.case === r.case && x.apply === r.apply);
        Object.assign(r, change, { at: new Date().toISOString() });
        if (i >= 0) {
            all[i] = r;
            this.#save(all);
        }
        if (change.state && change.state !== 'running') {
            this.#page(r.apply);
        }
    }

    /** The apply's page lists its rechecks; it was written before they ran. */
    #page(apply: string): void {
        try {
            writeApply(this.#t, join(this.#t.improvements.dir, apply));
        } catch {
            // A page that failed to render must not stop the tuning.
        }
    }

    dir(r: { case: string; apply: string }): string {
        return join(this.#t.dir, 'rechecks', r.apply, r.case);
    }

    /** Each try's folder, oldest first. */
    tryDirs(r: { case: string; apply: string }): string[] {
        try {
            return readdirSync(this.dir(r))
                .filter((n) => /^\d{2}-nomem$/.test(n))
                .sort()
                .map((n) => join(this.dir(r), n));
        } catch {
            return [];
        }
    }

    waiting(): number {
        return this.all().filter((r) => r.state === 'queued' || r.state === 'running').length;
    }

    /**
     * After a stop: a recheck cut off part-way runs again, and a regression's request
     * - kept only in memory until an apply takes it - goes back in the queue.
     */
    resume(): void {
        const all = this.all();
        let changed = false;
        for (const r of all) {
            if (r.state === 'running') {
                r.state = 'queued';
                changed = true;
            }
            if (
                r.state === 'regressed' &&
                r.request &&
                !this.#t.improvements.isApplied(r.request)
            ) {
                const f = this.#feedback(r);
                if (f) {
                    this.#t.improvements.regressed(f);
                }
            }
        }
        if (changed) {
            this.#save(all);
        }
    }

    /**
     * Queues completed cases to run on the version `apply` made: a case whose
     * last recheck regressed first - this apply was meant to repair it - then
     * the rest in an order fixed by the seed and the apply.
     */
    queue(apply: string): Recheck[] {
        const t = this.#t;
        if (t.config.recheck === 0) {
            return [];
        }
        const all = this.all();
        const open = new Set(
            all.filter((r) => r.state === 'queued' || r.state === 'running').map((r) => r.case),
        );
        const last = new Map(all.map((r) => [r.case, r]));
        const key = (id: string): string =>
            createHash('sha256').update(`${t.config.seed}:${apply}:${id}`).digest('hex');
        const rank = (id: string): number => (last.get(id)?.state === 'regressed' ? 0 : 1);
        const at = new Date().toISOString();
        const picked: Recheck[] = selection(t)
            .filter((c) => !open.has(c.id) && resultOf(t, c)?.state === 'completed')
            .sort((a, b) => rank(a.id) - rank(b.id) || key(a.id).localeCompare(key(b.id)))
            .slice(0, t.config.recheck)
            .map((c) => ({ case: c.id, rev: c.rev, apply, state: 'queued', at }));
        if (picked.length > 0) {
            this.#save([...all, ...picked]);
            this.#page(apply);
            t.event({
                what: 'recheck',
                detail: `${apply}: ${picked.map((r) => r.case).join(', ')} queued to run again on the edit`,
            });
        }
        return picked;
    }

    /** The next queued recheck, marked running, with its case; one whose case changed is dropped. */
    take(): { recheck: Recheck; case: Case } | undefined {
        const t = this.#t;
        for (;;) {
            const r = this.all().find((x) => x.state === 'queued' && !t.claimed.has(x.case));
            if (!r) {
                return undefined;
            }
            const c = selection(t).find((x) => x.id === r.case);
            if (!c || c.rev !== r.rev || resultOf(t, c)?.state !== 'completed') {
                this.#update(r, { state: 'void', note: 'the case changed since it was queued' });
                continue;
            }
            this.#update(r, { state: 'running' });
            return { recheck: r, case: c };
        }
    }

    /** A step broke for a reason outside the prose: the recheck says nothing. */
    void(r: Recheck, why: string): void {
        this.#update(r, { state: 'void', note: why });
    }

    /** Runs a recheck on the seat's worker, to its verdict. */
    async run(s: Seat, r: Recheck, c: Case): Promise<void> {
        const t = this.#t;
        const tries: string[] = [];
        let last: Feedback | undefined;
        for (let n = 1; n <= RECHECK_TRIES; n++) {
            const dir = join(this.dir(r), `${pad(n)}-nomem`);
            const one = await this.#try(s, r, c, n, dir);
            tries.push(one.verdict);
            if (one.passed) {
                const state = one.verdict === 'right' ? 'passed' : 'void';
                this.#update(r, { state, tries, ...(one.note ? { note: one.note } : {}) });
                t.event({
                    what: `recheck ${state}`,
                    case: c.id,
                    rev: c.rev,
                    result: tries.join(', '),
                });
                return;
            }
            last = one.feedback;
        }
        const sent = this.all().filter((x) => x.case === c.id && x.request).length;
        if (last && sent < REQUESTS_PER_CASE) {
            const request = `${c.id}@recheck-${r.apply}`;
            const f: Feedback = {
                ...last,
                id: request,
                recheck: r.apply,
                dir: join(this.dir(r), `${pad(RECHECK_TRIES)}-nomem`),
            };
            this.#update(r, { state: 'regressed', tries, request });
            t.improvements.regressed(f);
        } else {
            this.#update(r, {
                state: 'regressed',
                tries,
                note: `${sent} request(s) sent for this case already - reported, not queued`,
            });
        }
        t.event({
            what: 'regressed',
            case: c.id,
            rev: c.rev,
            detail: `passed before ${r.apply}, failed ${RECHECK_TRIES} tries on it`,
            result: tries.join(', '),
        });
    }

    /** A void run or an unreadable analysis counts as a pass: only a graded failure is a regression. */
    async #try(
        s: Seat,
        r: Recheck,
        c: Case,
        n: number,
        dir: string,
    ): Promise<{ verdict: string; passed: boolean; note?: string; feedback?: Feedback }> {
        const t = this.#t;
        const w = s.worker!;
        mkdirSync(dir, { recursive: true });
        w.recheck = { apply: r.apply, dir };
        let why: string | undefined;
        if (!existsSync(join(dir, 'run.json'))) {
            await t.improvements.notApplying();
            t.at(s, 'nomem', n, 'run');
            t.improvements.runs++;
            const began = Date.now();
            try {
                why = await runOnce(t, c, dir);
            } finally {
                t.improvements.runs--;
            }
            const ran = why ? undefined : readJson<Run>(join(dir, 'run.json'));
            t.ended(s, {
                what: why ? 'void' : 'ran',
                phase: 'nomem',
                attempt: n,
                result: `recheck: ${why ?? `${ran?.turns ?? '?'} turns`}`,
                took: Date.now() - began,
                tokens: spent(ran?.tokens),
            });
        }
        if (why) {
            return { verdict: 'void', passed: true, note: why };
        }
        const run = readJson<Run>(join(dir, 'run.json'))!;
        const file = join(dir, 'feedback.json');
        const known = { case: c.id, caseRev: c.rev, phase: 'nomem' as const, attempt: n };
        const rubricIds = c.rubric.map((x) => x.id);
        let read = readFeedback(file, known, rubricIds);
        if (!('feedback' in read)) {
            t.checkStopping();
            t.at(s, 'nomem', n, 'analyze');
            const began = Date.now();
            const patch = join(t.improvements.dir, r.apply, 'diff.patch');
            const session = randomUUID();
            writeFileSync(join(dir, 'session'), `${session}\n`);
            const brief = await writeAnalyzeBrief(t, dir, {
                run,
                case: c,
                phase: 'nomem',
                attempt: n,
                earlier: [],
                recheck: patch,
            });
            const res = await t.zen(
                [
                    'meta',
                    'run',
                    '--no-refresh',
                    '--json',
                    '--events',
                    join(dir, 'analyze.events.jsonl'),
                    '--session-id',
                    session,
                    '--prompt-file',
                    brief,
                    '/analyze',
                    run.dir,
                    `case=${c.id}`,
                    `rev=${c.rev}`,
                    'phase=nomem',
                    `attempt=${n}`,
                    `feedback=${file}`,
                    `recheck=${patch}`,
                ],
                join(dir, 'analyze.log'),
            );
            keepAnalysis(dir, res.stdout);
            read = readFeedback(file, known, rubricIds);
            t.ended(s, {
                what: 'analyzed',
                phase: 'nomem',
                attempt: n,
                result: `recheck: ${'feedback' in read ? read.feedback.verdict : read.problem}`,
                took: Date.now() - began,
                tokens: spent(envelopesIn(dir, 'analyze')),
            });
        }
        if (!('feedback' in read)) {
            return { verdict: 'unread', passed: true, note: read.problem };
        }
        const f = read.feedback;
        if (f.verdict === 'void') {
            return { verdict: 'void', passed: true, note: f.infra };
        }
        const passed = f.verdict === 'right' && !Object.values(f.rubric).includes('fail');
        return { verdict: f.verdict, passed, feedback: f };
    }

    /** A regression's request, read back from its last try. */
    #feedback(r: Recheck): Feedback | undefined {
        const c = selection(this.#t).find((x) => x.id === r.case);
        const dir = join(this.dir(r), `${pad(RECHECK_TRIES)}-nomem`);
        const read = readFeedback(
            join(dir, 'feedback.json'),
            { case: r.case, caseRev: r.rev, phase: 'nomem', attempt: RECHECK_TRIES },
            c?.rubric.map((x) => x.id) ?? [],
        );
        return 'feedback' in read
            ? { ...read.feedback, id: r.request!, recheck: r.apply, dir }
            : undefined;
    }

    /** Every recheck run and analysis so far. */
    tokens(): ByStage {
        const parts: ByStage[] = [];
        for (const r of this.all()) {
            for (const dir of this.tryDirs(r)) {
                parts.push({
                    run: readJson<Run>(join(dir, 'run.json'))?.tokens,
                    analyze: envelopesIn(dir, 'analyze'),
                });
            }
        }
        return mergeStages(...parts);
    }
}
