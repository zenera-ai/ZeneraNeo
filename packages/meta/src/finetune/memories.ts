import { isMemory, MemoryStore } from '@zenera/neo';
import { appendFileSync, cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DatasetStore } from './dataset/store.ts';
import type { Case } from './dataset/types.ts';
import { errorIn, sizeOf } from './failure.ts';
import { writeFeedback } from './report.ts';
import type { Run } from './train.ts';
import type { Tuning } from './tuning.ts';

// ---------------------------------------------------------------------------
// Memories, kept and merged
//
// No run ever shares a memory: each try runs on its own private directory - an
// empty one without memory, a copy of its case's passing memory with it. Its
// workspace is private too, and always starts empty. What
// is shared is only the record. A case whose with-memory run passes submits a
// copy of that memory here; once `mergeEvery` new ones are waiting they are
// merged, with the last merge, into a new graph. Merges are numbered and never
// rewritten, so each one says exactly which cases it holds.
// ---------------------------------------------------------------------------

export interface Submission {
    /** `<case>@r<rev>` */
    key: string;
    case: string;
    rev: number;
    attempt: number;
    run: string;
    dir: string;
    at: string;
    /** the run committed nothing: there is no graph to merge */
    empty: boolean;
}

export interface MergeRow {
    n: number;
    name: string;
    at: string;
    dir: string;
    log: string;
    /** every submission in this graph */
    includes: string[];
    /** the ones this merge brought in */
    added: string[];
    ok: boolean;
    nodes?: number;
    edges?: number;
}

function rows<T>(file: string): T[] {
    try {
        return readFileSync(file, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as T);
    } catch {
        return [];
    }
}

/** How big a memory is, or nothing when there is no memory there to open. */
async function sizeOfMemory(dir: string): Promise<{ nodes: number; edges: number } | undefined> {
    if (!isMemory(dir)) {
        return undefined;
    }
    try {
        const store = await MemoryStore.open(dir, { readOnly: true });
        try {
            return { nodes: store.graph.order, edges: store.graph.size };
        } finally {
            store.release();
        }
    } catch {
        return undefined;
    }
}

export class Memories {
    readonly #t: Tuning;
    #chain: Promise<void> = Promise.resolve();
    merging: { name: string; since: number } | undefined;

    constructor(t: Tuning) {
        this.#t = t;
    }

    get dir(): string {
        return join(this.#t.dir, 'memories');
    }

    submissions(): Submission[] {
        return rows<Submission>(join(this.dir, 'submissions.jsonl'));
    }

    merges(): MergeRow[] {
        return rows<MergeRow>(join(this.dir, 'merges.jsonl'));
    }

    lastMerge(): MergeRow | undefined {
        return this.merges()
            .filter((m) => m.ok)
            .at(-1);
    }

    unmerged(): Submission[] {
        const merged = new Set(this.lastMerge()?.includes ?? []);
        return this.submissions().filter((s) => !s.empty && !merged.has(s.key));
    }

    /** Keeps a copy of a passing with-memory run's memory. Once per case revision. */
    submit(c: Case, attempt: number, run: Run): void {
        const key = `${c.id}@r${c.rev}`;
        if (this.submissions().some((s) => s.key === key)) {
            return;
        }
        const dir = join(this.dir, 'submitted', key);
        const empty = !isMemory(run.memory);
        rmSync(dir, { recursive: true, force: true });
        if (!empty) {
            cpSync(run.memory, dir, {
                recursive: true,
                filter: (src) => basename(src) !== '.lock',
            });
        }
        const row: Submission = {
            key,
            case: c.id,
            rev: c.rev,
            attempt,
            run: run.dir,
            dir,
            at: new Date().toISOString(),
            empty,
        };
        mkdirSync(this.dir, { recursive: true });
        appendFileSync(join(this.dir, 'submissions.jsonl'), `${JSON.stringify(row)}\n`);
        this.#t.event({
            what: 'memory submitted',
            case: c.id,
            rev: c.rev,
            detail: empty ? 'nothing committed' : `${this.unmerged().length} waiting to merge`,
        });
        if (this.unmerged().length >= this.#t.config.mergeEvery) {
            this.#queue();
        }
    }

    /** Merges whatever is left, and waits for every merge queued. */
    async finish(): Promise<void> {
        if (this.unmerged().length > 0) {
            this.#queue();
        }
        await this.#chain;
    }

    #queue(): void {
        this.#chain = this.#chain
            .then(() => this.#merge())
            .catch((err: Error) => {
                this.#t.error('memory merge', err.message);
            });
    }

    async #merge(): Promise<void> {
        const fresh = this.unmerged();
        if (fresh.length === 0) {
            return;
        }
        const n = this.merges().length + 1;
        const name = `m${String(n).padStart(2, '0')}`;
        const target = join(this.dir, 'merged', name);
        const log = join(this.dir, 'merged', `${name}.log`);
        await this.#t.journal.step({ kind: 'merge', dir: target, log }, () =>
            this.#mergeInto(fresh, n, name, target, log),
        );
    }

    async #mergeInto(
        fresh: Submission[],
        n: number,
        name: string,
        target: string,
        log: string,
    ): Promise<void> {
        const last = this.lastMerge();
        rmSync(target, { recursive: true, force: true });
        mkdirSync(join(this.dir, 'merged'), { recursive: true });
        const began = Date.now();
        const from = sizeOf(log);
        this.merging = { name, since: began };
        this.#t.event({ what: 'memory merge', detail: `${name}: ${fresh.length} new` });
        const sources = [...(last ? [last.dir] : []), ...fresh.map((s) => s.dir)];
        const res = await this.#t
            .zen(['memory', 'merge', ...sources, '--dir', target, '--yes'], log)
            .finally(() => {
                this.merging = undefined;
            });
        const size = await sizeOfMemory(target);
        const row: MergeRow = {
            n,
            name,
            at: new Date().toISOString(),
            dir: target,
            log,
            includes: [...(last?.includes ?? []), ...fresh.map((s) => s.key)],
            added: fresh.map((s) => s.key),
            ok: res.code === 0 && size !== undefined,
            ...(size ? { nodes: size.nodes, edges: size.edges } : {}),
        };
        appendFileSync(join(this.dir, 'merges.jsonl'), `${JSON.stringify(row)}\n`);
        if (!row.ok) {
            const e = errorIn(log, from);
            this.#t.error(`memory ${name}`, e.message ?? 'the merge wrote no memory', e.log);
        }
        const store = DatasetStore.open(this.#t.root);
        for (const s of fresh) {
            const c = store.get(s.case);
            if (c?.rev === s.rev) {
                writeFeedback(this.#t, c);
            }
        }
        this.#t.event({
            what: row.ok ? 'memory merged' : 'memory merge failed',
            detail: `${name}: ${row.includes.length} case(s)${row.ok ? '' : ' - see the log'}`,
            result: row.ok
                ? `${row.includes.length} case(s), ${row.nodes ?? '?'} nodes`
                : 'see the log',
            took: Date.now() - began,
        });
    }
}
