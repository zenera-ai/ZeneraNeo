import { readProjectConfig, WORKSPACE_MOUNT } from '@zenera/neo';
import { createHash, randomBytes } from 'node:crypto';
import {
    copyFileSync,
    createWriteStream,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { extname, join, posix, relative, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { stamp } from './ids.ts';

// ---------------------------------------------------------------------------
// Files a person attaches to a chat message
//
// A file is uploaded on its own, before the message, into a staging folder the
// agent cannot see. Sending the message moves the files it names into the
// workspace, one folder per message, and the agent is told where they are in
// plain text: it reads them with the tools it already has. Nothing here is
// HTTP; a host streams the request body in and maps `UploadError` to a status.
//
//   staging/<id>.bin    the bytes
//   staging/<id>.json   what they are: name, type, size, sha256, when
//   <dir>/<batch>/<name>  after the message is sent; <dir> lies inside the workspace
// ---------------------------------------------------------------------------

/** One file; the same cap the project editor's uploads have. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
/** Files one message may carry. */
export const MAX_MESSAGE_UPLOADS = 20;
/** How long a file waits for the message that sends it. */
export const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

const MAX_NAME_BYTES = 200;
const MAX_EXT_BYTES = 20;
const UPLOAD_ID = /^[0-9a-f]{24}$/;
const MIME = /^[a-z0-9][\w.+-]*\/[\w.+-]+$/;
const DEFAULT_MIME = 'application/octet-stream';

export class UploadError extends Error {
    /** invalid: a bad request; too_large: over the cap; gone: no such staged file (any more) */
    readonly code: 'invalid' | 'too_large' | 'gone';
    constructor(code: UploadError['code'], message: string) {
        super(message);
        this.name = 'UploadError';
        this.code = code;
    }
}

export interface StagedUpload {
    id: string;
    name: string;
    size: number;
    mimeType: string;
    sha256: string;
    createdAt: string;
}

/** A sent file: where it is on this machine, and the name the agent reaches it by. */
export interface UploadedFile {
    id: string;
    name: string;
    size: number;
    mimeType: string;
    sha256: string;
    /** on this machine */
    file: string;
    /** in the sandbox, e.g. /workspace/uploads/20261116-184500-a7f3/report.pdf */
    path: string;
}

/** Where a chat's uploads wait and land. */
export interface UploadPlaces {
    /** where files wait for their message; outside the workspace */
    staging: string;
    /** where sent files land, one folder per message; inside `workspace` */
    dir: string;
    /** the session's workspace on this machine */
    workspace: string;
    /** where that workspace is in the sandbox: `workspaceMount(projectDir)` */
    workdir: string;
}

export function isUploadId(id: string): boolean {
    return UPLOAD_ID.test(id);
}

/**
 * A name that is safe as one path segment and still reads as what was sent: the
 * base name only, no separators, control characters or leading dots, at most
 * 200 bytes with the extension kept.
 */
export function cleanFileName(raw: string): string {
    let name = String(raw ?? '').normalize('NFC');
    name = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1);
    name = name
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .trim()
        .replace(/^\.+/, '')
        .replace(/[. ]+$/, '');
    if (!name) {
        return 'file';
    }
    if (Buffer.byteLength(name) <= MAX_NAME_BYTES) {
        return name;
    }
    const ext = extname(name);
    const keep = ext && Buffer.byteLength(ext) <= MAX_EXT_BYTES ? ext : '';
    const chars = [...name.slice(0, name.length - keep.length)];
    while (chars.length && Buffer.byteLength(chars.join('') + keep) > MAX_NAME_BYTES) {
        chars.pop();
    }
    return chars.join('').trimEnd() + keep || 'file';
}

export function cleanMimeType(raw: string | undefined): string {
    const type = String(raw ?? '')
        .split(';')[0]
        .trim()
        .toLowerCase();
    return type.length <= 100 && MIME.test(type) ? type : DEFAULT_MIME;
}

const binOf = (staging: string, id: string) => join(staging, `${id}.bin`);
const metaOf = (staging: string, id: string) => join(staging, `${id}.json`);

/**
 * Streams one file into staging, counting and hashing it on the way. Over
 * `maxBytes` it stops and leaves nothing behind; so does a body that breaks off.
 */
export async function stageUpload(
    staging: string,
    body: AsyncIterable<Uint8Array> | NodeJS.ReadableStream,
    opts: { name: string; mimeType?: string; maxBytes?: number; now?: Date },
): Promise<StagedUpload> {
    const maxBytes = opts.maxBytes ?? MAX_UPLOAD_BYTES;
    mkdirSync(staging, { recursive: true });
    const id = randomBytes(12).toString('hex');
    const tmp = join(staging, `.${id}.part`);
    const hash = createHash('sha256');
    let size = 0;
    const count = new Transform({
        transform(chunk: Buffer, _enc, done) {
            size += chunk.length;
            if (size > maxBytes) {
                done(new UploadError('too_large', `files are limited to ${formatBytes(maxBytes)}`));
                return;
            }
            hash.update(chunk);
            done(null, chunk);
        },
    });
    try {
        await pipeline(body, count, createWriteStream(tmp, { mode: 0o600 }));
        renameSync(tmp, binOf(staging, id));
    } catch (err) {
        await rm(tmp, { force: true });
        throw err;
    }
    const upload: StagedUpload = {
        id,
        name: cleanFileName(opts.name),
        size,
        mimeType: cleanMimeType(opts.mimeType),
        sha256: hash.digest('hex'),
        createdAt: (opts.now ?? new Date()).toISOString(),
    };
    writeFileSync(metaOf(staging, id), `${JSON.stringify(upload)}\n`, { mode: 0o600 });
    return upload;
}

/** A staged file, or undefined when there is none by that id. */
export function stagedUpload(staging: string, id: string): StagedUpload | undefined {
    if (!isUploadId(id) || !existsSync(binOf(staging, id))) {
        return undefined;
    }
    try {
        return JSON.parse(readFileSync(metaOf(staging, id), 'utf8')) as StagedUpload;
    } catch {
        return undefined;
    }
}

/** Removes a staged file; false when there was none. */
export function discardUpload(staging: string, id: string): boolean {
    if (!isUploadId(id)) {
        return false;
    }
    const had = existsSync(binOf(staging, id));
    rmSync(binOf(staging, id), { force: true });
    rmSync(metaOf(staging, id), { force: true });
    return had;
}

/** Removes staged files (and broken-off parts) older than `maxAgeMs`; how many went. */
export function sweepUploads(staging: string, maxAgeMs = UPLOAD_TTL_MS, now = Date.now()): number {
    let entries: string[];
    try {
        entries = readdirSync(staging);
    } catch {
        return 0;
    }
    let removed = 0;
    for (const entry of entries) {
        const at = join(staging, entry);
        try {
            if (now - statSync(at).mtimeMs <= maxAgeMs) {
                continue;
            }
            rmSync(at, { force: true });
            if (entry.endsWith('.bin')) {
                removed++;
            }
        } catch {
            // Gone already: another sweep, or the message that sent it.
        }
    }
    return removed;
}

/**
 * Moves the staged files a message names into `<dir>/<batch>/`, in the order
 * given. Every id is checked before anything moves, so a message whose files
 * are not all there moves none of them. A name already taken in the folder
 * gets a number: `report.pdf`, `report (2).pdf`.
 */
export function commitUploads(
    places: UploadPlaces,
    ids: readonly string[],
    batch: string = stamp(),
): UploadedFile[] {
    const staged = ids.map((id) => {
        const upload = stagedUpload(places.staging, id);
        if (!upload) {
            throw new UploadError('gone', 'an attached file is no longer there; attach it again');
        }
        return upload;
    });
    if (!staged.length) {
        return [];
    }
    const dest = join(places.dir, batch);
    const rel = relative(places.workspace, dest);
    if (rel.startsWith('..') || rel === '' || rel.startsWith(sep)) {
        throw new Error(`uploads land at ${dest}, which is not inside ${places.workspace}`);
    }
    mkdirSync(dest, { recursive: true });
    const taken = new Set(readdirSync(dest));
    return staged.map((upload) => {
        const name = freeName(upload.name, taken);
        taken.add(name);
        const file = join(dest, name);
        moveFile(binOf(places.staging, upload.id), file);
        rmSync(metaOf(places.staging, upload.id), { force: true });
        return {
            id: upload.id,
            name,
            size: upload.size,
            mimeType: upload.mimeType,
            sha256: upload.sha256,
            file,
            path: posix.join(places.workdir, ...rel.split(sep), name),
        };
    });
}

function freeName(name: string, taken: Set<string>): string {
    if (!taken.has(name)) {
        return name;
    }
    const ext = extname(name);
    const stem = name.slice(0, name.length - ext.length);
    for (let n = 2; ; n++) {
        const next = `${stem} (${n})${ext}`;
        if (!taken.has(next)) {
            return next;
        }
    }
}

function moveFile(from: string, to: string): void {
    try {
        renameSync(from, to);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EXDEV') {
            throw err;
        }
        copyFileSync(from, to);
        rmSync(from, { force: true });
    }
}

