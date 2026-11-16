import { tool, type AnyTool, type Model } from '@zenera/neo';
import type { Bindings } from './bindings.ts';
import type { SynthesizeHook } from './box.ts';
import type { Catalog } from './catalog.ts';
import type { HandlerRequest } from './runtime.ts';
import { runAgent } from './agents.ts';
import { sample } from './fake.ts';
import {
    ACCOUNTS,
    collectionFor,
    matches,
    OWNER,
    OWNER_TYPE,
    populatedKey,
    same,
    type SynthesisRequest,
} from './runtime.ts';
import { leaseOwner, WorldStore } from './store.ts';
import type { Knowledge } from './knowledge.ts';

// ---------------------------------------------------------------------------
// The world agent
//
// Handlers know where content lives; this is where it comes from. A handler
// that finds the world empty — no messages yet, no event with that id — asks
// for records, and an agent writes them: reading the story, reading what the
// world already holds so the same people keep the same addresses across APIs,
// and saving records that are checked against the schema before anything can
// read them. What it saves is permanent, so the second request sees the first
// request's world.
//
// Judging a handler asks for content too, and gets `fake.ts` instead: a probe
// is about mechanics, and an agent call per probe would make every build slow
// and every build cost.
// ---------------------------------------------------------------------------

/**
 * Accounts are the one collection no document declares: who `me` is, and who
 * everyone else is, shared by every API in the world. So their shape is ours.
 */
const ACCOUNT_SCHEMA = {
    type: 'object',
    required: ['id', 'email', 'displayName'],
    properties: {
        id: {
            type: 'string',
            description: `"${OWNER}" for the account the API is called as; otherwise the email`,
        },
        email: { type: 'string', format: 'email' },
        displayName: { type: 'string' },
        timeZone: { type: 'string', description: 'IANA zone, e.g. Europe/Berlin' },
    },
};

const ACCOUNT_DECLARATION = `interface Account {
    /** "${OWNER}" for the account the API is called as; otherwise the email */
    id: string;
    email: string;
    displayName: string;
    /** IANA zone, e.g. Europe/Berlin */
    timeZone?: string;
}`;

const MAX_RECORDS = 50;
/** Longer than any world-agent run; a crashed holder's lease lapses at once. */
const FILL_LEASE_MS = 10 * 60_000;
const LEASE_POLL_MS = 250;
const DEFAULT_COUNT = 5;
const MAX_TOOL_CALLS = 14;
/** What one read of a collection may put into the prompt. */
const READ_CHARS = 24_000;
const MAX_BATCH_RECORDS = 5000;

export interface WorldEvent {
    collection: string;
    made: number;
    /** the agent did not deliver and sampled records stood in */
    fallback?: string;
    /** records of other types made along the way, because these refer to them */
    dependents?: number;
    /** references in what was made that point at nothing in the world */
    dangling?: string[];
    report?: string;
    durationMs: number;
}

export interface WorldOptions {
    model: Model;
    knowledge: Knowledge;
    catalog: Catalog;
    /** where each type lives; the world agent may place a type nobody has used yet */
    bindings: Bindings;
    /** the live world */
    store: WorldStore;
    reportDir?: string;
    onMade?: (event: WorldEvent) => void;
}

export class World {
    readonly store: WorldStore;
    /** what the agents know: the story, and the docs with the tools that read them */
    readonly knowledge: Knowledge;
    readonly #opts: WorldOptions;
    readonly #stores = new Map<string, WorldStore>();
    readonly #locks = new Map<string, Promise<unknown>>();
    readonly #owner = leaseOwner();

    constructor(opts: WorldOptions) {
        this.#opts = opts;
        this.store = opts.store;
        this.knowledge = opts.knowledge;
    }

