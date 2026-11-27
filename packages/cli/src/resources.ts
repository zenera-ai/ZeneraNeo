import stringWidth from 'string-width';
import { isProjectDir, Registry, sessionIds, sessionsDir } from '@zenera/engine';
import { runProcess } from '@zenera/neo';
import { cpus as hostCpus, platform as hostPlatform, totalmem } from 'node:os';
import { basename, join } from 'node:path';
import { idleContainers, ownedContainers, type OwnedContainer } from './podman.ts';
import { ago, bytes } from './term.ts';
import { clipColumns, padEndCols, padStartCols, wrap } from './tui/wrap.ts';

// ---------------------------------------------------------------------------
// Where the memory and the cpu go — `zen sandbox top`
//
// Three layers, each with its own idea of "used", and the confusion is always
// between them:
//
//   1. this computer — off Linux, one process holds the whole Linux machine,
//      and the figure Activity Monitor shows for it is memory the machine has
//      *touched*, which only grows;
//   2. the machine — Linux's own accounting: in use, cache, free;
//   3. the containers — what each one's programs hold right now, against the
//      cap `sandbox.memory` put on it.
//
// A sample reads all three; a view puts two samples side by side, because a
// cpu figure is only meaningful over an interval. Layout is one function that
// both the one-shot report and the live screen draw, so they cannot disagree.
// ---------------------------------------------------------------------------

type Exec = typeof runProcess;

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
/** Process ids, footprints and container names are all short; a listing of many is not. */
const LISTING_BYTES = 16 * MIB;
/** How long a project-to-session map is trusted before the registry is read again. */
const OWNERS_TTL_MS = 30_000;
/** A helper started this close to the hypervisor belongs to the same machine. */
const SAME_START_S = 120;

/** What starts the machine, by executable name. */
const HYPERVISORS = new Set(['vfkit', 'krunkit', 'qemu-system-aarch64', 'qemu-system-x86_64']);
/** macOS runs a vfkit machine's memory in this XPC service, not in vfkit. */
const APPLE_VM = 'com.apple.Virtualization.VirtualMachine';
const NETWORK = new Set(['gvproxy']);

// ---------------------------------------------------------------------------
// A sample
// ---------------------------------------------------------------------------

export interface HostProcess {
    pid: number;
    /** `vm` holds the machine's memory; the others run beside it */
    role: 'vm' | 'hypervisor' | 'network';
    name: string;
    /** in RAM this moment */
    rss: number;
    /** macOS: what Activity Monitor's Memory column shows — RAM, compressed and swapped */
    footprint?: number;
    peak?: number;
    /** cumulative, since it started */
    cpuSeconds: number;
}

export interface GuestMemory {
    total: number;
    free: number;
    available: number;
    swapTotal: number;
    swapFree: number;
    cpus: number;
}

export interface ContainerStat {
    id: string;
    name: string;
    cpuNano: number;
    /** wall clock of the reading, in nanoseconds */
    systemNano: number;
    /** percent of one core, averaged over the container's whole life */
    avgCpu: number;
    memory: number;
    limit: number;
    pids: number;
    netIn: number;
    netOut: number;
    blockIn: number;
    blockOut: number;
}

export interface Sample {
    at: number;
    platform: NodeJS.Platform;
    engine: string;
    ready: boolean;
    machine?: string;
    host: { memory: number; cpus: number; processes: HostProcess[] };
    guest?: GuestMemory;
    stats: ContainerStat[];
    owned: OwnedContainer[];
    /** running containers whose zen run is gone */
    orphans: string[];
    /** session id -> project name */
    projects: ReadonlyMap<string, string>;
    problems: string[];
}

// ---------------------------------------------------------------------------
// A view: two samples read together
// ---------------------------------------------------------------------------

export interface ProcessView {
    pid: number;
    role: HostProcess['role'];
    name: string;
    /** the footprint where there is one, else what is in RAM */
    memory: number;
    rss: number;
    footprint?: number;
    peak?: number;
    /** percent of one core over the interval; absent on the first sample */
    cpu?: number;
}

export interface MachineView {
    name?: string;
    total: number;
    /** held by programs: total minus available */
    used: number;
    /** page cache and other memory Linux gives back on demand */
    cache: number;
    free: number;
    available: number;
    swapTotal: number;
    swapUsed: number;
    cpus: number;
    /**
     * macOS counts this much for the machine beyond what anything inside uses,
     * cache included: memory used once, freed inside, and never handed back.
     */
    held?: number;
}

export interface ContainerView {
    name: string;
    id: string;
    kind: 'zen' | 'gym' | 'other';
    project?: string;
    orphaned: boolean;
    /** percent of one core */
    cpu: number;
    /** whether `cpu` is over the last interval or the container's whole life */
    cpuOver: 'interval' | 'lifetime';
    memory: number;
    /** absent when the container may use the whole machine */
    limit?: number;
    pids: number;
    netIn: number;
    netOut: number;
    blockIn: number;
    blockOut: number;
    createdAt?: string;
}

export interface ResourceView {
    at: string;
    /** seconds between the two samples the cpu figures are taken over */
    interval?: number;
    platform: NodeJS.Platform;
    engine: string;
    ready: boolean;
    host: { memory: number; cpus: number; vm?: ProcessView; helpers: ProcessView[] };
    machine?: MachineView;
    containers: ContainerView[];
    /** containers that exist but are not running, which cost disk and no memory */
    stopped: number;
    totals: {
        running: number;
        zen: number;
        gym: number;
        other: number;
        orphaned: number;
        memory: number;
        cpu: number;
    };
    hints: string[];
    problems: string[];
}

