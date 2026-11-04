import { extname } from 'node:path';
import type { FileSource, WorkspaceFiles } from '../memory/files.ts';
import { tool, type AnyTool, type ToolContext } from '../types.ts';
import { localFs, type FsDriver, type FsStat } from './fs.ts';
import type { MountSource } from './mounts.ts';

// ---------------------------------------------------------------------------
// File tools
//
// Nothing here is wired in by default: what an agent may touch is a deployment
// decision, not a runtime one, so a host that wants filesystem access asks for
// it by calling `fileTools` and handing the result to a project. What the
// library does provide is the containment, once — every tool below resolves
// through `within`, so there is a single place where a path is allowed to
// become real.
//
// Containment is enforced on the *resolved, symlink-followed* path. Checking
// the string before resolving is the classic hole: `notes/../../.ssh/id_rsa`
// and a symlink called `notes` both pass a prefix test and both escape.
// ---------------------------------------------------------------------------

/** Reads are capped so one `cat` of a log file cannot fill the context. */
const MAX_READ = 256 * 1024;
const MAX_WRITE = 1024 * 1024;
const MAX_ENTRIES = 500;
/** Nothing is pulled into memory whole beyond this; bigger files are read by the head. */
const MAX_OPEN = 8 * 1024 * 1024;
/** How much of a file is examined to decide text vs binary. */
const SNIFF_BYTES = 8 * 1024;
/** A file is only read through to count its lines when it is at most this big. */
const MAX_SCAN = 1024 * 1024;
/** ...and one listing only spends this much on line counting in total. */
const LIST_SCAN_BUDGET = 8 * 1024 * 1024;

/** Where a project's `assets/` directory appears in the agent's namespace. */
export const ASSETS_MOUNT = '/assets';

/** ...and where its skill catalog does, so a skill's scripts can be run. */
export const SKILLS_MOUNT = '/skills';

/**
 * A second tree the agent can reach, under a name of its own. Structurally the
 * same as a `SandboxMount` on purpose: one directory is one mount, and the host
 * hands the identical array to the file tools and to the container so that both
 * call it by the same name.
 */
export interface WorkspaceMount {
    /** absolute host path; must already exist */
    host: string;
    /** absolute path the agent names it by, e.g. `/assets` */
    at: string;
    /** defaults to true — an extra tree is reference material unless said otherwise */
    readOnly?: boolean;
    /** what the tree is, for a backend that has to supply it rather than bind `host` */
    source?: MountSource;
}

export interface WorkspaceOptions {
    root: string;
    /** refuse every mutating tool; `zen run --read-only` */
    readOnly?: boolean;
    /**
     * An absolute path the root is *also* known by, because something else has
     * mounted it there — the sandbox bind-mounts the workspace at `/workspace`,
     * so `run_command` returns compiler errors, stack traces and `pwd` output
     * naming files under a prefix the file tools would otherwise refuse. Set
     * it and both spellings reach the same file.
     */
    mount?: string;
    /** further trees, each under its own name; read-only unless one says otherwise */
    mounts?: readonly WorkspaceMount[];
    /**
     * Where the bytes are; this machine's disk when unset. `root` and every
     * mount's `host` are paths in this driver's namespace.
     */
    fs?: FsDriver;
}

/** One directory the agent can reach, the name it reaches it by, and what it may do there. */
interface Root {
    path: string;
    at?: string;
    readOnly: boolean;
}

/** A mount as the workspace holds it: resolved, with its permission decided. */
export interface ResolvedMount {
    host: string;
    at: string;
    readOnly: boolean;
    source?: MountSource;
}

export class Workspace implements WorkspaceFiles {
    readonly root: string;
    readonly readOnly: boolean;
    readonly mount: string | undefined;
    /** the extra trees, resolved — the primary root is not among them */
    readonly mounts: readonly ResolvedMount[];
    /** where the bytes are; every resolved path is in its namespace */
    readonly fs: FsDriver;

    /** primary first */
    readonly #roots: Root[];
    /** the ones with a name, longest name first */
    readonly #named: (Root & { at: string })[];
    /** every root, deepest host path first, for attributing a resolved path to one */
    readonly #deep: Root[];

    constructor(opts: WorkspaceOptions) {
        this.fs = opts.fs ?? localFs;
        // Resolve the root's own symlinks once, so a workspace that *is* a
        // symlink does not fail every containment check against itself.
        this.root = this.fs.realpathSync(this.fs.path.resolve(opts.root));
        this.readOnly = opts.readOnly ?? false;
        this.mount = mountPoint(opts.mount);

        const roots: Root[] = [{ path: this.root, at: this.mount, readOnly: this.readOnly }];
        const mounts: ResolvedMount[] = [];
        for (const m of opts.mounts ?? []) {
            const at = mountPoint(m.at);
            if (at === undefined) {
                throw new Error(`a workspace mount needs an absolute name of its own: ${m.at}`);
            }
            // Overlapping names would make one path mean two directories, and
            // which one won would depend on the order they were passed in.
            for (const taken of roots) {
                if (taken.at && (at === taken.at || under(at, taken.at) || under(taken.at, at))) {
                    throw new Error(`workspace mounts overlap: ${at} and ${taken.at}`);
                }
            }
            const host = directory(this.fs, m.host, at);
            const readOnly = m.readOnly ?? true;
            roots.push({ path: host, at, readOnly });
            mounts.push({ host, at, readOnly, ...(m.source ? { source: m.source } : {}) });
        }

        this.mounts = mounts;
        this.#roots = roots;
        this.#named = roots
            .filter((r): r is Root & { at: string } => r.at !== undefined)
            .sort((a, b) => b.at.length - a.at.length);
        // A mount may sit inside the workspace root; the deeper one owns the path.
        this.#deep = [...roots].sort((a, b) => b.path.length - a.path.length);
    }

    /**
     * The one gate. Returns an absolute path inside one of the roots, or throws.
     *
     * A path that does not exist yet cannot be realpath'd, so the nearest
     * existing ancestor is resolved instead and the remainder appended — which
     * is exactly what a create needs and closes the same hole a create opens.
     */
    within(input: string, opts: { write?: boolean } = {}): string {
        if (typeof input !== 'string' || input.length === 0) {
            throw new Error('path is required');
        }
        if (input.includes('\0')) {
            throw new Error('path contains a null byte');
        }
        const { root, rest } = this.#locate(input);
        const { resolve, sep } = this.fs.path;
        const real = this.#realish(resolve(root.path, rest));
        if (real !== root.path && !real.startsWith(root.path + sep)) {
            throw new Error(`outside the workspace: ${input}`);
        }
        if (opts.write && root.readOnly) {
            throw new Error(
                root.path === this.root
                    ? 'the workspace is read-only for this run'
                    : `${root.at} is read-only`,
            );
        }
        return real;
    }

