// What the server can say about itself without being asked anything: `/api/status`, and the
// checks `zen server start` makes before it listens (`zen server check` prints them).
//   serverStatus  - versions, auth, sandbox, image identity, where users' things and the seed are
//   startupErrors - the reasons not to start: nowhere to run commands, the wrong image, a root
//                   that is not this server's
import { resolveBuild } from '@zenera/engine';
import { readProjectConfig } from '@zenera/neo';
import {
    IMAGE_BASE_ENV,
    IMAGE_BUILD_ENV,
    probeBwrap,
    runProcess,
    type ProcMode,
} from '@zenera/sandbox';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { settings, type ServerSettings } from './config.ts';
import { LAYOUT_VERSION, openLayout } from './layout.ts';
import { memorySeed } from './store.ts';
import { userStates } from './userState.ts';

export interface ServerStatus {
    server: string;
    zen: { engine?: string; neo?: string; sandbox?: string };
    node: string;
    project: { id: string; dir: string };
    /** jwt: the host's signed tokens; insecure: read, not checked */
    auth: ServerSettings['auth']['mode'];
    /** where it listens, host:port; unset before it does */
    listen?: string;
    debug: boolean;
    sandbox: {
        provider: string;
        /** bwrap: how commands get /proc, or why they cannot be isolated */
        proc?: ProcMode;
        ok: boolean;
        error?: string;
        hint?: string;
    };
    image: {
        /** what this container was built from (ZEN_IMAGE_BUILD / ZEN_IMAGE_BASE) */
        build?: string;
        base?: string;
        release?: string;
        /** what the project's sandbox config asks for */
        wants: { build?: string; image?: string };
        matches?: boolean;
        error?: string;
    };
    /** where every user's things are: users/<user>/{sessions,memory} */
    root: { dir: string; version?: number; supported: number; error?: string };
    /** what each user's memory starts as, when there is anything */
    memorySeed?: string;
    /** where users' data is kept, and how many are on this server now */
    state: { store: string; durable: boolean; users: number; draining: boolean };
}

const require = createRequire(import.meta.url);

function versionOf(pkg: string): string | undefined {
    try {
        const at = require.resolve(`${pkg}/package.json`);
        return (JSON.parse(readFileSync(at, 'utf8')) as { version: string }).version;
    } catch {
        return undefined;
    }
}

let listening: string | undefined;

/** Where the server listens, for the report. */
export function setListening(where: string | undefined): void {
    listening = where;
}

/** Whether podman answers: the machine running, on the platforms that have one. */
async function probePodman(): Promise<Pick<ServerStatus['sandbox'], 'ok' | 'error' | 'hint'>> {
    try {
        const info = await runProcess('podman', ['info', '--format', '{{.Host.OS}}'], {
            timeoutMs: 30_000,
        });
        if (info.code === 0) return { ok: true };
        return {
            ok: false,
            error: `podman is not responding: ${(info.stderr.trim() || `exit ${info.code}`).split('\n')[0]}`,
            hint: process.platform === 'linux' ? undefined : 'podman machine start',
        };
    } catch (err) {
        return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            hint: 'install podman, or run the server in the agent image (bwrap)',
        };
    }
}

export async function serverStatus(env: NodeJS.ProcessEnv = process.env): Promise<ServerStatus> {
    const s = settings();
    const sandbox: ServerStatus['sandbox'] = { provider: s.sandboxProvider, ok: true };
    if (s.sandbox === 'podman') {
        Object.assign(sandbox, await probePodman());
    } else if (s.sandbox === 'bwrap') {
        const probe = await probeBwrap();
        Object.assign(sandbox, {
            ok: probe.ok,
            proc: probe.proc,
            error: probe.error,
            hint: probe.hint,
        });
    }

    const image: ServerStatus['image'] = {
        build: env[IMAGE_BUILD_ENV]?.trim() || undefined,
        base: env[IMAGE_BASE_ENV]?.trim() || undefined,
        release: env.ZEN_RELEASE?.trim() || undefined,
        wants: {},
    };
    try {
        const { root, config } = readProjectConfig(s.projectDir);
        const build = resolveBuild(root, config.sandbox);
        image.wants = build ? { build: build.hash } : { image: config.sandbox?.image };
        if (image.build || image.base) {
            image.matches = build
                ? image.build === build.hash
                : image.base === (config.sandbox?.image ?? image.base);
        }
    } catch (err) {
        image.error = err instanceof Error ? err.message : String(err);
    }

    const root: ServerStatus['root'] = { dir: s.root, supported: LAYOUT_VERSION };
    try {
        root.version = openLayout(s.root, s.projectId, { create: false })?.version;
    } catch (err) {
        root.error = err instanceof Error ? err.message : String(err);
    }

    return {
        server: versionOf('@zenera/server') ?? 'unknown',
        zen: {
            engine: versionOf('@zenera/engine'),
            neo: versionOf('@zenera/neo'),
            sandbox: versionOf('@zenera/sandbox'),
        },
        node: process.versions.node,
        project: { id: s.projectId, dir: s.projectDir },
        auth: s.auth.mode,
        ...(listening ? { listen: listening } : {}),
        debug: s.debug,
        sandbox,
        image,
        root,
        ...(memorySeed() ? { memorySeed: memorySeed() } : {}),
        state: {
            store: s.stateStore?.name ?? 'local',
            durable: s.stateStore?.durable ?? false,
            users: userStates.size,
            draining: userStates.draining,
        },
    };
}

/** Why the server must not start, if anything. An image that was never labelled is not one. */
export function startupErrors(status: ServerStatus): string[] {
    const errors: string[] = [];
    if (!status.sandbox.ok) {
        errors.push(
            `commands have nowhere to run: ${status.sandbox.error}` +
                (status.sandbox.hint ? ` (${status.sandbox.hint})` : ''),
        );
    }
    if (status.image.error) errors.push(`the project cannot be read: ${status.image.error}`);
    if (status.root.error) errors.push(status.root.error);
    if (status.image.matches === false) {
        errors.push(
            `the image was built for another project environment: ${status.image.build ?? status.image.base}, ` +
                `the project asks for ${status.image.wants.build ?? status.image.wants.image} (rebuild it: zen image build)`,
        );
    }
    return errors;
}
