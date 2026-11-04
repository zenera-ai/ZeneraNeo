import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { systemClock } from '../src/ids.ts';
import { MEMORY_MOUNT, forgetFile, hostPath, rememberFile } from '../src/memory/files.ts';
import { MemoryIndex } from '../src/memory/index.ts';
import { FILES_DIR, MemoryStore } from '../src/memory/store.ts';
import { memoryTools } from '../src/memory/tools.ts';
import { MemoryError } from '../src/memory/types.ts';
import { Workspace } from '../src/tools/files.ts';
import { MemoryFs } from '../src/tools/memfs.ts';
import { MEMORY_COPY_FILE_TOOL, type ToolContext } from '../src/types.ts';

const SCRIPT = 'print("risky ports")\n';

describe('remembering a file', () => {
    let dir: string;
    let work: string;
    let source: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'neo-memfiles-'));
        work = await mkdtemp(join(tmpdir(), 'neo-work-'));
        source = join(work, 'audit.py');
        await writeFile(source, SCRIPT);
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
        await rm(work, { recursive: true, force: true });
    });

    it('copies the bytes under the node id and names them by the mount', async () => {
        const file = await rememberFile(dir, source, 'ID1');
        expect(file.path).toBe(`${MEMORY_MOUNT}/ID1.py`);
        expect(file.format).toBe('py');
        expect(file.bytes).toBe(Buffer.byteLength(SCRIPT));
        expect(await readFile(join(dir, FILES_DIR, 'ID1.py'), 'utf8')).toBe(SCRIPT);
    });

    it('survives the workspace it came from', async () => {
        const file = await rememberFile(dir, source, 'ID1');
        await rm(work, { recursive: true, force: true });
        expect(await readFile(hostPath(dir, file), 'utf8')).toBe(SCRIPT);
    });

    it('digests the copy that was kept', async () => {
        const file = await rememberFile(dir, source, 'ID1');
        const { createHash } = await import('node:crypto');
        expect(file.sha256).toBe(createHash('sha256').update(SCRIPT).digest('hex'));
    });

    it('keeps a file with no extension, without a trailing dot', async () => {
        const plain = join(work, 'Makefile');
        await writeFile(plain, 'all:\n');
        const file = await rememberFile(dir, plain, 'ID2');
        expect(file.path).toBe(`${MEMORY_MOUNT}/ID2`);
        expect(file.format).toBe('');
    });

    it('drops an extension it will not put in a filename', async () => {
        const odd = join(work, 'weird.p y!');
        await writeFile(odd, 'x');
        expect((await rememberFile(dir, odd, 'ID3')).format).toBe('');
    });

    it('refuses a file over the limit', async () => {
        const big = join(work, 'big.bin');
        await writeFile(big, Buffer.alloc(64));
        await expect(rememberFile(dir, big, 'ID4', { maxBytes: 32 })).rejects.toThrow(MemoryError);
    });

    it('refuses a directory and a path that is not there', async () => {
        await expect(rememberFile(dir, work, 'ID5')).rejects.toThrow(/not a regular file/);
        await expect(rememberFile(dir, join(work, 'nope.py'), 'ID6')).rejects.toThrow(
            /does not exist/,
        );
    });

    it('names the passed path in the error when provided', async () => {
        await expect(
            rememberFile(dir, join(work, 'nope.py'), 'ID6', { path: '/workspace/nope.py' }),
        ).rejects.toThrow(/\/workspace\/nope\.py does not exist/);
    });

    it('resolves a stored path back through the files directory only', async () => {
        const file = await rememberFile(dir, source, 'ID7');
        const escaped = { ...file, path: '/memory/../../etc/passwd' };
        expect(hostPath(dir, escaped)).toBe(join(dir, FILES_DIR, 'passwd'));
    });

    it('forgets the bytes, and forgetting twice is not an error', async () => {
        const file = await rememberFile(dir, source, 'ID8');
        await forgetFile(dir, file);
        await expect(readFile(hostPath(dir, file))).rejects.toThrow();
        await expect(forgetFile(dir, file)).resolves.toBeUndefined();
    });

    it('copies through a symlink rather than storing the link', async () => {
        const link = join(work, 'link.py');
        await symlink(source, link);
        const file = await rememberFile(dir, link, 'ID9');
        await rm(work, { recursive: true, force: true });
        expect(await readFile(hostPath(dir, file), 'utf8')).toBe(SCRIPT);
    });
});