    /**
     * Which tree a path names, and where in it. `/workspace/src/a.ts` and
     * `src/a.ts` are one file under two names, and only the second resolves
     * against the root, so the mounted spelling is rewritten before anything
     * else looks at it.
     *
     * This is renaming, not permission. What comes out is still resolved, still
     * symlink-followed and still checked against its root by the caller:
     * `/workspace/../etc/passwd` loses its prefix and then fails containment
     * exactly as `../etc/passwd` does.
     */
    #locate(input: string): { root: Root; rest: string } {
        const primary = this.#roots[0];
        // A lone `/` is the model's other name for "the top of what I can see".
        // There is nothing above the root for it to mean, so it means the root
        // — refusing it teaches nothing and costs a turn. This is the only
        // absolute path treated as rooted: `/etc/passwd` still names the
        // machine's file and still fails containment.
        if (/^[\\/]+$/.test(input)) {
            return { root: primary, rest: '.' };
        }
        const at = input.replace(/\\/g, '/');
        for (const root of this.#named) {
            if (at === root.at) {
                return { root, rest: '.' };
            }
            if (at.startsWith(root.at + '/')) {
                return { root, rest: at.slice(root.at.length + 1).replace(/^\/+/, '') || '.' };
            }
        }
        return { root: primary, rest: input };
    }

    /** The root a resolved path belongs to; the primary when nothing else claims it. */
    #owner(path: string): Root {
        const { sep } = this.fs.path;
        return (
            this.#deep.find((r) => path === r.path || path.startsWith(r.path + sep)) ??
            this.#roots[0]
        );
    }

    #realish(path: string): string {
        const { dirname, join } = this.fs.path;
        const missing: string[] = [];
        let at = path;
        for (;;) {
            try {
                return join(this.fs.realpathSync(at), ...missing.reverse());
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                    throw err;
                }
                const parent = dirname(at);
                if (parent === at) {
                    // Walked to the filesystem root without finding anything
                    // real; nothing here can be inside the workspace.
                    throw new Error(`cannot resolve: ${path}`);
                }
                missing.push(at.slice(parent.length + 1));
                at = parent;
            }
        }
    }

    /** Where a path sits under its own root, in posix form. `.` is that root. */
    rel(path: string): string {
        const { relative, sep } = this.fs.path;
        return relative(this.#owner(path).path, path).split(sep).join('/') || '.';
    }

    /**
     * How a path is written back to the model, and the reason `mount` is not
     * only about what comes in. A shell in the sandbox prints the mounted name
     * — `find` returns /workspace/src/a.ts — so if the file tools answered with
     * `src/a.ts` the model would be holding two vocabularies for one tree and
     * would have to translate between them to feed one tool's output to the
     * other. With a mount configured every path in and every path out is the
     * mounted one, and copying a path from a command's output into read_file
     * is exact. Without one, everything stays relative as before.
     */
    show(path: string): string {
        const root = this.#owner(path);
        const rel = this.rel(path);
        if (root.at === undefined) {
            return rel;
        }
        return rel === '.' ? root.at : `${root.at}/${rel}`;
    }

    /** Whether a resolved path *is* one of the roots. Nothing may move or delete one. */
    isRoot(path: string): boolean {
        return this.#roots.some((r) => r.path === path);
    }

    /** Whether resolved `inner` sits strictly below resolved `outer`. */
    isInside(inner: string, outer: string): boolean {
        return inner.startsWith(outer + this.fs.path.sep);
    }

    /**
     * A file the agent named, in the form memory copies from: contained like
     * any read, and read through this workspace's driver, so remembering works
     * the same whether the bytes are on this machine or in a remote sandbox.
     */
    source(path: string): FileSource {
        const at = this.within(path);
        const fs = this.fs;
        return { path: at, stat: () => fs.stat(at), read: () => fs.readFile(at) };
    }

    /**
     * Writes bytes the agent did not type — a remembered file being copied
     * back — under the same rules as `write_file`: contained, refused in a
     * read-only tree or run, and never over an existing file unless asked.
     */
    async write(
        path: string,
        data: Uint8Array,
        opts: { overwrite?: boolean } = {},
    ): Promise<string> {
        this.mutable();
        const at = this.within(path, { write: true });
        if (this.isRoot(at)) {
            throw new Error('refusing to overwrite the workspace root');
        }
        const there = await this.fs.stat(at).catch(() => undefined);
        if (there?.isDirectory()) {
            throw new Error(`${this.show(at)} is a directory`);
        }
        if (there && !opts.overwrite) {
            throw new Error(`${this.show(at)} already exists — pass overwrite to replace it`);
        }
        await this.fs.mkdirp(this.fs.path.dirname(at));
        await this.fs.writeFile(at, data);
        return this.show(at);
    }

    mutable(): void {
        if (this.readOnly) {
            throw new Error('the workspace is read-only for this run');
        }
    }
}

/**
 * An absolute name a tree is known by, with any trailing slash removed. A mount
 * of `/` would make everything on the machine look like it was inside, so it is
 * not a mount point; nor is a relative one, which would resolve against nothing.
 */
function mountPoint(at: string | undefined): string | undefined {
    const clean = at?.replace(/\\/g, '/').replace(/\/+$/, '');
    return clean && clean.startsWith('/') ? clean : undefined;
}

function under(inner: string, outer: string): boolean {
    return inner.startsWith(outer + '/');
}

/**
 * The host side of a mount, resolved. It has to exist: a mount of nothing is a
 * typo. That it is a directory is left to the first listing, which says so in
 * the model's words — a driver on another machine could not answer sooner.
 */
function directory(fs: FsDriver, host: string, at: string): string {
    try {
        return fs.realpathSync(fs.path.resolve(host));
    } catch {
        throw new Error(`workspace mount ${at}: no such directory: ${host}`);
    }
}

/** `a`, `a and b`, `a, b and c` — these end up in sentences the model reads. */
function nameList(items: readonly string[]): string {
    if (items.length < 2) {
        return items[0] ?? '';
    }
    return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

// ---------------------------------------------------------------------------
// What a file is
//
// A listing that says nothing but a name forces the model to open everything to
// find out what it is looking at, and opening a jpeg costs a turn and teaches
// it nothing. So every entry carries its shape: the format, the size, and — for
// text — how many lines, which is the coordinate system the ranged read and the
// patcher both speak.
// ---------------------------------------------------------------------------

export type FileFormat = 'text' | 'binary' | 'image' | 'audio' | 'video' | 'pdf' | 'archive';

export interface FileInfo {
    name: string;
    kind: 'file' | 'dir' | 'link' | 'other';
    format?: FileFormat;
    bytes?: number;
    lines?: number;
}

/**
 * Formats that are decided by name alone. Everything absent from here is
 * sniffed, so an unknown extension still lands on text or binary correctly.
 * `.svg` is deliberately *not* an image: it is editable text, and calling it an
 * image would tell the model not to open it.
 */
const BY_EXTENSION: Record<string, FileFormat> = {
    '.png': 'image',
    '.jpg': 'image',
    '.jpeg': 'image',
    '.gif': 'image',
    '.webp': 'image',
    '.avif': 'image',
    '.bmp': 'image',
    '.ico': 'image',
    '.tif': 'image',
    '.tiff': 'image',
    '.heic': 'image',
    '.mp3': 'audio',
    '.wav': 'audio',
    '.flac': 'audio',
    '.ogg': 'audio',
    '.m4a': 'audio',
    '.aac': 'audio',
    '.mp4': 'video',
    '.mov': 'video',
    '.avi': 'video',
    '.mkv': 'video',
    '.webm': 'video',
    '.pdf': 'pdf',
    '.zip': 'archive',
    '.tar': 'archive',
    '.gz': 'archive',
    '.tgz': 'archive',
    '.bz2': 'archive',
    '.xz': 'archive',
    '.7z': 'archive',
    '.rar': 'archive',
    '.jar': 'archive',
};

/**
 * A NUL byte is decisive; a replacement character means the bytes are not
 * UTF-8. When the buffer is a prefix its tail may be half of a multi-byte
 * character, so the last three bytes are dropped before decoding.
 */
function looksBinary(buf: Buffer, partial: boolean): boolean {
    const view = partial ? buf.subarray(0, Math.max(0, buf.length - 3)) : buf;
    if (view.includes(0)) {
        return true;
    }
    return view.toString('utf8').includes('\uFFFD');
}

function countLines(buf: Buffer): number {
    if (buf.length === 0) {
        return 0;
    }
    let lines = 0;
    for (const byte of buf) {
        if (byte === 0x0a) {
            lines++;
        }
    }
    return buf[buf.length - 1] === 0x0a ? lines : lines + 1;
}

/** Same arithmetic as `countLines`, for content already decoded. */
function lineCount(text: string): number {
    if (text.length === 0) {
        return 0;
    }
    let lines = 1;
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 0x0a) {
            lines++;
        }
    }
    return text.endsWith('\n') ? lines - 1 : lines;
}

