import { SKILLS_MOUNT } from './files.ts';
import type { SandboxMount } from './sandbox.ts';

// ---------------------------------------------------------------------------
// What a mount *is*, apart from where it comes from
//
// On `zen run` every tree besides the workspace is a host directory bound into
// the container, and the host path is the whole story. A sandbox on another
// machine has no host path to bind: it has to be told what the tree is — the
// project's assets, its skills — and fetch that itself. Memory is not one:
// its files stay with the graph and reach a box only through `memory_copy_file`.
// So each mount carries both: `host` for a backend that binds, `source` for
// one that supplies.
// ---------------------------------------------------------------------------

export type MountSource =
    /** the project's reference material, at `/assets` */
    | { kind: 'assets' }
    /** the skill catalog — one merged tree at `/skills`, however many folders it came from */
    | { kind: 'skills' }
    /** the container's private, persistent `$HOME` */
    | { kind: 'home' }
    /** one credential file, by the variable that names it */
    | { kind: 'credential'; name: string };

/** A mount stated by what it is: no host path, nothing to bind. */
export interface LogicalMount {
    at: string;
    readOnly: boolean;
    source: MountSource;
}

/**
 * The mounts a supplying backend is asked for. The skill catalog arrives here
 * as one bind per skill folder — podman cannot merge directories — and leaves
 * as the single `/skills` tree it is to the agent. A mount nobody labelled is a
 * host directory with no meaning elsewhere, so it is refused rather than
 * silently dropped.
 */
export function logicalMounts(mounts: readonly SandboxMount[]): LogicalMount[] {
    const out: LogicalMount[] = [];
    let skills = false;
    for (const m of mounts) {
        if (!m.source) {
            throw new Error(`mount ${m.at} has no source, so only a local sandbox can provide it`);
        }
        if (m.source.kind === 'skills') {
            if (!skills) {
                out.push({ at: SKILLS_MOUNT, readOnly: true, source: m.source });
                skills = true;
            }
            continue;
        }
        out.push({ at: m.at, readOnly: m.readOnly ?? false, source: m.source });
    }
    return out;
}
