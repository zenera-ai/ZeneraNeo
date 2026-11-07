/**
 * Vitest coverage for server startup layout and compact/verbose build presentation.
 * Mocked process streams and child pipes verify aligned summaries, complete UTF-8
 * log lines, animated single-row progress, timer cleanup, colors and failure diagnostics.
 * Run by the CLI suite without starting podman or a runtime.
 */
import { ChildProcess, spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    buildProgress,
    HOST_MANAGED_ENV,
    hostManagedOutput,
    printServerStarted,
    streamAgentBuild,
} from '../src/serverDisplay.ts';
import { plain } from '../src/term.ts';

vi.mock('node:child_process', async (original) => ({
    ...(await original<typeof import('node:child_process')>()),
    spawn: vi.fn(),
}));

let output: { stdout: string; stderr: string };
beforeEach(() => {
    output = { stdout: '', stderr: '' };
    vi.stubEnv('FORCE_COLOR', undefined);
    vi.stubEnv('NO_COLOR', '1');
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        output.stdout += String(chunk);
        return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        output.stderr += String(chunk);
        return true;
    });
    vi.mocked(spawn).mockReset();
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

function fakeBuild(run: (stdout: PassThrough, stderr: PassThrough) => void, exit = 0): void {
    vi.mocked(spawn).mockImplementation(() => {
        const child = new ChildProcess();
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        child.stdout = stdout;
        child.stderr = stderr;
        queueMicrotask(() => {
            run(stdout, stderr);
            stdout.end();
            stderr.end();
            setImmediate(() => child.emit('close', exit, null));
        });
        return child;
    });
}

describe('server startup display', () => {
    const info = {
        project: 'test52',
        url: 'http://127.0.0.1:3000',
        root: '/state/test52',
        auth: 'insecure' as const,
        sandbox: 'bwrap',
        image: { tag: 'localhost/agent:abc', base: 'localhost/base:def', built: true },
        runtimeUser: 'UID/GID 10001:10001 (non-root)',
        page: 'file:///chat.html#server=http%3A%2F%2F127.0.0.1%3A3000&jwt=dev.jwt.',
        chatUser: 'andrey',
    };

    it('separates aligned startup narration from the complete browser link', () => {
        printServerStarted(info);
        expect(output.stderr).toContain('✓ Container started');
        expect(output.stderr).not.toContain('✓ Server ready');
        expect(output.stderr).toMatch(/Project\s+test52/);
        expect(output.stderr).toMatch(/HTTP\s+http:\/\/127.0.0.1:3000/);
        expect(output.stderr).toMatch(/Chat user\s+andrey/);
        expect(output.stderr.match(/warning/g)).toHaveLength(1);
        expect(output.stderr).toContain('impersonate any user');
        expect(output.stderr).toContain('Ctrl+C');
        expect(output.stderr).not.toContain(info.page);
        expect(output.stdout).toBe(`\n  Test chat\n  ${info.page}\n\n`);
        expect(output.stdout + output.stderr).not.toContain('\u001b');
    });

    it('does not imply one global user or print a dev warning in secure mode', () => {
        printServerStarted({ ...info, auth: 'jwt', page: undefined });
        expect(output.stderr).toContain('EdDSA verified');
        expect(output.stderr).not.toContain('Chat user');
        expect(output.stderr).not.toContain('warning');
        expect(output.stdout).toBe('');
    });

    it('uses the ready heading for a direct runtime without a container', () => {
        printServerStarted({ ...info, image: undefined });
        expect(output.stderr).toContain('✓ Server ready');
    });

    it('only suppresses duplicate host summaries inside a managed image', () => {
        const env = { [HOST_MANAGED_ENV]: '1' };
        expect(hostManagedOutput(true, env)).toBe(true);
        expect(hostManagedOutput(false, env)).toBe(false);
        expect(hostManagedOutput(true, {})).toBe(false);
    });
});

