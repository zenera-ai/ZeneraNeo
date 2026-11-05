import { localFs, type FilesView, type FsDriver, type Mount } from '@zenera/sandbox';

// ---------------------------------------------------------------------------
// The workspace: what an agent's files are
//
// The trees an agent can reach, the names it reaches them by, and the one gate
// every path goes through (`within`). The file tools stand on it, and so does
// anything else that touches the agent's files on its behalf — memory copying
// a file in or out — through `AgentFiles`, which a host hands the tools as
// `services.files`.
// ---------------------------------------------------------------------------

/**
 * The agent's files, as something other than its file tools touches them:
 * contained and permission-checked exactly as those tools are. `Workspace` is
 * one.
 */
export interface AgentFiles {
    /** a file, whole; refuses a directory, and a file over `maxBytes` before reading it */
    read(path: string, opts?: { maxBytes?: number }): Promise<AgentFile>;
    /**
     * Writes bytes and answers with the path the model knows the file by.
     * Refuses to replace an existing file unless told to.
     */
    write(path: string, data: Uint8Array, opts?: { overwrite?: boolean }): Promise<string>;
}

export interface AgentFile {
    /** the name the model knows it by */
    path: string;
    data: Uint8Array;
}

/** Why a read was refused: `ENOENT`, `EISDIR` or `EFBIG`, as `node:fs` would say. */
function agentFileError(code: string, message: string): NodeJS.ErrnoException {
    const err: NodeJS.ErrnoException = new Error(message);
    err.code = code;
    return err;
}

/** The trees the file tools reach — `FilesView` from `@zenera/sandbox`, under the name these tools use. */
export type WorkspaceOptions = FilesView;

/** One directory the agent can reach, the name it reaches it by, and what it may do there. */
interface Root {
    path: string;
    at?: string;
    readOnly: boolean;
}

/** A mount as the workspace holds it: resolved, with its permission decided. */
export type ResolvedMount = Mount & { readOnly: boolean };

export class Workspace implements AgentFiles {
    /** the workspace as given, made absolute; where it really is is settled on first use */
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
    #deep: Root[];
    #ready?: Promise<void>;

    constructor(opts: WorkspaceOptions) {
        this.fs = opts.fs ?? localFs;
        this.root = this.fs.path.resolve(opts.root);
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
            const host = this.fs.path.resolve(m.host);
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
     * Every root's symlinks resolved, once, so a workspace that *is* a symlink
     * does not fail every containment check against itself. On first use rather
     * than at construction: the driver may be on another machine, and asking it
     * is a round trip.
     */
    #settle(): Promise<void> {
        this.#ready ??= (async () => {
            for (const [i, root] of this.#roots.entries()) {
                const real = await this.fs.resolve(root.path);
                const info = await this.fs.stat(real).catch(() => undefined);
                if (!info) {
                    throw new Error(
                        i === 0
                            ? `the workspace does not exist: ${root.path}`
                            : `workspace mount ${root.at}: no such directory: ${root.path}`,
                    );
                }
                root.path = real;
            }
            this.#deep = [...this.#roots].sort((a, b) => b.path.length - a.path.length);
        })().catch((err: unknown) => {
            this.#ready = undefined;
            throw err;
        });
        return this.#ready;
    }

    /** Every tree, where it really is: the workspace first. */
    async trees(): Promise<string[]> {
        await this.#settle();
        return this.#roots.map((r) => r.path);
    }

    /**
     * Where a name points on this machine, lexically: no symlink followed, no
     * file touched. For drawing a link to a file, never for deciding access —
     * that is `within`.
     */
    hostOf(input: string): string | undefined {
        const { root, rest } = this.#locate(input);
        const { resolve, sep } = this.fs.path;
        const at = resolve(root.path, rest);
        return at === root.path || at.startsWith(root.path + sep) ? at : undefined;
    }

    /**
     * The one gate. Returns an absolute path inside one of the roots, or throws.
     *
     * A path that does not exist yet cannot be realpath'd, so the nearest
     * existing ancestor is resolved instead and the remainder appended — which
     * is exactly what a create needs and closes the same hole a create opens.
     */
    async within(input: string, opts: { write?: boolean } = {}): Promise<string> {
        if (typeof input !== 'string' || input.length === 0) {
            throw new Error('path is required');
        }
        if (input.includes('\0')) {
            throw new Error('path contains a null byte');
        }
        await this.#settle();
        const { root, rest } = this.#locate(input);
        const { resolve, sep } = this.fs.path;
        const real = await this.fs.resolve(resolve(root.path, rest));
        if (real !== root.path && !real.startsWith(root.path + sep)) {
            throw new Error(`outside the workspace: ${input}`);
        }
        if (opts.write && root.readOnly) {
            throw new Error(
                root === this.#roots[0]
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
     * A file the agent named, whole: contained like any read, and read through
     * this workspace's driver, so it is the same whether the bytes are on this
     * machine or in a remote sandbox. Memory copies a file in through this.
     */
    async read(path: string, opts: { maxBytes?: number } = {}): Promise<AgentFile> {
        const at = await this.within(path);
        const info = await this.fs.stat(at).catch(() => undefined);
        if (!info) {
            throw agentFileError('ENOENT', `${path} does not exist`);
        }
        if (!info.isFile()) {
            throw agentFileError('EISDIR', `${path} is not a regular file`);
        }
        // Asked before reading, so a file far over the cap is never pulled across.
        if (opts.maxBytes !== undefined && info.size > opts.maxBytes) {
            throw agentFileError(
                'EFBIG',
                `${path} is ${info.size} bytes, over the ${opts.maxBytes} byte limit`,
            );
        }
        const data = await this.fs.readFile(at);
        if (opts.maxBytes !== undefined && data.byteLength > opts.maxBytes) {
            throw agentFileError('EFBIG', `${path} grew past the ${opts.maxBytes} byte limit`);
        }
        return { path: this.show(at), data };
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
        const at = await this.within(path, { write: true });
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
