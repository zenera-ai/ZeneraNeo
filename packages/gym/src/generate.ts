import { loose, tool, type AnyTool, type Model } from '@zenera/neo';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import RandExp from 'randexp';
import { runAgent } from './agents.ts';
import type { Bindings } from './bindings.ts';
import type { Box } from './box.ts';
import type { Catalog } from './catalog.ts';
import { ACCOUNTS, OWNER_TYPE, type Binding, type HandlerRequest, type Use } from './runtime.ts';
import { tokenOf, type Paging } from './paging.ts';
import { echoIssues, nextPage, probesFor, walkStart } from './probe.ts';
import { brief, repairBrief, retryNudge, SYSTEM, type Repair } from './prompt.ts';
import { properties } from './schema.ts';
import { called, type Operation } from './spec.ts';
import type { World } from './synth.ts';
import { describeIssues, issues, type Checks } from './validate.ts';

// ---------------------------------------------------------------------------
// Writing a handler
//
// An agent with tools rather than a prompt with a retry loop. It can look
// before it writes — the operations around this one, the handlers already
// written for them, the collections the world already holds, any type it was
// not shown — and that is what makes `getMessage` read the collection
// `listMessages` filled instead of inventing its own.
//
// It cannot decide it is finished. `test_handler` is the judge: it runs the
// module against probe requests in a throwaway copy of the world and reports
// everything wrong with the answers, and the first test that passes ends the
// run. The judgement is deliberately harsher than the schema — a body can
// validate and still be about somebody else (the echo rule), or validate and
// page forever (the walk).
// ---------------------------------------------------------------------------

/** Failed tests per build before giving up. */
export const DEFAULT_ATTEMPTS = 5;

/** How many times a run that stopped without passing is started again. */
const RESTARTS = 2;

export interface BuildOptions {
    model: Model;
    box: Box;
    checks: Checks;
    catalog: Catalog;
    world: World;
    /** where each type lives; a passing handler adds the ones it was first to use */
    bindings: Bindings;
    /** every operation being served, for siblings and list_operations */
    operations: readonly Operation[];
    /** the cached handler of another operation, if one has been written */
    sourceOf: (operation: Operation) => Promise<string | undefined>;
    attempts?: number;
    /** where HTML reports of agent runs go */
    reportDir?: string;
    /** Maximum pages to validate when walking a paginated handler. */
    paginationWalkPages?: number;
    /** Target pagination for this operation, when explicitly configured. */
    longPagination?: {
        pages: number;
        pageSize: number;
    };
    // Awaited: the next test overwrites the file this one was judged on.
    onAttempt?: (
        attempt: number,
        diagnostics: readonly string[],
        source: string,
        limit: number,
    ) => void | Promise<void>;
    signal?: AbortSignal;
}

export interface Built {
    source: string;
    attempts: number;
    report?: string;
    /** where the handler stores each type it uses: part of its identity */
    bindings: Record<string, Binding>;
}

export class BuildFailed extends Error {
    readonly operation: Operation;
    readonly diagnostics: readonly string[];
    /** the build report on disk, filled in by whoever was writing one */
    dump?: string;
    /** the agent's HTML run report */
    report?: string;

    constructor(operation: Operation, diagnostics: readonly string[]) {
        super(
            `could not write a handler for ${operation.method.toUpperCase()} ${called(operation)}`,
        );
        this.name = 'BuildFailed';
        this.operation = operation;
        this.diagnostics = diagnostics;
    }
}

/**
 * Why something failed, in one line, including the part that is usually hidden.
 *
 * `fetch failed` is undici's word for a dozen different problems — a DNS
 * miss, a refused connection, a TLS error, a timeout — and which one it was is
 * only ever in `cause`.
 */
