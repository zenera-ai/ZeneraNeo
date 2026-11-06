import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
    BwrapSandbox,
    bwrapArgs,
    buildIdentity,
    hiddenArgs,
    probeBwrap,
    rootArgs,
    SandboxError,
    type HostTree,
    type ProcOptions,
    type Runner,
} from '../src/index.ts';

// A host root as a map: a directory lists its entries, a string is a symlink's target.
function fakeTree(entries: Record<string, string[] | string | null>): HostTree {
    return {
        kind: (p) => {
            const e = entries[p];
            if (e === undefined) return 'missing';
            if (e === null) return 'file';
            return typeof e === 'string' ? 'symlink' : 'dir';
        },
        list: (p) => (entries[p] as string[]) ?? [],
        link: (p) => entries[p] as string,
    };
}

const tree = fakeTree({
    '/': ['bin', 'dev', 'etc', 'home', 'opt', 'proc', 'run', 'state', 'tmp', 'usr'],
    '/bin': 'usr/bin',
    '/dev': [],
    '/etc': ['passwd'],
    '/etc/passwd': null,
    '/home': ['zen'],
    '/home/zen': [],
    '/opt': [],
    '/proc': [],
    '/run': ['lock', 'secrets'],
    '/run/lock': [],
    '/run/secrets': ['token'],
    '/state': [],
    '/tmp': [],
    '/usr': [],
});

describe('rootArgs', () => {
    it('binds every top-level entry read-only, recreates symlinks, leaves out what is omitted', () => {
        const args = rootArgs(tree, [], ['/proc', '/dev', '/tmp', '/state']);
        expect(args).toEqual([
            '--symlink', 'usr/bin', '/bin',
            '--ro-bind', '/etc', '/etc',
            '--ro-bind', '/home', '/home',
            '--ro-bind', '/opt', '/opt',
            '--ro-bind', '/run', '/run',
            '--ro-bind', '/usr', '/usr',
        ]); // prettier-ignore
    });

    it('opens a directory only for a mount point it lacks, and covers what is hidden in one', () => {
        const args = rootArgs(tree, ['/home/agent', '/workspace'], ['/run/secrets']).join(' ');
        expect(args).toContain('--dir /home --ro-bind /home/zen /home/zen');
        expect(args).toContain('--ro-bind /run /run');
        expect(args).toContain('--ro-bind /etc /etc');
        expect(hiddenArgs(tree, ['/state', '/run/secrets', '/etc/passwd', '/tmp/x'])).toEqual([
            '--tmpfs', '/run/secrets',
            '--ro-bind', '/dev/null', '/etc/passwd',
        ]); // prettier-ignore
    });

    it('does not open a directory whose mount point exists', () => {
        const args = rootArgs(tree, ['/home/zen'], []).join(' ');
        expect(args).toContain('--ro-bind /home /home');
    });
});

describe('bwrapArgs', () => {
    const base = {
        tree,
        hidden: ['/state'],
        binds: [{ at: '/workspace', host: '/state/ws', readOnly: false }],
        proc: 'fresh' as const,
        network: 'bridge' as const,
        strict: false,
        cwd: '/workspace',
        command: ['/bin/sh', '-s'],
    };

    it('mounts its own /dev, /proc and /tmp, then the binds, then runs the command', () => {
        const args = bwrapArgs(base);
        const at = (flag: string, path: string) =>
            args.findIndex((a, i) => a === flag && args[i + 2] === path);
        expect(args.slice(0, 2)).toEqual(['--unshare-user', '--die-with-parent']);
        expect(args).toContain('--unshare-pid');
        expect(args).not.toContain('--unshare-net');
        expect(args.join(' ')).toContain('--dev-bind /dev /dev --proc /proc --tmpfs /tmp');
        expect(at('--bind', '/workspace')).toBeGreaterThan(args.indexOf('--tmpfs'));
        expect(args).not.toContain('--remount-ro');
        expect(args.slice(-5)).toEqual(['--chdir', '/workspace', '--', '/bin/sh', '-s']);
    });

    it('binds the container’s /proc when a fresh one cannot be mounted', () => {
        expect(bwrapArgs({ ...base, proc: 'bind' }).join(' ')).toContain('--ro-bind /proc /proc');
    });

    it('takes the network away, caps /tmp and drops capabilities under strict', () => {
        const args = bwrapArgs({ ...base, network: 'none', strict: true }).join(' ');
        expect(args).toContain('--unshare-net');
        expect(args).toContain('--cap-drop ALL');
        expect(args).toMatch(/--size \d+ --tmpfs \/tmp/);
    });

    it('sets a numeric user', () => {
        expect(bwrapArgs({ ...base, user: { uid: '1000' } }).join(' ')).toContain(
            '--uid 1000 --gid 1000',
        );
    });
});

