import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------------------
// Fetching the browser this package drives
//
// Chromium's headless shell for the Playwright this package depends on, through Playwright's own
// installer, into its default place (or PLAYWRIGHT_BROWSERS_PATH). The sandbox base image does
// the same at build time; this is for a person's machine.
//
// Main: installBrowser.
// Used by: @zenera/cli `zen page install`.
// ---------------------------------------------------------------------------

/** Installs the headless shell (and, as root on Linux, the libraries it needs); its exit code. */
export function installBrowser(): number {
    const require = createRequire(import.meta.url);
    const cli = join(dirname(require.resolve('playwright-core/package.json')), 'cli.js');
    const args = [cli, 'install', '--only-shell', 'chromium'];
    if (process.platform === 'linux' && process.getuid?.() === 0) args.splice(2, 0, '--with-deps');
    return spawnSync(process.execPath, args, { stdio: 'inherit' }).status ?? 1;
}
