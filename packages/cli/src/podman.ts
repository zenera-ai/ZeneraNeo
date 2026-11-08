/**
 * Host container-engine preflight used by server, sandbox and project setup commands.
 * ensurePodmanReady checks the binary, machine and socket; ensureImage builds/pulls
 * images with terminalProgress or caller-supplied progress, while asCliError surfaces
 * sandbox failures using the CLI's standard error reporting.
 */
import { isBusy, isProjectDir, Registry, sessionIds, sessionsDir } from '@zenera/engine';
import {
    ensurePodmanImage,
    isImageBuildError,
    pidAlive,
    runProcess,
    SandboxError,
    type BuildSpec,
    type PrepareOptions,
    type ProcResult,
} from '@zenera/neo';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { CliError, confirm, dim, EXIT, isInteractive, note, progress } from './term.ts';

// ---------------------------------------------------------------------------
// The pre-flight lifecycle manager
//
// Podman is native on Linux and a background virtual machine everywhere else,
// which means "is the container engine ready" is four questions, not one: is
// the binary installed, does the machine exist, is it running, and is the
// image on disk. Asked late, each of them surfaces as a different opaque
// failure in the middle of a turn the user is already paying for.
//
// So they are asked first, in order, and every one of them that can be fixed
// without a decision is fixed without asking. Installing a package manager's
// worth of software is the one thing that *is* a decision, so it is the one
// thing that prompts — and in a pipeline, where nobody can answer, it fails
// with the exact command to run instead of hanging.
// ---------------------------------------------------------------------------

export interface PodmanOptions {
    /** the image the project needs on disk before the first run */
    image?: string;
    /** a Dockerfile to build into `image`, instead of a registry to pull it from */
    build?: BuildSpec;
    /** build even when the tag is already on disk; `zen sandbox pull` */
    rebuild?: boolean;
    /** machine size, when one has to be created */
    cpus?: number;
    /** MiB */
    memory?: number;
    engine?: string;
    /** never prompt; `--yes`, `--json`, or no terminal */
    yes?: boolean;
    /** so the tests can watch the sequence without a container engine */
    exec?: typeof runProcess;
}

const DEFAULT_MACHINE_CPUS = 2;
const DEFAULT_MACHINE_MEMORY = 2048;
/** Starting a virtual machine is slow on purpose. */
const SLOW_MS = 600_000;

interface Machine {
    Name: string;
    Running: boolean;
    Starting: boolean;
    Default?: boolean;
}

export interface PodmanStatus {
    engine: string;
    installed: boolean;
    version?: string;
    /** absent on Linux, where there is no machine to have */
    machine?: { name: string; running: boolean; starting: boolean };
    /** how this client reaches the engine, and whether one connection carries every call */
    connection?: { uri: string; shared: boolean };
    /** whether `podman info` answered */
    ready: boolean;
    /** what the engine has to hand out: the machine's on macOS and Windows, the host's on Linux */
    capacity?: { memory: number; swap: number; cpus: number };
    /** containers the engine can still create; a stopped one holds a lock too */
    freeLocks?: number;
    image?: string;
    imagePresent?: boolean;
}

// One process asks once. Several agents starting containers in the same run
// must not each decide to boot a virtual machine.
const settled = new Map<string, Promise<void>>();

export async function ensurePodmanReady(opts: PodmanOptions = {}): Promise<void> {
    const key = `${opts.engine ?? 'podman'}::${opts.image ?? ''}`;
    const pending = settled.get(key);
    if (pending) {
        return pending;
    }
    const attempt = preflight(opts).catch((err: unknown) => {
        // A failure is not a settled answer: the user may well go and install
        // the thing we just complained about and try again in the same TUI.
        settled.delete(key);
        throw err;
    });
    settled.set(key, attempt);
    return attempt;
}

