import type { SandboxSetup } from '@zenera/engine';
import { assertLocks, ensurePodmanReady } from './podman.ts';

/**
 * Images this process has already settled. A batch opens the same project
 * dozens of times at once, and without this each one shells out to podman and
 * the concurrent copies race each other to pull the very same image.
 */
const READY = new Set<string>();

/** The engine's preflight on a terminal: podman is offered for install and started if needed. */
export async function preflight(setup: SandboxSetup, yes?: boolean): Promise<void> {
    if (READY.has(setup.image)) {
        return;
    }
    await ensurePodmanReady({
        image: setup.image,
        build: setup.build,
        cpus: setup.spec.cpus,
        memory: setup.spec.memory,
        yes,
    });
    // A resumed session restarts its own stopped container, which needs no lock.
    await assertLocks(1, { reuses: setup.sandbox.name });
    READY.add(setup.image);
}
