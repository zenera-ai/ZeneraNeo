import { posix } from 'node:path';
import { fsError, type FsDriver, type FsEntry, type FsStat } from './fs.ts';

// ---------------------------------------------------------------------------
// A filesystem in a map
//
// For tests, and for a host that wants the file tools without a disk under
// them. Posix paths, no symlinks, nothing persisted. It answers like `node:fs`
// down to the error codes, which is what lets the same suite run against both
// and say the tools do not depend on which one they were given.
// ---------------------------------------------------------------------------

type Node = { kind: 'dir' } | { kind: 'file'; data: Buffer };

export class MemoryFs implements FsDriver {
    readonly path = posix;
    readonly #nodes = new Map<string, Node>([['/', { kind: 'dir' }]]);

    /** Files to start with, by absolute path; their directories are made as needed. */
    constructor(files: Record<string, string | Uint8Array> = {}) {
        for (const [at, data] of Object.entries(files)) {
            this.#mkdirs(posix.dirname(this.#abs(at)));
            this.#nodes.set(this.#abs(at), { kind: 'file', data: Buffer.from(data) });
        }
    }

    /** An empty directory, with its parents. */
    dir(at: string): this {
        this.#mkdirs(this.#abs(at));
        return this;
    }

    realpathSync(at: string): string {
        const abs = this.#abs(at);
        if (!this.#nodes.has(abs)) {
            throw fsError('ENOENT', 'realpath', at);
        }
        return abs;
    }

    isDirectorySync(at: string): boolean {
        return this.#get(at, 'stat').kind === 'dir';
    }

    async stat(at: string): Promise<FsStat> {
        return info(this.#get(at, 'stat'));
    }

    async readdir(at: string): Promise<FsEntry[]> {
        const abs = this.#abs(at);
        if (this.#get(at, 'scandir').kind !== 'dir') {
            throw fsError('ENOTDIR', 'scandir', at);
        }
        return this.#children(abs).map((child) => ({
            name: posix.basename(child),
            ...info(this.#nodes.get(child)!),
        }));
    }

    async readFile(at: string): Promise<Buffer> {
        const node = this.#get(at, 'open');
        if (node.kind !== 'file') {
            throw fsError('EISDIR', 'read', at);
        }
        return Buffer.from(node.data);
    }

    async readHead(at: string, bytes: number): Promise<Buffer> {
        return (await this.readFile(at)).subarray(0, bytes);
    }

    async writeFile(at: string, data: string | Uint8Array): Promise<void> {
        const abs = this.#abs(at);
        this.#parent(abs, 'open');
        if (this.#nodes.get(abs)?.kind === 'dir') {
            throw fsError('EISDIR', 'open', at);
        }
        this.#nodes.set(abs, { kind: 'file', data: Buffer.from(data) });
    }

    async mkdirp(at: string): Promise<void> {
        this.#mkdirs(this.#abs(at));
    }

    async rm(at: string, opts: { recursive?: boolean; force?: boolean } = {}): Promise<void> {
        const abs = this.#abs(at);
        const node = this.#nodes.get(abs);
        if (!node) {
            if (opts.force) {
                return;
            }
            throw fsError('ENOENT', 'rm', at);
        }
        if (node.kind === 'dir') {
            if (!opts.recursive) {
                throw fsError('EISDIR', 'rm', at);
            }
            for (const key of this.#below(abs)) {
                this.#nodes.delete(key);
            }
        }
        this.#nodes.delete(abs);
    }

    async rename(from: string, to: string): Promise<void> {
        const src = this.#abs(from);
        const dst = this.#abs(to);
        const node = this.#get(from, 'rename');
        this.#parent(dst, 'rename');
        const there = this.#nodes.get(dst);
        if (there?.kind === 'dir' && this.#children(dst).length > 0) {
            throw fsError('ENOTEMPTY', 'rename', to);
        }
        const moved = node.kind === 'dir' ? this.#below(src) : [];
        this.#nodes.delete(dst);
        this.#nodes.set(dst, node);
        this.#nodes.delete(src);
        for (const key of moved) {
            this.#nodes.set(dst + key.slice(src.length), this.#nodes.get(key)!);
            this.#nodes.delete(key);
        }
    }

    async copy(from: string, to: string, opts: { recursive?: boolean } = {}): Promise<void> {
        const src = this.#abs(from);
        const dst = this.#abs(to);
        const node = this.#get(from, 'cp');
        if (node.kind === 'dir' && !opts.recursive) {
            throw fsError('EISDIR', 'cp', from);
        }
        this.#parent(dst, 'cp');
        this.#nodes.set(dst, copyOf(node));
        if (node.kind === 'dir') {
            for (const key of this.#below(src)) {
                this.#nodes.set(dst + key.slice(src.length), copyOf(this.#nodes.get(key)!));
            }
        }
    }

    #abs(at: string): string {
        return posix.resolve('/', at);
    }

    #get(at: string, syscall: string): Node {
        const node = this.#nodes.get(this.#abs(at));
        if (!node) {
            throw fsError('ENOENT', syscall, at);
        }
        return node;
    }

    /** The parent has to be there already, as it does for `node:fs` without `recursive`. */
    #parent(abs: string, syscall: string): void {
        const up = this.#nodes.get(posix.dirname(abs));
        if (!up) {
            throw fsError('ENOENT', syscall, abs);
        }
        if (up.kind !== 'dir') {
            throw fsError('ENOTDIR', syscall, abs);
        }
    }

    #mkdirs(abs: string): void {
        if (abs === '/') {
            return;
        }
        this.#mkdirs(posix.dirname(abs));
        const node = this.#nodes.get(abs);
        if (node?.kind === 'file') {
            throw fsError('EEXIST', 'mkdir', abs);
        }
        if (!node) {
            this.#nodes.set(abs, { kind: 'dir' });
        }
    }

    #children(abs: string): string[] {
        const prefix = abs === '/' ? '/' : `${abs}/`;
        return [...this.#nodes.keys()]
            .filter(
                (k) => k !== abs && k.startsWith(prefix) && !k.slice(prefix.length).includes('/'),
            )
            .sort();
    }

    #below(abs: string): string[] {
        return [...this.#nodes.keys()].filter((k) => k.startsWith(`${abs}/`));
    }
}

function info(node: Node): FsStat {
    return {
        size: node.kind === 'file' ? node.data.byteLength : 0,
        isFile: () => node.kind === 'file',
        isDirectory: () => node.kind === 'dir',
        isSymbolicLink: () => false,
    };
}

function copyOf(node: Node): Node {
    return node.kind === 'file' ? { kind: 'file', data: Buffer.from(node.data) } : { kind: 'dir' };
}