export function reason(err: unknown): string {
    if (err instanceof BuildFailed && err.diagnostics.length > 0) {
        return `${err.message}: ${err.diagnostics.join(' ')}`;
    }
    const parts: string[] = [];
    const seen = new Set<unknown>();
    let at: unknown = err;

    while (at instanceof Error && !seen.has(at)) {
        seen.add(at);
        const e = at as Error & { code?: string; status?: number; statusCode?: number };
        const head = [e.status ?? e.statusCode, e.code].filter(Boolean).join(' ');
        const line = `${head} ${e.message.split('\n')[0].trim()}`.trim();
        if (line && !parts.includes(line)) {
            parts.push(line);
        }
        at = e.cause;
    }
    const hint = (err as { hint?: unknown } | undefined)?.hint;
    if (typeof hint === 'string' && hint) {
        parts.push(hint);
    }
    return parts.join(' — ') || String(err);
}

/** Writes the handler for an operation, or repairs the one it has. */
export async function build(
    operation: Operation,
    opts: BuildOptions,
    repair?: Repair,
): Promise<Built> {
    const limit = Math.max(1, opts.attempts ?? DEFAULT_ATTEMPTS);
    const state = {
        bindings: {} as Record<string, Binding>,
        failures: 0,
        passed: undefined as string | undefined,
        last: [] as string[],
        lastSource: '',
    };
    let report: string | undefined;

    const intro = [
        brief(operation, {
            catalog: opts.catalog,
            siblings: await siblings(operation, opts),
            collections: opts.world.store.collections(),
            bindings: opts.bindings.all(),
            passages: await opts.world.knowledge.recall(
                [
                    operation.summary,
                    operation.operationId,
                    `${operation.method.toUpperCase()} ${operation.path}`,
                ]
                    .filter(Boolean)
                    .join(' — '),
                3,
            ),
            longPagination: opts.longPagination,
        }),
        ...(repair ? ['', repairBrief(repair)] : []),
    ].join('\n');

    for (let run = 0; run <= RESTARTS && !state.passed && state.failures < limit; run++) {
        const input =
            run === 0
                ? intro
                : [
                      intro,
                      '',
                      'YOUR LAST VERSION:',
                      '```ts',
                      state.lastSource,
                      '```',
                      '',
                      retryNudge(state.last.length > 0 ? state.last : ['- it was never tested']),
                  ].join('\n');
        const done = await runAgent({
            model: opts.model,
            name: 'builder',
            label: operation.operationId,
            instructions: SYSTEM,
            tools: tools(operation, opts, state, limit),
            input,
            maxToolCalls: limit * 3 + 10,
            done: () => Boolean(state.passed) || state.failures >= limit,
            reportDir: opts.reportDir,
            signal: opts.signal,
        });
        report = done.report ?? report;
    }

    if (state.passed) {
        return {
            source: state.passed,
            attempts: Math.max(1, state.failures + 1),
            report,
            bindings: state.bindings,
        };
    }
    const failed = new BuildFailed(
        operation,
        state.last.length > 0 ? state.last : ['the agent stopped without testing a handler'],
    );
    failed.report = report;
    throw failed;
}

