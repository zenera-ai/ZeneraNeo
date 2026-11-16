import { randomInt } from 'node:crypto';
import { properties, type Declared, type Schema } from './schema.ts';
import type { ParamSpec } from './spec.ts';

// ---------------------------------------------------------------------------
// Pages
//
// A mock that answers `?cursor=X` with `cursor: X` validates against its schema,
// echoes nothing it should not, and still hangs every client that walks it —
// the same class of wrong as the echo rule, and invisible for the same reason.
// Termination is not a property of one response, so no check on one response can
// see it.
//
// What lives here is only the *recognition*: which query parameter turns the
// page and which property carries the token for the next one. The handler
// still mints its own tokens — the host neither signs nor reads them — because
// the alternative is the host guessing the shape of somebody's response body
// and overwriting it, and then the handler is no longer the whole answer.
//
// Names, not conventions: there is no `x-pagination` in any of the three
// dialects, so this is a list of the words the world actually uses, matched
// with the punctuation and case squashed out (`next_cursor`, `nextCursor` and
// `next-cursor` are one word).
// ---------------------------------------------------------------------------

export type PagingStyle = 'cursor' | 'offset';

export interface Paging {
    style: PagingStyle;
    /** the parameter that turns the page */
    param: string;
    /** where the parameter lives: 'body' when in request body, absent when in query */
    paramIn?: 'query' | 'body';
    /** the page-size parameter, when the operation takes one */
    size?: string;
    /** the response property carrying the token for the page after this one */
    next?: string;
    /** whether `next` may be set to null */
    nextNullable?: boolean;
    /** whether the object declaring `next` lists it as required */
    nextRequired?: boolean;
    /** a boolean response property — `has_more` and friends */
    more?: string;
    /** the array of things being paged over */
    items?: string;
}

const squash = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');

const CURSOR_PARAMS = new Set([
    'cursor',
    'nextcursor',
    'pagetoken',
    'nextpagetoken',
    'continuationtoken',
    'nexttoken',
    'pagecursor',
    'after',
    'marker',
    'startkey',
]);

const OFFSET_PARAMS = new Set([
    'offset',
    'page',
    'pagenumber',
    'pageindex',
    'start',
    'startindex',
    'skip',
]);

const SIZE_PARAMS = new Set([
    'pagesize',
    'perpage',
    'limit',
    'maxresults',
    'maxitems',
    'count',
    'size',
]);

const NEXT_PROPS = new Set([
    'nextcursor',
    'nextpagetoken',
    'nexttoken',
    'nextoffset',
    'nextpage',
    'nextlink',
    'nexturl',
    'next',
    'cursor',
    'pagetoken',
    'continuationtoken',
    'marker',
]);

const MORE_PROPS = new Set([
    'hasmore',
    'hasnext',
    'hasnextpage',
    'more',
    'islast',
    'islastpage',
    'istruncated',
    'truncated',
]);

const ITEMS_PROPS = new Set([
    'items',
    'results',
    'data',
    'values',
    'records',
    'entries',
    'objects',
    'content',
    'list',
    'edges',
]);

/**
 * The paging shape of an operation, or nothing when it does not page.
 *
 * A page-size parameter on its own is not pagination — plenty of endpoints cap
 * a one-shot list — so a control that turns the page *and* a property that says
 * where the next one is are both required.
 */
export function pagingOf(
    params: readonly ParamSpec[],
    schema: Schema | undefined,
    bodySchema?: Schema | undefined,
): Paging | undefined {
    if (!schema) {
        return undefined;
    }
    const query = params.filter((p) => p.in === 'query');
    const queryCursor = query.find((p) => CURSOR_PARAMS.has(squash(p.name)));
    const queryOffset = query.find((p) => OFFSET_PARAMS.has(squash(p.name)) && numeric(p.schema));

    let bodyCursor: Declared | undefined;
    let bodyOffset: Declared | undefined;
    if (!queryCursor && !queryOffset && bodySchema) {
        const bodyProps = properties(bodySchema);
        bodyCursor = bodyProps.find((p) => CURSOR_PARAMS.has(squash(p.name)));
        bodyOffset = bodyProps.find((p) => OFFSET_PARAMS.has(squash(p.name)) && numeric(p.schema));
    }

    const cursor = queryCursor ?? bodyCursor;
    const offset = queryOffset ?? bodyOffset;
    const param = cursor ?? offset;
    if (!param) {
        return undefined;
    }

    const declared = properties(schema);
    const next = declared.find((d) => NEXT_PROPS.has(squash(d.name)));
    const more = declared.find((d) => MORE_PROPS.has(squash(d.name)) && boolish(d.schema));
    if (!next && !more) {
        return undefined;
    }

    const isBody = Boolean(!queryCursor && !queryOffset && (bodyCursor || bodyOffset));
    const size =
        query.find((p) => SIZE_PARAMS.has(squash(p.name)))?.name ??
        (bodySchema
            ? properties(bodySchema).find((p) => SIZE_PARAMS.has(squash(p.name)))?.name
            : undefined);

    return {
        style: cursor ? 'cursor' : 'offset',
        param: param.name,
        ...(isBody ? { paramIn: 'body' as const } : {}),
        size,
        next: next?.name,
        nextNullable: next ? nullable(next.schema) : undefined,
        nextRequired: next?.required,
        more: more?.name,
        items: itemsOf(declared),
    };
}

