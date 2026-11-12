import { type ChildProcess, spawn } from 'node:child_process';
import {
    appendFileSync,
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { CliError, EXIT } from '../host.ts';
import { forget, remember } from './children.ts';
import type { Case } from './dataset/types.ts';
import type { Phase } from './feedback.ts';
import { Improvements } from './improvements.ts';
import { Journal } from './journal.ts';
import type { Snapshot } from './live.ts';
import { Memories } from './memories.ts';
import { Rechecks } from './recheck.ts';
import { writeStatus } from './report.ts';
import { SystemVersions } from './system.ts';
import type { ByStage } from './usage.ts';

// ---------------------------------------------------------------------------
// One tuning, in progress
//
// Everything the workers and the applier share: where things go, the settings,
// how `zen` is run, and what each worker is doing right now. Each case's own
// progress is not held here - it is on disk, one folder per attempt.
// ---------------------------------------------------------------------------

export const FINETUNE_DIR = 'finetune';

/** Where a tuning was kept before it moved to {@link FINETUNE_DIR}. */
export const LEGACY_FINETUNE_DIR = '.finetune';

export interface Config {
    workers: number;
    /** apply once this many requests are waiting */
    applyAt: number;
    tries: number;
    memTries: number;
    /** merge the submitted memories after this many more arrive */
    mergeEvery: number;
    seed: number;
    /** completed cases run again after each apply, to catch what it broke */
    recheck: number;
    /** bytes one apply may add to what the agents always read */
    budget: number;
    /** percent over the start past which an apply may add nothing */
    maxGrowth: number;
    /** bytes one on-demand skill may hold */
    skillCap: number;
    /** skills one agent may see */
    maxSkills: number;
    classes?: string[];
    ids?: string[];
    rubric?: boolean;
    limit?: number;
}

export const DEFAULTS: Config = {
    workers: 4,
    applyAt: 4,
    tries: 4,
    memTries: 3,
    mergeEvery: 3,
    seed: 1,
    recheck: 3,
    budget: 1500,
    maxGrowth: 50,
    skillCap: 12_000,
    maxSkills: 10,
};

export type Step = 'idle' | 'run' | 'analyze' | 'parked';

export interface Worker {
    slot: number;
    case?: Case;
    phase?: Phase;
    attempt?: number;
    step: Step;
    since: number;
    /** a recheck: the apply whose version it runs on, and the try's folder */
    recheck?: { apply: string; dir: string };
}

/** A case in flight. It holds a worker only while it runs or is analyzed; parked, it holds none. */
export interface Seat {
    case: Case;
    worker?: Worker;
    phase?: Phase;
}

/** Runs `zen <args>` in the project, stderr into `log`; stdout is returned. */
export type Zen = (args: string[], log: string) => Promise<{ code: number; stdout: string }>;

export class Stopped extends Error {
    constructor() {
        super('stopped');
    }
}

export interface Event {
    at: string;
    what: string;
    worker?: number;
    case?: string;
    rev?: number;
    phase?: Phase;
    attempt?: number;
    detail?: string;
    /** a step that ended: what it came to, how long it took, what it spent */
    result?: string;
    took?: number;
    tokens?: number;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Failed cases in a row, with nothing going through between, that stop the loop. */
export const FAILURES_IN_A_ROW = 3;

export interface StepFailure {
    at: string;
    /** `merge-20 · no memory try 1`, `apply 004`, `memory m03` */
    where: string;
    message: string;
    log?: string;
}

export class Tuning {
    readonly root: string;
    readonly dir: string;
    readonly config: Config;
    readonly zen: Zen;
    readonly tickMs: number;
    readonly workers: Worker[];
    readonly claimed = new Set<string>();
    readonly startedAt = Date.now();
    readonly recent: Event[] = [];
    readonly system: SystemVersions;
    readonly journal: Journal;
    readonly improvements: Improvements;
    readonly rechecks: Rechecks;
    readonly memories: Memories;
    stopping = false;
    finished = false;
    fatal: Error | undefined;
    /** woken cases waiting for a worker: they go before any new case */
    resuming = 0;
    /** every case of the selection has been started */
    drained = false;
    /** cases started by this process: a failed one is not taken twice in one start */
    readonly tried = new Set<string>();
    /** `--more`: cases of any kind this start may take; not kept in loop.json */
    more: number | undefined;
    /** cases failed since the last step that went through */
    failures = 0;
    /** what the last status page counted */
    progress: { counts: Record<string, number>; total: number; spent: ByStage } | undefined;
    /** called with every live snapshot */
    readonly watchers = new Set<(s: Snapshot) => void>();
    /** the latest live snapshot */
    live: Snapshot | undefined;
    /** the latest step failures, newest first */
    readonly errors: StepFailure[] = [];

    constructor(root: string, config: Config, zen: Zen, tickMs = 1000) {
        this.root = root;
        this.dir = join(root, FINETUNE_DIR);
        this.config = config;
        this.zen = zen;
        this.tickMs = tickMs;
        this.workers = Array.from({ length: config.workers }, (_, slot) => ({
            slot: slot + 1,
            step: 'idle' as Step,
            since: Date.now(),
        }));
        this.system = new SystemVersions(root, join(this.dir, 'systems'));
        this.journal = new Journal(join(this.dir, 'journal.jsonl'));
        this.improvements = new Improvements(this);
        this.rechecks = new Rechecks(this);
        this.memories = new Memories(this);
    }

    get stopFile(): string {
        return join(this.dir, 'stop');
    }

    async tick(): Promise<void> {
        await sleep(this.tickMs);
        if (!this.stopping && existsSync(this.stopFile)) {
            this.stop('stop requested');
        }
    }

    stop(why: string): void {
        if (!this.stopping) {
            this.stopping = true;
            this.event({ what: 'stopping', detail: why });
        }
    }

    /** Between steps: a stop takes effect here, never in the middle of one. */
    checkStopping(): void {
        if (this.stopping) {
            throw new Stopped();
        }
    }

    caseDir(c: { id: string; rev: number }): string {
        return join(this.dir, 'cases', c.id, `r${c.rev}`);
    }

    /** Where `retry` puts a case's earlier rounds: `r<rev>.<round>`. */
    roundsDir(c: { id: string }): string {
        return join(this.dir, 'cases', c.id, 'rounds');
    }

    /** 1 for a case never retried at this revision. */
    round(c: { id: string; rev: number }): number {
        try {
            return (
                readdirSync(this.roundsDir(c)).filter((n) => n.startsWith(`r${c.rev}.`)).length + 1
            );
        } catch {
            return 1;
        }
    }

    /** A step went through: the sandbox and the providers are up. */
    succeeded(): void {
        this.failures = 0;
    }

    /** A case failed for a reason outside the prose. Enough in a row means nothing will go through. */
    failed(why: string): void {
        this.failures++;
        if (this.failures >= FAILURES_IN_A_ROW && !this.stopping) {
            this.fatal = new CliError(
                `${this.failures} cases failed in a row - the last: ${why}`,
                EXIT.failed,
                'fix what broke (the sandbox, a provider, a key), then start again: failed cases carry on where they stopped',
            );
            this.stop(`${this.failures} cases failed in a row`);
        }
    }

    /** No run goes through without the container engine: stop at the first sign, not the third. */
    sandboxDown(why: string): void {
        this.fatal ??= new CliError(
            `the sandbox failed: ${why}`,
            EXIT.sandbox,
            'see what the engine says: zen sandbox status - fix it, then start again: failed cases carry on where they stopped',
        );
        this.stop('the sandbox failed');
    }

    attemptDir(c: { id: string; rev: number }, phase: Phase, attempt: number): string {
        return join(this.caseDir(c), `${pad(attempt)}-${phase}`);
    }

    /** The folder of the try a worker is on: the case's own, or a recheck's. */
    workDir(w: Worker & { case: Case }): string {
        return w.recheck?.dir ?? this.attemptDir(w.case, w.phase ?? 'nomem', w.attempt ?? 1);
    }

    /** What the loop knows of a try, which a feedback file is never trusted for. */
    known(c: { id: string; rev: number }, phase: Phase, attempt: number) {
        const round = this.round(c);
        return { case: c.id, caseRev: c.rev, ...(round > 1 ? { round } : {}), phase, attempt };
    }

    freeWorker(): Worker | undefined {
        return this.workers.find((w) => !w.case);
    }

    busy(): number {
        return this.workers.filter((w) => w.case).length;
    }

    /** Puts a case on a free worker, waiting for one; a woken case goes before a new one. */
    async seat(s: Seat, woken: boolean): Promise<void> {
        if (woken) {
            this.resuming++;
        }
        try {
            for (;;) {
                const w = this.freeWorker();
                if (w && (woken || this.resuming === 0)) {
                    Object.assign(w, {
                        case: s.case,
                        phase: undefined,
                        attempt: undefined,
                        recheck: undefined,
                        step: 'idle',
                        since: Date.now(),
                    });
                    s.worker = w;
                    return;
                }
                this.checkStopping();
                await this.tick();
            }
        } finally {
            if (woken) {
                this.resuming--;
            }
        }
    }

    /** Gives the case's worker back, for another case to use. */
    unseat(s: Seat): void {
        if (!s.worker) {
            return;
        }
        Object.assign(s.worker, {
            case: undefined,
            phase: undefined,
            attempt: undefined,
            recheck: undefined,
            step: 'idle',
            since: Date.now(),
        });
        s.worker = undefined;
    }

    /** A case moved to another step on its worker. */
    at(s: Seat, phase: Phase, attempt: number, step: Step): void {
        const w = s.worker!;
        s.phase = phase;
        Object.assign(w, { case: s.case, phase, attempt, step, since: Date.now() });
        this.event({
            what: step,
            worker: w.slot,
            case: s.case.id,
            rev: s.case.rev,
            phase,
            attempt,
        });
    }

    /** A step ended: the worker is between steps until the next `at`, and the event says how it went. */
    ended(s: Seat, e: Omit<Event, 'at' | 'worker' | 'case' | 'rev'>): void {
        if (s.worker) {
            Object.assign(s.worker, { step: 'idle', since: Date.now() });
        }
        this.event({ worker: s.worker?.slot, case: s.case.id, rev: s.case.rev, ...e });
    }

    /** A step failed: kept for the live view, and in events.jsonl with its log. */
    error(where: string, message: string, log?: string): void {
        this.errors.unshift({
            at: new Date().toISOString(),
            where,
            message,
            ...(log ? { log } : {}),
        });
        this.errors.length = Math.min(this.errors.length, 20);
        this.event({ what: 'error', detail: `${where}: ${message}${log ? ` - see ${log}` : ''}` });
    }

    event(e: Omit<Event, 'at'>): void {
        const row: Event = { at: new Date().toISOString(), ...e };
        mkdirSync(this.dir, { recursive: true });
        appendFileSync(join(this.dir, 'events.jsonl'), `${JSON.stringify(row)}\n`);
        this.recent.unshift(row);
        this.recent.length = Math.min(this.recent.length, 50);
        this.report();
    }

    /** `live`: only what moves by the second is read again; the rest comes from the last full report. */
    report(live = false): void {
        try {
            writeStatus(this, live);
        } catch {
            // A status page that failed to render must not stop the tuning.
        }
    }
}

/** The real `zen`: this same binary, in its own process group so Ctrl-C reaches only us. */
export function spawnZen(root: string, children: Set<ChildProcess>): Zen {
    return (args, log) =>
        new Promise((resolve) => {
            mkdirSync(dirname(log), { recursive: true });
            const fd = openSync(log, 'a');
            const child = spawn(process.execPath, [process.argv[1], ...args], {
                cwd: root,
                stdio: ['ignore', 'pipe', fd],
                detached: true,
            });
            children.add(child);
            const dir = join(root, FINETUNE_DIR);
            if (child.pid !== undefined) {
                remember(dir, child.pid, process.argv[1]);
            }
            let stdout = '';
            child.stdout?.on('data', (chunk: Buffer) => {
                stdout += chunk.toString('utf8');
            });
            let finished = false;
            const done = (code: number): void => {
                if (finished) {
                    return;
                }
                finished = true;
                children.delete(child);
                if (child.pid !== undefined) {
                    forget(dir, child.pid);
                }
                closeSync(fd);
                resolve({ code, stdout });
            };
            child.on('error', () => done(1));
            child.on('close', (code) => done(code ?? 1));
        });
}

export function readJson<T>(file: string): T | undefined {
    try {
        return JSON.parse(readFileSync(file, 'utf8')) as T;
    } catch {
        return undefined;
    }
}