/**
 * `scan` is the caller's permission to read the file through — a listing hands
 * it out from a budget so that one `list_dir` of a build output directory does
 * not read a gigabyte to report line counts nobody asked for.
 */
async function inspectFile(
    fs: FsDriver,
    at: string,
    bytes: number,
    scan: boolean,
): Promise<{ format: FileFormat; lines?: number }> {
    const known = BY_EXTENSION[extname(at).toLowerCase()];
    if (known) {
        return { format: known };
    }
    if (bytes === 0) {
        return { format: 'text', lines: 0 };
    }
    if (scan && bytes <= MAX_SCAN) {
        const buf = await fs.readFile(at);
        return looksBinary(buf, false)
            ? { format: 'binary' }
            : { format: 'text', lines: countLines(buf) };
    }
    const buf = await fs.readHead(at, Math.min(bytes, SNIFF_BYTES));
    return { format: looksBinary(buf, buf.length < bytes) ? 'binary' : 'text' };
}

/** Reads a file as text, taking only the head of one too large to hold. */
async function readText(
    fs: FsDriver,
    at: string,
    bytes: number,
): Promise<{ body: string; whole: boolean }> {
    if (bytes <= MAX_OPEN) {
        return { body: (await fs.readFile(at)).toString('utf8'), whole: true };
    }
    return { body: (await fs.readHead(at, MAX_OPEN)).toString('utf8'), whole: false };
}

/** Splits into lines without inventing a trailing empty one. */
function toLines(body: string): string[] {
    const lines = body.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
    }
    return lines;
}

/** Whether every line of the file ends CRLF, so converting the lot is lossless. */
function isCrlf(body: string): boolean {
    return body.includes('\r\n') && !/(^|[^\r])\n/.test(body);
}

// ---------------------------------------------------------------------------
// The patch format
//
// A patch, not a rewrite, and not a set of line numbers either. Line numbers
// are the thing a model gets wrong: they drift the moment an earlier hunk
// changes the length of the file, and a wrong count in a `@@ -12,7 +12,9 @@`
// header either corrupts the file or forces the applier to guess. So the format
// below carries no offsets at all — a change is located by the unchanged text
// around it, and `@@ <heading>` narrows the search to the right block when the
// same lines occur more than once.
//
//     *** Begin Patch
//     *** Update File: src/server.ts
//     @@ class Server
//          start() {
//     -        this.port = 80;
//     +        this.port = 8080;
//          }
//     *** End Patch
//
// Whole files are added, deleted and moved by the same document, which is the
// real reason to have a patch at all rather than a per-file editor: a rename
// plus the edits that follow from it either both land or neither does.
//
// The grammar is the one Codex's `apply_patch` uses (sometimes called V4A), on
// purpose: frontier models have seen a great deal of it and emit it well. That
// lineage is deliberately *not* mentioned in the tool description — the sentinel
// lines and the worked example are what a model actually keys on, whereas naming
// a vendor in a prompt sent to three of them buys nothing and invites the model
// to assume behaviour of a reference implementation this parser does not share.
// ---------------------------------------------------------------------------

const BEGIN = '*** Begin Patch';
const END = '*** End Patch';
const ADD = '*** Add File: ';
const DELETE = '*** Delete File: ';
const UPDATE = '*** Update File: ';
const MOVE = '*** Move to: ';
const EOF_MARKER = '*** End of File';

/** A failure the model can act on: reported as a tool error, never thrown out. */
class PatchError extends Error {}

interface PatchChunk {
    /** `@@ heading` lines that say which block the chunk belongs to. */
    headings: string[];
    /** context + removed lines, in file order — what must be there now. */
    before: string[];
    /** context + added lines — what takes its place. */
    after: string[];
    /** the chunk is anchored to the end of the file */
    eof: boolean;
    /** 1-based line inside the patch, so an error can point at it */
    at: number;
}

type PatchOp =
    | { kind: 'add'; path: string; lines: string[]; at: number }
    | { kind: 'delete'; path: string; at: number }
    | { kind: 'update'; path: string; moveTo?: string; chunks: PatchChunk[]; at: number };

/** Only a bare `*** ` line can open a section; body lines are always prefixed. */
function isSection(line: string): boolean {
    return (
        line === END ||
        line.startsWith(ADD) ||
        line.startsWith(DELETE) ||
        line.startsWith(UPDATE) ||
        line === BEGIN
    );
}

function parsePatch(text: string): PatchOp[] {
    // A stray CR would otherwise end up inside every added line.
    const lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
    let i = 0;
    while (i < lines.length && lines[i].trim() === '') {
        i++;
    }
    if (i >= lines.length || lines[i].trim() !== BEGIN) {
        throw new PatchError(`the patch must start with '${BEGIN}'`);
    }
    i++;

    const ops: PatchOp[] = [];
    // The closing sentinel is not decoration. A blank line inside a chunk is
    // meaningful context, so without something to end the last chunk on, the
    // newline a model leaves at the end of the string becomes a blank line the
    // file has to contain — and the failure surfaces as a baffling "context not
    // found" instead of the missing marker it is.
    let closed = false;
    while (i < lines.length) {
        const line = lines[i];
        if (line.trim() === END) {
            closed = true;
            break;
        }
        if (line.trim() === '') {
            i++;
            continue;
        }
        if (line.startsWith(ADD)) {
            const at = i + 1;
            const path = line.slice(ADD.length).trim();
            i++;
            const body: string[] = [];
            while (i < lines.length && !isSection(lines[i])) {
                if (!lines[i].startsWith('+')) {
                    throw new PatchError(
                        `line ${i + 1}: every line of an added file must start with '+'`,
                    );
                }
                body.push(lines[i].slice(1));
                i++;
            }
            ops.push({ kind: 'add', path, lines: body, at });
            continue;
        }
        if (line.startsWith(DELETE)) {
            ops.push({ kind: 'delete', path: line.slice(DELETE.length).trim(), at: i + 1 });
            i++;
            continue;
        }
        if (line.startsWith(UPDATE)) {
            const at = i + 1;
            const path = line.slice(UPDATE.length).trim();
            i++;
            let moveTo: string | undefined;
            if (i < lines.length && lines[i].startsWith(MOVE)) {
                moveTo = lines[i].slice(MOVE.length).trim();
                i++;
            }
            const chunks: PatchChunk[] = [];
            let chunk: PatchChunk | undefined;
            const started = (c: PatchChunk): boolean => c.before.length > 0 || c.after.length > 0;
            const open = (): PatchChunk =>
                (chunk ??= { headings: [], before: [], after: [], eof: false, at: i + 1 });

            while (i < lines.length && !isSection(lines[i])) {
                const body = lines[i];
                if (body.startsWith('@@')) {
                    if (chunk && started(chunk)) {
                        chunks.push(chunk);
                        chunk = undefined;
                    }
                    const heading = body.slice(2).trim();
                    // `@@ ...` is a model eliding the lines between chunks, not
                    // naming a block, and there is no such line to find.
                    if (heading && !/^[.\u2026]+$/.test(heading)) {
                        open().headings.push(heading);
                    } else {
                        open();
                    }
                } else if (body === EOF_MARKER) {
                    open().eof = true;
                } else if (body === '') {
                    // A blank context line: models drop the leading space.
                    open().before.push('');
                    open().after.push('');
                } else if (body.startsWith('+')) {
                    open().after.push(body.slice(1));
                } else if (body.startsWith('-')) {
                    open().before.push(body.slice(1));
                } else if (body.startsWith(' ')) {
                    open().before.push(body.slice(1));
                    open().after.push(body.slice(1));
                } else {
                    throw new PatchError(
                        `line ${i + 1}: expected a line starting with ' ', '+' or '-': ${body}`,
                    );
                }
                i++;
            }
            if (chunk && started(chunk)) {
                chunks.push(chunk);
            }
            if (chunks.length === 0) {
                throw new PatchError(`${path}: '${UPDATE.trim()}' with nothing to change`);
            }
            ops.push({ kind: 'update', path, moveTo, chunks, at });
            continue;
        }
        throw new PatchError(`line ${i + 1}: unexpected line outside a file section: ${line}`);
    }
    if (!closed) {
        throw new PatchError(`the patch must end with '${END}'`);
    }
    if (ops.length === 0) {
        throw new PatchError('the patch changes nothing');
    }
    return ops;
}

