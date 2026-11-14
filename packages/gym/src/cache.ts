import { Cache as Store, paths, type CacheStore } from '@zenera/cli/lib';
import type { Model } from '@zenera/neo';
import { join } from 'node:path';
import type { Bindings } from './bindings.ts';
import type { Box } from './box.ts';
import type { Binding, HandlerRequest } from './runtime.ts';
import type { Catalog } from './catalog.ts';
import { build, BuildFailed, type BuildOptions, type Built } from './generate.ts';
import { saveBuildDump, type BuildAttempt, type ExampleRequest } from './logger.ts';
import { CONTRACT_VERSION, type Operation } from './spec.ts';
import { leaseOwner, WorldStore } from './store.ts';
import type { World } from './synth.ts';
import type { Checks } from './validate.ts';
import type { LongPaginationConfig, LongPaginationPolicy } from './long-pagination.ts';

// ---------------------------------------------------------------------------
// The cache
//
// Two layers over one identity. `Operation.key` is a function of the
// operation's shape, so a spec edit produces a new key and the old artefact is
// simply never asked for again — there is nothing to invalidate, which is the
// part of a cache that is usually wrong.
//
// The handler itself lives in the machine's shared cache rather than beside
// the box's workspace, so the same spec served from two directories is
// written once. The box root is scratch: a hit is copied back into it, because
// the worker imports a file, not a string.
//
// The in-flight map is the other half and matters more than it looks: ten
// requests arriving together for an uncached operation must produce one build,
// not ten. A failed build is remembered too, for the same reason — an operation
// the model could not write for should not re-ask on every request.
// ---------------------------------------------------------------------------

export const GYM_KIND = 'gym-handler';

/** What is kept about a handler besides the code, for `zen gym cache ls`. */
export interface HandlerMeta {
    operationId?: string;
    method?: string;
    path?: string;
    source?: string;
    model?: string;
    attempts?: number;
    rulesVersion?: number;
    createdAt?: string;
    longPagination?: LongPaginationConfig;
}

interface Stored {
    source: string;
    meta: HandlerMeta;
    /**
     * Where the handler stores each type it uses. Part of its identity, kept
     * beside rather than in the key because it is only known once the handler
     * is written: a hit whose bindings disagree with today's is a miss.
     */
    bindings?: Record<string, Binding>;
}

export interface Handler {
    key: string;
    source: string;
    /** whether it came out of the cache rather than out of a model */
    cached: boolean;
}

export interface CacheEvent {
    operation: Operation;
    attempt?: number;
    diagnostics?: readonly string[];
    /** where the rejected handler was written down, when it was */
    dump?: string;
}

export interface CacheOptions {
    box: Box;
    checks: Checks;
    model: Model;
    catalog: Catalog;
    world: World;
    bindings: Bindings;
    /** every operation being served, so a handler can be written knowing its siblings */
    operations: readonly Operation[];
    /** where HTML reports of agent runs go. Default `<box root>/reports` */
    reportDir?: string;
    attempts?: number;
    /**
     * How many handlers may be written at once. A client that walks every
     * route — which is exactly what people do to a new mock — would otherwise
     * open one model request per operation simultaneously and be rate limited
     * on all of them.
     */
    concurrency?: number;
    /** ignore what is cached and write fresh */
    rebuild?: boolean;
    /** run handlers but keep nothing */
    ephemeral?: boolean;
    /** keep them somewhere other than the shared store */
    cacheDir?: string;
    /** where rejected handlers are written down. Default `<box root>/builds` */
    dumpDir?: string;
    /** Long-list configuration by operationId. */
    longPagination?: LongPaginationPolicy;
    onStart?: (e: CacheEvent) => void;
    onAttempt?: (e: CacheEvent) => void;
    onReady?: (e: CacheEvent & { cached: boolean; attempts: number }) => void;
    onFail?: (e: CacheEvent & { error: Error }) => void;
}

export interface CacheRegenerateContext {
    currentSource: string;
    failingInput: HandlerRequest;
    fault: string;
    stderr?: string;
    examples?: readonly ExampleRequest[];
}

const DEFAULT_CONCURRENCY = 4;
/** Longer than any build; a crashed builder's lease lapses at once. */
const BUILD_LEASE_MS = 20 * 60_000;
const BUILD_POLL_MS = 500;

function samePagination(
    stored: LongPaginationConfig | undefined,
    expected: LongPaginationConfig | undefined,
): boolean {
    if (!stored || !expected) {
        return stored === expected;
    }

    return stored.pages === expected.pages && stored.pageSize === expected.pageSize;
}

/** One build's worth of rejected attempts, and where they are being written. */
interface BuildRecord {
    operation: Operation;
    started: Date;
    limit: number;
    regeneration: boolean;
    attempts: BuildAttempt[];
    path?: string;
}

