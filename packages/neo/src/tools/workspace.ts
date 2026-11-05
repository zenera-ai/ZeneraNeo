import { posix } from 'node:path';
import { RootedFs, type FsDriver, type MountSource } from '@zenera/sandbox';

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

/** A tree beside the workspace: its name, and — without a sandbox — its directory here. */
export interface WorkspaceMount {
    /** the absolute name the agent reaches it by, e.g. `/assets` */
    at: string;
    /** the directory on this machine; only read when the workspace builds its own `fs` */
    host?: string;
    /** read-only unless it says otherwise: an extra tree is reference material */
    readOnly?: boolean;
    source?: MountSource;
}

/**
 * The trees the file tools reach. Two ways to say it, one result:
 *
 * - with `fs` — a sandbox's own, already contained — `root` is the workspace's
 *   name in it (`/workspace`) and each mount is a name in it too;
 * - without, for a host with no sandbox, `root` and each mount's `host` are
 *   directories on this machine, and the workspace contains them itself with
 *   the same `RootedFs` a podman sandbox uses.
 *
 * `mount` is the name paths are shown by; unset, the workspace's own paths are
 * shown relative to it.
 */
export interface WorkspaceOptions {
    root: string;
    mount?: string;
    mounts?: readonly WorkspaceMount[];
    /** refuse every mutating tool; `zen run --read-only` */
    readOnly?: boolean;
    fs?: FsDriver;
}

/** The name the workspace has inside a contained fs when nobody named it. */
const LOCAL_ROOT = '/workspace';

/** One tree the agent can reach, by name, and what it may do there. */
interface Tree {
    at: string;
    readOnly: boolean;
    /** for saying which directory is missing, when there is one */
    host?: string;
}

/** A mount as the workspace holds it: named, with its permission decided. */
export type ResolvedMount = Required<Pick<WorkspaceMount, 'at' | 'readOnly'>> &
    Pick<WorkspaceMount, 'source'>;

/**
 * What an agent may do with its files, on top of a filesystem that already
 * decides what it may reach. Every path here is the agent's own: it comes in as
 * the model spelled it, is made the one name the fs knows, and goes back out in
 * the model's spelling. Containment — symlinks, `..`, read-only trees — is the
 * fs's; what is left is the tools' own rules.
 */
export class Workspace implements AgentFiles {
    /** the workspace's name in `fs`, and where relative paths start */
    readonly root: string;
    readonly readOnly: boolean;
    /** the name paths are shown by; unset, workspace paths are shown relative */
    readonly mount: string | undefined;
    /** the extra trees — the workspace itself is not among them */
    readonly mounts: readonly ResolvedMount[];
    /** the agent's files, contained, in the agent's paths */
    readonly fs: FsDriver;

    /** the workspace first */
    readonly #trees: Tree[];
    /** longest name first, for finding the tree a path is in */
    readonly #byName: Tree[];
    #ready?: Promise<void>;

    constructor(opts: WorkspaceOptions) {
        this.readOnly = opts.readOnly ?? false;
        this.mount = mountPoint(opts.mount);
        const local = opts.fs === undefined;
        this.root = local ? (this.mount ?? LOCAL_ROOT) : (mountPoint(opts.root) ?? LOCAL_ROOT);

        const trees: Tree[] = [
            { at: this.root, readOnly: this.readOnly, ...(local ? { host: opts.root } : {}) },
        ];
        const mounts: ResolvedMount[] = [];
        for (const m of opts.mounts ?? []) {
            const at = mountPoint(m.at);
            if (at === undefined) {
                throw new Error(`a workspace mount needs an absolute name of its own: ${m.at}`);
            }
            // Overlapping names would make one path mean two directories, and
            // which one won would depend on the order they were passed in.
            for (const taken of trees) {
                if (at === taken.at || under(at, taken.at) || under(taken.at, at)) {
                    throw new Error(`workspace mounts overlap: ${at} and ${taken.at}`);
                }
            }
            if (local && !m.host) {
                throw new Error(`workspace mount ${at} needs a host directory`);
            }
            const readOnly = m.readOnly ?? true;
            trees.push({ at, readOnly, ...(local ? { host: m.host } : {}) });
            mounts.push({ at, readOnly, ...(m.source ? { source: m.source } : {}) });
        }

        this.mounts = mounts;
        this.#trees = trees;
        this.#byName = [...trees].sort((a, b) => b.at.length - a.at.length);
        this.fs =
            opts.fs ??
            new RootedFs(trees.map((t) => ({ at: t.at, dir: t.host!, readOnly: t.readOnly })));
    }

