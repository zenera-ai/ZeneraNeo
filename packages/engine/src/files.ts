import { ASSETS_MOUNT, assetsDir, readProjectConfig, RootedFs, type Tree } from '@zenera/neo';
import { closeSync, createReadStream, fstatSync, openSync, realpathSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, posix } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { workspaceMount } from './uploads.ts';

// ---------------------------------------------------------------------------
// A session's files, for a person to look at
//
// The agent names its files the way its sandbox mounts them — `/workspace/x.png`,
// `file:///workspace/a%20b.csv`, `/assets/logo.svg` — and a chat shows those
// names as links and images. This turns such a name into the file on this
// machine, under the same containment the file tools have, and sends it.
// Only the session's workspace and the project's assets are reached: never the
// skills, never a dot-folder (`.env`, `.data`, `.git`), never a symlink out.
// Nothing here knows about users: the host has already decided whose session it is.
// ---------------------------------------------------------------------------

/** Where a session's readable trees are, and the names the agent knows them by. */
export interface FileTrees {
    /** the session's workspace on this machine */
    workspace: string;
    /** what the agent calls it: `sandbox.workdir`, else /workspace */
    workdir: string;
    /** the project's assets on this machine, mounted read-only at /assets */
    assets?: string;
    /**
     * Agent paths under which dot-folders may be read, e.g. a test chat's uploads under
     * `/workspace/.tmp/...` when the workspace is the project itself.
     */
    dotted?: readonly string[];
}

/** A file that may be sent: where it is, and what it was when looked at. */
export interface AgentFile {
    /** the agent's name for it, normalized */
    path: string;
    tree: 'workspace' | 'assets';
    /** on this machine, symlinks resolved */
    host: string;
    size: number;
    mtimeMs: number;
    /** identity, so the file opened is the file checked */
    ino: number;
    dev: number;
}

export type AgentFileErrorCode = 'invalid' | 'outside' | 'hidden' | 'missing';

export class AgentFileError extends Error {
    readonly code: AgentFileErrorCode;
    constructor(code: AgentFileErrorCode, message: string) {
        super(message);
        this.name = 'AgentFileError';
        this.code = code;
    }
}

/** The HTTP status an AgentFileError means. */
export function agentFileStatus(code: AgentFileErrorCode): number {
    return code === 'invalid' ? 400 : code === 'missing' ? 404 : 403;
}

/** A session's trees in a project: its workspace, the workdir and the assets the project has. */
export function fileTrees(projectDir: string, workspace: string): FileTrees {
    let assets: string | undefined;
    try {
        const { root, config } = readProjectConfig(projectDir);
        assets = assetsDir(root, config);
    } catch {
        // A config that does not load has no assets to show; the workspace still has its files.
    }
    return { workspace, workdir: workspaceMount(projectDir), ...(assets ? { assets } : {}) };
}

const FILE_SCHEME = 'file://';
const MAX_PATH = 4096;

/**
 * The agent path a link names, or undefined when it names none: `file:///workspace/a%20b.png`
 * (decoded, query and fragment dropped), the looser `file://workspace/x`, an absolute path, or
 * one relative to the workspace. Lexical: no file is touched.
 */
