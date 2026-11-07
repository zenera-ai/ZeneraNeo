import {
    DEFAULT_SANDBOX_IMAGE,
    GATEWAY_URL_ENV,
    SANDBOX_GROUP,
    WORKSPACE_MOUNT,
    identityEnv,
    podmanSandbox,
    isHostOnlyEnv,
    type AgentProject,
    type ProjectConfig,
    type RunIdentity,
    type Sandbox,
    type SandboxFactory,
    type SandboxConfig,
    type Mount,
    type SandboxSpec,
} from '@zenera/neo';
import { createHash } from 'node:crypto';
import {
    cpSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stderrLogger, type Logger } from './errors.ts';
import { home as zenHome } from './home.ts';
import { resolveBuild, type ResolvedBuild } from './image.ts';
import { credentials } from './keys.ts';
import type { SessionPaths } from './session.ts';

// ---------------------------------------------------------------------------
// The sandbox, as zen wires it
//
// The library takes resolved values; the config states names and numbers. This
// is the layer between the two, and it owns the two decisions the library has
// no business making: which host variables are worth forwarding, and where the
// container's home directory lives.
//
// It lives in the session directory, which is the whole point. A session is
// already a self-contained thing — copy the directory and its conversation,
// memory and blobs travel with it — and a `pip install --user` that vanished
// on close would be the only part of a session that did not. So `$HOME` is a
// bind mount into `.data/sandbox/home`, and what the agent installs for itself
// is still there when the session is opened again. Everything *outside* the
// mounts is throwaway, which is what keeps a stale container from becoming a
// second, invisible configuration.
// ---------------------------------------------------------------------------

/** Where the persistent home lives, inside the container. */
const HOME = '/home/agent';

/** Where a credential *file* is mounted, inside the container. */
const KEY_MOUNT = '/run/zenera/keys';

/**
 * The credentials the run is using, in the form a container takes.
 *
 * Two shapes, two mechanisms. A secret is forwarded by *name* — podman reads
 * the value from its own environment, so nothing is written into an argv that
 * `ps` will show. A service-account file has to be present as a file, so the
 * one file is bind-mounted read-only and the variable is rewritten to where it
 * landed; mounting the directory it came from would drag in whatever else the
 * user keeps beside it.
 *
 * This is the part of the design that gives something away, and it should be
 * said plainly: the sandbox runs code the model wrote, and a key it can read
 * is a key it can send. `keys: false`, or `network: none`, is the answer for a
 * project where that is not an acceptable trade.
 */
function forwarded(): { secrets: string[]; env: Record<string, string>; mounts: Mount[] } {
    const secrets: string[] = [];
    const env: Record<string, string> = {};
    const mounts: Mount[] = [];
    for (const cred of credentials()) {
        if (cred.holds === 'file') {
            const at = `${KEY_MOUNT}/${basename(cred.value)}`;
            mounts.push({
                host: cred.value,
                at,
                readOnly: true,
                source: { kind: 'credential', name: cred.env },
            });
            env[cred.env] = at;
            continue;
        }
        secrets.push(cred.env);
    }
    // Not secrets, and useless without one: a service account says which
    // project it belongs to but never which region to call, and a gateway key
    // says nothing of where the gateway is.
    for (const name of ['GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', GATEWAY_URL_ENV]) {
        const value = process.env[name];
        if (value) {
            env[name] = value;
        }
    }
    return { secrets, env, mounts };
}

export interface SandboxSetup {
    /** where the session's commands run, and the files they see; podman for `zen run` */
    sandbox: Sandbox;
    /** the resolved base spec, for `zn sandbox status` and the image pre-warm */
    spec: SandboxSpec;
    /** where the workspace is in the sandbox, and so the name the file tools answer with */
    workdir: string;
    image: string;
    /** the Dockerfile behind `image`, when it came from one */
    build?: ResolvedBuild;
    /** host side of the container's `$HOME`, created only if it is ever needed */
    home: string;
    /** every tree bound into the container besides the workspace itself */
    mounts: readonly Mount[];
    /** where it runs, for people: `podman (this machine)`, or what a plugin calls itself */
    provider: string;
}

