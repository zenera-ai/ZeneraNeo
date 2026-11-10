import RandExp from 'randexp';
import type { Collection, WorldStore } from './store.ts';

// ---------------------------------------------------------------------------
// What a handler is given
//
// A handler is one TypeScript module per operation, written by a model and run
// in a worker thread. It owns the API's *mechanics* — which collection an
// operation reads, how a query filters it, what a POST writes — and none of its
// *content*. Content lives in the world, and when the world has nothing to say
// yet, the handler asks for it: `ctx.lookup` and `ctx.ensure` read through to an
// agent that makes the missing entities up, consistent with the story and with
// everything already there, and stores them before answering.
//
// That split is why one cached handler serves every story: change the story and
// the world changes, the code does not.
//
// Loaded inside the worker, so: `node:` built-ins, `randexp` and erasable
// TypeScript only.
// ---------------------------------------------------------------------------

export interface HandlerRequest {
    operationId: string;
    method: string;
    /** the template, `/users/{userId}/messages/{id}` */
    path: string;
    pathParams: Record<string, string>;
    query: Record<string, string>;
    headers: Record<string, string>;
    body: unknown;
    seed: number;
}

/** What a handler may ask the world agent to make up. */
export interface SynthesisRequest {
    collection: string;
    /** the component schema every record must satisfy, e.g. `"Message"` */
    type?: string;
    /** how many to make when no ids are named. Default 5 */
    count?: number;
    /** nothing is made if this many records already match `where` */
    min?: number;
    /** ids that must exist afterwards */
    ids?: (string | number)[];
    /** the property that holds the id. Default `id` */
    idField?: string;
    /** values every new record must carry, e.g. `{ calendarId: 'primary' }` */
    where?: Record<string, unknown>;
    /** what the records are for, in a sentence: the query, the filter, the context */
    hint?: string;
    /** the first read of this collection (and `where`): fill it as the story has it */
    populate?: boolean;
}

export type Synthesize = (request: SynthesisRequest) => Promise<Record<string, unknown>[]>;

/** Key order is an accident of how a handler wrote it; it must not change a key. */
function canonical(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(canonical);
    }
    if (value !== null && typeof value === 'object') {
        return Object.keys(value)
            .sort()
            .map((k) => [k, canonical((value as Record<string, unknown>)[k])]);
    }
    return value;
}

/** Where accounts live, and the id of the one the API is called as. */
export const ACCOUNTS = 'accounts';

/**
 * Whether a collection — or the part of it `where` selects — has ever been
 * filled by the world agent. Counting records cannot tell: a mailbox whose
 * only message is the one the client just sent is not an inbox yet.
 */
export function populatedKey(collection: string, where?: Record<string, unknown>): string {
    return `populated:${collection}:${JSON.stringify(canonical(where ?? {}))}`;
}
export const OWNER = '@me';

export interface Account {
    id: string;
    email: string;
    displayName?: string;
    [key: string]: unknown;
}

export interface Page<T> {
    items: T[];
    /** the token for the next page, null on the last */
    nextToken: string | null;
    /** the offset of the next page, null on the last */
    nextOffset: number | null;
    hasMore: boolean;
    total: number;
}

export interface PageOptions {
    /** the token a previous page handed out, as the client sent it back */
    token?: unknown;
    /** for offset-style APIs, the offset the client asked for */
    offset?: unknown;
    /** page size the client asked for */
    size?: unknown;
    /** page size when the client did not say. Default 10 */
    defaultSize?: number;
}

export interface HandlerContext {
    /**
     * The shared world, by type: `ctx.db.collection('Message').get(id)`. A
     * lowercase name is taken as a collection name instead.
     */
    db: { collection<T = Record<string, unknown>>(name: string): Collection<T> };
    /** a record by id, made up by the world agent if the world does not have it */
    lookup<T = Record<string, unknown>>(
        type: string,
        id: string | number,
        options?: Omit<SynthesisRequest, 'collection' | 'ids' | 'count'>,
    ): Promise<T>;
    /**
     * Every record in a collection, after making sure there are at least
     * `min` (default 1) matching `where`. The way a list endpoint starts.
     */
    ensure<T = Record<string, unknown>>(
        type: string,
        options?: Omit<SynthesisRequest, 'collection' | 'ids'>,
    ): Promise<T[]>;
    /** asks the world agent for new records directly; they are stored before this returns */
    synthesize: Synthesize;
    /**
     * The account this API is called as — the person `me`, `primary` and
     * `self` stand for. Made once, from the story, and shared by every API.
     */
    owner(): Promise<Account>;
    /** a page of `items` with a token or offset that always advances and always ends */
    page<T>(items: readonly T[], options?: PageOptions): Page<T>;
    /** answers with an HTTP error instead of the success body */
    fail(status: number, body?: unknown): never;
    /** a string matching a regular expression, e.g. a schema `pattern` */
    fromPattern(pattern: string): string;
    /** a fresh id: hex by default, or matching `pattern` when given */
    newId(pattern?: string): string;
    /** seeded randomness, so one request answers the same way twice under `--seed` */
    random(): number;
    int(min: number, max: number): number;
    pick<T>(items: readonly T[]): T;
    /** the current time as RFC 3339 */
    now(): string;
}

