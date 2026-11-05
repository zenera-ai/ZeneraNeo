import { describe, expect, it } from 'vitest';
import { SandboxError, type Sandbox } from './contract.ts';
import type { FsDriver } from './fs.ts';
import { WORKSPACE_MOUNT } from './mounts.ts';

// ---------------------------------------------------------------------------
// The contract, as tests
//
// For whoever implements a sandbox or a filesystem driver: call these from a
// test file and the implementation is checked against the same expectations
// as the ones in this package. They are written against the interfaces only,
// so a driver over HTTP and a sandbox on a cluster run exactly what the disk
// driver and podman run.
//
//   import { describeFsDriver, describeSandbox } from '@zenera/sandbox/testing';
//   describeFsDriver('remote fs', () => ({ fs: new RemoteFs(url), root: '/workspace' }));
//   describeSandbox('remote', async () => ({ sandbox: open(...), root: '/ignored' }));
// ---------------------------------------------------------------------------

export interface FsUnderTest {
    fs: FsDriver;
    /** an existing, empty directory the suite may write under */
    root: string;
    cleanup?: () => void | Promise<void>;
}

/** What `FsDriver` promises, down to the error codes the file tools rely on. */
export function describeFsDriver(
    name: string,
    make: () => FsUnderTest | Promise<FsUnderTest>,
): void {
    describe(`FsDriver contract: ${name}`, () => {
        const withFs =
            (fn: (t: FsUnderTest, at: (...p: string[]) => string) => Promise<void>) => async () => {
                const t = await make();
                try {
                    await fn(t, (...p) => t.fs.path.join(t.root, ...p));
                } finally {
                    await t.cleanup?.();
                }
            };

        it(
            'writes, reads and stats a file under directories it makes',
            withFs(async ({ fs }, at) => {
                await fs.mkdirp(at('a', 'b'));
                await fs.writeFile(at('a', 'b', 'c.txt'), 'hello\n');
                expect((await fs.readFile(at('a', 'b', 'c.txt'))).toString()).toBe('hello\n');
                expect((await fs.readHead(at('a', 'b', 'c.txt'), 4)).toString()).toBe('hell');
                const info = await fs.stat(at('a', 'b', 'c.txt'));
                expect(info.isFile()).toBe(true);
                expect(info.isDirectory()).toBe(false);
                expect(info.size).toBe(6);
                expect((await fs.stat(at('a'))).isDirectory()).toBe(true);
                await fs.mkdirp(at('a', 'b'));
            }),
        );

        it(
            'lists a directory with each entry’s kind',
            withFs(async ({ fs }, at) => {
                await fs.mkdirp(at('d', 'sub'));
                await fs.writeFile(at('d', 'f.txt'), 'x');
                const entries = await fs.readdir(at('d'));
                const kinds = Object.fromEntries(
                    entries.map((e) => [
                        e.name,
                        e.isDirectory() ? 'dir' : e.isFile() ? 'file' : '?',
                    ]),
                );
                expect(kinds).toEqual({ sub: 'dir', 'f.txt': 'file' });
            }),
        );

        it(
            'moves, copies and removes, recursively when asked',
            withFs(async ({ fs }, at) => {
                await fs.mkdirp(at('src', 'deep'));
                await fs.writeFile(at('src', 'deep', 'f.txt'), 'one');
                await fs.copy(at('src'), at('copy'), { recursive: true });
                expect((await fs.readFile(at('copy', 'deep', 'f.txt'))).toString()).toBe('one');
                await fs.rename(at('copy'), at('moved'));
                await expect(fs.stat(at('copy'))).rejects.toMatchObject({ code: 'ENOENT' });
                expect((await fs.readFile(at('moved', 'deep', 'f.txt'))).toString()).toBe('one');
                await fs.rm(at('moved'), { recursive: true });
                await expect(fs.stat(at('moved'))).rejects.toMatchObject({ code: 'ENOENT' });
                await fs.rm(at('moved'), { force: true });
            }),
        );

        it(
            'fails with the code and path the file tools translate',
            withFs(async ({ fs }, at) => {
                await expect(fs.readFile(at('ghost.txt'))).rejects.toMatchObject({
                    code: 'ENOENT',
                    path: expect.stringContaining('ghost.txt'),
                });
                expect(() => fs.realpathSync(at('ghost', 'deeper'))).toThrow(
                    expect.objectContaining({ code: 'ENOENT' }),
                );
                expect(fs.realpathSync(at())).toBe(fs.realpathSync(at('.')));
            }),
        );
    });
}

