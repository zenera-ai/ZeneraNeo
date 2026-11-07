import type { ProcResult } from '@zenera/neo';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@zenera/sandbox', async (original) => ({
    ...(await original<typeof import('@zenera/sandbox')>()),
    runProcess: vi.fn(),
}));
vi.mock('@zenera/engine', async (original) => ({
    ...(await original<typeof import('@zenera/engine')>()),
    KeyStore: { open: async () => ({ materialize() {} }) },
    credentials: () => [],
}));

import { runProcess } from '@zenera/sandbox';
import { agentDockerfile, runContainer, type ContainerRun } from '../src/container.ts';

const root = mkdtempSync(join(tmpdir(), 'zen-container-test-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => vi.mocked(runProcess).mockReset());

const result = (stdout: string, code = 0): ProcResult => ({
    code,
    stdout,
    stderr: code ? 'test: container was not started' : '',
    truncated: false,
    timedOut: false,
});
const run: ContainerRun = {
    image: 'localhost/test-agent',
    project: { dir: root, id: 'test' },
    root: join(root, 'state'),
    listen: { host: '127.0.0.1', port: 3000 },
    auth: { mode: 'insecure' },
    debug: false,
};

describe('non-root agent containers', () => {
    it('uses root only to build, then a numeric user with a writable home', () => {
        const dockerfile = agentDockerfile('test-base', { ZEN_IMAGE_BASE: 'test-base' });
        expect(dockerfile).toContain(
            'chown 10001:10001 /state /workspace /home/agent /home/zenera',
        );
        expect(dockerfile).toContain('ENV HOME=/home/zenera\nUSER 10001:10001');
        expect(dockerfile.lastIndexOf('USER root')).toBeLessThan(
            dockerfile.lastIndexOf('USER 10001:10001'),
        );
        expect(dockerfile.lastIndexOf('USER 10001:10001')).toBeLessThan(
            dockerfile.lastIndexOf('ENTRYPOINT'),
        );
    });

    it.each(['true', 'false'])('runs as non-root with rootless=%s', async (rootless) => {
        vi.mocked(runProcess)
            .mockResolvedValueOnce(result(`${rootless}\n`))
            .mockResolvedValueOnce(result('', 125));
        await expect(runContainer(run)).rejects.toThrow('could not start the agent container');
        expect(runProcess).toHaveBeenNthCalledWith(
            1,
            'podman',
            ['info', '--format', '{{.Host.Security.Rootless}}'],
            expect.anything(),
        );
        const args = vi.mocked(runProcess).mock.calls[1]![1];
        expect(args.slice(args.indexOf('--user'), args.indexOf('--user') + 2)).toEqual([
            '--user',
            '10001:10001',
        ]);
        if (rootless === 'true') {
            expect(args.slice(args.indexOf('--userns'), args.indexOf('--userns') + 2)).toEqual([
                '--userns',
                'keep-id:uid=10001,gid=10001',
            ]);
        } else {
            expect(args).not.toContain('--userns');
        }
        expect(args).not.toContain('--privileged');
        expect(args.slice(args.indexOf('--cap-drop'), args.indexOf('--cap-drop') + 2)).toEqual([
            '--cap-drop',
            'ALL',
        ]);
        expect(
            args.slice(args.indexOf('--security-opt'), args.indexOf('--security-opt') + 2),
        ).toEqual(['--security-opt', 'no-new-privileges']);
        expect(args).toContain(`${run.root}:/state`);
    });

    it('refuses an unknown user-namespace mode instead of starting as root', async () => {
        vi.mocked(runProcess).mockResolvedValueOnce(result('unknown\n'));
        await expect(runContainer(run)).rejects.toThrow(
            'could not determine whether podman is rootless',
        );
        expect(runProcess).toHaveBeenCalledTimes(1);
    });

    it('reports podman info failures without trying to start a container', async () => {
        vi.mocked(runProcess).mockResolvedValueOnce(result('', 125));
        await expect(runContainer(run)).rejects.toThrow('podman info --format:');
        expect(runProcess).toHaveBeenCalledTimes(1);
    });
});