// A runner that records what it was asked and answers like a bwrap that works.
function recorder(answer: (args: readonly string[]) => number = () => 0) {
    const calls: { bin: string; args: readonly string[]; opts?: ProcOptions }[] = [];
    const run: Runner = async (bin, args, opts) => {
        calls.push({ bin, args, opts });
        return { code: answer(args), stdout: '', stderr: '', truncated: false, timedOut: false };
    };
    return { calls, run };
}

let n = 0;
const fakeBwrap = () => `/fake/bwrap-${n++}`;

describe('probeBwrap', () => {
    it('prefers a fresh /proc, falls back to binding it, and is asked once', async () => {
        const { calls, run } = recorder((args) => (args.includes('--proc') ? 1 : 0));
        const bin = fakeBwrap();
        const probe = await probeBwrap(bin, run);
        expect(probe).toMatchObject({ ok: true, bwrap: bin, proc: 'bind' });
        await probeBwrap(bin, run);
        expect(calls).toHaveLength(2);
    });

    it('says why bwrap cannot isolate anything', async () => {
        const run: Runner = async () => ({
            code: 1,
            stdout: '',
            stderr: 'bwrap: setting up uid map: Permission denied\n',
            truncated: false,
            timedOut: false,
        });
        const probe = await probeBwrap(fakeBwrap(), run);
        expect(probe.ok).toBe(false);
        expect(probe.error).toBe('bwrap: setting up uid map: Permission denied');
        expect(probe.hint).toMatch(/user namespaces/);
    });
});

