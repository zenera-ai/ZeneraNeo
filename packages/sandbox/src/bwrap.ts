import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
    closeSync,
    createReadStream,
    existsSync,
    lstatSync,
    mkdtempSync,
    openSync,
    readdirSync,
    readFileSync,
    readlinkSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { delimiter, join, posix } from 'node:path';
import { createInterface } from 'node:readline';
import { buildIdentity } from './image.ts';
import { sandboxLimits } from './limits.ts';
import { WORKSPACE_MOUNT, type Mount } from './mounts.ts';
import { MAX_TIMEOUT_MS, runProcess, type ProcResult, type Runner } from './process.ts';
import { RootedFs } from './rooted-fs.ts';
import {
    DEFAULT_SANDBOX_IMAGE,
    SandboxError,
    type BuildSpec,
    type ExecOptions,
    type ExecResult,
    type JobOutput,
    type JobStopped,
    type OutOfMemory,
    type PrepareOptions,
    type Sandbox,
    type SandboxFactory,
    type SandboxHardening,
    type SandboxNetwork,
    type SandboxOptions,
} from './contract.ts';

// ---------------------------------------------------------------------------
// The bwrap sandbox
//
// `Sandbox` for a host that is itself the sandbox's container: the agent
// image, where the server, the project's environment and the agent's commands
// share one root filesystem. Each command runs under bubblewrap in namespaces
// of its own — its own processes, a read-only view of the image, the mounts it
// is given and nothing of the server's: not its environment, not its state.
//
// Nothing is pulled or built here; the image is whatever this container runs.
// `prepare` only checks that it is the image the project describes.
//
// What a container sets for the whole container is not this sandbox's to set:
// `cpus`, `memory` and `persist` are ignored. Commands are made the first
// thing the kernel's out-of-memory killer takes instead of the server.
// ---------------------------------------------------------------------------

/** Where the agent image keeps its bwrap: a static build, so any base runs it. */
export const ZENERA_BWRAP = '/opt/zenera/bin/bwrap';

/**
 * The project image's own environment (its Dockerfile's `ENV` lines), written by the agent
 * image's build as a JSON object: what a command gets to start from, as it would in that image.
 */
export const IMAGE_ENV_FILE = '/opt/zenera/etc/image-env.json';

/** Set by `zen image build`: what the image was built from. */
export const IMAGE_BUILD_ENV = 'ZEN_IMAGE_BUILD';
export const IMAGE_BASE_ENV = 'ZEN_IMAGE_BASE';

/** The server's own paths, never shown to a command. */
const DEFAULT_HIDDEN = ['/state', '/run/secrets'];

