import { bannerArt } from '@zenera/cli/lib';
import { basename } from 'node:path';
import type { Schema } from './schema.ts';
import { called, type Operation, type ParamSpec } from './spec.ts';

// ---------------------------------------------------------------------------
// The index page
//
// What a person does first with a mock is point a browser at it, and a 404 on
// `/` tells them nothing about what the thing is serving. So the root is a
// contents page: every operation, grouped by the document it came from, in the
// order the document declared it, and a button that calls it.
//
// It is one self-contained string — nothing is fetched over a network the mock
// may well be standing in for: the stylesheet, the run dialog's script and the
// operation descriptions it works from are all inline. The banner is the CLI's
// own art, so the page and the terminal agree about what this program is
// called.
// ---------------------------------------------------------------------------

const BRAND = { head: 'Zenera', accent: 'Gym', subtitle: 'Agent Environments' };

export function indexPage(operations: readonly Operation[]): string {
    const documents = group(operations);
    const title = `${BRAND.head} ${BRAND.accent}`;
    const at = new Map(operations.map((operation, i) => [operation, i]));
    // `<` is escaped so no description can close this script element early.
    const descriptors = JSON.stringify(operations.map(callable)).replace(/</g, '\\u003c');
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<header>
${banner()}
<p class="caption">${esc(BRAND.subtitle)}</p>
<p class="meta">${operations.length} operation${operations.length === 1 ? '' : 's'} &middot; ${documents.length} document${documents.length === 1 ? '' : 's'} &middot; <a href="/__gym/routes">routes</a> &middot; <a href="/__gym/health">health</a></p>
</header>
<main>
${documents.map((d) => document(d, at)).join('\n') || '<p class="empty">No operations are being served.</p>'}
</main>
${DIALOG}
<script type="application/json" id="gym-ops">${descriptors}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

/** By source document, each keeping the order its document declared. */
function group(operations: readonly Operation[]): [string, Operation[]][] {
    const out = new Map<string, Operation[]>();
    for (const operation of operations) {
        const list = out.get(operation.source) ?? [];
        list.push(operation);
        out.set(operation.source, list);
    }
    return [...out];
}

function document([source, operations]: [string, Operation[]], at: Map<Operation, number>): string {
    return `<section>
<h2>${esc(basename(source))} <span class="source">${esc(source)}</span></h2>
${operations.map((operation) => entry(operation, at.get(operation) ?? 0)).join('\n')}
</section>`;
}

function entry(operation: Operation, index: number): string {
    const parts = [
        `<div class="op">`,
        `<div class="sig"><span class="verb ${operation.method}">${operation.method.toUpperCase()}</span><code class="path">${esc(called(operation))}</code><span class="id">${esc(operation.operationId)}</span><button type="button" class="try" data-op="${index}">Run</button></div>`,
    ];
    if (operation.summary) {
        parts.push(`<p class="summary">${esc(operation.summary)}</p>`);
    }
    if (operation.description && operation.description !== operation.summary) {
        parts.push(`<p class="about">${esc(operation.description)}</p>`);
    }
    parts.push(`<p class="answer">${esc(answer(operation))}</p>`);
    if (operation.params.length > 0 || operation.requestBody) {
        parts.push(
            `<div class="rows"><table class="params">${rows(operation).join('')}</table></div>`,
        );
    }
    parts.push('</div>');
    return parts.join('\n');
}

/** The one line that says what a call gets back. */
function answer(operation: Operation): string {
    const body = operation.success.schema ? typeOf(operation.success.schema) : 'no body';
    const paged = operation.paging
        ? ` · pages by ${operation.paging.param}${operation.paging.next ? ` → ${operation.paging.next}` : ''}`
        : '';
    return `→ ${operation.success.status} ${body}${paged}`;
}

function rows(operation: Operation): string[] {
    const out = operation.params.map(
        (p: ParamSpec) =>
            `<tr><td class="name">${esc(p.name)}</td><td class="in">${esc(p.in)}</td><td class="type">${esc(typeOf(p.schema))}</td><td class="need">${p.required ? 'required' : ''}</td><td class="note">${esc(p.description ?? '')}</td></tr>`,
    );
    if (operation.requestBody) {
        out.push(
            `<tr><td class="name">body</td><td class="in">body</td><td class="type">${esc(typeOf(operation.requestBody.schema))}</td><td class="need">${operation.requestBody.required ? 'required' : ''}</td><td class="note"></td></tr>`,
        );
    }
    return out;
}

/** A schema in as many words as fit in a column: the shape, not the contract. */
function typeOf(schema: Schema, root: Schema = schema, depth = 0): string {
    const node = deref(schema, root);
    const type = Array.isArray(node.type) ? node.type.join(' | ') : node.type;
    if (type === 'array' && depth < 3) {
        const items = node.items;
        return `${isObject(items) ? typeOf(items, root, depth + 1) : 'any'}[]`;
    }
    if (Array.isArray(node.enum)) {
        return brief(
            node.enum.map((v) => String(v)),
            ' | ',
        );
    }
    if (isObject(node.properties)) {
        return `object { ${brief(Object.keys(node.properties), ', ')} }`;
    }
    if (typeof type === 'string') {
        return `${type}${typeof node.format === 'string' ? ` <${node.format}>` : ''}`;
    }
    for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
        if (Array.isArray(node[key])) {
            return key;
        }
    }
    return 'any';
}