export function agentFilePath(link: string, workdir = '/workspace'): string | undefined {
    if (typeof link !== 'string' || !link || link.length > MAX_PATH) {
        return undefined;
    }
    let path = link;
    if (/^file:/i.test(path)) {
        if (!path.toLowerCase().startsWith(FILE_SCHEME)) {
            return undefined;
        }
        path = path.slice(FILE_SCHEME.length);
        const cut = path.search(/[?#]/);
        if (cut >= 0) {
            path = path.slice(0, cut);
        }
        try {
            path = decodeURIComponent(path);
        } catch {
            return undefined;
        }
        // `file://workspace/x`: the host part is the first segment.
        if (!path.startsWith('/')) {
            path = `/${path}`;
        }
    } else if (/^[a-z][\w+.-]*:/i.test(path)) {
        return undefined;
    }
    if (!path || path.includes('\0')) {
        return undefined;
    }
    path = path.replace(/\\/g, '/');
    const at = posix.normalize(path.startsWith('/') ? path : posix.join(workdir, path));
    return at.length > 1 ? at.replace(/\/+$/, '') : at;
}

/** Whether `at` is `base` or under it. */
const under = (at: string, base: string) => at === base || at.startsWith(`${base}/`);

function hiddenIn(at: string, tree: string, dotted: readonly string[]): boolean {
    if (dotted.some((d) => under(at, d))) {
        return false;
    }
    return posix
        .relative(tree, at)
        .split('/')
        .some((s) => s.startsWith('.') && s !== '.');
}

/**
 * The file a link names in a session, contained: in the workspace or the assets, a regular
 * file, no dot-folder on the way to it as asked or as its symlinks resolve. Throws AgentFileError.
 */
export function resolveAgentFile(link: string, trees: FileTrees): AgentFile {
    const workdir = posix.normalize(trees.workdir);
    const at = agentFilePath(link, workdir);
    if (!at) {
        throw new AgentFileError('invalid', `not a file path: ${String(link).slice(0, 200)}`);
    }
    const roots: Tree[] = [{ at: workdir, dir: trees.workspace, readOnly: true }];
    const withAssets =
        trees.assets !== undefined &&
        !under(ASSETS_MOUNT, workdir) &&
        !under(workdir, ASSETS_MOUNT);
    if (withAssets) {
        roots.push({ at: ASSETS_MOUNT, dir: trees.assets!, readOnly: true });
    }
    const treeOf = (p: string) => (withAssets && under(p, ASSETS_MOUNT) ? ASSETS_MOUNT : workdir);
    if (!roots.some((r) => under(at, r.at))) {
        throw new AgentFileError('outside', `outside the workspace: ${at}`);
    }
    const dotted = (trees.dotted ?? []).map((d) => posix.normalize(d));
    if (hiddenIn(at, treeOf(at), dotted)) {
        throw new AgentFileError('hidden', `hidden files are not shown: ${at}`);
    }

    const fs = new RootedFs(roots);
    let real: string;
    try {
        // Contains the path, symlinks and all, in one of the trees.
        real = realpathSync(fs.hostPath(at));
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
            throw new AgentFileError('missing', `no such file: ${at}`);
        }
        throw new AgentFileError('outside', `outside the workspace: ${at}`);
    }
    // Where the link really leads must pass the same rules as the name it was asked by.
    const target = fs.agentPath(real);
    if (!target) {
        throw new AgentFileError('outside', `outside the workspace: ${at}`);
    }
    if (hiddenIn(target, treeOf(target), dotted)) {
        throw new AgentFileError('hidden', `hidden files are not shown: ${at}`);
    }
    const info = statSync(real, { throwIfNoEntry: false });
    if (!info?.isFile()) {
        throw new AgentFileError('missing', `no such file: ${at}`);
    }
    return {
        path: at,
        tree: treeOf(at) === ASSETS_MOUNT ? 'assets' : 'workspace',
        host: real,
        size: info.size,
        mtimeMs: info.mtimeMs,
        ino: info.ino,
        dev: info.dev,
    };
}

const TYPES: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.bmp': 'image/bmp',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.pdf': 'application/pdf',
    '.json': 'application/json',
    '.geojson': 'application/geo+json',
    '.jsonl': 'application/x-ndjson',
    '.ndjson': 'application/x-ndjson',
    '.csv': 'text/csv',
    '.tsv': 'text/tab-separated-values',
    '.txt': 'text/plain',
    '.log': 'text/plain',
    '.md': 'text/markdown',
    '.yaml': 'text/yaml',
    '.yml': 'text/yaml',
    '.parquet': 'application/vnd.apache.parquet',
    '.arrow': 'application/vnd.apache.arrow.file',
    '.zip': 'application/zip',
    '.gz': 'application/gzip',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.xml': 'application/xml',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.css': 'text/css',
};