/**
 * The paging an actual request reveals, for a document that declared none.
 *
 * Plenty of specs describe the response envelope — `cursor`, `has_more` — and
 * never write down the parameter that reads it back. A client only sends
 * `?cursor=X` because a body handed it X, so the exchange is pagination on the
 * evidence even when the document is silent, and silence is exactly the case
 * nothing else here can catch.
 */
export function pagingSeen(
    params: readonly ParamSpec[],
    schema: Schema | undefined,
    query: Iterable<[string, string]>,
    body?: unknown,
): Paging | undefined {
    const declared = new Set(params.map((p) => p.name));
    const extra: ParamSpec[] = [];
    for (const [name, value] of query) {
        if (value !== '' && !declared.has(name)) {
            declared.add(name);
            extra.push({ name, in: 'query', required: false, schema: guess(value) });
        }
    }
    if (extra.length > 0) {
        const detected = pagingOf([...params, ...extra], schema);
        if (detected) {
            return detected;
        }
    }
    if (isObject(body)) {
        for (const [name, value] of Object.entries(body)) {
            if (value !== null && value !== undefined && value !== '') {
                if (CURSOR_PARAMS.has(squash(name)) || OFFSET_PARAMS.has(squash(name))) {
                    const syntheticBody: Schema = {
                        type: 'object',
                        properties: {
                            [name]: guess(
                                typeof value === 'string' ? value : JSON.stringify(value),
                            ),
                        },
                    };
                    const detected = pagingOf(params, schema, syntheticBody);
                    if (detected) {
                        return detected;
                    }
                }
            }
        }
    }
    return undefined;
}

/** The token a body offers for the next page, or nothing when it offers none. */
export function tokenOf(value: unknown, paging: Paging): string | undefined {
    if (!paging.next) {
        return undefined;
    }
    const holder = holderOf(value, paging.next);
    const token = holder?.[paging.next];
    if (token === null || token === undefined || token === '') {
        return undefined;
    }
    return typeof token === 'object' ? JSON.stringify(token) : String(token);
}

/**
 * A last line of defence, for the handler that is already on disk: a body
 * offering the very token it was given is cut back to "no more pages".
 *
 * Deliberately timid. Nothing re-validates a handler's output on the way to
 * the client, so writing `null` into a required, non-nullable property would
 * trade a client that hangs for a mock that lies — and a hang is at least
 * obvious. Where the schema leaves no room, this changes nothing and says so.
 */
export function cutLoop(value: unknown, paging: Paging, sent: string): boolean {
    if (!paging.next || tokenOf(value, paging) !== sent) {
        return false;
    }
    const holder = holderOf(value, paging.next);
    if (!holder) {
        return false;
    }
    if (paging.nextNullable) {
        holder[paging.next] = null;
    } else if (!paging.nextRequired) {
        delete holder[paging.next];
    } else {
        return false;
    }
    const more = paging.more ? holderOf(value, paging.more) : undefined;
    if (more && paging.more) {
        more[paging.more] = false;
    }
    return true;
}

/**
 * Terminates pagination unconditionally on a response object: nullifies or deletes
 * the next token if allowed, or empties items if the token is required non-nullable.
 */
export function cutPaging(value: unknown, paging: Paging): boolean {
    let cut = false;
    if (paging.next) {
        const holder = holderOf(value, paging.next);
        if (holder) {
            if (paging.nextNullable) {
                holder[paging.next] = null;
                cut = true;
            } else if (!paging.nextRequired) {
                delete holder[paging.next];
                cut = true;
            } else if (paging.items) {
                const itemsHolder = holderOf(value, paging.items);
                if (itemsHolder && Array.isArray(itemsHolder[paging.items])) {
                    itemsHolder[paging.items] = [];
                    cut = true;
                }
            }
        }
    }
    if (paging.more) {
        const moreHolder = holderOf(value, paging.more);
        if (moreHolder) {
            moreHolder[paging.more] = false;
            cut = true;
        }
    }
    return cut;
}

