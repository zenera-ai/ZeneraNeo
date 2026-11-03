import { existsSync } from 'node:fs';
import { cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { MemoryGraph } from './graph.ts';
import { MemoryError, type MemoryEdgeAttrs, type MemoryNode } from './types.ts';
import { VectorBlock } from './vectors.ts';

// ---------------------------------------------------------------------------
// What a memory is, on disk
//
// One SQLite database beside a `files/` directory. SQLite is what makes a
// memory safe to share: in WAL mode any number of connections read while one
// writes, every write is a transaction that lands whole or not at all, and a
// process killed mid-write leaves the last committed state behind rather than
// half a graph. It is built into Node, so this costs `@zenera/neo` no
// dependency and ships no binary of its own.
//
// The graph is still read whole and held in memory — recall, grep and merge
// all walk it — so the database is the record and `MemoryGraph` a cache of it.
// Every row carries the sequence number of the write that last touched it, and
// a forgotten node leaves a tombstone, so catching up with what other runs
// committed is a read of the rows newer than the last one seen, not a reload.
//
// A write is `write(fn)`: take the write lock, catch up, let `fn` change the
// graph, persist exactly what it changed, commit. `fn` runs against the graph
// as it stands on disk at that moment, which is what lets two runs change the
// same memory without one silently undoing the other. It must be synchronous:
// `DatabaseSync` waits for the lock by blocking the thread, so a transaction
// held across an `await` would leave every other connection in this process
// waiting on a lock nothing can release.
// ---------------------------------------------------------------------------

export const MEMORY_VERSION = 2;

export const MEMORY_DB = 'memory.db';
export const FILES_DIR = 'files';
/** The version 1 graph; present without a database, it means the memory needs migrating. */
export const LEGACY_GRAPH_FILE = 'graph.json';

/** How long a write waits for another to finish before giving up. */
export const BUSY_TIMEOUT_MS = 5000;

/** Tombstones kept for readers catching up; one further behind reloads in full. */
const TOMBSTONES = 1000;

export interface MemoryEmbedding {
    model: string;
    dimensions: number;
}

export interface OpenOptions {
    /** the embedder the caller intends to use; a mismatch with the memory is fatal */
    embedding?: MemoryEmbedding;
    /**
     * Recall, and nothing else. Writing is refused rather than dropped, and the
     * directory is never created, so pointing at a mistyped path fails here.
     */
    readOnly?: boolean;
    /** how long a write waits on another; `BUSY_TIMEOUT_MS` by default */
    busyTimeoutMs?: number;
}

const SCHEMA = `
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        body TEXT NOT NULL,
        seq INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS nodes_seq ON nodes (seq);
    CREATE TABLE IF NOT EXISTS edges (
        source TEXT NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
        relation TEXT NOT NULL,
        target TEXT NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
        attrs TEXT NOT NULL,
        seq INTEGER NOT NULL,
        PRIMARY KEY (source, relation, target)
    );
    CREATE INDEX IF NOT EXISTS edges_target ON edges (target);
    CREATE INDEX IF NOT EXISTS edges_seq ON edges (seq);
    CREATE TABLE IF NOT EXISTS vectors (
        id TEXT PRIMARY KEY REFERENCES nodes (id) ON DELETE CASCADE,
        data BLOB NOT NULL,
        seq INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS vectors_seq ON vectors (seq);
    CREATE TABLE IF NOT EXISTS forgotten (id TEXT NOT NULL, seq INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS forgotten_seq ON forgotten (seq);
`;

interface NodeRow {
    body: string;
}

interface EdgeRow {
    source: string;
    target: string;
    attrs: string;
}

interface VectorRow {
    id: string;
    data: Uint8Array;
}

export class MemoryStore {
    readonly dir: string;
    readonly readOnly: boolean;
    #graph = new MemoryGraph();
    #embedding?: MemoryEmbedding;
    #vectors?: VectorBlock;
    #db?: DatabaseSync;
    readonly #statements = new Map<string, StatementSync>();
    readonly #busyMs: number;
    /** the last write this cache has caught up with */
    #seq = 0;
    /** `PRAGMA data_version` when last caught up; it moves only when another connection commits */
    #version = -1;

    private constructor(dir: string, readOnly: boolean, busyMs: number) {
        this.dir = dir;
        this.readOnly = readOnly;
        this.#busyMs = busyMs;
    }

    static async open(dir: string, opts: OpenOptions = {}): Promise<MemoryStore> {
        const readOnly = opts.readOnly === true;
        const path = join(dir, MEMORY_DB);
        if (!existsSync(path) && existsSync(join(dir, LEGACY_GRAPH_FILE))) {
            throw new MemoryError(
                `${dir} holds a version 1 memory`,
                `convert it once with \`zen memory migrate --dir ${dir}\``,
            );
        }
        // Opening for writing brings a memory into existence; opening one to
        // read from has to find it, or a mistyped path is an empty graph that
        // answers every question with silence and reports no error.
        if (readOnly && !existsSync(path)) {
            throw new MemoryError(
                `${dir} is not a memory`,
                `no ${MEMORY_DB} in it, and a read-only open cannot create one`,
            );
        }
        if (!readOnly) {
            await mkdir(join(dir, FILES_DIR), { recursive: true });
        }

        const store = new MemoryStore(dir, readOnly, opts.busyTimeoutMs ?? BUSY_TIMEOUT_MS);
        store.#embedding = opts.embedding;
        if (store.#connect(false)) {
            const held = store.#read(() => store.#meta<MemoryEmbedding>('embedding'));
            if (held && opts.embedding) {
                assertSame(held, opts.embedding);
            }
            store.#reload();
        }
        return store;
    }

    get graph(): MemoryGraph {
        return this.#graph;
    }

    get embedding(): MemoryEmbedding | undefined {
        return this.#embedding;
    }

    /**
     * Records the vectoriser actually in use. A width is only knowable from a
     * real response, so a memory embedded for the first time learns it here
     * rather than making the caller declare a number it would have to keep in
     * step with the model.
     */
    adopt(embedding: MemoryEmbedding): void {
        const held = this.#embedding;
        if (held) {
            assertSame(held, embedding);
            return;
        }
        this.#embedding = embedding;
    }

    /** Absent when no embedder is configured; recall then falls back to term overlap. */
    get vectors(): VectorBlock | undefined {
        if (!this.#vectors && this.#embedding) {
            this.#vectors = new VectorBlock(this.#embedding.dimensions);
        }
        return this.#vectors;
    }

    filePath(name: string): string {
        return join(this.dir, FILES_DIR, name);
    }

    /**
     * Catches up with what other connections committed. Cheap when nothing
     * did: one pragma, answered from shared memory without touching the file.
     */
    refresh(): void {
        if (!this.#db && !this.#connect(false)) {
            return;
        }
        const version = this.#dataVersion();
        if (version === this.#version) {
            return;
        }
        this.#read(() => this.#pull());
        this.#version = version;
    }

    /**
     * One transaction: catch up, let `fn` change the graph, persist what it
     * changed. Whatever `fn` throws rolls the whole thing back, on disk and in
     * the cache.
     */
    write<T>(fn: () => T): T {
        if (this.readOnly) {
            // Loudly, not quietly. A write that is silently dropped is a run
            // that believes it remembered something and did not.
            throw new MemoryError(
                'this memory is open read-only',
                'nothing this run learns can be kept — point it at a memory of its own',
            );
        }
        this.#connect(true);
        const db = this.#db!;
        try {
            db.exec('BEGIN IMMEDIATE');
        } catch (err) {
            throw busy(this.dir, err);
        }
        try {
            this.#pull();
            const out = fn();
            if (out instanceof Promise) {
                throw new Error('MemoryStore.write takes a synchronous function');
            }
            this.#flush();
            db.exec('COMMIT');
            this.#graph.settle();
            return out;
        } catch (err) {
            if (db.isTransaction) {
                db.exec('ROLLBACK');
            }
            if (this.#graph.dirty) {
                this.#reload();
            }
            throw err;
        }
    }

    /** Persists whatever the graph changed outside `write` — a merge folding in memory. */
    async commit(): Promise<void> {
        this.write(() => undefined);
    }

    /** Folds the log into the database file and closes, so a committed `.db` is complete. */
    release(): void {
        const db = this.#db;
        if (!db) {
            return;
        }
        this.#db = undefined;
        this.#statements.clear();
        try {
            if (!this.readOnly) {
                db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
            }
        } catch {
            // Another connection is still reading; the last one to close folds it in.
        }
        try {
            db.close();
        } catch {
            // already closed
        }
    }

    // --- the connection ---

    #connect(create: boolean): boolean {
        if (this.#db) {
            return true;
        }
        const path = join(this.dir, MEMORY_DB);
        if (!create && !existsSync(path)) {
            return false;
        }
        let db: DatabaseSync;
        try {
            db = new DatabaseSync(path, { readOnly: this.readOnly, timeout: this.#busyMs });
        } catch (err) {
            throw new MemoryError(`cannot open ${path}: ${(err as Error).message}`);
        }
        try {
            const version = Number(
                (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
            );
            if (version !== MEMORY_VERSION && !(version === 0 && !this.readOnly)) {
                throw new MemoryError(
                    `this memory is version ${version}, but this build reads version ${MEMORY_VERSION}`,
                    'open it with the build that wrote it, or start a new memory',
                );
            }
            if (!this.readOnly) {
                db.exec('PRAGMA journal_mode = WAL');
                db.exec('PRAGMA synchronous = NORMAL');
                db.exec('PRAGMA foreign_keys = ON');
                if (version === 0) {
                    db.exec('BEGIN IMMEDIATE');
                    db.exec(SCHEMA);
                    db.exec(`PRAGMA user_version = ${MEMORY_VERSION}`);
                    db.exec('COMMIT');
                }
            }
        } catch (err) {
            db.close();
            if (err instanceof MemoryError) {
                throw err;
            }
            throw busy(this.dir, err);
        }
        this.#db = db;
        return true;
    }

    #sql(text: string): StatementSync {
        let statement = this.#statements.get(text);
        if (!statement) {
            statement = this.#db!.prepare(text);
            this.#statements.set(text, statement);
        }
        return statement;
    }

    #dataVersion(): number {
        return Number(
            (this.#sql('PRAGMA data_version').get() as { data_version: number }).data_version,
        );
    }

    /** Several reads that must see one snapshot. */
    #read<T>(fn: () => T): T {
        const db = this.#db!;
        if (db.isTransaction) {
            return fn();
        }
        db.exec('BEGIN');
        try {
            return fn();
        } finally {
            db.exec('COMMIT');
        }
    }

    #meta<T>(key: string): T | undefined {
        const row = this.#sql('SELECT value FROM meta WHERE key = ?').get(key) as
            { value: string } | undefined;
        return row ? (JSON.parse(row.value) as T) : undefined;
    }

    #setMeta(key: string, value: unknown): void {
        this.#sql(
            'INSERT INTO meta (key, value) VALUES (?, ?) ' +
                'ON CONFLICT (key) DO UPDATE SET value = excluded.value',
        ).run(key, JSON.stringify(value));
    }

    // --- reading ---

    /** The whole memory, from scratch. Discards anything not yet persisted. */
    #reload(): void {
        const db = this.#db;
        if (!db) {
            this.#graph = new MemoryGraph();
            this.#vectors = undefined;
            this.#seq = 0;
            return;
        }
        this.#read(() => {
            this.#adoptEmbedding();
            const graph = new MemoryGraph();
            for (const row of this.#sql('SELECT body FROM nodes').all() as unknown as NodeRow[]) {
                graph.adopt(JSON.parse(row.body) as MemoryNode);
            }
            for (const row of this.#sql(
                'SELECT source, target, attrs FROM edges',
            ).all() as unknown as EdgeRow[]) {
                graph.adoptEdge(row.source, row.target, JSON.parse(row.attrs) as MemoryEdgeAttrs);
            }
            graph.settle();
            this.#graph = graph;
            this.#vectors = this.#embedding
                ? new VectorBlock(this.#embedding.dimensions)
                : undefined;
            for (const row of this.#sql(
                'SELECT id, data FROM vectors',
            ).all() as unknown as VectorRow[]) {
                this.#setVector(row);
            }
            this.#seq = this.#meta<number>('seq') ?? 0;
        });
        this.#version = this.#dataVersion();
    }

    /** What other connections committed since this cache last looked. Inside a transaction. */
    #pull(): void {
        const seq = this.#meta<number>('seq') ?? 0;
        if (seq === this.#seq) {
            return;
        }
        if (this.#seq < (this.#meta<number>('floor') ?? 0) && !this.#graph.dirty) {
            this.#reload();
            return;
        }
        this.#adoptEmbedding();
        const since = this.#seq;
        const graph = this.#graph;
        graph.untracked(() => {
            const gone = this.#sql('SELECT id FROM forgotten WHERE seq > ?').all(since) as {
                id: string;
            }[];
            const alive = this.#sql('SELECT 1 FROM nodes WHERE id = ?');
            for (const { id } of gone) {
                // A row still there means the id came back after it was forgotten.
                if (!graph.isDirty(id) && !alive.get(id)) {
                    graph.forget(id);
                    this.#vectors?.remove(id);
                }
            }
            const nodes = this.#sql('SELECT body FROM nodes WHERE seq > ?').all(since);
            for (const row of nodes as unknown as NodeRow[]) {
                const node = JSON.parse(row.body) as MemoryNode;
                if (!graph.isDirty(node.id)) {
                    graph.adopt(node);
                }
            }
            const edges = this.#sql('SELECT source, target, attrs FROM edges WHERE seq > ?').all(
                since,
            );
            for (const row of edges as unknown as EdgeRow[]) {
                if (graph.has(row.source) && graph.has(row.target)) {
                    graph.adoptEdge(
                        row.source,
                        row.target,
                        JSON.parse(row.attrs) as MemoryEdgeAttrs,
                    );
                }
            }
        });
        const vectors = this.#sql('SELECT id, data FROM vectors WHERE seq > ?').all(since);
        for (const row of vectors as unknown as VectorRow[]) {
            if (!graph.isDirty(row.id)) {
                this.#setVector(row);
            }
        }
        this.#seq = seq;
    }

    /** A memory first embedded by another run tells this one what it was embedded with. */
    #adoptEmbedding(): void {
        const held = this.#meta<MemoryEmbedding>('embedding');
        if (held && !this.#embedding) {
            this.#embedding = held;
        }
    }

    #setVector(row: VectorRow): void {
        const block = this.vectors;
        const data = new Float32Array(row.data.byteLength / 4);
        new Uint8Array(data.buffer).set(row.data);
        if (block && data.length === block.dims) {
            block.set(row.id, data);
        }
    }

    // --- writing ---

    /** Inside the write transaction: exactly what the graph says changed. */
    #flush(): void {
        const seq = this.#seq + 1;
        const changes = this.#graph.changes();
        const vectors = this.#vectors;

        if (this.#embedding) {
            const held = this.#meta<MemoryEmbedding>('embedding');
            if (held) {
                assertSame(held, this.#embedding);
            } else {
                this.#setMeta('embedding', this.#embedding);
            }
        }

        const drop = this.#sql('DELETE FROM nodes WHERE id = ?');
        const tombstone = this.#sql('INSERT INTO forgotten (id, seq) VALUES (?, ?)');
        for (const id of changes.dropped) {
            drop.run(id);
            tombstone.run(id, seq);
        }

        const node = this.#sql(
            'INSERT INTO nodes (id, body, seq) VALUES (?, ?, ?) ' +
                'ON CONFLICT (id) DO UPDATE SET body = excluded.body, seq = excluded.seq',
        );
        const vector = this.#sql(
            'INSERT INTO vectors (id, data, seq) VALUES (?, ?, ?) ' +
                'ON CONFLICT (id) DO UPDATE SET data = excluded.data, seq = excluded.seq',
        );
        for (const id of changes.nodes) {
            const current = this.#graph.get(id);
            if (!current) {
                continue;
            }
            node.run(id, JSON.stringify(current), seq);
            const v = vectors?.get(id);
            if (v) {
                vector.run(id, new Uint8Array(v.buffer, v.byteOffset, v.byteLength), seq);
            }
        }

        const edge = this.#sql(
            'INSERT INTO edges (source, relation, target, attrs, seq) VALUES (?, ?, ?, ?, ?) ' +
                'ON CONFLICT (source, relation, target) DO UPDATE SET attrs = excluded.attrs, seq = excluded.seq',
        );
        for (const key of changes.edges) {
            const e = this.#graph.edge(key);
            if (e) {
                edge.run(e.source, e.attrs.relation, e.target, JSON.stringify(e.attrs), seq);
            }
        }

        this.#setMeta('seq', seq);
        if (seq % 100 === 0 && seq > TOMBSTONES) {
            const floor = seq - TOMBSTONES;
            this.#sql('DELETE FROM forgotten WHERE seq <= ?').run(floor);
            this.#setMeta('floor', floor);
        }
        this.#seq = seq;
    }
}