/** Shown in place when opened; anything else is a download, so it cannot run as the page. */
const INLINE =
    /^(image\/(?!svg)|audio\/|video\/|text\/(plain|csv|tab-separated-values|markdown|yaml)$|application\/(pdf|json|geo\+json|x-ndjson)$)/;

/**
 * Where a page served for viewing may load scripts, styles and fonts from besides itself: the
 * public npm CDNs charting libraries are published on.
 */
export const VIEW_CDNS: readonly string[] = [
    'https://cdn.jsdelivr.net',
    'https://unpkg.com',
    'https://cdnjs.cloudflare.com',
];

/**
 * The policy of a file served for viewing (`/v/<token>/...`): a page an agent wrote runs its
 * scripts in an opaque origin of its own (`sandbox allow-scripts`: no cookies, storage or token
 * of the chat's, no forms, no top navigation), reads the session's files it names by relative
 * path (`'self'`), loads libraries from VIEW_CDNS and talks to nothing else. `frameAncestors`:
 * who may show it in a frame (`'self'` when the chat is served from the same origin).
 */
export function viewCsp(frameAncestors: readonly string[] = ["'self'"]): string {
    const cdns = VIEW_CDNS.join(' ');
    return [
        'sandbox allow-scripts allow-popups',
        "default-src 'self'",
        `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: ${cdns}`,
        `style-src 'self' 'unsafe-inline' ${cdns}`,
        "img-src 'self' data: blob:",
        `font-src 'self' data: ${cdns}`,
        "media-src 'self' data: blob:",
        "connect-src 'self'",
        "worker-src 'self' blob:",
        "object-src 'none'",
        "form-action 'none'",
        "base-uri 'self'",
        `frame-ancestors ${frameAncestors.length ? frameAncestors.join(' ') : "'none'"}`,
    ].join('; ');
}

/** The type a file is sent as, by its name. */
export function contentTypeOf(name: string): string {
    const type = TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream';
    return type.startsWith('text/') || type.endsWith('json') ? `${type}; charset=utf-8` : type;
}

