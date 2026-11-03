import { ENV_FILE } from '@zenera/engine';
import { MEMORY_DB } from '@zenera/neo';
import { createWriteStream, lstatSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as yauzl from 'yauzl';
import * as yazl from 'yazl';
import { invalidError, usageError } from './term.ts';

// ---------------------------------------------------------------------------
// Archives
//
// A project is a directory, so sharing one is a question about which of its
// files are the project and which are the machine it happened to run on. The
// answer is the same one `.gitignore` gives — sessions, scratch and the `.env`
// are local; `agents.yaml`, the spec, the assets and what the agents learned
// are the project — with one difference that matters: the vectors travel. A
// clone rebuilds a rag index from the documents it carries, but nothing
// rebuilds memory from its graph, and an archive is not a clone with a setup
// step waiting for it. It is the whole thing, or it is not worth sending.
//
// The format is a zip because every machine already opens one, and because a
// person who is handed an archive should be able to look inside it without
// this tool. There is one file at the root that this tool wrote — the manifest
// — and one directory beside it holding the project verbatim. Nothing else.
//
// Everything here is streaming. An assets tree with vectors in it runs to
// hundreds of megabytes, and a reader that has to hold the archive in memory
// to open it is a reader that fails on the archives worth sending.
// ---------------------------------------------------------------------------

/** Bumped when the layout below changes in a way an older `zen` cannot read. */
export const ARCHIVE_FORMAT = 1;

/** The one file at the root of the archive, outside the project directory. */
export const MANIFEST_FILE = 'zenera-export.json';

/** Written in place of `.env`: the names it declared, with no values. */
export const ENV_EXAMPLE = '.env.example';

/**
 * What the archive says about itself.
 *
 * `root` is the single directory every other entry sits under, and `import`
 * refuses anything outside it — so this is a security boundary as much as a
 * convenience, and it is checked rather than trusted.
 */
export interface ArchiveManifest {
    format: number;
    /** the project's name, which is what it is registered as on arrival */
    name: string;
    /** the directory inside the archive holding the project */
    root: string;
    exportedAt: string;
    /** the `zen` that wrote it, for a bug report that starts "it won't open" */
    cli: string;
    /** whether `assets/**\/lance/` travelled */
    vectors: boolean;
    /** whether `memory/` travelled */
    memory: boolean;
    files: number;
    bytes: number;
}

/** A file the archive will carry, found by `collect`. */
export interface ArchiveEntry {
    /** project-relative, always `/`-separated, whatever the platform uses */
    rel: string;
    abs: string;
    bytes: number;
    mode: number;
}

export interface CollectOptions {
    /** carry `assets/**\/lance/`; default true */
    vectors?: boolean;
    /** carry `memory/`; default true */
    memory?: boolean;
}

export interface Collected {
    files: ArchiveEntry[];
    bytes: number;
    /** how many paths each rule turned away, so the report can say so */
    skipped: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Choosing what travels
// ---------------------------------------------------------------------------

/**
 * Why a path was left out. These are the words the report prints, so they are
 * the ones a person reads when they wonder where something went.
 */
export type Skip =
    | 'sessions'
    | 'scratch'
    | 'git'
    | 'modules'
    | 'env'
    | 'locks'
    | 'noise'
    | 'archives'
    | 'vectors'
    | 'memory'
    | 'links';

/**
 * The rule, stated once. `rel` is project-relative and `/`-separated, and the
 * answer is the reason to skip it or `undefined` to carry it — for a directory
 * that means the whole subtree.
 *
 * The top-level anchors are deliberate: `sessions/` is run state only when it
 * is *the* sessions directory, and an asset called `sessions` five levels down
 * inside a corpus is a document like any other.
 */
export function excluded(rel: string, isDir: boolean, opts: CollectOptions = {}): Skip | undefined {
    const name = rel.slice(rel.lastIndexOf('/') + 1);
    if (isDir) {
        if (rel === 'sessions') {
            return 'sessions';
        }
        if (rel === '.tmp') {
            return 'scratch';
        }
        if (name === '.git') {
            return 'git';
        }
        if (name === 'node_modules') {
            return 'modules';
        }
        if (rel === 'memory' && opts.memory === false) {
            return 'memory';
        }
        if (name === 'lance' && rel.startsWith('assets/') && opts.vectors === false) {
            return 'vectors';
        }
        return undefined;
    }
    // The credentials never travel, in any form and behind no flag. What the
    // project needs is described by `.env.example`, which `export` synthesizes
    // from the names in this file. Its variants (`.env.test`, `.env.local`, what
    // `ZEN_ENV_FILE` names) are credentials just the same.
    if (rel === ENV_FILE || (rel.startsWith(`${ENV_FILE}.`) && rel !== ENV_EXAMPLE)) {
        return 'env';
    }
    // The memory's write-ahead log: `export` carries a snapshot of the database instead.
    if (name === '.lock' || name === `${MEMORY_DB}-wal` || name === `${MEMORY_DB}-shm`) {
        return 'locks';
    }
    if (name === '.DS_Store') {
        return 'noise';
    }
    // An archive at the top of the project is one of these, and the default
    // destination puts it there: `zen export` run twice from inside a project
    // would otherwise pack the first archive into the second. Project material
    // that happens to be a zip lives under `assets/`, where this does not look.
    if (!rel.includes('/') && name.toLowerCase().endsWith('.zip')) {
        return 'archives';
    }
    return undefined;
}

/**
 * Walks the project and returns the files that travel, in a deterministic
 * order: two exports of an unchanged tree list the same files in the same
 * sequence, which is what makes a diff of two archives mean anything.
 *
 * Symbolic links are counted and never followed. A link out of the tree is not
 * part of it, and a link back into it would be carried twice — and an archive
 * is extracted by a `zen` that refuses link entries anyway, so writing one
 * would only produce something the other end declines to open.
 */
export function collect(dir: string, opts: CollectOptions = {}): Collected {
    const root = resolve(dir);
    const files: ArchiveEntry[] = [];
    const skipped: Record<string, number> = {};

    const drop = (reason: Skip): void => {
        skipped[reason] = (skipped[reason] ?? 0) + 1;
    };

    const walk = (at: string): void => {
        const entries = readdirSync(at, { withFileTypes: true });
        // Codepoint order, not locale order: the answer must not depend on
        // which machine ran the export.
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const entry of entries) {
            const abs = join(at, entry.name);
            const rel = relative(root, abs).split(sep).join('/');
            if (entry.isSymbolicLink()) {
                drop('links');
                continue;
            }
            const reason = excluded(rel, entry.isDirectory(), opts);
            if (reason) {
                drop(reason);
                continue;
            }
            if (entry.isDirectory()) {
                walk(abs);
                continue;
            }
            if (!entry.isFile()) {
                // A socket or a fifo left behind by something. Not a file.
                drop('noise');
                continue;
            }
            let stat;
            try {
                stat = lstatSync(abs);
            } catch {
                // Gone between the listing and the stat. Nothing to carry.
                continue;
            }
            files.push({ rel, abs, bytes: stat.size, mode: stat.mode & 0o777 });
        }
    };

    walk(root);
    return { files, bytes: files.reduce((n, f) => n + f.bytes, 0), skipped };
}

/**
 * A `.env` with every value removed.
 *
 * Comments and blank lines survive, because in the file `zen init` writes they
 * are the documentation of what each variable is for, and that is exactly what
 * the person on the other end needs. Anything that is neither a comment nor an
 * assignment is dropped rather than passed through: the only thing it can be
 * is the continuation of a quoted value, and a value is the one thing that
 * must not leave.
 */
export function envExample(text: string): string {
    const lines: string[] = [];
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trimStart();
        if (trimmed === '' || trimmed.startsWith('#')) {
            lines.push(line.trimEnd());
            continue;
        }
        const assigned = /^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
        if (assigned) {
            lines.push(`${assigned[1]}=`);
        }
    }
    return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * What a name may be once this tool turns it into a path segment or a registry
 * key. Deliberately permissive — a project is whatever someone called their
 * directory — and closed on the three things that are not names: a traversal,
 * a separator, and a leading dash that some later command would read as a flag.
 */
export function safeName(value: unknown): string | undefined {
    if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
        return undefined;
    }
    if (value === '.' || value === '..' || value.startsWith('-')) {
        return undefined;
    }
    return /[/\\\0]/.test(value) ? undefined : value;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface WriteOptions {
    /** where the archive goes */
    out: string;
    /** the directory inside it that every project file sits under */
    root: string;
    entries: readonly ArchiveEntry[];
    /** files this tool makes up, keyed by their path inside `root` */
    extra?: ReadonlyMap<string, string>;
    manifest: ArchiveManifest;
    onFile?: (rel: string) => void;
}

/** Writes the archive and answers with its size on disk. */
export async function writeArchive(opts: WriteOptions): Promise<number> {
    const zip = new yazl.ZipFile();
    const out = resolve(opts.out);
    mkdirSync(dirname(out), { recursive: true });

    // Piped before anything is added: yazl reads eagerly, and an unread
    // outputStream is the whole archive held in memory.
    const sink = createWriteStream(out);
    const finished = pipeline(zip.outputStream as unknown as Readable, sink);

    zip.addBuffer(
        Buffer.from(`${JSON.stringify(opts.manifest, null, 4)}\n`, 'utf8'),
        MANIFEST_FILE,
        {
            mode: 0o644,
        },
    );
    for (const entry of opts.entries) {
        zip.addFile(entry.abs, `${opts.root}/${entry.rel}`, { mode: entry.mode });
        opts.onFile?.(entry.rel);
    }
    for (const [rel, text] of opts.extra ?? []) {
        zip.addBuffer(Buffer.from(text, 'utf8'), `${opts.root}/${rel}`, { mode: 0o644 });
    }
    zip.end();

    await finished;
    return statSync(out).size;
}

// ---------------------------------------------------------------------------
// Reading
//
// Everything below treats the archive as something a stranger sent, because
// that is the only reason it exists. A zip entry carries its own path, its own
// size and its own unix mode, and all three are claims: the path can walk out
// of the directory it was extracted into, the size can be a lie that unpacks
// to more than the disk holds, and the mode can say "this is a symbolic link",
// which is how an unpacker is talked into writing outside the tree it checked.
// ---------------------------------------------------------------------------

/** No project has this many files, and no archive this tool wrote does. */
const MAX_ENTRIES = 200_000;

/** Nor this many bytes once unpacked. Both bounds exist to stop a zip bomb. */
const MAX_BYTES = 8 * 1024 ** 3;

/** A manifest is a small json file; anything larger is not one. */
const MAX_MANIFEST = 64 * 1024;

/** The file-type bits of a unix mode, and the value that means "symlink". */
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

/**
 * The absolute path an entry may be written to, or `undefined` to refuse it.
 *
 * Exported because it is the guard, and a guard that is not tested directly is
 * a guard nobody knows the shape of.
 */
export function safePath(name: string, root: string, into: string): string | undefined {
    if (name.length === 0 || name.includes('\\') || name.includes('\0')) {
        return undefined;
    }
    if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
        return undefined;
    }
    const parts = name.split('/');
    if (parts.some((part) => part === '' || part === '.' || part === '..')) {
        return undefined;
    }
    if (parts.length < 2 || parts[0] !== root) {
        return undefined;
    }
    // Every segment has been checked, so this cannot fail — which is the point
    // of asking. A guard whose last step is redundant is one that still holds
    // when an earlier step is changed by someone who missed the reason for it.
    const base = resolve(into);
    const at = resolve(base, ...parts.slice(1));
    return at.startsWith(base + sep) ? at : undefined;
}

