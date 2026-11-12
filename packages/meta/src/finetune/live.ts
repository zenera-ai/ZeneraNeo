import {
    closeSync,
    fstatSync,
    mkdirSync,
    openSync,
    readSync,
    renameSync,
    writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import type { EventLine } from '../host.ts';
import type { Phase } from './feedback.ts';
import type { Event, StepFailure, Tuning } from './tuning.ts';
import { modelName, type Stage, STAGES, type Tokens } from './usage.ts';

// ---------------------------------------------------------------------------
// What is going on right now
//
// One snapshot of the tuning, taken every second: the steps under way with
// what their agent is doing, the tokens spent so far, and the steps that ended.
// The live view draws it and `finetune/live.json` keeps it for anyone else.
// Built from the loop's own state and the `--events` files its steps write,
// so it costs nothing the loop does not already do.
// ---------------------------------------------------------------------------

export type ModelSpend = Tokens;

/** One events file, folded as it grows. */
export interface Activity {
    model?: string;
    calls: number;
    input: number;
    output: number;
    byModel: Record<string, ModelSpend>;
    /** the latest tool call, with what was said just before it, or the latest thing said */
    last?: string;
    /** said since the last tool call */
    said?: string;
    /** what the agent is doing now: `says: …`, `thinks: …` or `runs: …` */
    now?: string;
    /** the last few `now` lines, oldest first */
    recent: string[];
    /** the latest lines, oldest first */
    lines: EventLine[];
}

export interface NowRow {
    /** stable across snapshots: `w1`, `apply`, `merge` */
    key: string;
    who: string;
    step: string;
    what: string;
    sinceMs: number;
    stage?: Stage;
    act?: Activity;
    /** what it is doing now, in one line */
    now?: string;
    /** the last few such lines, oldest first */
    recent?: string[];
}

export interface TokenRow extends ModelSpend {
    stage: Stage;
    model: string;
}

export interface LogRow {
    at: string;
    action: string;
    case: string;
    result: string;
    took?: number;
    tokens?: number;
}

export interface Snapshot {
    pid: number;
    project: string;
    state: 'running' | 'stopping' | 'stopped' | 'finished';
    at: string;
    elapsedMs: number;
    system: number;
    workers: { busy: number; all: number };
    total: number;
    counts: Record<string, number>;
    parked: number;
    applyAt: number;
    now: NowRow[];
    tokens: TokenRow[];
    log: LogRow[];
    /** the latest step failures, newest first */
    errors: StepFailure[];
}

const KEEP_LINES = 200;
const KEEP_LOG = 50;
const KEEP_ERRORS = 5;
const PHASE_WORD: Record<Phase, string> = { nomem: 'no memory', mem: 'with memory' };
/** Not log rows: a start shows in `now` and ends in an event of its own, an error has its own section. */
const UNLOGGED = new Set(['run', 'analyze', 'apply', 'memory merge', 'idle', 'error']);
/** Shell tools: their subject is the command itself. */
const SHELL = new Set(['bash', 'run_command', 'run_command_background']);
/** What the applier runs once the agent is done. */
export const CHECK_NOW = 'runs: zen check --no-models --no-sandbox';
/** `now` lines a step keeps. */
export const KEEP_NOW = 6;

const blank = (): Activity => ({
    calls: 0,
    input: 0,
    output: 0,
    byModel: {},
    recent: [],
    lines: [],
});

function doing(a: Activity, line: string): void {
    a.now = line;
    a.recent.push(line);
    if (a.recent.length > KEEP_NOW) {
        a.recent.shift();
    }
}

function fold(a: Activity, text: string): void {
    let e: EventLine;
    try {
        e = JSON.parse(text) as EventLine;
    } catch {
        return;
    }
    a.lines.push(e);
    if (a.lines.length > KEEP_LINES) {
        a.lines.shift();
    }
    if (e.type === 'llm') {
        const model = modelName(e.model);
        a.model = model;
        a.calls++;
        a.input += e.in;
        a.output += e.out;
        const m = (a.byModel[model] ??= { calls: 0, input: 0, cached: 0, output: 0, reasoning: 0 });
        m.calls++;
        m.input += e.in;
        m.cached += e.cached;
        m.output += e.out;
        m.reasoning += e.reasoning;
    } else if (e.type === 'tool' && e.phase === 'start') {
        const tool = `${e.name} ${e.subject}`.trim();
        a.last = a.said ? `${a.said} · ${tool}` : tool;
        a.said = undefined;
        doing(a, `runs: ${SHELL.has(e.name) && e.subject ? e.subject : tool}`);
    } else if (e.type === 'say' || e.type === 'think') {
        // A call's thought comes before what it said, so the words win.
        a.said = e.text;
        a.last = e.text;
        doing(a, `${e.type === 'say' ? 'says' : 'thinks'}: ${e.text}`);
    }
}

/** Reads only what each events file gained since the last look; a file cleared for a new step starts over. */
export class Tails {
    readonly #files = new Map<
        string,
        { ino: number; offset: number; rest: string; act: Activity }
    >();

    read(file: string): Activity {
        let fd: number;
        try {
            fd = openSync(file, 'r');
        } catch {
            this.#files.delete(file);
            return blank();
        }
        try {
            const st = fstatSync(fd);
            let f = this.#files.get(file);
            if (!f || f.ino !== st.ino || st.size < f.offset) {
                f = { ino: st.ino, offset: 0, rest: '', act: blank() };
                this.#files.set(file, f);
            }
            if (st.size > f.offset) {
                const buf = Buffer.alloc(st.size - f.offset);
                readSync(fd, buf, 0, buf.length, f.offset);
                f.offset = st.size;
                const parts = (f.rest + buf.toString('utf8')).split('\n');
                f.rest = parts.pop() ?? '';
                for (const line of parts) {
                    fold(f.act, line);
                }
            }
            return f.act;
        } finally {
            closeSync(fd);
        }
    }

    /** Forgets the files no step writes any more. */
    keep(files: ReadonlySet<string>): void {
        for (const file of this.#files.keys()) {
            if (!files.has(file)) {
                this.#files.delete(file);
            }
        }
    }
}

const tails = new WeakMap<Tuning, Tails>();

function stateOf(t: Tuning): Snapshot['state'] {
    if (t.finished) {
        return t.stopping ? 'stopped' : 'finished';
    }
    return t.stopping ? 'stopping' : 'running';
}

function logRow(e: Event): LogRow {
    const where = e.phase ? `${PHASE_WORD[e.phase]}${e.attempt ? ` try ${e.attempt}` : ''}` : '';
    return {
        at: e.at,
        action: e.what,
        case: [e.case, where].filter(Boolean).join(' · '),
        result: e.result ?? e.detail ?? '',
        ...(e.took !== undefined ? { took: e.took } : {}),
        ...(e.tokens ? { tokens: e.tokens } : {}),
    };
}

export function snapshot(t: Tuning): Snapshot {
    let tail = tails.get(t);
    if (!tail) {
        tail = new Tails();
        tails.set(t, tail);
    }
    const now: NowRow[] = [];
    const files = new Set<string>();
    const watch = (file: string): Activity => {
        files.add(file);
        return tail.read(file);
    };
    const clock = Date.now();
    for (const w of t.workers) {
        if (!w.case || (w.step !== 'run' && w.step !== 'analyze')) {
            continue;
        }
        const dir = t.workDir({ ...w, case: w.case });
        const act = watch(join(dir, w.step === 'run' ? 'events.jsonl' : 'analyze.events.jsonl'));
        now.push({
            key: `w${w.slot}`,
            who: `worker ${w.slot}`,
            step: w.step,
            what: `${w.case.id} · ${w.recheck ? 'recheck' : PHASE_WORD[w.phase ?? 'nomem']} try ${w.attempt ?? 1}`,
            sinceMs: clock - w.since,
            stage: w.step,
            act,
            ...(act.now ? { now: act.now, recent: [...act.recent] } : {}),
        });
    }
    const q = t.improvements;
    if (q.current?.dir) {
        const checking = q.current.step === 'check';
        const act = watch(join(q.current.dir, 'apply.events.jsonl'));
        const line = checking ? CHECK_NOW : act.now;
        const recent = checking ? [...act.recent, CHECK_NOW].slice(-KEEP_NOW) : [...act.recent];
        now.push({
            key: 'apply',
            who: 'applier',
            step: checking ? 'check' : 'apply',
            what: `apply ${basename(q.current.dir)} · ${q.current.requests} request(s)`,
            sinceMs: clock - q.current.since,
            stage: 'apply',
            act,
            ...(line ? { now: line, recent } : {}),
        });
    } else if (q.current) {
        now.push({
            key: 'apply',
            who: 'applier',
            step: 'waiting',
            what: `${q.pending.length} request(s), ${q.runs} run(s) to finish first`,
            sinceMs: clock - q.current.since,
        });
    }
    const merge = t.memories.merging;
    if (merge) {
        now.push({
            key: 'merge',
            who: 'memory',
            step: 'merge',
            what: merge.name,
            sinceMs: clock - merge.since,
        });
    }
    tail.keep(files);

    const sums = new Map<string, TokenRow>();
    const add = (stage: Stage, model: string, s: ModelSpend): void => {
        const key = `${stage}\u0000${model}`;
        const row = sums.get(key) ?? {
            stage,
            model,
            calls: 0,
            input: 0,
            cached: 0,
            output: 0,
            reasoning: 0,
        };
        row.calls += s.calls;
        row.input += s.input;
        row.cached += s.cached;
        row.output += s.output;
        row.reasoning += s.reasoning;
        sums.set(key, row);
    };
    for (const stage of STAGES) {
        for (const [model, s] of Object.entries(t.progress?.spent[stage] ?? {})) {
            add(stage, model, s);
        }
    }
    for (const row of now) {
        for (const [model, s] of Object.entries(row.act?.byModel ?? {})) {
            add(row.stage!, model, s);
        }
    }
    const tokens = [...sums.values()]
        .filter((r) => r.calls > 0)
        .sort(
            (a, b) =>
                STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage) ||
                b.input + b.output - (a.input + a.output),
        );

    return {
        pid: process.pid,
        project: basename(t.root),
        state: stateOf(t),
        at: new Date(clock).toISOString(),
        elapsedMs: clock - t.startedAt,
        system: t.system.version(),
        workers: { busy: t.busy(), all: t.workers.length },
        total: t.progress?.total ?? 0,
        counts: t.progress?.counts ?? {},
        parked: q.pending.length,
        applyAt: t.config.applyAt,
        now,
        tokens,
        log: t.recent
            .filter((e) => !UNLOGGED.has(e.what))
            .slice(0, KEEP_LOG)
            .map(logRow),
        errors: t.errors.slice(0, KEEP_ERRORS),
    };
}

/** Takes a snapshot, keeps it in live.json without the raw lines, and hands it to every watcher. */
export function publish(t: Tuning): Snapshot | undefined {
    let snap: Snapshot;
    try {
        snap = snapshot(t);
        const file = join(t.dir, 'live.json');
        mkdirSync(t.dir, { recursive: true });
        writeFileSync(
            `${file}.tmp`,
            `${JSON.stringify(snap, (k, v: unknown) => (k === 'lines' ? undefined : v), 2)}\n`,
        );
        renameSync(`${file}.tmp`, file);
    } catch {
        // A live view that failed to draw must not stop the tuning.
        return undefined;
    }
    t.live = snap;
    for (const watcher of t.watchers) {
        watcher(snap);
    }
    return snap;
}
