import type { AnyTool } from '@zenera/neo';
import addFormatsDefault from 'ajv-formats';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import * as rag from '@zenera/rag';
import type { Operation } from './spec.ts';

const addFormats = addFormatsDefault as unknown as (ajv: Ajv2020) => void;

// ---------------------------------------------------------------------------
// The catalog
//
// The documents as `@zenera/rag` reads them: bundled rather than dereferenced,
// so `Message` stays one named type instead of being pasted into every
// operation that returns it. That is what lets an agent be shown a response as
// a few TypeScript interfaces instead of a page of JSON Schema, ask for a
// nested type by name when it needs one, and be told that the records it makes
// for a collection must be a `Message` — validated here against that one name.
//
// Nothing here is embedded or indexed. Reading and graphing a document is
// milliseconds even at thousands of operations; only search needs vectors, and
// nothing here searches.
// ---------------------------------------------------------------------------

/** A brief stops quoting declarations past this, and points at describe_types. */
const BRIEF_CHARS = 12_000;

const TYPES_ID = 'gym:types';

export class Catalog {
    readonly corpus: rag.Corpus;
    readonly graph: rag.ApiGraph;
    readonly types: Record<string, rag.Schema>;
    readonly #printer: rag.Printer;
    readonly #ajv: Ajv2020;
    readonly #validators = new Map<string, ValidateFunction>();

