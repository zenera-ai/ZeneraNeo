import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { FILES_DIR } from './store.ts';
import { MemoryError, type MemoryFile } from './types.ts';

// ---------------------------------------------------------------------------
// Remembered files
//
// An agent that writes a working script should be able to run it again next
// week, and a summary of a script is not a script. So the bytes are copied out
// of the workspace — which is disposable, and may be a container that is about
// to be discarded — into the memory directory, under the id of the node that
// describes them. The copy is the point: a reference to a workspace path would
// dangle the moment the run ends.
//
// The tree is never mounted into a sandbox. A file leaves it only as a copy,
// through `memory_copy_file`, and enters it only through a commit, so every
// file here has a node that explains what it is and the graph cannot acquire
// orphans that no recollection can ever surface. It also means a sandbox holds
// nothing that changes under it while it runs.
// ---------------------------------------------------------------------------

/**
 * Big enough for any script or config worth re-running, small enough that the
 * memory directory cannot become a place where build outputs go to hide.
 */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Extensions are for `run_command` and syntax hints, not a type system. */
const MAX_FORMAT_LEN = 16;

/**
 * Where a remembered file's bytes come from, read for memory by whoever owns
 * them — the workspace's own driver, so it does not matter whether the files
 * are on this machine. `path` names it, and its extension decides the copy's.
 */
export interface FileSource {
    path: string;
    stat(): Promise<{ size: number; isFile(): boolean }>;
    read(): Promise<Uint8Array>;
}

/** A file on this machine's disk, as a source. */
export function hostFile(path: string): FileSource {
    return { path, stat: () => stat(path), read: () => readFile(path) };
}

/**
 * The agent's workspace, as memory needs it: a file to remember is read from
 * it, and a remembered file is copied back into it. Both are contained and
 * permission-checked exactly as the file tools are. `Workspace` is one.
 */
export interface WorkspaceFiles {
    source(path: string): FileSource;
    /**
     * Writes bytes and answers with the path the model knows the file by.
     * Refuses to replace an existing file unless told to.
     */
    write(path: string, data: Uint8Array, opts?: { overwrite?: boolean }): Promise<string>;
}

export interface RememberOptions {
    maxBytes?: number;
    /** Display path as passed to the tool, for reporting errors without leaking the host filesystem */
    path?: string;
}

/**
 * Copy `source` into the memory directory under `id` and describe it.
 *
 * The bytes are read once and both hashed and written from that one buffer, so
 * the digest provably belongs to the copy that was kept — re-reading the source
 * to hash it would leave a window for it to change in between.
 */
export async function rememberFile(
    dir: string,
    source: FileSource,
    id: string,
    opts: RememberOptions = {},
): Promise<MemoryFile> {
    const maxBytes = opts.maxBytes ?? MAX_FILE_BYTES;
    const name = opts.path ?? source.path;
    const info = await describe(source, name);
    if (!info.isFile()) {
        throw new MemoryError(
            `${name} is not a regular file`,
            'only files can be remembered; write a `fact` node describing a directory instead',
        );
    }
    if (info.size > maxBytes) {
        throw new MemoryError(
            `${name} is ${info.size} bytes, over the ${maxBytes} byte limit for a remembered file`,
            'keep the artifact in the workspace and remember a `snippet` of the part that matters',
        );
    }

    const bytes = await source.read();
    if (bytes.byteLength > maxBytes) {
        throw new MemoryError(`${name} grew past the ${maxBytes} byte limit while being read`);
    }

    const format = formatOf(source.path);
    const stored = id + (format ? `.${format}` : '');
    await mkdir(join(dir, FILES_DIR), { recursive: true });
    await writeFile(join(dir, FILES_DIR, stored), bytes);

    return {
        path: stored,
        bytes: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        format,
    };
}

/**
 * What a remembered file is called: `<id>.<ext>`. The name the model is shown,
 * and where a copy lands by default. Graphs written while the tree was still
 * mounted stored `/memory/<id>.<ext>`; the base name is the same for both.
 */
export function fileName(file: Pick<MemoryFile, 'path'>): string {
    return basename(file.path);
}

/** The host path of a remembered file, for reading it back or deleting it. */
export function hostPath(dir: string, file: Pick<MemoryFile, 'path'>): string {
    // Through `basename` so a stored path can never climb out of the tree.
    return join(dir, FILES_DIR, fileName(file));
}

/** Drop the bytes of a forgotten node. Missing is success — the goal is absence. */
export async function forgetFile(dir: string, file: MemoryFile): Promise<void> {
    await rm(hostPath(dir, file), { force: true });
}

async function describe(source: FileSource, name: string) {
    try {
        return await source.stat();
    } catch {
        throw new MemoryError(
            `${name} does not exist`,
            'remember a file the run actually wrote, by the path the file tools use',
        );
    }
}

/**
 * The extension drives how the file is run and rendered, so it is kept, but it
 * becomes part of a filename this module chooses — hence the character class.
 */
function formatOf(source: string): string {
    const ext = extname(source).slice(1).toLowerCase();
    return /^[a-z0-9]+$/.test(ext) && ext.length <= MAX_FORMAT_LEN ? ext : '';
}
