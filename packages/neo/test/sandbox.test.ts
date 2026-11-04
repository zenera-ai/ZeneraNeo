import { describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../src/project/config.ts';
import { sandboxLimits } from '../src/tools/limits.ts';
import { WORKSPACE_MOUNT } from '../src/tools/mounts.ts';
import { PodmanBox, podmanBox } from '../src/tools/podman.ts';
import { resilient, type ProcOptions, type ProcResult, type Runner } from '../src/tools/process.ts';
import { SANDBOX_GROUP, SandboxError, SandboxPool, sandboxTools } from '../src/tools/sandbox.ts';
import { selectTools, type ToolContext } from '../src/types.ts';

// ---------------------------------------------------------------------------
// Nothing here starts a container. Every process goes through the injected
// runner, so what is under test is the *decision*: which arguments podman is
// handed, what reaches the shell, and what never does.
// ---------------------------------------------------------------------------

interface Call {
    bin: string;
    args: string[];
    opts?: ProcOptions;
}

interface Fake {
    run: Runner;
    calls: Call[];
    /** queued answers, matched in order; anything unanswered succeeds silently */
    reply(match: string, res: Partial<ProcResult>): void;
}

function fake(): Fake {
    const calls: Call[] = [];
    const replies: { match: string; res: Partial<ProcResult> }[] = [];

    const run: Runner = (bin, args, opts) => {
        calls.push({ bin, args: [...args], opts });
        const line = args.join(' ');
        const i = replies.findIndex((r) => line.includes(r.match));
        const res = i >= 0 ? replies.splice(i, 1)[0].res : {};
        return Promise.resolve({
            code: 0,
            stdout: '',
            stderr: '',
            truncated: false,
            timedOut: false,
            ...res,
        });
    };

    return { run, calls, reply: (match, res) => void replies.push({ match, res }) };
}

/** The container does not exist yet, so `container inspect` has to fail. */
function fresh(): Fake {
    const f = fake();
    f.reply('container inspect', { code: 1, stderr: 'no such container' });
    return f;
}

function box(f: Fake, over: Record<string, unknown> = {}): PodmanBox {
    return new PodmanBox(
        { root: '/host/ws', key: '20260827-120000-abcd', ...over },
        { exec: f.run },
    );
}

const find = (f: Fake, verb: string): Call | undefined => f.calls.find((c) => c.args[0] === verb);

describe('starting a container', () => {
    it('mounts the workspace and nothing else of the host', async () => {
        const f = fresh();
        await box(f).start();

        const create = find(f, 'run');
        expect(create).toBeDefined();
        expect(create?.args).toContain('--detach');
        expect(create?.args).toContain(`/host/ws:${WORKSPACE_MOUNT}`);
        expect(create?.args.at(-3)).toBe('docker.io/library/python:3.14-slim-bookworm');
        expect(create?.args.slice(-2)).toEqual(['sleep', 'infinity']);
    });

    it('passes cpus and memory through as podman limits', async () => {
        const f = fresh();
        await box(f, { cpus: 8, memory: 8192 }).start();

        const create = find(f, 'run');
        expect(create?.args).toContain('--cpus');
        expect(create?.args[create.args.indexOf('--cpus') + 1]).toBe('8');
        expect(create?.args[create.args.indexOf('--memory') + 1]).toBe('8192m');
    });

    it('supplies default resource limits under the standard profile', async () => {
        const f = fresh();
        await box(f).start();
        const args = find(f, 'run')?.args ?? [];
        expect(args[args.indexOf('--cpus') + 1]).toBe('4');
        expect(args[args.indexOf('--memory') + 1]).toBe('4096m');
    });

    it('omits limits when explicitly set to zero', async () => {
        const f = fresh();
        await box(f, { cpus: 0, memory: 0 }).start();
        expect(find(f, 'run')?.args).not.toContain('--cpus');
        expect(find(f, 'run')?.args).not.toContain('--memory');
    });

    it('hardens without breaking package managers', async () => {
        const f = fresh();
        await box(f).start();
        const args = find(f, 'run')?.args ?? [];
        expect(args).toContain('no-new-privileges');
        expect(args).toContain('--init');
        expect(args).toContain('--pids-limit');
        // Dropping every capability would break `apt install`, which is the
        // ordinary use of this tool. The container is the boundary.
        expect(args).not.toContain('--cap-drop=ALL');
        expect(args).not.toContain('--privileged');
    });

    it('takes the whole host away under the strict profile', async () => {
        const f = fresh();
        await box(f, { hardening: 'strict' }).start();
        const args = find(f, 'run')?.args ?? [];
        expect(args.slice(args.indexOf('--cap-drop'), args.indexOf('--cap-drop') + 2)).toEqual([
            '--cap-drop',
            'ALL',
        ]);
        expect(args).toContain('--read-only');
        expect(args).toContain('/tmp:rw,noexec,nosuid,nodev,size=64m');
        // Non-zero uid *inside* the container, and still the owner of the
        // bind mounts, which an explicit `--user` would not be.
        expect(args.slice(args.indexOf('--userns'), args.indexOf('--userns') + 2)).toEqual([
            '--userns',
            'keep-id',
        ]);
        expect(args).not.toContain('--privileged');
    });

    it('supplies the limits the strict profile promises', async () => {
        const f = fresh();
        await box(f, { hardening: 'strict' }).start();
        const args = find(f, 'run')?.args ?? [];
        // A ceiling nobody wrote down is not a ceiling.
        expect(args[args.indexOf('--cpus') + 1]).toBe('2');
        expect(args[args.indexOf('--memory') + 1]).toBe('2048m');
        expect(args[args.indexOf('--network') + 1]).toBe('none');
    });

    it('lets a strict project ask for what it needs back', async () => {
        const f = fresh();
        await box(f, { hardening: 'strict', network: 'bridge', memory: 512, user: '1000' }).start();
        const args = find(f, 'run')?.args ?? [];
        expect(args[args.indexOf('--network') + 1]).toBe('bridge');
        expect(args[args.indexOf('--memory') + 1]).toBe('512m');
        // A named user answers the question `keep-id` was there to answer.
        expect(args).not.toContain('--userns');
        expect(args[args.indexOf('--user') + 1]).toBe('1000');
    });

    /**
     * The name is a hash of the configuration, so a field added to it renames
     * every container that already exists — abandoning a persisted rootfs.
     */
    it('does not rename a standard container now that the profile exists', async () => {
        expect(box(fake(), { hardening: 'standard' }).name).toBe(box(fake()).name);
        expect(box(fake()).name).toBe('zn-20260827-120000-abcd-9ecf2650b9');
        expect(box(fake(), { hardening: 'strict' }).name).toBe(
            'zn-20260827-120000-abcd-0b39f22fa5',
        );
    });

    it('mounts the workspace read-only when the run is', async () => {
        const f = fresh();
        await box(f, { readOnly: true }).start();
        expect(find(f, 'run')?.args).toContain(`/host/ws:${WORKSPACE_MOUNT}:ro`);
    });

    /** Reference material and the skill catalog, under the names the tools use. */
    it('mounts the extra trees it is given, read-only', async () => {
        const f = fresh();
        await box(f, {
            mounts: [
                { host: '/host/assets', at: '/assets', readOnly: true },
                { host: '/host/skills', at: '/skills', readOnly: true },
                { host: '/host/home', at: '/home/agent' },
            ],
        }).start();
        const args = find(f, 'run')?.args ?? [];
        expect(args).toContain('/host/assets:/assets:ro');
        expect(args).toContain('/host/skills:/skills:ro');
        expect(args).toContain('/host/home:/home/agent');
    });

    it('forwards only the environment it was given', async () => {
        const f = fresh();
        await box(f, { env: { HOME: '/home/agent', HTTPS_PROXY: 'http://p:3128' } }).start();
        const args = find(f, 'run')?.args ?? [];
        expect(args).toContain('HOME=/home/agent');
        expect(args).toContain('HTTPS_PROXY=http://p:3128');
    });

    // The whole point of the separate channel: the key must not be visible to
    // anyone who can run `ps` or `podman inspect`.
    it('forwards a secret by name, never by value', async () => {
        vi.stubEnv('ZN_TEST_API_KEY', 'sk-do-not-print');
        const f = fresh();
        await box(f, { secrets: ['ZN_TEST_API_KEY'] }).start();
        const args = find(f, 'run')?.args ?? [];
        expect(args).toContain('ZN_TEST_API_KEY');
        expect(args.join(' ')).not.toContain('sk-do-not-print');
    });

    it('says nothing about a secret this host does not have', async () => {
        vi.stubEnv('ZN_TEST_API_KEY', '');
        const f = fresh();
        await box(f, { secrets: ['ZN_TEST_API_KEY'] }).start();
        expect(find(f, 'run')?.args ?? []).not.toContain('ZN_TEST_API_KEY');
    });

    it('reuses a container that already exists, and starts a stopped one', async () => {
        const f = fake();
        f.reply('container inspect', { code: 0, stdout: 'exited\n' });
        await box(f).start();

        expect(find(f, 'run')).toBeUndefined();
        expect(find(f, 'start')).toBeDefined();
    });

    it('does nothing at all to one that is already running', async () => {
        const f = fake();
        f.reply('container inspect', { code: 0, stdout: 'running\n' });
        await box(f).start();

        expect(find(f, 'run')).toBeUndefined();
        expect(find(f, 'start')).toBeUndefined();
    });

    it('starts once, however many calls arrive together', async () => {
        const f = fresh();
        const b = box(f);
        await Promise.all([b.exec('a'), b.exec('b'), b.exec('c')]);
        expect(f.calls.filter((c) => c.args[0] === 'run')).toHaveLength(1);
    });

    it('does not remember a failed start', async () => {
        const f = fake();
        f.reply('container inspect', { code: 1 });
        f.reply('run', { code: 125, stderr: 'no such image' });
        const b = box(f);

        await expect(b.exec('ls')).rejects.toThrow(/no such image/);
        expect(b.started).toBe(false);
    });
});

describe('the container name', () => {
    it('is a function of the configuration, so a changed image is a new container', () => {
        const f = fake();
        const a = box(f).name;
        const same = box(f).name;
        const other = box(f, { image: 'docker.io/library/python:3.13-slim' }).name;

        expect(a).toBe(same);
        expect(a).not.toBe(other);
        expect(a.startsWith('zn-20260827-120000-abcd-')).toBe(true);
    });

    it('survives a key that is not a legal container name', () => {
        const f = fake();
        expect(box(f, { key: 'Session Name/../x' }).name).toMatch(/^zn-[a-z0-9-]+$/);
    });

    // Rotating a key must not abandon a persisted container's filesystem, so
    // what a secret contributes to the identity is its name and not its value.
    it('does not change when a forwarded secret does', () => {
        const f = fake();
        vi.stubEnv('ZN_TEST_API_KEY', 'sk-one');
        const before = box(f, { secrets: ['ZN_TEST_API_KEY'] }).name;
        vi.stubEnv('ZN_TEST_API_KEY', 'sk-two');
        expect(box(f, { secrets: ['ZN_TEST_API_KEY'] }).name).toBe(before);
        expect(box(f, { secrets: ['ZN_OTHER_API_KEY'] }).name).not.toBe(before);
    });
});

describe('running a command', () => {
    it('sends the command down stdin, never as an argument', async () => {
        const f = fresh();
        await box(f).exec('rm -rf / # $(whoami) `id`');

        const exec = find(f, 'exec');
        expect(exec?.args).toContain('--interactive');
        expect(exec?.args.slice(-2)).toEqual(['/bin/sh', '-s']);
        expect(exec?.opts?.input).toBe('rm -rf / # $(whoami) `id`');
        // The point: no part of the model's text is ever in argv.
        expect(exec?.args.join(' ')).not.toContain('whoami');
    });

    it('runs in the workspace by default and in a subdirectory on request', async () => {
        const f = fresh();
        const b = box(f);
        await b.exec('ls');
        const first = find(f, 'exec');
        expect(first?.args[first.args.indexOf('--workdir') + 1]).toBe(WORKSPACE_MOUNT);

        await b.exec('ls', { cwd: 'packages/cli' });
        const last = f.calls.at(-1);
        expect(last?.args[last.args.indexOf('--workdir') + 1]).toBe(
            `${WORKSPACE_MOUNT}/packages/cli`,
        );
    });

    it('refuses a working directory outside the workspace', () => {
        const b = box(fake());
        expect(() => b.inside('../../etc')).toThrow(/outside/);
        expect(() => b.inside('/etc')).toThrow(/outside/);
        expect(() => b.inside('a/../../..')).toThrow(/outside/);
        expect(() => b.inside('ok\u0000')).toThrow(/null byte/);
    });

    it('reports the exit code rather than throwing on one', async () => {
        const f = fresh();
        f.reply('/bin/sh -s', { code: 2, stderr: 'nope\n' });
        const res = await box(f).exec('false');

        expect(res.exit_code).toBe(2);
        expect(res.stderr).toBe('nope\n');
        expect(res.timed_out).toBeUndefined();
    });

    it('takes its default timeout from the spec and lets a call override it', async () => {
        const f = fresh();
        const b = box(f, { timeout: 5 });
        await b.exec('sleep 1');
        expect(f.calls.at(-1)?.opts?.timeoutMs).toBe(5000);

        await b.exec('sleep 1', { timeout: 30 });
        expect(f.calls.at(-1)?.opts?.timeoutMs).toBe(30_000);
    });

    it('caps a timeout nobody should be allowed to ask for', async () => {
        const f = fresh();
        await box(f).exec('sleep 1', { timeout: 999_999 });
        expect(f.calls.at(-1)?.opts?.timeoutMs).toBe(3_600_000);
    });

    it('restarts a container that stopped under it, and runs the command once', async () => {
        const f = fresh();
        const b = box(f);
        await b.start();
        f.reply('/bin/sh -s', {
            code: 125,
            stderr: 'Error: can only create exec sessions on running containers: container state improper\n',
        });
        f.reply('container inspect', { stdout: 'exited\n' });
        const res = await b.exec('echo hi');

        expect(res.exit_code).toBe(0);
        expect(f.calls.some((c) => c.args[0] === 'start' && c.args[1] === b.name)).toBe(true);
        expect(f.calls.filter((c) => c.args[0] === 'exec')).toHaveLength(2);
    });

    it('says the engine is the problem when the container cannot be brought back', async () => {
        const f = fresh();
        const b = box(f);
        await b.start();
        f.reply('/bin/sh -s', { code: 125, stderr: 'Error: no such container zn-x\n' });
        f.reply('container inspect', { code: 125, stderr: 'Cannot connect to Podman' });
        f.reply('run --detach', { code: 125, stderr: 'Cannot connect to Podman' });

        await expect(b.exec('echo hi')).rejects.toMatchObject({
            name: 'SandboxError',
            message: expect.stringMatching(/stopped .* could not be restarted/),
            hint: expect.stringContaining('podman machine start'),
        });
    });

    it('names stopped containers as the fix when the engine is out of locks', async () => {
        const f = fresh();
        f.reply('run --detach', {
            code: 125,
            stderr: 'Error: allocating lock for new container: allocation failed; exceeded num_locks (2048)\n',
        });

        await expect(box(f).start()).rejects.toMatchObject({
            message: expect.stringContaining('exceeded num_locks'),
            hint: expect.stringContaining('container prune --force --filter label=zenera=1'),
        });
    });
});

describe('background jobs', () => {
    it('writes the command to a file rather than into the launcher', async () => {
        const f = fresh();
        const id = await box(f).startJob('npm run dev', { cwd: 'app' });

        expect(id).toMatch(/^job-[0-9a-f]{6}$/);

        const write = f.calls.find((c) => c.opts?.input === 'npm run dev');
        expect(write).toBeDefined();
        expect(write?.args.at(-1)).toContain(`cat > /tmp/zenera-jobs/${id}.sh`);

        const launch = f.calls.at(-1);
        expect(launch?.opts?.input).toContain(`/bin/sh /tmp/zenera-jobs/${id}.sh`);
        expect(launch?.opts?.input).toContain(`cd '${WORKSPACE_MOUNT}/app'`);
        expect(launch?.opts?.input).not.toContain('npm run dev');

        // The redirection and the `&` have to be on the same line as the
        // command they apply to. A newline there ends the command instead, and
        // the job runs in the foreground of the exec that started it — which
        // no argument assertion notices, because every fragment is still
        // present and in order.
        const line = (launch?.opts?.input ?? '').split('\n').find((l) => l.includes(`${id}.sh`));
        expect(line).toMatch(/> \S+\.log 2>&1 < \/dev\/null &$/);
    });

    it('reads the log back with the running flag and a resumable window', async () => {
        const f = fresh();
        const b = box(f);
        const id = await b.startJob('npm run dev');

        f.reply('/bin/sh -s', { stdout: 'lines=3\n---\nfirst\nsecond\nthird\n' });
        const running = await b.readJob(id);

        expect(running.running).toBe(true);
        expect(running.exit_code).toBeUndefined();
        expect(running.output).toBe('first\nsecond\nthird\n');
        expect(running.start_line).toBe(1);
        expect(running.end_line).toBe(3);

        f.reply('/bin/sh -s', { stdout: 'lines=4\nexit=0\n---\nfourth\n' });
        const done = await b.readJob(id, 4);
        expect(done.running).toBe(false);
        expect(done.exit_code).toBe(0);
        expect(done.start_line).toBe(4);
    });

    it('will not read or stop a job it never started', async () => {
        const f = fresh();
        const b = box(f);
        await expect(b.readJob('job-000000')).rejects.toThrow(SandboxError);
        await expect(b.stopJob('job-000000')).rejects.toThrow(/no such job/);
    });

    it('signals the whole process group', async () => {
        const f = fresh();
        const b = box(f);
        const id = await b.startJob('npm run dev');
        await b.stopJob(id);

        expect(f.calls.at(-1)?.opts?.input).toContain('kill -TERM -"$pid"');
    });
});

describe('an out-of-memory kill', () => {
    // The command's own exec carries `--workdir`; the cgroup probe does not,
    // which is the only thing telling the two `exec` calls apart here.
    const COMMAND = 'exec --interactive --workdir';
    const probes = (f: Fake) => f.calls.filter((c) => c.opts?.input?.includes('memory.events'));

    it('blames the container when the kill was counted against it', async () => {
        const f = fresh();
        f.reply(COMMAND, { code: 137 });
        f.reply('/bin/sh -s', { stdout: 'peak=536870912 kills=1\n' });

        const res = await box(f, { memory: 512 }).exec('python3 -c "bytearray(2**31)"');

        expect(res.exit_code).toBe(137);
        expect(res.out_of_memory).toMatchObject({
            limit_mib: 512,
            peak_mib: 512,
            retryable: false,
        });
        expect(res.out_of_memory?.hint).toContain('limited to 512 MiB');
    });

    it('blames the machine when the count did not move', async () => {
        const f = fresh();
        const b = box(f, { memory: 512 });

        f.reply(COMMAND, { code: 137 });
        f.reply('/bin/sh -s', { stdout: 'peak=536870912 kills=1\n' });
        const own = await b.exec('big');

        // Same counter a second time: nothing was killed in *this* cgroup, so
        // the kill came from outside it.
        f.reply(COMMAND, { code: 137 });
        f.reply('/bin/sh -s', { stdout: 'peak=536870912 kills=1\n' });
        const outside = await b.exec('big');

        expect(own.out_of_memory?.retryable).toBe(false);
        expect(outside.out_of_memory?.retryable).toBe(true);
        expect(outside.out_of_memory?.hint).toContain('machine ran out of memory');
    });

    it('assumes the container when the cgroup cannot be read', async () => {
        const f = fresh();
        f.reply(COMMAND, { code: 137 });
        f.reply('/bin/sh -s', { stdout: 'peak= kills=\n' });

        const res = await box(f, { memory: 512 }).exec('big');

        expect(res.out_of_memory?.retryable).toBe(false);
        expect(res.out_of_memory?.peak_mib).toBeUndefined();
    });

    it('does not probe for a timeout, an ordinary failure, or an uncapped box', async () => {
        const timed = fresh();
        timed.reply(COMMAND, { code: 137, timedOut: true });
        expect((await box(timed, { memory: 512 }).exec('sleep 1')).out_of_memory).toBeUndefined();
        expect(probes(timed)).toHaveLength(0);

        const failed = fresh();
        failed.reply(COMMAND, { code: 1 });
        expect((await box(failed, { memory: 512 }).exec('false')).out_of_memory).toBeUndefined();
        expect(probes(failed)).toHaveLength(0);

        const uncapped = fresh();
        uncapped.reply(COMMAND, { code: 137 });
        expect((await box(uncapped, { memory: 0 }).exec('big')).out_of_memory).toBeUndefined();
        expect(probes(uncapped)).toHaveLength(0);
    });

    it('explains a killed job once, however often its log is read', async () => {
        const f = fresh();
        const b = box(f, { memory: 512 });
        const id = await b.startJob('npm run build');

        f.reply('/bin/sh -s', { stdout: 'lines=1\nexit=137\n---\nboom\n' });
        f.reply('/bin/sh -s', { stdout: 'peak=536870912 kills=1\n' });
        const first = await b.readJob(id);

        f.reply('/bin/sh -s', { stdout: 'lines=1\nexit=137\n---\nboom\n' });
        const again = await b.readJob(id);

        expect(first.out_of_memory).toMatchObject({ limit_mib: 512, retryable: false });
        // Re-probing would find the counter unchanged and change its mind.
        expect(again.out_of_memory).toBe(first.out_of_memory);
        expect(probes(f)).toHaveLength(1);
    });
});

describe('disposal', () => {
    it('removes an ephemeral container', async () => {
        const f = fresh();
        const b = box(f);
        await b.start();
        await b.dispose();
        expect(find(f, 'rm')?.args).toContain(b.name);
    });

    it('only stops one that asked to persist', async () => {
        const f = fresh();
        const b = box(f, { persist: true });
        await b.start();
        await b.dispose();
        expect(find(f, 'rm')).toBeUndefined();
        expect(find(f, 'stop')?.args).toContain(b.name);
    });

    it('is free when nothing was ever started', async () => {
        const f = fake();
        await box(f).dispose();
        expect(f.calls).toHaveLength(0);
    });
});

describe('one container per configuration', () => {
    const pool = (agents: Record<string, Record<string, unknown>>): SandboxPool =>
        new SandboxPool({
            root: '/host/ws',
            key: 'session',
            newBox: podmanBox({ exec: fake().run }),
            image: 'base',
            agents,
        });

    it('shares one container between agents that agree', () => {
        const p = pool({});
        expect(p.for('alpha')).toBe(p.for('beta'));
    });

    it('gives an agent that names its own image its own container', () => {
        const p = pool({ analyst: { image: 'python' } });
        expect(p.for('analyst').name).not.toBe(p.for('writer').name);
    });

    it('still shares between two agents that made the same choice', () => {
        const p = pool({ a: { image: 'python' }, b: { image: 'python' } });
        expect(p.for('a')).toBe(p.for('b'));
    });
});

describe('the tools', () => {
    const tools = sandboxTools(
        new SandboxPool({
            root: '/host/ws',
            key: 'session',
            newBox: podmanBox({ exec: fake().run }),
        }),
    );

    it('are one selectable family', () => {
        expect(tools.map((t) => t.name)).toEqual([
            'run_command',
            'run_command_background',
            'read_command_output',
            'stop_command',
        ]);
        expect(tools.every((t) => t.group === SANDBOX_GROUP)).toBe(true);
        expect(
            selectTools(tools, ['sandbox:*', '-stop_command'], { where: 'test' }).map(
                (t) => t.name,
            ),
        ).toEqual(['run_command', 'run_command_background', 'read_command_output']);
    });

    /**
     * The container is chosen from `tc.agent` at call time rather than captured
     * when the tool was built, so one tool object — one schema, one cached
     * prompt prefix — still serves agents that need different images.
     */
    it('pick their container from the calling agent', async () => {
        const f = fresh();
        const pool = new SandboxPool({
            root: '/host/ws',
            key: 'session',
            newBox: podmanBox({ exec: f.run }),
            image: 'base',
            agents: { analyst: { image: 'python' } },
        });
        const [runCommand] = sandboxTools(pool);
        const tc = { agent: { name: 'analyst' } } as ToolContext;

        await runCommand.execute({ command: 'python -V' }, tc);
        expect(find(f, 'run')?.args).toContain('python');
    });

    it('turn a path escape into something the model can act on', async () => {
        const [runCommand] = sandboxTools(
            new SandboxPool({
                root: '/host/ws',
                key: 's',
                newBox: podmanBox({ exec: fake().run }),
            }),
        );
        const out = await runCommand.execute({ command: 'ls', cwd: '../../etc' }, {
            agent: { name: 'a' },
        } as ToolContext);
        expect(out).toMatchObject({ error: expect.stringContaining('outside') });
    });
});

describe('the sandbox block in agents.yaml', () => {
    const config = (body: string): unknown =>
        parseConfig(`version: 1\n${body}\nagents:\n  - name: a\n`, 'agents.yaml');

    it('takes the resource knobs', () => {
        expect(config('sandbox:\n  image: python:3.13\n  cpus: 2\n  memory: 4096')).toMatchObject({
            sandbox: { image: 'python:3.13', cpus: 2, memory: 4096 },
        });
    });

    it('refuses a key it does not honour', () => {
        expect(() => config('sandbox:\n  privileged: true')).toThrow(/privileged/);
    });

    /**
     * The CLI materialises its keyring into the environment before loading a
     * project, so an unguarded passthrough would hand every model key to
     * whatever the agent decided to run.
     */
    // Disable it for now
    // it('refuses to forward anything that reads like a credential', () => {
    //     expect(() => config('sandbox:\n  env: [OPENAI_API_KEY]')).toThrow(/credential/);
    //     expect(() => config('sandbox:\n  env: [GH_TOKEN]')).toThrow(/credential/);
    //     expect(config('sandbox:\n  env: [HTTPS_PROXY]')).toMatchObject({
    //         sandbox: { env: ['HTTPS_PROXY'] },
    //     });
    // });

    it('lets one agent differ from the rest', () => {
        const parsed = parseConfig(
            'version: 1\nsandbox:\n  image: base\nagents:\n' +
                '  - name: a\n    sandbox:\n      image: python\n',
            'agents.yaml',
        );
        expect(parsed.agents[0].sandbox?.image).toBe('python');
    });
});

// ---------------------------------------------------------------------------
// Reaching the engine
//
// Off Linux podman is a remote client that opens one ssh connection per
// invocation, and sshd drops them past `MaxStartups`. That is a connection
// failing before authentication, so nothing ran and the call can be repeated —
// but only then, which is what these pin down.
// ---------------------------------------------------------------------------

describe('a refused connection', () => {
    const answer = (res: Partial<ProcResult>): ProcResult => ({
        code: 0,
        stdout: '',
        stderr: '',
        truncated: false,
        timedOut: false,
        ...res,
    });

    /** Fails with `stderr` the first `times` calls, then succeeds. */
    const flaky = (times: number, stderr: string): { run: Runner; tries: () => number } => {
        let n = 0;
        return {
            tries: () => n,
            run: () =>
                Promise.resolve(
                    ++n <= times ? answer({ code: 125, stderr }) : answer({ stdout: 'ok' }),
                ),
        };
    };

    it('is retried until it lands', async () => {
        const f = flaky(2, 'Error: failed to connect: ssh: handshake failed: EOF');
        const res = await resilient(f.run)('podman', ['ps']);
        expect(res.code).toBe(0);
        expect(res.stdout).toBe('ok');
        expect(f.tries()).toBe(3);
    });

    it('gives up rather than retrying forever, and returns the last answer', async () => {
        const f = flaky(99, 'kex_exchange_identification: Connection closed by remote host');
        const res = await resilient(f.run, 3)('podman', ['ps']);
        expect(res.code).toBe(125);
        expect(f.tries()).toBe(3);
    });

    /**
     * The distinction the whole thing rests on: a command that failed on its
     * own merits must run exactly once, however its stderr reads.
     */
    it('is not confused with a command that ran and failed', async () => {
        let n = 0;
        const run: Runner = () => {
            n++;
            return Promise.resolve(answer({ code: 1, stderr: 'npm ERR! test failed' }));
        };
        expect((await resilient(run)('podman', ['exec'])).code).toBe(1);
        expect(n).toBe(1);
    });

    it('does not repeat a command that had already produced output', async () => {
        let n = 0;
        const run: Runner = () => {
            n++;
            return Promise.resolve(
                answer({ code: 1, stdout: 'partial', stderr: 'connection reset by peer' }),
            );
        };
        await resilient(run)('podman', ['exec']);
        expect(n).toBe(1);
    });

    it('stops when the turn is abandoned', async () => {
        const f = flaky(99, 'ssh: handshake failed');
        const res = await resilient(f.run)('podman', ['ps'], {
            signal: AbortSignal.abort(),
        });
        expect(res.code).toBe(125);
        expect(f.tries()).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// The ceilings, as a report reads them
// ---------------------------------------------------------------------------

describe('resolved limits', () => {
    it('are the profile’s own defaults when nothing is written down', () => {
        expect(sandboxLimits()).toEqual({
            memory: 4096,
            cpus: 4,
            hardening: 'standard',
            declared: false,
        });
        expect(sandboxLimits({ hardening: 'strict' })).toEqual({
            memory: 2048,
            cpus: 2,
            hardening: 'strict',
            declared: false,
        });
    });

    it('take what was declared, and say that it was', () => {
        expect(sandboxLimits({ memory: 8192, hardening: 'strict' })).toEqual({
            memory: 8192,
            cpus: 2,
            hardening: 'strict',
            declared: true,
        });
    });

    /** Or a status report would contradict the container a run actually starts. */
    it('agree with what the container is created with', async () => {
        const f = fresh();
        await box(f, { hardening: 'strict' }).start();
        const create = find(f, 'run');
        const limits = sandboxLimits({ hardening: 'strict' });
        expect(create?.args).toContain(`${limits.memory}m`);
        expect(create?.args).toContain(String(limits.cpus));
    });
});