/**
 * Finds `want` as a run of lines at or after `from`. Exact first; then ignoring
 * trailing whitespace; then ignoring indentation entirely. The looser passes
 * exist because a model reproducing context by hand gets whitespace wrong far
 * more often than it gets the code wrong — but each is a whole separate sweep,
 * so an exact match anywhere always beats a sloppy one earlier in the file.
 */
function locate(lines: string[], want: string[], from: number): { index: number; fuzz: number } {
    if (want.length === 0) {
        return { index: from, fuzz: 0 };
    }
    const passes: ((a: string, b: string) => boolean)[] = [
        (a, b) => a === b,
        (a, b) => a.trimEnd() === b.trimEnd(),
        (a, b) => a.trim() === b.trim(),
    ];
    for (const [fuzz, same] of passes.entries()) {
        for (let start = from; start + want.length <= lines.length; start++) {
            let ok = true;
            for (let k = 0; k < want.length; k++) {
                if (!same(lines[start + k], want[k])) {
                    ok = false;
                    break;
                }
            }
            if (ok) {
                return { index: start, fuzz };
            }
        }
    }
    return { index: -1, fuzz: 0 };
}

/**
 * Finds the line a `@@ heading` names. Exact, then trimmed, then any line that
 * contains it: a model writes `@@ check_risk` where the file says
 * `def check_risk(entry):`, and the worked example in the tool description —
 * `@@ class Server` — teaches exactly that. Separate sweeps, so an exact match
 * anywhere beats a loose one earlier.
 */
function findHeading(lines: string[], heading: string, from: number): number {
    const want = heading.trim();
    const passes: ((line: string) => boolean)[] = [
        (line) => line === heading,
        (line) => line.trim() === want,
        (line) => line.includes(want),
    ];
    for (const same of passes) {
        for (let i = from; i < lines.length; i++) {
            if (same(lines[i])) {
                return i;
            }
        }
    }
    return -1;
}

function indentOf(line: string): string {
    return line.slice(0, line.length - line.trimStart().length);
}

/**
 * The single shift that turns the patch's indentation into the file's, replayed
 * onto `after`. Null when the lines disagree about it: that is not a
 * mis-indented chunk, it is a chunk matched in the wrong place.
 *
 * Prefix arithmetic rather than column counts, because a tab and four spaces
 * are different bytes and Python does not treat them alike.
 */
function reindent(after: string[], file: string[], want: string[], at: number): string[] | null {
    let add: string | undefined;
    let drop: string | undefined;
    for (let k = 0; k < want.length; k++) {
        if (want[k].trim() === '') {
            continue;
        }
        const have = indentOf(file[at + k]);
        const said = indentOf(want[k]);
        const step = have.startsWith(said)
            ? { add: have.slice(said.length), drop: '' }
            : said.startsWith(have)
              ? { add: '', drop: said.slice(have.length) }
              : undefined;
        if (!step || (add !== undefined && (add !== step.add || drop !== step.drop))) {
            return null;
        }
        add = step.add;
        drop = step.drop;
    }
    if (!add && !drop) {
        return after;
    }
    return after.map((line) => {
        if (line.trim() === '') {
            return line;
        }
        const bare = drop && line.startsWith(drop) ? line.slice(drop.length) : line;
        return add ? add + bare : bare;
    });
}

/**
 * How many lines of `want` the closest near-miss got through, so an error can
 * name the line that actually diverged. Naming the first line of the block
 * instead sends the model to verify a line that was never the problem.
 */
function matchedUpTo(lines: string[], want: string[], from: number): number {
    let best = 0;
    for (let start = from; start < lines.length; start++) {
        let k = 0;
        while (k < want.length && start + k < lines.length) {
            if (lines[start + k].trim() !== want[k].trim()) {
                break;
            }
            k++;
        }
        if (k > best) {
            best = k;
        }
    }
    return best;
}

/** How many places `want` occurs at or after `from`, counted no further than two. */
function countMatches(lines: string[], want: string[], from: number): number {
    if (want.length === 0) {
        return 2;
    }
    let found = 0;
    let at = from;
    while (found < 2) {
        const hit = locate(lines, want, at);
        if (hit.index < 0) {
            break;
        }
        found++;
        at = hit.index + 1;
    }
    return found;
}