export class Cache {
    readonly #opts: CacheOptions;
    readonly #store: CacheStore;
    readonly #dumpDir: string;
    readonly #reportDir: string;
    readonly #records = new Map<string, BuildRecord>();
    readonly #live = new Map<string, Promise<Handler>>();
    readonly #settled = new Set<string>();
    readonly #slots: number;
    readonly #leaseFile: string;
    readonly #owner = leaseOwner();
    #leaseStore?: WorldStore;
    readonly #waiting: (() => void)[] = [];
    #running = 0;

    constructor(opts: CacheOptions) {
        this.#opts = opts;
        this.#store = new Store(GYM_KIND, { dir: opts.cacheDir, mode: 0o600 });
        this.#leaseFile = join(opts.cacheDir ?? paths.cache(), GYM_KIND, 'leases.sqlite');
        this.#dumpDir = opts.dumpDir ?? join(opts.box.root, 'builds');
        this.#reportDir = opts.reportDir ?? join(opts.box.root, 'reports');
        this.#slots = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
    }

    /**
     * The handler for an operation, written if it does not exist yet. Callers
     * that arrive during a build wait for that build rather than starting one.
     *
     * `cached` answers "did this call cost a model turn", which is what the
     * response header is for — so it is false for the caller that triggered the
     * build and for everyone who waited on it, and true from then on.
     */
    ensure(operation: Operation): Promise<Handler> {
        const already = this.#settled.has(operation.key);
        const running = this.#live.get(operation.key);
        if (running) {
            return already ? running.then((g) => ({ ...g, cached: true })) : running;
        }
        const started = this.#make(operation).then(
            (g) => {
                this.#settled.add(operation.key);
                return g;
            },
            (err: unknown) => {
                // A model that tried and could not is remembered: re-asking it
                // once per request is how a mock server becomes an invoice.
                // Anything else — a rate limit, a dropped connection — is about
                // this moment rather than this operation, so it is forgotten
                // and the next request gets a fresh go.
                if (!(err instanceof BuildFailed)) {
                    this.#live.delete(operation.key);
                }
                throw err;
            },
        );
        this.#live.set(operation.key, started);
        return started;
    }

    get model(): Model {
        return this.#opts.model;
    }

    async getSource(key: string): Promise<string | undefined> {
        const found = this.#store.get<Stored>(key);
        return found?.source?.trim() ? found.source : undefined;
    }

    async regenerate(operation: Operation, ctx: CacheRegenerateContext): Promise<Handler> {
        const { box } = this.#opts;
        await this.#enter();
        this.#opts.onStart?.({ operation });
        try {
            const built = await build(operation, this.#builder(operation, true), ctx);
            this.#keep(operation, built);
            this.#opts.onReady?.({ operation, cached: false, attempts: built.attempts });
            const gen: Handler = { key: operation.key, source: built.source, cached: false };
            this.#settled.add(operation.key);
            this.#live.set(operation.key, Promise.resolve(gen));
            await this.#finished(operation);
            return gen;
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            // The box holds the last rejected attempt; the next request must run the old file.
            await box.write(operation.key, ctx.currentSource).catch(() => undefined);
            const dump = await this.#finished(operation, error);
            this.#opts.onFail?.({ operation, error, dump });
            throw error;
        } finally {
            this.#leave();
        }
    }

    #builder(operation: Operation, regeneration: boolean): BuildOptions {
        const { box, model, checks, catalog, world, operations, bindings } = this.#opts;
        return {
            model,
            box,
            checks,
            catalog,
            world,
            bindings,
            operations,
            attempts: this.#opts.attempts,
            reportDir: this.#reportDir,
            sourceOf: (other) => this.getSource(other.key),
            onAttempt: (attempt, diagnostics, source, limit) =>
                this.#rejected(operation, attempt, diagnostics, source, limit, regeneration),
            longPagination: this.#opts.longPagination?.[operation.operationId],
            paginationWalkPages: this.#opts.longPagination?.[operation.operationId]?.pages,
        };
    }

    #keep(operation: Operation, built: Built): void {
        if (this.#opts.ephemeral) {
            return;
        }
        const { source, attempts, bindings } = built;
        this.#store.put(operation.key, {
            source,
            bindings,
            meta: {
                operationId: operation.operationId,
                method: operation.method,
                path: operation.path,
                source: operation.source,
                model: this.#opts.model.id,
                attempts,
                rulesVersion: CONTRACT_VERSION,
                createdAt: new Date().toISOString(),
                longPagination: this.#opts.longPagination?.[operation.operationId],
            },
        } satisfies Stored);
    }

    async #make(operation: Operation): Promise<Handler> {
        const { box, rebuild } = this.#opts;
        // Read before queueing: a cache hit costs nothing and must not wait
        // behind somebody else's model call.
        const source = rebuild ? undefined : await this.#read(box, operation);

        if (source !== undefined) {
            this.#opts.onReady?.({ operation, cached: true, attempts: 0 });
            return { key: operation.key, source, cached: true };
        }

        // Another process writing the same handler — same documents, other
        // port — is waited for, and its handler read, rather than paid for twice.
        const lease = `build:${operation.key}`;
        while (!this.#leases().claim(lease, this.#owner, BUILD_LEASE_MS)) {
            await new Promise((settle) => setTimeout(settle, BUILD_POLL_MS));
            const theirs = await this.#read(box, operation);
            if (theirs !== undefined) {
                this.#opts.onReady?.({ operation, cached: true, attempts: 0 });
                return { key: operation.key, source: theirs, cached: true };
            }
        }
        try {
            return await this.#write(operation);
        } finally {
            this.#leases().release(lease, this.#owner);
        }
    }

    async #write(operation: Operation): Promise<Handler> {
        await this.#enter();
        this.#opts.onStart?.({ operation });
        try {
            const built = await build(operation, this.#builder(operation, false));
            this.#keep(operation, built);
            this.#opts.onReady?.({ operation, cached: false, attempts: built.attempts });
            await this.#finished(operation);
            return { key: operation.key, source: built.source, cached: false };
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            const dump = await this.#finished(operation, error);
            this.#opts.onFail?.({ operation, error, dump });
            throw error;
        } finally {
            this.#leave();
        }
    }

    /**
     * An attempt the judge threw out. The report is rewritten with the file
     * still in it before the next test overwrites `handler.ts` — for a timeout
     * that source is the only evidence there will ever be, since a handler
     * that hangs leaves no stack behind.
     */
    async #rejected(
        operation: Operation,
        attempt: number,
        diagnostics: readonly string[],
        source: string,
        limit: number,
        regeneration: boolean,
    ): Promise<void> {
        let record = this.#records.get(operation.key);
        if (!record || attempt === 1) {
            record = {
                operation,
                started: new Date(),
                limit,
                regeneration,
                attempts: [],
            };
            this.#records.set(operation.key, record);
        }
        record.attempts.push({ attempt, at: new Date(), diagnostics, source });
        await this.#report(record);
        this.#opts.onAttempt?.({ operation, attempt, diagnostics, dump: record.path });
    }

    /** A report that cannot be written is not worth failing a build over. */
    async #report(record: BuildRecord, gaveUp = false, report?: string): Promise<void> {
        try {
            record.path = await saveBuildDump(this.#dumpDir, {
                started: record.started,
                operationId: record.operation.operationId,
                method: record.operation.method,
                path: record.operation.path,
                key: record.operation.key,
                limit: record.limit,
                regeneration: record.regeneration,
                model: this.#opts.model.id,
                attempts: record.attempts,
                gaveUp,
                report,
            });
        } catch {
            // no report, then — the narration still says what failed
        }
    }

    /**
     * The end of a build, either way. A failure is stamped as such and its
     * report handed to the error, so the request that gets the 501 can say
     * where to read about it.
     */
    async #finished(operation: Operation, error?: Error): Promise<string | undefined> {
        const record = this.#records.get(operation.key);
        this.#records.delete(operation.key);
        if (!record) {
            return undefined;
        }
        if (error instanceof BuildFailed) {
            await this.#report(record, true, error.report);
            error.dump = record.path;
        }
        return record.path;
    }

    /**
     * A hit is written into the box before it is returned. The worker imports
     * files from the box and nothing else, and the box is scratch that any
     * `cache clear` is free to delete.
     */
    async #read(box: Box, operation: Operation): Promise<string | undefined> {
        const key = operation.key;
        const found = this.#store.get<Stored>(key);

        if (!found?.source?.trim()) {
            return undefined;
        }

        // A handler generated for a different pagination requirement
        // must not be reused.
        const expected = this.#opts.longPagination?.[operation.operationId];

        if (!samePagination(found.meta?.longPagination, expected)) {
            return undefined;
        }

        // Reject cached handlers whose type bindings no longer agree.
        const bindings = Object.entries(found.bindings ?? {});

        if (bindings.some(([type, b]) => this.#opts.bindings.conflict(type, b))) {
            return undefined;
        }

        // Restore bindings relied on by a cached handler.
        for (const [type, b] of bindings) {
            this.#opts.bindings.bind(type, b);
        }

        try {
            await box.write(key, found.source);
        } catch {
            return undefined;
        }

        return found.source;
    }

    /** Opened on the first build, so a server that never writes one never opens it. */
    #leases(): WorldStore {
        this.#leaseStore ??= new WorldStore(this.#leaseFile);
        return this.#leaseStore;
    }

    #enter(): Promise<void> {
        if (this.#running < this.#slots) {
            this.#running++;
            return Promise.resolve();
        }
        return new Promise<void>((admit) => this.#waiting.push(admit));
    }

    /** Hands the slot straight to whoever is next, so the count stays exact. */
    #leave(): void {
        const next = this.#waiting.shift();
        if (next) {
            next();
            return;
        }
        this.#running--;
    }
}

export { BuildFailed };
