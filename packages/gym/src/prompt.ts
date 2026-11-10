import type { Catalog } from './catalog.ts';
import type { HandlerRequest } from './runtime.ts';
import type { Paging } from './paging.ts';
import { called, type Operation } from './spec.ts';

// ---------------------------------------------------------------------------
// What the handler agent is told
//
// A contract, not a request. The handler is a module with a fixed shape that
// this package runs in three places — the judge, the server, the repair loop —
// so the shape is stated as rules; everything discretionary is taste.
//
// The rule that earns its paragraph is the split between mechanics and
// content. A handler that writes `subject: 'Hello'` inline answers every story
// the same way; one that asks `ctx.lookup` for the message answers with the
// story's. So content is never written here, only fetched.
// ---------------------------------------------------------------------------

export const SYSTEM = `You write the request handler for one operation of a simulated HTTP API.

THE HANDLER is one TypeScript module, run by Node.js as it is:

    export default async function handle(req, ctx) { ... return body; }

- \`req\`: { operationId, method, path, pathParams, query, headers, body, seed }.
  pathParams and query values are strings, as on the wire.
- Return the response body. It must match the response type exactly.
- No imports of any kind. Only erasable TypeScript: type annotations, interfaces and
  \`type\` aliases are fine; enums, namespaces and parameter properties are not.
- No network, no files, no timers, no global state between calls.

THE WORLD. All content lives in a shared world of records, grouped by type. Several
APIs share it, so a message listed here is the message read there. Your handler owns
the mechanics — which type, which filter, what a write changes — and never invents
content itself. Name records by their schema TYPE (a name with a capital: "Message",
"Router"); the world knows which collection and id field each type has. When the world
lacks what a request needs, ask for it and an agent writes it, consistent with
everything else:

  ctx.db.collection(Type)            sync: all(), get(id), has(id), find(fn), count(),
                                     put(id, record), putMany([{id, value}]), delete(id)
  await ctx.lookup(Type, id, { where?, hint?, idField? })
                                     the record with that id, made if missing
  await ctx.ensure(Type, { min?, count?, where?, hint? })
                                     all records (matching where), making some if fewer than min
  await ctx.synthesize({ collection: Type, count?, ids?, where?, hint? })
                                     make new records now; returns them, already stored
  await ctx.owner()                  the account the API is called as: { id, email, displayName, timeZone? }
  ctx.page(items, { token?, offset?, size?, defaultSize? })
                                     -> { items, nextToken, nextOffset, hasMore, total }
  ctx.fail(status, body?)            answer with an HTTP error instead
  ctx.newId(pattern?)  ctx.fromPattern(regex)  ctx.now()  ctx.random()  ctx.int(a, b)  ctx.pick(list)

\`idField\` is for the first use of a type whose id property is not \`id\` (e.g. "user_id");
after that the binding remembers it. \`where\` pins values every made record must carry
(e.g. { calendarId }); \`hint\` says in a sentence what the request is after (a search
query, a filter), so the made records actually answer it.

HOW EACH KIND OF OPERATION WORKS
- Read one (GET /things/{id}): \`await ctx.lookup('Thing', req.pathParams.id)\`.
- List (GET /things): \`await ctx.ensure('Thing', { where, hint })\`, then filter by the
  query parameters that describe content (search text, dates, labels, owner…) in code,
  sort as the API would, then \`ctx.page\`. If filtering leaves nothing for a query that
  plainly expects results, \`await ctx.synthesize({ collection: 'Thing', hint: <the query> })\` and filter again.
- Create (POST): build the stored record from the request body plus the server-assigned
  fields (id via ctx.newId(<the id pattern>), timestamps via ctx.now(), status…),
  \`put\` it, return it. Later reads must see it.
- Update (PUT/PATCH): lookup, merge, put, return. Delete: delete, return what the schema asks.
- Actions and computed answers (free/busy, search, stats…): derive the answer from the
  collections they are about, ensuring those exist first.
- Store whole records — the richest type the API has for the thing (e.g. a full
  \`Message\`, not a \`MessageRef\`) — and project to the response shape. Use the type
  sibling operations use: read their handlers first.
- People come from the world, never from code. Ids that stand for the caller — "me",
  "primary", "self", "default" — mean \`await ctx.owner()\`: resolve them to the owner's
  email (or whatever id the other records use for that person) before you store or
  filter by them, so "primary" and the owner's address are one calendar. Fields like
  sender, organizer, author or owner on a record you create are the owner's.
- Where a path parameter has the same name as a property of the response, the response
  carries the request's value.
- Paging: always through ctx.page, passing the client's token or offset as given.
  The token is opaque and always advances; on the last page leave the next token out
  (or null, if the schema allows) and set any has-more flag false.

REFERENCE DOCUMENTS. When the brief quotes documentation, or search_docs is among your
tools, the documents describe behaviour the schema cannot: what a write changes
elsewhere, what is refused and with which status, defaults, state transitions.
Implement what they say. Content still comes from the world, never from the documents.

WORKFLOW
1. Look before writing: read_handler for the related operations already built,
   list_collections for what the world holds, describe_types for types you were not
   shown. In a large API, trace_api on the record type finds every operation that
   carries it, and grep_api / list_api find the rest. Read the reference documents
   when the operation's behaviour is not obvious from its schema.
2. test_handler with the whole module. It runs the handler against probe requests in a
   copy of the world and reports every problem. Fix and test again until it passes.
   A passing test is the end of the job.`;

export interface BriefOptions {
    catalog: Catalog;
    /** operations this one must agree with, closest first, and whether each has a handler */
    siblings: readonly { operation: Operation; built: boolean; type?: string }[];
    collections: readonly { name: string; count: number }[];
    /** where each type lives, fixed by the handlers before this one */
    bindings: Readonly<Record<string, { collection: string; idField: string }>>;
    /** reference passages about this operation, quoted; '' when there are none */
    passages?: string;
}

