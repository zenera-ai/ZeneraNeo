import type { WorkspaceOptions } from './files.ts';
import { localFs, type FsDriver } from './fs.ts';
import { logicalMounts, WORKSPACE_MOUNT } from './mounts.ts';
import { podmanBox } from './podman.ts';
import type { BoxFactory } from './sandbox.ts';

// ---------------------------------------------------------------------------
// Where a session's sandbox lives
//
// Two things have to agree for an agent to work: the box its commands run in,
// and the filesystem its file tools read — a file `write_file` makes has to be
// a file `run_command` sees. On `zen run` that agreement is free: the box is a
// podman container on this machine and both sides use the same host directory.
// A sandbox service runs the box somewhere else and keeps the files with it,
// so it has to supply both halves. A backend is that pair.
// ---------------------------------------------------------------------------

export interface SandboxBackend {
    /** for messages and status lines: `podman`, `remote`, ... */
    readonly name: string;
    /**
     * Whether each mount's `host` directory is bound into the box from this
     * machine. When it is, the host prepares those directories (the
     * container's `$HOME`, the runtime libraries in it); when not, the backend
     * supplies each tree by its `source`.
     */
    readonly bindsHostPaths: boolean;
    /** makes the box for one spec */
    readonly newBox: BoxFactory;
    /** how the file tools reach the same trees the boxes see */
    readonly fs: FsDriver;
}

/** What `zen run` uses: podman on this machine, and this machine's disk. */
export const podmanBackend: SandboxBackend = {
    name: 'podman',
    bindsHostPaths: true,
    newBox: podmanBox(),
    fs: localFs,
};

/**
 * The file tools' view of a session, in the backend's own paths. A backend
 * that binds host directories reads them where they are. One that keeps the
 * files with the box has no host paths: the workspace is its mount point and
 * each tree is found where the box has it, so a path the model writes means
 * one file to both the tools and the shell.
 */
export function workspaceFor(backend: SandboxBackend, opts: WorkspaceOptions): WorkspaceOptions {
    if (backend.bindsHostPaths) {
        return { ...opts, fs: backend.fs };
    }
    const mount = opts.mount ?? WORKSPACE_MOUNT;
    return {
        ...opts,
        root: mount,
        mount,
        mounts: logicalMounts(opts.mounts ?? []).map((m) => ({ ...m, host: m.at })),
        fs: backend.fs,
    };
}