/**
 * Reads the manifest, and nothing else. Opening is cheap — it reads the
 * central directory and no file data — so `import` can describe what it is
 * about to do, and decide where to put it, before it writes anything.
 */
export async function readManifest(file: string): Promise<ArchiveManifest> {
    const zip = await yauzl.openPromise(file, { lazyEntries: true }).catch((err: unknown) => {
        throw usageError(
            `${file} is not a readable zip archive`,
            err instanceof Error ? err.message : undefined,
        );
    });
    let found: string | undefined;
    for await (const entry of zip.eachEntry()) {
        if (entry.fileName !== MANIFEST_FILE) {
            continue;
        }
        if (entry.uncompressedSize > MAX_MANIFEST) {
            zip.close();
            throw invalidError(`${MANIFEST_FILE} is implausibly large`);
        }
        found = await read(await zip.openReadStreamPromise(entry));
        zip.close();
        break;
    }
    if (found === undefined) {
        throw usageError(
            `${file} has no ${MANIFEST_FILE}`,
            'only an archive written by `zen export` can be imported',
        );
    }
    return parseManifest(found);
}

/** Checked rather than trusted: every field here arrives from the archive. */
function parseManifest(text: string): ArchiveManifest {
    let raw: Record<string, unknown>;
    try {
        raw = JSON.parse(text) as Record<string, unknown>;
    } catch {
        throw invalidError(`${MANIFEST_FILE} is not valid json`);
    }
    const format = typeof raw.format === 'number' ? raw.format : 0;
    if (format > ARCHIVE_FORMAT) {
        throw invalidError(
            `this archive is format ${format}, and this zen reads ${ARCHIVE_FORMAT}`,
            'upgrade: npm i -g @zenera/cli',
        );
    }
    const name = safeName(raw.name);
    const root = safeName(raw.root);
    if (!name || !root) {
        throw invalidError(`${MANIFEST_FILE} names the project in a way zen will not write`);
    }
    return {
        format,
        name,
        root,
        exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : '',
        cli: typeof raw.cli === 'string' ? raw.cli : 'unknown',
        vectors: raw.vectors !== false,
        memory: raw.memory !== false,
        files: typeof raw.files === 'number' ? raw.files : 0,
        bytes: typeof raw.bytes === 'number' ? raw.bytes : 0,
    };
}

