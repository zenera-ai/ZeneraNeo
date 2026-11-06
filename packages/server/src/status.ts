// What the server can say about itself without being asked anything: `/api/status`, and the
// checks `zen server start` makes before it listens (`zen server check` prints them).
//   serverStatus  - versions, sandbox, image identity, state layout
//   startupErrors - the reasons not to start: no isolation, the wrong image, an unknown layout
import { resolveBuild } from '@zenera/engine';
import { readProjectConfig } from '@zenera/neo';
import { IMAGE_BASE_ENV, IMAGE_BUILD_ENV, probeBwrap, type ProcMode } from '@zenera/sandbox';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { settings, type ServerSettings } from './config.ts';
import { openState, STATE_VERSION, type StateInfo } from './state.ts';

export interface ServerStatus {
    server: string;
    zen: { engine?: string; neo?: string; sandbox?: string };
    node: string;
    project: { id: string; dir: string };
    user?: string;
    auth: ServerSettings['auth']['mode'];
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
    /** `version` absent and no error: not created yet (the server writes it on start) */
    state: { dir: string; version?: number; supported: number; error?: string };
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

export async function serverStatus(env: NodeJS.ProcessEnv = process.env): Promise<ServerStatus> {
    const s = settings();
    const sandbox: ServerStatus['sandbox'] = { provider: s.sandboxProvider, ok: true };
    if (s.sandbox !== 'podman' && s.sandboxProvider.startsWith('bwrap')) {
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

    const state: ServerStatus['state'] = { dir: s.stateDir, supported: STATE_VERSION };
    try {
        state.version = openState(s.stateDir, s, { create: false })?.version;
    } catch (err) {
        state.error = err instanceof Error ? err.message : String(err);
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
        ...(s.userId ? { user: s.userId } : {}),
        auth: s.auth.mode,
        debug: s.debug,
        sandbox,
        image,
        state,
    };
}

/** Why the server must not start, if anything. An image that was never labelled is not one. */
export function startupErrors(status: ServerStatus): string[] {
    const errors: string[] = [];
    if (!status.sandbox.ok) {
        errors.push(
            `commands cannot be isolated: ${status.sandbox.error}` +
                (status.sandbox.hint ? ` (${status.sandbox.hint})` : ''),
        );
    }
    if (status.image.error) errors.push(`the project cannot be read: ${status.image.error}`);
    if (status.image.matches === false) {
        errors.push(
            `the image was built for another project environment: ${status.image.build ?? status.image.base}, ` +
                `the project asks for ${status.image.wants.build ?? status.image.wants.image} (rebuild it: zen image build)`,
        );
    }
    if (status.state.error) errors.push(status.state.error);
    return errors;
}

export type { StateInfo };