/** What a command gets of this process's environment; the rest it is given by name. */
const BASE_ENV = ['PATH', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TZ'];
const DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

const MAX_LOG_LINES = 400;
const DEFAULT_TIMEOUT_MS = 120_000;
const STRICT_TMP_BYTES = 64 * 1024 * 1024;
const STOP_GRACE_MS = 1000;
/** SIGKILL, which is how the kernel's out-of-memory killer arrives. */
const KILLED = 137;
/** Where a job's script appears, inside the command's own `/tmp`. */
const JOB_SCRIPT = '/tmp/.zenera-job.sh';

/**
 * Commands go first when memory runs out, the server last. Set by a shell of
 * ours just before it becomes bwrap, so everything in the sandbox inherits it
 * (raising one's own score needs no privilege), whether or not the sandbox's
 * `/proc` is writable. The same shell lowers the command's priority and caps
 * the size of any one file it writes, when the host asks: soft limits that need
 * no cgroup of their own, which a pod rarely lets a process make.
 */
export function launchArgs(limits: CommandLimits = {}): string[] {
    const steps = ['{ echo 1000 > /proc/self/oom_score_adj; } 2>/dev/null'];
    // `sh`'s `ulimit -f` counts 512-byte blocks (POSIX; bash in sh mode, dash and ash alike).
    if (limits.fileSizeBytes && limits.fileSizeBytes > 0) {
        steps.push(`ulimit -f ${Math.ceil(limits.fileSizeBytes / 512)}`);
    }
    const nice = Math.trunc(limits.nice ?? 0);
    steps.push(
        nice > 0
            ? `if command -v nice >/dev/null 2>&1; then exec nice -n ${Math.min(nice, 19)} "$0" "$@"; fi; exec "$0" "$@"`
            : 'exec "$0" "$@"',
    );
    return ['-c', steps.join('; ')];
}

/** What a host may hold each command to; unset or 0 is no limit. */
export interface CommandLimits {
    /** how much lower the command's CPU priority is than the server's (1-19) */
    nice?: number;
    /** the largest file a command may write (RLIMIT_FSIZE); a bigger write fails with EFBIG */
    fileSizeBytes?: number;
    /** the size of the command's own /tmp, which is memory (tmpfs) */
    tmpBytes?: number;
}

const CGROUP = '/sys/fs/cgroup';

/** `--proc`: a `/proc` of the command's own, or the container's, bound read-only. */
export type ProcMode = 'fresh' | 'bind';

export interface BwrapProbe {
    ok: boolean;
    /** the binary probed */
    bwrap: string;
    /** how `/proc` is given to commands, when `ok` */
    proc?: ProcMode;
    /** why not, when not `ok` */
    error?: string;
    hint?: string;
}

/** What a host can tell the sandbox about where it runs; the defaults are the agent image's. */
export interface BwrapHost {
    /** the bwrap binary; `/opt/zenera/bin/bwrap`, else `bwrap` on PATH */
    bwrap?: string;
    /** where the base environment and secrets are read from; `process.env` */
    env?: NodeJS.ProcessEnv;
    /** more paths no command sees, besides `/state` and `/run/secrets` (always hidden) */
    hidden?: readonly string[];
    /** soft limits on every command: priority, file size, /tmp size */
    limits?: CommandLimits;
    /**
     * What this image was built from, which `prepare` checks the spec against;
     * from `ZEN_IMAGE_BUILD` / `ZEN_IMAGE_BASE` when unset. Neither known, or
     * `false`: no check — the container is whatever its host made it.
     */
    image?: false | { build?: string; base?: string };
    /**
     * What a command's environment starts from: the image's own `ENV` (IMAGE_ENV_FILE, when the
     * container has it), else PATH, LANG, LC_* and TZ of this process. Never the rest of it.
     */
    imageEnv?: Record<string, string>;
    /** how processes are spawned — the seam tests replace */
    exec?: Runner;
    /** the host's filesystem as the root is built from it — the seam tests replace */
    tree?: HostTree;
}

/** The host's filesystem, as far as building a command's root needs it. */
export interface HostTree {
    kind(path: string): 'dir' | 'file' | 'symlink' | 'missing';
    list(path: string): string[];
    link(path: string): string;
}

export const hostTree: HostTree = {
    kind(path) {
        try {
            const s = lstatSync(path);
            return s.isSymbolicLink() ? 'symlink' : s.isDirectory() ? 'dir' : 'file';
        } catch {
            return 'missing';
        }
    },
    list: (path) => readdirSync(path),
    link: (path) => readlinkSync(path),
};

interface Resolved {
    root: string;
    key: string;
    image: string;
    build?: BuildSpec;
    network: SandboxNetwork;
    workdir: string;
    timeout: number;
    hardening: SandboxHardening;
    user?: { uid: string; gid?: string };
    env: Record<string, string>;
    secrets: readonly string[];
    readOnly: boolean;
    mounts: readonly Mount[];
    execEnv: Record<string, string>;
    execPaths: Record<string, readonly string[]>;
}

interface Job {
    id: string;
    command: string;
    startedAt: number;
    log: string;
    child: ChildProcess;
    exit?: number;
    ended: Promise<void>;
    oom?: OutOfMemory;
}

export class BwrapSandbox implements Sandbox {
    readonly name: string;
    readonly fs: RootedFs;
    readonly spec: Resolved;
    readonly #host: BwrapHost;
    readonly #run: Runner;
    readonly #tree: HostTree;
    readonly #jobs = new Map<string, Job>();
    #bwrap?: string;
    #proc: ProcMode = 'fresh';
    #dir?: string;
    #closing = new AbortController();
    #ready?: Promise<void>;
    #prepared?: Promise<void>;
    #started = false;
    /** kills counted in this container's cgroup as of the last look */
    #kills?: number;

    constructor(opts: SandboxOptions, host: BwrapHost = {}) {
        this.spec = resolveSpec(opts);
        this.#host = host;
        this.#run = host.exec ?? runProcess;
        this.#tree = host.tree ?? hostTree;
        this.name = `zenera-bwrap-${opts.key}`;
        this.fs = new RootedFs([
            { at: this.spec.workdir, dir: this.spec.root, readOnly: this.spec.readOnly },
            ...this.spec.mounts
                .filter((m) => m.source?.kind !== 'credential')
                .map((m) => ({ at: m.at, dir: m.host, readOnly: m.readOnly })),
        ]);
    }

    get started(): boolean {
        return this.#started;
    }

    /** Checks that this container is the image the project describes; builds nothing. */
    prepare(opts: PrepareOptions = {}): Promise<void> {
        if (!this.#prepared || opts.force) {
            this.#prepared = Promise.resolve()
                .then(() => this.#checkImage())
                .catch((err: unknown) => {
                    this.#prepared = undefined;
                    throw err;
                });
        }
        return this.#prepared;
    }

    #checkImage(): void {
        if (this.#host.image === false) {
            return;
        }
        const env = this.#host.env ?? process.env;
        const have = this.#host.image ?? {
            build: env[IMAGE_BUILD_ENV]?.trim() || undefined,
            base: env[IMAGE_BASE_ENV]?.trim() || undefined,
        };
        // A container `zen image build` did not make says nothing about what it holds; that is
        // the host's call (a development container, a test), not a mismatch.
        if (!have.build && !have.base) {
            return;
        }
        const hint = 'rebuild the image: zen image build';
        if (this.spec.build) {
            const want = buildIdentity(this.spec.build).hash;
            if (!have.build) {
                throw new SandboxError(
                    `this container was not built from the project's sandbox Dockerfile (no ${IMAGE_BUILD_ENV})`,
                    hint,
                );
            }
            if (have.build !== want) {
                throw new SandboxError(
                    `the image was built from another sandbox Dockerfile: ${have.build}, the project's is ${want}`,
                    hint,
                );
            }
        } else if (have.base !== this.spec.image) {
            throw new SandboxError(
                `the image is based on ${have.base ?? 'an unknown image'}, the project asks for ${this.spec.image}`,
                hint,
            );
        }
    }

    start(): Promise<void> {
        this.#ready ??= this.#bring().catch((err: unknown) => {
            this.#ready = undefined;
            throw err;
        });
        return this.#ready;
    }

    async #bring(): Promise<void> {
        const probe = await probeBwrap(this.#host.bwrap, this.#run);
        if (!probe.ok) {
            throw new SandboxError(`commands cannot be isolated here: ${probe.error}`, probe.hint);
        }
        this.#bwrap = probe.bwrap;
        this.#proc = probe.proc ?? 'bind';
        this.#dir = mkdtempSync(join(tmpdir(), 'zenera-bwrap-'));
        this.#closing = new AbortController();
        this.#kills ??= cgroupKills();
        this.#started = true;
    }

    async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
        await this.start();
        const cwd = this.inside(opts.cwd);
        const startedAt = Date.now();
        const signal = opts.signal
            ? AbortSignal.any([opts.signal, this.#closing.signal])
            : this.#closing.signal;
        // The script goes down stdin, so no text of the agent's is ever part of a parse here.
        const res = await this.#run(
            '/bin/sh',
            [...launchArgs(this.#host.limits), this.#bwrap!, ...this.#args(cwd, ['/bin/sh', '-s'])],
            {
                input: command,
                timeoutMs: this.#timeout(opts.timeout),
                signal,
                env: this.#env(),
            },
        );
        refuseSetupFailure(res);
        return {
            exit_code: res.code,
            stdout: res.stdout,
            stderr: res.stderr,
            truncated: res.truncated || undefined,
            timed_out: res.timedOut || undefined,
            duration_ms: Date.now() - startedAt,
            out_of_memory: res.timedOut || signal.aborted ? undefined : this.#oom(res.code),
        };
    }

    /**
     * Starts a command and returns. Its log is a file of this process's, outside
     * the command's view; its exit code is the one bwrap reports.
     */
    async startJob(command: string, opts: ExecOptions = {}): Promise<string> {
        await this.start();
        const cwd = this.inside(opts.cwd);
        const id = jobId();
        const script = join(this.#dir!, `${id}.sh`);
        const log = join(this.#dir!, `${id}.log`);
        writeFileSync(script, command, { mode: 0o600 });
        const fd = openSync(log, 'a', 0o600);
        let child: ChildProcess;
        try {
            child = spawn(
                '/bin/sh',
                [
                    ...launchArgs(this.#host.limits),
                    this.#bwrap!,
                    ...this.#args(cwd, ['/bin/sh', JOB_SCRIPT], ['--ro-bind', script, JOB_SCRIPT]),
                ],
                // Its own process group, so stopping it signals bwrap and nothing of ours.
                { stdio: ['ignore', fd, fd], env: this.#env(), detached: true },
            );
        } finally {
            closeSync(fd);
        }
        const job: Job = {
            id,
            command,
            startedAt: Date.now(),
            log,
            child,
            ended: new Promise((done) => {
                child.once('exit', (code, sig) => {
                    job.exit = code ?? exitOfSignal(sig);
                    done();
                });
                child.once('error', (err) => {
                    job.exit ??= 127;
                    writeFileSync(log, `could not start: ${err.message}\n`, { flag: 'a' });
                    done();
                });
            }),
        };
        child.unref();
        this.#jobs.set(id, job);
        return id;
    }

    async readJob(id: string, from = 1): Promise<JobOutput> {
        const job = this.#job(id);
        const first = Math.max(1, Math.trunc(from));
        const { lines, window } = await readWindow(job.log, first, MAX_LOG_LINES);
        if (job.exit === KILLED && !job.oom) {
            job.oom = this.#oom(job.exit);
        }
        const end = first + window.length - 1;
        return {
            job_id: id,
            command: job.command,
            running: job.exit === undefined,
            exit_code: job.exit,
            duration_ms: Date.now() - job.startedAt,
            start_line: first,
            end_line: end,
            lines,
            truncated: end < lines || undefined,
            output: window.length ? `${window.join('\n')}\n` : '',
            out_of_memory: job.oom,
        };
    }

    /**
     * Ends bwrap, and with it everything the job started: the command is the
     * first process of a pid namespace, and a namespace whose first process
     * dies takes the rest with it.
     */
    async stopJob(id: string): Promise<JobStopped> {
        const job = this.#job(id);
        await this.#end(job);
        this.#jobs.delete(id);
        return { job_id: id, stopped: true };
    }

    async #end(job: Job): Promise<void> {
        if (job.exit !== undefined || job.child.pid === undefined) {
            return;
        }
        signalGroup(job.child.pid, 'SIGTERM');
        const ended = await Promise.race([
            job.ended.then(() => true),
            new Promise<boolean>((r) => setTimeout(() => r(false), STOP_GRACE_MS)),
        ]);
        if (!ended) {
            signalGroup(job.child.pid, 'SIGKILL');
            await job.ended;
        }
    }

    #job(id: string): Job {
        const job = this.#jobs.get(id);
        if (!job) {
            throw new SandboxError(`no such job: ${id}`, 'ids come from run_command_background');
        }
        return job;
    }

    /** Ends every command and job; the files stay where the mounts keep them. */
    async close(): Promise<void> {
        if (!this.#started) {
            return;
        }
        this.#started = false;
        this.#ready = undefined;
        this.#closing.abort();
        await Promise.all([...this.#jobs.values()].map((job) => this.#end(job)));
        this.#jobs.clear();
        if (this.#dir) {
            rmSync(this.#dir, { recursive: true, force: true });
            this.#dir = undefined;
        }
    }

    /** A path inside the sandbox, contained to the working directory. */
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

    /** bwrap's arguments for one command. */
    #args(cwd: string, command: readonly string[], extra: readonly string[] = []): string[] {
        const s = this.spec;
        const binds = [
            { at: s.workdir, host: s.root, readOnly: s.readOnly },
            ...s.mounts.map((m) => ({ at: m.at, host: m.host, readOnly: m.readOnly ?? false })),
        ].sort((a, b) => depth(a.at) - depth(b.at));
        return bwrapArgs({
            tree: this.#tree,
            hidden: [
                ...DEFAULT_HIDDEN,
                ...(this.#host.hidden ?? []),
                ...(this.#dir ? [this.#dir] : []),
            ],
            binds,
            proc: this.#proc,
            network: s.network,
            strict: s.hardening === 'strict',
            tmpBytes: this.#host.limits?.tmpBytes,
            user: s.user,
            cwd,
            extra,
            command,
        });
    }

    /**
     * Exactly what a command sees, and also what bwrap is started with: bwrap's
     * own environment stays readable to the command (its `/proc/1/environ`), so
     * nothing of the server's may reach bwrap in the first place.
     */
    #env(): NodeJS.ProcessEnv {
        const host = this.#host.env ?? process.env;
        const image = this.#host.imageEnv ?? imageEnv();
        const env: Record<string, string> = {};
        if (image) {
            Object.assign(env, image);
        } else {
            for (const name of BASE_ENV) {
                const value = host[name];
                if (value !== undefined) {
                    env[name] = value;
                }
            }
        }
        env.PATH ??= DEFAULT_PATH;
        Object.assign(env, this.spec.env);
        for (const name of this.spec.secrets) {
            const value = host[name];
            if (value !== undefined) {
                env[name] = value;
            }
        }
        Object.assign(env, this.spec.execEnv);
        for (const [name, dirs] of Object.entries(this.spec.execPaths)) {
            if (dirs.length) {
                env[name] = [...dirs, ...(env[name] ? [env[name]] : [])].join(':');
            }
        }
        return env;
    }

    #timeout(seconds?: number): number {
        const wanted = seconds && seconds > 0 ? seconds * 1000 : this.spec.timeout * 1000;
        return Math.min(wanted || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    }

    /**
     * A bare 137 turned into a reason. The container's cgroup is the only
     * limit there is, so a kill counted against it means the command needs
     * less memory, or the container more; an uncounted one was the machine's.
     */
    #oom(code: number): OutOfMemory | undefined {
        if (code !== KILLED) {
            return undefined;
        }
        const limit = cgroupLimitMib();
        if (limit === undefined) {
            return undefined;
        }
        const kills = cgroupKills();
        const own = kills === undefined || kills > (this.#kills ?? 0);
        if (kills !== undefined) {
            this.#kills = kills;
        }
        const peak = cgroupNumber('memory.peak');
        return {
            limit_mib: limit,
            peak_mib: peak === undefined ? undefined : Math.round(peak / (1024 * 1024)),
            retryable: !own,
            hint: own
                ? `this container is limited to ${limit} MiB and the command wanted more. ` +
                  `Running it again unchanged will end the same way: do the work in smaller ` +
                  `pieces, or give the container more memory.`
                : `the machine ran out of memory while this container was inside its ` +
                  `${limit} MiB limit, so the command was killed for something else. It does ` +
                  `not need to change, and may work once the machine is less busy.`,
        };
    }
}

export const bwrapSandbox: SandboxFactory = (opts) => new BwrapSandbox(opts);

// ---------------------------------------------------------------------------
// The command's root
//
// Built from the host's, entry by entry, on an empty one: every top-level
// directory is bound read-only where it is, symlinks are recreated, and what is
// hidden is left out or covered. A directory is opened up — made an empty one
// of its own, its entries bound one by one — only where something has to be
// mounted inside it that the image does not have (`/home/agent`,
// `/run/zenera/keys/…`). The empty root itself stays writable: it is the
// command's own scratch, gone with it, and remounting it is something SELinux
// refuses inside a container.
// ---------------------------------------------------------------------------

export interface BwrapArgs {
    tree: HostTree;
    hidden: readonly string[];
    /** shallowest first */
    binds: readonly { at: string; host: string; readOnly: boolean }[];
    proc: ProcMode;
    network: SandboxNetwork;
    strict: boolean;
    /** the size of the command's /tmp; strict mode's own cap applies when smaller */
    tmpBytes?: number;
    user?: { uid: string; gid?: string };
    cwd: string;
    /** more mounts, after `/tmp` exists */
    extra?: readonly string[];
    command: readonly string[];
}

/** Paths every command gets of its own, whatever the host has there. */
const OWN = ['/proc', '/dev', '/tmp'];

export function bwrapArgs(a: BwrapArgs): string[] {
    const args = [
        // Explicit, so a server that happens to run as root still puts commands
        // in a user namespace — which is what keeps its `/proc` entries closed.
        '--unshare-user',
        '--die-with-parent',
        '--new-session',
        '--unshare-pid',
        '--unshare-ipc',
        '--unshare-uts',
    ];
    if (a.network === 'none') {
        args.push('--unshare-net');
    }
    if (a.strict) {
        args.push('--cap-drop', 'ALL');
    }
    if (a.user) {
        args.push('--uid', a.user.uid, '--gid', a.user.gid ?? a.user.uid);
    }

    args.push(
        ...rootArgs(
            a.tree,
            a.binds.map((b) => b.at),
            [...OWN, ...a.hidden],
        ),
    );
    args.push(...hiddenArgs(a.tree, a.hidden));
    args.push('--dev-bind', '/dev', '/dev');
    // The bind is recursive: the container's shared memory would come with it,
    // writable and shared with the server and every other session.
    for (const shared of ['/dev/shm', '/dev/mqueue']) {
        if (a.tree.kind(shared) === 'dir') {
            args.push('--tmpfs', shared);
        }
    }
    args.push(...(a.proc === 'fresh' ? ['--proc', '/proc'] : ['--ro-bind', '/proc', '/proc']));
    if (a.strict || a.tmpBytes) {
        const sizes = [a.strict ? STRICT_TMP_BYTES : 0, a.tmpBytes ?? 0].filter((n) => n > 0);
        args.push('--size', String(Math.min(...sizes)));
    }
    args.push('--tmpfs', '/tmp');
    for (const b of a.binds) {
        args.push(b.readOnly ? '--ro-bind' : '--bind', b.host, b.at);
    }
    args.push(...(a.extra ?? []));
    args.push('--chdir', a.cwd, '--', ...a.command);
    return args;
}

/**
 * The host's root, bound piece by piece: `targets` are mounted later, `omit`
 * is never shown. A directory is opened only for a mount point it lacks;
 * whatever it holds is then bound entry by entry, so this stays rare — under
 * SELinux a bind of something the runtime itself mounted can be refused.
 */
export function rootArgs(
    tree: HostTree,
    targets: readonly string[],
    omit: readonly string[],
): string[] {
    const args: string[] = [];
    const within = (path: string, dir: string): boolean =>
        dir === '/' ? path !== '/' : path.startsWith(`${dir}/`);
    const open = (dir: string): boolean =>
        targets.some((t) => within(t, dir) && tree.kind(t) === 'missing');

    const emit = (dir: string): void => {
        for (const name of tree.list(dir).sort()) {
            const path = dir === '/' ? `/${name}` : `${dir}/${name}`;
            if (omit.includes(path)) {
                continue;
            }
            const kind = tree.kind(path);
            if (kind === 'symlink') {
                args.push('--symlink', tree.link(path), path);
            } else if (kind === 'dir' && open(path)) {
                args.push('--dir', path);
                emit(path);
            } else if (kind !== 'missing') {
                args.push('--ro-bind', path, path);
            }
        }
    };
    emit('/');
    return args;
}

/** What is hidden inside a bound directory is covered: an empty tmpfs, or /dev/null. */
export function hiddenArgs(tree: HostTree, hidden: readonly string[]): string[] {
    const args: string[] = [];
    for (const path of hidden) {
        if (path.split('/').length <= 2 || OWN.some((own) => path.startsWith(`${own}/`))) {
            continue;
        }
        const kind = tree.kind(path);
        if (kind === 'dir') {
            args.push('--tmpfs', path);
        } else if (kind === 'file') {
            args.push('--ro-bind', '/dev/null', path);
        }
    }
    return args;
}

// ---------------------------------------------------------------------------
// Whether bwrap can isolate anything here
//
// Asked once per binary and process. A fresh `/proc` needs the container's own
// to be unmasked (or gVisor); without one, the container's is bound read-only:
// the command still has a pid namespace of its own, and, being in a user
// namespace of its own too, may not read another process's environment or
// memory — it can only see that the processes exist.
// ---------------------------------------------------------------------------

const probes = new Map<string, Promise<BwrapProbe>>();

export function probeBwrap(bwrap?: string, run: Runner = runProcess): Promise<BwrapProbe> {
    const bin = bwrap ?? findBwrap();
    let probe = probes.get(bin);
    if (!probe) {
        probe = probeOnce(bin, run);
        probes.set(bin, probe);
    }
    return probe;
}

async function probeOnce(bwrap: string, run: Runner): Promise<BwrapProbe> {
    // `--unshare-user` as every command has it: without it bwrap run by root (a container's root)
    // takes itself for privileged and fails where an unprivileged namespace would do.
    const base = [
        '--unshare-user',
        '--ro-bind',
        '/',
        '/',
        '--dev-bind',
        '/dev',
        '/dev',
        '--unshare-pid',
    ];
    const attempt = async (proc: string[]): Promise<ProcResult | Error> => {
        try {
            return await run(bwrap, [...base, ...proc, '--', '/bin/sh', '-c', 'exit 0'], {
                timeoutMs: 30_000,
                env: { PATH: DEFAULT_PATH },
            });
        } catch (err) {
            return err instanceof Error ? err : new Error(String(err));
        }
    };
    const fresh = await attempt(['--proc', '/proc']);
    if (!(fresh instanceof Error) && fresh.code === 0) {
        return { ok: true, bwrap, proc: 'fresh' };
    }
    const bound = await attempt(['--ro-bind', '/proc', '/proc']);
    if (!(bound instanceof Error) && bound.code === 0) {
        return { ok: true, bwrap, proc: 'bind' };
    }
    const error =
        bound instanceof Error ? bound.message : firstLine(bound.stderr) || `exit ${bound.code}`;
    return { ok: false, bwrap, error, hint: probeHint(error) };
}

function probeHint(error: string): string {
    if (/not installed|ENOENT/i.test(error)) {
        return `install bubblewrap, or run in the agent image (${ZENERA_BWRAP})`;
    }
    return (
        'bwrap needs unprivileged user namespaces: allowed by the container runtime ' +
        '(seccomp, AppArmor) and the kernel (user.max_user_namespaces, ' +
        'kernel.apparmor_restrict_unprivileged_userns=0); gVisor allows them'
    );
}

function findBwrap(): string {
    if (existsSync(ZENERA_BWRAP)) {
        return ZENERA_BWRAP;
    }
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
        if (dir && existsSync(join(dir, 'bwrap'))) {
            return join(dir, 'bwrap');
        }
    }
    return 'bwrap';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** bwrap's own failures are its exit code 1 and a line of its own; nothing ran. */
function refuseSetupFailure(res: ProcResult): void {
    if (res.code === 1 && res.stdout === '' && /^bwrap: /.test(res.stderr)) {
        throw new SandboxError(`the sandbox could not start the command: ${firstLine(res.stderr)}`);
    }
}

async function readWindow(
    file: string,
    first: number,
    max: number,
): Promise<{ lines: number; window: string[] }> {
    const window: string[] = [];
    let lines = 0;
    if (!existsSync(file)) {
        return { lines, window };
    }
    const input = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of input) {
        lines++;
        if (lines >= first && window.length < max) {
            window.push(line);
        }
    }
    return { lines, window };
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
    try {
        process.kill(-pid, signal);
    } catch {
        // already gone
    }
}

function exitOfSignal(signal: NodeJS.Signals | null): number {
    return signal ? 128 + (constants.signals[signal] ?? 0) : 1;
}

let imageEnvRead: { env?: Record<string, string> } | undefined;

/** The image's own environment, from IMAGE_ENV_FILE; read once. Only string values count. */
function imageEnv(): Record<string, string> | undefined {
    if (!imageEnvRead) {
        imageEnvRead = {};
        try {
            const parsed = JSON.parse(readFileSync(IMAGE_ENV_FILE, 'utf8')) as Record<
                string,
                unknown
            >;
            imageEnvRead.env = Object.fromEntries(
                Object.entries(parsed).filter(
                    (e): e is [string, string] =>
                        typeof e[1] === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(e[0]),
                ),
            );
        } catch {
            // not the agent image
        }
    }
    return imageEnvRead.env;
}

function cgroupNumber(file: string): number | undefined {
    try {
        const value = Number(readFileSync(join(CGROUP, file), 'utf8').trim());
        return Number.isFinite(value) ? value : undefined;
    } catch {
        return undefined;
    }
}

function cgroupLimitMib(): number | undefined {
    const max = cgroupNumber('memory.max');
    return max === undefined ? undefined : Math.round(max / (1024 * 1024));
}

function cgroupKills(): number | undefined {
    try {
        const events = readFileSync(join(CGROUP, 'memory.events'), 'utf8');
        const kills = /^oom_kill (\d+)$/m.exec(events)?.[1];
        return kills === undefined ? undefined : Number(kills);
    } catch {
        return undefined;
    }
}

function firstLine(text: string): string {
    return text.trim().split('\n')[0] ?? '';
}

function depth(path: string): number {
    return path.split('/').length;
}

function jobId(): string {
    return `job-${randomBytes(3).toString('hex')}`;
}

function resolveSpec(opts: SandboxOptions): Resolved {
    const workdir = opts.workdir ?? WORKSPACE_MOUNT;
    if (!posix.isAbsolute(workdir)) {
        throw new SandboxError(`sandbox workdir must be absolute: ${workdir}`);
    }
    for (const name of [...Object.keys(opts.execEnv ?? {}), ...Object.keys(opts.execPaths ?? {})]) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
            throw new SandboxError(`not a variable name: ${JSON.stringify(name)}`);
        }
    }
    const { hardening } = sandboxLimits(opts);
    return {
        root: opts.root,
        key: opts.key,
        image: opts.image ?? DEFAULT_SANDBOX_IMAGE,
        build: opts.build,
        network: opts.network ?? (hardening === 'strict' ? 'none' : 'bridge'),
        workdir,
        timeout: opts.timeout ?? DEFAULT_TIMEOUT_MS / 1000,
        hardening,
        user: parseUser(opts.user),
        env: opts.env ?? {},
        secrets: opts.secrets ?? [],
        readOnly: opts.readOnly ?? false,
        mounts: opts.mounts ?? [],
        execEnv: opts.execEnv ?? {},
        execPaths: opts.execPaths ?? {},
    };
}

/** Numbers only: inside a user namespace a name means nothing the image's passwd says. */
function parseUser(user?: string): { uid: string; gid?: string } | undefined {
    if (!user) {
        return undefined;
    }
    const m = /^(\d+)(?::(\d+))?$/.exec(user);
    if (!m) {
        throw new SandboxError(
            `the bwrap sandbox takes a numeric user (uid or uid:gid), not ${JSON.stringify(user)}`,
        );
    }
    return { uid: m[1], gid: m[2] };
}