export interface ExtractOptions {
    file: string;
    /** the directory the project's own files land in */
    into: string;
    /** the directory inside the archive they are expected to come from */
    root: string;
    onFile?: (rel: string) => void;
}

export interface Extracted {
    files: number;
    bytes: number;
}

/**
 * Unpacks the project into `into`, refusing anything the archive claims that
 * this tool would not have written. Nothing is executed, then or afterwards:
 * an archive carries `scripts/` and a `.github/` tree, and the only safe thing
 * to do with a stranger's script is to leave it on disk and say where it is.
 */
export async function extractArchive(opts: ExtractOptions): Promise<Extracted> {
    const zip = await yauzl.openPromise(opts.file, {
        lazyEntries: true,
        validateEntrySizes: true,
    });
    let files = 0;
    let bytes = 0;
    let drained = false;
    try {
        for await (const entry of zip.eachEntry()) {
            // Directories arrive as their own entries; the tree is made from
            // the file paths instead, so an empty one simply does not travel.
            if (entry.fileName === MANIFEST_FILE || entry.fileName.endsWith('/')) {
                continue;
            }
            if (entry.isEncrypted()) {
                throw invalidError(`${entry.fileName} is encrypted`, 'zen does not write those');
            }
            if (++files > MAX_ENTRIES) {
                throw invalidError(`this archive holds more than ${MAX_ENTRIES} files`);
            }
            bytes += entry.uncompressedSize;
            if (bytes > MAX_BYTES) {
                throw invalidError('this archive unpacks to more than 8 GiB');
            }
            if (((entry.externalFileAttributes >>> 16) & S_IFMT) === S_IFLNK) {
                throw invalidError(
                    `${entry.fileName} is a symbolic link`,
                    'a link can point out of the directory being written to',
                );
            }
            const to = safePath(entry.fileName, opts.root, opts.into);
            if (!to) {
                throw invalidError(
                    `${entry.fileName} does not belong under ${opts.root}/`,
                    'this archive was not written by `zen export`',
                );
            }
            await mkdir(dirname(to), { recursive: true });
            const stream = await zip.openReadStreamPromise(entry);
            // The mode is the archive's claim, so it is replaced rather than
            // honoured. A shell script has to be runnable to be useful; there
            // is no other reason for anything here to carry a bit.
            const mode = entry.fileName.endsWith('.sh') ? 0o755 : 0o644;
            await pipeline(stream, createWriteStream(to, { mode }));
            opts.onFile?.(entry.fileName.slice(opts.root.length + 1));
        }
        drained = true;
    } finally {
        // Reaching the end closes it; leaving early does not.
        if (!drained) {
            zip.close();
        }
    }
    return { files, bytes };
}

async function read(stream: Readable): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
}