    private constructor(corpus: rag.Corpus) {
        this.corpus = corpus;
        const built = rag.buildGraph(corpus);
        this.graph = built.graph;
        this.types = built.types;
        this.#printer = new rag.Printer(this.types);
        this.#ajv = new Ajv2020({ allErrors: true, strict: false, logger: false });
        addFormats(this.#ajv);
        this.#ajv.addSchema({ $id: TYPES_ID, $defs: stripSchemaKeys(this.types) });
    }

    static async open(files: readonly string[]): Promise<Catalog> {
        return new Catalog(await rag.loadSpecs(files));
    }

    hasType(name: string): boolean {
        return name in this.types;
    }

    /** A validator for records of a named type, or undefined for a name nobody declared. */
    validator(name: string): ValidateFunction | undefined {
        if (!this.hasType(name)) {
            return undefined;
        }
        let found = this.#validators.get(name);
        if (!found) {
            found = this.#ajv.compile({ $ref: `${TYPES_ID}#/$defs/${pointer(name)}` });
            this.#validators.set(name, found);
        }
        return found;
    }

    /** A validator for a schema of gym's own, outside the documents. */
    compile(schema: object): ValidateFunction {
        return this.#ajv.compile(schema);
    }

    /** The named types and everything they refer to, as TypeScript. */
    declare(names: readonly string[], maxChars = Infinity): { code: string; omitted: string[] } {
        const wanted = this.closure(names);
        const blocks: string[] = [];
        const omitted: string[] = [];
        let size = 0;
        for (const name of wanted) {
            const block = this.#printer.declaration(name, { docs: true, maxDoc: 160 });
            if (size + block.length > maxChars && blocks.length > 0) {
                omitted.push(name);
                continue;
            }
            blocks.push(block);
            size += block.length;
        }
        return { code: blocks.join('\n'), omitted };
    }

    /** Names reachable from these through `$ref`, the named ones first. */
    closure(names: readonly string[]): string[] {
        const out: string[] = [];
        const seen = new Set<string>();
        const queue = names.filter((n) => this.hasType(n));
        while (queue.length > 0) {
            const name = queue.shift()!;
            if (seen.has(name)) {
                continue;
            }
            seen.add(name);
            out.push(name);
            for (const ref of rag.refsIn(this.types[name])) {
                if (this.hasType(ref) && !seen.has(ref)) {
                    queue.push(ref);
                }
            }
        }
        return out;
    }

    /** An inline type expression for a schema, e.g. `Message[]`. */
    signature(schema: unknown): string {
        return this.#printer.signature(schema);
    }

    /** The document's own record of an operation, matched by method and path. */
    find(operation: Operation): rag.Operation | undefined {
        const candidates = this.corpus.operations.filter(
            (o) => o.method === operation.method && o.path.split('?')[0] === operation.path,
        );
        return (
            candidates.find((o) => o.operationId === operation.operationId) ??
            candidates.find((o) => o.path.includes('?') === Boolean(operation.fixed)) ??
            candidates[0]
        );
    }

    /**
     * The operation's request and response as TypeScript: what an agent writing
     * its handler needs to read first, and usually all it needs.
     */
    describe(operation: Operation): string {
        const op = this.find(operation);
        if (!op) {
            return '';
        }
        const lines: string[] = [];
        const roots: string[] = [];
        const note = (schema: unknown): string => {
            roots.push(...rag.refsIn(schema));
            return this.signature(schema);
        };
        for (const p of op.params) {
            lines.push(
                `  ${p.in} ${p.name}${p.required ? '' : '?'}: ${note(p.schema)}${p.doc ? `  // ${oneLine(p.doc)}` : ''}`,
            );
        }
        if (op.requestBody) {
            lines.push(
                `  body${op.requestBody.required ? '' : '?'}: ${note(op.requestBody.schema)}`,
            );
        }
        const response = op.responses[0];
        const out = [
            'REQUEST',
            ...(lines.length > 0 ? lines : ['  (no parameters)']),
            '',
            `RESPONSE ${response ? `${response.status}: ${note(response.schema)}` : '(no body)'}`,
        ];
        const declared = this.declare([...new Set(roots)], BRIEF_CHARS);
        if (declared.code) {
            out.push('', 'TYPES', declared.code.trimEnd());
        }
        if (declared.omitted.length > 0) {
            out.push(
                '',
                `Not shown for length (ask describe_types): ${declared.omitted.join(', ')}`,
            );
        }
        return out.join('\n');
    }

    /**
     * `list_api`, `grep_api`, `trace_api` and `find_types_with_property` over
     * the graph — exact, and needing no embedder. `describe_types` is gym's own.
     */
    tools(): AnyTool[] {
        return rag
            .graphTools({
                graph: this.graph,
                sources: this.corpus.docs.map((d) => d.source),
                schemas: () => Promise.resolve(this.types),
            })
            .filter((t) => t.name !== 'describe_types');
    }

    /**
     * The type of the records an operation is about: its response type, or —
     * when that is a list envelope with no identity of its own — the type its
     * list holds. `RouterListResult` is about `Router`; `Event` is about `Event`.
     */
    itemType(operation: Operation): string | undefined {
        const op = this.find(operation);
        const schema = op?.responses[0]?.schema ?? op?.requestBody?.schema;
        const root =
            rag.refName(schema) ?? rag.refName(isObject(schema) ? schema.items : undefined);
        const type = root ? this.types[root] : undefined;
        if (!root || !type) {
            return undefined;
        }
        const properties = isObject(type.properties) ? type.properties : {};
        if (Object.keys(properties).some((k) => IDENTITY.test(k))) {
            return root;
        }
        const lists = Object.entries(properties)
            .map(([name, p]) => [name, isObject(p) ? rag.refName(p.items) : undefined] as const)
            .filter((entry): entry is readonly [string, string] => Boolean(entry[1]));
        const preferred = lists.find(([name]) => LIST_NAMES.test(name)) ?? lists[0];
        return preferred?.[1] ?? root;
    }

    /**
     * A type's own properties and the ones it inherits through `allOf`, which is
     * how most documents spell inheritance — a `Router` built on a base resource declares little of
     * what it holds itself.
     */
    properties(type: string): { name: string; schema: rag.Schema; required: boolean }[] {
        const out = new Map<string, { name: string; schema: rag.Schema; required: boolean }>();
        const visit = (schema: unknown, depth: number): void => {
            if (!isObject(schema) || depth > 6) {
                return;
            }
            const ref = rag.refName(schema);
            if (ref) {
                visit(this.types[ref], depth + 1);
                return;
            }
            for (const member of Array.isArray(schema.allOf) ? schema.allOf : []) {
                visit(member, depth + 1);
            }
            const required = new Set(Array.isArray(schema.required) ? schema.required : []);
            for (const [name, sub] of Object.entries(
                isObject(schema.properties) ? schema.properties : {},
            )) {
                if (isObject(sub)) {
                    out.set(name, { name, schema: sub, required: required.has(name) });
                }
            }
        };
        visit(this.types[type], 0);
        return [...out.values()];
    }

    /** The property a type's records are known by. */
    idField(type: string): string {
        const names = this.properties(type).map((p) => p.name);
        return names.find((n) => n === 'id') ?? names.find((n) => IDENTITY.test(n)) ?? 'id';
    }

    /**
     * Fields that point at other entities, judged by name: `*_id`, `*_path`,
     * `*Ref`, `parent`, `owner`… Names rather than the schema because the
     * schema rarely says: a `gateway_path` is a string, and only its name and
     * its description say it names a Gateway.
     */
    references(type: string): { name: string; signature: string; doc: string }[] {
        const own = this.idField(type);
        return this.properties(type)
            .filter((p) => p.name !== own && REFERENCE.test(p.name) && stringy(p.schema))
            .map((p) => ({
                name: p.name,
                signature: this.signature(p.schema),
                doc: oneLine(typeof p.schema.description === 'string' ? p.schema.description : ''),
            }));
    }

    /**
     * The type a reference field most likely names, from the field's name:
     * `labelIds` → `Label`, `availability_zone_path` → `AvailabilityZone`. A
     * field that names no type — a `threadId` where threads are not a schema —
     * has no referent, and cannot dangle.
     */
    referent(field: string): string | undefined {
        const base = squash(field.replace(REFERENCE, ''));
        if (!base) {
            return undefined;
        }
        const types = Object.keys(this.types);
        return (
            types.find((t) => squash(t) === base) ??
            types.filter((t) => squash(t).endsWith(base)).sort((a, b) => a.length - b.length)[0]
        );
    }

    /** Every operation that accepts or returns a type, as method and path. */
    carriers(type: string, maxHops = 4): { method: string; path: string; direction: string }[] {
        const id = `Type:${type}`;
        if (!this.graph.hasNode(id)) {
            return [];
        }
        const traced = rag.traceNodes(this.graph, { ids: [id], maxHops, maxRoutes: 100 });
        return (traced.traces[0]?.routes ?? []).map((r) => ({
            method: r.attributes.httpMethod.toLowerCase(),
            path: r.attributes.path.split('?')[0]!,
            direction: r.direction,
        }));
    }

    /** The component types a response carries, nearest first: the candidates for a collection. */
    responseTypes(operation: Operation): string[] {
        const op = this.find(operation);
        const schema = op?.responses[0]?.schema;
        return schema ? this.closure(rag.refsIn(schema)) : [];
    }
}

/** A subschema must not carry its own `$schema`; only the root may. */
function stripSchemaKeys(types: Record<string, rag.Schema>): Record<string, rag.Schema> {
    return Object.fromEntries(
        Object.entries(types).map(([name, schema]) => {
            const { $schema: _a, $id: _b, ...rest } = schema as Record<string, unknown>;
            return [name, rest];
        }),
    );
}

/** A property that makes an object a record rather than an envelope. */
const IDENTITY = /^(id|uid|uuid|_id|key|name)$/i;

/** A field named for the thing it points at. */
const REFERENCE =
    /(_id|Id|_ids|Ids|_path|Path|_paths|Paths|_ref|Ref|_refs|Refs|_uri|Uri)$|^(parent|owner|organizer|assignee|author|creator|manager)$/;

const squash = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');

/** A string, or a list of them: what an id or a path is written as. */
function stringy(schema: rag.Schema): boolean {
    const type = schema.type;
    if (type === 'string' || (Array.isArray(type) && type.includes('string'))) {
        return true;
    }
    const items = schema.items;
    return type === 'array' && isObject(items) && items.type === 'string';
}

/** What an envelope usually calls its list. */
const LIST_NAMES = /^(items|results|data|records|entries|values|objects|list|content)$/i;

const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

const pointer = (name: string): string =>
    encodeURIComponent(name.replace(/~/g, '~0').replace(/\//g, '~1'));

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 120);
