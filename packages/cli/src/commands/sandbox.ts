import {
    current as currentProject,
    dirSize,
    isProjectDir,
    machineSandboxProvider,
    open as openProject,
    Registry,
    resolveBuild,
    sessionIds,
    type ResolvedBuild,
    type SandboxProvider,
} from '@zenera/engine';
import {
    readProjectConfig,
    sandboxLimits,
    type ProjectConfig,
    type SandboxConfig,
    type SandboxLimits,
} from '@zenera/neo';
import { parse } from '../args.ts';
import type { Command } from '../command.ts';
import { prepareOn } from '../sandbox.ts';
import {
    engineDisk,
    ensurePodmanReady,
    idleContainers,
    ownedContainers,
    podmanStatus,
    removeContainers,
    sessionOwners,
    type EngineDisk,
    type OwnedContainer,
    type PodmanStatus,
} from '../podman.ts';
import { layout, ResourceSampler, type Line, type Tone } from '../resources.ts';
import {
    ago,
    bold,
    bytes,
    count,
    cyan,
    dim,
    green,
    json,
    note,
    red,
    table,
    usageError,
    write,
    writeAll,
    yellow,
} from '../term.ts';

const USAGE = 'zen sandbox [status|top|up|pull|clean|disk] [options]';
const SUBCOMMANDS = ['status', 'top', 'up', 'pull', 'clean', 'disk'];

/** `top` refreshes this often unless told otherwise. */
const DEFAULT_INTERVAL_S = 2;
/** A one-shot report still needs two readings for a cpu figure. */
const ONCE_INTERVAL_MS = 1000;

/** Enough to see the pattern; the rest are a number. */
const LISTED = 6;
/** Under the labels, which is where the eye already is. */
const INDENT = ' '.repeat(11);
/** `agents.yaml` states memory in MiB; `bytes` prints bytes. */
const MIB = 1024 * 1024;

/** Below this many free locks, `status` says so: a batch can spend that in minutes. */
const FEW_LOCKS = 256;

interface Flags {
    project?: string;
    image?: string;
    stopped?: boolean;
    idle?: boolean;
    once?: boolean;
    interval?: string;
    brief?: boolean;
    theme?: string;
    podman?: boolean;
}

// ---------------------------------------------------------------------------
// The container engine, on its own
//
// Everything here also happens inside `zen run`, and that is the point of
// having it: the slow, one-time, machine-wide half of a run is the half most
// likely to fail, and debugging it should not cost a model call. `up` is what
// you run on a new laptop; `status` is what you read when a run says the engine
// did not answer.
// ---------------------------------------------------------------------------

