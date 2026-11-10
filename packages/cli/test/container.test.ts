/**
 * Vitest coverage for host-side agent container configuration and startup failures.
 * Tests inspect agentDockerfile and mocked podman calls from runContainer, including
 * numeric identity, privilege restrictions and the prepared read-only memory seed.
 * Run by the CLI suite without starting real containers.
 */
import type { ProcResult } from '@zenera/neo';
import { MemoryStore } from '@zenera/neo';
import { ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@zenera/sandbox', async (original) => ({
    ...(await original<typeof import('@zenera/sandbox')>()),
    runProcess: vi.fn(),
}));
vi.mock('@zenera/engine', async (original) => ({
    ...(await original<typeof import('@zenera/engine')>()),
    KeyStore: { open: async () => ({ materialize }) },
    credentials: vi.fn(() => []),
    gcloudAdc: vi.fn(),
}));
vi.mock('node:child_process', async (original) => ({
    ...(await original<typeof import('node:child_process')>()),
    spawn: vi.fn(),
}));

import { runProcess } from '@zenera/sandbox';
import { credentials, gcloudAdc } from '@zenera/engine';
import {
    AGENT_RUNTIME_REPO,
    agentDockerfile,
    agentRuntimeDockerfile,
    agentRuntimeRef,
    runContainer,
    type ContainerRun,
} from '../src/container.ts';

const root = mkdtempSync(join(tmpdir(), 'zen-container-test-'));
const materialize = vi.fn(() => ({}));
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
    vi.mocked(runProcess).mockReset();
    vi.mocked(spawn).mockReset();
    vi.mocked(credentials).mockReset().mockReturnValue([]);
    vi.mocked(gcloudAdc).mockReset().mockReturnValue(undefined);
    materialize.mockReset().mockReturnValue({});
});
afterEach(() => vi.unstubAllEnvs());

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
    memorySeed: null,
    listen: { host: '127.0.0.1', port: 3000 },
    auth: { mode: 'insecure' },
    debug: false,
};

describe('prebuilt agent runtime', () => {
    const released = { version: '1.2.5', installed: true };

    it('a released CLI uses its release image; a dev checkout builds its own code', () => {
        expect(agentRuntimeRef(released, {})).toBe(`${AGENT_RUNTIME_REPO}:1.2.5`);
        expect(agentRuntimeRef({ ...released, installed: false }, {})).toBeNull();
    });

    it('ZEN_AGENT_RUNTIME=local builds here; ZEN_AGENT_RUNTIME_IMAGE names a mirror', () => {
        expect(agentRuntimeRef(released, { ZEN_AGENT_RUNTIME: 'local' })).toBeNull();
        expect(
            agentRuntimeRef(
                { ...released, installed: false },
                { ZEN_AGENT_RUNTIME_IMAGE: 'mirror.local/rt:1.2.5' },
            ),
        ).toBe('mirror.local/rt:1.2.5');
        expect(
            agentRuntimeRef(released, {
                ZEN_AGENT_RUNTIME: 'local',
                ZEN_AGENT_RUNTIME_IMAGE: 'mirror.local/rt:1.2.5',
            }),
        ).toBeNull();
    });

    it('copies /opt/zenera from the runtime image instead of installing and compiling', () => {
        const prebuilt = agentDockerfile('test-base', { ZEN_IMAGE_BASE: 'b' }, 'rt:1.2.5');
        expect(prebuilt).toContain(
            'FROM test-base\nUSER root\nCOPY --from=rt:1.2.5 /opt/zenera /opt/zenera',
        );
        expect(prebuilt).not.toMatch(/npm install|meson|pkgs\/|app\.json/);
        expect(prebuilt.match(/^FROM /gm)).toHaveLength(1);
        // Same final image either way, past the runtime.
        const local = agentDockerfile('test-base', { ZEN_IMAGE_BASE: 'b' });
        const tail = (d: string) => d.slice(d.indexOf('COPY runtime/'));
        expect(tail(prebuilt)).toBe(tail(local));
        expect(local).toContain('COPY --from=bwrap /src/build/bwrap /opt/zenera/bin/bwrap');
    });

    it('the runtime image pins every @zenera package and checks the version it installed', () => {
        const dockerfile = agentRuntimeDockerfile();
        for (const name of ['sandbox', 'neo', 'view', 'engine', 'server']) {
            expect(dockerfile).toContain(`"overrides.@zenera/${name}=$ZEN_VERSION"`);
        }
        expect(dockerfile).toContain('"dependencies.@zenera/cli=$ZEN_VERSION"');
        expect(dockerfile).toContain('--version)" = "$ZEN_VERSION"');
        expect(dockerfile).toContain('LABEL zenera.agent-runtime=1 zenera.version=$ZEN_VERSION');
        expect(dockerfile).toContain('org.opencontainers.image.source=');
    });

    it('agent-runtime.Dockerfile is agentRuntimeDockerfile() (npm run agent-runtime:dockerfile)', () => {
        const file = fileURLToPath(new URL('../agent-runtime.Dockerfile', import.meta.url));
        expect(readFileSync(file, 'utf8')).toBe(agentRuntimeDockerfile());
    });
});