export interface SamplerOptions {
    engine?: string;
    exec?: Exec;
    /** so the tests can be macOS on Linux and the other way round */
    platform?: NodeJS.Platform;
    /** session id -> {dir, project}; read from the registry when absent */
    owners?: () => Promise<Owners>;
    now?: () => number;
}

export interface Owners {
    dirs: ReadonlyMap<string, string>;
    names: ReadonlyMap<string, string>;
}

/** Reads one sample at a time and remembers the last, so each view has an interval. */
export class ResourceSampler {
    readonly engine: string;
    readonly #exec: Exec;
    readonly #platform: NodeJS.Platform;
    readonly #owners: () => Promise<Owners>;
    readonly #now: () => number;
    #previous?: Sample;
    #machine?: Promise<string | undefined>;
    #cached?: { at: number; owners: Owners };

    constructor(opts: SamplerOptions = {}) {
        this.engine = opts.engine ?? 'podman';
        this.#exec = opts.exec ?? runProcess;
        this.#platform = opts.platform ?? hostPlatform();
        this.#owners = opts.owners ?? registryOwners;
        this.#now = opts.now ?? Date.now;
    }

    async next(): Promise<ResourceView> {
        const sample = await this.sample();
        const view = viewOf(sample, this.#previous);
        this.#previous = sample;
        return view;
    }

    async sample(): Promise<Sample> {
        const at = this.#now();
        const problems: string[] = [];
        const native = this.#platform === 'linux';
        const [guest, stats, owned, processes, machine, owners] = await Promise.all([
            guestMemory(this.engine, this.#exec),
            containerStats(this.engine, this.#exec),
            ownedContainers(this.engine, this.#exec),
            this.#platform === 'darwin' ? hostProcesses(this.#exec) : Promise.resolve([]),
            native ? Promise.resolve(undefined) : this.#machineName(),
            this.#ownersCached(at),
        ]);
        if (!guest) {
            problems.push(
                native
                    ? `${this.engine} did not answer — is it installed? zen sandbox up`
                    : `${this.engine} did not answer — is the machine running? zen sandbox up`,
            );
        }
        if (stats === undefined && owned.some((c) => c.state === 'running')) {
            problems.push(`${this.engine} stats did not answer, so no container figures`);
        }
        const orphans = idleContainers(owned, owners.dirs)
            .filter((c) => c.state === 'running')
            .map((c) => c.name);
        return {
            at,
            platform: this.#platform,
            engine: this.engine,
            ready: guest !== undefined,
            machine,
            host: { memory: totalmem(), cpus: hostCpus().length, processes },
            guest,
            stats: stats ?? [],
            owned,
            orphans,
            projects: owners.names,
            problems,
        };
    }

    #machineName(): Promise<string | undefined> {
        this.#machine ??= this.#exec(this.engine, ['machine', 'list', '--format', 'json'], {
            timeoutMs: 30_000,
        })
            .then((res) => {
                if (res.code !== 0) {
                    return undefined;
                }
                const all = JSON.parse(res.stdout.trim() || '[]') as {
                    Name?: string;
                    Default?: boolean;
                }[];
                return (all.find((m) => m.Default) ?? all[0])?.Name;
            })
            .catch(() => undefined);
        return this.#machine;
    }

    async #ownersCached(at: number): Promise<Owners> {
        if (this.#cached && at - this.#cached.at < OWNERS_TTL_MS) {
            return this.#cached.owners;
        }
        const owners = await this.#owners().catch(() => ({
            dirs: new Map<string, string>(),
            names: new Map<string, string>(),
        }));
        this.#cached = { at, owners };
        return owners;
    }
}

/** Every session on this machine, by id: where it lives and which project it is in. */
export async function registryOwners(): Promise<Owners> {
    const dirs = new Map<string, string>();
    const names = new Map<string, string>();
    for (const entry of (await Registry.open()).entries) {
        if (isProjectDir(entry.path)) {
            for (const id of sessionIds(entry.path)) {
                dirs.set(id, join(sessionsDir(entry.path), id));
                names.set(id, entry.name);
            }
        }
    }
    return { dirs, names };
}

// ---------------------------------------------------------------------------
// Reading each layer
// ---------------------------------------------------------------------------

async function guestMemory(engine: string, exec: Exec): Promise<GuestMemory | undefined> {
    const res = await exec(engine, ['info', '--format', 'json'], { timeoutMs: 30_000 }).catch(
        () => undefined,
    );
    if (!res || res.code !== 0) {
        return undefined;
    }
    return parseInfo(res.stdout);
}

export function parseInfo(stdout: string): GuestMemory | undefined {
    let host: Record<string, unknown> | undefined;
    try {
        host = (JSON.parse(stdout) as { host?: Record<string, unknown> }).host;
    } catch {
        return undefined;
    }
    const num = (key: string): number => {
        const v = host?.[key];
        return typeof v === 'number' && Number.isFinite(v) ? v : 0;
    };
    const total = num('memTotal');
    if (total <= 0) {
        return undefined;
    }
    const free = num('memFree');
    // An older podman reports no `memAvailable`; free alone undercounts, but
    // it never claims room that is not there.
    const available = num('memAvailable') || free;
    return {
        total,
        free,
        available,
        swapTotal: num('swapTotal'),
        swapFree: num('swapFree'),
        cpus: num('cpus'),
    };
}

/**
 * Every running container, not only zen's: what the machine is short of is
 * shared by everything in it, and an unlabelled container eats from the same
 * memory a session needs. The raw `ContainerStats` rather than podman's own
 * columns, which are strings like `2.5MB / 4.3GB` rounded for a person.
 */
