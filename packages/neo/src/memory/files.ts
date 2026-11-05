import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
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

/** A file to remember: its bytes, and the name its extension is taken from. */
export interface FileBytes {
    name: string;
    data: Uint8Array;
}

export interface RememberOptions {
    maxBytes?: number;
}

/**
 * Keep `file` in the memory directory under `id`, and describe it. The digest
 * is of these bytes, the ones written, so it provably belongs to the copy kept.
 */
export async function rememberFile(
    dir: string,
    file: FileBytes,
    id: string,
    opts: RememberOptions = {},
): Promise<MemoryFile> {
    const maxBytes = opts.maxBytes ?? MAX_FILE_BYTES;
    if (file.data.byteLength > maxBytes) {
        throw new MemoryError(
            `${file.name} is ${file.data.byteLength} bytes, over the ${maxBytes} byte limit for a remembered file`,
            'keep the artifact in the workspace and remember a `snippet` of the part that matters',
        );
    }

    const format = formatOf(file.name);
    const stored = id + (format ? `.${format}` : '');
    await mkdir(join(dir, FILES_DIR), { recursive: true });
    await writeFile(join(dir, FILES_DIR, stored), file.data);

    return {
        path: stored,
        bytes: file.data.byteLength,
        sha256: createHash('sha256').update(file.data).digest('hex'),
        format,
    };
}

/**
 * What a remembered file is called: `<id>.<ext>`. The name the model is shown,
 * and where a copy lands by default. Graphs written while the tree was still
 * mounted stored `/memory/<id>.<ext>`; the base name is the same for both.
 */
export function storedName(file: Pick<MemoryFile, 'path'>): string {
    return basename(file.path);
}

/** The host path of a remembered file, for reading it back or deleting it. */
export function hostPath(dir: string, file: Pick<MemoryFile, 'path'>): string {
    // Through `basename` so a stored path can never climb out of the tree.
    return join(dir, FILES_DIR, storedName(file));
}

/** Drop the bytes of a forgotten node. Missing is success — the goal is absence. */
export async function forgetFile(dir: string, file: MemoryFile): Promise<void> {
    await rm(hostPath(dir, file), { force: true });
}

/**
 * The extension drives how the file is run and rendered, so it is kept, but it
 * becomes part of a filename this module chooses — hence the character class.
 */
function formatOf(source: string): string {
    const ext = extname(source).slice(1).toLowerCase();
    return /^[a-z0-9]+$/.test(ext) && ext.length <= MAX_FORMAT_LEN ? ext : '';
}