export const sandbox: Command = {
    summary: 'Check and prepare the container command-line tools run in.',
    usage: USAGE,
    banner: { head: 'Zenera', accent: 'Sandbox', subtitle: 'Container Isolation', hue: 'azure' },
    details: [
        '  status                 What is installed, running and pulled. Changes nothing.',
        '  top                    Memory and cpu, live: this computer, the machine, each',
        '                         container — with a note on what every figure means.',
        '  up                     Install if asked, start the machine, pull or build the image.',
        '  pull                   Just the image: pulled, or built from the project\u2019s Dockerfile.',
        '  clean                  Remove every container this CLI created.',
        '  disk                   What the engine and every known project occupy.',
        '',
        '  --project <name|dir>   Which project the image and containers belong to.',
        '  --image <ref>          Use this image instead of the project\u2019s.',
        '  --idle                 With clean: only what no live run is using — stopped ones,',
        '                         and running ones whose run was killed before it cleaned up.',
        '  --once                 With top: measure once and print, no live screen. Also',
        '                         what happens with --json or when output is not a terminal.',
        '  --interval <seconds>   With top: how often the live screen refreshes (default 2).',
        '  --brief                With top: the figures without the notes explaining them.',
        '  --podman               Podman on this machine, even when a plugin in',
        '                         $ZEN_PLUGINS provides the sandbox.',
        '',
        'Without --project this is the project you are standing in, and standing',
        'nowhere is an answer: `status` then reports the engine and every container',
        'on the machine, since that is all there is to say.',
        '',
        'None of this is required. A run does all of it on its own, the first',
        'time an agent that can reach a shell is about to start one.',
        '',
        'When a plugin provides the sandbox, `status` and `clean` ask it instead,',
        'and the podman-only subcommands say so.',
    ],
    run: async (ctx) => {
        const { values, positionals } = parse<Flags>(
            ctx.args,
            {
                project: { type: 'string' },
                image: { type: 'string' },
                stopped: { type: 'boolean' },
                idle: { type: 'boolean' },
                once: { type: 'boolean' },
                interval: { type: 'string' },
                brief: { type: 'boolean' },
                theme: { type: 'string' },
                podman: { type: 'boolean' },
            },
            USAGE,
        );

        const what = positionals[0] ?? 'status';
        if (!SUBCOMMANDS.includes(what)) {
            throw usageError(`unknown subcommand: ${what}`, USAGE);
        }
        if (positionals.length > 1) {
            throw usageError('one subcommand at a time', USAGE);
        }

        // `clean` and `disk` are machine-wide questions, so looking for a
        // project they do not use would be reading something for nothing.
        const scoped = what === 'status' || what === 'up' || what === 'pull';
        const found = scoped ? await projectSandbox(ctx.cwd, values) : undefined;

        if (!values.podman) {
            const remote = await machineSandboxProvider(
                { dir: found?.dir ?? ctx.cwd, name: found?.name ?? 'machine' },
                undefined,
                { warn: (m) => note(yellow(m)) },
            );
            if (remote) {
                try {
                    return await elsewhere(what, remote.provider, ctx.json, values, found);
                } finally {
                    await Promise.resolve(remote.plugin.close?.()).catch(() => undefined);
                }
            }
        }
        const image = values.image ?? found?.image;
        const build = values.image ? undefined : found?.build;

        switch (what) {
            case 'status':
                return status(found, image, ctx.json);
            case 'up':
                return up(image, build, ctx.json, ctx.json);
            case 'pull':
                if (!image) {
                    throw usageError(
                        'no project here, so there is no image to pull',
                        'name one with --project, or an image with --image',
                    );
                }
                return up(image, build, true, ctx.json, true);
            case 'top':
                return top(values, ctx.json);
            case 'clean':
                return clean(ctx.json, Boolean(values.idle || values.stopped));
            case 'disk':
                return disk(ctx.json);
        }
    },
};

/**
 * The subcommands, when a plugin runs the sandboxes somewhere else: `status`,
 * `clean`, and getting the image ready (`up`, `pull`) are asked of it, and the
 * rest are about a podman that is not the one in use, so they say that rather
 * than quietly reporting on it.
 */
async function elsewhere(
    what: string,
    provider: SandboxProvider,
    asJson: boolean,
    values: Flags,
    project: ProjectSandbox | undefined,
): Promise<void> {
    if (what === 'up' || what === 'pull') {
        // The image is built where the sandboxes run, so this is the one
        // place it can be got ready ahead of a run.
        if (!project?.build && !project?.config?.image) {
            throw usageError(
                'no project here, so there is no image to get ready',
                'run it in a project, or name one with --project',
            );
        }
        await prepareOn(provider, project.config, project.build, { force: what === 'pull' });
        if (asJson) {
            json({ ready: true, provider: provider.describe, image: project.image ?? null });
            return;
        }
        write(`${green('ready')} ${dim(`on ${provider.describe}`)}`);
        return;
    }
    if (what === 'status') {
        const report = provider.status ? await provider.status() : undefined;
        if (asJson) {
            json({ provider: provider.describe, ...(report ?? {}) });
            return;
        }
        write(`${bold('sandbox')}  ${provider.describe}`);
        for (const line of report?.lines ?? [dim('it has nothing more to say')]) {
            write(`${INDENT}${line}`);
        }
        return;
    }
    if (what === 'clean' && provider.clean) {
        const removed = await provider.clean({ all: !(values.idle || values.stopped) });
        if (asJson) {
            json({ provider: provider.describe, removed });
            return;
        }
        write(
            removed.length
                ? `removed ${count(removed.length, 'sandbox')}`
                : dim('nothing to remove'),
        );
        return;
    }
    throw usageError(
        `sandboxes run on ${provider.describe}, so \`zen sandbox ${what}\` has nothing to do here`,
        'pass --podman to manage podman on this machine anyway',
    );
}