function tools(
    operation: Operation,
    opts: BuildOptions,
    state: {
        failures: number;
        passed?: string;
        last: string[];
        lastSource: string;
        bindings: Record<string, Binding>;
    },
    limit: number,
): AnyTool[] {
    const listOperations = tool<{ path?: string; name?: string }>({
        name: 'list_operations',
        description:
            'Operations this server answers, with whether each already has a handler. ' +
            'Filter by path (e.g. "/users/*/messages*") or by operationId.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'A substring, or a glob with * and ?.' },
                name: { type: 'string', description: 'A substring of the operationId.' },
            },
            additionalProperties: false,
        },
        execute: async ({ path, name }) => {
            const byPath = path ? loose(path) : undefined;
            const byName = name ? loose(name) : undefined;
            const found = opts.operations.filter(
                (o) => (!byPath || byPath(o.path)) && (!byName || byName(o.operationId)),
            );
            const rows = await Promise.all(
                found.slice(0, 80).map(async (o) => {
                    const built = Boolean(await opts.sourceOf(o));
                    return `${built ? '[built]' : '[     ]'} ${o.method.toUpperCase()} ${called(o)}  ${o.operationId}`;
                }),
            );
            return { found: found.length, operations: rows };
        },
    });

    const readHandler = tool<{ operationId: string }>({
        name: 'read_handler',
        description:
            'The handler already written for another operation. Read the siblings of this ' +
            'operation before writing it, and use the same collections and types they use.',
        parameters: {
            type: 'object',
            properties: { operationId: { type: 'string' } },
            required: ['operationId'],
            additionalProperties: false,
        },
        execute: async ({ operationId }) => {
            const other = opts.operations.find((o) => o.operationId === operationId);
            if (!other) {
                return {
                    error: `no operation called ${operationId}`,
                    hint: 'call list_operations',
                };
            }
            const source = await opts.sourceOf(other);
            return source ? { source } : { error: `${operationId} has no handler yet` };
        },
    });

    const listCollections = tool<Record<string, never>>({
        name: 'list_collections',
        description: 'The collections the world holds, with record counts and sample ids.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: () => ({ collections: opts.world.store.collections() }),
    });

    const readCollection = tool<{ collection: string; limit?: number }>({
        name: 'read_collection',
        description: 'A few records from a collection, to see the shape stored there.',
        parameters: {
            type: 'object',
            properties: {
                collection: { type: 'string' },
                limit: { type: 'integer', description: 'Default 3.' },
            },
            required: ['collection'],
            additionalProperties: false,
        },
        execute: ({ collection, limit }) => {
            const col = opts.world.store.collection(collection);
            const text = JSON.stringify(col.all().slice(0, Math.min(limit ?? 3, 10)));
            return {
                total: col.count(),
                records: text.length > 12_000 ? `${text.slice(0, 12_000)}…` : JSON.parse(text),
            };
        },
    });

    const describeTypes = tool<{ names: string[] }>({
        name: 'describe_types',
        description: 'Schema types by name, as TypeScript, with everything they refer to.',
        parameters: {
            type: 'object',
            properties: { names: { type: 'array', items: { type: 'string' } } },
            required: ['names'],
            additionalProperties: false,
        },
        execute: ({ names }) => {
            const { code, omitted } = opts.catalog.declare(names, 30_000);
            return code
                ? { typescript: code, ...(omitted.length ? { omitted } : {}) }
                : { error: `no such type: ${names.join(', ')}` };
        },
    });

    const testHandler = tool<{ source: string }>({
        name: 'test_handler',
        description:
            'Saves the handler module and judges it: runs it against probe requests in a ' +
            'copy of the world, checks every answer against the response schema, the echo ' +
            'rule and, for paged operations, that the pages advance and end. Returns ok, or ' +
            'every problem found.',
        parameters: {
            type: 'object',
            properties: {
                source: { type: 'string', description: 'The whole TypeScript module.' },
            },
            required: ['source'],
            additionalProperties: false,
        },
        execute: async ({ source }) => {
            if (state.passed || state.failures >= limit) {
                return { error: 'the build is over' };
            }
            const code = unfence(String(source ?? ''));
            state.lastSource = code;
            const { problems, placed } = code.trim()
                ? await test(operation, code, opts)
                : { problems: ['- the module is empty'], placed: {} };
            if (problems.length === 0) {
                // Bound only on a pass: a failing handler must not fix where a
                // type lives for everyone after it.
                for (const [type, binding] of Object.entries(placed)) {
                    opts.bindings.bind(type, binding);
                }
                state.passed = code;
                state.bindings = placed;
                return { ok: true };
            }
            state.failures++;
            state.last = problems;
            await opts.onAttempt?.(state.failures, problems, code, limit);
            return {
                ok: false,
                problems,
                testsLeft: Math.max(0, limit - state.failures),
            };
        },
    });

    return [
        listOperations,
        readHandler,
        listCollections,
        readCollection,
        describeTypes,
        ...opts.catalog.tools(),
        ...opts.world.knowledge.tools,
        testHandler,
    ];
}

