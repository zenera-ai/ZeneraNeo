import {
    machineSandboxProvider,
    type ResolvedBuild,
    type SandboxProvider,
    type SandboxSetup,
} from '@zenera/engine';
import { PodmanSandbox, type SandboxConfig } from '@zenera/neo';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asCliError, assertLocks, ensurePodmanReady, terminalProgress } from './podman.ts';

/**
 * Images this process has already settled. A batch opens the same project
 * dozens of times at once, and without this each one asks podman for its
 * machine and its locks all over again.
 */
const READY = new Set<string>();

/**
 * The engine's preflight on a terminal. For podman: the engine is offered for
 * install and started if needed, and its lock table checked. For any sandbox:
 * its image is pulled or built now, with progress, rather than silently at the
 * first command of the turn.
 */
export async function preflight(setup: SandboxSetup, yes?: boolean): Promise<void> {
    if (setup.sandbox instanceof PodmanSandbox && !READY.has(setup.image)) {
        await ensurePodmanReady({ cpus: setup.spec.cpus, memory: setup.spec.memory, yes });
        // A resumed session restarts its own stopped container, which needs no lock.
        await assertLocks(1, { reuses: setup.sandbox.name });
        READY.add(setup.image);
    }
    try {
        await setup.sandbox.prepare(terminalProgress());
    } catch (err) {
        throw asCliError(err);
    }
}

/**
 * Gets a project's image ready on the sandbox a plugin provides: what `zen init`
 * and `zen sandbox up|pull` do instead of building in podman, so the image is
 * built where the sandboxes will run it. Answers with the provider's
 * description, or undefined when no plugin provides the sandbox.
 *
 * The sandbox is opened on a temporary directory and never started:
 * `prepare` is the whole of it.
 */
export async function prepareOnProvider(
    project: { dir: string; name: string },
    config: SandboxConfig | undefined,
    build: ResolvedBuild | undefined,
    opts: { force?: boolean; warn?: (message: string) => void } = {},
): Promise<string | undefined> {
    const found = await machineSandboxProvider(project, config, {
        warn: opts.warn ?? (() => undefined),
    });
    if (!found) {
        return undefined;
    }
    try {
        await prepareOn(found.provider, config, build, opts);
        return found.provider.describe;
    } finally {
        await Promise.resolve(found.plugin.close?.()).catch(() => undefined);
    }
}

/** `prepareOnProvider` with the provider already in hand. */
export async function prepareOn(
    provider: SandboxProvider,
    config: SandboxConfig | undefined,
    build: ResolvedBuild | undefined,
    opts: { force?: boolean } = {},
): Promise<void> {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'zen-prepare-')));
    try {
        const box = provider.newSandbox({
            key: 'prepare',
            root,
            image: config?.image,
            build: build ? { dockerfile: build.dockerfile, context: build.context } : undefined,
            env: {},
            persist: false,
        });
        try {
            await box.prepare({ ...terminalProgress(), force: opts.force });
        } catch (err) {
            throw asCliError(err);
        } finally {
            await box.close().catch(() => undefined);
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}