export function brief(operation: Operation, opts: BriefOptions): string {
    const lines: string[] = [
        `OPERATION  ${operation.method.toUpperCase()} ${called(operation)}`,
        `operationId: ${operation.operationId}`,
    ];
    if (operation.summary) {
        lines.push(`summary: ${operation.summary}`);
    }
    if (operation.description && operation.description !== operation.summary) {
        lines.push(`description: ${operation.description.slice(0, 800)}`);
    }
    lines.push('', opts.catalog.describe(operation) || fallback(operation));

    const record = opts.catalog.itemType(operation);
    if (record) {
        lines.push('', `This operation is about \`${record}\` records.`);
    }
    if (!operation.success.schema) {
        lines.push('', 'This operation answers with no body: return null.');
    }
    if (operation.paging) {
        lines.push('', ...pagination(operation.paging));
    }
    if (opts.siblings.length > 0) {
        lines.push(
            '',
            'RELATED OPERATIONS (read the built ones with read_handler and reuse their collections)',
            ...opts.siblings.map(
                ({ operation: o, built, type }) =>
                    `  ${built ? '[built]' : '[     ]'} ${o.method.toUpperCase()} ${called(o)}  ${o.operationId}` +
                    (type ? `  → ${type}` : ''),
            ),
        );
    }
    const bound = Object.entries(opts.bindings).filter(([type]) => !type.startsWith('@'));
    lines.push(
        '',
        'WHERE TYPES LIVE (fixed: name the type and the binding finds its collection)',
        ...(bound.length > 0
            ? bound.map(([type, b]) => `  ${type} → ${b.collection} (keyed by ${b.idField})`)
            : ['  (nothing yet — the first handler to use a type gives it its place)']),
    );
    if (opts.passages) {
        lines.push(
            '',
            'FROM THE REFERENCE DOCUMENTS (what the API does, beyond its schema)',
            opts.passages.trimEnd(),
        );
    }
    lines.push(
        '',
        'THE WORLD SO FAR',
        ...(opts.collections.length > 0
            ? opts.collections.map((c) => `  ${c.name}: ${c.count} records`)
            : ['  (empty — collections are created by the first handler that asks for them)']),
    );
    return lines.join('\n');
}

/** For an operation the catalog could not match: its JSON, cut to a sane length. */
function fallback(operation: Operation): string {
    const out = ['REQUEST'];
    for (const p of operation.params) {
        out.push(`  ${p.in} ${p.name}${p.required ? '' : '?'}: ${JSON.stringify(p.schema)}`);
    }
    if (operation.requestBody) {
        out.push(`  body: ${JSON.stringify(operation.requestBody.schema).slice(0, 4000)}`);
    }
    out.push(
        '',
        `RESPONSE ${operation.success.status}: ${JSON.stringify(operation.success.schema ?? null).slice(0, 8000)}`,
    );
    return out.join('\n');
}

/**
 * Said only to the operations that page, in their own names. The rule that
 * matters is that the token advances: a body offering back the token it was
 * given passes the schema and hangs every client that walks the list.
 */
function pagination(paging: Paging): string[] {
    const where = paging.paramIn === 'body' ? 'req.body' : 'req.query';
    const from =
        paging.style === 'cursor'
            ? `{ token: ${where}.${paging.param}`
            : `{ offset: ${where}.${paging.param}`;
    const size = paging.size ? `, size: ${where}.${paging.size}` : '';
    const lines = ['PAGINATION', `  This operation pages: \`ctx.page(items, ${from}${size} })\`.`];
    if (paging.next) {
        const end = paging.nextNullable
            ? 'null'
            : paging.nextRequired
              ? 'still present (the schema requires it), with the items empty past the end'
              : 'left out';
        lines.push(
            `  \`${paging.next}\` carries ${paging.style === 'cursor' ? 'nextToken' : 'nextOffset'}; on the last page it is ${end}.`,
        );
    }
    if (paging.more) {
        lines.push(`  \`${paging.more}\` is hasMore.`);
    }
    if (paging.items) {
        lines.push(`  \`${paging.items}\` holds the page's items.`);
    }
    return lines;
}

export interface Repair {
    currentSource: string;
    failingInput: HandlerRequest;
    fault: string;
    stderr?: string;
    examples?: readonly { input: HandlerRequest; output?: unknown }[];
}

export function repairBrief(repair: Repair): string {
    const lines = [
        'THE CURRENT HANDLER FAILED ON A REAL REQUEST. Fix it; keep what works.',
        '',
        'CURRENT HANDLER:',
        '```ts',
        repair.currentSource.trim(),
        '```',
        '',
        'FAILING REQUEST:',
        json(repair.failingInput),
        '',
        `FAULT: ${repair.fault}`,
    ];
    if (repair.stderr?.trim()) {
        lines.push(
            '',
            'STACK:',
            '```',
            repair.stderr.trim().split('\n').slice(0, 15).join('\n'),
            '```',
        );
    }
    for (const [i, ex] of (repair.examples ?? []).entries()) {
        lines.push(
            '',
            `EARLIER SUCCESSFUL REQUEST ${i + 1}:`,
            json(ex.input),
            'answered:',
            json(ex.output).slice(0, 3000),
        );
    }
    return lines.join('\n');
}

export function retryNudge(diagnostics: readonly string[]): string {
    return [
        'The handler has not passed test_handler yet. Fix these and test again:',
        '',
        ...diagnostics,
    ].join('\n');
}

const json = (value: unknown): string => JSON.stringify(value, null, 1);