async function containerStats(engine: string, exec: Exec): Promise<ContainerStat[] | undefined> {
    const res = await exec(
        engine,
        ['stats', '--no-stream', '--no-reset', '--format', '{{json .ContainerStats}}'],
        { timeoutMs: 30_000, maxBytes: LISTING_BYTES },
    ).catch(() => undefined);
    if (!res || res.code !== 0) {
        return undefined;
    }
    return parseStats(res.stdout);
}

interface RawStats {
    ContainerID?: string;
    Name?: string;
    CPUNano?: number;
    SystemNano?: number;
    AvgCPU?: number;
    CPU?: number;
    MemUsage?: number;
    MemLimit?: number;
    PIDs?: number;
    BlockInput?: number;
    BlockOutput?: number;
    Network?: Record<string, { RxBytes?: number; TxBytes?: number }> | null;
}

export function parseStats(stdout: string): ContainerStat[] {
    const out: ContainerStat[] = [];
    for (const line of stdout.split('\n')) {
        const text = line.trim();
        if (!text.startsWith('{')) {
            continue;
        }
        let raw: RawStats;
        try {
            raw = JSON.parse(text) as RawStats;
        } catch {
            continue;
        }
        if (!raw.Name) {
            continue;
        }
        const nets = Object.values(raw.Network ?? {});
        out.push({
            id: (raw.ContainerID ?? '').slice(0, 12),
            name: raw.Name,
            cpuNano: raw.CPUNano ?? 0,
            systemNano: raw.SystemNano ?? 0,
            avgCpu: raw.AvgCPU ?? raw.CPU ?? 0,
            memory: raw.MemUsage ?? 0,
            limit: raw.MemLimit ?? 0,
            pids: raw.PIDs ?? 0,
            netIn: nets.reduce((n, i) => n + (i.RxBytes ?? 0), 0),
            netOut: nets.reduce((n, i) => n + (i.TxBytes ?? 0), 0),
            blockIn: raw.BlockInput ?? 0,
            blockOut: raw.BlockOutput ?? 0,
        });
    }
    return out;
}

/**
 * The processes on this Mac that make up the machine. `ps` says how much cpu
 * each has burned and what is in RAM; `footprint` says what Activity Monitor
 * says, which is the number people come here about — it counts the pages
 * macOS compressed or swapped too, and for a virtual machine that is nearly
 * all of it.
 */
async function hostProcesses(exec: Exec): Promise<HostProcess[]> {
    const res = await exec('ps', ['-axww', '-o', 'pid=,rss=,time=,etime=,comm='], {
        timeoutMs: 10_000,
        maxBytes: LISTING_BYTES,
    }).catch(() => undefined);
    if (!res || res.code !== 0) {
        return [];
    }
    const found = machineProcesses(parsePs(res.stdout));
    if (found.length === 0) {
        return found;
    }
    const args = ['-f', 'bytes', '--noCategories', ...found.flatMap((p) => ['-p', String(p.pid)])];
    const fp = await exec('footprint', args, { timeoutMs: 10_000 }).catch(() => undefined);
    const sizes = fp && fp.code === 0 ? parseFootprint(fp.stdout) : new Map();
    return found.map((p) => {
        const size = sizes.get(p.pid);
        return size ? { ...p, footprint: size.footprint, peak: size.peak } : p;
    });
}

interface PsRow {
    pid: number;
    rss: number;
    cpuSeconds: number;
    ageSeconds: number;
    command: string;
}

export function parsePs(stdout: string): PsRow[] {
    const rows: PsRow[] = [];
    for (const line of stdout.split('\n')) {
        const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
        if (!m) {
            continue;
        }
        rows.push({
            pid: Number(m[1]),
            rss: Number(m[2]) * 1024,
            cpuSeconds: clock(m[3]!),
            ageSeconds: clock(m[4]!),
            command: m[5]!,
        });
    }
    return rows;
}

/** `[[dd-]hh:]mm:ss[.cc]` — how `ps` prints both cpu time and elapsed time. */
export function clock(text: string): number {
    const [days, rest] = text.includes('-') ? text.split('-', 2) : ['0', text];
    const parts = (rest ?? '').split(':').map(Number).reverse();
    if (parts.some((n) => !Number.isFinite(n))) {
        return 0;
    }
    const [s = 0, m = 0, h = 0] = parts;
    return Number(days) * 86400 + h * 3600 + m * 60 + s;
}

/**
 * Picks the machine out of every process on the host. A Mac can run more than
 * one virtual machine through the same framework, so the Apple service and
 * the network helper are matched to the hypervisor by when they started.
 */
export function machineProcesses(rows: readonly PsRow[]): HostProcess[] {
    const named = (row: PsRow): string => basename(row.command);
    const near = (a: PsRow, b: PsRow): boolean =>
        Math.abs(a.ageSeconds - b.ageSeconds) <= SAME_START_S;
    const closest = (pool: readonly PsRow[], to: PsRow): PsRow | undefined =>
        pool
            .filter((r) => near(r, to))
            .sort(
                (a, b) =>
                    Math.abs(a.ageSeconds - to.ageSeconds) - Math.abs(b.ageSeconds - to.ageSeconds),
            )[0];

    const out: HostProcess[] = [];
    const apple = rows.filter((r) => named(r) === APPLE_VM);
    const helpers = rows.filter((r) => NETWORK.has(named(r)));
    for (const hv of rows.filter((r) => HYPERVISORS.has(named(r)))) {
        const name = named(hv);
        const vm = name === 'vfkit' ? closest(apple, hv) : undefined;
        const as = (row: PsRow, role: HostProcess['role'], label: string): HostProcess => ({
            pid: row.pid,
            role,
            name: label,
            rss: row.rss,
            cpuSeconds: row.cpuSeconds,
        });
        if (vm) {
            out.push(as(vm, 'vm', `Virtual Machine Service for ${name}`));
            out.push(as(hv, 'hypervisor', name));
        } else {
            // krunkit and qemu hold the guest's memory in their own process.
            out.push(as(hv, 'vm', name));
        }
        const net = closest(helpers, hv);
        if (net) {
            out.push(as(net, 'network', named(net)));
        }
    }
    return out;
}