async function preflight(opts: PodmanOptions): Promise<void> {
    const engine = opts.engine ?? 'podman';
    const run = opts.exec ?? runProcess;
    const call = async (args: string[], timeoutMs = 60_000): Promise<ProcResult> => {
        try {
            return await run(engine, args, { timeoutMs });
        } catch (err) {
            if (err instanceof SandboxError) {
                return {
                    code: 127,
                    stdout: '',
                    stderr: err.message,
                    truncated: false,
                    timedOut: false,
                };
            }
            throw err;
        }
    };

    // 1. The binary.
    const version = await call([`--version`], 15_000);
    if (version.code !== 0) {
        await install(engine, opts, run);
    }

    // 2. The virtual machine, on the platforms that have one. Linux runs
    //    containers natively and has no machine to list, so asking would fail
    //    with a message about an unknown command rather than about anything
    //    true.
    let shared: string | undefined;
    if (platform() !== 'linux') {
        await machine(engine, call, opts, run);
        shared = await shareConnection(engine, run);
    }

    // 3. The socket. Everything above can be true while the engine is wedged.
    let info = await call(['info'], 60_000);
    if (info.code !== 0 && shared && process.env.CONTAINER_HOST === shared) {
        // The shared endpoint is an optimisation, so it never gets to be the
        // reason a run fails: put the default connection back and ask again.
        delete process.env.CONTAINER_HOST;
        info = await call(['info'], 60_000);
    }
    if (info.code !== 0) {
        throw sandboxError(
            `${engine} is installed but not responding`,
            first(info) || `try: ${engine} machine start`,
        );
    }

    // 4. The image, so the first command is not a five-minute pull that looks
    //    like a hung model.
    if (opts.image) {
        await ensureImage(
            { image: opts.image, build: opts.build },
            { engine, exec: run, force: opts.rebuild },
        );
    }
}

/**
 * How a terminal watches a pull or a build: the sandbox's own lines, dimmed,
 * and a spinner over each slow step.
 */
export function terminalProgress(): Pick<PrepareOptions, 'onProgress' | 'slow'> {
    return { onProgress: (line) => note(dim(line)), slow: ticking };
}

/**
 * The image step on its own, in a terminal's words: what `ensurePodmanReady`
 * ends with, and what `zen init` and `zen sandbox pull` ask for directly. A
 * Dockerfile that does not build is a `BuildError`; everything else the engine
 * says is a sandbox error.
 */
export async function ensureImage(
    target: { image: string; build?: BuildSpec },
    opts: {
        engine?: string;
        exec?: typeof runProcess;
        force?: boolean;
        progress?: Pick<PrepareOptions, 'onProgress' | 'slow'>;
    } = {},
): Promise<void> {
    try {
        await ensurePodmanImage(
            target,
            { engine: opts.engine, exec: opts.exec },
            { ...(opts.progress ?? terminalProgress()), force: opts.force },
        );
    } catch (err) {
        throw asCliError(err);
    }
}

/** A sandbox's failure, as the CLI reports it. */
export function asCliError(err: unknown): unknown {
    if (isImageBuildError(err)) {
        return new BuildError(err.message, EXIT.sandbox, err.hint);
    }
    // By name too, for a sandbox a plugin built against its own copy of the package.
    if (err instanceof SandboxError || (err instanceof Error && err.name === 'SandboxError')) {
        return new CliError(err.message, EXIT.sandbox, (err as SandboxError).hint);
    }
    return err;
}

// ---------------------------------------------------------------------------
// Installing
// ---------------------------------------------------------------------------

async function install(engine: string, opts: PodmanOptions, run: typeof runProcess): Promise<void> {
    if (engine !== 'podman') {
        throw sandboxError(`${engine} is not installed`, `install ${engine} and try again`);
    }

    const how = instructions();
    if (platform() !== 'darwin' || opts.yes || !isInteractive()) {
        throw sandboxError('podman is not installed', how);
    }

    const brew = await run('brew', ['--version'], { timeoutMs: 15_000 }).catch(() => undefined);
    if (!brew || brew.code !== 0) {
        throw sandboxError('podman is not installed', how);
    }
    if (!(await confirm('Podman is not installed. Install it with Homebrew now?', true))) {
        throw sandboxError('podman is not installed', how);
    }

    note(dim('installing podman — this takes a few minutes'));
    const done = await stream('brew', ['install', 'podman'], run, 'installing podman');
    if (done.code !== 0) {
        throw sandboxError('could not install podman', first(done) || how);
    }
}

