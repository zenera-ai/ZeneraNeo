import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { tool, type AnyTool, type JsonSchema } from '../types.ts';

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
/** Where background jobs keep their logs. Inside the container, not the host. */
const JOBS = '/tmp/zenera-jobs';
/** One command's output is capped, so a `cat` of a log file cannot fill the context. */
const MAX_OUTPUT = 64 * 1024;
/** ...and a job's log is read in windows of this many lines. */
const MAX_LOG_LINES = 400;
const DEFAULT_IMAGE = 'docker.io/library/python:3.14-slim-bookworm';
/** The image a project gets when it does not name one. */
export const DEFAULT_SANDBOX_IMAGE = DEFAULT_IMAGE;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 3_600_000;
const DEFAULT_PIDS = 1024;
/** How long a container gets to stop itself before it is killed. */
const STOP_GRACE_S = 2;
/** SIGKILL, which is how the kernel's out-of-memory killer arrives. */
const KILLED = 137;

// Standard mode's resource ceilings. Even without the strict profile, an
// unbounded container can exhaust host cores or memory during runaway builds.
const DEFAULT_CPUS = 4;
const DEFAULT_MEMORY = 4096;

// Strict mode's own defaults. A limit that is only there when someone
// remembered to write it down is not a limit, so the profile supplies one for
// each of the four exhaustible things: cores, memory, processes and disk.
const STRICT_CPUS = 2;
const STRICT_MEMORY = 2048;
const STRICT_TMPFS = 'rw,noexec,nosuid,nodev';
const STRICT_TMP_SIZE = '64m';

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
}

/** A failure the caller can do something about — a missing engine, usually. */
export class SandboxError extends Error {
    readonly hint?: string;

    constructor(message: string, hint?: string) {
        super(message);
        this.name = 'SandboxError';
        this.hint = hint;
    }
}

// ---------------------------------------------------------------------------
// Spawning
//
// Small on purpose. `execa` would do this and more, and this package's runtime
// dependencies are two — so it does this and nothing more.
// ---------------------------------------------------------------------------

export interface ProcOptions {
    /** written to stdin, which is then closed */
    input?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    /** per stream */
    maxBytes?: number;
}

export interface ProcResult {
    code: number;
    stdout: string;
    stderr: string;
    truncated: boolean;
    timedOut: boolean;
}

export type Runner = (
    bin: string,
    args: readonly string[],
    opts?: ProcOptions,
) => Promise<ProcResult>;

export const runProcess: Runner = (bin, args, opts = {}) =>
    new Promise<ProcResult>((settle, fail) => {
        const max = opts.maxBytes ?? MAX_OUTPUT;
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        let outSize = 0;
        let errSize = 0;
        let truncated = false;
        let timedOut = false;
        let done = false;

        const child = spawn(bin, [...args], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });

        const keep = (into: Buffer[], size: number, chunk: Buffer): number => {
            const room = max - size;
            if (room <= 0) {
                truncated = true;
                return size;
            }
            if (chunk.length > room) {
                truncated = true;
                into.push(chunk.subarray(0, room));
                return max;
            }
            into.push(chunk);
            return size + chunk.length;
        };

        child.stdout.on('data', (c: Buffer) => (outSize = keep(out, outSize, c)));
        child.stderr.on('data', (c: Buffer) => (errSize = keep(err, errSize, c)));

        // SIGTERM first so a well-behaved process can flush; SIGKILL after, so
        // one that ignores it cannot hold the turn open forever.
        let hard: NodeJS.Timeout | undefined;
        const stop = (): void => {
            child.kill('SIGTERM');
            hard = setTimeout(() => child.kill('SIGKILL'), 2000);
            hard.unref();
        };

        const timer = opts.timeoutMs
            ? setTimeout(
                  () => {
                      timedOut = true;
                      stop();
                  },
                  Math.min(opts.timeoutMs, MAX_TIMEOUT_MS),
              )
            : undefined;

        const onAbort = (): void => stop();
        opts.signal?.addEventListener('abort', onAbort, { once: true });

        const finish = (fn: () => void): void => {
            if (done) {
                return;
            }
            done = true;
            clearTimeout(timer);
            clearTimeout(hard);
            opts.signal?.removeEventListener('abort', onAbort);
            fn();
        };

        child.on('error', (e: NodeJS.ErrnoException) => {
            finish(() =>
                fail(
                    e.code === 'ENOENT'
                        ? new SandboxError(`${bin} is not installed, or not on PATH`)
                        : e,
                ),
            );
        });

        child.on('close', (code) => {
            finish(() =>
                settle({
                    code: code ?? (timedOut ? 124 : 1),
                    stdout: Buffer.concat(out).toString('utf8'),
                    stderr: Buffer.concat(err).toString('utf8'),
                    truncated,
                    timedOut,
                }),
            );
        });

        if (opts.input !== undefined) {
            child.stdin.on('error', () => {
                // A command that exits before reading its script closes the
                // pipe under us. That is the command's answer, not an error.
            });
            child.stdin.end(opts.input);
        } else {
            child.stdin.end();
        }
    });

