import SwaggerParser from '@apidevtools/swagger-parser';
import { CliError, EXIT } from '@zenera/cli/lib';
import { createHash } from 'node:crypto';
import { pagingOf, type Paging } from './paging.ts';
import { normalize, type Dialect, type Schema } from './schema.ts';

/**
 * Version of the handler contract: the prompt rules and the `ctx` runtime.
 * Bumping it gives every operation a new cache key, so nothing written to an
 * older contract is ever run against a newer one.
 */
export const CONTRACT_VERSION = 4;

// ---------------------------------------------------------------------------
// Documents, flattened
//
// Everything below this file works on `Operation`, which is one method on one
// path with its schemas already dereferenced and already 2020-12. Which
// document it came from, and which of the three dialects that document was
// written in, stops mattering here.
//
// `dereference` is used rather than `bundle` on purpose: requests and responses
// are checked one operation at a time, and a check wants the whole shape in
// hand. The agents see the other view — named, bundled types — through
// catalog.ts.
// ---------------------------------------------------------------------------

export const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'] as const;

export type Method = (typeof METHODS)[number];

export type ParamIn = 'path' | 'query' | 'header' | 'cookie';

export interface ParamSpec {
    name: string;
    in: ParamIn;
    required: boolean;
    schema: Schema;
    description?: string;
}

export interface Operation {
    /** cache identity — a pure function of the operation's shape, see `keyOf` */
    key: string;
    /** the document it came from, for error messages */
    source: string;
    method: Method;
    /** the template, `/users/{user_id}` */
    path: string;
    operationId: string;
    summary?: string;
    description?: string;
    params: ParamSpec[];
    /** query values the path key pinned down, see `splitQuery` */
    fixed?: Record<string, string>;
    requestBody?: { required: boolean; schema: Schema };
    /** the response a call is answered with; `schema` absent means no body */
    success: { status: number; schema?: Schema };
    /** how the operation turns pages, when it turns pages at all */
    paging?: Paging;
    /** Exact length of an explicitly configured synthetic page series. */
    pageCount?: number;
}