describe('BwrapSandbox', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'zen-bwrap-unit-')));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it('starts bwrap with exactly the command’s environment, and the command on stdin', async () => {
        const { calls, run } = recorder();
        const box = new BwrapSandbox(
            {
                root: dir,
                key: 't',
                env: { HOME: '/home/agent' },
                secrets: ['API_KEY', 'UNSET_KEY'],
                execEnv: { ZEN_USER_ID: 'u1' },
                execPaths: { PYTHONPATH: ['/home/agent/.zenera/python'] },
            },
            {
                bwrap: fakeBwrap(),
                exec: run,
                image: false,
                env: {
                    PATH: '/usr/bin:/bin',
                    LANG: 'C.UTF-8',
                    API_KEY: 'k',
                    SERVER_SECRET: 'no',
                    PYTHONPATH: '/image/lib',
                },
            },
        );
        const res = await box.exec('echo hi', { cwd: 'sub' });
        expect(res.exit_code).toBe(0);
        const call = calls.at(-1)!;
        expect(call.bin).toBe('/bin/sh');
        expect(call.args[1]).toMatch(/oom_score_adj/);
        expect(call.opts?.input).toBe('echo hi');
        expect(call.opts?.env).toEqual({
            PATH: '/usr/bin:/bin',
            LANG: 'C.UTF-8',
            HOME: '/home/agent',
            API_KEY: 'k',
            ZEN_USER_ID: 'u1',
            PYTHONPATH: '/home/agent/.zenera/python',
        });
        expect(call.args).toContain('/workspace/sub');
        await box.close();
    });

    it('hides /state and /run/secrets whatever else a host hides, and covers /dev/shm', async () => {
        const { calls, run } = recorder();
        const box = new BwrapSandbox(
            { root: dir, key: 't' },
            {
                bwrap: fakeBwrap(),
                exec: run,
                image: false,
                hidden: ['/opt'],
                tree: fakeTree({
                    '/': ['dev', 'opt', 'run', 'state', 'usr'],
                    '/dev': ['shm'],
                    '/dev/shm': [],
                    '/opt': [],
                    '/run': ['secrets'],
                    '/run/secrets': [],
                    '/state': [],
                    '/usr': [],
                }),
            },
        );
        await box.exec('true');
        const args = calls.at(-1)!.args.join(' ');
        expect(args).not.toContain('--ro-bind /state');
        expect(args).not.toContain('--ro-bind /opt');
        expect(args).toContain('--tmpfs /run/secrets');
        expect(args).toContain('--dev-bind /dev /dev --tmpfs /dev/shm');
        await box.close();
    });

    it('turns bwrap’s own failure into a SandboxError', async () => {
        let first = true;
        const run: Runner = async () => {
            const probe = first;
            first = false;
            return probe
                ? { code: 0, stdout: '', stderr: '', truncated: false, timedOut: false }
                : {
                      code: 1,
                      stdout: '',
                      stderr: 'bwrap: Can’t mount tmpfs on /newroot/tmp\n',
                      truncated: false,
                      timedOut: false,
                  };
        };
        const box = new BwrapSandbox(
            { root: dir, key: 't' },
            { bwrap: fakeBwrap(), exec: run, image: false },
        );
        await expect(box.exec('true')).rejects.toBeInstanceOf(SandboxError);
        await box.close();
    });

    it('refuses a path outside the workspace and a user name', () => {
        const box = new BwrapSandbox({ root: dir, key: 't' }, { image: false });
        expect(() => box.inside('../etc')).toThrow(SandboxError);
        expect(() => new BwrapSandbox({ root: dir, key: 't', user: 'agent' })).toThrow(
            /numeric user/,
        );
    });

    describe('prepare', () => {
        const ctx = join(dir, 'ctx');
        mkdirSync(ctx, { recursive: true });
        writeFileSync(join(ctx, 'Dockerfile'), 'FROM docker.io/library/python:3.14-slim\n');
        const build = { dockerfile: join(ctx, 'Dockerfile'), context: ctx };
        const hash = buildIdentity(build).hash;

        it('accepts the image the project’s Dockerfile hashes to, and nothing else', async () => {
            const ok = new BwrapSandbox({ root: dir, key: 't', build }, { image: { build: hash } });
            await ok.prepare();
            expect(ok.started).toBe(false);

            const stale = new BwrapSandbox(
                { root: dir, key: 't', build },
                { image: { build: 'abc' } },
            );
            await expect(stale.prepare()).rejects.toThrow(/another sandbox Dockerfile/);

            const based = new BwrapSandbox(
                { root: dir, key: 't', build },
                { image: { base: 'x' } },
            );
            await expect(based.prepare()).rejects.toThrow(/ZEN_IMAGE_BUILD/);

            // A container zen image build did not make is not checked.
            await new BwrapSandbox({ root: dir, key: 't', build }, { env: {} }).prepare();
        });

        it('compares an `image:` with the image the container was based on', async () => {
            const image = 'docker.io/library/node:24';
            await new BwrapSandbox(
                { root: dir, key: 't', image },
                { image: { base: image } },
            ).prepare();
            await expect(
                new BwrapSandbox(
                    { root: dir, key: 't', image },
                    { image: { base: 'docker.io/library/python:3.14-slim' } },
                ).prepare(),
            ).rejects.toThrow(/the project asks for/);
        });
    });
});