/**
 * Anything shared or recursive was hoisted into `$defs` under a made-up name,
 * so the pointer says nothing and the shape it points at says everything.
 */
function deref(schema: Schema, root: Schema, hops = 0): Schema {
    const ref = schema.$ref;
    if (typeof ref !== 'string' || !ref.startsWith(DEFS) || hops >= 4) {
        return schema;
    }
    const defs = root.$defs;
    if (!isObject(defs)) {
        return schema;
    }
    const target = defs[ref.slice(DEFS.length)];
    return isObject(target) ? deref(target, root, hops + 1) : schema;
}

const DEFS = '#/$defs/';

// ---------------------------------------------------------------------------
// Running one
//
// The dialog is built in the browser from these, rather than a form per
// operation in the markup: a document with a thousand operations is a thousand
// forms, and only one of them is ever open.
// ---------------------------------------------------------------------------

interface Field {
    name: string;
    in: string;
    required: boolean;
    /** the hint beside the box */
    type: string;
    /** a closed set, so the box is a menu */
    choices?: string[];
    /** Inclusive JSON Schema numeric bounds, for browser-side validation. */
    minimum?: number;
    maximum?: number;
    /** JSON Schema `multipleOf`, used as the native number input step. */
    multipleOf?: number;
    numeric?: 'integer' | 'number';
    description?: string;
}

interface Callable {
    method: string;
    path: string;
    /** the path as the document writes it, query pins and all */
    shown: string;
    fields: Field[];
    body?: { required: boolean; sample: string };
}

function callable(operation: Operation): Callable {
    // Cookies are not the browser's to set from a script, so they are shown in
    // the table and left out of the form.
    const fields = operation.params
        .filter((p) => p.in !== 'cookie')
        .map((p): Field => {
            const node = deref(p.schema, p.schema);
            return {
                name: p.name,
                in: p.in,
                required: p.required,
                type: typeOf(p.schema),
                choices: choicesOf(node),
                numeric: node.type === 'integer' || node.type === 'number' ? node.type : undefined,
                minimum: typeof node.minimum === 'number' ? node.minimum : undefined,
                maximum: typeof node.maximum === 'number' ? node.maximum : undefined,
                multipleOf: typeof node.multipleOf === 'number' ? node.multipleOf : undefined,
                description: p.description,
            };
        });
    const body = operation.requestBody;
    return {
        method: operation.method,
        path: operation.path,
        shown: called(operation),
        fields,
        body: body
            ? {
                  required: body.required,
                  sample: JSON.stringify(sample(body.schema, body.schema), null, 2),
              }
            : undefined,
    };
}

function choicesOf(node: Schema): string[] | undefined {
    if (Array.isArray(node.enum)) {
        return node.enum.map((v) => String(v));
    }
    return node.type === 'boolean' ? ['true', 'false'] : undefined;
}

