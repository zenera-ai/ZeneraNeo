import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { ensurePodmanImage, localImageTag } from './image.ts';
import { localFs, type FsDriver } from './fs.ts';
import { sandboxLimits } from './limits.ts';
import { WORKSPACE_MOUNT, type FilesView, type Mount } from './mounts.ts';
import { MAX_TIMEOUT_MS, resilient, runProcess, type ProcResult, type Runner } from './process.ts';
import {
    DEFAULT_SANDBOX_IMAGE,
    SandboxError,
    type BuildSpec,
    type PrepareOptions,
    type Sandbox,
    type SandboxFactory,
    type ExecOptions,
    type ExecResult,
    type JobOutput,
    type JobStopped,
    type OutOfMemory,
    type SandboxHardening,
    type SandboxOptions,
    type SandboxSpec,
} from './contract.ts';

// ---------------------------------------------------------------------------
// The podman sandbox
//
// `Sandbox` on this machine: one podman container per spec, driven by spawning the
// engine binary. Everything here is about that engine — its argv, its exit
// codes, its lock table, the ssh hop into its virtual machine — and none of it
// is something another backend would share.
// ---------------------------------------------------------------------------

/** Where background jobs keep their logs. Inside the container, not the host. */
const JOBS = '/tmp/zenera-jobs';
/** ...and a job's log is read in windows of this many lines. */
const MAX_LOG_LINES = 400;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_PIDS = 1024;
/** How long a container gets to stop itself before it is killed. */
const STOP_GRACE_S = 2;
/** SIGKILL, which is how the kernel's out-of-memory killer arrives. */
const KILLED = 137;

// Strict mode's filesystem limits; its cores and memory are in `limits.ts`.
const STRICT_TMPFS = 'rw,noexec,nosuid,nodev';
const STRICT_TMP_SIZE = '64m';

// ---------------------------------------------------------------------------
// One container
// ---------------------------------------------------------------------------

/** What only a podman sandbox needs: which binary to drive, and how to spawn it. */
export interface PodmanHost {
    /** the container engine binary; `podman` when unset */
    engine?: string;
    /** how processes are spawned — the seam tests replace */
    exec?: Runner;
}

interface Resolved extends Required<Omit<SandboxSpec, 'user' | 'build'>> {
    user?: string;
    /** the Dockerfile `image` is built from, when it is */
    build?: BuildSpec;
    root: string;
    key: string;
    readOnly: boolean;
    mounts: readonly Mount[];
    execEnv: Record<string, string>;
    execPaths: Record<string, readonly string[]>;
    explicitCpus?: boolean;
    explicitMemory?: boolean;
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
export class PodmanSandbox implements Sandbox {
    readonly name: string;
    /** the container binds the host directories, so the disk is where the files are */
    readonly fs: FsDriver = localFs;
    readonly spec: Resolved;
    readonly engine: string;
    readonly #run: Runner;
    readonly #spawn: Runner;
    readonly #jobs = new Map<string, Job>();
    #ready?: Promise<void>;
    #prepared?: Promise<void>;
    #created = false;
    /** kills counted in this container's cgroup as of the last probe */
    #kills?: number;

    constructor(opts: SandboxOptions, host: PodmanHost = {}) {
        this.spec = resolveSpec(opts);
        this.engine = host.engine ?? 'podman';
        this.#spawn = host.exec ?? runProcess;
        this.#run = resilient(this.#spawn);
        this.name = containerName(this.spec);
    }

    /** Whether anything was actually started — `close` is free when not. */
    get started(): boolean {
        return this.#created;
    }

    /** The host paths, as they are: the container binds exactly these. */
    files(opts: FilesView): FilesView {
        return { ...opts, fs: this.fs };
    }