interface ProjectSandbox {
    dir: string;
    name: string;
    image?: string;
    build?: ResolvedBuild;
    /** the project's `sandbox:` block, as written */
    config?: SandboxConfig;
    /** the ceilings one container gets, agent overrides included */
    limits?: SandboxLimits;
}

/**
 * Which project this is about: the flag, or the directory the command was run
 * in. It deliberately never asks. `zen sandbox status` run from anywhere at
 * all is a useful thing, so standing outside every project is an answer — the
 * engine is still there to report on — and a question with a list of every
 * project on the machine is not one a *reading* has any business asking.
 *
 * Notably it also does not go through `target`: reading a setting must not
 * create a session.
 */
async function projectSandbox(cwd: string, values: Flags): Promise<ProjectSandbox | undefined> {
    const found = values.project ? await openProject(values.project) : await currentProject(cwd);
    if (!found) {
        return undefined;
    }
    try {
        const { root, config } = readProjectConfig(found.dir);
        const build = resolveBuild(root, config.sandbox);
        return {
            dir: found.dir,
            name: found.name,
            image: build?.tag ?? config.sandbox?.image,
            build,
            config: config.sandbox,
            limits: sandboxLimits(config.sandbox),
        };
    } catch {
        // A project whose configuration does not read is `zen check`'s to
        // report; here it only means there is no image to name.
        return { dir: found.dir, name: found.name };
    }
}

async function status(
    project: ProjectSandbox | undefined,
    image: string | undefined,
    asJson: boolean,
): Promise<void> {
    const build = project?.build;
    const found = await podmanStatus({ image });
    const all = found.ready ? await ownedContainers(found.engine) : [];
    // A container belongs to a session, and a session belongs to a project, so
    // a report about one project must not list another's — or the gym's,
    // which wears the same label and belongs to no project at all.
    const containers = project ? ofProject(project.dir, all) : all;
    const idle = all.length > 0 ? idleContainers(all, await sessionOwners()) : [];

    if (asJson) {
        json({
            ...found,
            project: project?.name ?? null,
            dockerfile: build?.dockerfile ?? null,
            limits: project?.limits ?? null,
            fits: fits(found.capacity?.memory, project?.limits?.memory) ?? null,
            containers,
            idle: idle.map((c) => c.name),
        });
        return;
    }

    const mark = (ok: boolean): string => (ok ? green('ok') : red('no'));
    write(
        `${bold('engine')}     ${found.engine} ${dim(found.version ?? '')} ${mark(found.installed)}`,
    );
    if (found.machine) {
        const state = found.machine.starting ? yellow('starting') : mark(found.machine.running);
        write(`${bold('machine')}    ${found.machine.name} ${state}`);
    }
    if (found.connection) {
        // A concurrency limit wearing a connection string: `ssh://` opens one
        // connection per call and sshd refuses them past ten, which stays
        // invisible until a batch is wide enough to lose tasks at random.
        const how = found.connection.shared
            ? dim('· one shared connection, no limit on parallel calls')
            : yellow('· a new ssh connection per call — about 10 at a time');
        write(`${bold('connection')} ${dim(found.connection.uri)} ${how}`);
    }
    write(`${bold('responds')}   ${mark(found.ready)}`);
    writeAll(limitLines(found, project?.limits));
    if (project) {
        write(`${bold('project')}    ${project.name} ${dim(project.dir)}`);
    }
    if (found.image) {
        write(`${bold('image')}      ${found.image} ${mark(Boolean(found.imagePresent))}`);
    }
    if (build) {
        write(`${bold('dockerfile')} ${dim(build.dockerfile)}`);
    }
    writeAll(lockLines(found.freeLocks, idle.length));
    writeAll(containerLines(containers, idle, project?.name, all.length));

    if (!found.installed || !found.ready) {
        note('');
        note(dim('run `zen sandbox up` to fix what can be fixed.'));
    } else {
        note('');
        note(dim('memory and cpu, live: zen sandbox top'));
    }
}