// ---------------------------------------------------------------------------
// Reaching the engine at all
//
// On macOS and Windows the client is remote: unless it has been pointed at the
// machine's forwarded endpoint, every invocation opens its own ssh connection
// into the virtual machine, and sshd refuses new ones past `MaxStartups` — ten
// by default, with a random drop above that. A wide batch therefore loses
// calls for a reason that has nothing to do with the command, on a different
// task each time.
//
// A refused connection is the one failure that can be retried without asking
// what the command was: it happened before authentication, so nothing ran.
// ---------------------------------------------------------------------------

const TRANSPORT =
    /kex_exchange_identification|ssh: handshake failed|ssh: unexpected packet|connection closed by remote host|connection reset by peer|connection refused/i;

const ATTEMPTS = 4;

/**
 * `run`, retried while the engine could not be reached at all.
 *
 * Empty stdout is the guard that keeps this from retrying real work: a command
 * that produced output ran, whatever its stderr says afterwards. The wait is
 * jittered because the burst being backed off from is N clients arriving
 * together, and a fixed delay would only reassemble it.
 */
export function resilient(run: Runner, attempts = ATTEMPTS): Runner {
    return async (bin, args, opts = {}) => {
        for (let n = 1; ; n++) {
            const res = await run(bin, args, opts);
            if (
                n >= attempts ||
                res.code === 0 ||
                res.stdout !== '' ||
                opts.signal?.aborted ||
                !TRANSPORT.test(res.stderr)
            ) {
                return res;
            }
            await new Promise((go) => setTimeout(go, 2 ** n * 50 + Math.random() * 100));
        }
    };
}

// ---------------------------------------------------------------------------
// One container
// ---------------------------------------------------------------------------

interface Resolved extends Required<Omit<SandboxSpec, 'user'>> {
    user?: string;
    root: string;
    key: string;
    readOnly: boolean;
    mounts: readonly SandboxMount[];
    engine: string;
    execEnv: Record<string, string>;
    execPaths: Record<string, readonly string[]>;
    explicitCpus?: boolean;
    explicitMemory?: boolean;
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

/**
 * Asked of the container after a kill. Builtins only: a slim image may have no
 * `awk`, and strict hardening leaves nowhere writable to install one. `oom_kill`
 * counts kills in this container's cgroup and no other, which is what separates
 * the two cases. Unreadable values print empty, and the caller reads that as
 * "could not tell".
 */
const CGROUP = [
    `peak=; kills=`,
    `read peak < /sys/fs/cgroup/memory.peak 2>/dev/null`,
    `while read -r k v; do [ "$k" = oom_kill ] && kills=$v; done < /sys/fs/cgroup/memory.events 2>/dev/null`,
    `echo "peak=$peak kills=$kills"`,
].join('\n');

interface Job {
    id: string;
    command: string;
    cwd: string;
    startedAt: number;
    /** worked out once, because a log is read many times and the evidence is consumed */
    oom?: OutOfMemory;
}

/**
 * The container, started when it is first needed and not before. A project
 * whose agents never shell out never pays for an image pull, and a session
 * that only ever asks a question never leaves anything behind.
 */
export class Sandbox {
    readonly name: string;
    readonly spec: Resolved;
    readonly #run: Runner;
    readonly #jobs = new Map<string, Job>();
    #ready?: Promise<void>;
    #created = false;
    /** kills counted in this container's cgroup as of the last probe */
    #kills?: number;