/** Applies one file's chunks to its lines. Throws `PatchError` on a miss. */
function patchLines(
    lines: string[],
    chunks: PatchChunk[],
    file: string,
): { lines: string[]; fuzz: number; ignored: number } {
    const out = lines.slice();
    let cursor = 0;
    let fuzz = 0;
    let ignored = 0;
    for (const chunk of chunks) {
        // Nothing to search for and no marker to append after: the top of the file
        // is a guess, and a guess that reports success is worse than a refusal.
        if (chunk.before.length === 0 && !chunk.eof && chunk.headings.length === 0) {
            throw new PatchError(
                `${file}: the chunk at patch line ${chunk.at} adds lines without any context, ` +
                    'so there is nowhere to put them — keep a line of the file above the ' +
                    'insertion, or end the chunk with *** End of File to append',
            );
        }
        for (const heading of chunk.headings) {
            const at = findHeading(out, heading, cursor);
            if (at < 0) {
                // A heading only narrows the search. Models invent them —
                // `@@ class RiskScanner` for a file of plain functions — and
                // when the context occurs once the heading was never needed, so
                // refusing spends a turn to learn nothing.
                if (countMatches(out, chunk.before, cursor) === 1) {
                    ignored++;
                    break;
                }
                throw new PatchError(
                    `${file}: no line matching '@@ ${heading}' after the previous chunk` +
                        (countMatches(out, chunk.before, cursor) === 0
                            ? ", and the chunk's context is not in the file either"
                            : ", and the chunk's context occurs more than once, so a heading " +
                              'that matches a line of the file is needed'),
                );
            }
            // Not `at + 1`: models routinely repeat the heading as the first
            // context line, and consuming it makes that line unfindable.
            cursor = at;
        }
        // An end-of-file chunk is tried against the tail first; failing that it
        // is an ordinary search, because the marker is often optimistic.
        let found = { index: -1, fuzz: 0 };
        if (chunk.eof) {
            const tail = out.length - chunk.before.length;
            if (tail >= cursor) {
                const hit = locate(out.slice(tail), chunk.before, 0);
                if (hit.index === 0) {
                    found = { index: tail, fuzz: hit.fuzz };
                }
            } else if (chunk.before.length === 0) {
                found = { index: out.length, fuzz: 0 };
            }
        }
        if (found.index < 0) {
            found = locate(out, chunk.before, cursor);
        }
        if (found.index < 0) {
            // Saying "not in the file" about a line that is plainly in it, just
            // above the cursor, sends the model back to re-read and retry the
            // same patch. Look once more from the top to tell the two apart.
            if (cursor > 0 && locate(out, chunk.before, 0).index >= 0) {
                throw new PatchError(
                    `${file}: the chunk at patch line ${chunk.at} matches earlier in the file ` +
                        `than the previous chunk — chunks must be in file order`,
                );
            }
            const k = matchedUpTo(out, chunk.before, cursor);
            const missed = chunk.before[k] ?? chunk.before[0] ?? '';
            throw new PatchError(
                `${file}: the chunk at patch line ${chunk.at} does not match — line ${k + 1} of ` +
                    `its context is not in the file` +
                    (missed ? `: ${missed.trim()}` : '') +
                    // A model that has been reading escaped tool output writes
                    // one patch line where the file has two.
                    (missed.includes('\\n')
                        ? " — that line holds a literal '\\n'; each line of a patch is one line " +
                          'of the file'
                        : ''),
            );
        }
        fuzz += found.fuzz > 0 ? 1 : 0;
        // Pass 2 matched by ignoring indentation, so writing `after` as the
        // patch spelled it would put the model's wrong indentation in the file
        // — a syntax error in Python, and silent, since the chunk "applied".
        let after = chunk.after;
        if (found.fuzz === 2 && after.length > 0) {
            const fixed = reindent(after, out, chunk.before, found.index);
            if (!fixed) {
                throw new PatchError(
                    `${file}: the chunk at patch line ${chunk.at} matches only when indentation ` +
                        `is ignored, and its lines disagree about how far out they are`,
                );
            }
            after = fixed;
        }
        out.splice(found.index, chunk.before.length, ...after);
        cursor = found.index + after.length;
    }
    return { lines: out, fuzz, ignored };
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

/** The family name config selects the whole set by: `tools: [files:*]` (or legacy `workspace:*`). */
const GROUP = 'files';

export function fileTools<TCtx = unknown>(opts: WorkspaceOptions): AnyTool<TCtx>[] {
    const ws = new Workspace(opts);
    const fs = ws.fs;
    const { dirname, join } = fs.path;

    // What the model is told about naming a file. The long form goes in
    // `read_file`, which is the first of these any model reaches for; the short
    // one is repeated on every `path` argument, which is where the value is
    // actually written and where a wrong guess costs a turn.
    //
    // This is also the only place an extra tree is named. Nothing else in the
    // prompt mentions one, and a directory the model has not been told about is
    // a directory it never opens.
    const extras = ws.mounts.map((m) => m.at);
    const bounds =
        extras.length === 0
            ? ' That directory is the whole of what can be reached: nothing outside it can be ' +
              'read or written.'
            : ` ${nameList(extras)} ${extras.length > 1 ? 'are' : 'is'} mounted alongside it: ` +
              `read, list and search ${extras.length > 1 ? 'them' : 'it'} like anything else, ` +
              'but nothing there can be written, moved or deleted. Nothing outside those ' +
              'directories can be reached at all.';
    const scope =
        (ws.mount
            ? `The workspace is mounted at ${ws.mount}, which is the name commands running in ` +
              `the sandbox print and the name these tools answer with, so a path from a ` +
              `command's output can be used here unchanged. A path relative to the workspace ` +
              `root names the same file: ${ws.mount}/src/a.ts and src/a.ts are one file.`
            : 'Paths are relative to the workspace root.') + bounds;
    const inside =
        (ws.mount
            ? `Path in the workspace: ${ws.mount}/src/a.ts, or src/a.ts relative to the root — ` +
              `the same file either way. The root itself is "${ws.mount}" or ".".`
            : 'Path in the workspace, relative to its root: src/a.ts. The root itself is "." ' +
              'or "/".') + (extras.length === 0 ? '' : ` Read-only: ${nameList(extras)}.`);

    // With more than one tree in reach, "/" is not another name for the
    // workspace root: it is where the trees hang, and listing it names them.
    // One tree has nothing above it, so there "/" stays the root.
    const trees: FileInfo[] | undefined =
        ws.mount && ws.mounts.length > 0
            ? [ws.mount, ...extras].map((name) => ({ name, kind: 'dir' }))
            : undefined;

    /**
     * `.`, `/`, the mount and nothing at all are four spellings of the root, and
     * a tool whose path is optional takes all four. A model that means "the top"
     * writes whichever one it has in mind, and being told `path is required`
     * because it sent "" rather than omitting the argument teaches it nothing.
     */
    const root = (path: string | undefined): string => ws.within(path?.trim() || '.');

    const readFileTool = tool<{ path: string; start_line?: number; end_line?: number }, TCtx>({
        name: 'read_file',
        group: GROUP,
        description:
            'Reads a UTF-8 text file from the workspace. ' +
            scope +
            ' Give start_line/end_line (1-based, inclusive) to read a range; without them ' +
            'the file is read from the top until the size cap, and `truncated` says whether ' +
            'anything was left. Read before patching: apply_patch matches on the exact text.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: inside },
                start_line: { type: 'integer', description: 'First line to return, 1-based.' },
                end_line: { type: 'integer', description: 'Last line to return, inclusive.' },
            },
            required: ['path'],
            additionalProperties: false,
        },
        execute: async ({ path, start_line, end_line }) => {
            const at = ws.within(path);
            const info = await fs.stat(at);
            if (info.isDirectory()) {
                return { error: `${ws.show(at)} is a directory`, hint: 'use list_dir' };
            }
            const shape = await inspectFile(fs, at, info.size, false);
            if (shape.format !== 'text') {
                return {
                    error: `${ws.show(at)} is not a text file`,
                    format: shape.format,
                    bytes: info.size,
                };
            }
            const { body, whole } = await readText(fs, at, info.size);
            const all = toLines(body);
            const total = all.length;
            const from = Math.max(1, Math.trunc(start_line ?? 1));
            const to = Math.min(total, end_line === undefined ? total : Math.trunc(end_line));
            if (from > total) {
                return { path: ws.show(at), lines: total, error: `file has ${total} lines` };
            }

            // The cap is spent line by line, so a truncated read still ends on a
            // line boundary and can be resumed from `end_line + 1`.
            const taken: string[] = [];
            let used = 0;
            let cut = false;
            for (const line of all.slice(from - 1, to)) {
                if (taken.length > 0 && used + line.length + 1 > MAX_READ) {
                    cut = true;
                    break;
                }
                taken.push(line);
                used += line.length + 1;
            }
            return {
                path: ws.show(at),
                bytes: info.size,
                lines: total,
                start_line: from,
                end_line: from + taken.length - 1,
                // Where the range started is not truncation: a read that ends
                // on the last line withheld nothing, and saying otherwise
                // teaches the model to distrust every ranged read it makes.
                truncated: cut || !whole || to < total ? true : undefined,
                content: taken.join('\n'),
            };
        },
    });

    const listDir = tool<{ path?: string }, TCtx>({
        name: 'list_dir',
        group: GROUP,
        description:
            'Lists a directory in the workspace. Each entry reports its kind, and files also ' +
            'report format (text, binary, image, audio, video, pdf, archive), size in bytes ' +
            'and, for text files that are small enough to scan, their line count.',
        parameters: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: trees
                        ? `${inside} Omit it, or give "/", to list the directories that can be ` +
                          `reached: ${nameList(trees.map((t) => t.name))}.`
                        : `${inside} Omit it to list the root.`,
                },
            },
            required: [],
            additionalProperties: false,
        },
        execute: async ({ path }) => {
            const asked = path?.trim() ?? '';
            if (trees && (asked === '' || /^[\\/]+$/.test(asked))) {
                return { path: '/', entries: trees };
            }
            const at = root(path);
            const entries = await fs.readdir(at);
            const listed: FileInfo[] = [];
            let budget = LIST_SCAN_BUDGET;
            for (const entry of entries.slice(0, MAX_ENTRIES)) {
                if (entry.isDirectory()) {
                    listed.push({ name: entry.name, kind: 'dir' });
                    continue;
                }
                if (entry.isSymbolicLink()) {
                    listed.push({ name: entry.name, kind: 'link' });
                    continue;
                }
                if (!entry.isFile()) {
                    listed.push({ name: entry.name, kind: 'other' });
                    continue;
                }
                // A file can vanish between the readdir and the stat; that is a
                // race, not a failure of the listing.
                try {
                    const info = await fs.stat(join(at, entry.name));
                    const shape = await inspectFile(
                        fs,
                        join(at, entry.name),
                        info.size,
                        info.size <= budget,
                    );
                    budget -= info.size;
                    listed.push({ name: entry.name, kind: 'file', bytes: info.size, ...shape });
                } catch {
                    listed.push({ name: entry.name, kind: 'file' });
                }
            }
            return {
                path: ws.show(at),
                entries: listed,
                truncated: entries.length > MAX_ENTRIES ? entries.length : undefined,
            };
        },
    });

    const writeFileTool = tool<{ path: string; content: string }, TCtx>({
        name: 'write_file',
        group: GROUP,
        description:
            'Creates or overwrites a UTF-8 text file in the workspace, making parent ' +
            'directories as needed. To change part of an existing file use apply_patch instead.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: inside },
                content: { type: 'string' },
            },
            required: ['path', 'content'],
            additionalProperties: false,
        },
        execute: async ({ path, content }) => {
            ws.mutable();
            if (content.length > MAX_WRITE) {
                return { error: `content exceeds ${MAX_WRITE} bytes` };
            }
            const at = ws.within(path, { write: true });
            await fs.mkdirp(dirname(at));
            await fs.writeFile(at, content);
            return {
                path: ws.show(at),
                bytes: Buffer.byteLength(content),
                lines: lineCount(content),
                written: true,
            };
        },
    });

    const applyPatch = tool<{ patch: string }, TCtx>({
        name: 'apply_patch',
        group: GROUP,
        description:
            'Applies a patch to the workspace. The patch names the text it changes instead of ' +
            'line numbers, so read the file first and copy the surrounding lines exactly.\n\n' +
            '*** Begin Patch\n' +
            '*** Update File: src/server.ts\n' +
            '@@ class Server\n' +
            '     start() {\n' +
            '-        this.port = 80;\n' +
            '+        this.port = 8080;\n' +
            '     }\n' +
            '*** End Patch\n\n' +
            'Sections: "*** Update File: <path>", optionally followed by "*** Move to: <path>" ' +
            'to rename it; "*** Add File: <path>" with every line of the new file prefixed by ' +
            '"+"; "*** Delete File: <path>". Inside an update, a line starting with a space is ' +
            'context that must already be there, "-" removes a line and "+" adds one. ' +
            '"@@ <text>" names the enclosing block when the same lines occur more than once, ' +
            'and "*** End of File" anchors a chunk to the end. Give at least three lines of ' +
            'context around each change. One patch may touch several files, and the whole of ' +
            'it is checked before anything is written: if any part fails, nothing changes.',
        parameters: {
            type: 'object',
            properties: {
                patch: {
                    type: 'string',
                    description: 'The patch, from *** Begin Patch to *** End Patch.',
                },
            },
            required: ['patch'],
            additionalProperties: false,
        },
        execute: async ({ patch }) => {
            ws.mutable();
            if (typeof patch !== 'string' || patch.trim() === '') {
                return { error: 'patch is required' };
            }
            try {
                return await runPatch(ws, patch);
            } catch (err) {
                if (err instanceof PatchError) {
                    return {
                        error: err.message,
                        hint: 'nothing was written — read the file again and rebuild the patch',
                    };
                }
                throw err;
            }
        },
    });

    const movePath = tool<{ from: string; to: string; overwrite?: boolean }, TCtx>({
        name: 'move_file',
        group: GROUP,
        description:
            'Moves or renames a file or directory inside the workspace, making the ' +
            'destination parent directories as needed. Refuses to clobber an existing ' +
            'destination unless overwrite is set.',
        parameters: {
            type: 'object',
            properties: {
                from: { type: 'string', description: `What to move. ${inside}` },
                to: { type: 'string', description: `Where it should end up. ${inside}` },
                overwrite: {
                    type: 'boolean',
                    description: 'Replace the destination if it exists.',
                },
            },
            required: ['from', 'to'],
            additionalProperties: false,
        },
        execute: async ({ from, to, overwrite }) => {
            ws.mutable();
            const source = ws.within(from, { write: true });
            const target = ws.within(to, { write: true });
            if (ws.isRoot(source)) {
                return { error: 'refusing to move the workspace root' };
            }
            if (ws.isRoot(target)) {
                return { error: 'refusing to overwrite the workspace root' };
            }
            if (source === target) {
                return { error: 'the source and the destination are the same path' };
            }
            if (ws.isInside(target, source)) {
                return { error: `cannot move ${ws.show(source)} into itself` };
            }
            await fs.stat(source); // ENOENT here is the honest error
            if (await statOrNull(fs, target)) {
                if (!overwrite) {
                    return {
                        error: `${ws.show(target)} already exists`,
                        hint: 'pass overwrite to replace it',
                    };
                }
                // rename() will not replace a non-empty directory on its own.
                await fs.rm(target, { recursive: true, force: true });
            }
            await fs.mkdirp(dirname(target));
            await fs.rename(source, target);
            return { from: ws.show(source), to: ws.show(target), moved: true };
        },
    });

    // The one mutating tool whose source may sit in a read-only tree, and the
    // reason it earns its place: reaching a mounted file otherwise means
    // reading it into the context and writing it back out, which costs a turn,
    // truncates past the read cap and cannot carry a binary at all.
    const copyPath = tool<
        { from: string; to: string; overwrite?: boolean; recursive?: boolean },
        TCtx
    >({
        name: 'copy_file',
        group: GROUP,
        description:
            'Copies a file, making the destination parent directories as needed. The source ' +
            'may be in a read-only tree, so this is how something mounted for reference is ' +
            'brought into the workspace; the destination must be writable. The bytes are ' +
            'copied directly and are not read into the conversation, so size is no object ' +
            'and a binary copies as faithfully as text. Refuses to clobber an existing ' +
            'destination unless overwrite is set, and only copies a directory, with ' +
            'everything in it, when recursive is set.',
        parameters: {
            type: 'object',
            properties: {
                from: { type: 'string', description: `What to copy. ${inside}` },
                to: { type: 'string', description: `Where the copy should land. ${inside}` },
                overwrite: {
                    type: 'boolean',
                    description: 'Replace the destination if it exists.',
                },
                recursive: {
                    type: 'boolean',
                    description: 'Required to copy a directory and its contents.',
                },
            },
            required: ['from', 'to'],
            additionalProperties: false,
        },
        execute: async ({ from, to, overwrite, recursive }) => {
            ws.mutable();
            const source = ws.within(from);
            const target = ws.within(to, { write: true });
            if (ws.isRoot(target)) {
                return { error: 'refusing to overwrite the workspace root' };
            }
            if (source === target) {
                return { error: 'the source and the destination are the same path' };
            }
            const info = await fs.stat(source); // ENOENT here is the honest error
            if (info.isDirectory()) {
                if (!recursive) {
                    return {
                        error: `${ws.show(source)} is a directory`,
                        hint: 'pass recursive to copy it and everything in it',
                    };
                }
                if (ws.isInside(target, source)) {
                    return { error: `cannot copy ${ws.show(source)} into itself` };
                }
            }
            if (await statOrNull(fs, target)) {
                if (!overwrite) {
                    return {
                        error: `${ws.show(target)} already exists`,
                        hint: 'pass overwrite to replace it',
                    };
                }
                // cp() will not replace a directory with a file, or the reverse.
                await fs.rm(target, { recursive: true, force: true });
            }
            await fs.mkdirp(dirname(target));
            await fs.copy(source, target, { recursive: recursive === true });
            const out = { from: ws.show(source), to: ws.show(target), copied: true };
            return info.isDirectory() ? { ...out, directory: true } : { ...out, bytes: info.size };
        },
    });

    const deleteFile = tool<{ path: string; recursive?: boolean }, TCtx>({
        name: 'delete_file',
        group: GROUP,
        description:
            'Deletes a file from the workspace. A directory is only removed, with everything ' +
            'in it, when recursive is set.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: inside },
                recursive: {
                    type: 'boolean',
                    description: 'Required to delete a directory and its contents.',
                },
            },
            required: ['path'],
            additionalProperties: false,
        },
        execute: async ({ path, recursive }) => {
            ws.mutable();
            const at = ws.within(path, { write: true });
            if (ws.isRoot(at)) {
                return { error: 'refusing to delete the workspace root' };
            }
            const info = await fs.stat(at);
            if (info.isDirectory()) {
                if (!recursive) {
                    return {
                        error: `${ws.show(at)} is a directory`,
                        hint: 'pass recursive to delete it and everything in it',
                    };
                }
                await fs.rm(at, { recursive: true });
                return { path: ws.show(at), deleted: true, directory: true };
            }
            await fs.rm(at);
            return { path: ws.show(at), deleted: true };
        },
    });

    const findFiles = tool<{ pattern: string; path?: string }, TCtx>({
        name: 'find_files',
        group: GROUP,
        description:
            'Finds files in the workspace whose path contains the given substring. ' +
            'Case-insensitive.',
        parameters: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'Substring to match against the path.' },
                path: {
                    type: 'string',
                    description:
                        `Directory to search under; omit it to search the whole ` +
                        `workspace. ${inside}`,
                },
            },
            required: ['pattern'],
            additionalProperties: false,
        },
        execute: async ({ pattern, path }) => {
            // Omitting the path means "everywhere I can see", and what the
            // model can see now includes the mounted trees. Searching only the
            // workspace would leave them behind a path it has to know to ask
            // for. A tree nested inside the workspace is walked twice, so the
            // hits are a set: `show` gives one file one name either way.
            const where = path?.trim()
                ? [ws.within(path)]
                : [ws.root, ...ws.mounts.map((m) => m.host)];
            const needle = pattern.toLowerCase();
            const hits = new Set<string>();
            for (const dir of where) {
                const room = await walk(dir, ws, (file) => {
                    // Matched on the path within its own tree, reported under
                    // the name the model uses: a mount prefix is on every
                    // candidate, so matching it would mean nothing.
                    if (ws.rel(file).toLowerCase().includes(needle)) {
                        hits.add(ws.show(file));
                    }
                    return hits.size < MAX_ENTRIES;
                });
                if (!room) {
                    break;
                }
            }
            return {
                pattern,
                matches: [...hits],
                truncated: hits.size >= MAX_ENTRIES,
            };
        },
    });

    return named(
        ws,
        opts.readOnly
            ? [readFileTool, listDir, findFiles]
            : [
                  readFileTool,
                  listDir,
                  findFiles,
                  writeFileTool,
                  applyPatch,
                  copyPath,
                  movePath,
                  deleteFile,
              ],
    );
}

