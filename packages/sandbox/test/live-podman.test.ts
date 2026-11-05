import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { DEFAULT_SANDBOX_IMAGE, podmanSandbox, runProcess } from '../src/index.ts';
import { describeSandbox } from '../src/testing.ts';

// The sandbox contract against a real podman. It self-skips when no engine
// answers, like the other live tests do without their credentials.
const IMAGE = process.env.ZEN_LIVE_SANDBOX_IMAGE ?? DEFAULT_SANDBOX_IMAGE;

async function ready(): Promise<boolean> {
    try {
        const info = await runProcess('podman', ['info', '--format', '{{.Host.OS}}'], {
            timeoutMs: 30_000,
        });
        if (info.code !== 0) {
            return false;
        }
        const has = await runProcess('podman', ['image', 'exists', IMAGE], { timeoutMs: 60_000 });
        return (
            has.code === 0 ||
            (await runProcess('podman', ['pull', IMAGE], { timeoutMs: 600_000 })).code === 0
        );
    } catch {
        return false;
    }
}

if (await ready()) {
    describeSandbox('podman', () => {
        const root = realpathSync(mkdtempSync(join(tmpdir(), 'zen-sandbox-contract-')));
        return {
            sandbox: podmanSandbox({ root, key: 'contract', image: IMAGE }),
            root,
            cleanup: () => rmSync(root, { recursive: true, force: true }),
        };
    });
} else {
    describe.skip('Sandbox contract: podman (no engine answered)', () => {
        it('runs against a real podman', () => undefined);
    });
}
