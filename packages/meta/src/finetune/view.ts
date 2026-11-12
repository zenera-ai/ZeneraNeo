import { liveHolder, type Lock, ownLock } from '@zenera/neo';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FINETUNE_DIR } from './tuning.ts';

// ---------------------------------------------------------------------------
// The tuning, live in a browser
//
// The project directory is served, not finetune/: STATUS.md links out to run
// directories under sessions/. finetune/view.json names the address while a
// process serves it, so status can print it and a second server is not started.
// ---------------------------------------------------------------------------

export interface Viewing {
    url: string;
    close(): Promise<void>;
}

type ViewLock = Lock & { url: string };

const lockFile = (projectDir: string): string => join(projectDir, FINETUNE_DIR, 'view.json');

/** The address another live process serves the tuning on, if one does. */
export function liveView(projectDir: string): string | undefined {
    return liveHolder<ViewLock>(lockFile(projectDir))?.url;
}

/** Serves the project, opening at STATUS.md, until `close`. */
export async function startView(projectDir: string): Promise<Viewing> {
    const { serveView } = await import('@zenera/view');
    const server = await serveView({ root: projectDir, start: `/${FINETUNE_DIR}/STATUS.md` });
    const file = lockFile(projectDir);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(ownLock({ url: server.url }), null, 2)}\n`);
    return {
        url: server.url,
        close: async () => {
            if (liveHolder<ViewLock>(file)?.pid === process.pid) {
                rmSync(file, { force: true });
            }
            await server.close();
        },
    };
}
