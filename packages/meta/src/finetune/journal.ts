import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { reap } from './children.ts';
import type { Tuning } from './tuning.ts';

// ---------------------------------------------------------------------------
// The journal: every step that writes, as a transaction
//
// A run, an analysis, an apply and a memory merge each write `begin` before
// they touch anything and `commit` once their result is whole - or `failed`
// when they ended badly but in hand, their own error path having cleaned up.
// A step begun and never closed was cut off by a kill: the next start rolls it
// back, newest first, so nothing half-written is taken for done.
// ---------------------------------------------------------------------------

export type Tx =
    | { kind: 'run'; dir: string }
    | { kind: 'analyze'; dir: string }
    | { kind: 'apply'; dir: string; from: number }
    | { kind: 'merge'; dir: string; log: string };

type Row =
    | { id: string; at: string; op: 'begin'; tx: Tx }
    | { id: string; at: string; op: 'commit' | 'failed' | 'rollback' };

/** What a step leaves in its attempt folder; the logs stay, they only grow. */
const OUTPUTS: Record<'run' | 'analyze', string[]> = {
    run: ['run.json', 'envelope.json', 'request.json', 'events.jsonl', 'memory', 'workspace'],
    analyze: [
        'feedback.json',
        'analysis.md',
        'analyze.json',
        'analyze-2.json',
        'analyze.events.jsonl',
    ],
};

export class Journal {
    readonly file: string;
    readonly #base: string;

    constructor(file: string) {
        this.file = file;
        this.#base = dirname(file);
    }

    #append(row: Row): void {
        mkdirSync(this.#base, { recursive: true });
        appendFileSync(this.file, `${JSON.stringify(row)}\n`);
    }

    // Paths are kept relative, so a project moved between sessions still recovers.
    #paths(tx: Tx, to: (p: string) => string): Tx {
        return { ...tx, dir: to(tx.dir), ...('log' in tx ? { log: to(tx.log) } : {}) } as Tx;
    }

    begin(tx: Tx): string {
        const id = randomUUID().slice(0, 8);
        this.#append({
            id,
            at: new Date().toISOString(),
            op: 'begin',
            tx: this.#paths(tx, (p) => relative(this.#base, p)),
        });
        return id;
    }

    end(id: string, op: 'commit' | 'failed' | 'rollback'): void {
        this.#append({ id, at: new Date().toISOString(), op });
    }

    /** Runs `fn` as one transaction. */
    async step<T>(tx: Tx, fn: () => Promise<T>): Promise<T> {
        const id = this.begin(tx);
        let result: T;
        try {
            result = await fn();
        } catch (err) {
            this.end(id, 'failed');
            throw err;
        }
        this.end(id, 'commit');
        return result;
    }

    /** Transactions begun and never closed, oldest first. */
    open(): { id: string; tx: Tx }[] {
        let text = '';
        try {
            text = readFileSync(this.file, 'utf8');
        } catch {
            return [];
        }
        const begun = new Map<string, Tx>();
        for (const line of text.split('\n')) {
            let row: Row;
            try {
                row = JSON.parse(line) as Row;
            } catch {
                // A line torn by the kill itself.
                continue;
            }
            if (row.op === 'begin') {
                begun.set(row.id, row.tx);
            } else {
                begun.delete(row.id);
            }
        }
        return [...begun].map(([id, tx]) => ({
            id,
            tx: this.#paths(tx, (p) => (isAbsolute(p) ? p : join(this.#base, p))),
        }));
    }

    /** Every transaction closed: the history can go. */
    clear(): void {
        rmSync(this.file, { force: true });
    }
}

/** Rolls back what a kill cut off. Only under the loop's lock: a live step looks the same. */
export async function recover(t: Tuning): Promise<void> {
    // Before anything is rolled back: a child still running would write into it again.
    const reaped = await reap(t.dir);
    if (reaped.length > 0) {
        t.event({
            what: 'stopped leftovers',
            detail: `${reaped.length} process(es) the last loop left running`,
        });
    }
    const open = t.journal.open().reverse();
    for (const { id, tx } of open) {
        rollback(t, tx);
        t.journal.end(id, 'rollback');
        t.event({ what: 'rolled back', detail: `${tx.kind} ${relative(t.dir, tx.dir)}` });
    }
    if (open.some(({ tx }) => tx.kind === 'apply')) {
        t.improvements.reload();
    }
    t.journal.clear();
}

function rollback(t: Tuning, tx: Tx): void {
    switch (tx.kind) {
        case 'run':
        case 'analyze':
            for (const name of OUTPUTS[tx.kind]) {
                rmSync(join(tx.dir, name), { recursive: true, force: true });
            }
            return;
        case 'apply':
            // Its edits never passed `zen check`: put back the version it started from.
            t.system.restore(tx.from);
            t.system.drop(basename(tx.dir));
            rmSync(tx.dir, { recursive: true, force: true });
            return;
        case 'merge':
            rmSync(tx.dir, { recursive: true, force: true });
            rmSync(tx.log, { force: true });
            return;
    }
}
