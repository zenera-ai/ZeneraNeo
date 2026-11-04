import { tool, type AnyTool, type JsonSchema } from '../types.ts';
import type { MountSource } from './mounts.ts';
import { podmanBox, type Runner } from './podman.ts';

// ---------------------------------------------------------------------------
// Sandbox tools
//
// A shell, and a boundary around it. The boundary is a container: the agent's
// commands run against an image the project chose, with one host directory
// bind-mounted at `/workspace` and nothing else of the machine in reach. That
// is the whole security story, and it is deliberately the *only* one — the
// command string is handed to `/bin/sh` verbatim, because escaping a shell
// language is a game nobody wins and the container is what makes losing it
// survivable.
//
// The host side is the opposite: every process is spawned with an argv array
// and `shell: false`, and the command text travels on **stdin** rather than in
// an argument, so there is no host shell to inject into and no argv length to
// overflow.
//
// Nothing here knows how to install a container engine or start a virtual
// machine. That is a host concern with a user attached to it, so it lives in
// whatever front end is driving this — the library only reports, clearly, that
// the engine did not answer.
// ---------------------------------------------------------------------------

/** Where the workspace appears inside the container. */
export const SANDBOX_MOUNT = '/workspace';
/** The image a project gets when it does not name one. */
export const DEFAULT_SANDBOX_IMAGE = 'docker.io/library/python:3.14-slim-bookworm';

/** The family name config selects the whole set by: `tools: [sandbox:*]`. */
export const SANDBOX_GROUP = 'sandbox';

/**
 * Everything about a container that an author can state, and that two agents
 * can therefore disagree about. Two specs that are equal share a container;
 * two that differ get one each, because the identity of a container here *is*
 * its configuration.
 */
export interface SandboxSpec {
    /** the base image commands run in */
    image?: string;
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

export interface SandboxMount {
    /** absolute host path */
    host: string;
    /** absolute path inside the container */
    at: string;
    readOnly?: boolean;
    /** what the tree is, for a backend that has to supply it rather than bind `host` */
    source?: MountSource;
}

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
    mounts?: readonly SandboxMount[];
    /**
     * Environment set on every command rather than on the container: values
     * that belong to the run, not to the box — the user it is acting for.
     *
     * `env` is fixed when the container is created, and a container is kept
     * between sessions and shared between agents; a run's values written there
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
    /** the container engine binary */
    engine?: string;
    /** how processes are spawned — the seam tests replace */
    exec?: Runner;
}

/**
 * Per-agent overrides on top of one base spec. An agent that overrides nothing
 * shares the base container; an agent that names a different image gets its
 * own, and two agents that name the *same* different image share that.
 */
export interface SandboxPoolOptions extends SandboxOptions {
    agents?: Record<string, SandboxSpec>;
    /** what a box is made of; a podman container on this machine when unset */
    box?: BoxFactory;
}

/**
 * What the sandbox tools need of a container, wherever it runs. `PodmanBox` is
 * one on this machine through podman; a remote sandbox service is another. The
 * tools, the pool and the job model are the same for both.
 */
export interface Box {
    /**
     * Derived from the spec, so two equal specs name one box — the pool shares
     * them by this, and a host can tell a reused box from a new one.
     */
    readonly name: string;
    /** whether anything was actually started — `dispose` is free when not */
    readonly started: boolean;
    /** idempotent and single-flight; every other call starts the box itself */
    start(): Promise<void>;
    exec(command: string, opts?: ExecOptions): Promise<ExecResult>;
    startJob(command: string, opts?: ExecOptions): Promise<{ id: string }>;
    /** a window of a job's log, plus whether it is still going */
    readJob(id: string, from?: number): Promise<unknown>;
    stopJob(id: string): Promise<unknown>;
    /** stops a persisted box, removes an ephemeral one */
    dispose(): Promise<void>;
}

/** Makes the box for one resolved set of options. Cheap: nothing starts until it is used. */
export type BoxFactory = (opts: SandboxOptions) => Box;

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

// ---------------------------------------------------------------------------
// One container per configuration
//
// Agents share a sandbox by default, and that is usually what an author means:
// they already share the workspace, and a hand-off is supposed to be
// continuous — whatever the first agent installed should still be there when
// the second one takes over.
//
// It stops being what they mean the moment two agents need different images.
// So the tool object stays single — one name, one schema, one prompt-cache
// prefix — and picks its container from `tc.agent` at call time. Two agents
// that resolve to the same spec still share one container, because the name is
// derived from the spec rather than from who asked.
// ---------------------------------------------------------------------------

export class SandboxPool {
    readonly #base: SandboxOptions;
    readonly #agents: Record<string, SandboxSpec>;
    readonly #make: BoxFactory;
    readonly #boxes = new Map<string, Box>();

