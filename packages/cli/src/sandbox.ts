import type { SandboxSetup } from '@zenera/engine';
import { PodmanSandbox } from '@zenera/neo';
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