describe('build output', () => {
    it('animates quiet terminal steps with elapsed time and stops cleanly', () => {
        vi.useFakeTimers();
        const saved = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
        Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: true });
        try {
            const log = buildProgress();
            expect(output.stderr).toContain('| 0s Building…');
            log.line('STEP 4/4: RUN npm install');
            const before = output.stderr;
            vi.advanceTimersByTime(1200);
            expect(output.stderr.length).toBeGreaterThan(before.length);
            expect(output.stderr).toContain('1s STEP 4/4: RUN npm install');
            expect(output.stderr).toContain('/ 0s');
            log.line('npm warn visible');
            vi.advanceTimersByTime(150);
            expect(output.stderr).toContain('npm warn visible\n');
            expect(vi.getTimerCount()).toBe(1);
            log.done();
            const completed = output.stderr;
            vi.advanceTimersByTime(3000);
            log.done();
            log.line('late output');
            expect(output.stderr).toBe(completed);
            expect(vi.getTimerCount()).toBe(0);

            const verbose = buildProgress(true);
            expect(vi.getTimerCount()).toBe(0);
            verbose.done();
            Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: false });
            const piped = buildProgress();
            expect(vi.getTimerCount()).toBe(0);
            piped.done();
        } finally {
            if (saved) Object.defineProperty(process.stderr, 'isTTY', saved);
            else Reflect.deleteProperty(process.stderr, 'isTTY');
        }
    });

    it('cleans up animation when spawning the builder fails', async () => {
        vi.useFakeTimers();
        const saved = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
        Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: true });
        const child = new ChildProcess();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        vi.mocked(spawn).mockReturnValue(child);
        try {
            const build = streamAgentBuild('podman', ['build']);
            expect(vi.getTimerCount()).toBe(1);
            child.emit('error', new Error('builder unavailable'));
            await expect(build).rejects.toThrow('builder unavailable');
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            if (saved) Object.defineProperty(process.stderr, 'isTTY', saved);
            else Reflect.deleteProperty(process.stderr, 'isTTY');
        }
    });

    it('prints only the final progress line in a pipe, but keeps warnings', async () => {
        fakeBuild((stdout, stderr) => {
            for (let i = 0; i < 100; i++) stdout.write(`routine build line ${i}\n`);
            stderr.write('npm warn deprecated test dependency\n');
            stdout.write('Successfully tagged localhost/agent:test\n');
        });
        await streamAgentBuild('podman', ['build']);
        expect(output.stderr).not.toContain('routine build line');
        expect(output.stderr).toContain('npm warn deprecated test dependency');
        expect(output.stderr).toContain('Successfully tagged localhost/agent:test');
        expect(output.stderr.trim().split('\n')).toHaveLength(2);
        expect(output.stderr).not.toContain('\u001b');
    });

    it('preserves every full line, stage grouping and split UTF-8 bytes with verbose output', async () => {
        const long = `RUN ${'command '.repeat(100)}`;
        fakeBuild((stdout, stderr) => {
            stdout.write('[1/3] STEP 1/4: FR');
            stdout.write('OM node AS runtime\n');
            stdout.write(`${long}\n`);
            const bytes = Buffer.from('café\n');
            stdout.write(bytes.subarray(0, 4));
            stdout.write(bytes.subarray(4));
            stderr.write('npm warn deprecated test\n');
            stdout.write('[2/3] STEP 1/5: FROM alpine AS bwrap\n');
            stdout.write('last line without newline');
        });
        await streamAgentBuild('podman', ['build'], true);
        expect(output.stderr).toContain('Build stage 1/3 · runtime');
        expect(output.stderr).toContain('[1/3] STEP 1/4: FROM node AS runtime');
        expect(output.stderr).toContain(long);
        expect(output.stderr).toContain('café');
        expect(output.stderr).not.toContain('\uFFFD');
        expect(output.stderr).toContain('npm warn deprecated test');
        expect(output.stderr).toContain('Build stage 2/3 · bwrap');
        expect(output.stderr).toContain('last line without newline');
    });

    it('retains raw diagnostic tails and visibly reports a compact-mode build failure', async () => {
        fakeBuild((stdout, stderr) => {
            stdout.write('STEP 2/4: RUN npm install\n');
            stderr.write('npm error code EFAIL\nnpm error failed to install');
        }, 125);
        await expect(streamAgentBuild('podman', ['build'])).rejects.toMatchObject({
            message: 'the agent image did not build (exit 125)',
            hint: 'STEP 2/4: RUN npm install\nnpm error code EFAIL\nnpm error failed to install',
        });
        expect(output.stderr).toContain('npm error code EFAIL');
        expect(output.stderr).toContain('npm error failed to install');
    });

    it('honors forced colors in verbose logs without changing their plain text', async () => {
        vi.stubEnv('NO_COLOR', undefined);
        vi.stubEnv('FORCE_COLOR', '1');
        fakeBuild((stdout, stderr) => {
            stdout.write('[1/3] STEP 1/4: FROM node AS runtime\n');
            stderr.write('npm warn deprecated test\n');
        });
        await streamAgentBuild('podman', ['build'], true);
        expect(output.stderr).toContain('\u001b');
        expect(plain(output.stderr)).toContain('npm warn deprecated test');
        expect(plain(output.stderr)).toContain('[1/3] STEP 1/4: FROM node AS runtime');
    });

    it('uses one width-limited terminal row and clears it before printing a warning', () => {
        const keys = ['isTTY', 'columns'] as const;
        const saved = keys.map((key) => Object.getOwnPropertyDescriptor(process.stderr, key));
        Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: true });
        Object.defineProperty(process.stderr, 'columns', { configurable: true, value: 40 });
        try {
            const log = buildProgress();
            log.line('a'.repeat(100));
            log.line('b'.repeat(100));
            log.line('npm warn visible');
            log.done();
            const rows = output.stderr.split('\r\u001b[2K').filter(Boolean);
            expect(rows[0]!.length).toBeLessThanOrEqual(40);
            expect(rows[1]!.length).toBeLessThanOrEqual(40);
            expect(output.stderr).toContain('npm warn visible\n');
            Object.defineProperty(process.stderr, 'columns', { configurable: true, value: 0 });
            const unknownWidth = buildProgress();
            unknownWidth.line('Building runtime packages');
            unknownWidth.done();
            expect(output.stderr).toContain('Building runtime packages');
        } finally {
            keys.forEach((key, i) => {
                const descriptor = saved[i];
                if (descriptor) Object.defineProperty(process.stderr, key, descriptor);
                else Reflect.deleteProperty(process.stderr, key);
            });
        }
    });
});