// ---------------------------------------------------------------------------
// Memory and cpu
//
// A live screen when a person is watching, one report when not: the same
// layout either way, so what a script reads is what the screen showed.
// ---------------------------------------------------------------------------

async function top(values: Flags, asJson: boolean): Promise<void> {
    const interval = values.interval === undefined ? DEFAULT_INTERVAL_S : Number(values.interval);
    if (!Number.isFinite(interval) || interval < 0.5 || interval > 3600) {
        throw usageError(
            `--interval must be a number of seconds from 0.5 to 3600, not ${values.interval}`,
            USAGE,
        );
    }
    const sampler = new ResourceSampler();
    const live =
        !asJson && !values.once && Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY);
    if (live) {
        const { watch } = await import('../tui/sandbox.tsx');
        await watch({
            sampler,
            intervalMs: interval * 1000,
            explain: !values.brief,
            theme: values.theme,
        });
        return;
    }

    // The first reading has nothing to compare against, so its cpu figures are
    // lifetime averages; the second one is over a second of real time.
    await sampler.next();
    await new Promise((done) => setTimeout(done, ONCE_INTERVAL_MS));
    const view = await sampler.next();
    if (asJson) {
        json(view);
        return;
    }
    const width = process.stdout.columns || Number(process.env.COLUMNS) || 100;
    writeAll(
        layout(view, { width, explain: !values.brief, sort: 'memory', wrapNotes: true }).map(ansi),
    );
}

const PAINT: Record<Tone, (s: string) => string> = {
    plain: (s) => s,
    strong: bold,
    heading: (s) => bold(cyan(s)),
    dim,
    good: green,
    warn: yellow,
    bad: red,
    accent: cyan,
};

function ansi(line: Line): string {
    return line.map((s) => PAINT[s.tone ?? 'plain'](s.text)).join('');
}

/**
 * How many containers of this size the engine could hold at once.
 *
 * Nothing enforces it — `--memory` caps one container and the kernel kills
 * whatever overruns the sum, so this is what the machine can honour, not a
 * gate anything checks. It is worth printing because neither figure gives it
 * alone: off Linux the memory is the *machine's*, which has nothing to do with
 * the host, so a few containers at the 4096 MiB default can be past it while
 * the laptop sits nearly empty.
 */
function fits(capacity?: number, container?: number): number | undefined {
    if (!capacity || !container) {
        return undefined;
    }
    return Math.max(0, Math.floor(capacity / container));
}

/**
 * Two ceilings, in the order they bite: what the engine has, and what one
 * container is permitted to take of it.
 */
function limitLines(found: PodmanStatus, limits?: SandboxLimits): string[] {
    const lines: string[] = [];
    const where = found.machine ? 'machine' : 'host';
    if (found.capacity) {
        const { memory, swap, cpus } = found.capacity;
        const swapped = swap > 0 ? `${bytes(swap * MIB)} swap` : 'no swap';
        lines.push(
            `${bold('capacity')}   ${bytes(memory * MIB)} ${dim(
                `· ${swapped} · ${cpus} cpus · the ${where}'s, not the host's`,
            )}`,
        );
    }
    if (limits) {
        const room = fits(found.capacity?.memory, limits.memory);
        const how = limits.declared ? limits.hardening : `${limits.hardening} defaults`;
        const tail =
            room === undefined
                ? how
                : room > 0
                  ? `· ${how} · the ${where} has room for ${room}`
                  : `· ${how} · more than the ${where} has`;
        lines.push(
            `${bold('container')}  ${bytes(limits.memory * MIB)} ${dim(
                `· ${limits.cpus} cpus ${tail}`,
            )}`,
        );
    }
    return lines;
}

