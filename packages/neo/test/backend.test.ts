import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { rememberFile } from '../src/memory/files.ts';
import { Workspace, fileTools, type WorkspaceOptions } from '../src/tools/files.ts';
import {
    InMemoryFs,
    inSandboxPaths,
    localFs,
    logicalMounts,
    PodmanSandbox,
    podmanSandbox,
    SandboxError,
    type ExecOptions,
    type ExecResult,
    type FsDriver,
    type JobOutput,
    type JobStopped,
    type Sandbox,
    type SandboxOptions,
} from '@zenera/sandbox';
import { sandboxTools } from '../src/tools/sandbox.ts';
import type { ToolContext } from '../src/types.ts';

// ---------------------------------------------------------------------------
// One contract, every backend
//
// The file tools and the sandbox tools are written against two seams — where
// the bytes are (`FsDriver`) and where commands run (`Sandbox`). Each behaviour
// below is asserted once and run against every implementation, so a backend
// that passes here is one the tools cannot tell apart from `zen run`.
// ---------------------------------------------------------------------------

interface Tree {
    fs: FsDriver;
    /** the workspace root and one read-only tree beside it, in the driver's namespace */
    root: string;
    assets: string;
    seed(at: string, body: string): void;
    cleanup(): void;
}

const trees: [string, () => Tree][] = [
    [
        'this machine’s disk',
        () => {
            const base = realpathSync(mkdtempSync(join(tmpdir(), 'zen-contract-')));
            const root = join(base, 'ws');
            const assets = join(base, 'assets');
            mkdirSync(root);
            mkdirSync(assets);
            return {
                fs: localFs,
                root,
                assets,
                seed: (at, body) => {
                    mkdirSync(join(at, '..'), { recursive: true });
                    writeFileSync(at, body);
                },
                cleanup: () => rmSync(base, { recursive: true, force: true }),
            };
        },
    ],
    [
        'a filesystem in memory',
        () => {
            const fs = new InMemoryFs().dir('/workspace').dir('/assets');
            return {
                fs,
                root: '/workspace',
                assets: '/assets',
                seed: (at, body) => void fs.writeFile(at, body),
                cleanup: () => undefined,
            };
        },
    ],
];