    constructor(opts: SandboxPoolOptions) {
        const { agents, box, ...base } = opts;
        this.#base = base;
        this.#agents = agents ?? {};
        this.#make = box ?? podmanBox;
    }

    for(agent?: string): Box {
        const override = agent ? this.#agents[agent] : undefined;
        const box = this.#make(override ? { ...this.#base, ...override } : this.#base);
        const existing = this.#boxes.get(box.name);
        if (existing) {
            return existing;
        }
        this.#boxes.set(box.name, box);
        return box;
    }

    /** The containers that were actually started, for a status line. */
    get running(): readonly Box[] {
        return [...this.#boxes.values()].filter((b) => b.started);
    }

    async dispose(): Promise<void> {
        await Promise.all([...this.#boxes.values()].map((b) => b.dispose()));
    }
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

export function sandboxTools<TCtx = unknown>(
    opts: SandboxPoolOptions | SandboxPool,
): AnyTool<TCtx>[] {
    const pool = opts instanceof SandboxPool ? opts : new SandboxPool(opts);

    const where: JsonSchema = {
        type: 'object',
        properties: {
            command: {
                type: 'string',
                description: 'Shell command. Runs under /bin/sh inside the container.',
            },
            cwd: {
                type: 'string',
                description: `Directory to run in, relative to ${SANDBOX_MOUNT}.`,
            },
        },
        required: ['command'],
        additionalProperties: false,
    };

    const runCommand = tool<{ command: string; cwd?: string; timeout?: number }, TCtx>({
        name: 'run_command',
        group: SANDBOX_GROUP,
        description:
            'Runs a shell command in a Linux container and waits for it to finish. The ' +
            `workspace is mounted at ${SANDBOX_MOUNT} and is the working directory, so files you ` +
            'read and write here are the same files the file tools see. Everything ' +
            'else is throwaway. Use this for builds, tests, and package installs; use ' +
            'run_command_background for anything that does not end on its own, such as a ' +
            'server or a watcher.',
        parameters: {
            ...where,
            properties: {
                ...where.properties,
                timeout: { type: 'integer', description: 'Seconds to allow before killing it.' },
            },
        },
        execute: (args, tc) =>
            guard(() =>
                pool.for(tc.agent.name).exec(args.command, {
                    cwd: args.cwd,
                    timeout: args.timeout,
                    signal: tc.signal,
                }),
            ),
    });

    const runBackground = tool<{ command: string; cwd?: string }, TCtx>({
        name: 'run_command_background',
        group: SANDBOX_GROUP,
        description:
            'Starts a long-running command and returns immediately with a job id. Output ' +
            'is collected to a log you read with read_command_output; stop it with ' +
            'stop_command. Use this for servers, watchers, and anything you want to keep ' +
            'running while you do something else.',
        parameters: where,
        execute: (args, tc) =>
            guard(async () => {
                const job = await pool.for(tc.agent.name).startJob(args.command, { cwd: args.cwd });
                return {
                    job_id: job.id,
                    started: true,
                    hint: 'read_command_output shows what it has printed so far',
                };
            }),
    });

    const readOutput = tool<{ job_id: string; start_line?: number }, TCtx>({
        name: 'read_command_output',
        group: SANDBOX_GROUP,
        description:
            "Reads a background job's output and says whether it is still running. Pass " +
            'start_line to continue from where the last read ended, which is `end_line + 1`.',
        parameters: {
            type: 'object',
            properties: {
                job_id: { type: 'string', description: 'From run_command_background.' },
                start_line: { type: 'integer', description: 'First log line to return, 1-based.' },
            },
            required: ['job_id'],
            additionalProperties: false,
        },
        execute: (args, tc) =>
            guard(() => pool.for(tc.agent.name).readJob(args.job_id, args.start_line)),
    });

    const stop = tool<{ job_id: string }, TCtx>({
        name: 'stop_command',
        group: SANDBOX_GROUP,
        description: 'Stops a background job and everything it started.',
        parameters: {
            type: 'object',
            properties: { job_id: { type: 'string', description: 'From run_command_background.' } },
            required: ['job_id'],
            additionalProperties: false,
        },
        execute: (args, tc) => guard(() => pool.for(tc.agent.name).stopJob(args.job_id)),
    });

    return [runCommand, runBackground, readOutput, stop];
}

/**
 * A missing engine and a path outside the workspace are things the model can
 * be told about; anything else is a bug and should reach the runner as one.
 */
async function guard(fn: () => Promise<unknown>): Promise<unknown> {
    try {
        return await fn();
    } catch (err) {
        if (err instanceof SandboxError) {
            return { error: err.message, hint: err.hint };
        }
        throw err;
    }
}
