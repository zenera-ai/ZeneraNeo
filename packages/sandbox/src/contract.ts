import type { FsDriver } from './fs.ts';
import type { FilesView, Mount } from './mounts.ts';

// ---------------------------------------------------------------------------
// The sandbox
//
// The whole environment a session's agents work in: one place commands run —
// a container, here or on a sandbox service — and the files they see. Every
// agent of the session shares it. This is the contract every implementation
// keeps, with one invariant:
//
//   A file written through `fs` is, at once, the file `exec` sees under the
//   same name — and the reverse.
//
// On `zen run` that is free: a podman container binds the host directory the
// disk driver reads. A sandbox service keeps the files with the container, so
// it serves `fs` itself.
// ---------------------------------------------------------------------------

/** The image a project gets when it does not name one. */
export const DEFAULT_SANDBOX_IMAGE = 'docker.io/library/python:3.14-slim-bookworm';

/**
 * Everything about a container that an author can state: the project's
 * `sandbox:` block, resolved. The identity of a container here *is* its
 * configuration, so a persisted one is reused only while the spec is equal.
 */
export interface SandboxSpec {
    /** the base image commands run in */
    image?: string;
    /**
     * A Dockerfile to build instead of an image to pull. The sandbox builds it
     * where it runs — podman on this machine, a service on its own builders —
     * under a tag derived from its content; `image` is then ignored.
     */
    build?: BuildSpec;
    /** fractional cores, as podman's `--cpus` */
    cpus?: number;
    /** MiB, as podman's `--memory` */
    memory?: number;
    network?: SandboxNetwork;
    /** where the workspace is mounted, and the default cwd */
    workdir?: string;
    /** default seconds a single command may take */
    timeout?: number;
    /** how much of the host the container is allowed to be; `standard` by default */
    hardening?: SandboxHardening;
    /** uid, name, or `uid:gid`; unset means the image's own user */
    user?: string;
    /** keep the container between sessions rather than removing it */
    persist?: boolean;
    /** environment inside the container — resolved values, never a passthrough */
    env?: Record<string, string>;
    /**
     * Variables forwarded from this process by *name*, for credentials.
     *
     * Separate from `env` for two reasons, both about the value never being
     * written down. `--env NAME` without an `=` tells podman to read the value
     * out of its own environment, so the secret never appears on a command
     * line, in `ps`, or in `podman inspect`. And the container's identity is
     * computed from the names alone, so rotating a key does not abandon a
     * persisted container's filesystem.
     */
    secrets?: readonly string[];
}

export type SandboxNetwork = 'bridge' | 'none' | 'host';

/** A Dockerfile and what it may see. Paths are absolute and already checked by the host. */
export interface BuildSpec {
    dockerfile: string;
    /** the build context: what `COPY` can reach */
    context: string;
    /** `--build-arg`s; part of the image's identity */
    args?: Record<string, string>;
}

/** How a sandbox gets its image ready. */
export interface PrepareOptions {
    /** lines worth showing a person: what is being pulled or built, and how it ended */
    onProgress?(line: string): void;
    /** wraps a slow step — a pull, a build — so a host can show it is still going */
    slow?<T>(label: string, work: Promise<T>): Promise<T>;
    /** pull or build again even when the image is there; `zen sandbox pull` */
    force?: boolean;
    /**
     * false: an image that would have to be built is a `SandboxError` instead —
     * for a host whose images are built somewhere else, ahead of time.
     */
    allowBuild?: boolean;
    signal?: AbortSignal;
}

/**
 * Two postures, because they cannot both be the default.
 *
 * `standard` is the one this tool was built around: a container with an init,
 * a pid ceiling and `no-new-privileges`, running an image the agent can still
 * install into. Installing a package is the ordinary use of a shell, so the
 * capabilities stay and the root filesystem stays writable.
 *
 * `strict` is for running code nobody has read. Every capability is dropped,
 * the root filesystem is read-only, the only writable temporary space is an
 * in-memory `/tmp` with `noexec,nosuid,nodev`, the process runs as the host's
 * own unprivileged uid rather than as container root, and the network is off
 * unless the project turns it back on. What that costs is exactly what it
 * removes: `apt`, `pip` and anything else that writes outside the mounts stop
 * working, so a strict project bakes its dependencies into the image instead.
 *
 * What it does *not* do is make the bind mounts go away. `/workspace` is the
 * work itself and stays writable — the profile shrinks the blast radius of a
 * command, it does not pretend the agent has nothing to edit.
 */
export type SandboxHardening = 'standard' | 'strict';