    /** Given to the box: every request a handler makes for content lands here. */
    readonly synthesize: SynthesizeHook = (request, context) => {
        const req = normalizeRequest(request);
        const store = this.#storeFor(context.db);
        if (context.probe) {
            if (req.ids?.length) {
                return Promise.resolve(this.#stub(store, req, context.input.seed));
            }

            const target = Math.max(req.count ?? 3, req.min ?? 0);
            if (!Number.isSafeInteger(target) || target < 0 || target > MAX_BATCH_RECORDS) {
                throw new Error(
                    `requested ${target} probe records, maximum is ${MAX_BATCH_RECORDS}`,
                );
            }

            const existing = store
                .collection(req.collection)
                .all()
                .filter((record) => matches(record, req.where)).length;

            const missingCount = req.min === undefined ? target : Math.max(0, target - existing);

            return Promise.resolve(this.#stubBatches(store, req, context.input.seed, missingCount));
        }
        // One agent per collection at a time: two requests that both found the
        // inbox empty must not both fill it.
        const key = `${context.db}\u0000${req.collection}`;
        const before = this.#locks.get(key) ?? Promise.resolve();
        const mine = before
            .catch(() => undefined)
            .then(() => this.#make(store, req, context.input));
        this.#locks.set(key, mine);
        void mine.finally(() => {
            if (this.#locks.get(key) === mine) {
                this.#locks.delete(key);
            }
        });
        return mine;
    };

    /** Forgets a world that was only borrowed, such as a judging snapshot. */
    release(db: string): void {
        const store = this.#stores.get(db);
        if (store && store !== this.store) {
            store.close();
        }
        this.#stores.delete(db);
    }

    close(): void {
        for (const db of [...this.#stores.keys()]) {
            this.release(db);
        }
    }

    // -----------------------------------------------------------------------

    #storeFor(db: string): WorldStore {
        if (db === this.store.path) {
            return this.store;
        }
        let store = this.#stores.get(db);
        if (!store) {
            store = new WorldStore(db);
            this.#stores.set(db, store);
        }
        return store;
    }

    /**
     * One filler per collection across every process on this world. The lock
     * above serialises this process; the lease serialises the others, which
     * wait and then find the records made for them.
     */
    async #make(
        store: WorldStore,
        req: Required<Pick<SynthesisRequest, 'collection' | 'idField'>> & SynthesisRequest,
        input: HandlerRequest,
    ): Promise<Record<string, unknown>[]> {
        const ready = (): Record<string, unknown>[] | undefined => this.#ready(store, req);
        const already = ready();
        if (already) {
            return already;
        }
        const lease = `fill:${req.collection}:${JSON.stringify(
            req.ids?.length ? req.ids.map(String).sort() : (req.where ?? {}),
        )}`;
        while (!store.claim(lease, this.#owner, FILL_LEASE_MS)) {
            await new Promise((settle) => setTimeout(settle, LEASE_POLL_MS));
            const made = ready();
            if (made) {
                return made;
            }
        }
        try {
            return ready() ?? (await this.#fill(store, req, input));
        } finally {
            store.release(lease, this.#owner);
        }
    }

    /** What is wanted, if the world already has it. */
    #ready(
        store: WorldStore,
        req: SynthesisRequest & { idField: string },
    ): Record<string, unknown>[] | undefined {
        const col = store.collection(req.collection);
        if (req.ids?.length) {
            return req.ids.every((id) => col.has(id))
                ? req.ids.map((id) => col.get(id)!)
                : undefined;
        }
        if (req.min !== undefined) {
            const have = col.all().filter((r) => matches(r, req.where));
            const populated = store.getMeta(populatedKey(req.collection, req.where));
            if (have.length >= req.min && (!req.populate || populated)) {
                return have;
            }
        }
        return undefined;
    }

    async #fill(
        store: WorldStore,
        req: Required<Pick<SynthesisRequest, 'collection' | 'idField'>> & SynthesisRequest,
        input: HandlerRequest,
    ): Promise<Record<string, unknown>[]> {
        const key = populatedKey(req.collection, req.where);
        const started = Date.now();
        const saved = new Map<string, Record<string, unknown>>();
        const dependents = new Map<string, Record<string, unknown>>();
        const wanted = req.ids?.length ?? Math.min(req.count ?? DEFAULT_COUNT, MAX_RECORDS);
        // A first fill makes what the story says exists, however many that is:
        // the count is only a suggestion, and what is required is what the
        // handler cannot answer without.
        const required =
            req.ids?.length ??
            (req.populate ? Math.max(req.min ?? 1, 1) : Math.max(wanted, req.min ?? 0));
        const enough = (): boolean =>
            req.ids?.length ? req.ids.every((id) => saved.has(String(id))) : saved.size >= required;
        // Stopped as soon as it is provably done — except a first fill, whose
        // end only the agent knows.
        const done = req.populate && !req.ids?.length ? undefined : enough;

        let report: string | undefined;
        let failure: string | undefined;
        try {
            const run = await runAgent({
                model: this.#opts.model,
                name: 'world',
                label: req.collection,
                instructions: this.#instructions(),
                tools: [
                    ...this.#opts.knowledge.tools,
                    ...this.#tools(store, req, saved, dependents),
                ],
                input: await this.#brief(store, req, input, wanted),
                maxToolCalls: MAX_TOOL_CALLS,
                done,
                reportDir: this.#opts.reportDir,
            });
            report = run.report;
            if (!enough()) {
                failure = `the world agent saved ${saved.size} of ${required} records`;
            }
        } catch (err) {
            failure = `the world agent failed: ${err instanceof Error ? err.message : String(err)}`;
        }

        let made = [...saved.values()];
        if (!req.ids?.length) {
            store.setMeta(key, true);
        }
        if (failure) {
            const fallback = {
                ...req,
                ids: missing(req, saved),
            };

            const remaining =
                req.min === undefined && !req.populate
                    ? Math.max(0, required - saved.size)
                    : Math.max(
                          0,
                          required -
                              store
                                  .collection(req.collection)
                                  .all()
                                  .filter((record) => matches(record, req.where)).length,
                      );

            made = [
                ...made,
                ...(fallback.ids?.length
                    ? this.#stub(store, fallback, input.seed)
                    : this.#stubBatches(store, fallback, input.seed, remaining)),
            ];
        }
        const dangling = this.#dangling(store, req, [...saved.values()]);
        this.#opts.onMade?.({
            collection: req.collection,
            made: made.length,
            fallback: failure,
            ...(dependents.size > 0 ? { dependents: dependents.size } : {}),
            ...(dangling.length > 0 ? { dangling } : {}),
            report,
            durationMs: Date.now() - started,
        });
        return made;
    }

    #stubBatches(
        store: WorldStore,
        req: SynthesisRequest,
        seed: number,
        total: number,
    ): Record<string, unknown>[] {
        const records: Record<string, unknown>[] = [];
        if (!Number.isSafeInteger(total) || total < 0 || total > MAX_BATCH_RECORDS) {
            throw new Error(`requested ${total} sampled records, maximum is ${MAX_BATCH_RECORDS}`);
        }

        for (let remaining = total; remaining > 0; remaining -= MAX_RECORDS) {
            const count = Math.min(remaining, MAX_RECORDS);

            records.push(...this.#stub(store, { ...req, count }, seed + records.length));
        }

        return records;
    }

    #uniqueId(
        record: Record<string, unknown>,
        idField: string,
        type: string | undefined,
        collection: ReturnType<WorldStore['collection']>,
    ): string | number {
        const validate = type ? this.#opts.catalog.validator(type) : undefined;
        const original = record[idField];

        const valid = (candidate: string | number): boolean => {
            if (collection.has(String(candidate))) {
                return false;
            }

            if (!validate) {
                return true;
            }

            return validate({ ...record, [idField]: candidate });
        };

        if ((typeof original === 'string' || typeof original === 'number') && valid(original)) {
            return original;
        }

        const numeric = typeof original === 'number';

        // Start beyond the existing collection size, then find the next
        // available schema-valid value.
        for (let offset = 1; offset <= 10_000; offset++) {
            const index = collection.count() + offset;

            const candidate = numeric ? index : `${String(original ?? 'id')}-${index}`;

            if (valid(candidate)) {
                return candidate;
            }
        }

        throw new Error(`could not allocate a unique schema-valid ID for ${type ?? idField}`);
    }

    #stub(store: WorldStore, req: SynthesisRequest, seed: number): Record<string, unknown>[] {
        const idField = req.idField ?? 'id';
        if (!req.ids?.length) {
            store.setMeta(populatedKey(req.collection, req.where), true);
        }
        const schema = req.type
            ? this.#opts.catalog.types[req.type]
            : req.collection === ACCOUNTS
              ? ACCOUNT_SCHEMA
              : undefined;
        const requested = req.count ?? req.min ?? 3;
        const n = req.ids?.length ?? Math.max(0, Math.min(requested, MAX_RECORDS));
        const col = store.collection(req.collection);
        const out: Record<string, unknown>[] = [];
        let attempts = 0;
        const maxAttempts = Math.max(n * 100, 100);
        while (out.length < n) {
            if (attempts >= maxAttempts) {
                throw new Error(`could not generate ${n} unique records for ${req.collection}`);
            }

            const i = attempts++;

            const made = schema ? sample(schema, this.#opts.catalog.types, seed * 31 + i + 1) : {};

            const record: Record<string, unknown> =
                typeof made === 'object' && made !== null && !Array.isArray(made)
                    ? (made as Record<string, unknown>)
                    : {};

            Object.assign(record, req.where ?? {});

            const want = req.ids?.[out.length];

            if (want !== undefined) {
                record[idField] =
                    typeof record[idField] === 'number' && /^-?\d+$/.test(String(want))
                        ? Number(want)
                        : want;
            } else {
                record[idField] = this.#uniqueId(record, idField, req.type, col);
            }

            const id = String(record[idField]);

            col.put(id, record);
            out.push(record);
        }
        return out;
    }

    #instructions(): string {
        return [
            'You populate the world behind a simulated API. A request handler needs records',
            'that do not exist yet; you write them and save them with save_records.',
            '',
            this.#opts.knowledge.story,
            '',
            ...(this.#opts.knowledge.docs
                ? [
                      'REFERENCE DOCUMENTS. The world also has documentation: a knowledge base,',
                      'guides, runbooks. The brief quotes the passages most likely to matter;',
                      'search_docs, grep_docs and read_docs find more. Take realistic values',
                      'from them — names, codes, settings, valid ranges, how things relate —',
                      'and where a record would cite or quote a document, cite or quote it',
                      'truly. The story wins where the two disagree.',
                      '',
                  ]
                : []),
            'RULES',
            '- Agree with the story. Use its people, names, addresses, dates, projects and',
            '  themes. Where it is silent, invent what fits it.',
            '- Respect what the story says has NOT happened: a meeting it calls unscheduled',
            '  is not on any calendar, a reply it says was not sent is not in the mailbox.',
            '  Those are left for the user of the API to do.',
            '- Agree with the world. Look at what other collections already hold',
            '  (list_collections, read_collection) and reuse the same people, ids and',
            '  facts: the world is shared by several APIs and must read as one place.',
            '- Never point at what does not exist. A field that names another entity — an',
            '  id, a path, a parent, an owner — names one the world holds: reuse it, or make',
            '  it in this same run with save_records({ type, records }) and point at that.',
            '  Records you make that way are saved in their own collections.',
            '- Every record must satisfy the type you are given. Required fields always;',
            '  optional ones where they make the record more realistic.',
            '- Write content a person would recognise: real-sounding subjects, bodies,',
            '  titles, descriptions; consistent timestamps; ids in the format the schema',
            '  asks for.',
            '- Save everything in one save_records call when you can. If it reports',
            '  errors, fix those records and save them again. Do not save duplicates.',
            '- Stop as soon as the request is satisfied.',
        ].join('\n');
    }