export interface SandboxUnderTest {
    sandbox: Sandbox;
    /** the workspace the sandbox was opened with, in the host's terms */
    root: string;
    cleanup?: () => void | Promise<void>;
}

/**
 * What `Sandbox` promises: commands run, jobs outlive the call that started
 * them, and — the invariant — a file written through `fs` is the file `exec`
 * sees, and the reverse. Needs a real shell, so for podman it is a live test.
 */
export function describeSandbox(
    name: string,
    make: () => SandboxUnderTest | Promise<SandboxUnderTest>,
    opts: { timeout?: number } = {},
): void {
    const timeout = opts.timeout ?? 120_000;
    describe(`Sandbox contract: ${name}`, () => {
        const withSandbox = (fn: (t: SandboxUnderTest) => Promise<void>) => async () => {
            const t = await make();
            try {
                await fn(t);
            } finally {
                await t.sandbox.close();
                await t.cleanup?.();
            }
        };

        it(
            'runs a command, and reports its exit code and output',
            withSandbox(async ({ sandbox }) => {
                const ok = await sandbox.exec('echo out; echo err >&2');
                expect(ok).toMatchObject({ exit_code: 0, stdout: 'out\n', stderr: 'err\n' });
                expect((await sandbox.exec('exit 3')).exit_code).toBe(3);
                expect(sandbox.started).toBe(true);
            }),
            timeout,
        );

        it(
            'shows a command the files `fs` wrote, and `fs` the files a command wrote',
            withSandbox(async ({ sandbox, root }) => {
                const view = sandbox.files({ root, mount: WORKSPACE_MOUNT });
                const fs = view.fs!;
                await fs.writeFile(fs.path.join(view.root, 'from-fs.txt'), 'written by fs\n');
                expect((await sandbox.exec('cat from-fs.txt')).stdout).toBe('written by fs\n');

                await sandbox.exec('mkdir -p out && printf "by exec" > out/from-exec.txt');
                const back = await fs.readFile(fs.path.join(view.root, 'out', 'from-exec.txt'));
                expect(back.toString()).toBe('by exec');
            }),
            timeout,
        );

        it(
            'keeps a job running past the call that started it, and stops it',
            withSandbox(async ({ sandbox }) => {
                const id = await sandbox.startJob('echo started; sleep 30');
                let out = await sandbox.readJob(id);
                for (let i = 0; i < 20 && !out.output.includes('started'); i++) {
                    await new Promise((r) => setTimeout(r, 250));
                    out = await sandbox.readJob(id);
                }
                expect(out).toMatchObject({ job_id: id, running: true });
                expect(out.output).toContain('started');
                expect(await sandbox.stopJob(id)).toMatchObject({ job_id: id, stopped: true });
                await expect(sandbox.readJob('job-unknown')).rejects.toBeInstanceOf(SandboxError);
            }),
            timeout,
        );

        it(
            'prepares its image without starting, once however often it is asked',
            withSandbox(async ({ sandbox }) => {
                await Promise.all([sandbox.prepare(), sandbox.prepare()]);
                await sandbox.prepare();
                expect(sandbox.started).toBe(false);
                expect((await sandbox.exec('echo ready')).stdout).toBe('ready\n');
            }),
            timeout,
        );

        it(
            'is free to close, and closes once',
            withSandbox(async ({ sandbox }) => {
                await sandbox.exec('true');
                await sandbox.close();
                expect(sandbox.started).toBe(false);
            }),
            timeout,
        );
    });
}