    constructor(opts: SandboxOptions) {
        this.spec = resolveSpec(opts);
        this.#run = resilient(opts.exec ?? runProcess);
        this.name = containerName(this.spec);
    }

    /** Whether anything was actually started — `dispose` is free when not. */
    get started(): boolean {
        return this.#created;
    }

    /**
     * Idempotent, and single-flight: several tool calls in one batch all await
     * the same start rather than racing to create the same container.
     */
    start(): Promise<void> {
        this.#ready ??= this.#bring().catch((err: unknown) => {
            // A failed start must not be remembered as a start, or every later
            // call in the session inherits a failure it could have retried.
            this.#ready = undefined;
            throw err;
        });
        return this.#ready;
    }

    async #bring(): Promise<void> {
        const status = await this.#podman([
            'container',
            'inspect',
            this.name,
            '--format',
            '{{.State.Status}}',
        ]);
        if (status.code === 0) {
            const state = status.stdout.trim();
            if (state !== 'running') {
                await this.#must(['start', this.name], `could not start container ${this.name}`);
            }
            this.#created = true;
            return;
        }
        const made = await this.#podman(this.#createArgs());
        if (made.code !== 0) {
            throw new SandboxError(
                `could not create container ${this.name}: ${message(made)}`,
                LOCKS.test(made.stderr) ? locksHint(this.spec.engine) : undefined,
            );
        }
        this.#created = true;
    }

    #createArgs(): string[] {
        const s = this.spec;
        const args = ['run', '--detach', '--name', this.name];

        args.push('--label', 'zenera=1', '--label', `zenera.key=${s.key}`);
        args.push('--volume', mount({ host: s.root, at: s.workdir, readOnly: s.readOnly }));
        for (const m of s.mounts) {
            args.push('--volume', mount(m));
        }
        args.push('--workdir', s.workdir);
        args.push('--network', s.network);
        if (s.cpus > 0) {
            args.push('--cpus', String(s.cpus));
        }
        if (s.memory > 0) {
            args.push('--memory', `${s.memory}m`);
        }
        args.push('--pids-limit', String(DEFAULT_PIDS));

        // `no-new-privileges` costs nothing here and closes setuid escalation.
        // Under `standard` the capabilities are deliberately *not* dropped
        // wholesale: installing a package is the ordinary use of this tool, and
        // `--cap-drop=ALL` breaks every package manager there is. The container
        // is the boundary. `strict` makes the opposite trade, below.
        args.push('--security-opt', 'no-new-privileges');

        // Background jobs orphan processes; without an init they accumulate as
        // zombies until the pids limit stops the sandbox dead.
        args.push('--init');
        args.push('--restart', 'no');

        if (s.hardening === 'strict') {
            args.push('--cap-drop', 'ALL');
            // The image's own files become reference material: a command can
            // read a binary and run it, and can write nowhere but the mounts
            // and the tmpfs below.
            args.push('--read-only');
            // `noexec` is safe for the job launcher because a job script is
            // *interpreted* (`/bin/sh <file>`), never executed as a program.
            // `/run` is left to podman's own read-only tmpfs: `--init` mounts
            // catatonit under it and has to be able to exec it.
            args.push('--tmpfs', `/tmp:${STRICT_TMPFS},size=${STRICT_TMP_SIZE}`);
            if (!s.user) {
                // Rootless podman maps container uid 0 to the host account, so
                // the default container root is already unprivileged on the
                // host — but it is uid 0 *inside*, where the setuid binaries
                // are. `keep-id` runs the process as the host's own uid, which
                // is both non-zero and the owner of every bind mount, so the
                // workspace stays writable without a chown.
                args.push('--userns', 'keep-id');
            }
        }

        if (s.user) {
            args.push('--user', s.user);
        }
        for (const [k, v] of Object.entries(s.env)) {
            args.push('--env', `${k}=${v}`);
        }
        // No `=`, and so no value: podman reads each one from its own
        // environment. A key passed this way is not in the argv of a process
        // any user on the machine can list.
        for (const name of s.secrets) {
            if (process.env[name]) {
                args.push('--env', name);
            }
        }
        args.push(s.image, 'sleep', 'infinity');
        return args;
    }

    /**
     * `podman exec` for a command the agent asked for, with the run's own
     * environment. The script still arrives on stdin; when a path has to be
     * extended, the shell that reads it is started by a fixed `-c` line that
     * exports the variable and `exec`s it — built from host-chosen names and
     * paths only, so no text of the agent's is ever part of a parse here.
     */
    #exec(options: readonly string[] = []): string[] {
        const env = Object.entries(this.spec.execEnv).flatMap(([k, v]) => ['--env', `${k}=${v}`]);
        const paths = Object.entries(this.spec.execPaths).filter(([, dirs]) => dirs.length);
        const shell = paths.length
            ? [
                  '/bin/sh',
                  '-c',
                  [
                      ...paths.map(
                          ([name, dirs]) =>
                              `export ${name}=${quote(dirs.join(':'))}"\${${name}:+:\$${name}}"`,
                      ),
                      'exec /bin/sh -s',
                  ].join('; '),
              ]
            : ['/bin/sh', '-s'];
        return ['exec', '--interactive', ...env, ...options, this.name, ...shell];
    }

    /**
     * Runs one command and waits for it. The script goes down stdin, so no part
     * of it is ever parsed by a shell on this side of the container.
     */
    async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
        await this.start();
        const cwd = this.inside(opts.cwd);
        const timeoutMs = this.#timeout(opts.timeout);
        const startedAt = Date.now();

        const once = (): Promise<ProcResult> =>
            this.#run(this.spec.engine, this.#exec(['--workdir', cwd]), {
                input: command,
                timeoutMs,
                signal: opts.signal,
            });
        let res = await once();
        if (gone(res)) {
            // podman refused before running anything, so the retry cannot run the command twice.
            await this.#revive(res);
            res = await once();
        }

        return {
            exit_code: res.code,
            stdout: res.stdout,
            stderr: res.stderr,
            truncated: res.truncated || undefined,
            timed_out: res.timedOut || undefined,
            duration_ms: Date.now() - startedAt,
            out_of_memory: await this.#oom(res.code, res.timedOut, opts.signal),
        };
    }

    /**
     * Starts a command and returns. The wrapper writes the log and the exit
     * code to files the container owns, which is what makes the job readable
     * after the `exec` that started it has long returned.
     */
    async startJob(command: string, opts: ExecOptions = {}): Promise<Job> {
        await this.start();
        const cwd = this.inside(opts.cwd);
        const id = jobId();

        // The command reaches the container as a *file*, written by `cat` from
        // stdin. Interpolating it into the launcher script would put user text
        // back into a shell parse, which is the one thing this design avoids.
        const body = await this.#run(
            this.spec.engine,
            [
                'exec',
                '--interactive',
                this.name,
                '/bin/sh',
                '-c',
                `mkdir -p ${JOBS} && cat > ${JOBS}/${id}.sh`,
            ],
            { input: command, timeoutMs: 30_000 },
        );
        if (body.code !== 0) {
            throw new SandboxError(`could not write the job: ${message(body)}`);
        }

        // One logical line, because a newline would end the group command and
        // leave the redirection and the `&` on a statement of their own — the
        // job would then run in the foreground of this `exec`, with its output
        // going to the caller instead of the log.
        //
        // `setsid` puts the job in a session of its own so that stopping it can
        // signal a process group rather than one process; a shell without job
        // control leaves background jobs in its own group, and signalling that
        // would take down the `exec` shell with them. It is not required: where
        // it is missing the job still runs, and stopping falls back to the
        // single pid. The leader writes its own pid, since with `setsid` the
        // launching shell's `$!` is no longer the process to signal.
        const inner =
            `echo $$ > ${JOBS}/${id}.pid; ` +
            `/bin/sh ${JOBS}/${id}.sh; echo $? > ${JOBS}/${id}.exit`;
        const launch = [
            `cd ${quote(cwd)}`,
            `S=; command -v setsid > /dev/null 2>&1 && S=setsid`,
            `$S /bin/sh -c ${quote(inner)} > ${JOBS}/${id}.log 2>&1 < /dev/null &`,
            // The pid file is written by the child, so the launcher waits for
            // it: a read or a stop arriving immediately after must not find
            // the job missing.
            `i=0; while [ ! -s ${JOBS}/${id}.pid ] && [ $i -lt 50 ]; do i=$((i+1)); sleep 0.1; done`,
        ].join('\n');

        const started = await this.#run(this.spec.engine, this.#exec(), {
            input: launch,
            timeoutMs: 30_000,
        });
        if (started.code !== 0) {
            throw new SandboxError(`could not start the job: ${message(started)}`);
        }

        const job: Job = { id, command, cwd, startedAt: Date.now() };
        this.#jobs.set(id, job);
        return job;
    }

    /** A window of a job's log, plus whether it is still going. */
    async readJob(id: string, from = 1): Promise<unknown> {
        const job = this.#jobs.get(id);
        if (!job) {
            return { error: `no such job: ${id}`, hint: 'ids come from run_command_background' };
        }
        await this.start();
        const first = Math.max(1, Math.trunc(from));
        const script = [
            `cd ${JOBS} || exit 0`,
            `printf 'lines=%s\\n' "$(wc -l < ${id}.log 2>/dev/null || echo 0)"`,
            `if [ -f ${id}.exit ]; then printf 'exit=%s\\n' "$(cat ${id}.exit)"; fi`,
            `printf -- '---\\n'`,
            `tail -n +${first} ${id}.log 2>/dev/null | head -n ${MAX_LOG_LINES}`,
        ].join('\n');

        const res = await this.#run(
            this.spec.engine,
            ['exec', '--interactive', this.name, '/bin/sh', '-s'],
            { input: script, timeoutMs: 30_000 },
        );
        const [head, ...rest] = res.stdout.split('\n---\n');
        const meta = Object.fromEntries(
            head
                .split('\n')
                .filter(Boolean)
                .map((l) => l.split('=', 2) as [string, string]),
        );
        const output = rest.join('\n---\n');
        const lines = Number(meta.lines ?? 0);
        const shown = output ? output.replace(/\n$/, '').split('\n').length : 0;
        const exit = meta.exit === undefined ? undefined : Number(meta.exit);
        // Kept on the job: a second read would find the kill counter unchanged
        // and report this container's own overrun as the machine's doing.
        if (exit === KILLED && !job.oom) {
            job.oom = await this.#oom(exit, false);
        }

        return {
            job_id: id,
            command: job.command,
            running: meta.exit === undefined,
            exit_code: exit,
            duration_ms: Date.now() - job.startedAt,
            start_line: first,
            end_line: first + shown - 1,
            lines,
            truncated: first + shown - 1 < lines || undefined,
            output,
            out_of_memory: job.oom,
        };
    }

    /** Signals a job's whole process group, so its children go too. */
    async stopJob(id: string): Promise<unknown> {
        if (!this.#jobs.has(id)) {
            return { error: `no such job: ${id}`, hint: 'ids come from run_command_background' };
        }
        await this.start();
        const script = [
            `pid=$(cat ${JOBS}/${id}.pid 2>/dev/null)`,
            `[ -n "$pid" ] || { echo "already gone"; exit 0; }`,
            `kill -TERM -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true`,
            `sleep 1`,
            `kill -KILL -"$pid" 2>/dev/null || true`,
            `echo stopped`,
        ].join('\n');
        const res = await this.#run(
            this.spec.engine,
            ['exec', '--interactive', this.name, '/bin/sh', '-s'],
            { input: script, timeoutMs: 30_000 },
        );
        this.#jobs.delete(id);
        return { job_id: id, stopped: res.code === 0 };
    }

    /**
     * Stops a persisted container and removes an ephemeral one. Stopping
     * rather than removing is what makes `persist` mean anything: a stopped
     * container costs disk, a running one costs the machine's whole budget.
     */
    async dispose(): Promise<void> {
        if (!this.#created) {
            return;
        }
        this.#created = false;
        this.#ready = undefined;
        await this.#podman(
            this.spec.persist
                ? ['stop', '--time', String(STOP_GRACE_S), this.name]
                : ['rm', '--force', '--volumes', this.name],
        ).catch(() => undefined);
    }

    /**
     * A path inside the container, contained to the working directory. Purely
     * lexical, and correctly so: this is the container's path space, not this
     * machine's, and there is nothing here to resolve a symlink against.
     */
    inside(path?: string): string {
        const base = this.spec.workdir;
        if (!path) {
            return base;
        }
        if (path.includes('\0')) {
            throw new SandboxError('path contains a null byte');
        }
        const at = posix.resolve(base, path);
        if (at !== base && !at.startsWith(`${base}/`)) {
            throw new SandboxError(`outside ${base}: ${path}`, `paths are relative to ${base}`);
        }
        return at;
    }

    #timeout(seconds?: number): number {
        const wanted = seconds && seconds > 0 ? seconds * 1000 : this.spec.timeout * 1000;
        return Math.min(wanted || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    }

    /**
     * Turns a bare 137 into a reason, by asking the container which cgroup did
     * the killing. Only a kill counted against *this* container is the caller's
     * to fix; the rest is the machine being busy, and telling someone to shrink
     * a command that already fit would send them off after the wrong thing.
     */
    async #oom(
        code: number,
        timedOut: boolean,
        signal?: AbortSignal,
    ): Promise<OutOfMemory | undefined> {
        // A timeout or a cancel kills podman on this side, not the container,
        // and an uncapped container has no limit it could have exceeded.
        if (code !== KILLED || timedOut || signal?.aborted || this.spec.memory <= 0) {
            return undefined;
        }
        const res = await this.#run(
            this.spec.engine,
            ['exec', '--interactive', this.name, '/bin/sh', '-s'],
            { input: CGROUP, timeoutMs: 15_000 },
        ).catch(() => undefined);

        const out = res?.stdout ?? '';
        const peak = Number(/peak=(\d+)/.exec(out)?.[1]);
        const kills = Number(/kills=(\d+)/.exec(out)?.[1]);
        const counted = Number.isFinite(kills);
        // Nothing readable is read as our own doing: that costs one wasted
        // retry, where the other guess costs an agent retrying forever a
        // command that was never going to fit.
        const own = !counted || kills > (this.#kills ?? 0);
        if (counted) {
            this.#kills = kills;
        }

        const limit = this.spec.memory;
        return {
            limit_mib: limit,
            peak_mib: Number.isFinite(peak) ? Math.round(peak / (1024 * 1024)) : undefined,
            retryable: !own,
            hint: own
                ? `this container is limited to ${limit} MiB and the command wanted more. ` +
                  `Running it again unchanged will end the same way: give the sandbox more ` +
                  `memory in the project configuration, or do the work in smaller pieces.`
                : `the machine ran out of memory while this container was inside its ` +
                  `${limit} MiB limit, so it was killed for something another container did. ` +
                  `The command itself does not need to change, and may work once the machine ` +
                  `is less busy.`,
        };
    }

    #podman(args: readonly string[]): Promise<ProcResult> {
        return this.#run(this.spec.engine, args, { timeoutMs: 120_000 });
    }

    /** The container stopped or vanished under us (machine slept, restarted, or someone removed it). */
    async #revive(res: ProcResult): Promise<void> {
        this.#ready = undefined;
        try {
            await this.start();
        } catch (err) {
            throw new SandboxError(
                `the sandbox container ${this.name} stopped (${message(res)}) and could not be restarted: ` +
                    (err instanceof Error ? err.message : String(err)),
                `the ${this.spec.engine} machine may have stopped or restarted — check \`${this.spec.engine} machine list\`, ` +
                    `start it with \`${this.spec.engine} machine start\`, then retry`,
            );
        }
    }

    async #must(args: readonly string[], what: string): Promise<ProcResult> {
        const res = await this.#podman(args);
        if (res.code !== 0) {
            throw new SandboxError(`${what}: ${message(res)}`);
        }
        return res;
    }
}