    async #brief(
        store: WorldStore,
        req: SynthesisRequest & { idField: string },
        input: HandlerRequest,
        wanted: number,
    ): Promise<string> {
        const catalog = this.#opts.catalog;
        const typed = req.type && catalog.hasType(req.type);
        const lines = [
            `Make records for the collection \`${req.collection}\`, keyed by \`${req.idField}\`.`,
            req.ids?.length
                ? `They must have exactly these ${req.idField} values: ${JSON.stringify(req.ids)}.`
                : req.populate
                  ? `Make the records the story says exist; where it does not say, about ${wanted}.`
                  : `Make ${wanted} new records.`,
        ];
        if (req.populate) {
            lines.push(
                'This is the first time anyone reads this collection: fill it as the story has it',
                'today — a realistic, varied population — not only what this one request asks for.',
                "Records already in it were written by the API's users; keep them and add around them.",
            );
        }
        if (req.where && Object.keys(req.where).length > 0) {
            lines.push(`Every record must carry these values: ${JSON.stringify(req.where)}.`);
        }
        if (req.hint) {
            lines.push(`What they are for: ${req.hint}`);
        }
        lines.push(
            '',
            `The request that needs them: ${input.method.toUpperCase()} ${input.path}`,
            `  path ${JSON.stringify(input.pathParams)}  query ${JSON.stringify(input.query)}` +
                (input.body !== undefined
                    ? `  body ${clip(JSON.stringify(input.body), 1500)}`
                    : ''),
            `Today is ${new Date().toISOString().slice(0, 10)}.`,
            '',
        );
        if (typed) {
            const { code, omitted } = catalog.declare([req.type!], 16_000);
            lines.push(`Each record is a \`${req.type}\`:`, code.trimEnd());
            if (omitted.length > 0) {
                lines.push(`(also referenced, ask describe_types: ${omitted.join(', ')})`);
            }
        } else if (req.collection === ACCOUNTS) {
            lines.push(
                'Each record is an account. The one with id "' +
                    OWNER +
                    '" is the person the API is',
                'called as — the owner of the mailbox, calendar and data in the story.',
                ACCOUNT_DECLARATION,
            );
        } else {
            lines.push(
                'No schema type was named: make records shaped like the response the request expects.',
            );
        }
        const references = req.type ? catalog.references(req.type) : [];
        if (references.length > 0) {
            lines.push(
                '',
                'REFERENCES — fields that name other entities. Each must name one the world holds:',
                ...references.map(
                    (r) => `  ${r.name}: ${r.signature}${r.doc ? `  — ${r.doc}` : ''}`,
                ),
            );
        }
        const placed = Object.entries(this.#opts.bindings.all()).filter(
            ([type]) => type !== OWNER_TYPE && type !== req.type,
        );
        if (placed.length > 0) {
            lines.push(
                '',
                'OTHER TYPES IN THE WORLD (save one with save_records({ type, records }))',
                ...placed.map(
                    ([type, b]) =>
                        `  ${type} → ${b.collection}, keyed by ${b.idField}: ${store.collection(b.collection).count()} records`,
                ),
            );
        }
        const passages = await this.#opts.knowledge.recall(
            [req.type, req.collection, req.hint, `${input.method.toUpperCase()} ${input.path}`]
                .filter(Boolean)
                .join(' — '),
        );
        if (passages) {
            lines.push('', 'FROM THE REFERENCE DOCUMENTS', passages.trimEnd());
        }
        const world = store.collections();
        lines.push(
            '',
            'THE WORLD SO FAR',
            ...(world.length > 0
                ? world.map(
                      (c) => `- ${c.name}: ${c.count} records (e.g. ${c.sampleIds.join(', ')})`,
                  )
                : ['- (empty)']),
        );
        return lines.join('\n');
    }

    #tools(
        store: WorldStore,
        req: SynthesisRequest & { idField: string },
        saved: Map<string, Record<string, unknown>>,
        dependents: Map<string, Record<string, unknown>>,
    ): AnyTool[] {
        const catalog = this.#opts.catalog;
        const validate = req.type
            ? catalog.validator(req.type)
            : req.collection === ACCOUNTS
              ? catalog.compile(ACCOUNT_SCHEMA)
              : undefined;

        const list = tool<Record<string, never>>({
            name: 'list_collections',
            description: 'Every collection in the world, with how many records it holds.',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
            execute: () => ({ collections: store.collections() }),
        });

        const read = tool<{ collection: string; limit?: number; where?: Record<string, unknown> }>({
            name: 'read_collection',
            description:
                'Records already in a collection, oldest first. Read related collections to ' +
                'reuse their people, ids and facts.',
            parameters: {
                type: 'object',
                properties: {
                    collection: { type: 'string' },
                    limit: { type: 'integer', description: 'Default 10.' },
                    where: { type: 'object', description: 'Only records with these values.' },
                },
                required: ['collection'],
                additionalProperties: false,
            },
            execute: ({ collection, limit, where }) => {
                const all = store
                    .collection(collection)
                    .all()
                    .filter((r) => matches(r, where));
                const records = all.slice(0, Math.min(limit ?? 10, 50));
                return {
                    total: all.length,
                    records: JSON.parse(clip(JSON.stringify(records), READ_CHARS, true)),
                };
            },
        });

        const describe = tool<{ names: string[] }>({
            name: 'describe_types',
            description: 'Schema types by name, as TypeScript, with everything they refer to.',
            parameters: {
                type: 'object',
                properties: { names: { type: 'array', items: { type: 'string' } } },
                required: ['names'],
                additionalProperties: false,
            },
            execute: ({ names }) => {
                const { code, omitted } = catalog.declare(names, 30_000);
                return code
                    ? { typescript: code, omitted }
                    : { error: `no such type: ${names.join(', ')}` };
            },
        });

        const save = tool<{ records: Record<string, unknown>[]; type?: string }>({
            name: 'save_records',
            description:
                `Validates records and saves the valid ones — to \`${req.collection}\` by default, ` +
                'or, with `type`, to the collection of that type: how the entities these records ' +
                'refer to are made. Reports every invalid record with what is wrong, so it can be ' +
                'fixed and saved again.',
            parameters: {
                type: 'object',
                properties: {
                    records: { type: 'array', items: { type: 'object' } },
                    type: {
                        type: 'string',
                        description:
                            'Save records of another schema type, e.g. one these records refer to.',
                    },
                },
                required: ['records'],
                additionalProperties: false,
            },
            execute: ({ records, type }) => {
                const other = type && type !== req.type ? this.#placeOf(type) : undefined;
                if (other && 'error' in other) {
                    return other;
                }
                const target = other ?? {
                    collection: req.collection,
                    idField: req.idField,
                    request: req,
                    validate,
                };
                const col = store.collection(target.collection);
                const errors: { index: number; problems: string[] }[] = [];
                let ok = 0;
                (Array.isArray(records) ? records : []).forEach((record, index) => {
                    const problems = this.#problems(record, target.request, target.validate);
                    if (problems.length > 0) {
                        errors.push({ index, problems });
                        return;
                    }
                    const id = String(record[target.idField]);
                    col.put(id, record);
                    if (other) {
                        dependents.set(`${target.collection}/${id}`, record);
                    } else {
                        saved.set(id, record);
                    }
                    ok++;
                });
                if (other) {
                    return { saved: ok, errors, collection: target.collection };
                }
                const left = missing(req, saved);
                return {
                    saved: ok,
                    errors,
                    ...(left?.length ? { stillMissing: left } : {}),
                    ...(!req.ids?.length
                        ? req.populate
                            ? { savedSoFar: saved.size }
                            : {
                                  stillNeeded: Math.max(
                                      0,
                                      (req.count ?? DEFAULT_COUNT) - saved.size,
                                  ),
                              }
                        : {}),
                };
            },
        });

        return [list, read, describe, save];
    }

    /**
     * Where records of another type go, placing the type if nobody has: the
     * world agent can be first to need a label, before any handler has
     * served one.
     */
    #placeOf(type: string):
        | {
              collection: string;
              idField: string;
              request: SynthesisRequest & { idField: string };
              validate: ReturnType<Catalog['validator']>;
          }
        | { error: string; hint?: string } {
        const catalog = this.#opts.catalog;
        if (!catalog.hasType(type)) {
            return {
                error: `no type called ${type}`,
                hint: 'describe_types shows the ones there are',
            };
        }
        const binding = this.#opts.bindings.of(type) ?? {
            collection: collectionFor(type),
            idField: catalog.idField(type),
        };
        const problem = this.#opts.bindings.bind(type, binding);
        if (problem) {
            return { error: problem };
        }
        return {
            collection: binding.collection,
            idField: binding.idField,
            request: { collection: binding.collection, type, idField: binding.idField },
            validate: catalog.validator(type),
        };
    }

    /**
     * References in the records just made that point at nothing. Judged loosely:
     * a value counts as found if any collection holds a record under it, or
     * under its last path segment — `/v1/gateways/gw-app` names `gw-app`.
     * Reported, never repaired: a guess at the missing entity would be worse.
     */
    #dangling(
        store: WorldStore,
        req: SynthesisRequest & { idField: string },
        made: readonly Record<string, unknown>[],
    ): string[] {
        const catalog = this.#opts.catalog;
        const references = (req.type ? catalog.references(req.type) : []).filter((r) =>
            catalog.referent(r.name),
        );
        if (references.length === 0 || made.length === 0) {
            return [];
        }
        const collections = store.collections().map((c) => store.collection(c.name));
        const exists = (value: string): boolean => {
            const tail = value.split('/').filter(Boolean).at(-1) ?? value;
            return collections.some((c) => c.has(value) || c.has(tail));
        };
        const out = new Set<string>();
        for (const record of made) {
            for (const { name } of references) {
                const value = record[name];
                const values = Array.isArray(value) ? value : [value];
                for (const v of values) {
                    if (typeof v === 'string' && v && !exists(v)) {
                        out.add(`${name}=${v}`);
                    }
                }
            }
        }
        return [...out];
    }

    #problems(
        record: unknown,
        req: SynthesisRequest & { idField: string },
        validate: ReturnType<Catalog['validator']>,
    ): string[] {
        if (typeof record !== 'object' || record === null || Array.isArray(record)) {
            return ['is not an object'];
        }
        const r = record as Record<string, unknown>;
        const out: string[] = [];
        const id = r[req.idField];
        if (typeof id !== 'string' && typeof id !== 'number') {
            out.push(`\`${req.idField}\` is missing`);
        } else if (req.ids?.length && !req.ids.some((want) => String(want) === String(id))) {
            out.push(`\`${req.idField}\` ${JSON.stringify(id)} is not one of the ids asked for`);
        }
        for (const [k, v] of Object.entries(req.where ?? {})) {
            if (!same(r[k], v)) {
                out.push(`\`${k}\` must be ${JSON.stringify(v)}`);
            }
        }
        if (validate && !validate(r)) {
            for (const e of validate.errors ?? []) {
                // An id the client asked for wins over the id format: it is the
                // name the record will be looked up by.
                if (req.ids?.length && e.instancePath === `/${req.idField}`) {
                    continue;
                }
                out.push(`${e.instancePath || '(root)'} ${e.message ?? 'is invalid'}`);
            }
        }
        return out;
    }
}

function normalizeRequest(
    request: SynthesisRequest,
): SynthesisRequest & { collection: string; idField: string } {
    if (!request || typeof request.collection !== 'string' || !request.collection.trim()) {
        throw new Error('synthesize needs a `collection` name');
    }
    return {
        ...request,
        collection: request.collection.trim(),
        // The owner's type is gym's own, not a document's: accounts are shaped below.
        type: request.type === OWNER_TYPE ? undefined : request.type,
        idField: request.idField ?? 'id',
        ids: request.ids?.slice(0, MAX_RECORDS),
    };
}

function missing(
    req: SynthesisRequest,
    saved: Map<string, unknown>,
): (string | number)[] | undefined {
    return req.ids?.filter((id) => !saved.has(String(id)));
}

function clip(text: string, max: number, json = false): string {
    if (text.length <= max) {
        return text;
    }
    return json
        ? JSON.stringify({ truncated: true, preview: text.slice(0, max) })
        : `${text.slice(0, max)}…`;
}