describe('the memory_copy_file tool', () => {
    let dir: string;
    let work: string;
    let index: MemoryIndex;
    let ids: Record<string, string>;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'neo-memfiles-'));
        work = await mkdtemp(join(tmpdir(), 'neo-work-'));
        await writeFile(join(work, 'audit.py'), SCRIPT);
        index = new MemoryIndex({ store: await MemoryStore.open(dir) });
        ({ ids } = await index.commit(
            {
                nodes: [
                    {
                        ref: 'script',
                        kind: 'file',
                        text: 'audit script',
                        file: { source: join(work, 'audit.py') },
                    },
                    { ref: 'fact', kind: 'fact', text: 'ports 22 and 3389 are risky' },
                    {
                        ref: 'secret',
                        kind: 'file',
                        text: 'theirs',
                        audience: ['other'],
                        file: { source: join(work, 'audit.py') },
                    },
                ],
            },
            { clock: systemClock, sees: ['*'], writes: ['solo', 'other'] },
        ));
    });

    afterEach(async () => {
        index.store.release();
        await rm(dir, { recursive: true, force: true });
        await rm(work, { recursive: true, force: true });
    });

    function copier(ws?: Workspace, access: 'read' | 'full' = 'read') {
        const [tool] = memoryTools({
            index,
            binding: { access, sees: ['solo'], writes: ['solo'] },
        }).filter((t) => t.name === MEMORY_COPY_FILE_TOOL);
        const tc = {
            services: {
                clock: systemClock,
                writeFile:
                    ws &&
                    ((p: string, d: Uint8Array, o?: { overwrite?: boolean }) => ws.write(p, d, o)),
            },
        } as unknown as ToolContext;
        return async (args: Record<string, unknown>): Promise<any> => await tool.execute(args, tc);
    }

    it('is offered to an agent that can only read memory', () => {
        const names = memoryTools({
            index,
            binding: { access: 'read', sees: ['*'], writes: [] },
        }).map((t) => t.name);
        expect(names).toContain(MEMORY_COPY_FILE_TOOL);
    });

    it('copies under the file’s own name by default', async () => {
        const out = await copier(new Workspace({ root: work, mount: '/workspace' }))({
            id: ids.script,
        });
        expect(out).toEqual({
            id: ids.script,
            path: `/workspace/${ids.script}.py`,
            bytes: Buffer.byteLength(SCRIPT),
            copied: true,
        });
        expect(await readFile(join(work, `${ids.script}.py`), 'utf8')).toBe(SCRIPT);
    });

    it('does the same into a workspace that is not on this disk', async () => {
        const fs = new MemoryFs().dir('/workspace');
        const out = await copier(new Workspace({ root: '/workspace', mount: '/workspace', fs }))({
            id: ids.script,
            to: 'tools/audit.py',
        });
        expect(out.path).toBe('/workspace/tools/audit.py');
        expect((await fs.readFile('/workspace/tools/audit.py')).toString()).toBe(SCRIPT);
    });

    it('keeps what is already there unless told to replace it', async () => {
        const copy = copier(new Workspace({ root: work }));
        const first = await copy({ id: ids.script, to: 'audit.py' });
        expect(first.error).toMatch(/already exists/);
        expect(await copy({ id: ids.script, to: 'audit.py', overwrite: true })).toMatchObject({
            copied: true,
        });
    });

    it('stays inside a writable workspace', async () => {
        expect(
            (await copier(new Workspace({ root: work }))({ id: ids.script, to: '../out.py' }))
                .error,
        ).toMatch(/outside/);
        expect(
            (await copier(new Workspace({ root: work, readOnly: true }))({ id: ids.script })).error,
        ).toMatch(/read-only/);
    });

    it('answers a hidden node exactly as a missing one', async () => {
        const copy = copier(new Workspace({ root: work }));
        const hidden = await copy({ id: ids.secret });
        const missing = await copy({ id: 'NOPE' });
        expect(hidden.error).toBe(`no memory ${ids.secret}`);
        expect(missing.error).toBe('no memory NOPE');
    });

    it('says when a node holds no file, or there is nowhere to put one', async () => {
        expect((await copier(new Workspace({ root: work }))({ id: ids.fact })).error).toMatch(
            /holds no file/,
        );
        expect((await copier()({ id: ids.script })).error).toMatch(/no workspace/);
    });
});