/**
 * The containers this project's sessions made. A container carries the session
 * id that made it in a label, and a session id is a directory name under the
 * project — the same attribution `disk` does for every project at once, so the
 * two cannot disagree.
 */
function ofProject(dir: string, containers: readonly OwnedContainer[]): OwnedContainer[] {
    const sessions = new Set(sessionIds(dir));
    return containers.filter((c) => c.key !== undefined && sessions.has(c.key));
}

/**
 * Every container the engine holds takes one of its locks, stopped or not, and
 * at zero nothing can be created — for any project. Said only when it is close.
 */
function lockLines(free: number | undefined, idle: number): string[] {
    if (free === undefined || free >= FEW_LOCKS) {
        return [];
    }
    const left = free === 0 ? red('none free') : yellow(`${free} free`);
    return [
        `${bold('locks')}      ${left} ${dim('· one per container, stopped ones included')}`,
        ...(idle > 0
            ? [`${INDENT}${dim(`${idle} no live run is using — zen sandbox clean --idle`)}`]
            : []),
    ];
}

/**
 * One per line rather than one long line, because there is normally more than
 * one and the interesting part — how old, and whether anything is still up —
 * is at the end of a name too long to scan.
 *
 * The trailing note is there because the count surprises people: a container
 * is per *session*, not per project, and `persist: true` is what leaves the
 * stopped ones behind. `scope` names the project these belong to, and saying
 * so is half the answer — the other half is that there are more elsewhere.
 */
function containerLines(
    containers: readonly OwnedContainer[],
    idle: readonly OwnedContainer[],
    scope?: string,
    total = containers.length,
): string[] {
    const tail = scope
        ? `one per session in ${scope}, kept by \`persist: true\` — all of them: zen sandbox disk`
        : 'one per session, kept by `persist: true` — see: zen sandbox disk';
    const elsewhere = total > containers.length ? ` · ${total} on the machine` : '';
    if (containers.length === 0) {
        return [`${bold('containers')} ${dim(scope ? `none in ${scope}${elsewhere}` : 'none')}`];
    }
    // Running, but the run that started it is gone: nothing will ever stop it.
    const orphans = new Set(idle.filter((c) => c.state === 'running').map((c) => c.name));
    const running = containers.filter((c) => c.state === 'running').length;
    const lost = containers.filter((c) => orphans.has(c.name)).length;
    const head = `${bold('containers')} ${containers.length} ${dim(
        (running ? `· ${running} running` : '· none running') +
            (lost ? `, ${lost} of them orphaned` : '') +
            elsewhere,
    )}`;
    const rows = containers
        .slice(0, LISTED)
        .map((c) => [
            INDENT.slice(2),
            c.name,
            orphans.has(c.name)
                ? yellow('orphaned')
                : c.state === 'running'
                  ? green('running')
                  : dim(c.state),
            dim(ago(c.createdAt)),
        ]);
    const rest = containers.length - LISTED;
    return [
        head,
        ...table(rows),
        ...(rest > 0 ? [`${INDENT}${dim(`+${rest} more`)}`] : []),
        `${INDENT}${dim(tail)}`,
        ...(lost
            ? [`${INDENT}${dim('orphaned: its run was killed — zen sandbox clean --idle')}`]
            : []),
    ];
}

