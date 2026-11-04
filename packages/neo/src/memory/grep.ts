import { readFile, stat } from 'node:fs/promises';
import { PatternError, finder, type Finder, type MatchOptions } from '../match.ts';
import { hostPath } from './files.ts';
import type { Omitted } from './report.ts';
import type { MemoryStore } from './store.ts';
import { MemoryError, type MemoryNode } from './types.ts';

// ---------------------------------------------------------------------------
// The memory, read exhaustively
//
// `search` ranks and `grep` decides. They answer different questions and
// neither can be made to answer the other's: a ranking hands back the top of a
// list, so "nothing came back" and "nothing is there" are the same result, and
// the one question memory keeps raising — *did we already write this down* —
// needs them to be different results. So this is one pass, no embedder, no
// credential, and `found` is the true total even when the list was cut.
//
// Three fields, because a memory is not only its summary. `text` is what the
// ranker sees; `metadata` is where an agent puts the identifiers nobody would
// ever phrase as a sentence — a commit sha, an endpoint, a container name; and
// the bytes of a remembered file are the thing itself. An exact match belongs
// against all three.
//
// Two rules keep this honest against a raw `grep` over the memory directory,
// which is what it exists to replace. Superseded nodes are excluded unless asked for, and come
// back flagged when they are — serving a withdrawn correction as current is
// the failure mode the mount is warned about. And reading here is not use:
// recency decay is meant to track what an agent actually opened, and a finder
// that bumped it would make every scan look like a read.
// ---------------------------------------------------------------------------

/** The three places a pattern is looked for. */
export const GREP_FIELDS = ['text', 'metadata', 'file'] as const;

export type GrepField = (typeof GREP_FIELDS)[number];

/** What to do about nodes something has superseded. */
export type StaleMode = 'exclude' | 'include' | 'only';

/** A scan is bounded, because a pattern may have come from a model. */
const DEADLINE_MS = 2000;
const DEADLINE_EVERY = 100;

/** Past this a remembered file is reported as unsearched rather than read. */
export const MAX_GREP_FILE_BYTES = 256 * 1024;

/** And past this, so does the rest of the scan: one memory can hold hundreds. */
export const MAX_GREP_BYTES = 8 * 1024 * 1024;

/** Enough to see why a node matched without one file crowding out every other. */
const HITS_PER_NODE = 5;

/** A matched line, as much of it as is worth carrying. */
const EXCERPT = 240;

export interface GrepHit {
    where: GrepField;
    /** 1-based, within that field */
    line: number;
    /** the matched line, clipped around the match */
    text: string;
}

export interface MemoryMatch {
    node: MemoryNode;
    hits: GrepHit[];
    /** hits this node had beyond the ones kept */
    more: number;
    /** superseded by a newer node; only ever true when they were asked for */
    stale: boolean;
}

/** A remembered file that was not searched, so absence of a hit proves nothing. */
export interface SkippedFile {
    id: string;
    /** the mount path, as the agent knows it */
    path: string;
    reason: Omitted;
}

export interface MemoryGrepFilter extends MatchOptions {
    /** audience labels the reader holds; absent reads the graph unmasked */
    sees?: readonly string[];
    kinds?: readonly string[];
    audience?: string;
    /** only nodes that remember a file */
    files?: boolean;
    /** which fields to read; all three by default */
    in?: readonly GrepField[];
    stale?: StaleMode;
    limit?: number;
    hitsPerNode?: number;
}

export interface MemoryGrepResult {
    /** how many nodes matched, whatever was kept */
    found: number;
    matches: MemoryMatch[];
    truncated: boolean;
    skipped: SkippedFile[];
}