/** Where the project's sandbox mounts the workspace: `sandbox.workdir`, else /workspace. */
export function workspaceMount(projectDir: string): string {
    try {
        return readProjectConfig(projectDir).config.sandbox?.workdir ?? WORKSPACE_MOUNT;
    } catch {
        // A config that does not load fails the run on its own, and says why there.
        return WORKSPACE_MOUNT;
    }
}

/**
 * What the agent is given: the person's text, then the files, each with its
 * type and size, in a block a reader can find again.
 */
export function attachmentsText(
    text: string,
    files: readonly Pick<UploadedFile, 'path' | 'mimeType' | 'size'>[],
): string {
    if (!files.length) {
        return text;
    }
    const block = [
        '<attachments>',
        ...files.map((f) => `- ${f.path} (${f.mimeType}, ${formatBytes(f.size)})`),
        '</attachments>',
    ].join('\n');
    return text ? `${text}\n\n${block}` : block;
}

/** A session's title for a message with files and no text: their names. */
export function attachmentsTitle(files: readonly Pick<UploadedFile, 'name'>[]): string {
    const names = files.map((f) => f.name).join(', ');
    return names.length > 60 ? `${names.slice(0, 57)}…` : names;
}

export function formatBytes(n: number): string {
    if (n < 1024) {
        return `${n} B`;
    }
    const units = ['KB', 'MB', 'GB'];
    let value = n / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
}