describe('non-root agent containers', () => {
    it('passes API keys by environment name without putting values in argv', async () => {
        vi.mocked(credentials).mockReturnValue([
            { env: 'OPENAI_API_KEY', holds: 'secret', value: 'fake-api-key-for-test' },
        ]);
        vi.mocked(runProcess)
            .mockResolvedValueOnce(result('true\n'))
            .mockResolvedValueOnce(result('', 125));
        await expect(runContainer(run)).rejects.toThrow('could not start the agent container');
        const [, args, options] = vi.mocked(runProcess).mock.calls[1]!;
        expect(args).toContain('OPENAI_API_KEY');
        expect(args.join(' ')).not.toContain('fake-api-key-for-test');
        expect(options?.env?.OPENAI_API_KEY).toBe('fake-api-key-for-test');
    });

    it('reports credential preparation failures without launching the container', async () => {
        vi.mocked(credentials).mockReturnValue([
            { env: 'GOOGLE_APPLICATION_CREDENTIALS', holds: 'file', value: '/missing/adc.json' },
        ]);
        vi.mocked(runProcess)
            .mockResolvedValueOnce(result('true\n'))
            .mockResolvedValueOnce(result('', 125));
        await expect(runContainer(run)).rejects.toThrow(
            'could not prepare GOOGLE_APPLICATION_CREDENTIALS',
        );
        expect(runProcess).toHaveBeenCalledTimes(2);
    });

    it.each([true, false])(
        'removes secrets only after a confirmed stop (stopped=%s)',
        async (stopped) => {
            vi.mocked(credentials).mockReturnValue([
                {
                    env: 'GOOGLE_APPLICATION_CREDENTIALS',
                    holds: 'file',
                    value: '/private/adc.json',
                },
            ]);
            vi.mocked(runProcess)
                .mockResolvedValueOnce(result('true\n'))
                .mockResolvedValueOnce(result('created\n'))
                .mockResolvedValueOnce(result('test-container-id\n'))
                .mockResolvedValueOnce(result('', stopped ? 0 : 125))
                .mockResolvedValueOnce(result('removed\n'));
            vi.mocked(spawn).mockImplementation(() => {
                const logs = new ChildProcess();
                queueMicrotask(() => logs.emit('error', new Error('test log failure')));
                return logs;
            });
            await expect(runContainer(run)).rejects.toThrow(
                stopped ? 'test log failure' : 'could not stop the agent container',
            );
            expect(runProcess).toHaveBeenCalledTimes(stopped ? 5 : 4);
            const createdName = vi.mocked(runProcess).mock.calls[1]![1][2]!;
            const removed = vi
                .mocked(runProcess)
                .mock.calls.some(
                    ([, args]) =>
                        args[0] === 'secret' && args[1] === 'rm' && args[2] === createdName,
                );
            expect(removed).toBe(stopped);
        },
    );

    it('surfaces failed secret cleanup with a manual removal hint', async () => {
        vi.mocked(credentials).mockReturnValue([
            { env: 'GOOGLE_APPLICATION_CREDENTIALS', holds: 'file', value: '/private/adc.json' },
        ]);
        vi.mocked(runProcess)
            .mockResolvedValueOnce(result('true\n'))
            .mockResolvedValueOnce(result('created\n'))
            .mockResolvedValueOnce(result('', 125))
            .mockResolvedValueOnce(result('', 125));
        await expect(runContainer(run)).rejects.toMatchObject({
            message: expect.stringContaining('could not remove runtime credentials'),
            hint: expect.stringContaining('podman secret rm'),
        });
    });

    it('forwards project, location and gateway settings populated by the host keyring', async () => {
        vi.stubEnv('GOOGLE_CLOUD_PROJECT', undefined);
        vi.stubEnv('GOOGLE_CLOUD_LOCATION', undefined);
        vi.stubEnv('BIFROST_BASE_URL', undefined);
        materialize.mockImplementation(() => {
            process.env.GOOGLE_CLOUD_PROJECT = 'vertex-project';
            process.env.GOOGLE_CLOUD_LOCATION = 'europe-west4';
            process.env.BIFROST_BASE_URL = 'http://gateway.test';
            return {};
        });
        vi.mocked(runProcess)
            .mockResolvedValueOnce(result('true\n'))
            .mockResolvedValueOnce(result('', 125));
        await expect(runContainer(run)).rejects.toThrow('could not start the agent container');
        const [, args, options] = vi.mocked(runProcess).mock.calls[1]!;
        expect(args).toContain('GOOGLE_CLOUD_PROJECT');
        expect(args).toContain('GOOGLE_CLOUD_LOCATION');
        expect(args).toContain('BIFROST_BASE_URL');
        expect(args).not.toContain('vertex-project');
        expect(options?.env).toMatchObject({
            GOOGLE_CLOUD_PROJECT: 'vertex-project',
            GOOGLE_CLOUD_LOCATION: 'europe-west4',
            BIFROST_BASE_URL: 'http://gateway.test',
        });
    });

    it('mounts file credentials as private secrets and removes them after a startup failure', async () => {
        vi.mocked(credentials).mockReturnValue([
            {
                env: 'GOOGLE_APPLICATION_CREDENTIALS',
                holds: 'file',
                value: '/host/private/adc.json',
            },
        ]);
        vi.mocked(runProcess)
            .mockResolvedValueOnce(result('true\n'))
            .mockResolvedValueOnce(result('created\n'))
            .mockResolvedValueOnce(result('', 125))
            .mockResolvedValueOnce(result('removed\n'));
        await expect(runContainer(run)).rejects.toThrow('could not start the agent container');
        const create = vi.mocked(runProcess).mock.calls[1]![1];
        expect(create.slice(0, 2)).toEqual(['secret', 'create']);
        expect(create[3]).toBe('/host/private/adc.json');
        const name = create[2]!;
        const [, args, options] = vi.mocked(runProcess).mock.calls[2]!;
        expect(args).toContain(`${name},type=mount,uid=10001,gid=10001,mode=0400`);
        expect(args).toContain('GOOGLE_APPLICATION_CREDENTIALS');
        expect(options?.env?.GOOGLE_APPLICATION_CREDENTIALS).toBe(`/run/secrets/${name}`);
        expect(args).not.toContain('/host/private/adc.json');
        expect(runProcess).toHaveBeenLastCalledWith(
            'podman',
            ['secret', 'rm', name],
            expect.anything(),
        );
    });

    it('forwards ambient gcloud ADC when no explicit file variable is set', async () => {
        vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', undefined);
        vi.mocked(gcloudAdc).mockReturnValue('/host/gcloud/adc.json');
        vi.mocked(runProcess)
            .mockResolvedValueOnce(result('true\n'))
            .mockResolvedValueOnce(result('created\n'))
            .mockResolvedValueOnce(result('', 125))
            .mockResolvedValueOnce(result('removed\n'));
        await expect(runContainer(run)).rejects.toThrow('could not start the agent container');
        expect(vi.mocked(runProcess).mock.calls[1]![1][3]).toBe('/host/gcloud/adc.json');
    });

    it('loads relative credential paths from the project env file before keyring materialization', async () => {
        const project = mkdtempSync(join(root, 'project-env-'));
        writeFileSync(join(project, '.env'), 'GOOGLE_APPLICATION_CREDENTIALS=adc.json\n');
        vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', undefined);
        vi.mocked(credentials).mockImplementation(() => [
            {
                env: 'GOOGLE_APPLICATION_CREDENTIALS',
                holds: 'file',
                value: process.env.GOOGLE_APPLICATION_CREDENTIALS!,
            },
        ]);
        vi.mocked(runProcess)
            .mockResolvedValueOnce(result('true\n'))
            .mockResolvedValueOnce(result('created\n'))
            .mockResolvedValueOnce(result('', 125))
            .mockResolvedValueOnce(result('removed\n'));
        await expect(
            runContainer({ ...run, project: { dir: project, id: 'env-test' } }),
        ).rejects.toThrow('could not start the agent container');
        expect(vi.mocked(runProcess).mock.calls[1]![1][3]).toBe(join(project, 'adc.json'));
    });

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
        expect(args).toContain('ZEN_SERVER_HOST_MANAGED');
        expect(vi.mocked(runProcess).mock.calls[1]![2]?.env?.ZEN_SERVER_HOST_MANAGED).toBe('1');
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

    it('mounts a startup snapshot instead of the live WAL seed and cleans up on failure', async () => {
        const source = join(root, 'source');
        const memory = await MemoryStore.open(source);
        await memory.commit();
        memory.release();
        vi.mocked(runProcess)
            .mockResolvedValueOnce(result('true\n'))
            .mockResolvedValueOnce(result('', 125));
        await expect(runContainer({ ...run, memorySeed: source })).rejects.toThrow(
            'could not start the agent container',
        );
        const args = vi.mocked(runProcess).mock.calls[1]![1];
        const volume = args.find((arg) => arg.endsWith(':/seed:ro'))!;
        expect(volume).toMatch(/\.memory-seed-/);
        expect(volume).not.toBe(`${source}:/seed:ro`);
        expect(args).toContain(`${run.project.dir}:/project:ro`);
        expect(
            args.slice(args.indexOf('--memory-seed'), args.indexOf('--memory-seed') + 2),
        ).toEqual(['--memory-seed', '/seed']);
        expect(existsSync(volume.slice(0, -':/seed:ro'.length))).toBe(false);
    });

    it('does not fall back to live project memory when the startup seed is empty', async () => {
        vi.mocked(runProcess)
            .mockResolvedValueOnce(result('true\n'))
            .mockResolvedValueOnce(result('', 125));
        await expect(
            runContainer({ ...run, memorySeed: join(root, 'not-created') }),
        ).rejects.toThrow('could not start the agent container');
        const args = vi.mocked(runProcess).mock.calls[1]![1];
        expect(args).toContain('--no-memory-seed');
        expect(args).not.toContain('--memory-seed');
        expect(readdirSync(run.root).some((name) => name.startsWith('.memory-seed-'))).toBe(false);
    });

    it('keeps the seed until the launched container is stopped when log following fails', async () => {
        const source = join(root, 'lifecycle-source');
        const memory = await MemoryStore.open(source);
        await memory.commit();
        memory.release();
        vi.mocked(runProcess)
            .mockResolvedValueOnce(result('true\n'))
            .mockResolvedValueOnce(result('test-container-id\n'))
            .mockImplementationOnce(async () => {
                expect(readdirSync(run.root).some((name) => name.startsWith('.memory-seed-'))).toBe(
                    true,
                );
                return result('test-container-id\n');
            });
        vi.mocked(spawn).mockImplementation(() => {
            const logs = new ChildProcess();
            queueMicrotask(() => logs.emit('error', new Error('test log follower failure')));
            return logs;
        });
        await expect(runContainer({ ...run, memorySeed: source })).rejects.toThrow(
            'test log follower failure',
        );
        expect(runProcess).toHaveBeenLastCalledWith(
            'podman',
            ['stop', '--ignore', '--time', '25', 'test-container-id'],
            expect.anything(),
        );
        expect(readdirSync(run.root).some((name) => name.startsWith('.memory-seed-'))).toBe(false);
    });
});