    /** Pulls the image, or builds it from the Dockerfile, unless the engine already has it. */
    prepare(opts: PrepareOptions = {}): Promise<void> {
        if (this.#prepared && !opts.force) {
            return this.#prepared;
        }
        this.#prepared = ensurePodmanImage(
            { image: this.spec.image, build: this.spec.build },
            { engine: this.engine, exec: this.#spawn },
            opts,
        ).catch((err: unknown) => {
            this.#prepared = undefined;
            throw err;
        });
        return this.#prepared;
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
        // `run` pulls a registry image by itself; a built one has to exist first.
        if (this.spec.build) {
            await this.prepare();
        }
        const made = await this.#podman(this.#createArgs());
        if (made.code !== 0) {
            throw new SandboxError(
                `could not create container ${this.name}: ${message(made)}`,
                LOCKS.test(made.stderr) ? locksHint(this.engine) : undefined,
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
            this.#run(this.engine, this.#exec(['--workdir', cwd]), {
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
    async startJob(command: string, opts: ExecOptions = {}): Promise<string> {
        await this.start();
        const cwd = this.inside(opts.cwd);
        const id = jobId();

        // The command reaches the container as a *file*, written by `cat` from
        // stdin. Interpolating it into the launcher script would put user text
        // back into a shell parse, which is the one thing this design avoids.
        const body = await this.#run(
            this.engine,
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

        const started = await this.#run(this.engine, this.#exec(), {
            input: launch,
            timeoutMs: 30_000,
        });
        if (started.code !== 0) {
            throw new SandboxError(`could not start the job: ${message(started)}`);
        }

        const job: Job = { id, command, cwd, startedAt: Date.now() };
        this.#jobs.set(id, job);
        return id;
    }

    /** A window of a job's log, plus whether it is still going. */
    async readJob(id: string, from = 1): Promise<JobOutput> {
        const job = this.#job(id);
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
            this.engine,
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
    async stopJob(id: string): Promise<JobStopped> {
        this.#job(id);
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
            this.engine,
            ['exec', '--interactive', this.name, '/bin/sh', '-s'],
            { input: script, timeoutMs: 30_000 },
        );
        this.#jobs.delete(id);
        return { job_id: id, stopped: res.code === 0 };
    }

    #job(id: string): Job {
        const job = this.#jobs.get(id);
        if (!job) {
            throw new SandboxError(`no such job: ${id}`, 'ids come from run_command_background');
        }
        return job;
    }

    /**
     * Stops a persisted container and removes an ephemeral one. Stopping
     * rather than removing is what makes `persist` mean anything: a stopped
     * container costs disk, a running one costs the machine's whole budget.
     */
    async close(): Promise<void> {
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
            this.engine,
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
        return this.#run(this.engine, args, { timeoutMs: 120_000 });
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
                `the ${this.engine} machine may have stopped or restarted — check \`${this.engine} machine list\`, ` +
                    `start it with \`${this.engine} machine start\`, then retry`,
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

function mount(m: Mount): string {
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
    const workdir = opts.workdir ?? WORKSPACE_MOUNT;
    if (!posix.isAbsolute(workdir)) {
        throw new SandboxError(`sandbox workdir must be absolute: ${workdir}`);
    }
    const limits = sandboxLimits(opts);
    const { hardening } = limits;
    const strict = hardening === 'strict';
    for (const name of [...Object.keys(opts.execEnv ?? {}), ...Object.keys(opts.execPaths ?? {})]) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
            throw new SandboxError(`not a variable name: ${JSON.stringify(name)}`);
        }
    }
    return {
        root: opts.root,
        key: opts.key,
        image: opts.build ? localImageTag(opts.build) : (opts.image ?? DEFAULT_SANDBOX_IMAGE),
        build: opts.build,
        cpus: limits.cpus,
        memory: limits.memory,
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
        execEnv: opts.execEnv ?? {},
        execPaths: opts.execPaths ?? {},
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
    const strict = spec.hardening === 'strict' ? sandboxLimits({ hardening: 'strict' }) : undefined;
    const hashCpus = spec.explicitCpus ? spec.cpus : (strict?.cpus ?? 0);
    const hashMemory = spec.explicitMemory ? spec.memory : (strict?.memory ?? 0);

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

/** Podman on this machine: what `zen run` uses, and the engine's default. */
export const podmanSandbox: SandboxFactory = (opts) => new PodmanSandbox(opts);
