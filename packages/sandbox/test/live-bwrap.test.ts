import {
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BwrapSandbox, probeBwrap, type BwrapHost, type SandboxOptions } from '../src/index.ts';
import { describeSandbox } from '../src/testing.ts';

// The sandbox contract and the isolation it promises, against a real bwrap.
// It self-skips where bwrap cannot isolate anything — macOS, or a Linux whose
// user namespaces are closed — like the other live tests do without an engine.
const probe = await probeBwrap();

if (probe.ok) {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'zen-bwrap-live-')));
    afterAll(() => rmSync(base, { recursive: true, force: true }));
    let n = 0;
    const dir = (name: string): string => {
        const d = join(base, `${name}-${n++}`);
        mkdirSync(d, { recursive: true });
        return d;
    };
    const open = (opts: Partial<SandboxOptions> = {}, host: BwrapHost = {}) =>
        new BwrapSandbox({ root: dir('ws'), key: 'live', ...opts }, { image: false, ...host });

    describeSandbox(`bwrap (${probe.proc} /proc)`, () => {
        const root = dir('contract');
        return { sandbox: open({ root }), root };
    });

    describe(`bwrap isolation (${probe.proc} /proc)`, () => {
        it('shows a command none of this process’s environment it was not given', async () => {
            process.env.ZEN_LIVE_SERVER_SECRET = 'leaked';
            const box = open({ secrets: ['ZEN_LIVE_NAMED'] });
            process.env.ZEN_LIVE_NAMED = 'given';
            try {
                const env = await box.exec('env');
                expect(env.stdout).toContain('ZEN_LIVE_NAMED=given');
                expect(env.stdout).not.toContain('leaked');
                const proc = await box.exec(
                    'cat /proc/*/environ 2>/dev/null | tr "\\0" "\\n" | grep -c leaked || true',
                );
                expect(proc.stdout.trim()).toBe('0');
            } finally {
                delete process.env.ZEN_LIVE_SERVER_SECRET;
                delete process.env.ZEN_LIVE_NAMED;
                await box.close();
            }
        });

        it('runs commands in a pid namespace of their own, and cannot read this process', async () => {
            const box = open();
            try {
                expect(Number((await box.exec('echo $$')).stdout.trim())).toBeLessThan(10);
                const mine = await box.exec(`cat /proc/${process.pid}/environ`);
                if (probe.proc === 'bind') {
                    expect(mine.exit_code).not.toBe(0);
                }
                expect(mine.stdout).toBe('');
            } finally {
                await box.close();
            }
        });

        it('hides what is hidden, and keeps the image read-only', async () => {
            // Not under /tmp, which every command has its own of anyway.
            const secret = realpathSync(mkdtempSync(join(process.cwd(), '.zen-live-hidden-')));
            writeFileSync(join(secret, 'token'), 'x');
            const box = open({}, { hidden: [secret] });
            try {
                expect((await box.exec(`test -e ${secret}/token`)).exit_code).not.toBe(0);
                expect((await box.exec(`test -e ${process.cwd()}/package.json`)).exit_code).toBe(0);
                expect((await box.exec('touch /usr/zen-live-x')).exit_code).not.toBe(0);
                expect((await box.exec('touch /etc/zen-live-x')).exit_code).not.toBe(0);
            } finally {
                await box.close();
                rmSync(secret, { recursive: true, force: true });
            }
        });

        it('mounts where the image has no directory, and writes through to the host', async () => {
            const home = dir('home');
            const box = open({
                mounts: [{ host: home, at: '/home/agent-live', source: { kind: 'home' } }],
                env: { HOME: '/home/agent-live' },
            });
            try {
                const res = await box.exec('echo hi > "$HOME/f" && cat "$HOME/f"');
                expect(res).toMatchObject({ exit_code: 0, stdout: 'hi\n' });
                expect(readFileSync(join(home, 'f'), 'utf8')).toBe('hi\n');
            } finally {
                await box.close();
            }
        });

        it('takes the network away when told to', async () => {
            const box = open({ network: 'none' });
            try {
                // No route anywhere: the routing table is its header line alone. (Some
                // kernels add idle tunnel devices to every namespace, so interfaces are no test.)
                const routes = await box.exec('wc -l < /proc/net/route');
                expect(routes.stdout.trim()).toBe('1');
            } finally {
                await box.close();
            }
        });

        it('gives each command a /dev/shm of its own', async () => {
            const box = open();
            try {
                const write = await box.exec(
                    'echo x > /dev/shm/zen-live-shm && cat /dev/shm/zen-live-shm',
                );
                expect(write.stdout).toBe('x\n');
                expect((await box.exec('test -e /dev/shm/zen-live-shm')).exit_code).not.toBe(0);
            } finally {
                await box.close();
            }
        });

        it('makes commands the first thing the out-of-memory killer takes', async () => {
            const box = open();
            try {
                expect((await box.exec('cat /proc/self/oom_score_adj')).stdout.trim()).toBe('1000');
            } finally {
                await box.close();
            }
        });

        it('stops a job and everything it started', async () => {
            const box = open();
            const marker = `${4000 + Math.floor(Math.random() * 1000)}`;
            try {
                const id = await box.startJob(`sleep ${marker} & sleep ${marker}`);
                await new Promise((r) => setTimeout(r, 500));
                expect(sleeping(marker)).toBeGreaterThan(0);
                await box.stopJob(id);
                await new Promise((r) => setTimeout(r, 300));
                expect(sleeping(marker)).toBe(0);
            } finally {
                await box.close();
            }
        });

        it('reports a job’s exit code and log', async () => {
            const box = open();
            try {
                const id = await box.startJob('echo one; echo two; exit 4');
                let out = await box.readJob(id);
                for (let i = 0; i < 40 && out.running; i++) {
                    await new Promise((r) => setTimeout(r, 100));
                    out = await box.readJob(id);
                }
                expect(out).toMatchObject({ running: false, exit_code: 4, lines: 2 });
                expect(out.output).toBe('one\ntwo\n');
                expect((await box.readJob(id, 2)).output).toBe('two\n');
            } finally {
                await box.close();
            }
        });
    });

    /** Processes on this machine running `sleep <marker>`. */
    function sleeping(marker: string): number {
        let count = 0;
        for (const pid of readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
            try {
                const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ');
                if (cmd.trim() === `sleep ${marker}`) {
                    count++;
                }
            } catch {
                // gone
            }
        }
        return count;
    }
} else {
    describe.skip(`Sandbox contract: bwrap (${probe.error})`, () => {
        it('runs against a real bwrap', () => undefined);
    });
}
