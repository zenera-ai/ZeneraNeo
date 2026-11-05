import { realpathSync } from 'node:fs';
import { cp, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path, { posix } from 'node:path';
import { fsError, type FsDriver, type FsEntry, type FsStat } from './fs.ts';

// ---------------------------------------------------------------------------
// The agent's trees, on this machine
//
// The one place a path the agent names becomes a file, and the one place it is
// contained. Every path in and out is the agent's own — /workspace/a.py,
// /assets/x — and each tree it names is a directory here: the session's
// workspace and the project's assets for podman, the pod's own /workspace for
// sandboxd. A path must fall in a tree, and once its symlinks are resolved it
// must still be in one; a read-only tree refuses every change, a link into it
// included. Failures carry the agent's path, never this machine's.
// ---------------------------------------------------------------------------

/** One tree: the name the agent knows it by, and the directory it is here. */
export interface Tree {
    /** absolute, posix: `/workspace`, `/assets`, `/skills/review` */
    at: string;
    /** where it is on this machine */
    dir: string;
    readOnly?: boolean;
}

export class RootedFs implements FsDriver {
    readonly path = posix;
    /** longest name first, so a nested tree wins over the one it sits in */
    readonly #trees: Required<Tree>[];

    constructor(trees: readonly Tree[]) {
        this.#trees = trees
            .map((t) => ({
                at: name(t.at),
                dir: path.resolve(t.dir),
                readOnly: t.readOnly ?? false,
            }))
            .sort((a, b) => b.at.length - a.at.length);
    }

    get trees(): readonly Required<Tree>[] {
        return this.#trees;
    }

    /**
     * Where an agent path is on this machine, contained: it must name a tree,
     * and whatever of it exists must resolve, symlinks and all, into a tree — a
     * writable one when `write`. The path need not exist.
     */
    hostPath(at: string, opts: { write?: boolean } = {}): string {
        const clean = agentPath(at);
        const tree = this.#treeOf(clean);
        if (!tree) {
            throw fsError('EACCES', 'open', clean);
        }
        if (opts.write && tree.readOnly) {
            throw fsError('EROFS', 'open', clean);
        }
        const host =
            clean === tree.at
                ? tree.dir
                : path.join(tree.dir, ...posix.relative(tree.at, clean).split('/'));
        this.#contain(host, clean, opts.write === true);
        return host;
    }

    /** An agent path for a file on this machine; undefined when it is in no tree. */
    agentPath(host: string): string | undefined {
        return this.#owner(host)?.at;
    }

    async stat(at: string): Promise<FsStat> {
        const host = this.hostPath(at);
        return guard(at, () => stat(host));
    }

    async readdir(at: string): Promise<FsEntry[]> {
        const host = this.hostPath(at);
        return guard(at, () => readdir(host, { withFileTypes: true }));
    }

    async readFile(at: string): Promise<Buffer> {
        const host = this.hostPath(at);
        return guard(at, () => readFile(host));
    }

    async readHead(at: string, bytes: number): Promise<Buffer> {
        const host = this.hostPath(at);
        return guard(at, async () => {
            const handle = await open(host, 'r');
            try {
                const buf = Buffer.alloc(bytes);
                const { bytesRead } = await handle.read(buf, 0, bytes, 0);
                return buf.subarray(0, bytesRead);
            } finally {
                await handle.close();
            }
        });
    }

    async writeFile(at: string, data: string | Uint8Array): Promise<void> {
        const host = this.hostPath(at, { write: true });
        await guard(at, () => writeFile(host, data));
    }

    async mkdirp(at: string): Promise<void> {
        const host = this.hostPath(at, { write: true });
        await guard(at, () => mkdir(host, { recursive: true }));
    }

    async rm(at: string, opts: { recursive?: boolean; force?: boolean } = {}): Promise<void> {
        const host = this.hostPath(at, { write: true });
        await guard(at, () =>
            rm(host, { recursive: opts.recursive === true, force: opts.force === true }),
        );
    }

    async rename(from: string, to: string): Promise<void> {
        const src = this.hostPath(from, { write: true });
        const dst = this.hostPath(to, { write: true });
        await guard(from, () => rename(src, dst));
    }

    async copy(from: string, to: string, opts: { recursive?: boolean } = {}): Promise<void> {
        const src = this.hostPath(from);
        const dst = this.hostPath(to, { write: true });
        await guard(from, () => cp(src, dst, { recursive: opts.recursive === true }));
    }

    #treeOf(at: string): Required<Tree> | undefined {
        return this.#trees.find((t) => at === t.at || t.at === '/' || at.startsWith(`${t.at}/`));
    }

    #owner(host: string): { tree: Required<Tree>; at: string } | undefined {
        let best: { tree: Required<Tree>; at: string; depth: number } | undefined;
        for (const tree of this.#trees) {
            const base = canonical(tree.dir);
            if (host !== base && !host.startsWith(base + path.sep)) {
                continue;
            }
            // The deepest directory owns a path that two trees both contain.
            if (best && best.depth >= base.length) {
                continue;
            }
            const rest = path.relative(base, host).split(path.sep).join('/');
            best = { tree, at: rest ? posix.join(tree.at, rest) : tree.at, depth: base.length };
        }
        return best;
    }

    #contain(host: string, at: string, write: boolean): void {
        let probe = host;
        for (;;) {
            let real: string;
            try {
                real = realpathSync(probe);
            } catch (err) {
                const code = (err as NodeJS.ErrnoException).code;
                const up = path.dirname(probe);
                if (code !== 'ENOENT' || up === probe) {
                    throw code ? fsError(code, 'realpath', at) : err;
                }
                probe = up;
                continue;
            }
            const owner = this.#owner(real);
            if (!owner) {
                throw fsError('EACCES', 'realpath', at);
            }
            if (write && owner.tree.readOnly) {
                throw fsError('EROFS', 'open', at);
            }
            return;
        }
    }
}

/** A path the agent gave, made absolute and normal; anything else is not a path. */
function agentPath(at: string): string {
    if (typeof at !== 'string' || !at.startsWith('/') || at.includes('\0')) {
        throw fsError('EINVAL', 'open', String(at));
    }
    return name(at);
}

function name(at: string): string {
    const clean = posix.normalize(at.replace(/\\/g, '/'));
    return clean.length > 1 ? clean.replace(/\/+$/, '') : clean;
}

/** A tree's directory with its own symlinks resolved (macOS: /var is /private/var). */
function canonical(dir: string): string {
    try {
        return realpathSync(dir);
    } catch {
        return dir;
    }
}

/** Node's failure, with the agent's path in it instead of this machine's. */
async function guard<T>(at: string, work: () => Promise<T>): Promise<T> {
    try {
        return await work();
    } catch (err) {
        const e = err as NodeJS.ErrnoException;
        throw e?.code ? fsError(e.code, e.syscall ?? 'fs', at) : err;
    }
}