export class HttpError extends Error {
    readonly status: number;
    readonly body: unknown;

    constructor(status: number, body?: unknown) {
        super(`HTTP ${status}`);
        this.name = 'HttpError';
        this.status = status;
        this.body = body ?? { error: `HTTP ${status}` };
    }
}

/** Where a type's records live, and which property holds their id. */
export interface Binding {
    collection: string;
    idField: string;
}

export type Bindings = Readonly<Record<string, Binding>>;

/** One collection a handler touched, and as which type. */
export interface Use {
    collection: string;
    type?: string;
    idField?: string;
}

/** The type gym gives the owner account; no document declares one. */
export const OWNER_TYPE = '@owner';

/** A name that starts with a capital is a type: `Message`, not `messages`. */
export const isTypeName = (name: string): boolean => /^[A-Z]/.test(name);

/**
 * The collection an unbound type gets: `Message` → `messages`,
 * `AvailabilityZone` → `availability_zones`. Only ever a first guess —
 * once bound, the binding is the answer.
 */
export function collectionFor(type: string): string {
    const snake = type
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
        .replace(/[^A-Za-z0-9]+/g, '_')
        .toLowerCase()
        .replace(/^_+|_+$/g, '');
    return /s$/.test(snake) ? snake : `${snake}s`;
}

/**
 * A name as a handler wrote it, made concrete. A type name finds its
 * collection through the bindings; a collection name finds its type the same
 * way, backwards. Whatever was asked is reported to `record`, which is how the
 * judge learns which types a handler stores where.
 */
export function resolve(
    name: string,
    options: { type?: string; idField?: string },
    bindings: Bindings,
): Required<Pick<Use, 'collection'>> & Use {
    if (name === ACCOUNTS) {
        return { collection: ACCOUNTS, type: OWNER_TYPE, idField: 'id' };
    }
    if (isTypeName(name)) {
        const bound = bindings[name];
        return {
            collection: bound?.collection ?? collectionFor(name),
            type: name,
            idField: options.idField ?? bound?.idField,
        };
    }
    const type =
        options.type ?? Object.entries(bindings).find(([, b]) => b.collection === name)?.[0];
    const bound = type ? bindings[type] : undefined;
    return { collection: name, type, idField: options.idField ?? bound?.idField };
}