describe.each(trees)('the file tools on %s', (_, make) => {
    const t = make();
    afterAll(() => t.cleanup());
    t.seed(join(t.assets, 'guide.md'), 'read me\n');

    const opts: WorkspaceOptions = {
        root: t.root,
        mount: '/workspace',
        mounts: [{ host: t.assets, at: '/assets', source: { kind: 'assets' } }],
        fs: t.fs,
    };
    const tools = fileTools(opts);
    const call = async (name: string, args: unknown): Promise<any> =>
        await tools.find((x) => x.name === name)!.execute(args, {} as never);

    it('writes and reads one file under both of its names', async () => {
        await call('write_file', { path: '/workspace/src/a.ts', content: 'one\ntwo\n' });
        expect(await call('read_file', { path: 'src/a.ts' })).toMatchObject({
            path: '/workspace/src/a.ts',
            lines: 2,
            content: 'one\ntwo',
        });
    });

    it('lists with formats and line counts', async () => {
        const out = await call('list_dir', { path: '/workspace/src' });
        expect(out.entries).toEqual([
            { name: 'a.ts', kind: 'file', bytes: 8, format: 'text', lines: 2 },
        ]);
        expect((await call('list_dir', {})).entries.map((e: any) => e.name)).toEqual([
            '/workspace',
            '/assets',
        ]);
    });

    it('applies a patch whole or not at all', async () => {
        const good = await call('apply_patch', {
            patch: [
                '*** Begin Patch',
                '*** Update File: src/a.ts',
                '*** Move to: src/b.ts',
                ' one',
                '-two',
                '+three',
                '*** Add File: notes.md',
                '+hello',
                '*** End Patch',
            ].join('\n'),
        });
        expect(good).toMatchObject({ applied: 2 });
        expect((await call('read_file', { path: 'src/b.ts' })).content).toBe('one\nthree');

        const bad = await call('apply_patch', {
            patch: [
                '*** Begin Patch',
                '*** Delete File: notes.md',
                '*** Update File: src/b.ts',
                '-not there',
                '+x',
                '*** End Patch',
            ].join('\n'),
        });
        expect(bad.error).toMatch(/does not match/);
        expect((await call('read_file', { path: 'notes.md' })).content).toBe('hello');
    });

    it('copies out of a read-only tree but never writes into one', async () => {
        expect(await call('copy_file', { from: '/assets/guide.md', to: 'guide.md' })).toMatchObject(
            { to: '/workspace/guide.md', copied: true },
        );
        await expect(call('write_file', { path: '/assets/x.md', content: 'x' })).rejects.toThrow(
            /\/assets is read-only/,
        );
        await expect(call('delete_file', { path: '/assets/guide.md' })).rejects.toThrow(
            /read-only/,
        );
    });

    it('refuses to climb out', async () => {
        await expect(call('read_file', { path: '../../etc/passwd' })).rejects.toThrow(/outside/);
        await expect(call('read_file', { path: '/workspace/../../etc' })).rejects.toThrow(
            /outside/,
        );
    });

    it('moves, finds and deletes across the tree', async () => {
        await call('move_file', { from: 'guide.md', to: 'docs/guide.md' });
        const found = await call('find_files', { pattern: 'guide' });
        expect(found.matches.sort()).toEqual(['/assets/guide.md', '/workspace/docs/guide.md']);
        expect(await call('delete_file', { path: 'docs' })).toMatchObject({
            error: expect.stringContaining('is a directory'),
        });
        expect(await call('delete_file', { path: 'docs', recursive: true })).toMatchObject({
            deleted: true,
        });
    });

    it('reports a missing file by the name the model used', async () => {
        await expect(call('read_file', { path: 'ghost.txt' })).rejects.toThrow(
            '/workspace/ghost.txt does not exist',
        );
    });

    it('hands memory a file it can copy without knowing where the bytes are', async () => {
        const ws = new Workspace(opts);
        const memory = mkdtempSync(join(tmpdir(), 'zen-contract-mem-'));
        try {
            const file = await rememberFile(memory, ws.source('src/b.ts'), 'ID1');
            expect(file).toMatchObject({ path: 'ID1.ts', format: 'ts', bytes: 10 });
        } finally {
            rmSync(memory, { recursive: true, force: true });
        }
    });
});

// ---------------------------------------------------------------------------
// The sandbox
// ---------------------------------------------------------------------------

/**
 * A sandbox with nothing on this machine: it runs nothing — it records what it
 * was asked and answers from a script — and keeps its files in a map, named
 * by where the container would have them.
 */
class FakeSandbox implements Sandbox {
    readonly name: string;
    readonly fs = new InMemoryFs().dir('/workspace');
    readonly calls: string[] = [];
    started = false;
    closed = false;
    readonly #jobs = new Map<string, string>();

    constructor(readonly opts: SandboxOptions) {
        this.name = `fake-${opts.key}-${opts.image ?? 'default'}`;
    }

    files(opts: WorkspaceOptions): WorkspaceOptions {
        return inSandboxPaths(opts, this.fs);
    }

    async start(): Promise<void> {
        this.started = true;
    }

    async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
        await this.start();
        this.calls.push(command);
        return { exit_code: 0, stdout: `ran in ${opts.cwd ?? '.'}`, stderr: '', duration_ms: 0 };
    }

    async startJob(command: string): Promise<string> {
        await this.start();
        const id = `job-${this.#jobs.size + 1}`;
        this.#jobs.set(id, command);
        return id;
    }

    async readJob(id: string, from = 1): Promise<JobOutput> {
        const command = this.#command(id);
        return {
            job_id: id,
            command,
            running: true,
            duration_ms: 0,
            start_line: from,
            end_line: from - 1,
            lines: 0,
            output: '',
        };
    }

    async stopJob(id: string): Promise<JobStopped> {
        this.#command(id);
        return { job_id: id, stopped: this.#jobs.delete(id) };
    }

    #command(id: string): string {
        const command = this.#jobs.get(id);
        if (command === undefined) {
            throw new SandboxError(`no such job: ${id}`);
        }
        return command;
    }

    async close(): Promise<void> {
        this.closed = true;
        this.started = false;
    }
}