interface Doc {
    swagger?: string;
    openapi?: string;
    basePath?: string;
    paths?: Record<string, unknown>;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

/** A `CliError` so an unreadable document exits 3 wherever it is raised. */
export class SpecError extends CliError {
    constructor(message: string, hint?: string) {
        super(message, EXIT.invalid, hint);
        this.name = 'SpecError';
    }
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export async function loadSpecs(files: readonly string[]): Promise<Operation[]> {
    const out: Operation[] = [];
    for (const file of files) {
        out.push(...(await loadSpec(file)));
    }
    return out;
}

export async function loadSpec(file: string): Promise<Operation[]> {
    let doc: Doc;
    try {
        doc = (await SwaggerParser.dereference(file)) as Doc;
    } catch (err) {
        throw new SpecError(
            `${file}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
            'the document must be a readable OpenAPI 3.x or Swagger 2.0 file',
        );
    }

    const dialect = dialectOf(doc);
    const prefix = dialect === 'swagger-2.0' ? (doc.basePath ?? '') : '';
    const out: Operation[] = [];

    for (const [template, item] of Object.entries(doc.paths ?? {})) {
        if (!isObject(item)) {
            continue;
        }
        // Path-level parameters apply to every method on it, and an operation
        // may override one by repeating its name and location.
        const shared = params(item.parameters, dialect);
        for (const method of METHODS) {
            const op = item[method];
            if (!isObject(op)) {
                continue;
            }
            const { path, fixed } = splitQuery(join(prefix, template));
            const merged = override(
                override(shared, params(op.parameters, dialect)),
                pinned(fixed),
            );
            out.push(
                build({
                    source: file,
                    dialect,
                    method,
                    path,
                    fixed,
                    op,
                    params: merged,
                    body: requestBody(op, dialect),
                }),
            );
        }
    }
    return out;
}

function dialectOf(doc: Doc): Dialect {
    if (doc.swagger?.startsWith('2.')) {
        return 'swagger-2.0';
    }
    if (doc.openapi?.startsWith('3.1')) {
        return 'openapi-3.1';
    }
    if (doc.openapi?.startsWith('3.')) {
        return 'openapi-3.0';
    }
    throw new SpecError('neither `swagger: 2.0` nor `openapi: 3.x` is declared');
}

function join(prefix: string, template: string): string {
    const base = prefix.replace(/\/+$/, '');
    return `${base}${template.startsWith('/') ? '' : '/'}${template}` || '/';
}

/** The path as it has to be called — what a person needs to see. */
export const called = (op: Operation): string =>
    op.fixed ? `${op.path}?${new URLSearchParams(op.fixed).toString()}` : op.path;

/**
 * A path template has no query string, but some vendors write one
 * anyway — `/x/{id}?action=retry` — because they need two `post`s under one
 * path and the object model gives them one. Taken verbatim the key matches
 * nothing, since a request path never contains a `?`. So it is read for what
 * it means: the path is the part before the `?`, and each pair after it is a
 * query value this operation insists on.
 */
function splitQuery(template: string): { path: string; fixed?: Record<string, string> } {
    const cut = template.indexOf('?');
    if (cut < 0) {
        return { path: template };
    }
    const fixed: Record<string, string> = {};
    for (const [name, value] of new URLSearchParams(template.slice(cut + 1))) {
        fixed[name] = value;
    }
    const path = template.slice(0, cut) || '/';
    return Object.keys(fixed).length > 0 ? { path, fixed } : { path };
}

/** A one-value enum, so the check, the page and the handler all see the rule. */
function pinned(fixed: Record<string, string> | undefined): ParamSpec[] {
    return Object.entries(fixed ?? {}).map(([name, value]) => ({
        name,
        in: 'query',
        required: true,
        schema: { type: 'string', enum: [value] },
    }));
}

interface Built {
    source: string;
    dialect: Dialect;
    method: Method;
    path: string;
    fixed?: Record<string, string>;
    op: Record<string, unknown>;
    params: ParamSpec[];
    body?: { required: boolean; schema: Schema };
}

function build(b: Built): Operation {
    const success = successOf(b.op, b.dialect);
    const operationId =
        typeof b.op.operationId === 'string' && b.op.operationId
            ? b.op.operationId
            : synthesizeId(b.method, b.path, b.fixed);

    const operation: Operation = {
        key: '',
        source: b.source,
        method: b.method,
        path: b.path,
        operationId,
        summary: typeof b.op.summary === 'string' ? b.op.summary : undefined,
        description: typeof b.op.description === 'string' ? b.op.description : undefined,
        params: b.params,
        fixed: b.fixed,
        requestBody: b.body,
        success,
        paging: pagingOf(b.params, success.schema, b.body?.schema),
    };
    return { ...operation, key: keyOf(operation) };
}

export function withPageCount(operation: Operation, pageCount: number): Operation {
    const configured = { ...operation, pageCount };
    return { ...configured, key: keyOf(configured) };
}

/**
 * Cache identity. Everything that changes what a handler must produce is in
 * here and nothing else is — not the file it came from, not its summary, not
 * the wording of a field's description, not the order of its keys. Editing a
 * spec's shape therefore yields a new key and the old artefact is simply never
 * looked up again, so there is no invalidation step to get wrong.
 *
 * The world's type bindings are part of a handler's identity too, but they are
 * known only once it is written; `cache.ts` adds them on top of this key.
 */
function keyOf(op: Operation): string {
    const shape = {
        version: CONTRACT_VERSION,
        method: op.method,
        path: op.path,
        operationId: op.operationId,
        params: [...op.params]
            .sort((a, b) => `${a.in}:${a.name}`.localeCompare(`${b.in}:${b.name}`))
            .map((p) => [p.in, p.name, p.required, canonical(bare(p.schema))]),
        body: op.requestBody
            ? [op.requestBody.required, canonical(bare(op.requestBody.schema))]
            : null,
        success: [op.success.status, op.success.schema ? canonical(bare(op.success.schema)) : null],
        paging: op.paging ? canonical(op.paging) : null,
        ...(op.pageCount === undefined ? {} : { pageCount: op.pageCount }),
    };
    return createHash('sha256').update(JSON.stringify(shape)).digest('hex').slice(0, 16);
}

/** Keywords that annotate a schema and change nothing a handler must produce. */
const ANNOTATIONS = new Set([
    '$schema',
    '$comment',
    'title',
    'description',
    'example',
    'examples',
    'externalDocs',
    'deprecated',
]);

/** Keywords whose value is a map of names to schemas, not a schema itself. */
const SCHEMA_MAPS = new Set([
    'properties',
    'patternProperties',
    '$defs',
    'definitions',
    'dependentSchemas',
]);

/** Keywords whose value is data, kept verbatim whatever keys it happens to have. */
const DATA = new Set(['enum', 'const', 'default']);

/**
 * A schema without its annotations. Schema-aware rather than a blanket key
 * filter, because a *property* called `description` is shape, not prose.
 */
function bare(schema: unknown): unknown {
    if (Array.isArray(schema)) {
        return schema.map(bare);
    }
    if (!isObject(schema)) {
        return schema;
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema)) {
        if (ANNOTATIONS.has(key) || key.startsWith('x-')) {
            continue;
        }
        if (DATA.has(key)) {
            out[key] = value;
        } else if (SCHEMA_MAPS.has(key) && isObject(value)) {
            out[key] = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, bare(v)]));
        } else {
            out[key] = bare(value);
        }
    }
    return out;
}

/** Key order is a formatting accident; it must not change a cache key. */
function canonical(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(canonical);
    }
    if (isObject(value)) {
        return Object.keys(value)
            .sort()
            .map((k) => [k, canonical(value[k])]);
    }
    return value;
}

function synthesizeId(method: Method, path: string, fixed?: Record<string, string>): string {
    const words = [...path.split('/'), ...Object.values(fixed ?? {})]
        .filter(Boolean)
        .map((s) => s.replace(/[{}]/g, '').replace(/[^A-Za-z0-9]+/g, '_'));
    return [method, ...words].join('_');
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

function params(raw: unknown, dialect: Dialect): ParamSpec[] {
    if (!Array.isArray(raw)) {
        return [];
    }
    const out: ParamSpec[] = [];
    for (const entry of raw) {
        if (!isObject(entry) || typeof entry.name !== 'string') {
            continue;
        }
        const where = entry.in;
        if (where !== 'path' && where !== 'query' && where !== 'header' && where !== 'cookie') {
            continue; // `body` and `formData` are handled as a request body
        }
        out.push({
            name: entry.name,
            in: where,
            required: where === 'path' ? true : entry.required === true,
            schema: normalize(paramSchema(entry, dialect), dialect),
            description: typeof entry.description === 'string' ? entry.description : undefined,
        });
    }
    return out;
}

/**
 * Swagger 2.0 puts a non-body parameter's type keywords directly on the
 * parameter object; OpenAPI 3 moved them under `schema`. Both end up as a
 * schema, so the difference is confined to this function.
 */
function paramSchema(entry: Record<string, unknown>, dialect: Dialect): unknown {
    if (dialect !== 'swagger-2.0') {
        return isObject(entry.schema) ? entry.schema : {};
    }
    const {
        name: _name,
        in: _in,
        required: _required,
        description: _description,
        collectionFormat: _collectionFormat,
        allowEmptyValue: _allowEmptyValue,
        ...rest
    } = entry;
    return rest;
}

/** Operation-level parameters win over path-level ones with the same identity. */
function override(base: ParamSpec[], own: ParamSpec[]): ParamSpec[] {
    const merged = new Map(base.map((p) => [`${p.in}:${p.name}`, p]));
    for (const p of own) {
        merged.set(`${p.in}:${p.name}`, p);
    }
    return [...merged.values()];
}

function requestBody(
    op: Record<string, unknown>,
    dialect: Dialect,
): { required: boolean; schema: Schema } | undefined {
    if (dialect === 'swagger-2.0') {
        const list = Array.isArray(op.parameters) ? op.parameters : [];
        const body = list.find((p): p is Record<string, unknown> => isObject(p) && p.in === 'body');
        if (!body || !isObject(body.schema)) {
            return undefined;
        }
        return { required: body.required === true, schema: normalize(body.schema, dialect) };
    }
    const rb = op.requestBody;
    if (!isObject(rb)) {
        return undefined;
    }
    const schema = jsonContent(rb.content);
    return schema
        ? { required: rb.required === true, schema: normalize(schema, dialect) }
        : undefined;
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/**
 * The response a call gets answered with: the lowest 2xx that carries a JSON
 * body, or the lowest 2xx at all when none of them do. An operation whose
 * success response has no JSON schema is answered `204` and never gets a
 * handler — there is nothing for one to produce.
 */
function successOf(
    op: Record<string, unknown>,
    dialect: Dialect,
): { status: number; schema?: Schema } {
    const responses = isObject(op.responses) ? op.responses : {};
    const codes = Object.keys(responses)
        .map(Number)
        .filter((n) => Number.isInteger(n) && n >= 200 && n < 300)
        .sort((a, b) => a - b);

    for (const status of codes) {
        const schema = responseSchema(responses[String(status)], dialect);
        if (schema) {
            return { status, schema: normalize(schema, dialect) };
        }
    }
    return { status: codes[0] ?? 204 };
}

function responseSchema(response: unknown, dialect: Dialect): unknown {
    if (!isObject(response)) {
        return undefined;
    }
    if (dialect === 'swagger-2.0') {
        return isObject(response.schema) ? response.schema : undefined;
    }
    return jsonContent(response.content);
}

/** The first JSON media type a content map offers, `+json` suffixes included. */
function jsonContent(content: unknown): unknown {
    if (!isObject(content)) {
        return undefined;
    }
    for (const [type, entry] of Object.entries(content)) {
        const base = type.split(';')[0].trim();
        if ((base === 'application/json' || base.endsWith('+json')) && isObject(entry)) {
            return isObject(entry.schema) ? entry.schema : undefined;
        }
    }
    return undefined;
}