/** `footprint -f bytes` output: one block per process. */
export function parseFootprint(stdout: string): Map<number, { footprint: number; peak?: number }> {
    const out = new Map<number, { footprint: number; peak?: number }>();
    let pid: number | undefined;
    for (const line of stdout.split('\n')) {
        const head = /\[(\d+)\]:.*Footprint:\s*(\d+)\s*B/.exec(line);
        if (head) {
            pid = Number(head[1]);
            out.set(pid, { footprint: Number(head[2]) });
            continue;
        }
        const entry = pid === undefined ? undefined : out.get(pid);
        const exact = /^\s*phys_footprint:\s*(\d+)\s*B/.exec(line);
        if (entry && exact) {
            entry.footprint = Number(exact[1]);
        }
        const peak = /^\s*phys_footprint_peak:\s*(\d+)\s*B/.exec(line);
        if (entry && peak) {
            entry.peak = Number(peak[1]);
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// From samples to a view
// ---------------------------------------------------------------------------

export function viewOf(now: Sample, before?: Sample): ResourceView {
    const seconds = before ? (now.at - before.at) / 1000 : undefined;

    const processes = now.host.processes.map((p): ProcessView => {
        const prior = before?.host.processes.find((q) => q.pid === p.pid);
        const cpu =
            prior && seconds && seconds > 0
                ? Math.max(0, ((p.cpuSeconds - prior.cpuSeconds) / seconds) * 100)
                : undefined;
        return {
            pid: p.pid,
            role: p.role,
            name: p.name,
            memory: p.footprint ?? p.rss,
            rss: p.rss,
            footprint: p.footprint,
            peak: p.peak,
            cpu,
        };
    });
    const vm = processes.find((p) => p.role === 'vm');

    const machine = now.guest ? machineOf(now.guest, now.machine, vm) : undefined;

    const owned = new Map(now.owned.map((c) => [c.name, c]));
    const orphans = new Set(now.orphans);
    const containers = now.stats.map((s): ContainerView => {
        const own = owned.get(s.name);
        const prior = before?.stats.find((p) => p.id === s.id);
        const span = prior ? s.systemNano - prior.systemNano : 0;
        const measured = prior !== undefined && span > 0;
        const kind = !own ? 'other' : own.key?.startsWith('gym-') ? 'gym' : 'zen';
        return {
            name: s.name,
            id: s.id,
            kind,
            project: own?.key ? now.projects.get(own.key) : undefined,
            orphaned: orphans.has(s.name),
            cpu: measured ? Math.max(0, ((s.cpuNano - prior.cpuNano) / span) * 100) : s.avgCpu,
            cpuOver: measured ? 'interval' : 'lifetime',
            memory: s.memory,
            // A container with no cap reports the whole machine as its limit.
            limit:
                s.limit > 0 && (!now.guest || s.limit < now.guest.total * 0.99)
                    ? s.limit
                    : undefined,
            pids: s.pids,
            netIn: s.netIn,
            netOut: s.netOut,
            blockIn: s.blockIn,
            blockOut: s.blockOut,
            createdAt: own?.createdAt,
        };
    });
    const running = new Set(containers.map((c) => c.name));

    const view: ResourceView = {
        at: new Date(now.at).toISOString(),
        interval: seconds,
        platform: now.platform,
        engine: now.engine,
        ready: now.ready,
        host: {
            memory: now.host.memory,
            cpus: now.host.cpus,
            vm,
            helpers: processes.filter((p) => p !== vm),
        },
        machine,
        containers,
        stopped: now.owned.filter((c) => !running.has(c.name) && c.state !== 'running').length,
        totals: {
            running: containers.length,
            zen: containers.filter((c) => c.kind === 'zen').length,
            gym: containers.filter((c) => c.kind === 'gym').length,
            other: containers.filter((c) => c.kind === 'other').length,
            orphaned: containers.filter((c) => c.orphaned).length,
            memory: containers.reduce((n, c) => n + c.memory, 0),
            cpu: containers.reduce((n, c) => n + c.cpu, 0),
        },
        hints: [],
        problems: [...now.problems],
    };
    view.hints = hintsOf(view);
    return view;
}

function machineOf(g: GuestMemory, name: string | undefined, vm?: ProcessView): MachineView {
    const used = Math.max(0, g.total - g.available);
    const cache = Math.max(0, g.available - g.free);
    const touched = g.total - g.free;
    const held = vm?.footprint !== undefined ? Math.max(0, vm.footprint - touched) : undefined;
    return {
        name,
        total: g.total,
        used,
        cache,
        free: g.free,
        available: g.available,
        swapTotal: g.swapTotal,
        swapUsed: Math.max(0, g.swapTotal - g.swapFree),
        cpus: g.cpus,
        held,
    };
}

/** What a person can do about what the view shows, most useful first. */
function hintsOf(v: ResourceView): string[] {
    const out: string[] = [];
    const m = v.machine;
    const vm = v.host.vm;

    const lost = v.containers.filter((c) => c.orphaned);
    if (lost.length > 0) {
        out.push(
            `${lost.length === 1 ? '1 container is' : `${lost.length} containers are`} still running ` +
                `for zen runs that are gone, holding ${bytes(lost.reduce((n, c) => n + c.memory, 0))}. ` +
                'Remove them with: zen sandbox clean --idle',
        );
    }
    if (m && m.available < m.total * 0.15) {
        out.push(
            `The machine is nearly out of memory: ${bytes(m.available)} left of ${bytes(m.total)}. ` +
                'Commands may be killed with exit 137. Stop what you do not need, or give the machine more memory.',
        );
    }
    for (const c of v.containers) {
        if (c.limit && c.memory > c.limit * 0.9) {
            out.push(
                `${c.name} is using ${pct((c.memory / c.limit) * 100)} of its own limit (${bytes(c.limit)}). ` +
                    'Its next big command may be killed with exit 137; raise `sandbox.memory` in agents.yaml.',
            );
        }
    }
    if (m && m.swapUsed > 64 * MIB) {
        out.push(
            `The machine has moved ${bytes(m.swapUsed)} to disk (swap): it ran out of RAM at some point, ` +
                'which slows everything inside it down.',
        );
    }
    if (vm && m && vm.memory - m.used > GIB && vm.memory > m.used * 2) {
        out.push(
            `macOS counts ${bytes(vm.memory)} for the machine, but programs inside use only ${bytes(m.used)}. ` +
                'The rest is cache and memory used earlier that Linux does not hand back to macOS. ' +
                'To get it back now: podman machine stop && podman machine start ' +
                '(cuts off any command running in a session).',
        );
    }
    if (vm && m && m.total > v.host.memory * 0.5) {
        out.push(
            `The machine may grow to ${bytes(m.total)}, ${pct((m.total / v.host.memory) * 100)} of this computer's memory. ` +
                'To cap it lower: podman machine stop; podman machine set --memory 8192; podman machine start',
        );
    }
    return out;
}

// ---------------------------------------------------------------------------
// Layout
//
// Lines of styled spans rather than strings with escape codes in them: the
// live screen colours a span with the theme, the one-shot report with the
// terminal's own codes, and both measure the text that is actually printed.
// ---------------------------------------------------------------------------

export type Tone = 'plain' | 'strong' | 'dim' | 'good' | 'warn' | 'bad' | 'accent' | 'heading';
export interface Span {
    readonly text: string;
    readonly tone?: Tone;
}
export type Line = readonly Span[];
export type Sort = 'memory' | 'cpu' | 'name';
export const SORTS: readonly Sort[] = ['memory', 'cpu', 'name'];

export interface LayoutOptions {
    width: number;
    /** the most lines to return; containers are cut first, with a count of the rest */
    rows?: number;
    /** a note beside every figure saying what it means, and a sentence under each heading */
    explain: boolean;
    sort?: Sort;
    /** seconds between refreshes, for the live screen's header */
    live?: number;
    /** wrap a long note onto the next line instead of letting the edge cut it */
    wrapNotes?: boolean;
    /**
     * The sentence under each heading and the column legend. On by default
     * with `explain`; the live screen turns it off before it cuts any figure.
     */
    intros?: boolean;
}

const sp = (text: string, tone?: Tone): Span => ({ text, tone });
/** Where a note starts: label, value and detail all fit before it. */
const NOTE_COLUMN = 48;
/** A note that does not fit beside its row goes under it, indented this far. */
const NOTE_INDENT = 6;
const LABEL = 14;
const VALUE = 9;
const BAR = 30;

export function pct(n: number): string {
    return `${n < 10 ? n.toFixed(1) : Math.round(n)}%`;
}

function pressure(fraction: number): Tone {
    return fraction >= 0.9 ? 'bad' : fraction >= 0.7 ? 'warn' : 'good';
}

/** One stacked bar: each part a run of its own character and tone. */
function bar(parts: readonly [number, string, Tone][], width: number): Span[] {
    let left = width;
    const spans: Span[] = [];
    parts.forEach(([fraction, char, tone], i) => {
        const n =
            i === parts.length - 1
                ? left
                : Math.min(left, Math.round(Math.max(0, fraction) * width));
        left -= n;
        if (n > 0) {
            spans.push(sp(char.repeat(n), tone));
        }
    });
    return spans;
}

/** Drops trailing padding, which a styled span cannot have trimmed afterwards. */
function finish(line: Span[]): Line {
    const last = line.at(-1);
    if (last) {
        line[line.length - 1] = sp(last.text.trimEnd(), last.tone);
    }
    return line.filter((s) => s.text !== '');
}

class Lines {
    readonly out: Line[] = [];
    readonly #o: LayoutOptions;
    constructor(o: LayoutOptions) {
        this.#o = o;
    }
    blank(): void {
        this.out.push([]);
    }
    push(...spans: Span[]): void {
        this.out.push(finish(spans));
    }
    /** A heading in capitals, then what follows it on the same line, quieter. */
    heading(title: string, rest: string): void {
        this.push(sp(title, 'heading'), sp(rest ? `  ${rest}` : '', 'dim'));
    }
    /** A sentence under a heading, wrapped, only when explaining. */
    intro(text: string): void {
        if (!this.#o.explain || this.#o.intros === false) {
            return;
        }
        for (const line of wrap(text, Math.max(20, this.#o.width - 2))) {
            this.push(sp(`  ${line}`, 'dim'));
        }
    }
    /**
     * `label  value  detail  note`. The note is what the figure means: beside
     * the figure when it fits, wrapped under the row in a report, and in its
     * short form on a live screen too narrow for the long one.
     */
    row(
        label: string,
        value: string,
        tone: Tone,
        detail: Span[] = [],
        note = '',
        short = '',
    ): void {
        const head = [
            sp(`  ${padEndCols(label, LABEL)}`, 'dim'),
            sp(padStartCols(value, VALUE), tone),
        ];
        const used = stringWidth([...head, ...detail].map((s) => s.text).join(''));
        if (!this.#o.explain || !note) {
            this.push(...head, ...detail);
            return;
        }
        const column = Math.max(NOTE_COLUMN, used + 2);
        const gap = sp(' '.repeat(column - used));
        if (column + stringWidth(note) <= this.#o.width) {
            this.push(...head, ...detail, gap, sp(note, 'dim'));
            return;
        }
        if (!this.#o.wrapNotes) {
            this.push(...head, ...detail, gap, sp(short || note, 'dim'));
            return;
        }
        this.push(...head, ...detail);
        for (const l of wrap(note, Math.max(20, this.#o.width - NOTE_INDENT))) {
            this.push(sp(`${' '.repeat(NOTE_INDENT)}${l}`, 'dim'));
        }
    }
}

/** Containers keep at least this many rows on a short screen before the hints get any. */
const MIN_CONTAINER_ROWS = 3;

export function layout(view: ResourceView, o: LayoutOptions): Line[] {
    const full = sections(view, o);
    if (o.rows === undefined) {
        return [...full.top, ...full.head, ...full.rows, ...full.tail];
    }
    // Too tall: the prose under the headings goes first, then container rows
    // and hints share what is left, the containers getting a floor.
    const fits = (s: Sections): boolean =>
        s.top.length + s.head.length + s.rows.length + s.tail.length <= o.rows!;
    const s = fits(full) || !o.explain ? full : sections(view, { ...o, intros: false });
    if (fits(s)) {
        return [...s.top, ...s.head, ...s.rows, ...s.tail];
    }
    const avail = Math.max(0, o.rows - s.top.length - s.head.length);
    const floor = Math.min(s.rows.length, MIN_CONTAINER_ROWS, avail);
    let shown = Math.max(floor, Math.min(s.rows.length, avail - s.tail.length));
    const cut = shown < s.rows.length;
    if (cut) {
        shown = Math.max(0, shown - 1);
    }
    const hints = Math.max(0, avail - shown - (cut ? 1 : 0));
    const more: Line[] = cut
        ? [[sp(`  +${s.rows.length - shown} more — a taller window shows them`, 'dim')]]
        : [];
    const tail =
        hints >= s.tail.length
            ? s.tail
            : hints > 0
              ? [
                    ...s.tail.slice(0, wholeHints(s.tail, hints - 1)),
                    [sp('  … a taller window shows the rest', 'dim')],
                ]
              : [];
    return [...s.top, ...s.head, ...s.rows.slice(0, shown), ...more, ...tail].slice(0, o.rows);
}

interface Sections {
    top: Line[];
    head: Line[];
    rows: Line[];
    tail: Line[];
}

const HINT_MARK = '  • ';

/** The longest prefix of `n` lines or fewer that ends between two hints, never inside one. */
function wholeHints(tail: readonly Line[], n: number): number {
    let k = n;
    while (k > 0 && k < tail.length && tail[k]![0]?.text !== HINT_MARK) {
        k--;
    }
    return k;
}

function sections(view: ResourceView, o: LayoutOptions): Sections {
    const top = new Lines(o);
    const when = new Date(view.at).toLocaleTimeString();
    const how =
        o.live !== undefined
            ? `refreshing every ${o.live}s · ${when}`
            : view.interval
              ? `cpu measured over ${view.interval.toFixed(1)}s · ${when}`
              : when;
    top.push(sp('zen sandbox', 'strong'), sp(' · memory and cpu', 'plain'), sp(`   ${how}`, 'dim'));
    for (const p of view.problems) {
        top.push(sp(`  ✗ ${p}`, 'bad'));
    }
    top.blank();

    hostSection(top, view);
    machineSection(top, view, o);

    const head = new Lines(o);
    containerHead(head, view, o);

    const tail = new Lines(o);
    hintSection(tail, view, o);

    return { top: top.out, head: head.out, rows: containerRows(view, o), tail: tail.out };
}

function hostSection(l: Lines, v: ResourceView): void {
    const vm = v.host.vm;
    if (!vm) {
        return;
    }
    const mac = v.platform === 'darwin' ? 'THIS MAC' : 'THIS COMPUTER';
    l.heading(mac, `${bytes(v.host.memory)} memory · ${v.host.cpus} cores`);
    l.intro(
        'Containers do not run on this computer directly: they run inside one Linux virtual ' +
            'machine, and these rows are what that machine costs it.',
    );
    const share = vm.memory / v.host.memory;
    l.row(
        'machine',
        bytes(vm.memory),
        pressure(share * 2),
        [
            sp('  '),
            ...bar(
                [
                    [share, '█', pressure(share * 2)],
                    [1, '░', 'dim'],
                ],
                20,
            ),
            sp(`  ${pct(share * 100)}`, 'dim'),
        ],
        vm.footprint !== undefined
            ? `what Activity Monitor shows for “${vm.name}”: memory the machine has touched, which grows and rarely shrinks`
            : `memory held by ${vm.name}`,
        vm.footprint !== undefined ? 'Activity Monitor’s figure' : '',
    );
    if (vm.footprint !== undefined && vm.rss < vm.footprint * 0.8) {
        l.row(
            'in RAM now',
            bytes(vm.rss),
            'plain',
            [sp(`  ${pct((vm.rss / vm.footprint) * 100)} of it`, 'dim')],
            'the part physically in RAM; macOS has compressed or swapped the rest',
            'rest compressed or swapped',
        );
    }
    if (vm.peak !== undefined && vm.peak > vm.memory * 1.02) {
        l.row(
            'peak',
            bytes(vm.peak),
            'plain',
            [],
            'the most it has held since the machine started',
            'most since it started',
        );
    }
    l.row(
        'cpu',
        vm.cpu === undefined ? '…' : pct(vm.cpu),
        vm.cpu === undefined ? 'dim' : pressure(vm.cpu / 100 / Math.max(1, v.host.cpus)),
        [sp('  of one core', 'dim')],
        '100% is one core kept fully busy by everything inside the machine',
        '100% = one core busy',
    );
    if (v.host.helpers.length > 0) {
        const mem = v.host.helpers.reduce((n, p) => n + p.memory, 0);
        l.row(
            'helpers',
            bytes(mem),
            'plain',
            [sp(`  ${v.host.helpers.map((p) => p.name).join(', ')}`, 'dim')],
            'programs beside the machine: vfkit starts it, gvproxy carries its network',
            'start it, carry its network',
        );
    }
    l.blank();
}

function machineSection(l: Lines, v: ResourceView, o: LayoutOptions): void {
    const m = v.machine;
    if (!m) {
        return;
    }
    const native = v.platform === 'linux';
    l.heading(
        native ? 'THIS COMPUTER' : 'INSIDE THE MACHINE',
        [m.name, `${bytes(m.total)} memory`, `${m.cpus} cpus`].filter(Boolean).join(' · '),
    );
    l.intro(
        native
            ? 'Containers run directly on this computer, so they share its memory with everything else on it.'
            : 'The Linux machine every container shares. Its size was set when it was created; ' +
                  '`podman machine set --memory` changes it.',
    );
    const width = Math.max(10, Math.min(BAR * 2, o.width - 4));
    l.push(
        sp('  '),
        ...bar(
            [
                [m.used / m.total, '█', pressure(m.used / m.total)],
                [m.cache / m.total, '▒', 'accent'],
                [1, '░', 'dim'],
            ],
            width,
        ),
    );
    if (o.explain) {
        l.push(
            sp('  '),
            sp('█', pressure(m.used / m.total)),
            sp(' in use  ', 'dim'),
            sp('▒', 'accent'),
            sp(' cache  ', 'dim'),
            sp('░ free', 'dim'),
        );
    }
    const of = (n: number): Span[] => [sp(`  ${pct((n / m.total) * 100).padStart(4)}`, 'dim')];
    l.row(
        'in use',
        bytes(m.used),
        pressure(m.used / m.total),
        of(m.used),
        'held by programs: the containers and the machine’s own services',
        'held by programs',
    );
    l.row(
        'cache',
        bytes(m.cache),
        'accent',
        of(m.cache),
        'recently read files kept for speed; given back the moment a program needs room',
        'file cache, freed on demand',
    );
    l.row('free', bytes(m.free), 'plain', of(m.free), 'not used for anything', 'unused');
    l.row(
        'available',
        bytes(m.available),
        pressure(1 - m.available / m.total),
        of(m.available),
        'what a new command could get right now: free plus cache',
        'free + cache: room left',
    );
    l.row(
        'swap',
        bytes(m.swapUsed),
        m.swapUsed > 64 * MIB ? 'warn' : 'plain',
        [sp(`  of ${bytes(m.swapTotal)}`, 'dim')],
        'memory moved to disk when RAM ran out; above zero means it ran short and slowed down',
        'RAM spilled to disk',
    );
    if (m.held !== undefined && m.held > 256 * MIB) {
        l.row(
            'held, unused',
            bytes(m.held),
            'warn',
            [],
            'counted by macOS, used by nothing inside: freed after earlier use, never handed back',
            'macOS counts it, nothing uses it',
        );
    }
    l.blank();
}

function containerHead(l: Lines, v: ResourceView, o: LayoutOptions): void {
    const t = v.totals;
    const kinds = [
        t.zen ? `${t.zen} zen` : '',
        t.gym ? `${t.gym} gym` : '',
        t.other ? `${t.other} other` : '',
    ]
        .filter(Boolean)
        .join(', ');
    l.heading(
        'CONTAINERS',
        t.running === 0
            ? `none running${v.stopped ? ` · ${v.stopped} stopped` : ''}`
            : [
                  `${t.running} running${kinds ? ` (${kinds})` : ''}`,
                  `${bytes(t.memory)} memory`,
                  `cpu ${pct(t.cpu)}`,
                  v.stopped ? `${v.stopped} stopped` : '',
              ]
                  .filter(Boolean)
                  .join(' · '),
    );
    l.intro(
        'Running ones only: a stopped container keeps its files but uses no memory or cpu. ' +
            'zen makes one per session; zen gym servers and anything else in podman are listed too.',
    );
    if (t.running === 0) {
        return;
    }
    if (o.explain && o.intros !== false) {
        const over = v.interval ? `the last ${v.interval.toFixed(0)}s` : 'its whole life so far';
        const legend = [
            `CPU — share of one core over ${over}; 100% is one core fully busy.`,
            'MEMORY — what its programs hold now, cache not counted; the bar is how close it is to LIMIT.',
            'LIMIT — the most it may use (`sandbox.memory` in agents.yaml); past it a command is killed with exit 137.',
            'NET — received ↓ and sent ↑ since it started.  orphaned — its zen run is gone, yet it keeps running.',
        ];
        for (const text of legend) {
            for (const line of wrap(text, Math.max(20, o.width - 4))) {
                l.push(sp(`  ${line}`, 'dim'));
            }
        }
    }
    l.push(
        sp('  '),
        ...tableColumns(o.width).flatMap((c, i) => [
            sp(i > 0 ? ' ' : ''),
            sp(
                c.align === 'right' ? padStartCols(c.title, c.width) : padEndCols(c.title, c.width),
                'strong',
            ),
        ]),
    );
}

interface Column {
    title: string;
    width: number;
    align: 'left' | 'right';
    /** narrow screens drop the lowest first; 0 is never dropped */
    keep: number;
    cell(c: ContainerView): Span[];
}

/** The name gets whatever the other columns leave, but never less than this. */
const NAME_MIN = 24;

const COLUMNS: readonly Column[] = [
    {
        title: 'CPU',
        width: 7,
        align: 'right',
        keep: 0,
        cell: (c) => [sp(pct(c.cpu), c.cpuOver === 'lifetime' ? 'dim' : pressure(c.cpu / 100))],
    },
    {
        title: 'MEMORY',
        width: 9,
        align: 'right',
        keep: 0,
        cell: (c) => [sp(bytes(c.memory), c.limit ? pressure(c.memory / c.limit) : 'plain')],
    },
    {
        title: '',
        width: 10,
        align: 'left',
        keep: 3,
        cell: (c) =>
            c.limit
                ? bar(
                      [
                          [c.memory / c.limit, '█', pressure(c.memory / c.limit)],
                          [1, '░', 'dim'],
                      ],
                      10,
                  )
                : [sp('·', 'dim')],
    },
    {
        title: 'LIMIT',
        width: 9,
        align: 'right',
        keep: 4,
        cell: (c) => [sp(c.limit ? bytes(c.limit) : 'none', 'dim')],
    },
    {
        title: 'PIDS',
        width: 5,
        align: 'right',
        keep: 2,
        cell: (c) => [sp(String(c.pids))],
    },
    {
        title: 'NET ↓ / ↑',
        width: 19,
        align: 'left',
        keep: 1,
        cell: (c) => [sp(`${bytes(c.netIn)} ↓ ${bytes(c.netOut)} ↑`, 'dim')],
    },
    {
        title: 'AGE',
        width: 5,
        align: 'left',
        keep: 2,
        cell: (c) => [
            sp(
                c.createdAt ? ago(c.createdAt).replace(' ago', '').replace('just now', 'now') : '',
                'dim',
            ),
        ],
    },
    {
        title: 'WHAT',
        width: 8,
        align: 'left',
        keep: 0,
        cell: (c) => [
            sp(
                c.orphaned ? 'orphaned' : c.kind,
                c.orphaned ? 'warn' : c.kind === 'other' ? 'dim' : 'plain',
            ),
        ],
    },
    {
        title: 'PROJECT',
        width: 14,
        align: 'left',
        keep: 5,
        cell: (c) => [sp(clipTo(c.project ?? (c.kind === 'gym' ? '(gym)' : '—'), 14))],
    },
];

/** The columns that fit, in order, dropping the least needed until the name has room. */
function tableColumns(width: number): Column[] {
    let cols = [...COLUMNS];
    const used = (): number => 2 + cols.reduce((n, c) => n + c.width + 1, 0);
    const order = [...COLUMNS].filter((c) => c.keep > 0).sort((a, b) => a.keep - b.keep);
    for (const drop of order) {
        if (used() + NAME_MIN <= width) {
            break;
        }
        cols = cols.filter((c) => c !== drop);
    }
    return [...cols, { title: 'NAME', width: 0, align: 'left', keep: 0, cell: () => [] }];
}

function containerRows(v: ResourceView, o: LayoutOptions): Line[] {
    const sorted = [...v.containers].sort((a, b) => {
        switch (o.sort ?? 'memory') {
            case 'cpu':
                return b.cpu - a.cpu;
            case 'name':
                return a.name.localeCompare(b.name);
            default:
                return b.memory - a.memory;
        }
    });
    const cols = tableColumns(o.width).slice(0, -1);
    const room = Math.max(NAME_MIN, o.width - 2 - cols.reduce((n, c) => n + c.width + 1, 0));
    return sorted.map((c) =>
        finish([
            sp('  '),
            ...cols.flatMap((col) => {
                const spans = col.cell(c);
                const len = stringWidth(spans.map((s) => s.text).join(''));
                const pad = sp(' '.repeat(Math.max(0, col.width - len)));
                return col.align === 'right' ? [pad, ...spans, sp(' ')] : [...spans, pad, sp(' ')];
            }),
            sp(clipTo(c.name, room), 'dim'),
        ]),
    );
}

function clipTo(text: string, width: number): string {
    return clipColumns(text, width);
}

function hintSection(l: Lines, v: ResourceView, o: LayoutOptions): void {
    if (v.hints.length === 0) {
        return;
    }
    l.blank();
    l.heading('WHAT TO DO', '');
    for (const hint of v.hints) {
        const [first = '', ...rest] = wrap(hint, Math.max(20, o.width - 6));
        l.push(sp(HINT_MARK, 'warn'), sp(first));
        for (const line of rest) {
            l.push(sp(`    ${line}`));
        }
    }
}
