import { RootedFs, type Workspace } from '@zenera/neo';
import { statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { Block, Span } from './wrap.ts';

// ---------------------------------------------------------------------------
// Mounted paths, as links to this machine
//
// The agent names its files the way the sandbox mounts them — `/workspace/x`,
// `/assets/x`, `file:///workspace/x` — and none of them opens anything on the
// host. Text is never changed where the terminal can carry a hyperlink: the
// path stays as the agent wrote it and the click goes to the real file.
// ---------------------------------------------------------------------------

export interface Mounts {
    /** every name a tree is reached by, longest first */
    names: readonly string[];
    /** the host path an agent path names, or nothing when it is in no tree */
    resolve(path: string): string | undefined;
    /** the host file a workspace-relative path names, only when that file exists */
    file(path: string): string | undefined;
}

/**
 * Exactly the trees the file tools reach, under the same containment: a name
 * becomes a link only where the files are on this machine, and only to where
 * the fs itself would go — a symlink out of a tree is no more a link than it is
 * a file the tools reach.
 */
export function mountsOf(files: Workspace): Mounts {
    const fs = files.fs instanceof RootedFs ? files.fs : undefined;
    const names = files.mount ? files.trees() : files.trees().slice(1);
    const resolve = (path: string): string | undefined => {
        const at = files.locate(path)?.at;
        if (!fs || !at) {
            return undefined;
        }
        try {
            return fs.hostPath(at);
        } catch {
            return undefined;
        }
    };
    return {
        names: names.sort((a, b) => b.length - a.length),
        resolve,
        file: (path) => {
            const host = resolve(path);
            return host && statSync(host, { throwIfNoEntry: false })?.isFile() ? host : undefined;
        },
    };
}

const FILE = 'file://';

/** Prose punctuation that ends a sentence, not a path. */
const TRAILING = /[.,;:!?'"]+$/;

/** The host `file:` url a mounted path names, or nothing. */
export function mountUrl(token: string, mounts: Mounts): string | undefined {
    let path = token;
    let fragment = '';
    if (path.startsWith(FILE)) {
        path = path.slice(FILE.length);
        const cut = path.search(/[?#]/);
        if (cut >= 0) {
            fragment = path.slice(cut);
            path = path.slice(0, cut);
        }
        try {
            path = decodeURIComponent(path);
        } catch {
            return undefined;
        }
    }
    // `within` also takes relative paths and `/`; only a mount name counts here.
    if (!mounts.names.some((n) => path === n || path.startsWith(`${n}/`))) {
        return undefined;
    }
    const host = mounts.resolve(path);
    return host ? pathToFileURL(host).href + fragment : undefined;
}

/** `scripts/x.py`, `README.md` — no scheme, no leading slash, no spaces. */
const RELATIVE = /^[\w@+-][\w.@+-]*(?:\/[\w.@+-]+)*$/;

/** The host `file:` url of a workspace-relative path in code, when that file exists. */
function relativeUrl(text: string, mounts: Mounts): string | undefined {
    // Without a `.` or `/` it is an identifier, not worth a stat.
    if (!RELATIVE.test(text) || !/[./]/.test(text)) {
        return undefined;
    }
    const host = mounts.file(text);
    return host ? pathToFileURL(host).href : undefined;
}

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`);

/** Every spelling of a mounted path in running text. */
function pattern(mounts: Mounts): RegExp {
    const names = mounts.names.map(escaped).join('|');
    return new RegExp(
        `(?<![\\w/.:-])(?:${FILE})?(?:${names})(?![\\w-]|\\.\\w)(?:/[^\\s<>"'\`()[\\]{}|\\\\^]*)?`,
        'g',
    );
}

/** Each mounted path in `text`, without the punctuation that follows it. */
function* matches(text: string, mounts: Mounts): Generator<{ at: number; token: string }> {
    if (mounts.names.length === 0) {
        return;
    }
    for (const m of text.matchAll(pattern(mounts))) {
        const token = m[0].replace(TRAILING, '');
        if (token) {
            yield { at: m.index, token };
        }
    }
}

/**
 * The same spans with the same text, mounted paths carrying a host `href`.
 *
 * Only `href` changes, so every width measured from `span.text` still holds.
 */
export function linkSpans(spans: readonly Span[], mounts: Mounts): Span[] {
    const out: Span[] = [];
    for (const span of spans) {
        if (span.href) {
            const url = mountUrl(span.href, mounts);
            out.push(url ? { ...span, href: url } : span);
            continue;
        }
        if (span.code) {
            const url = relativeUrl(span.text, mounts);
            if (url) {
                out.push({ ...span, href: url });
                continue;
            }
        }
        let from = 0;
        for (const { at, token } of matches(span.text, mounts)) {
            const url = mountUrl(token, mounts);
            if (!url) {
                continue;
            }
            if (at > from) {
                out.push({ ...span, text: span.text.slice(from, at) });
            }
            out.push({ ...span, text: token, href: url });
            from = at + token.length;
        }
        if (from === 0) {
            out.push(span);
        } else if (from < span.text.length) {
            out.push({ ...span, text: span.text.slice(from) });
        }
    }
    return out;
}

/** A block whose prose and cells link their mounted paths; a fence is left alone. */
export function linkBlock(block: Block, mounts: Mounts): Block {
    return {
        ...block,
        ...(block.spans ? { spans: linkSpans(block.spans, mounts) } : {}),
        ...(block.cells
            ? { cells: block.cells.map((row) => row.map((cell) => linkSpans(cell, mounts))) }
            : {}),
    };
}

/** For a terminal with no hyperlinks: every `file:///<mount>/…` url, rewritten to the host. */
export function hostUrls(text: string, mounts: Mounts): string {
    let out = '';
    let from = 0;
    for (const { at, token } of matches(text, mounts)) {
        const url = token.startsWith(FILE) ? mountUrl(token, mounts) : undefined;
        if (!url) {
            continue;
        }
        out += text.slice(from, at) + url;
        from = at + token.length;
    }
    return out + text.slice(from);
}

/** `text` as an OSC 8 hyperlink to `href`. */
export function hyperlink(href: string, text: string): string {
    return `\u001b]8;;${href}\u001b\\${text}\u001b]8;;\u001b\\`;
}

/** Whether this terminal turns OSC 8 into a link; an unknown one is assumed not to. */
export function hyperlinks(env: NodeJS.ProcessEnv = process.env): boolean {
    const forced = env.FORCE_HYPERLINK;
    if (forced !== undefined && forced !== '') {
        return forced !== '0' && forced !== 'false';
    }
    if (env.WT_SESSION || env.KITTY_WINDOW_ID || env.KONSOLE_VERSION) {
        return true;
    }
    if (['iTerm.app', 'vscode', 'WezTerm', 'ghostty'].includes(env.TERM_PROGRAM ?? '')) {
        return true;
    }
    if (env.TERM === 'xterm-kitty' || env.TERM === 'xterm-ghostty') {
        return true;
    }
    return Number(env.VTE_VERSION ?? 0) >= 5000;
}