/** What each errno means, said the way the rest of these tools say things. */
const ERRNO: Record<string, string> = {
    ENOENT: 'does not exist',
    ENOTDIR: 'is not a directory',
    EISDIR: 'is a directory',
    EEXIST: 'already exists',
    ENOTEMPTY: 'is not empty',
    EACCES: 'cannot be reached',
    EPERM: 'cannot be reached',
    ELOOP: 'is a loop of symlinks',
};

/**
 * Every path these tools are given comes back under the name the model wrote
 * it — except when the filesystem itself fails, because Node's errors name the
 * host path: `ENOENT: no such file or directory, scandir '/Users/me/proj/src'`.
 * That is a name the model has never been shown, cannot pass to another tool,
 * and will read as evidence about where it is running. So a failure is
 * rewritten into the same vocabulary as a success before it leaves.
 */
function named<TCtx>(ws: Workspace, tools: AnyTool<TCtx>[]): AnyTool<TCtx>[] {
    return tools.map((t) => ({
        ...t,
        execute: async (args: never, tc: ToolContext<TCtx>) => {
            try {
                return await t.execute(args, tc);
            } catch (err) {
                const e = err as NodeJS.ErrnoException;
                if (typeof e?.code !== 'string' || typeof e.path !== 'string') {
                    throw err;
                }
                throw new Error(`${ws.show(e.path)} ${ERRNO[e.code] ?? `failed: ${e.code}`}`, {
                    cause: err,
                });
            }
        },
    }));
}

