// ---------------------------------------------------------------------------
// The trees an agent can reach, and what each one is
//
// One directory is one mount, and the host hands the same array to the file
// tools and to the box so that both call it by the same name: a path a command
// prints is a path `read_file` accepts.
//
// On `zen run` every tree is a host directory bound into the container, and
// `host` is the whole story. A sandbox on another machine has no host path to
// bind: it has to be told what the tree is — the project's assets, its skills —
// and fetch that itself. So a mount carries both: `host` for a backend that
// binds, `source` for one that supplies. Memory is not a mount: its files stay
// with the graph and reach a box only through `memory_copy_file`.
// ---------------------------------------------------------------------------

/** Where the workspace appears in the agent's namespace, and the default cwd. */
export const WORKSPACE_MOUNT = '/workspace';

/** Where a project's `assets/` directory appears. */
export const ASSETS_MOUNT = '/assets';

/** ...and where its skill catalog does, so a skill's scripts can be run. */
export const SKILLS_MOUNT = '/skills';

export type MountSource =
    /** the project's reference material, at `/assets` */
    | { kind: 'assets' }
    /** the skill catalog — one merged tree at `/skills`, however many folders it came from */
    | { kind: 'skills' }
    /** the container's private, persistent `$HOME` */
    | { kind: 'home' }
    /** one credential file, by the variable that names it */
    | { kind: 'credential'; name: string };

export interface Mount {
    /** absolute host path; must already exist */
    host: string;
    /** absolute path the agent names it by, e.g. `/assets` */
    at: string;
    /**
     * Say it. Unset, the file tools treat an extra tree as reference material
     * and refuse to write it, while the box binds it writable — the container's
     * `$HOME` is the one mount that relies on that.
     */
    readOnly?: boolean;
    /** what the tree is, for a backend that has to supply it rather than bind `host` */
    source?: MountSource;
}

/** A mount stated by what it is: no host path, nothing to bind. */
export type LogicalMount = Required<Omit<Mount, 'host'>>;

/**
 * The mounts a supplying backend is asked for. The skill catalog arrives here
 * as one bind per skill folder — podman cannot merge directories — and leaves
 * as the single `/skills` tree it is to the agent. A mount nobody labelled is a
 * host directory with no meaning elsewhere, so it is refused rather than
 * silently dropped.
 */
export function logicalMounts(mounts: readonly Mount[]): LogicalMount[] {
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