async function up(
    image: string | undefined,
    build: ResolvedBuild | undefined,
    yes: boolean,
    asJson: boolean,
    rebuild = false,
): Promise<void> {
    await ensurePodmanReady({ image, build, yes, rebuild });
    if (asJson) {
        json({ ready: true, image, dockerfile: build?.dockerfile ?? null });
        return;
    }
    write(`${green('ready')}${image ? ` ${dim(image)}` : ''}`);
}

async function clean(asJson: boolean, idle: boolean): Promise<void> {
    const owned = await ownedContainers(undefined, undefined, { sizes: true });
    const containers = idle ? idleContainers(owned, await sessionOwners()) : owned;
    const names = containers.map((c) => c.name);
    const freed = containers.reduce((n, c) => n + (c.size ?? 0), 0);
    await removeContainers(names);
    if (asJson) {
        json({ removed: names, freed });
        return;
    }
    if (names.length === 0) {
        write(dim('nothing to remove'));
        return;
    }
    write(`removed ${names.length} ${dim(`· ${bytes(freed)} freed`)}`);
    write(dim('images are left alone — see: zen sandbox disk'));
}

// ---------------------------------------------------------------------------
// Where the disk went
//
// Two questions that look like one. The engine holds images and container
// layers inside its machine; a project holds sessions — workspaces, blobs,
// memory — in its own directory on the host. Removing a container reclaims
// only the first, and a report that added them into one number would suggest
// otherwise.
// ---------------------------------------------------------------------------

interface ProjectDisk {
    name: string;
    path: string;
    present: boolean;
    sessions: number;
    /** the project directory on the host */
    files: number;
    containers: number;
    /** what those containers have written on top of their image */
    layers: number;
}

async function disk(asJson: boolean): Promise<void> {
    const found = await podmanStatus();
    const [usage, containers] = found.ready
        ? await Promise.all([
              engineDisk(found.engine),
              ownedContainers(found.engine, undefined, { sizes: true }),
          ])
        : [undefined, [] as OwnedContainer[]];
    const { projects, loose } = await projectDisk(containers);

    if (asJson) {
        json({ engine: found.engine, ready: found.ready, ...usage, projects, unclaimed: loose });
        return;
    }

    if (usage) {
        write(`${bold('engine')} ${found.engine} ${dim(found.version ?? '')}`);
        writeAll(engineRows(usage));
        write('');
    } else {
        write(dim(`${found.engine} did not answer — projects only`));
        write('');
    }
    writeAll(projectRows(projects, loose));

    const idle = idleContainers(containers, await sessionOwners());
    const live = containers.length - idle.length;
    const sessions = projects.reduce((n, p) => n + p.files, 0);
    const hints = [
        ...(idle.length > 0
            ? [`zen sandbox clean --idle  ${count(idle.length, 'container')} no live run is using`]
            : []),
        ...(live > 0
            ? [`zen sandbox clean         also the ${live} in use, cutting off whatever runs there`]
            : []),
        ...(usage && usage.images.reclaimable > 0
            ? [`podman image prune -a     ${bytes(usage.images.reclaimable)} of unused images`]
            : []),
        // The ON DISK column is the bulk of the report and no command above touches it.
        ...(sessions > 0
            ? [
                  `${bytes(sessions)} ON DISK is project directories on this host, not the engine: ` +
                      'removing containers frees none of it',
              ]
            : []),
    ];
    if (hints.length > 0) {
        write('');
        writeAll(hints.map((h) => dim(h)));
    }
}