function assertSame(held: MemoryEmbedding, wanted: MemoryEmbedding): void {
    if (held.model !== wanted.model || held.dimensions !== wanted.dimensions) {
        throw new MemoryError(
            `this memory was embedded with ${held.model} (${held.dimensions}d), ` +
                `but ${wanted.model} (${wanted.dimensions}d) is configured`,
            'restore the original model, or start a new memory',
        );
    }
}

function busy(dir: string, err: unknown): MemoryError {
    const message = (err as Error).message ?? String(err);
    return /locked|busy/i.test(message)
        ? new MemoryError(
              `the memory in ${dir} is busy`,
              'another run held it past the wait; try again when it finishes',
          )
        : new MemoryError(`the memory in ${dir} cannot be written: ${message}`);
}

/** Whether a directory holds a memory anything has written to. */
export function isMemory(dir: string): boolean {
    return existsSync(join(dir, MEMORY_DB));
}

/**
 * The database as of one moment, written to `file`, whatever other runs are
 * doing to it meanwhile.
 */
export function snapshotMemory(from: string, file: string): void {
    const db = new DatabaseSync(join(from, MEMORY_DB), {
        readOnly: true,
        timeout: BUSY_TIMEOUT_MS,
    });
    try {
        db.prepare('VACUUM INTO ?').run(file);
    } finally {
        db.close();
    }
}

/**
 * A consistent copy of a memory another run may be writing to: the database
 * as of one moment, then the files. Files written after that moment come
 * along as well, which costs a few unreferenced bytes and nothing else.
 */
export async function copyMemory(from: string, to: string): Promise<void> {
    await mkdir(to, { recursive: true });
    if (isMemory(from)) {
        snapshotMemory(from, join(to, MEMORY_DB));
    }
    if (existsSync(join(from, FILES_DIR))) {
        await cp(join(from, FILES_DIR), join(to, FILES_DIR), { recursive: true });
    }
}
