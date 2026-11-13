// packages/meta/src/reporter.ts
//
// Keeps `finetune/USAGE.md` current while a meta agent session runs in a project that is being tuned.
// Main: `usageReporter(dir)` - reruns the shipped usage script on a timer and once at the end, detached.
// Used by: `command.ts` (`go()`, for run and resume) and `chat/run.ts` (`zen meta chat`).

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** How often a running meta agent rewrites the fine-tuning's usage report. */
const REPORT_EVERY_MS = 5 * 60_000;

/**
 * Rewrites `finetune/USAGE.md` on a timer and once more at the end, when the
 * project is being tuned. Detached and silent: the report is a by-product, and
 * neither its time nor its failure belongs to the run.
 */
export function usageReporter(dir: string): { stop(): void } {
    const script = join(dir, '.github/skills/zen-finetune/scripts/usage.mjs');
    if (!existsSync(join(dir, 'finetune')) || !existsSync(script)) {
        return { stop: () => undefined };
    }
    let running = false;
    const refresh = (): void => {
        if (running) {
            return;
        }
        running = true;
        const child = spawn(process.execPath, [script, '-q'], {
            cwd: dir,
            stdio: 'ignore',
            detached: true,
        });
        child.on('exit', () => (running = false));
        child.on('error', () => (running = false));
        child.unref();
    };
    const timer = setInterval(refresh, REPORT_EVERY_MS);
    timer.unref();
    return {
        stop: (): void => {
            clearInterval(timer);
            running = false;
            refresh();
        },
    };
}
