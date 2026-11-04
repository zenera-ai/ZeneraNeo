import { realpathSync } from 'node:fs';
import { cp, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path, { type PlatformPath } from 'node:path';

// ---------------------------------------------------------------------------
// The filesystem the file tools stand on
//
// The tools decide what a path means and whether it may be touched; this is
// only where the bytes are. On `zen run` that is this machine's disk, and the
// container bind-mounts the same directories, so a file the tools write is a
// file a command sees. A sandbox that runs somewhere else keeps its files
// there too, and answers these calls over the wire instead — the tools, the
// containment and the names the model sees stay exactly as they are.
//
// Every path in and out is the driver's own: a host path for `localFs`, a
// path in the sandbox's tree for a remote one. Failures carry `code` and
// `path` the way Node's do, because that is what the tools turn back into the
// model's vocabulary.
// ---------------------------------------------------------------------------

export interface FsStat {
    size: number;
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
}

export interface FsEntry {
    name: string;
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
}

export interface FsDriver {
    /** how this driver's paths are spelled: the host's for `localFs`, posix otherwise */
    readonly path: PlatformPath;
    /**
     * The path with every symlink resolved; throws `ENOENT` when it does not
     * exist. Synchronous because containment is decided synchronously. A
     * driver whose files live elsewhere may answer lexically here, provided
     * the far side refuses an escape on its own.
     */
    realpathSync(path: string): string;
    stat(path: string): Promise<FsStat>;
    readdir(path: string): Promise<FsEntry[]>;
    readFile(path: string): Promise<Buffer>;
    /** at most the first `bytes` bytes, for sniffing a file too large to read whole */
    readHead(path: string, bytes: number): Promise<Buffer>;
    writeFile(path: string, data: string | Uint8Array): Promise<void>;
    /** with parents, and no complaint when it already exists */
    mkdirp(path: string): Promise<void>;
    rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    copy(from: string, to: string, opts?: { recursive?: boolean }): Promise<void>;
}

/** This machine's disk, through `node:fs`. */
export const localFs: FsDriver = {
    path,
    realpathSync: (p) => realpathSync(p),
    stat: (p) => stat(p),
    readdir: (p) => readdir(p, { withFileTypes: true }),
    readFile: (p) => readFile(p),
    async readHead(p, bytes) {
        const handle = await open(p, 'r');
        try {
            const buf = Buffer.alloc(bytes);
            const { bytesRead } = await handle.read(buf, 0, bytes, 0);
            return buf.subarray(0, bytesRead);
        } finally {
            await handle.close();
        }
    },
    writeFile: (p, data) => writeFile(p, data),
    mkdirp: async (p) => void (await mkdir(p, { recursive: true })),
    rm: (p, opts) => rm(p, opts),
    rename: (from, to) => rename(from, to),
    copy: (from, to, opts) => cp(from, to, { recursive: opts?.recursive === true }),
};

/**
 * A failure shaped like Node's, for drivers that are not `node:fs`: the file
 * tools read `code` and `path` to say what went wrong in the model's words.
 */
export function fsError(code: string, syscall: string, at: string): NodeJS.ErrnoException {
    const err: NodeJS.ErrnoException = new Error(`${code}: ${syscall} '${at}'`);
    err.code = code;
    err.syscall = syscall;
    err.path = at;
    return err;
}