export function createContext(
    input: HandlerRequest,
    store: WorldStore,
    synthesize: Synthesize,
    bindings: Bindings = {},
    record: (use: Use) => void = () => {},
): HandlerContext {
    const at = (name: string, options: { type?: string; idField?: string } = {}) => {
        const where = resolve(name, options, bindings);
        record(where);
        return where;
    };
    const random = mulberry32(input.seed || 1);
    const int = (min: number, max: number): number => min + Math.floor(random() * (max - min + 1));
    const fromPattern = (pattern: string): string => {
        const gen = new RandExp(stripSlashes(pattern));
        gen.max = 8;
        gen.randInt = int;
        return gen.gen();
    };

    const ctx: HandlerContext = {
        db: { collection: (name) => store.collection(at(name).collection) },
        async lookup(name, id, options = {}) {
            const { collection, type, idField } = at(name, options);
            const col = store.collection(collection);
            const found = col.get(id);
            if (found !== undefined) {
                return found as never;
            }
            await synthesize({ ...options, collection, type, idField, ids: [id] });
            const made = col.get(id);
            if (made === undefined) {
                throw new Error(`the world agent did not create ${collection}/${String(id)}`);
            }
            return made as never;
        },
        async ensure(name, options = {}) {
            const { collection, type, idField } = at(name, options);
            const min = options.min ?? 1;
            const col = store.collection(collection);
            const matching = (): Record<string, unknown>[] =>
                col.all().filter((r) => matches(r, options.where));
            const have = matching().length;
            const populate = !store.getMeta(populatedKey(collection, options.where));
            if (populate || have < min) {
                await synthesize({
                    ...options,
                    collection,
                    type,
                    idField,
                    min,
                    populate,
                    count: options.count ?? (populate ? Math.max(min, 8) : Math.max(min - have, 5)),
                });
            }
            return matching() as never;
        },
        synthesize: (request) => {
            const { collection, type, idField } = at(request.collection, request);
            return synthesize({ ...request, collection, type, idField });
        },
        owner: () =>
            ctx.lookup<Account>(ACCOUNTS, OWNER, {
                hint: 'the person whose mailbox, calendar and data this API serves',
            }),
        page: (items, options = {}) => page(items, options),
        fail(status, body) {
            throw new HttpError(status, body);
        },
        fromPattern,
        newId: (pattern) =>
            pattern
                ? fromPattern(pattern)
                : Array.from({ length: 16 }, () => int(0, 15).toString(16)).join(''),
        random,
        int,
        pick: (items) => items[int(0, items.length - 1)]!,
        now: () => new Date().toISOString(),
    };
    return ctx;
}

/** Every key in `where` present on the record with an equal value, compared as text. */
/** Every key in `where` matched by the record: see `same`. */
export function matches(record: Record<string, unknown>, where?: Record<string, unknown>): boolean {
    return !where || same(record, where);
}

/**
 * Whether a value is what was asked for. Scalars compare as text (a path
 * segment is text, the stored id may be a number); an object asks for a subset
 * of the same shape; a list asks for every item it names; and a scalar asked
 * of a list asks whether the list holds it — `{ labelIds: 'INBOX' }` finds the
 * messages labelled INBOX.
 */
export function same(actual: unknown, wanted: unknown): boolean {
    if (wanted !== null && typeof wanted === 'object') {
        if (Array.isArray(wanted)) {
            return Array.isArray(actual) && wanted.every((w) => actual.some((a) => same(a, w)));
        }
        return (
            actual !== null &&
            typeof actual === 'object' &&
            Object.entries(wanted).every(([k, v]) =>
                same((actual as Record<string, unknown>)[k], v),
            )
        );
    }
    if (Array.isArray(actual)) {
        return actual.some((a) => same(a, wanted));
    }
    return actual !== undefined && String(actual) === String(wanted);
}

/**
 * The one paging rule, written once rather than by every handler: the token is
 * the next offset, it strictly advances, and it is absent on the last page. A
 * token that cannot be read is the end of the list, never the start of it.
 */
export function page<T>(items: readonly T[], options: PageOptions): Page<T> {
    const size = clampSize(options.size, options.defaultSize ?? 10);
    let start = 0;
    if (options.token !== undefined && options.token !== null && options.token !== '') {
        const decoded = decodeToken(String(options.token));
        start = decoded === undefined ? items.length : decoded;
    } else if (options.offset !== undefined && options.offset !== null && options.offset !== '') {
        const n = Number(options.offset);
        start = Number.isFinite(n) && n >= 0 ? Math.floor(n) : items.length;
    }
    start = Math.min(start, items.length);
    const end = Math.min(start + size, items.length);
    const hasMore = end < items.length;
    return {
        items: items.slice(start, end),
        nextToken: hasMore ? encodeToken(end) : null,
        nextOffset: hasMore ? end : null,
        hasMore,
        total: items.length,
    };
}

function clampSize(asked: unknown, fallback: number): number {
    const n = Number(asked);
    return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 500) : fallback;
}

const encodeToken = (offset: number): string =>
    Buffer.from(JSON.stringify({ o: offset })).toString('base64url');

function decodeToken(token: string): number | undefined {
    try {
        const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as {
            o?: unknown;
        };
        return typeof parsed.o === 'number' && parsed.o >= 0 ? parsed.o : undefined;
    } catch {
        return undefined;
    }
}

/** Some documents write a pattern as a JavaScript literal, slashes and all. */
const stripSlashes = (pattern: string): string => {
    const m = /^\/(.*)\/[a-z]*$/.exec(pattern);
    return m ? m[1]! : pattern;
};

function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