// ---------------------------------------------------------------------------
// Applying a patch
//
// Two passes, and the split between them is the whole point: the first resolves
// every path, reads every file and works out what each one should become, in
// memory; the second writes. A patch that fails halfway through validation has
// touched nothing, so the model can be told what went wrong and try again
// against a workspace that still looks exactly as it did when it read it.
// ---------------------------------------------------------------------------

type PatchStep =
    | { kind: 'write'; at: string; content: string }
    | { kind: 'move'; from: string; to: string }
    | { kind: 'delete'; at: string };

async function runPatch(ws: Workspace, patch: string): Promise<unknown> {
    const fs = ws.fs;
    const { dirname } = fs.path;
    const ops = parsePatch(patch);
    const steps: PatchStep[] = [];
    const touched: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    // Where a move lands is a path this patch writes as surely as one it names,
    // and `rename` overwrites: without this, the last step to touch a path wins
    // and the others are lost with the patch still reporting them applied.
    const targets = new Set<string>();
    // Steps run in patch order, so a path deleted by an earlier op is free by the
    // time a later move lands on it, however occupied it still looks on disk.
    const removed = new Set<string>();
    let fuzz = 0;
    let ignored = 0;

    for (const op of ops) {
        const at = patchPath(ws, op.path);
        if (ws.isRoot(at)) {
            throw new PatchError(`${op.path} is the workspace root`);
        }
        if (seen.has(at)) {
            throw new PatchError(`${ws.show(at)} appears twice in the patch`);
        }
        if (targets.has(at)) {
            throw new PatchError(
                `${ws.show(at)} is where an earlier part of this patch moves a file`,
            );
        }
        seen.add(at);

        if (op.kind === 'delete') {
            const info = await statOrNull(fs, at);
            if (!info) {
                throw new PatchError(`${ws.show(at)} does not exist`);
            }
            if (info.isDirectory()) {
                throw new PatchError(`${ws.show(at)} is a directory`);
            }
            steps.push({ kind: 'delete', at });
            removed.add(at);
            touched.push({ path: ws.show(at), action: 'deleted' });
            continue;
        }

        if (op.kind === 'add') {
            if (await statOrNull(fs, at)) {
                throw new PatchError(
                    `${ws.show(at)} already exists — update it instead of adding it`,
                );
            }
            const content = op.lines.length > 0 ? op.lines.join('\n') + '\n' : '';
            if (Buffer.byteLength(content) > MAX_WRITE) {
                throw new PatchError(`${ws.show(at)} would exceed ${MAX_WRITE} bytes`);
            }
            steps.push({ kind: 'write', at, content });
            touched.push({
                path: ws.show(at),
                action: 'added',
                bytes: Buffer.byteLength(content),
                lines: op.lines.length,
            });
            continue;
        }

        const info = await statOrNull(fs, at);
        if (!info) {
            throw new PatchError(`${ws.show(at)} does not exist`);
        }
        if (info.isDirectory()) {
            throw new PatchError(`${ws.show(at)} is a directory`);
        }
        if (info.size > MAX_WRITE) {
            throw new PatchError(`${ws.show(at)} is too large to patch`);
        }
        const shape = await inspectFile(fs, at, info.size, false);
        if (shape.format !== 'text') {
            throw new PatchError(`${ws.show(at)} is a ${shape.format} file, not text`);
        }
        const body = (await fs.readFile(at)).toString('utf8');
        // Matched against LF-only lines. A patch never carries a CR, so a CRLF
        // file would miss exactly, match on the trailing-whitespace pass, and be
        // spliced with bare LF — mixed endings behind a successful apply.
        const eol = isCrlf(body) ? '\r\n' : '\n';
        const flat = eol === '\n' ? body : body.split(eol).join('\n');
        const patched = patchLines(toLines(flat), op.chunks, ws.show(at));
        fuzz += patched.fuzz;
        ignored += patched.ignored;
        // Whether the file ended in a newline is a property of the file, not of
        // the patch, so it survives the edit.
        const trailing = flat === '' || flat.endsWith('\n');
        const content =
            patched.lines.length === 0 ? '' : patched.lines.join(eol) + (trailing ? eol : '');
        if (Buffer.byteLength(content) > MAX_WRITE) {
            throw new PatchError(`${ws.show(at)} would exceed ${MAX_WRITE} bytes`);
        }
        steps.push({ kind: 'write', at, content });

        const entry: Record<string, unknown> = {
            path: ws.show(at),
            action: 'updated',
            chunks: op.chunks.length,
            bytes: Buffer.byteLength(content),
            lines: patched.lines.length,
        };
        if (op.moveTo) {
            const to = patchPath(ws, op.moveTo);
            if (ws.isRoot(to)) {
                throw new PatchError('cannot move a file onto the workspace root');
            }
            if (to !== at) {
                if (targets.has(to) || (seen.has(to) && !removed.has(to))) {
                    throw new PatchError(
                        `${ws.show(to)} is already written by another part of this patch`,
                    );
                }
                if (!removed.has(to) && (await statOrNull(fs, to))) {
                    throw new PatchError(`${ws.show(to)} already exists`);
                }
                targets.add(to);
                steps.push({ kind: 'move', from: at, to });
                entry.action = 'moved';
                entry.to = ws.show(to);
            }
        }
        touched.push(entry);
    }

    for (const step of steps) {
        switch (step.kind) {
            case 'write':
                await fs.mkdirp(dirname(step.at));
                await fs.writeFile(step.at, step.content);
                break;
            case 'move':
                await fs.mkdirp(dirname(step.to));
                await fs.rename(step.from, step.to);
                break;
            case 'delete':
                await fs.rm(step.at);
                break;
        }
    }
    return {
        applied: touched.length,
        files: touched,
        // Worth reporting: a chunk that only matched once whitespace was
        // ignored landed where the tool thinks it should, not where the patch
        // said, and that is a thing to check.
        fuzzy: fuzz > 0 ? fuzz : undefined,
        // A heading that named nothing, applied anyway because the context was
        // unique. Says the heading was wrong without having refused the edit.
        ignoredHeadings: ignored > 0 ? ignored : undefined,
    };
}

