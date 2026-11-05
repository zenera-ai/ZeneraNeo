import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { RootedFs } from '../src/index.ts';
import { describeFsDriver } from '../src/testing.ts';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'zen-rooted-')));
const outside = realpathSync(mkdtempSync(join(tmpdir(), 'zen-rooted-out-')));
afterAll(() => {
    rmSync(base, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
});

let n = 0;
describeFsDriver('RootedFs', () => {
    const dir = join(base, `t${n++}`);
    mkdirSync(dir);
    return { fs: new RootedFs([{ at: '/workspace', dir }]), root: '/workspace' };
});

describe('RootedFs containment', () => {
    const ws = join(base, 'ws');
    const assets = join(base, 'assets');
    mkdirSync(ws);
    mkdirSync(assets);
    writeFileSync(join(assets, 'ref.md'), 'reference');
    writeFileSync(join(outside, 'secret.txt'), 'no');
    symlinkSync(outside, join(ws, 'out'));
    symlinkSync(assets, join(ws, 'to-assets'));
    const fs = new RootedFs([
        { at: '/workspace', dir: ws },
        { at: '/assets', dir: assets, readOnly: true },
    ]);

    it('serves each tree under its own name', async () => {
        await fs.writeFile('/workspace/a.txt', 'a');
        expect((await fs.readFile('/assets/ref.md')).toString()).toBe('reference');
        expect(fs.hostPath('/workspace/a.txt')).toBe(join(ws, 'a.txt'));
        expect(fs.agentPath(join(assets, 'ref.md'))).toBe('/assets/ref.md');
    });

    it('refuses what is in no tree, by name or by climbing', async () => {
        for (const at of ['/etc/passwd', '/workspace/../etc/passwd', '/workspacex/a']) {
            await expect(fs.readFile(at)).rejects.toMatchObject({ code: 'EACCES' });
        }
        await expect(fs.readFile('relative.txt')).rejects.toMatchObject({ code: 'EINVAL' });
    });

    it('does not follow a symlink out of the trees', async () => {
        await expect(fs.readFile('/workspace/out/secret.txt')).rejects.toMatchObject({
            code: 'EACCES',
            path: '/workspace/out/secret.txt',
        });
        await expect(fs.writeFile('/workspace/out/new.txt', 'x')).rejects.toMatchObject({
            code: 'EACCES',
        });
    });

    it('refuses to change a read-only tree, directly or through a link', async () => {
        await expect(fs.writeFile('/assets/x.md', 'x')).rejects.toMatchObject({ code: 'EROFS' });
        await expect(fs.rm('/assets/ref.md')).rejects.toMatchObject({ code: 'EROFS' });
        await expect(fs.writeFile('/workspace/to-assets/x.md', 'x')).rejects.toMatchObject({
            code: 'EROFS',
        });
        expect((await fs.readFile('/workspace/to-assets/ref.md')).toString()).toBe('reference');
    });

    it('names a failure by the agent’s path, never this machine’s', async () => {
        const err = await fs.readFile('/workspace/ghost.txt').catch((e: Error) => e);
        expect(err).toMatchObject({ code: 'ENOENT', path: '/workspace/ghost.txt' });
        expect(String((err as Error).message)).not.toContain(base);
    });
});
