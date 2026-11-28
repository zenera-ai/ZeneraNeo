import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ProcessSandbox } from '../src/index.ts';

// ProcessSandbox: commands as plain child processes, for code already inside a sandbox.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'zen-process-sandbox-')));
mkdirSync(join(root, 'sub'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('ProcessSandbox', () => {
    it('runs in its root, or a cwd under it, with the paths put in front', async () => {
        const box = new ProcessSandbox({
            root,
            env: { PATH: process.env.PATH, PYTHONPATH: '/image/own' },
            execPaths: { PYTHONPATH: ['/opt/runtime'] },
        });
        const here = await box.exec('pwd; echo "$PYTHONPATH"');
        expect(here.exit_code).toBe(0);
        expect(here.stdout.trim().split('\n')).toEqual([root, '/opt/runtime:/image/own']);
        expect((await box.exec('pwd', { cwd: 'sub' })).stdout.trim()).toBe(join(root, 'sub'));
    });

    it('stops a command at its timeout, and every command on close', async () => {
        const box = new ProcessSandbox({ root });
        const slow = await box.exec('sleep 5', { timeout: 0.2 });
        expect(slow.timed_out).toBe(true);
        const running = box.exec('sleep 5');
        await box.close();
        const ended = await running;
        expect(ended.exit_code).not.toBe(0);
        expect(ended.duration_ms).toBeLessThan(4000);
    });
});