function instructions(): string {
    switch (platform()) {
        case 'darwin':
            return 'install it with: brew install podman';
        case 'win32':
            return 'install it with: winget install RedHat.Podman';
        default:
            return linuxInstructions();
    }
}

/**
 * How podman gets installed, by distribution — podman.io/docs/installation,
 * which is where any of these should be checked against.
 *
 * "Install it with your package manager" is advice nobody needs and everybody
 * has to translate; the host already says which one it has, so the message may
 * as well be the line to paste. It stops at the line: `sudo` wants a terminal
 * to ask for a password on and `runProcess` gives it a pipe, so running this
 * for the user would hang rather than help.
 */
const LINUX_INSTALL: Record<string, string> = {
    alpine: 'install it with: sudo apk add podman',
    arch: 'install it with: sudo pacman -S podman',
    centos: 'install it with: sudo dnf -y install podman',
    debian: 'install it with: sudo apt-get -y install podman',
    fedora: 'install it with: sudo dnf -y install podman',
    gentoo: 'install it with: sudo emerge app-containers/podman',
    // Nix installs nothing imperatively worth keeping: the podman that works
    // rootless is the one the module turns on.
    nixos: 'enable it with: virtualisation.podman.enable = true; then: sudo nixos-rebuild switch',
    opensuse: 'install it with: sudo zypper install podman',
    rhel: 'install it with: sudo dnf -y install podman',
    sles: 'install it with: sudo zypper install podman',
    suse: 'install it with: sudo zypper install podman',
    ubuntu: 'install it with: sudo apt-get update && sudo apt-get -y install podman',
    void: 'install it with: sudo xbps-install -S podman',
};

function linuxInstructions(): string {
    for (const id of osRelease()) {
        // `opensuse-leap` and `rhel-9` name the same package manager as their
        // family does, so a miss on the whole id is worth one on its stem.
        const how = LINUX_INSTALL[id] ?? LINUX_INSTALL[id.split(/[-.]/)[0] ?? ''];
        if (how) {
            return how;
        }
    }
    return 'install it with your package manager, e.g. apt-get install podman';
}

/**
 * `ID` first, then `ID_LIKE` — the distribution's own name, then the families
 * it claims to behave like, which is how Rocky, Alma and Mint get answered
 * without being listed.
 */