function mount(m: SandboxMount): string {
    return `${m.host}:${m.at}${m.readOnly ? ':ro' : ''}`;
}

function message(res: ProcResult): string {
    return (res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`).split('\n')[0];
}

/** podman's words for "every lock is taken": `allocating lock … exceeded num_locks (2048)`. */
const LOCKS = /exceeded num_locks|allocating lock/i;

/**
 * A stopped container holds a lock as surely as a running one, and a
 * persisted sandbox is stopped, never removed — so they pile up one per
 * session until the engine can create nothing at all, for anyone.
 */
function locksHint(engine: string): string {
    return (
        `the ${engine} engine has no locks left: every container it holds, stopped ones ` +
        `included, takes one. Remove the stopped sandbox containers with ` +
        `\`${engine} container prune --force --filter label=zenera=1\`, then retry`
    );
}

/** podman's own exit code for "could not exec at all", with the two reasons that mean the container is not there to exec in. */
function gone(res: ProcResult): boolean {
    return (
        res.code === 125 &&
        /can only create exec sessions on running containers|container state improper|no such container/i.test(
            res.stderr,
        )
    );
}

/** Only ever applied to paths this module derived, never to a model's text. */
function quote(s: string): string {
    return `'${s.replaceAll("'", `'\\''`)}'`;
}

function jobId(): string {
    return `job-${createHash('sha256').update(`${Date.now()}${Math.random()}`).digest('hex').slice(0, 6)}`;
}

function resolveSpec(opts: SandboxOptions): Resolved {
    const workdir = opts.workdir ?? SANDBOX_MOUNT;
    if (!posix.isAbsolute(workdir)) {
        throw new SandboxError(`sandbox workdir must be absolute: ${workdir}`);
    }
    const hardening = opts.hardening ?? 'standard';
    const strict = hardening === 'strict';
    for (const name of [...Object.keys(opts.execEnv ?? {}), ...Object.keys(opts.execPaths ?? {})]) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
            throw new SandboxError(`not a variable name: ${JSON.stringify(name)}`);
        }
    }
    return {
        root: opts.root,
        key: opts.key,
        image: opts.image ?? DEFAULT_IMAGE,
        cpus: opts.cpus ?? (strict ? STRICT_CPUS : DEFAULT_CPUS),
        memory: opts.memory ?? (strict ? STRICT_MEMORY : DEFAULT_MEMORY),
        explicitCpus: opts.cpus !== undefined,
        explicitMemory: opts.memory !== undefined,
        network: opts.network ?? (strict ? 'none' : 'bridge'),
        workdir,
        timeout: opts.timeout ?? DEFAULT_TIMEOUT_MS / 1000,
        hardening,
        user: opts.user,
        persist: opts.persist ?? false,
        env: opts.env ?? {},
        secrets: opts.secrets ?? [],
        readOnly: opts.readOnly ?? false,
        mounts: opts.mounts ?? [],
        engine: opts.engine ?? 'podman',
        execEnv: opts.execEnv ?? {},
        execPaths: opts.execPaths ?? {},
    };
}

export interface SandboxLimits {
    /** MiB */
    memory: number;
    /** fractional cores */
    cpus: number;
    hardening: SandboxHardening;
    /** whether the numbers above were written down, or are this profile's defaults */
    declared: boolean;
}

/**
 * What a spec's ceilings come to, for a report that has no container to ask.
 *
 * It exists so `zen sandbox status` cannot disagree with what a run actually
 * applies: the defaults are stated once, here and in `resolveSpec`, and
 * nothing outside this module repeats them.
 */
export function sandboxLimits(
    spec: Pick<SandboxSpec, 'cpus' | 'memory' | 'hardening'> = {},
): SandboxLimits {
    const hardening = spec.hardening ?? 'standard';
    const strict = hardening === 'strict';
    return {
        memory: spec.memory ?? (strict ? STRICT_MEMORY : DEFAULT_MEMORY),
        cpus: spec.cpus ?? (strict ? STRICT_CPUS : DEFAULT_CPUS),
        hardening,
        declared: spec.memory !== undefined || spec.cpus !== undefined,
    };
}

/**
 * The container's name is a function of its configuration. Change the image
 * and a new container appears rather than an old one quietly persisting with
 * the wrong rootfs — which is the failure mode `persist` would otherwise have.
 *
 * Secrets contribute their names and not their values: what a container is
 * depends on which credentials reach it, not on what they happen to say today,
 * and hashing the values would throw away a persisted container's filesystem
 * every time a key was rotated.
 */
function containerName(spec: Resolved): string {
    // Unconfigured cpus and memory hash 0 under standard and strict's own
    // defaults under strict, so introducing defaults did not rename every
    // existing container.
    const hashCpus = spec.explicitCpus ? spec.cpus : spec.hardening === 'strict' ? STRICT_CPUS : 0;
    const hashMemory = spec.explicitMemory
        ? spec.memory
        : spec.hardening === 'strict'
          ? STRICT_MEMORY
          : 0;

    const digest = createHash('sha256')
        .update(
            JSON.stringify([
                spec.root,
                spec.image,
                hashCpus,
                hashMemory,
                spec.network,
                spec.workdir,
                spec.user ?? null,
                spec.readOnly,
                spec.mounts,
                Object.entries(spec.env).sort(),
                [...spec.secrets].sort(),
                // Appended only when it is set, so adding the profile did not
                // rename every container that existed before it.
                ...(spec.hardening === 'strict' ? ['strict'] : []),
            ]),
        )
        .digest('hex')
        .slice(0, 10);
    const key = spec.key
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
    return `zn-${key || 'session'}-${digest}`;
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
    readonly #boxes = new Map<string, Sandbox>();

    constructor(opts: SandboxPoolOptions) {
        const { agents, ...base } = opts;
        this.#base = base;
        this.#agents = agents ?? {};
    }

    for(agent?: string): Sandbox {
        const override = agent ? this.#agents[agent] : undefined;
        const box = new Sandbox(override ? { ...this.#base, ...override } : this.#base);
        const existing = this.#boxes.get(box.name);
        if (existing) {
            return existing;
        }
        this.#boxes.set(box.name, box);
        return box;
    }

    /** The containers that were actually started, for a status line. */
    get running(): readonly Sandbox[] {
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