/** Writes the module and judges it in a copy of the world nobody else can see. */
async function test(
    operation: Operation,
    source: string,
    opts: BuildOptions,
): Promise<{ problems: string[]; placed: Record<string, Binding> }> {
    await opts.box.write(operation.key, source);
    const scratch = join(
        opts.box.root,
        'scratch',
        `${operation.key}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sqlite`,
    );
    opts.world.store.snapshot(scratch);
    try {
        const used: Use[] = [];
        const problems = await judge(operation, opts, scratch, used);
        const { problems: misplaced, placed } = placement(used, opts);
        return { problems: [...problems, ...misplaced], placed };
    } finally {
        opts.box.release(scratch);
        opts.world.release(scratch);
        for (const suffix of ['', '-wal', '-shm']) {
            rmSync(`${scratch}${suffix}`, { force: true });
        }
    }
}

async function judge(
    operation: Operation,
    opts: BuildOptions,
    db: string,
    used: Use[],
): Promise<string[]> {
    const response = opts.checks.for(operation).response;
    const out: string[] = [];

    for (const probe of fitted(operation, probesFor(operation))) {
        const outcome = await opts.box.run(operation.key, probe, { db, probe: true });
        used.push(...(outcome.used ?? []));
        const what = `request ${JSON.stringify({ pathParams: probe.pathParams, query: probe.query, ...(probe.body !== undefined ? { body: probe.body } : {}) }).slice(0, 600)}`;
        if (!outcome.ok) {
            out.push(`- ${what}: the handler ${outcome.fault}.`);
            if (outcome.stderr) {
                out.push(`  stack: ${tail(outcome.stderr)}`);
            }
            break;
        }
        if (outcome.status !== undefined) {
            out.push(
                `- ${what}: answered HTTP ${outcome.status} ${JSON.stringify(outcome.value).slice(0, 200)}. ` +
                    'An ordinary request must get a body: make missing content with ctx.lookup / ctx.ensure instead of failing.',
            );
            continue;
        }
        if (response && !response(outcome.value)) {
            out.push(
                `- ${what}: the answer does not match the response schema — ${describeIssues(issues('', response.errors))}. ` +
                    `It answered: ${JSON.stringify(outcome.value).slice(0, 400)}`,
            );
        }
        const echo = echoIssues(probe, outcome.value, operation.success.schema);
        if (echo.length > 0) {
            out.push(`- ${what}: ${describeIssues(echo)}.`);
        }
    }
    if (out.length === 0 && operation.paging?.next) {
        out.push(...(await walk(operation, operation.paging, opts, db, used)));
    }
    return out;
}

/**
 * Probe path values that the response would have to echo, made to fit the
 * response's own pattern. Asking for message `ada` when ids are sixteen hex
 * digits is a test no handler can pass.
 */
function fitted(operation: Operation, probes: HandlerRequest[]): HandlerRequest[] {
    const schema = operation.success.schema;
    if (!schema) {
        return probes;
    }
    const patterned = new Map<string, string>();
    for (const p of properties(schema)) {
        if (typeof p.schema.pattern === 'string' && !patterned.has(p.name)) {
            patterned.set(p.name, p.schema.pattern);
        }
    }
    return probes.map((probe, i) => {
        const pathParams = { ...probe.pathParams };
        for (const name of Object.keys(pathParams)) {
            const pattern = patterned.get(name);
            if (pattern) {
                try {
                    const gen = new RandExp(pattern);
                    gen.max = 6;
                    let n = i + 7;
                    gen.randInt = (a, b) => a + ((n = (n * 48271) % 2147483647) % (b - a + 1));
                    pathParams[name] = gen.gen();
                } catch {
                    // an unreadable pattern keeps the plain probe value
                }
            }
        }
        return { ...probe, pathParams };
    });
}

/**
 * Where the handler put each type it touched, checked against where every
 * handler before it put them. Untyped access is refused outright: a collection
 * nobody can name a type for is a collection the next handler cannot find.
 */