export interface SandboxInputs {
    config: ProjectConfig;
    session: SessionPaths;
    workspace: string;
    /** the project directory, which `build:` paths are relative to */
    root: string;
    readOnly?: boolean;
    /**
     * Trees to mount besides the workspace and the home — the project's assets
     * and its skill catalog. The same array goes to the file tools, so a path
     * a command prints is a path `read_file` accepts.
     */
    mounts?: readonly Mount[];
    /** `--image` */
    image?: string;
    /** `--no-keys`: refuse to forward credentials, whatever the config says */
    keys?: boolean;
    /**
     * Names from the project's `.env`, forwarded into the container the same
     * way a credential is — by name, so the value stays out of the argv.
     *
     * They travel with the keys rather than beside them: a `.env` is where an
     * api token lives, so `--no-keys` has to withhold it too or the flag is a
     * promise it does not keep.
     */
    env?: readonly string[];
    /** `false` overrides the config's `persist:` */
    persist?: boolean;
    /**
     * Who the run is acting for. Set on every command as `ZEN_USER_*`, never
     * on the container — see `execEnv` in the library for why.
     */
    identity?: RunIdentity;
    /** opens the sandbox; podman on this machine when unset */
    newSandbox?: SandboxFactory;
    /** what to call whatever `newSandbox` opens */
    provider?: string;
}

export function buildSandbox(opts: SandboxInputs): SandboxSetup {
    // An explicit --image is an answer, so there is nothing left to build.
    const build = opts.image ? undefined : resolveBuild(opts.root, opts.config.sandbox);
    const base = {
        ...(opts.config.sandbox ?? {}),
        ...(opts.image ? { image: opts.image } : {}),
        ...(opts.keys === false ? { keys: false } : {}),
        ...(opts.persist === false ? { persist: false } : {}),
    };
    const home = join(opts.session.data, 'sandbox', 'home');

    const mounts: Mount[] = [
        { host: home, at: HOME, source: { kind: 'home' } },
        { host: runtimeDir(), at: RUNTIME_DIR, readOnly: true, source: { kind: 'runtime' } },
        ...(opts.mounts ?? []),
    ];
    const keys = base.keys === false ? undefined : forwarded();
    if (keys) {
        mounts.push(...keys.mounts);
    }
    // Skills and assets are mounted read-only, and a python script run from a
    // read-only directory fails on writing its own `__pycache__` — a confusing
    // error about a file nobody asked for.
    // `ZENERA_AGENT` tells a `zen` run by `run_command` that no person is there.
    const extra = { HOME, PYTHONDONTWRITEBYTECODE: '1', ZENERA_AGENT: '1', ...(keys?.env ?? {}) };
    const spec = toSpec(base, extra, secretsOf(keys?.secrets, opts.env));
    if (build) {
        spec.build = { dockerfile: build.dockerfile, context: build.context };
    }

    const sandbox = (opts.newSandbox ?? podmanSandbox)({
        ...spec,
        root: opts.workspace,
        key: opts.session.id,
        readOnly: opts.readOnly,
        mounts,
        execEnv: identityEnv(opts.identity),
        execPaths: RUNTIME_PATHS,
    });

    return {
        sandbox,
        spec,
        workdir: spec.workdir ?? WORKSPACE_MOUNT,
        image: build?.tag ?? spec.image ?? DEFAULT_SANDBOX_IMAGE,
        build,
        home,
        mounts,
        provider: opts.newSandbox ? (opts.provider ?? 'the host') : PODMAN_PROVIDER,
    };
}

/** How the default sandbox is described. */
export const PODMAN_PROVIDER = 'podman (this machine)';

/**
 * The two sources of forwarded names, as one list: the credentials the keyring
 * selected, and whatever the project's `.env` declares. Deduped, because the
 * same variable named twice is the same `--env` twice.
 *
 * `undefined` in means keys are withheld, and the file goes with them.
 */
function secretsOf(
    secrets: readonly string[] | undefined,
    env: readonly string[] | undefined,
): string[] | undefined {
    if (!secrets) {
        return undefined;
    }
    return [...new Set([...secrets, ...(env ?? [])])].filter((name) => !isHostOnlyEnv(name));
}

/**
 * Config names a variable; this reads it. A name that is not set on this host
 * is simply not forwarded — an empty string in the container is a different
 * thing from an absent one, and tools test for absence.
 *
 * A name that has already been answered with a value drops off the forwarded
 * list: `--env NAME=value` and `--env NAME` are the same variable twice, and
 * the one that carries a value is the one that was resolved on purpose. That
 * matters for `GOOGLE_APPLICATION_CREDENTIALS`, which is rewritten here to
 * where the key file was mounted — a `.env` naming it must not put the host's
 * path back, since that path does not exist inside the container.
 */
function toSpec(
    config: SandboxConfig,
    extra: Record<string, string>,
    secrets?: readonly string[],
): SandboxSpec {
    const env: Record<string, string> = { ...extra };
    for (const name of config.env ?? []) {
        const value = process.env[name];
        if (value !== undefined && value !== '' && !isHostOnlyEnv(name)) {
            env[name] = value;
        }
    }
    return {
        image: config.image,
        cpus: config.cpus,
        memory: config.memory,
        network: config.network,
        workdir: config.workdir,
        timeout: config.timeout,
        hardening: config.hardening,
        user: config.user,
        persist: config.persist,
        env,
        secrets: secrets?.filter((name) => !(name in env)),
    };
}