function disposition(name: string, inline: boolean): string {
    const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
    return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function etagOf(file: AgentFile): string {
    return `"${file.size.toString(36)}-${Math.floor(file.mtimeMs).toString(36)}"`;
}

function notModified(req: IncomingMessage, etag: string, mtimeMs: number): boolean {
    const match = req.headers['if-none-match'];
    if (match !== undefined) {
        return match
            .split(',')
            .map((t) => t.trim().replace(/^W\//, ''))
            .some((t) => t === etag || t === '*');
    }
    const since = Date.parse(req.headers['if-modified-since'] ?? '');
    return !Number.isNaN(since) && Math.floor(mtimeMs / 1000) * 1000 <= since;
}

/** The one byte range asked for: null for the whole file, 'unsatisfiable' for none of it. */
function rangeOf(
    req: IncomingMessage,
    size: number,
    etag: string,
    mtimeMs: number,
): { start: number; end: number } | null | 'unsatisfiable' {
    const header = req.headers.range;
    if (!header) {
        return null;
    }
    const ifRange = req.headers['if-range'];
    if (typeof ifRange === 'string') {
        const date = Date.parse(ifRange);
        const same = ifRange.startsWith('"')
            ? ifRange === etag
            : !Number.isNaN(date) && Math.floor(mtimeMs / 1000) * 1000 <= date;
        if (!same) {
            return null;
        }
    }
    // Several ranges would need a multipart answer: the whole file does instead.
    const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!m || (!m[1] && !m[2])) {
        return null;
    }
    let start: number;
    let end: number;
    if (!m[1]) {
        const suffix = Number(m[2]);
        if (suffix === 0) {
            return 'unsatisfiable';
        }
        start = Math.max(0, size - suffix);
        end = size - 1;
    } else {
        start = Number(m[1]);
        end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    }
    if (start >= size || start > end) {
        return 'unsatisfiable';
    }
    return { start, end };
}

export interface SendFileOptions {
    /** default: workspace files revalidated every time, assets kept for 5 minutes */
    cacheControl?: string;
    /**
     * Served for viewing, as a page and the files it loads (`/v/<token>/...`): everything
     * inline, under viewCsp, readable by the page's opaque origin (CORS `*`; no credentials
     * ride along, the URL is the credential).
     */
    view?: { frameAncestors?: readonly string[] };
}

/**
 * Sends a resolved file: its type, `ETag` and `Last-Modified` (304 when the client has it),
 * one byte range when asked (206, or 416), HEAD without a body. What the agent wrote may be
 * steered by whatever it read, so nothing is let run as the page that shows it: `nosniff`,
 * a sandboxing CSP, and anything not plainly viewable (html, svg, scripts) sent as a download.
 * An `<img>` still shows an svg. In `view` mode a page does run, but only under viewCsp.
 * Resolves when the response has ended.
 */
export async function sendAgentFile(
    req: IncomingMessage,
    res: ServerResponse,
    file: AgentFile,
    opts: SendFileOptions = {},
): Promise<void> {
    // Open first, then make sure the file opened is the one that was checked: a symlink
    // swapped in between would point the open somewhere else.
    let fd: number;
    try {
        fd = openSync(file.host, 'r');
    } catch {
        throw new AgentFileError('missing', `no such file: ${file.path}`);
    }
    let owned = true;
    try {
        const info = fstatSync(fd);
        if (!info.isFile() || info.ino !== file.ino || info.dev !== file.dev) {
            throw new AgentFileError('missing', `no such file: ${file.path}`);
        }
        const current: AgentFile = { ...file, size: info.size, mtimeMs: info.mtimeMs };
        const etag = etagOf(current);
        const type = contentTypeOf(file.path);
        const inline = opts.view !== undefined || INLINE.test(type);
        res.setHeader(
            'Cache-Control',
            opts.cacheControl ??
                (file.tree === 'assets' ? 'private, max-age=300' : 'private, no-cache'),
        );
        res.setHeader('ETag', etag);
        res.setHeader('Last-Modified', new Date(current.mtimeMs).toUTCString());
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
        // Chrome refuses to show a pdf under a sandboxing CSP; a pdf is shown by the browser's
        // own viewer, not as the page.
        if (type !== 'application/pdf') {
            res.setHeader(
                'Content-Security-Policy',
                opts.view ? viewCsp(opts.view.frameAncestors) : 'sandbox',
            );
        }
        if (opts.view) {
            res.setHeader('Access-Control-Allow-Origin', '*');
        }
        if (notModified(req, etag, current.mtimeMs)) {
            res.statusCode = 304;
            res.end();
            return;
        }
        res.setHeader('Content-Type', type);
        res.setHeader('Content-Disposition', disposition(posix.basename(file.path), inline));
        res.setHeader('Accept-Ranges', 'bytes');
        const range = rangeOf(req, current.size, etag, current.mtimeMs);
        if (range === 'unsatisfiable') {
            res.statusCode = 416;
            res.setHeader('Content-Range', `bytes */${current.size}`);
            res.end();
            return;
        }
        const start = range?.start ?? 0;
        const end = range?.end ?? current.size - 1;
        res.statusCode = range ? 206 : 200;
        if (range) {
            res.setHeader('Content-Range', `bytes ${start}-${end}/${current.size}`);
        }
        res.setHeader('Content-Length', String(Math.max(0, end - start + 1)));
        if (req.method === 'HEAD' || current.size === 0) {
            res.end();
            return;
        }
        owned = false;
        const stream = createReadStream('', { fd, start, end, autoClose: true });
        try {
            await pipeline(stream, res);
        } catch {
            // The client went away, or the file shrank underneath: nothing left to tell anyone.
            res.destroy();
        }
    } finally {
        if (owned) {
            closeSync(fd);
        }
    }
}