function placement(
    used: readonly Use[],
    opts: BuildOptions,
): { problems: string[]; placed: Record<string, Binding> } {
    const problems = new Set<string>();
    const byType = new Map<string, { collections: Set<string>; idFields: Set<string> }>();
    for (const use of used) {
        if (use.collection === ACCOUNTS || use.type === OWNER_TYPE) {
            continue;
        }
        if (!use.type) {
            problems.add(
                `- \`${use.collection}\` is used without a type. Name the type instead — ` +
                    `ctx.lookup('Message', id), ctx.ensure('Message', …), ctx.db.collection('Message') — ` +
                    'so every handler finds the same records in the same place.',
            );
            continue;
        }
        if (!opts.catalog.hasType(use.type)) {
            problems.add(
                `- \`${use.type}\` is not a type the documents declare; ` +
                    'describe_types, list_api or grep_api finds the right name.',
            );
            continue;
        }
        const seen = byType.get(use.type) ?? { collections: new Set(), idFields: new Set() };
        seen.collections.add(use.collection);
        if (use.idField) {
            seen.idFields.add(use.idField);
        }
        byType.set(use.type, seen);
    }

    const placed: Record<string, Binding> = {};
    for (const [type, seen] of byType) {
        if (seen.collections.size > 1 || seen.idFields.size > 1) {
            problems.add(
                `- \`${type}\` is stored two ways in this handler ` +
                    `(${[...seen.collections].join(', ')}; keyed by ${[...seen.idFields].join(', ') || 'id'}). ` +
                    'Use one type name and one id field throughout.',
            );
            continue;
        }
        const binding: Binding = {
            collection: [...seen.collections][0]!,
            idField: [...seen.idFields][0] ?? opts.bindings.of(type)?.idField ?? 'id',
        };
        const conflict = opts.bindings.conflict(type, binding);
        if (conflict) {
            problems.add(
                `- ${conflict} — fixed by an earlier handler. Use the type name ` +
                    `(ctx.lookup('${type}', …)) and leave the collection and id field to the binding.`,
            );
            continue;
        }
        placed[type] = binding;
    }
    return { problems: [...problems], placed };
}

function pagedItems(value: unknown, name: string): unknown[] | undefined {
    const seen = new Set<object>();
    const queue: unknown[] = [value];

    while (queue.length > 0) {
        const node = queue.shift();

        if (typeof node !== 'object' || node === null || seen.has(node)) {
            continue;
        }

        seen.add(node);

        if (Array.isArray(node)) {
            continue;
        }

        const record = node as Record<string, unknown>;
        const items = record[name];

        if (Array.isArray(items)) {
            return items;
        }

        queue.push(...Object.values(record));
    }

    return undefined;
}

/** How many pages a judged handler may offer before it is not terminating. */
const MAX_PAGES = 8;

async function walk(
    operation: Operation,
    paging: Paging,
    opts: BuildOptions,
    db: string,
    used: Use[],
): Promise<string[]> {
    let input = walkStart(operation, paging);
    const seen = new Set<string>();
    let sent: string | undefined;
    const targetPages = opts.longPagination?.pages;
    const maxPages = targetPages ?? opts.paginationWalkPages ?? MAX_PAGES;
    const pageSize = opts.longPagination?.pageSize ?? 2;

    // Enough content to need more than one page, so the token is exercised.
    if (paging.size) {
        input = setSize(input, paging, pageSize);
    }

    for (let page = 1; page <= maxPages; page++) {
        const outcome = await opts.box.run(operation.key, input, { db, probe: true });
        used.push(...(outcome.used ?? []));
        const what = `page ${page} of ${operation.method.toUpperCase()} ${called(operation)}`;
        if (!outcome.ok) {
            return [`- ${what}: the handler ${outcome.fault}.`];
        }
        const response = opts.checks.for(operation).response;
        if (response && !response(outcome.value)) {
            return [
                `- ${what}: the answer does not match the response schema — ${describeIssues(issues('', response.errors))}.`,
            ];
        }

        if (targetPages !== undefined) {
            if (!paging.items) {
                return [
                    `- ${what}: cannot validate long pagination page size ` +
                        'because the paginated items property is unknown.',
                ];
            }

            const items = pagedItems(outcome.value, paging.items);

            if (!items) {
                return [
                    `- ${what}: could not find paginated items ` + `in property "${paging.items}".`,
                ];
            }

            if (items.length !== pageSize) {
                return [
                    `- ${what}: expected ${pageSize} records per page, ` +
                        `but received ${items.length}.`,
                ];
            }
        }

        const token = tokenOf(outcome.value, paging);
        if (token === undefined) {
            if (targetPages !== undefined && page !== targetPages) {
                return [
                    `- ${what}: long pagination requires ${targetPages} pages, ` +
                        `but the handler terminated after ${page}.`,
                ];
            }

            return [];
        }
        if (token === sent) {
            return [
                `- ${what}: \`${paging.next}\` came back as ${JSON.stringify(token)}, the token the request sent in \`${paging.param}\`. Pass the client's token to ctx.page and answer with its nextToken.`,
            ];
        }
        if (seen.has(token)) {
            return [
                `- ${what}: the page tokens cycle — ${JSON.stringify(token)} was handed out before.`,
            ];
        }
        seen.add(token);
        sent = token;
        input = nextPage(input, paging, token);
    }
    if (targetPages !== undefined) {
        return [
            `- ${operation.method.toUpperCase()} ${operation.path}: ` +
                `long pagination requires termination on page ${targetPages}, ` +
                `but the continuation token is still present.`,
        ];
    }

    return [
        `- ${operation.method.toUpperCase()} ${operation.path}: ` +
            `the pages never run out — after ${maxPages} of them ` +
            `\`${paging.next}\` is still set. Page with ctx.page so the list ends.`,
    ];
}