/**
 * Whether anything in this project can reach a shell.
 *
 * Read off the *resolved* tool lists rather than off the config's selectors,
 * because `sandbox:*`, `*` and a bare name all mean the same thing by the time
 * the loader is done, and only one of those three is greppable.
 */
export function usesSandbox(project: AgentProject): boolean {
    return project.agents.some((a) => a.tools.some((t) => t.group === SANDBOX_GROUP));
}

/**
 * Gets the container engine ready before the first turn rather than at the
 * first tool call, so a missing engine costs an error instead of a round trip
 * and half a plan. Installing or starting one is a host decision with a user
 * attached to it, so the host supplies this; the engine only calls it.
 */
export type Preflight = (setup: SandboxSetup, yes?: boolean) => Promise<void>;

/** Where the container's `$HOME` lives must exist before podman mounts it. */
export function prepareHome(setup: SandboxSetup): void {
    mkdirSync(setup.home, { recursive: true });
}

// ---------------------------------------------------------------------------
// The `zenera` libraries
//
// What generated code calls to ask who it is running for. Python and Node,
// because those are what agents write; anything else reads `ZEN_USER_*`.
//
// One read-only copy for every session, at the same path in every sandbox:
// /opt/zenera/runtime/{python,node}/zenera. podman binds this machine's copy
// there (written once per content, in the zen home); the agent image has it
// there already. Every command gets both directories in front of PYTHONPATH and
// NODE_PATH, ahead of whatever the image set, so `import zenera` and
// `require('zenera')` work as they are (an ES `import` ignores NODE_PATH).
// ---------------------------------------------------------------------------

/**
 * The packaged sources, beside `src/` and `dist/` alike — also `@zenera/engine/runtime/*`,
 * for an image build that puts them in the image.
 */
export const RUNTIME_SOURCE = fileURLToPath(new URL('../runtime/', import.meta.url));

/** Where the libraries are, inside every sandbox. */
export const RUNTIME_DIR = '/opt/zenera/runtime';
export const RUNTIME_PYTHON = `${RUNTIME_DIR}/python`;
export const RUNTIME_NODE = `${RUNTIME_DIR}/node`;

const RUNTIME_PATHS = { PYTHONPATH: [RUNTIME_PYTHON], NODE_PATH: [RUNTIME_NODE] };

/** Lays the libraries out as a sandbox sees them: `python/zenera/`, `node/zenera/`. */
export function writeRuntime(dir: string): void {
    mkdirSync(join(dir, 'node'), { recursive: true });
    cpSync(join(RUNTIME_SOURCE, 'python'), join(dir, 'python'), { recursive: true });
    cpSync(join(RUNTIME_SOURCE, 'node'), join(dir, 'node', 'zenera'), { recursive: true });
}

/**
 * This machine's copy of the libraries: the agent image's own when it is one, else one in the
 * zen home per content — written once, by whichever process gets there first.
 */
export function runtimeDir(): string {
    if (existsSync(join(RUNTIME_PYTHON, 'zenera', '__init__.py'))) {
        return RUNTIME_DIR;
    }
    const dir = join(zenHome(), 'runtime', runtimeHash());
    if (!existsSync(dir)) {
        const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`;
        writeRuntime(tmp);
        try {
            renameSync(tmp, dir);
        } catch {
            // Another process wrote the same content first.
            rmSync(tmp, { recursive: true, force: true });
        }
    }
    return dir;
}

let hashed: string | undefined;

function runtimeHash(): string {
    if (hashed) return hashed;
    const hash = createHash('sha256');
    const walk = (rel: string): void => {
        for (const entry of readdirSync(join(RUNTIME_SOURCE, rel), { withFileTypes: true }).sort(
            (a, b) => a.name.localeCompare(b.name),
        )) {
            const path = join(rel, entry.name);
            if (entry.isDirectory()) {
                walk(path);
            } else {
                hash.update(`\0${path}\0`).update(readFileSync(join(RUNTIME_SOURCE, path)));
            }
        }
    };
    walk('');
    hashed = hash.digest('hex').slice(0, 12);
    return hashed;
}

/**
 * Best-effort teardown: losing a container must never lose a run. Closing is
 * also where a sandbox that keeps its files elsewhere persists them.
 */
export async function teardown(setup: SandboxSetup, logger: Logger = stderrLogger): Promise<void> {
    try {
        await setup.sandbox.close();
    } catch (err) {
        logger.warn(
            `could not clean up the sandbox: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
}