export async function grepMemory(
    store: MemoryStore,
    pattern: string,
    filter: MemoryGrepFilter = {},
): Promise<MemoryGrepResult> {
    const match = compile(pattern, filter);
    const fields = new Set<GrepField>(filter.in?.length ? filter.in : GREP_FIELDS);
    const kinds = filter.kinds?.length ? new Set(filter.kinds) : undefined;
    const cap = filter.hitsPerNode ?? HITS_PER_NODE;
    const want = filter.stale ?? 'exclude';
    store.refresh();
    const superseded = store.graph.superseded(filter.sees);

    const matches: MemoryMatch[] = [];
    const skipped: SkippedFile[] = [];
    const until = Date.now() + DEADLINE_MS;
    let budget = MAX_GREP_BYTES;
    let seen = 0;

    for (const node of store.graph.nodes(filter.sees)) {
        if (++seen % DEADLINE_EVERY === 0 && Date.now() > until) {
            throw new MemoryError(
                `the pattern is still running after ${DEADLINE_MS / 1000}s — it is too expensive to be useful`,
                'anchor the pattern, or narrow the scan with `kinds` or `in`',
            );
        }
        const stale = superseded.has(node.id);
        if (want === 'exclude' ? stale : want === 'only' && !stale) {
            continue;
        }
        if (kinds && !kinds.has(node.kind)) {
            continue;
        }
        if (filter.audience && !node.audience.includes(filter.audience)) {
            continue;
        }
        if (filter.files && !node.file) {
            continue;
        }

        const hits: GrepHit[] = [];
        let total = 0;
        if (fields.has('text')) {
            total += scan(hits, 'text', node.text, match, cap);
        }
        // Indented rather than compact, so a line number names a key someone
        // can search for: one-line JSON would make every hit "line 1".
        if (fields.has('metadata') && node.metadata) {
            total += scan(hits, 'metadata', JSON.stringify(node.metadata, null, 4), match, cap);
        }
        if (fields.has('file') && node.file) {
            const body = await read(store.dir, node.file, budget);
            if (body.omitted) {
                skipped.push({ id: node.id, path: node.file.path, reason: body.omitted });
            } else {
                budget -= body.bytes;
                total += scan(hits, 'file', body.text, match, cap);
            }
        }
        if (hits.length) {
            matches.push({ node, hits, more: total - hits.length, stale });
        }
    }

    // Newest first, as `zen memory ls` lists them: when a pattern matches an
    // old node and the node that corrected it, the correction should read first.
    matches.sort(
        (a, b) =>
            b.node.createdAt.localeCompare(a.node.createdAt) || a.node.id.localeCompare(b.node.id),
    );

    const found = matches.length;
    const limit = filter.limit;
    const truncated = limit !== undefined && limit >= 0 && limit < found;
    return { found, matches: truncated ? matches.slice(0, limit) : matches, truncated, skipped };
}

// ---------------------------------------------------------------------------

/**
 * A bad pattern is the model's mistake to fix, and `MemoryError` is the one
 * shape both surfaces already know how to hand back rather than throw.
 */
function compile(pattern: string, options: MatchOptions): Finder {
    try {
        return finder(pattern, options);
    } catch (err) {
        if (err instanceof PatternError) {
            throw new MemoryError(
                err.message,
                options.regex
                    ? 'fix the expression, or drop `regex` to search for the literal text'
                    : 'pass a shorter, non-empty pattern',
            );
        }
        throw err;
    }
}

/** Every matching line, of which the first `cap` are kept; the count is of all of them. */
function scan(out: GrepHit[], where: GrepField, body: string, match: Finder, cap: number): number {
    const lines = body.split('\n');
    let total = 0;
    for (let i = 0; i < lines.length; i++) {
        const at = match(lines[i]);
        if (at < 0) {
            continue;
        }
        total++;
        if (out.length < cap) {
            out.push({ where, line: i + 1, text: excerpt(lines[i], at) });
        }
    }
    return total;
}

/**
 * The line, windowed onto the match. Clipping from the front would be right for
 * prose and useless for the one case that most needs it — a minified file or a
 * long serialized value, where the hit is thousands of characters in.
 */
function excerpt(line: string, at: number): string {
    const text = line.replace(/\t/g, '    ').trimEnd();
    if (text.length <= EXCERPT) {
        return text;
    }
    const start = Math.max(0, Math.min(at - Math.floor(EXCERPT / 3), text.length - EXCERPT));
    const end = start + EXCERPT;
    return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

/**
 * A remembered file's bytes, or why they were not read. The recorded size is
 * not trusted for the decision — what is on disk is what would have to be
 * scanned — and a skip is reported rather than swallowed, because a grep that
 * silently did not look is worse than one that refused to.
 */
async function read(
    dir: string,
    file: NonNullable<MemoryNode['file']>,
    budget: number,
): Promise<{ text: string; bytes: number; omitted?: undefined } | { omitted: Omitted }> {
    const path = hostPath(dir, file);
    let size: number;
    try {
        size = (await stat(path)).size;
    } catch {
        return { omitted: 'missing' };
    }
    if (size > Math.min(MAX_GREP_FILE_BYTES, budget)) {
        return { omitted: 'too-big' };
    }
    let buf: Buffer;
    try {
        buf = await readFile(path);
    } catch {
        return { omitted: 'unreadable' };
    }
    // A NUL byte in the first few KiB is the cheap, boring test for "this is
    // not text", and it is right about every format anyone remembers on purpose.
    if (buf.subarray(0, 8192).includes(0)) {
        return { omitted: 'binary' };
    }
    return { text: buf.toString('utf8'), bytes: buf.byteLength };
}
