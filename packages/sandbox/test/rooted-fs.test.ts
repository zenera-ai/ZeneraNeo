import {
    existsSync,
    linkSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
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
    writeFileSync(join(assets, 'linked.md'), 'linked');
    writeFileSync(join(outside, 'secret.txt'), 'no');
    writeFileSync(join(outside, 'hard-link-target.txt'), 'no');
    symlinkSync(outside, join(ws, 'out'));
    symlinkSync(assets, join(ws, 'to-assets'));
    linkSync(join(outside, 'secret.txt'), join(ws, 'secret'));
    symlinkSync(join(outside, 'missing-file.txt'), join(ws, 'link-to-missing-file'));
    symlinkSync(join(outside, 'secret.txt'), join(ws, 'to-secret-link'));
    writeFileSync(join(ws, 'payload.md'), 'payload');
    linkSync(join(outside, 'hard-link-target.txt'), join(ws, 'hard-link-out'));
    linkSync(join(assets, 'linked.md'), join(ws, 'hard-link-to-assets'));
    symlinkSync(join(assets, 'planted.md'), join(ws, 'link-to-missing-asset'));
    symlinkSync(
        relative(ws, join(outside, 'relative-escape.txt')),
        join(ws, 'link-by-relative-path'),
    );

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

    /**
     * Expected to fail: the path check follows symlinks, and a hard link is
     * not one. The workspace sees an ordinary file of its own, while the
     * bytes belong to a file outside every tree, or to one in a tree that
     * refuses writes.
     */
    it.fails('does not reach a file outside the trees through a hard link', async () => {
        await expect.soft(fs.readFile('/workspace/secret')).rejects.toMatchObject({
            code: 'EACCES',
        });
        await expect.soft(fs.writeFile('/workspace/hard-link-out', 'yes')).rejects.toMatchObject({
            code: 'EACCES',
        });
        await expect
            .soft(fs.writeFile('/workspace/hard-link-to-assets', 'tampered'))
            .rejects.toMatchObject({ code: 'EROFS' });

        expect.soft(readFileSync(join(outside, 'hard-link-target.txt'), 'utf8')).toBe('no');
        expect.soft(readFileSync(join(assets, 'linked.md'), 'utf8')).toBe('linked');
    });

    /**
     * Expected to fail: with no target to follow, the check falls back to the
     * directory holding the link and finds it inside. The write then follows
     * the link out: to an absolute target, to a relative one, and into the
     * read-only tree.
     */
    it.fails('does not write outside the trees through a broken symlink', async () => {
        await expect
            .soft(fs.writeFile('/workspace/link-to-missing-file', 'yes'))
            .rejects.toMatchObject({ code: 'EACCES' });
        await expect
            .soft(fs.writeFile('/workspace/link-by-relative-path', 'yes'))
            .rejects.toMatchObject({ code: 'EACCES' });
        await expect
            .soft(fs.writeFile('/workspace/link-to-missing-asset', 'planted'))
            .rejects.toMatchObject({ code: 'EROFS' });

        expect.soft(existsSync(join(outside, 'missing-file.txt'))).toBe(false);
        expect.soft(existsSync(join(outside, 'relative-escape.txt'))).toBe(false);
        expect.soft(existsSync(join(assets, 'planted.md'))).toBe(false);
    });

    it('does not write outside the trees through a symlink destination', async () => {
        await expect(fs.writeFile('/workspace/to-secret-link', 'yes')).rejects.toMatchObject({
            code: 'EACCES',
        });
        await expect(
            fs.copy('/workspace/payload.md', '/workspace/to-secret-link'),
        ).rejects.toMatchObject({ code: 'EACCES' });
        await expect(
            fs.rename('/workspace/payload.md', '/workspace/to-secret-link'),
        ).rejects.toMatchObject({ code: 'EACCES' });
        expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('no');
    });

    it('refuses a path that became a link out of the trees since the last call', async () => {
        await fs.writeFile('/workspace/notes.txt', 'first');
        rmSync(join(ws, 'notes.txt'));
        symlinkSync(join(outside, 'secret.txt'), join(ws, 'notes.txt'));

        await expect(fs.writeFile('/workspace/notes.txt', 'second')).rejects.toMatchObject({
            code: 'EACCES',
        });
        expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('no');
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