export interface SandboxOptions extends SandboxSpec {
    /** host directory mounted at `workdir` */
    root: string;
    /**
     * Stable name for whatever owns this sandbox — a session id, typically.
     * It prefixes the container name, so a crashed process leaves something a
     * human can recognise rather than a hash.
     */
    key: string;
    /** refuse to mount the workspace writable */
    readOnly?: boolean;
    /** extra bind mounts; the host side must already exist */
    mounts?: readonly Mount[];
    /**
     * Environment set on every command rather than on the container: values
     * that belong to the run, not to the container — the user it is acting for.
     *
     * `env` is fixed when the container is created, and a persisted container
     * is kept between sessions; a run's values written there
     * would still be answering for whoever came before. Not part of the
     * container's name either, for the same reason in reverse: a new user is
     * not a new machine. Plain values on podman's command line, so nothing
     * secret goes here — that is what `secrets` is for.
     */
    execEnv?: Record<string, string>;
    /**
     * Directories put in front of a path-like variable for every command —
     * `PYTHONPATH`, say — keeping whatever the image already set behind them.
     * `--env` could only replace the image's value, and an image that relies on
     * its own `PYTHONPATH` would break on the first `python`.
     */
    execPaths?: Record<string, readonly string[]>;
}

/**
 * One session's sandbox. `PodmanSandbox` is one on this machine; a remote
 * sandbox service is another. The tools and the job model are the same for
 * both.
 */
export interface Sandbox {
    /**
     * Derived from the spec, so a persisted sandbox is found again by an equal
     * spec, and a host can tell a reused one from a new one.
     */
    readonly name: string;
    /** the files every command sees, under the same names */
    readonly fs: FsDriver;
    /**
     * The file tools' view of this sandbox, in its own paths: given the host's
     * workspace and mounts, where `fs` actually finds each of them.
     */
    files(opts: FilesView): FilesView;
    /** whether anything was actually started — `close` is free when not */
    readonly started: boolean;
    /**
     * Makes the image available — pulled, or built from `build` — without
     * starting anything, so a host can do the slow part before the first turn
     * and show it. Idempotent and single-flight unless `force`; `start` does
     * whatever of it is still needed.
     */
    prepare(opts?: PrepareOptions): Promise<void>;
    /** idempotent and single-flight; every other call starts the sandbox itself */
    start(): Promise<void>;
    exec(command: string, opts?: ExecOptions): Promise<ExecResult>;
    /** starts a command and returns its job id; the output goes to a log */
    startJob(command: string, opts?: ExecOptions): Promise<string>;
    /**
     * A window of a job's log, from line `from` (1-based), plus whether it is
     * still going. An unknown id is a `SandboxError`.
     */
    readJob(id: string, from?: number): Promise<JobOutput>;
    /** Signals the job and everything it started. An unknown id is a `SandboxError`. */
    stopJob(id: string): Promise<JobStopped>;
    /**
     * The session is done for now (the end of a turn): stops a persisted
     * sandbox, removes an ephemeral one, and keeps the files — a sandbox that
     * holds them elsewhere persists them here.
     */
    close(): Promise<void>;
}

/** Opens a session's sandbox. Cheap: nothing starts until it is used. */
export type SandboxFactory = (opts: SandboxOptions) => Sandbox;

/** A failure the caller can do something about — a missing engine, usually. */
export class SandboxError extends Error {
    readonly hint?: string;

    constructor(message: string, hint?: string) {
        super(message);
        this.name = 'SandboxError';
        this.hint = hint;
    }
}

export interface ExecOptions {
    cwd?: string;
    /** seconds; the spec's default otherwise */
    timeout?: number;
    signal?: AbortSignal;
}

export interface ExecResult {
    exit_code: number;
    stdout: string;
    stderr: string;
    truncated?: boolean;
    timed_out?: boolean;
    duration_ms: number;
    out_of_memory?: OutOfMemory;
}

export interface JobOutput {
    job_id: string;
    command: string;
    running: boolean;
    /** once it has ended */
    exit_code?: number;
    duration_ms: number;
    /** the window returned, 1-based and inclusive */
    start_line: number;
    end_line: number;
    /** how long the log is now */
    lines: number;
    /** more of the log follows `end_line` */
    truncated?: boolean;
    output: string;
    out_of_memory?: OutOfMemory;
}

export interface JobStopped {
    job_id: string;
    stopped: boolean;
}

/**
 * Why a command was killed for memory, which is a different question from
 * whether it was. A container that overran its own `--memory` will do it again
 * however long anyone waits; one the kernel sacrificed for a neighbour may
 * simply succeed later. Exit code 137 is all either of them says.
 */
export interface OutOfMemory {
    /** what this container was allowed */
    limit_mib: number;
    /** high-water mark for the container's whole life, not for this command */
    peak_mib?: number;
    /** false when the limit itself is the problem, so an unchanged rerun ends the same way */
    retryable: boolean;
    hint: string;
}
