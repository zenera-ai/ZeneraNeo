import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { type Anchor } from './types.ts';

// ---------------------------------------------------------------------------
// Sections of a source file
//
// A case remembers the part of a source it was read from, and finding that part
// again has to be mechanical: no model, no judgement, the same answer on every
// machine. So an anchor is something a parser can follow — a markdown heading
// path, a JSON pointer, or the whole file — and the section it names is hashed
// in a normal form, so a re-wrapped line ending is not a change and a changed
// sentence is.
// ---------------------------------------------------------------------------

export type Found =
    | { found: true; text: string; sha256: string }
    | { found: false; why: 'no file' | 'not found' | 'ambiguous' | 'unreadable' };

interface Heading {
    level: number;
    title: string;
    path: string[];
    /** first line, and one past the last line of its section */
    start: number;
    end: number;
}

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

const normal = (text: string): string =>
    text
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map((line) => line.trimEnd())
        .join('\n')
        .replace(/\n+$/, '');

const title = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Every ATX heading outside a code fence, with the extent of its section. */
export function headingsOf(text: string): Heading[] {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const found: Heading[] = [];
    const stack: Heading[] = [];
    let fence: { char: string; size: number } | undefined;
    lines.forEach((line, i) => {
        const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
        if (marker) {
            const char = marker[1][0];
            if (!fence) {
                fence = { char, size: marker[1].length };
            } else if (fence.char === char && marker[1].length >= fence.size) {
                fence = undefined;
            }
            return;
        }
        if (fence) {
            return;
        }
        const m = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(line);
        if (!m || !m[2]?.trim()) {
            return;
        }
        const level = m[1].length;
        while (stack.length > 0 && stack[stack.length - 1].level >= level) {
            stack.pop();
        }
        const heading: Heading = {
            level,
            title: title(m[2]),
            path: [...stack.map((h) => h.title), title(m[2])],
            start: i,
            end: lines.length,
        };
        stack.push(heading);
        found.push(heading);
    });
    for (let i = 0; i < found.length; i++) {
        const next = found.slice(i + 1).find((h) => h.level <= found[i].level);
        found[i].end = next ? next.start : lines.length;
    }
    return found;
}

/**
 * The last name must be the heading's own; the names before it must appear, in
 * order, among its ancestors. So `["Query: organize my day"]` is enough while it
 * is unique, and an author adds a parent only to tell two apart.
 */
function matches(path: readonly string[], heading: Heading): boolean {
    const want = path.map(title);
    if (want[want.length - 1] !== heading.title) {
        return false;
    }
    let at = 0;
    for (const name of heading.path.slice(0, -1)) {
        if (at < want.length - 1 && name === want[at]) {
            at++;
        }
    }
    return at === want.length - 1;
}

/** RFC 6901, over a parsed JSON or YAML document. */
function follow(doc: unknown, pointer: string): { ok: boolean; value?: unknown } {
    if (pointer === '') {
        return { ok: true, value: doc };
    }
    let at: unknown = doc;
    for (const raw of pointer.slice(1).split('/')) {
        const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
        if (Array.isArray(at) && /^\d+$/.test(key) && Number(key) < at.length) {
            at = at[Number(key)];
        } else if (at !== null && typeof at === 'object' && !Array.isArray(at) && key in at) {
            at = (at as Record<string, unknown>)[key];
        } else {
            return { ok: false };
        }
    }
    return { ok: true, value: at };
}