describe('the sandbox tools on a sandbox of another kind', () => {
    const tc = (agent: string) => ({ agent: { name: agent } }) as ToolContext;

    it('run in the one sandbox, whichever agent calls', async () => {
        const sandbox = new FakeSandbox({ key: 's1', root: '/workspace' });
        const [run, background, read, stop] = sandboxTools(sandbox);

        expect(await run.execute({ command: 'ls', cwd: 'src' }, tc('a'))).toMatchObject({
            exit_code: 0,
            stdout: 'ran in src',
        });
        const job = (await background.execute({ command: 'serve' }, tc('b'))) as any;
        expect(await read.execute({ job_id: job.job_id }, tc('a'))).toMatchObject({
            command: 'serve',
            running: true,
        });
        expect(await stop.execute({ job_id: job.job_id }, tc('a'))).toMatchObject({
            stopped: true,
        });
        expect(await read.execute({ job_id: job.job_id }, tc('a'))).toEqual({
            error: `no such job: ${job.job_id}`,
            hint: undefined,
        });
        expect(sandbox.calls).toEqual(['ls']);
        expect(sandbox.started).toBe(true);
    });

    it('get a podman sandbox on this machine’s disk by default', async () => {
        const sandbox = podmanSandbox({ key: 'k', root: '/host/ws', image: 'python' });
        expect(sandbox).toBeInstanceOf(PodmanSandbox);
        expect(sandbox.fs).toBe(localFs);
        expect((sandbox as PodmanSandbox).spec.image).toBe('python');
        await sandbox.close();
    });
});

describe('logical mounts', () => {
    it('merge the skill folders into one tree and keep what each mount is', () => {
        expect(
            logicalMounts([
                { host: '/h/assets', at: '/assets', readOnly: true, source: { kind: 'assets' } },
                { host: '/h/s/a', at: '/skills/a', readOnly: true, source: { kind: 'skills' } },
                { host: '/h/s/b', at: '/skills/b', readOnly: true, source: { kind: 'skills' } },
                { host: '/h/home', at: '/home/agent', source: { kind: 'home' } },
            ]),
        ).toEqual([
            { at: '/assets', readOnly: true, source: { kind: 'assets' } },
            { at: '/skills', readOnly: true, source: { kind: 'skills' } },
            { at: '/home/agent', readOnly: false, source: { kind: 'home' } },
        ]);
    });

    it('refuse a host directory nobody said the meaning of', () => {
        expect(() => logicalMounts([{ host: '/h/x', at: '/x' }])).toThrow(/no source/);
    });
});

describe('the file tools’ view of a sandbox', () => {
    const opts: WorkspaceOptions = {
        root: '/host/session/ws',
        mount: '/workspace',
        mounts: [
            { host: '/host/p/assets', at: '/assets', readOnly: true, source: { kind: 'assets' } },
            { host: '/host/p/s/a', at: '/skills/a', readOnly: true, source: { kind: 'skills' } },
            { host: '/host/p/s/b', at: '/skills/b', readOnly: true, source: { kind: 'skills' } },
        ],
    };

    it('reads host directories where a podman sandbox binds them', () => {
        expect(podmanSandbox({ key: 'k', root: opts.root }).files(opts)).toEqual({
            ...opts,
            fs: localFs,
        });
    });

    it('names everything by where the box has it when nothing is bound', () => {
        const sandbox = new FakeSandbox({ key: 'k', root: opts.root });
        const fs = sandbox.fs;
        const view = sandbox.files(opts);
        expect(view).toEqual({
            root: '/workspace',
            mount: '/workspace',
            mounts: [
                { host: '/assets', at: '/assets', readOnly: true, source: { kind: 'assets' } },
                { host: '/skills', at: '/skills', readOnly: true, source: { kind: 'skills' } },
            ],
            fs,
        });
    });
});