/** Sets the items array to empty and sets more to false. */
export function emptyItems(value: unknown, paging: Paging): boolean {
    let cut = false;
    if (paging.items) {
        const itemsHolder = holderOf(value, paging.items);
        if (itemsHolder && Array.isArray(itemsHolder[paging.items])) {
            itemsHolder[paging.items] = [];
            cut = true;
        }
    }
    if (paging.next) {
        const holder = holderOf(value, paging.next);
        if (holder) {
            if (paging.nextNullable) {
                holder[paging.next] = null;
                cut = true;
            } else if (!paging.nextRequired) {
                delete holder[paging.next];
                cut = true;
            }
        }
    }
    if (paging.more) {
        const moreHolder = holderOf(value, paging.more);
        if (moreHolder) {
            moreHolder[paging.more] = false;
            cut = true;
        }
    }
    return cut;
}

/** Retrieves the sent pagination token from query parameters or request body. */
export function getSentToken(
    query: URLSearchParams,
    body: unknown,
    paging: Paging,
): string | undefined {
    if (paging.paramIn === 'body' && isObject(body)) {
        const val = body[paging.param];
        if (val !== undefined && val !== null && val !== '') {
            return typeof val === 'object' ? JSON.stringify(val) : String(val);
        }
    }
    const qVal = query.get(paging.param);
    if (qVal !== null && qVal !== '') {
        return qVal;
    }
    if (isObject(body)) {
        const val = body[paging.param];
        if (val !== undefined && val !== null && val !== '') {
            return typeof val === 'object' ? JSON.stringify(val) : String(val);
        }
        if (paging.next) {
            const nextVal = body[paging.next];
            if (nextVal !== undefined && nextVal !== null && nextVal !== '') {
                return typeof nextVal === 'object' ? JSON.stringify(nextVal) : String(nextVal);
            }
        }
    }
    return undefined;
}

/** Decodes the 1-based page index from base64 JSON token `{"p": n}` if present. */
export function parsePageFromToken(
    token: string,
    style: PagingStyle = 'cursor',
): number | undefined {
    if (style !== 'cursor') {
        return undefined;
    }
    try {
        const decoded = Buffer.from(token, 'base64').toString('utf8');
        const parsed = JSON.parse(decoded);
        if (typeof parsed?.p === 'number') return parsed.p;
        if (typeof parsed?.page === 'number') return parsed.page;
    } catch {
        // Not base64 JSON
    }
    return undefined;
}

export interface PaginationCutResult {
    cut: boolean;
    reason: string;
}

interface ActiveToken {
    operationKey: string;
    page: number;
    maxPages: number;
    seenTokens: Set<string>;
    streamKey: string;
    terminated?: boolean;
    createdAt: number;
}

function tokenStateKey(operationKey: string, streamKey: string, token: string): string {
    return JSON.stringify([operationKey, streamKey, token]);
}

/**
 * Tracks active pagination streams to bound iterations and prevent infinite loops.
 *
 * Randomly bounds pagination to 1-10 pages by default, intercepts cycle loops and
 * echoed tokens, and empties responses when clients loop past the end.
 */
export class PaginationLimiter {
    readonly #tokens = new Map<string, ActiveToken>();
    readonly #maxPagesFactory: (operationKey: string) => number;
    readonly #maxEntries: number;

    constructor(
        maxPages: number | ((operationKey: string) => number) = () => randomInt(1, 11),
        maxEntries = 5000,
    ) {
        this.#maxPagesFactory = typeof maxPages === 'function' ? maxPages : () => maxPages;

        this.#maxEntries = maxEntries;
    }

    process(
        operationKey: string,
        streamKey: string,
        sent: string | undefined,
        value: unknown,
        paging: Paging,
    ): PaginationCutResult | undefined {
        this.#prune();
        const nextToken = tokenOf(value, paging);
        const keyOf = (token: string): string => tokenStateKey(operationKey, streamKey, token);

        // Case 1: First page (no cursor sent)
        if (sent === undefined) {
            const maxPages = Math.max(1, this.#maxPagesFactory(operationKey));
            if (maxPages === 1) {
                if (nextToken !== undefined) {
                    cutPaging(value, paging);
                    return { cut: true, reason: 'cut pagination at max pages (1)' };
                }
                return undefined;
            }
            if (nextToken !== undefined) {
                this.#tokens.set(keyOf(nextToken), {
                    operationKey,
                    page: 2,
                    maxPages,
                    seenTokens: new Set([nextToken]),
                    streamKey,
                    createdAt: Date.now(),
                });
            }
            return undefined;
        }

        // Case 2: Cursor was sent
        const state = this.#tokens.get(keyOf(sent));

        // Subcase 2A: Re-requesting an already-terminated token
        if (state?.terminated) {
            emptyItems(value, paging);
            return {
                cut: true,
                reason: `cut pagination at max pages (${state.maxPages})`,
            };
        }