/** Something shaped like the body, so the textarea is edited rather than written. */
function sample(schema: Schema, root: Schema, depth = 0): unknown {
    const node = deref(schema, root);
    if (node.default !== undefined) {
        return node.default;
    }
    if (Array.isArray(node.enum)) {
        return node.enum[0];
    }
    const type = Array.isArray(node.type) ? node.type[0] : node.type;
    if (type === 'array') {
        return depth < 2 && isObject(node.items) ? [sample(node.items, root, depth + 1)] : [];
    }
    if (isObject(node.properties) && depth < 3) {
        // Only what the document insists on. An optional branch filled in with
        // blanks is a request the mock would reject before it answered.
        const need = Array.isArray(node.required) ? node.required.map(String) : null;
        const out: Record<string, unknown> = {};
        for (const [name, sub] of Object.entries(node.properties)) {
            if (isObject(sub) && (need === null || need.includes(name))) {
                out[name] = sample(sub, root, depth + 1);
            }
        }
        return out;
    }
    if (Array.isArray(node.allOf) && depth < 3) {
        // The branches of an `allOf` all apply at once, so they are merged.
        return node.allOf
            .filter(isObject)
            .reduce<Record<string, unknown>>(
                (all, branch) => Object.assign(all, sample(branch, root, depth + 1)),
                {},
            );
    }
    for (const key of ['oneOf', 'anyOf'] as const) {
        const branches = node[key];
        if (Array.isArray(branches) && isObject(branches[0]) && depth < 3) {
            return sample(branches[0], root, depth + 1);
        }
    }
    if (type === 'integer' || type === 'number') {
        return 0;
    }
    if (type === 'boolean') {
        return false;
    }
    if (type === 'string') {
        // A blank fails `format`, and the mock checks the request before it
        // answers it, so a formatted string starts out as something legal.
        return LIKE[String(node.format)] ?? '';
    }
    return type === 'object' ? {} : null;
}

const LIKE: Record<string, string> = {
    email: 'someone@example.com',
    hostname: 'example.com',
    uri: 'https://example.com',
    'uri-reference': '/example',
    uuid: '00000000-0000-4000-8000-000000000000',
    date: '2024-01-01',
    'date-time': '2024-01-01T00:00:00Z',
    time: '00:00:00',
    duration: 'P1D',
    ipv4: '127.0.0.1',
    ipv6: '::1',
};

/** A list cut short: a contents page is not the document. */
const brief = (values: string[], sep: string): string =>
    values.slice(0, MOST).join(sep) + (values.length > MOST ? `${sep}…` : '');

const MOST = 6;

const isObject = (v: unknown): v is Schema =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

/** The CLI's block face, split at the word so the accent keeps its colour. */
function banner(): string {
    const { head, accent } = bannerArt(BRAND);
    const rows = head.map(
        (row, i) =>
            `<span class="head">${paint(row)}</span>   <span class="accent">${paint(accent[i] ?? '')}</span>`,
    );
    return `<pre class="banner" role="img" aria-label="${esc(`${BRAND.head} ${BRAND.accent}`)}">${rows.join('\n')}</pre>`;
}

/**
 * Stroke and bevel, the terminal's two tones. Without the darker bevel the
 * letter reads as a doubled outline rather than as a raised face.
 */
const paint = (row: string): string =>
    row.replace(/[█▀▄]+|[^█▀▄ ]+/g, (run) =>
        /[█▀▄]/.test(run) ? `<b>${run}</b>` : `<i>${run}</i>`,
    );