async function statOrNull(fs: FsDriver, at: string): Promise<FsStat | null> {
    try {
        return await fs.stat(at);
    } catch {
        return null;
    }
}

/**
 * A path in a patch, checked for containment and for write permission before
 * the first byte is written. Both refusals become patch errors, because the
 * promise apply_patch makes is that a patch it will not finish leaves nothing
 * behind — a read-only file named halfway down is a reason to reject the whole
 * patch, not to write the files above it and then throw.
 */
function patchPath(ws: Workspace, path: string): string {
    try {
        return ws.within(path, { write: true });
    } catch (err) {
        throw new PatchError(err instanceof Error ? err.message : String(err));
    }
}

/** Depth-first, skipping the noise nobody means to search. */
const SKIP = new Set(['.git', 'node_modules', '.data', 'dist', '.venv', '__pycache__']);

async function walk(
    dir: string,
    ws: Workspace,
    visit: (file: string) => boolean,
): Promise<boolean> {
    let entries;
    try {
        entries = await ws.fs.readdir(dir);
    } catch {
        return true;
    }
    for (const entry of entries) {
        if (SKIP.has(entry.name)) {
            continue;
        }
        const child = ws.fs.path.join(dir, entry.name);
        // Symlinks are not followed: a link out of the workspace would
        // otherwise let a listing report paths the tools cannot open anyway.
        if (entry.isSymbolicLink()) {
            continue;
        }
        if (entry.isDirectory()) {
            if (!(await walk(child, ws, visit))) {
                return false;
            }
        } else if (entry.isFile() && !visit(child)) {
            return false;
        }
    }
    return true;
}