function engineRows(usage: EngineDisk): string[] {
    // Dimming an empty cell is not empty: it is two escape codes of nothing,
    // which `table` cannot trim and which leave trailing whitespace behind.
    const hint = (s: string): string => (s ? dim(s) : '');
    const rows = [
        [
            bold('images'),
            String(usage.images.count),
            bytes(usage.images.size),
            hint(usage.images.reclaimable > 0 ? `${bytes(usage.images.reclaimable)} unused` : ''),
        ],
        [
            bold('containers'),
            String(usage.containers.count),
            bytes(usage.containers.size),
            hint(usage.containers.active > 0 ? `${usage.containers.active} running` : ''),
        ],
        [bold('volumes'), String(usage.volumes.count), bytes(usage.volumes.size), ''],
    ];
    if (usage.store) {
        rows.push([
            bold('store'),
            '',
            bytes(usage.store.used),
            hint(`of ${bytes(usage.store.capacity)}`),
        ]);
    }
    if (usage.image) {
        // The one number that is actually gone from this host's disk. It is
        // larger than the store's own `used` because freeing blocks inside the
        // machine does not hand them back until something trims them.
        rows.push([
            bold('on this host'),
            '',
            bytes(usage.image.allocated),
            hint(`${usage.image.name} disk image, which never shrinks on its own`),
        ]);
    }
    return table(rows);
}

function projectRows(projects: readonly ProjectDisk[], loose: readonly OwnedContainer[]): string[] {
    if (projects.length === 0 && loose.length === 0) {
        return [dim('no projects yet')];
    }
    const rows: string[][] = [
        [
            bold('PROJECT'),
            bold('SESSIONS'),
            bold('ON DISK'),
            bold('CONTAINERS'),
            bold('IN PODMAN'),
            '',
        ],
    ];
    for (const p of projects) {
        const style = p.present ? (s: string) => s : dim;
        rows.push([
            style(p.name),
            style(String(p.sessions)),
            style(bytes(p.files)),
            style(p.containers ? String(p.containers) : dim('—')),
            style(p.layers ? bytes(p.layers) : dim('—')),
            p.present ? '' : dim('(missing)'),
        ]);
    }
    if (loose.length > 0) {
        // Containers whose session directory is gone, and gym's, which are
        // labelled the same way and belong to no project at all.
        const size = loose.reduce((n, c) => n + (c.size ?? 0), 0);
        const gyms = loose.filter((c) => c.key?.startsWith('gym-')).length;
        rows.push([
            dim('(unclaimed)'),
            dim('—'),
            dim('—'),
            dim(String(loose.length)),
            dim(bytes(size)),
            dim(
                gyms === loose.length
                    ? `zen gym ${gyms === 1 ? 'server' : 'servers'}, no project`
                    : 'no session owns these',
            ),
        ]);
    }
    const total = (pick: (p: ProjectDisk) => number): number =>
        projects.reduce((n, p) => n + pick(p), 0);
    rows.push([
        bold('total'),
        bold(String(total((p) => p.sessions))),
        bold(bytes(total((p) => p.files))),
        bold(String(total((p) => p.containers) + loose.length)),
        bold(bytes(total((p) => p.layers) + loose.reduce((n, c) => n + (c.size ?? 0), 0))),
        '',
    ]);
    return table(rows);
}

/**
 * Containers carry the session id that made them, and a session id is a
 * directory name under a project — so the label is enough to attribute one,
 * with no second index to keep in step with reality.
 */
async function projectDisk(
    containers: readonly OwnedContainer[],
): Promise<{ projects: ProjectDisk[]; loose: OwnedContainer[] }> {
    const registry = await Registry.open();
    const claimed = new Set<string>();
    const projects: ProjectDisk[] = [];

    for (const entry of registry.entries) {
        const present = isProjectDir(entry.path);
        const sessions = new Set(present ? sessionIds(entry.path) : []);
        const mine = containers.filter((c) => c.key !== undefined && sessions.has(c.key));
        for (const c of mine) {
            claimed.add(c.name);
        }
        projects.push({
            name: entry.name,
            path: entry.path,
            present,
            sessions: sessions.size,
            files: present ? dirSize(entry.path) : 0,
            containers: mine.length,
            layers: mine.reduce((n, c) => n + (c.size ?? 0), 0),
        });
    }

    // By the column that is shown, so the order is one a reader can check.
    projects.sort((a, b) => b.files - a.files);
    return { projects, loose: containers.filter((c) => !claimed.has(c.name)) };
}