function osRelease(): string[] {
    let text: string;
    try {
        text = readFileSync('/etc/os-release', 'utf8');
    } catch {
        return [];
    }
    const read = (key: string): string[] => {
        const line = new RegExp(`^${key}=(.*)$`, 'm').exec(text)?.[1] ?? '';
        return line
            .trim()
            .replace(/^["']|["']$/g, '')
            .toLowerCase()
            .split(/\s+/)
            .filter(Boolean);
    };
    return [...read('ID'), ...read('ID_LIKE')];
}

// ---------------------------------------------------------------------------
// The machine
// ---------------------------------------------------------------------------

async function machine(
    engine: string,
    call: (args: string[], timeoutMs?: number) => Promise<ProcResult>,
    opts: PodmanOptions,
    run: typeof runProcess,
): Promise<void> {
    const listed = await call(['machine', 'list', '--format', 'json'], 30_000);
    if (listed.code !== 0) {
        throw sandboxError(`${engine} machine list failed`, first(listed));
    }
    const machines = parseMachines(listed.stdout);

    if (machines.length === 0) {
        const cpus = String(opts.cpus ?? DEFAULT_MACHINE_CPUS);
        const memory = String(opts.memory ?? DEFAULT_MACHINE_MEMORY);
        note(dim(`initialising the podman machine (${cpus} cpus, ${memory} MiB) — once per host`));
        const created = await stream(
            engine,
            ['machine', 'init', '--cpus', cpus, '--memory', memory],
            run,
            'initialising the machine',
        );
        if (created.code !== 0) {
            throw sandboxError('could not create the podman machine', first(created));
        }
    }

    const chosen = machines.find((m) => m.Default) ?? machines[0];
    if (machines.length > 0 && chosen?.Running) {
        return;
    }

    // A machine that is already starting is not a machine to start again;
    // `machine start` on one mid-boot is an error, not a no-op.
    const args = ['machine', 'start'];
    if (chosen && !chosen.Starting) {
        args.push(chosen.Name);
    }
    note(dim('starting the podman machine'));
    const started = await stream(engine, args, run, 'starting the machine', SLOW_MS);
    if (started.code !== 0 && !/already running/i.test(started.stderr)) {
        throw sandboxError('could not start the podman machine', first(started));
    }
}

function parseMachines(stdout: string): Machine[] {
    const text = stdout.trim();
    if (!text) {
        return [];
    }
    try {
        const parsed: unknown = JSON.parse(text);
        return Array.isArray(parsed) ? (parsed as Machine[]) : [];
    } catch {
        // A podman that answers `--format json` with something else is a podman
        // we cannot reason about; treating it as "no machines" would try to
        // create a second one.
        throw sandboxError('could not read `podman machine list --format json`');
    }
}

// ---------------------------------------------------------------------------
// How the client reaches the engine
//
// Off Linux the client is remote, and the connection it is given by default is
// `ssh://` into the machine — one fresh ssh connection per `podman` process.
// sshd refuses new ones past `MaxStartups`, ten by default and randomly above
// that, so a batch wider than about ten loses calls on a different task each
// time it runs, for a reason that looks nothing like a connection limit.
//
// The machine already forwards a second endpoint for Docker API clients — a
// unix socket on macOS, a named pipe on Windows — and it is served by one
// long-lived connection that every call shares. Pointing this process at it
// takes the ceiling away rather than raising it, and needs nothing inside the
// machine changed. On Linux there is no machine, no ssh and no ceiling.
// ---------------------------------------------------------------------------

interface Inspected {
    ConnectionInfo?: {
        PodmanSocket?: { Path?: string } | null;
        PodmanPipe?: { Path?: string } | null;
    };
}

interface Connection {
    Name?: string;
    URI?: string;
    Default?: boolean;
}

/**
 * The machine's forwarded endpoint as a URI this client accepts, or nothing
 * when there is no machine to ask.
 */
export async function sharedEndpoint(
    engine = 'podman',
    exec = runProcess,
): Promise<string | undefined> {
    if (platform() === 'linux') {
        return undefined;
    }
    const res = await exec(engine, ['machine', 'inspect'], { timeoutMs: 30_000 }).catch(
        () => undefined,
    );
    if (!res || res.code !== 0) {
        return undefined;
    }
    let raw: unknown;
    try {
        raw = JSON.parse(res.stdout.trim() || '[]');
    } catch {
        return undefined;
    }
    const one = (Array.isArray(raw) ? (raw as Inspected[]) : [])[0];
    // Windows first: a named pipe is the only endpoint there, and `\\.\pipe\x`
    // is spelled `//./pipe/x` in a URI.
    const pipe = one?.ConnectionInfo?.PodmanPipe?.Path;
    if (pipe) {
        return `npipe://${pipe.replaceAll('\\', '/')}`;
    }
    const socket = one?.ConnectionInfo?.PodmanSocket?.Path;
    return socket ? `unix://${socket}` : undefined;
}

/**
 * Points this process at the shared endpoint, and returns what it set so the
 * caller can take it back if the engine then fails to answer.
 *
 * An explicit `CONTAINER_HOST` or `CONTAINER_CONNECTION` is the user's choice
 * about which engine to talk to, which is not ours to overrule for a
 * throughput win.
 */
async function shareConnection(
    engine: string,
    exec: typeof runProcess,
): Promise<string | undefined> {
    if (process.env.CONTAINER_HOST || process.env.CONTAINER_CONNECTION) {
        return undefined;
    }
    const uri = await sharedEndpoint(engine, exec);
    if (uri) {
        process.env.CONTAINER_HOST = uri;
    }
    return uri;
}

/**
 * The connection a run will use, which is what a report about concurrency has
 * to name — not the one that is configured today.
 *
 * `status` deliberately changes nothing, so it does not set `CONTAINER_HOST`
 * the way `ensurePodmanReady` does; it asks the same question in the same
 * order instead, and so answers for the run that has not happened yet. The
 * `ssh://` fallback is therefore the machine where the shared endpoint could
 * not be found, which is exactly the one worth saying so about.
 */
async function connectionOf(
    engine: string,
    exec: typeof runProcess,
): Promise<PodmanStatus['connection']> {
    const held = process.env.CONTAINER_HOST;
    if (held) {
        return { uri: held, shared: !held.startsWith('ssh://') };
    }
    const shared = process.env.CONTAINER_CONNECTION
        ? undefined
        : await sharedEndpoint(engine, exec);
    if (shared) {
        return { uri: shared, shared: true };
    }
    const res = await exec(engine, ['system', 'connection', 'list', '--format', 'json'], {
        timeoutMs: 30_000,
    }).catch(() => undefined);
    if (!res || res.code !== 0) {
        return undefined;
    }
    let raw: unknown;
    try {
        raw = JSON.parse(res.stdout.trim() || '[]');
    } catch {
        return undefined;
    }
    const all = Array.isArray(raw) ? (raw as Connection[]) : [];
    const named = process.env.CONTAINER_CONNECTION;
    const uri =
        (named ? all.find((c) => c.Name === named) : undefined)?.URI ??
        (all.find((c) => c.Default) ?? all[0])?.URI;
    return uri ? { uri, shared: !uri.startsWith('ssh://') } : undefined;
}

// ---------------------------------------------------------------------------
// The image
// ---------------------------------------------------------------------------

/**
 * A build that ran and failed, rather than a host that could not be asked.
 *
 * The difference is invisible at the command line — both stop the run and
 * print why — but it decides everything for `zen check`: a Dockerfile that
 * does not build is a broken project, and a laptop without podman on it is
 * not. Only one of them is an error.
 */
export class BuildError extends CliError {}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** What `zn sandbox status` prints. Changes nothing, and never throws. */
export async function podmanStatus(opts: PodmanOptions = {}): Promise<PodmanStatus> {
    const engine = opts.engine ?? 'podman';
    const run = opts.exec ?? runProcess;
    const call = (args: string[]): Promise<ProcResult | undefined> =>
        run(engine, args, { timeoutMs: 30_000 }).catch(() => undefined);

    const version = await call(['--version']);
    if (!version || version.code !== 0) {
        return { engine, installed: false, ready: false };
    }

    const status: PodmanStatus = {
        engine,
        installed: true,
        version: version.stdout.trim().split(' ').at(-1),
        ready: false,
    };

    if (platform() !== 'linux') {
        const listed = await call(['machine', 'list', '--format', 'json']);
        const machines = listed?.code === 0 ? safeMachines(listed.stdout) : [];
        const chosen = machines.find((m) => m.Default) ?? machines[0];
        if (chosen) {
            status.machine = {
                name: chosen.Name,
                running: Boolean(chosen.Running),
                starting: Boolean(chosen.Starting),
            };
        }
        status.connection = await connectionOf(engine, run);
    }

    // The same `info` answers both questions, and the memory is the one worth
    // printing: off Linux it is the machine's, which is neither the host's nor
    // anything the container limits in agents.yaml were written against.
    const info = await call([
        'info',
        '--format',
        '{{.Host.MemTotal}} {{.Host.SwapTotal}} {{.Host.CPUs}}',
    ]);
    status.ready = info?.code === 0;
    if (info?.code === 0) {
        const [memory, swap, cpus] = info.stdout.trim().split(/\s+/).map(Number);
        if (Number.isFinite(memory) && memory > 0) {
            status.capacity = {
                memory: Math.round(memory / 1048576),
                swap: Number.isFinite(swap) ? Math.round(swap / 1048576) : 0,
                cpus: Number.isFinite(cpus) ? cpus : 0,
            };
        }
        // Asked apart from the line above: an engine without the field fails
        // the whole template, and that must not cost the report its memory.
        status.freeLocks = await freeLocks(engine, run);
    }

    if (opts.image) {
        status.image = opts.image;
        const exists = status.ready ? await call(['image', 'exists', opts.image]) : undefined;
        status.imagePresent = exists?.code === 0;
    }
    return status;
}

function safeMachines(stdout: string): Machine[] {
    try {
        return parseMachines(stdout);
    } catch {
        return [];
    }
}

/** Containers the engine can still create; undefined when it will not say. */
export async function freeLocks(engine = 'podman', exec = runProcess): Promise<number | undefined> {
    const res = await exec(engine, ['info', '--format', '{{.Host.FreeLocks}}'], {
        timeoutMs: 30_000,
    }).catch(() => undefined);
    const free = res?.code === 0 ? res.stdout.trim() : '';
    return /^\d+$/.test(free) ? Number(free) : undefined;
}

export interface LockOptions {
    engine?: string;
    exec?: typeof runProcess;
    /** a container that may already exist, and so needs no new lock */
    reuses?: string;
    /** session id -> its directory; read from the registry when absent */
    owners?: ReadonlyMap<string, string>;
}

/**
 * Refuses a run the engine cannot hold before anything is spent on it. Every
 * container takes a lock, stopped ones included, and at zero the failure would
 * otherwise land on the first shell command — mid-turn, or once per item.
 */
export async function assertLocks(need: number, opts: LockOptions = {}): Promise<void> {
    const engine = opts.engine ?? 'podman';
    const exec = opts.exec ?? runProcess;
    const free = await freeLocks(engine, exec);
    if (free === undefined || free >= need) {
        return;
    }
    if (opts.reuses) {
        const there = await exec(engine, ['container', 'exists', opts.reuses], {
            timeoutMs: 30_000,
        }).catch(() => undefined);
        if (there?.code === 0) {
            return;
        }
    }
    const idle = idleContainers(
        await ownedContainers(engine, exec),
        opts.owners ?? (await sessionOwners()),
    ).length;
    throw new CliError(
        `the container engine has ${free} locks free and this run needs ${need} — ` +
            'every container holds one, stopped ones included',
        EXIT.sandbox,
        idle > 0
            ? `zen sandbox clean --idle frees ${idle}`
            : `every container zen made is in use — \`${engine} ps --all\` shows what holds them`,
    );
}

/** Every session on this machine, by id, from the projects the registry knows. */
export async function sessionOwners(): Promise<Map<string, string>> {
    const owners = new Map<string, string>();
    for (const entry of (await Registry.open()).entries) {
        if (isProjectDir(entry.path)) {
            for (const id of sessionIds(entry.path)) {
                owners.set(id, join(sessionsDir(entry.path), id));
            }
        }
    }
    return owners;
}

/**
 * Containers no live process is using: every stopped one, and a running one
 * whose run exited without tearing it down (a kill, a crash, a closed lid).
 * A running container that cannot be traced to its owner is left alone.
 */
export function idleContainers(
    containers: readonly OwnedContainer[],
    owners: ReadonlyMap<string, string>,
): OwnedContainer[] {
    return containers.filter((c) => {
        if (c.state !== 'running') {
            return true;
        }
        const gym = /^gym-(\d+)$/.exec(c.key ?? '');
        if (gym) {
            return !pidAlive(Number(gym[1]));
        }
        const dir = c.key === undefined ? undefined : owners.get(c.key);
        return dir !== undefined && !isBusy(dir);
    });
}

export interface OwnedContainer {
    name: string;
    /** podman's own word: `running`, `exited`, `created`, `paused` */
    state: string;
    /** the session that owns it, from the `zenera.key` label */
    key?: string;
    createdAt?: string;
    /** bytes written on top of the image; only present when `sizes` is asked for */
    size?: number;
}

interface PsEntry {
    Names?: string[];
    State?: string;
    Created?: number;
    Labels?: Record<string, string>;
    Size?: { rwSize?: number };
}

/**
 * `ps --format json` is ~1 kB a container, so the runner's default 64 kB cap cut
 * the listing at about sixty, the JSON stopped parsing, and every report said
 * "none" while two thousand sat on the machine.
 */
const LISTING_BYTES = 64 * 1024 * 1024;

/**
 * Containers this CLI created, whatever session they belong to, and whether
 * each is up. `--all` is the point: with `persist: true` a session leaves a
 * *stopped* container behind, and a listing that only showed running ones
 * would say nothing is there while the disk says otherwise.
 */
export async function ownedContainers(
    engine = 'podman',
    exec = runProcess,
    opts: { sizes?: boolean } = {},
): Promise<OwnedContainer[]> {
    const args = ['ps', '--all', '--filter', 'label=zenera=1', '--format', 'json'];
    // Asked for by name only: podman works a size out by diffing the layer,
    // which costs more than everything else `status` does put together.
    if (opts.sizes) {
        args.push('--size');
    }
    const res = await exec(engine, args, { timeoutMs: 120_000, maxBytes: LISTING_BYTES }).catch(
        () => undefined,
    );
    if (!res || res.code !== 0) {
        return [];
    }
    return parseContainers(res.stdout);
}

/** Newest first, which is the order someone reading a list of them wants. */
function parseContainers(stdout: string): OwnedContainer[] {
    let raw: unknown;
    try {
        raw = JSON.parse(stdout.trim() || '[]');
    } catch {
        return [];
    }
    if (!Array.isArray(raw)) {
        return [];
    }
    return (raw as PsEntry[])
        .map((c) => ({
            name: c.Names?.[0] ?? '',
            state: c.State?.trim() || 'unknown',
            key: c.Labels?.['zenera.key'],
            createdAt: c.Created ? new Date(c.Created * 1000).toISOString() : undefined,
            size: c.Size?.rwSize,
        }))
        .filter((c) => c.name)
        .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
}

export async function removeContainers(
    names: readonly string[],
    engine = 'podman',
    exec = runProcess,
): Promise<void> {
    if (names.length === 0) {
        return;
    }
    // In slices, so two thousand of them get a timeout each slice can meet.
    for (let i = 0; i < names.length; i += REMOVE_SLICE) {
        await exec(engine, ['rm', '--force', '--volumes', ...names.slice(i, i + REMOVE_SLICE)], {
            timeoutMs: 120_000,
        });
    }
}

const REMOVE_SLICE = 100;

// ---------------------------------------------------------------------------
// Disk
//
// Two disks, and confusing them is the whole difficulty. Images and container
// layers live inside the machine's disk image; everything a session writes
// lives in the project directory, on the host. On macOS both end up in the
// same SSD, but only one of them is reclaimed by removing a container.
// ---------------------------------------------------------------------------

export interface DiskLine {
    count: number;
    active: number;
    size: number;
    reclaimable: number;
}

export interface EngineDisk {
    images: DiskLine;
    containers: DiskLine;
    volumes: DiskLine;
    /** the filesystem images and layers are kept on — inside the machine, if there is one */
    store?: { used: number; capacity: number };
    /** the machine's disk image, as it costs this host; absent on Linux */
    image?: { name: string; path: string; allocated: number };
}

interface DfEntry {
    Type?: string;
    TotalCount?: number;
    Total?: number;
    Active?: number;
    RawSize?: number;
    RawReclaimable?: number;
}

/** What the engine is using. Never throws: a disk report is not worth a crash. */
export async function engineDisk(
    engine = 'podman',
    exec = runProcess,
): Promise<EngineDisk | undefined> {
    const call = (args: string[]): Promise<ProcResult | undefined> =>
        exec(engine, args, { timeoutMs: 120_000 }).catch(() => undefined);

    const res = await call(['system', 'df', '--format', 'json']);
    if (!res || res.code !== 0) {
        return undefined;
    }
    let raw: unknown;
    try {
        raw = JSON.parse(res.stdout.trim() || '[]');
    } catch {
        return undefined;
    }
    const rows = Array.isArray(raw) ? (raw as DfEntry[]) : [];
    const pick = (type: string): DiskLine => {
        const row = rows.find((r) => r.Type === type);
        return {
            count: row?.TotalCount ?? row?.Total ?? 0,
            active: row?.Active ?? 0,
            size: row?.RawSize ?? 0,
            reclaimable: row?.RawReclaimable ?? 0,
        };
    };

    const info = await call([
        'info',
        '--format',
        '{{.Store.GraphRootUsed}}\t{{.Store.GraphRootAllocated}}',
    ]);
    const [used, capacity] = (info?.code === 0 ? info.stdout.trim() : '').split('\t').map(Number);

    return {
        images: pick('Images'),
        containers: pick('Containers'),
        volumes: pick('Local Volumes'),
        store: used > 0 && capacity > 0 ? { used, capacity } : undefined,
        image: platform() === 'linux' ? undefined : await machineImage(engine, exec),
    };
}

/**
 * What the machine costs the host, which is not what it says it costs: the
 * disk image is created sparse at its full size, so only its allocated blocks
 * are real, and blocks freed inside the machine are not handed back until
 * something trims them. That is why this can exceed the machine's own `used`.
 *
 * The path is not something podman will tell us — `machine inspect` stopped
 * carrying it — so this is the documented default location and nothing is
 * reported when the file is not there.
 */
async function machineImage(engine: string, exec: typeof runProcess): Promise<EngineDisk['image']> {
    const listed = await exec(engine, ['machine', 'list', '--format', 'json'], {
        timeoutMs: 30_000,
    }).catch(() => undefined);
    if (!listed || listed.code !== 0) {
        return undefined;
    }
    const machines = safeMachines(listed.stdout);
    const name = (machines.find((m) => m.Default) ?? machines[0])?.Name;
    if (!name) {
        return undefined;
    }

    const base = join(
        process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'),
        'containers',
        'podman',
        'machine',
    );
    for (const provider of children(base)) {
        for (const file of children(join(base, provider))) {
            if (!file.startsWith(name) || !/\.(raw|qcow2|img)$/.test(file)) {
                continue;
            }
            const path = join(base, provider, file);
            try {
                return { name, path, allocated: statSync(path).blocks * 512 };
            } catch {
                return undefined;
            }
        }
    }
    return undefined;
}

function children(dir: string): string[] {
    try {
        return readdirSync(dir);
    } catch {
        return [];
    }
}

// ---------------------------------------------------------------------------

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
const FRAME_MS = 100;

/**
 * Long steps print as they go. A five-minute pull with no output is
 * indistinguishable from a hang, and the one thing worse than waiting is not
 * knowing whether you are waiting.
 *
 * The engine's own output is buffered until it exits, so while the step runs
 * the only honest thing to show is that it is still running: a spinner and a
 * clock, both of which have to move without any event to move them. Off
 * without a terminal — a CI log wants one line per fact, not ten a second.
 */
async function stream(
    bin: string,
    args: string[],
    run: typeof runProcess,
    label: string,
    timeoutMs = SLOW_MS,
): Promise<ProcResult> {
    const res = await ticking(label, run(bin, args, { timeoutMs }));
    for (const line of res.stderr.split('\n').slice(-3)) {
        if (line.trim()) {
            note(dim(`  ${line.trim()}`));
        }
    }
    return res;
}

async function ticking<T>(label: string, work: Promise<T>): Promise<T> {
    if (!process.stderr.isTTY) {
        return work;
    }
    const bar = progress();
    const startedAt = Date.now();
    let frame = 0;
    const timer = setInterval(() => {
        const spin = SPINNER[frame++ % SPINNER.length] as string;
        bar.update(dim(`  ${spin} ${label}  ${elapsed(Date.now() - startedAt)}`));
    }, FRAME_MS);
    timer.unref();
    try {
        return await work;
    } finally {
        clearInterval(timer);
        bar.done();
    }
}

function elapsed(ms: number): string {
    const total = Math.floor(ms / 1000);
    const seconds = total % 60;
    return total < 60
        ? `${seconds}s`
        : `${Math.floor(total / 60)}m ${String(seconds).padStart(2, '0')}s`;
}

function first(res: ProcResult): string {
    return (res.stderr.trim() || res.stdout.trim()).split('\n')[0] ?? '';
}

function sandboxError(message: string, hint?: string): CliError {
    return new CliError(message, EXIT.sandbox, hint);
}