function setSize(input: HandlerRequest, paging: Paging, size: number): HandlerRequest {
    if (!paging.size) {
        return input;
    }
    if (paging.paramIn === 'body' && typeof input.body === 'object' && input.body !== null) {
        return { ...input, body: { ...(input.body as object), [paging.size]: size } };
    }
    return { ...input, query: { ...input.query, [paging.size]: String(size) } };
}

/** Operations sharing this one's resource path, or a response type with it. */
/**
 * The operations a handler must agree with, closest first. Same record type and
 * same resource are the strongest ties; operations that merely carry the type
 * somewhere (traced through the graph) come next; nearby paths last. In a large
 * API the list is cut, and the cut must fall on the weakest.
 */
async function siblings(
    operation: Operation,
    opts: BuildOptions,
): Promise<{ operation: Operation; built: boolean; type?: string }[]> {
    const base = resourceOf(operation.path);
    const mine = opts.catalog.itemType(operation);
    const carriers = new Set(
        (mine ? opts.catalog.carriers(mine) : []).map((c) => `${c.method} ${c.path}`),
    );
    const scored = opts.operations
        .filter((o) => o !== operation)
        .map((o) => {
            const type = opts.catalog.itemType(o);
            const other = resourceOf(o.path);
            const score =
                (mine && type === mine ? 4 : 0) +
                (other === base ? 3 : 0) +
                (carriers.has(`${o.method} ${o.path}`) ? 2 : 0) +
                (near(o.path, base) ? 1 : 0);
            return { operation: o, type, score };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score || a.operation.path.localeCompare(b.operation.path))
        .slice(0, 25);
    return Promise.all(
        scored.map(async ({ operation: o, type }) => ({
            operation: o,
            type,
            built: Boolean(await opts.sourceOf(o)),
        })),
    );
}

/** One or two segments above or below. */
function near(path: string, base: string): boolean {
    const depth = (p: string): number => p.split('/').filter(Boolean).length;
    const [short, long] = path.length < base.length ? [path, base] : [base, path];
    return long.startsWith(`${short}/`) && depth(long) - depth(short) <= 2;
}

/** `/users/{userId}/messages/{id}` → `/users/{userId}/messages`. */
const resourceOf = (path: string): string => path.replace(/\/\{[^/]+\}$/, '') || '/';

/**
 * Models fence code even when told not to, and a stray ```ts line is a syntax
 * error rather than a bad answer — not worth a round trip.
 */
export function unfence(text: string): string {
    const trimmed = text.trim();
    if (!trimmed.startsWith('```')) {
        return trimmed;
    }
    const body = trimmed.slice(trimmed.indexOf('\n') + 1);
    const close = body.lastIndexOf('```');
    return (close === -1 ? body : body.slice(0, close)).trimEnd();
}

const tail = (s: string): string => s.trim().split('\n').slice(0, 6).join('\n  ');