        // Subcase 2B: Echo loop (server returned the exact token that was sent)
        if (nextToken !== undefined && nextToken === sent) {
            const didCut = cutLoop(value, paging, sent);
            if (state) {
                state.terminated = true;
            }
            if (didCut) {
                return { cut: true, reason: 'cut a looping page token' };
            }
            // Where the schema leaves no room to null or delete, leave alone
            return undefined;
        }

        // Subcase 2C: Cycle loop (server returned a token seen earlier in this stream)
        if (state && nextToken !== undefined && state.seenTokens.has(nextToken)) {
            cutPaging(value, paging);
            state.terminated = true;
            return { cut: true, reason: 'cut a cycling page token' };
        }

        // Subcase 2D: Tracked stream reached maxPages
        if (state) {
            if (state.page >= state.maxPages) {
                cutPaging(value, paging);
                state.terminated = true;
                if (nextToken !== undefined) {
                    this.#tokens.set(keyOf(nextToken), {
                        operationKey,
                        page: state.page + 1,
                        maxPages: state.maxPages,
                        seenTokens: state.seenTokens,
                        streamKey,
                        terminated: true,
                        createdAt: Date.now(),
                    });
                }
                return {
                    cut: true,
                    reason: `cut pagination at max pages (${state.maxPages})`,
                };
            }

            // Not yet at maxPages: advance to next page
            if (nextToken !== undefined) {
                state.seenTokens.add(nextToken);
                this.#tokens.set(keyOf(nextToken), {
                    operationKey,
                    page: state.page + 1,
                    maxPages: state.maxPages,
                    seenTokens: state.seenTokens,
                    streamKey,
                    createdAt: Date.now(),
                });
            }
            return undefined;
        }

        // Subcase 2E: Untracked token (first time seen)
        const decodedPage = parsePageFromToken(sent, paging.style);
        if (decodedPage !== undefined) {
            const maxPages = Math.max(decodedPage, this.#maxPagesFactory(operationKey));
            if (decodedPage >= maxPages) {
                cutPaging(value, paging);
                return {
                    cut: true,
                    reason: `cut pagination at max pages (${maxPages})`,
                };
            }
            if (nextToken !== undefined) {
                this.#tokens.set(keyOf(nextToken), {
                    operationKey,
                    page: decodedPage + 1,
                    maxPages,
                    seenTokens: new Set([sent, nextToken]),
                    streamKey,
                    createdAt: Date.now(),
                });
            }
            return undefined;
        }

        // Untracked arbitrary string token (e.g. 'page-1' in server.test.ts)
        const maxPages = Math.max(2, this.#maxPagesFactory(operationKey));
        if (nextToken !== undefined) {
            this.#tokens.set(keyOf(nextToken), {
                operationKey,
                page: 2,
                maxPages,
                seenTokens: new Set([sent, nextToken]),
                streamKey,
                createdAt: Date.now(),
            });
        }
        return undefined;
    }

    #prune(): void {
        const now = Date.now();
        for (const [token, entry] of this.#tokens) {
            if (now - entry.createdAt > 10 * 60 * 1000) {
                this.#tokens.delete(token);
            }
        }
        while (this.#tokens.size > this.#maxEntries) {
            const first = this.#tokens.keys().next().value;
            if (first !== undefined) {
                this.#tokens.delete(first);
            } else {
                break;
            }
        }
    }
}

/** The nearest object carrying `name`; a real body nests its envelope. */
function holderOf(value: unknown, name: string): Record<string, unknown> | undefined {
    const seen = new Set<object>();
    let level: unknown[] = [value];

    while (level.length > 0) {
        const next: unknown[] = [];
        for (const node of level) {
            if (typeof node !== 'object' || node === null || seen.has(node)) {
                continue;
            }
            seen.add(node);
            if (Array.isArray(node)) {
                next.push(...node);
                continue;
            }
            const record = node as Record<string, unknown>;
            if (name in record) {
                return record;
            }
            next.push(...Object.values(record));
        }
        level = next;
    }
    return undefined;
}

function itemsOf(declared: readonly Declared[]): string | undefined {
    const named = declared.find((d) => ITEMS_PROPS.has(squash(d.name)) && listish(d.schema));
    return (named ?? declared.find((d) => listish(d.schema)))?.name;
}

const types = (schema: Schema): string[] => {
    const type = schema.type;
    return typeof type === 'string' ? [type] : Array.isArray(type) ? (type as string[]) : [];
};

const numeric = (schema: Schema): boolean =>
    types(schema).some((t) => t === 'integer' || t === 'number');

const boolish = (schema: Schema): boolean => types(schema).includes('boolean');

const listish = (schema: Schema): boolean =>
    types(schema).includes('array') || schema.items !== undefined;

const nullable = (schema: Schema): boolean => types(schema).includes('null');

const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

/** An undeclared parameter has only its value to be typed by. */
const guess = (value: string): Schema => ({
    type: /^-?\d+$/.test(value) ? 'integer' : 'string',
});