    /**
     * Every tree has to be there. Asked once, on first use rather than at
     * construction: the fs may be on another machine, and asking is a round trip.
     */
    #settle(): Promise<void> {
        this.#ready ??= (async () => {
            for (const [i, tree] of this.#trees.entries()) {
                // There at all; that it is a directory is the first listing's to say.
                const info = await this.fs.stat(tree.at).catch(() => undefined);
                if (!info) {
                    const where = tree.host ?? tree.at;
                    throw new Error(
                        i === 0
                            ? `the workspace does not exist: ${where}`
                            : `workspace mount ${tree.at}: no such directory: ${where}`,
                    );
                }
            }
        })().catch((err: unknown) => {
            this.#ready = undefined;
            throw err;
        });
        return this.#ready;
    }

    /** Every tree by name: the workspace first. */
    trees(): string[] {
        return this.#trees.map((t) => t.at);
    }

    /**
     * The one gate: the name the fs knows a path by, or a refusal in the
     * model's words. What the fs then does with it is contained by the fs.
     */
    async within(input: string, opts: { write?: boolean } = {}): Promise<string> {
        if (typeof input !== 'string' || input.length === 0) {
            throw new Error('path is required');
        }
        if (input.includes('\0')) {
            throw new Error('path contains a null byte');
        }
        await this.#settle();
        const found = this.locate(input);
        if (!found) {
            throw new Error(`outside the workspace: ${input}`);
        }
        if (opts.write && found.tree.readOnly) {
            throw new Error(
                found.tree === this.#trees[0]
                    ? 'the workspace is read-only for this run'
                    : `${found.tree.at} is read-only`,
            );
        }
        return found.at;
    }

    /**
     * Which tree a path names, and its one name there. `/workspace/src/a.ts`
     * and `src/a.ts` are one file under two names; a lone `/` is the model's
     * other name for the top of what it can see, so it means the workspace;
     * `..` that climbs out of a tree, and any other absolute path, names
     * nothing. Lexical: no file is touched.
     */
    locate(input: string): { tree: Tree; at: string } | undefined {
        const primary = this.#trees[0]!;
        if (/^[\\/]+$/.test(input)) {
            return { tree: primary, at: primary.at };
        }
        const spelled = input.replace(/\\/g, '/');
        const at = trim(
            posix.normalize(spelled.startsWith('/') ? spelled : posix.join(primary.at, spelled)),
        );
        const tree = this.#owner(at);
        // Unnamed, the workspace is only ever spelled relative: an absolute
        // path is the machine's, and the machine's is not in reach.
        if (tree === primary && spelled.startsWith('/') && this.mount === undefined) {
            return undefined;
        }
        return tree ? { tree, at } : undefined;
    }

    #owner(at: string): Tree | undefined {
        return this.#byName.find((t) => at === t.at || under(at, t.at));
    }

    /** Where a path sits under its own tree, in posix form. `.` is that tree. */
    rel(path: string): string {
        const tree = this.#owner(path);
        return tree ? posix.relative(tree.at, path) || '.' : path;
    }

    /**
     * How a path is written back to the model, and the reason `mount` is not
     * only about what comes in. A shell in the sandbox prints the mounted name
     * — `find` returns /workspace/src/a.ts — so if the file tools answered with
     * `src/a.ts` the model would be holding two vocabularies for one tree and
     * would have to translate between them to feed one tool's output to the
     * other. With a mount configured every path in and every path out is the
     * mounted one, and copying a path from a command's output into read_file
     * is exact. Without one, the workspace's own paths stay relative.
     */
    show(path: string): string {
        if (this.mount === undefined && this.#owner(path) === this.#trees[0]) {
            return this.rel(path);
        }
        return path;
    }

    /** Whether a path *is* one of the trees. Nothing may move or delete one. */
    isRoot(path: string): boolean {
        return this.#trees.some((t) => t.at === path);
    }

    /** Whether `inner` sits strictly below `outer`. */
    isInside(inner: string, outer: string): boolean {
        return under(inner, outer);
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
    return clean && clean.startsWith('/') ? posix.normalize(clean) : undefined;
}

function trim(at: string): string {
    return at.length > 1 ? at.replace(/\/+$/, '') : at;
}

function under(inner: string, outer: string): boolean {
    return inner.startsWith(outer + '/');
}
