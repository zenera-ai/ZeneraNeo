import {
    DEFAULT_SANDBOX_IMAGE,
    GATEWAY_URL_ENV,
    SANDBOX_GROUP,
    SandboxPool,
    WORKSPACE_MOUNT,
    identityEnv,
    podmanBackend,
    isIdentityEnv,
    type AgentProject,
    type ProjectConfig,
    type RunIdentity,
    type SandboxBackend,
    type SandboxConfig,
    type Mount,
    type SandboxSpec,
} from '@zenera/neo';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stderrLogger, type Logger } from './errors.ts';
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
    pool: SandboxPool;
    /** where the boxes run and the files live; podman on this machine for `zen run` */
    backend: SandboxBackend;
    /** the resolved base spec, for `zn sandbox status` and the image pre-warm */
    spec: SandboxSpec;
    /** where the workspace is in the box, and so the name the file tools answer with */
    workdir: string;
    image: string;
    /** the Dockerfile behind `image`, when it came from one */
    build?: ResolvedBuild;
    /** host side of the container's `$HOME`, created only if it is ever needed */
    home: string;
    /** every tree bound into the container besides the workspace itself */
    mounts: readonly Mount[];
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
    /** `false` overrides every `persist:` in the config, the agents' included */
    persist?: boolean;
    /**
     * Who the run is acting for. Set on every command as `ZEN_USER_*`, never
     * on the container — see `execEnv` in the library for why.
     */
    identity?: RunIdentity;
    /** where the boxes run; podman on this machine when unset */
    backend?: SandboxBackend;
}

export function buildSandbox(opts: SandboxInputs): SandboxSetup {
    // An explicit --image is an answer, so there is nothing left to build.
    const build = opts.image ? undefined : resolveBuild(opts.root, opts.config.sandbox);
    const base = {
        ...(opts.config.sandbox ?? {}),
        ...((opts.image ?? build?.tag) ? { image: opts.image ?? build?.tag } : {}),
        ...(opts.keys === false ? { keys: false } : {}),
        ...(opts.persist === false ? { persist: false } : {}),
    };
    const home = join(opts.session.data, 'sandbox', 'home');

    const mounts: Mount[] = [
        { host: home, at: HOME, source: { kind: 'home' } },
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

    const agents: Record<string, SandboxSpec> = {};
    for (const agent of opts.config.agents) {
        if (agent.sandbox) {
            const merged = merge(base, agent.sandbox);
            if (opts.persist === false) {
                merged.persist = false;
            }
            // An agent that opts out gets neither the variables nor the mount,
            // but the mount is on the pool and cannot be taken back per agent —
            // so the variable is what actually decides, and without it the file
            // sitting there is not a credential anything will look for.
            const own = merged.keys === false ? undefined : keys;
            agents[agent.name] = toSpec(
                merged,
                { HOME, PYTHONDONTWRITEBYTECODE: '1', ZENERA_AGENT: '1', ...(own?.env ?? {}) },
                own && secretsOf(own.secrets, opts.env),
            );
        }
    }

    const backend = opts.backend ?? podmanBackend;
    const pool = new SandboxPool({
        ...spec,
        agents,
        newBox: backend.newBox,
        root: opts.workspace,
        key: opts.session.id,
        readOnly: opts.readOnly,
        mounts,
        execEnv: identityEnv(opts.identity),
        execPaths: RUNTIME_PATHS,
    });

    return {
        pool,
        backend,
        spec,
        workdir: spec.workdir ?? WORKSPACE_MOUNT,
        image: spec.image ?? DEFAULT_SANDBOX_IMAGE,
        build,
        home,
        mounts,
    };
}

/**
 * An agent's overrides on the project's block. `image` and `build` answer the
 * same question, so naming either one drops the other: a plain spread would
 * leave an agent's `image` sitting next to the project's `build`, and the
 * schema forbids exactly that combination when it is written down.
 */
function merge(base: SandboxConfig, agent: SandboxConfig): SandboxConfig {
    const merged = { ...base, ...agent };
    if (agent.image !== undefined) {
        delete merged.build;
    }
    if (agent.build !== undefined) {
        delete merged.image;
    }
    return merged;
}

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
    return [...new Set([...secrets, ...(env ?? [])])].filter((name) => !isIdentityEnv(name));
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
        if (value !== undefined && value !== '' && !isIdentityEnv(name)) {
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

/**
 * Where the container's `$HOME` lives must exist before podman mounts it — and
 * the `zenera` libraries go into it, written fresh on every open so they match
 * the engine that set the variables they read.
 */
export function prepareHome(setup: SandboxSetup): void {
    mkdirSync(setup.home, { recursive: true });
    installRuntime(setup.home);
}

// ---------------------------------------------------------------------------
// The `zenera` libraries
//
// What generated code calls to ask who it is running for. Python and Node,
// because those are what agents write; anything else reads `ZEN_USER_*`.
//
// They live in the home the container already mounts, not in a mount of their
// own: a new mount would rename every container that already exists, and a
// persisted one would lose what it had installed. Each language is put where
// its interpreter looks without being told — `require` searches
// `$HOME/.node_modules` on its own — except Python, which has no such place
// that does not depend on the version, so its directory is put in front of
// `PYTHONPATH` on every command, ahead of whatever the image set.
// ---------------------------------------------------------------------------

/** The packaged sources, beside `src/` and `dist/` alike. */
const RUNTIME_SOURCE = fileURLToPath(new URL('../runtime/', import.meta.url));

/** Where each one lands, inside the container. */
export const RUNTIME_PYTHON = `${HOME}/.zenera/python`;
export const RUNTIME_NODE = `${HOME}/.node_modules/zenera`;

const RUNTIME_PATHS = { PYTHONPATH: [RUNTIME_PYTHON] };

function installRuntime(home: string): void {
    const inside = (path: string): string => join(home, relative(HOME, path));
    for (const [from, to] of [
        ['python', RUNTIME_PYTHON],
        ['node', RUNTIME_NODE],
    ] as const) {
        const target = inside(to);
        rmSync(target, { recursive: true, force: true });
        cpSync(join(RUNTIME_SOURCE, from), target, { recursive: true });
    }
}

/** Best-effort teardown: losing a container must never lose a run. */
export async function teardown(pool: SandboxPool, logger: Logger = stderrLogger): Promise<void> {
    try {
        await pool.dispose();
    } catch (err) {
        logger.warn(
            `could not clean up the sandbox: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
}
