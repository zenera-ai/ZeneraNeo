import { localFs, type FsDriver } from './fs.ts';
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
     * Whether mounts are host directories bound from this machine. When they
     * are, the host prepares them (the container's `$HOME`, the runtime
     * libraries in it); when not, the backend supplies each by its `source`.
     */
    readonly local: boolean;
    /** the box for one spec */
    readonly box: BoxFactory;
    /** how the file tools reach the same trees the boxes see */
    readonly fs: FsDriver;
}

/**
 * What `zen run` uses: podman on this machine, and this machine's disk. The
 * engine binary and the process runner are per box, in `SandboxOptions`.
 */
export const podmanBackend: SandboxBackend = {
    name: 'podman',
    local: true,
    box: podmanBox,
    fs: localFs,
};