const esc = (s: string): string =>
    s.replace(
        /[&<>"]/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string,
    );

const DIALOG = `<dialog id="run">
<div class="run-head"><h3 id="run-title"></h3><button type="button" id="run-close" aria-label="Close">&times;</button></div>
<form id="run-form">
<div id="run-fields"></div>
<div class="actions"><button type="submit" class="go">Run</button><button type="button" id="run-cancel" class="cancel">Cancel</button></div>
</form>
<pre id="run-out" hidden></pre>
</dialog>`;

// Values from the document reach the dialog as text nodes rather than markup:
// the page escapes what it prints, and this has to do the same by construction.
const SCRIPT = `
const specs = JSON.parse(document.getElementById('gym-ops').textContent);
const dialog = document.getElementById('run');
const title = document.getElementById('run-title');
const slots = document.getElementById('run-fields');
const form = document.getElementById('run-form');
const out = document.getElementById('run-out');
let current = null;

function box(field) {
    if (field.choices) {
        const select = document.createElement('select');
        if (!field.required) {
            select.append(new Option('', ''));
        }
        for (const choice of field.choices) {
            select.append(new Option(choice, choice));
        }
        return select;
    }
    const input = document.createElement('input');
    input.type = field.numeric ? 'number' : 'text';
    input.placeholder = field.type;
    if (field.numeric) {
        input.step = field.multipleOf === undefined ? (field.numeric === 'integer' ? '1' : 'any') : String(field.multipleOf);
        if (field.minimum !== undefined) input.min = String(field.minimum);
        if (field.maximum !== undefined) input.max = String(field.maximum);
    }
    return input;
}

function head(name, hint, required) {
    const span = document.createElement('span');
    span.className = 'label';
    span.textContent = name;
    const where = document.createElement('em');
    where.textContent = hint;
    span.append(' ', where);
    if (required) {
        const need = document.createElement('b');
        need.textContent = 'required';
        span.append(' ', need);
    }
    return span;
}

function row(field) {
    const label = document.createElement('label');
    label.className = 'field';
    const input = box(field);
    input.name = field.in + ':' + field.name;
    input.required = field.required;
    label.append(head(field.name, field.in + ' \u00b7 ' + field.type, field.required), input);
    if (field.description) {
        const note = document.createElement('small');
        note.textContent = field.description;
        label.append(note);
    }
    return label;
}

function bodyRow(body) {
    const label = document.createElement('label');
    label.className = 'field';
    const area = document.createElement('textarea');
    area.name = '@body';
    area.value = body.sample;
    area.required = body.required;
    label.append(head('body', 'application/json', body.required), area);
    return label;
}

function show(index) {
    current = specs[index];
    title.textContent = current.method.toUpperCase() + ' ' + current.shown;
    slots.replaceChildren();
    for (const field of current.fields) {
        slots.append(row(field));
    }
    if (current.body) {
        slots.append(bodyRow(current.body));
    }
    if (!current.fields.length && !current.body) {
        const hint = document.createElement('p');
        hint.className = 'hint';
        hint.textContent = 'This call takes no arguments.';
        slots.append(hint);
    }
    out.hidden = true;
    out.textContent = '';
    dialog.showModal();
}

form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const spec = current;
    const data = new FormData(form);
    const path = spec.path.replace(/\\{(.*?)\\}/g, (whole, name) =>
        encodeURIComponent(String(data.get('path:' + name) || '')),
    );
    const url = new URL(path, location.origin);
    const headers = {};
    for (const field of spec.fields) {
        const value = data.get(field.in + ':' + field.name);
        if (value === null || value === '') {
            continue;
        }
        if (field.in === 'query') {
            url.searchParams.set(field.name, value);
        }
        if (field.in === 'header') {
            headers[field.name] = value;
        }
    }
    let body;
    const typed = spec.body ? String(data.get('@body') || '').trim() : '';
    if (typed && spec.method !== 'get' && spec.method !== 'head') {
        body = typed;
        headers['content-type'] = 'application/json';
    }

    out.hidden = false;
    out.dataset.ok = 'true';
    out.textContent = 'running\u2026';
    const started = performance.now();
    try {
        const res = await fetch(url, { method: spec.method.toUpperCase(), headers, body });
        const answer = await res.text();
        let shown = answer;
        try {
            shown = JSON.stringify(JSON.parse(answer), null, 2);
        } catch {}
        out.dataset.ok = String(res.ok);
        out.textContent =
            res.status + ' ' + res.statusText + ' \u00b7 ' +
            Math.round(performance.now() - started) + 'ms \u00b7 ' +
            spec.method.toUpperCase() + ' ' + url.pathname + url.search + '\\n\\n' + shown;
    } catch (err) {
        out.dataset.ok = 'false';
        out.textContent = String(err);
    }
});

for (const button of document.querySelectorAll('button.try')) {
    button.addEventListener('click', () => show(Number(button.dataset.op)));
}
document.getElementById('run-close').addEventListener('click', () => dialog.close());
document.getElementById('run-cancel').addEventListener('click', () => dialog.close());
`;

// The two schemes are the terminal's two, and the accent is the same mint the
// `zen gym` banner is painted in on both.
const CSS = `
:root {
  color-scheme: dark light;
  --bg: #12131a; --fg: #e6e7ee; --dim: #8b8fa3; --line: #262838;
  --card: #191b25; --accent: #87ffaf; --shade: #5fd787;
}
@media (prefers-color-scheme: light) {
  :root { --bg: #fbfbfd; --fg: #1d1f2a; --dim: #6a6e80; --line: #e2e3ec;
          --card: #ffffff; --accent: #14915a; --shade: #0f7548; }
}
* { box-sizing: border-box; }
body { margin: 0; padding: 2rem 0 4rem; background: var(--bg); color: var(--fg);
  font: 15px/1.55 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif; }
header, main { width: 90%; margin: 0 auto; }
.banner { font: 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
  margin: 0; overflow-x: auto; }
.banner b, .banner i { font: inherit; }
.banner .head b { color: var(--fg); }
.banner .head i { color: var(--dim); }
.banner .accent b { color: var(--accent); }
.banner .accent i { color: var(--shade); }
.caption { margin: .75rem 0 0; color: var(--dim); letter-spacing: .35em;
  text-transform: uppercase; font-size: 11px; }
.meta { margin: .35rem 0 2.5rem; color: var(--dim); font-size: 13px; }
.meta a { color: var(--shade); text-decoration: none; }
.meta a:hover { text-decoration: underline; }
h2 { font-size: 14px; font-weight: 600; margin: 2.5rem 0 .75rem;
  padding-bottom: .4rem; border-bottom: 1px solid var(--line); }
h2 .source { font-weight: 400; color: var(--dim); font-size: 12px; margin-left: .5rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.op { background: var(--card); border: 1px solid var(--line); border-radius: 8px;
  padding: .8rem 1rem; margin: .5rem 0; }
.sig { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; }
.verb { font: 600 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .08em;
  padding: .3rem .45rem; border-radius: 4px; color: #0c0d12; background: var(--dim); }
.verb.get { background: #87ffaf; } .verb.post { background: #7fbcff; }
.verb.put { background: #ffd479; } .verb.patch { background: #d3a6ff; }
.verb.delete { background: #ff8f8f; }
.path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px;
  overflow-wrap: anywhere; }
.id { color: var(--dim); font-size: 12px; margin-left: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.summary { margin: .5rem 0 0; }
.about { margin: .3rem 0 0; color: var(--dim); font-size: 13px; white-space: pre-wrap;
  overflow-wrap: anywhere; }
.answer { margin: .5rem 0 0; color: var(--shade); font-size: 12px; overflow-wrap: anywhere;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.rows { overflow-x: auto; }
.params { margin: .6rem 0 0; border-collapse: collapse; width: 100%; font-size: 12px; }
.params td { padding: .2rem .5rem .2rem 0; vertical-align: top; overflow-wrap: break-word;
  border-top: 1px solid var(--line); }
.params .name { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.params .in, .params .need { color: var(--dim); white-space: nowrap; }
.params .type { color: var(--dim); max-width: 18rem; overflow-wrap: anywhere; }
.params .note { color: var(--dim); width: 50%; }
.empty { color: var(--dim); }
.try { background: transparent; color: var(--shade); border: 1px solid var(--line);
  border-radius: 6px; padding: .2rem .6rem; font: 600 11px/1.6 inherit; cursor: pointer; }
.try:hover { border-color: var(--accent); color: var(--accent); }
dialog { width: min(48rem, 92%); padding: 0; color: var(--fg); background: var(--card);
  border: 1px solid var(--line); border-radius: 10px; }
dialog::backdrop { background: rgba(0, 0, 0, .55); }
.run-head { display: flex; align-items: center; gap: .6rem;
  padding: .8rem 1rem; border-bottom: 1px solid var(--line); }
.run-head h3 { margin: 0; overflow-wrap: anywhere;
  font: 600 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
#run-close { margin-left: auto; background: none; border: 0; color: var(--dim);
  font-size: 18px; line-height: 1; cursor: pointer; }
#run-form { padding: 1rem; max-height: 55vh; overflow-y: auto; }
.field { display: block; margin: 0 0 .9rem; }
.field .label { font: 600 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
.field .label em { font-style: normal; font-weight: 400; color: var(--dim); font-size: 11px; }
.field .label b { color: var(--shade); font-size: 11px; }
.field small { display: block; margin-top: .2rem; color: var(--dim); font-size: 11px; }
.field input, .field select, .field textarea { display: block; width: 100%; margin-top: .3rem;
  padding: .4rem .5rem; color: var(--fg); background: var(--bg); border: 1px solid var(--line);
  border-radius: 6px; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
.field textarea { min-height: 9rem; resize: vertical; }
.hint { color: var(--dim); font-size: 13px; margin: 0 0 .9rem; }
.actions { display: flex; gap: .5rem; }
.go { background: var(--accent); color: #0c0d12; border: 0; border-radius: 6px;
  padding: .45rem 1.1rem; font: 600 13px/1.4 inherit; cursor: pointer; }
.cancel { background: transparent; color: var(--dim); border: 1px solid var(--line);
  border-radius: 6px; padding: .45rem .9rem; font: 13px/1.4 inherit; cursor: pointer; }
#run-out { margin: 0; padding: .8rem 1rem; max-height: 40vh; overflow: auto;
  border-top: 1px solid var(--line); background: var(--bg); white-space: pre-wrap;
  overflow-wrap: anywhere; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
#run-out[data-ok="false"] { color: #ff8f8f; }
`;