const escapeKey = (key: string): string => key.replace(/~/g, '~0').replace(/\//g, '~1');

/** Sorted keys, so reformatting or reordering a document is not a change. */
export function canonical(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(canonical).join(',')}]`;
    }
    if (value !== null && typeof value === 'object') {
        const keys = Object.keys(value).sort();
        return `{${keys
            .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
            .join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}

/** One read of each file per instance: a drift check asks about many cases per file. */
export class Sources {
    readonly root: string;
    #text = new Map<string, string | undefined>();
    #headings = new Map<string, Heading[]>();
    #docs = new Map<string, { ok: boolean; doc?: unknown }>();

    constructor(root: string) {
        this.root = root;
    }

    text(file: string): string | undefined {
        if (!this.#text.has(file)) {
            let text: string | undefined;
            try {
                text = readFileSync(resolve(this.root, file), 'utf8');
            } catch {
                text = undefined;
            }
            this.#text.set(file, text);
        }
        return this.#text.get(file);
    }

    /** Of the bytes as they are: any edit at all, even one no case sees. */
    hash(file: string): string | undefined {
        const text = this.text(file);
        return text === undefined ? undefined : sha256(text);
    }

    #headingsOf(file: string, text: string): Heading[] {
        let found = this.#headings.get(file);
        if (!found) {
            found = headingsOf(text);
            this.#headings.set(file, found);
        }
        return found;
    }

    #doc(file: string, text: string): { ok: boolean; doc?: unknown } {
        let parsed = this.#docs.get(file);
        if (!parsed) {
            try {
                const ext = extname(file).toLowerCase();
                parsed = { ok: true, doc: ext === '.json' ? JSON.parse(text) : parseYaml(text) };
            } catch {
                parsed = { ok: false };
            }
            this.#docs.set(file, parsed);
        }
        return parsed;
    }

    section(file: string, anchor: Anchor | undefined): Found {
        const text = this.text(file);
        if (text === undefined) {
            return { found: false, why: 'no file' };
        }
        if (anchor?.heading) {
            const hits = this.#headingsOf(file, text).filter((h) => matches(anchor.heading!, h));
            if (hits.length !== 1) {
                return { found: false, why: hits.length === 0 ? 'not found' : 'ambiguous' };
            }
            const lines = text.replace(/\r\n?/g, '\n').split('\n');
            const body = normal(lines.slice(hits[0].start, hits[0].end).join('\n'));
            return { found: true, text: body, sha256: sha256(body) };
        }
        if (anchor?.pointer !== undefined) {
            const parsed = this.#doc(file, text);
            if (!parsed.ok) {
                return { found: false, why: 'unreadable' };
            }
            const hit = follow(parsed.doc, anchor.pointer);
            if (!hit.ok) {
                return { found: false, why: 'not found' };
            }
            const body = canonical(hit.value);
            return { found: true, text: body, sha256: sha256(body) };
        }
        const body = normal(text);
        return { found: true, text: body, sha256: sha256(body) };
    }

    /**
     * Sections of a file no case and no ignore accounts for: headings at the
     * levels the covered ones sit at, or the siblings of covered pointers. A
     * section inside a covered one is part of that case, and a section around one
     * is its context, so neither is reported.
     */
    uncovered(file: string, covered: readonly (Anchor | undefined)[]): Anchor[] {
        const text = this.text(file);
        if (text === undefined || covered.some((a) => !a?.heading && a?.pointer === undefined)) {
            return [];
        }
        const out: Anchor[] = [];
        const paths = covered.flatMap((a) => (a?.heading ? [a.heading] : []));
        if (paths.length > 0) {
            const all = this.#headingsOf(file, text);
            const hit = all.filter((h) => paths.some((p) => matches(p, h)));
            const levels = new Set(hit.map((h) => h.level));
            const near = (h: Heading): boolean =>
                hit.some(
                    (c) =>
                        c === h ||
                        (c.start <= h.start && h.start < c.end) ||
                        (h.start <= c.start && c.start < h.end),
                );
            for (const h of all) {
                if (levels.has(h.level) && !near(h)) {
                    out.push({ heading: h.path });
                }
            }
        }
        const pointers = covered.flatMap((a) => (a?.pointer ? [a.pointer] : []));
        if (pointers.length > 0) {
            const parsed = this.#doc(file, text);
            const taken = new Set(pointers);
            const parents = new Set(pointers.map((p) => p.slice(0, p.lastIndexOf('/'))));
            for (const parent of parents) {
                const hit = parsed.ok ? follow(parsed.doc, parent) : { ok: false };
                if (!hit.ok || hit.value === null || typeof hit.value !== 'object') {
                    continue;
                }
                const keys = Array.isArray(hit.value)
                    ? hit.value.map((_, i) => String(i))
                    : Object.keys(hit.value);
                for (const key of keys) {
                    const pointer = `${parent}/${escapeKey(key)}`;
                    if (!taken.has(pointer)) {
                        out.push({ pointer });
                    }
                }
            }
        }
        return out;
    }
}
