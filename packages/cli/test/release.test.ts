/**
 * Vitest coverage for `zen server build` release images (src/release.ts, commands/server.ts).
 * Tests check the project snapshot's exclusions and image-readable modes, releaseDockerfile,
 * --add and --release validation, podman push arguments and digests, push failures, and the
 * command's --json output. podman and the agent-image build are mocked: no real builds run.
 */
import type { ProcResult } from '@zenera/neo';
import { MemoryStore } from '@zenera/neo';
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@zenera/sandbox', async (original) => ({
    ...(await original<typeof import('@zenera/sandbox')>()),
    runProcess: vi.fn(),
}));
vi.mock('../src/serverDisplay.ts', async (original) => ({
    ...(await original<typeof import('../src/serverDisplay.ts')>()),
    streamAgentBuild: vi.fn(),
}));
vi.mock('../src/container.ts', async (original) => ({
    ...(await original<typeof import('../src/container.ts')>()),
    buildAgentImage: vi.fn(),
}));

import { runProcess } from '@zenera/sandbox';
import { server } from '../src/commands/server.ts';
import { complete } from '../src/complete.ts';
import { buildAgentImage } from '../src/container.ts';
import {
    buildReleaseImage,
    checkRelease,
    parseAdd,
    pushArgs,
    releaseDockerfile,
    snapshotProject,
} from '../src/release.ts';
import { streamAgentBuild } from '../src/serverDisplay.ts';
import { EXIT } from '../src/term.ts';

const DIGEST = `sha256:${'ab'.repeat(32)}`;
const AGENT = {
    tag: 'localhost/zenera-agent:0123456789ab',
    base: 'localhost/base:1',
    built: false,
};

let root: string;
let project: string;
/** What the last mocked `podman build` saw in its context: path → mode, and the Dockerfile. */
let seen: { files: Map<string, number>; dockerfile: string } | undefined;

const ok = (stdout = ''): ProcResult => ({
    code: 0,
    stdout,
    stderr: '',
    truncated: false,
    timedOut: false,
});
const failed = (stderr: string, code = 125): ProcResult => ({ ...ok(), code, stderr });

function snapshotOf(ctx: string): Map<string, number> {
    const files = new Map<string, number>();
    const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);
            files.set(relative(ctx, path), statSync(path).mode & 0o777);
            if (entry.isDirectory()) walk(path);
        }
    };
    walk(ctx);
    return files;
}

/** podman: inspect gives an id, exists says no, push writes the digest file. */
function podman(opts: { exists?: boolean; push?: ProcResult } = {}) {
    vi.mocked(runProcess).mockImplementation(async (_bin, args) => {
        if (args[0] === 'image' && args[1] === 'inspect') return ok('sha256:agentid\n');
        if (args[0] === 'image' && args[1] === 'exists') return opts.exists ? ok() : failed('', 1);
        if (args[0] === 'push') {
            if (opts.push) return opts.push;
            writeFileSync(args[args.indexOf('--digestfile') + 1]!, `${DIGEST}\n`);
            return ok();
        }
        return failed(`unexpected podman ${args.join(' ')}`);
    });
}

function write(rel: string, text = rel, mode = 0o644): void {
    const path = join(project, rel);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
    chmodSync(path, mode);
}

beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'zen-release-test-'));
    project = join(root, 'p1');
    vi.stubEnv('ZENERA_HOME', join(root, 'home'));
    vi.stubEnv('ZEN_PROJECT_ID', '');
    vi.stubEnv('PROJECT_DIR', '');
    write(
        'agents.yaml',
        'version: 1\nmemory:\n  dir: knowledge\nagents:\n  - name: main\n    model: openai:gpt-4o-mini\n',
    );
    for (const rel of [
        '.env',
        '.env.local',
        '.env.example',
        'sessions/s1.json',
        '.git/HEAD',
        'node_modules/x/index.js',
        '.tmp/scratch',
        'memory/stray.txt',
        'assets/docs/a.md',
        'sandbox/Dockerfile',
    ]) {
        write(rel);
    }
    write('assets/private.txt', 'owner only', 0o600);
    write('scripts/run.sh', '#!/bin/sh\n', 0o700);
    const store = await MemoryStore.open(join(project, 'knowledge'));
    store.write(() => {
        store.graph.add(
            { id: 'seeded', kind: 'fact', text: 'seeded', audience: ['*'] },
            new Date().toISOString(),
        );
    });
    store.release();
    seen = undefined;
    vi.mocked(runProcess).mockReset();
    vi.mocked(buildAgentImage).mockReset().mockResolvedValue(AGENT);
    vi.mocked(streamAgentBuild)
        .mockReset()
        .mockImplementation(async (_bin, args) => {
            const ctx = args.at(-1)!;
            seen = {
                files: snapshotOf(ctx),
                dockerfile: readFileSync(join(ctx, 'Dockerfile'), 'utf8'),
            };
        });
});
afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
});

describe('the project snapshot', () => {
    it('carries the project, never its credentials, run state or memory', async () => {
        const into = join(root, 'snap');
        await snapshotProject(project, into);
        const files = [...snapshotOf(into).keys()].sort();
        expect(files).toEqual(
            expect.arrayContaining([
                '.env.example',
                'agents.yaml',
                'assets/docs/a.md',
                'assets/private.txt',
                'sandbox/Dockerfile',
                'scripts/run.sh',
            ]),
        );
        for (const gone of ['.env', '.env.local', 'sessions', '.git', 'node_modules', '.tmp']) {
            expect(files).not.toContain(gone);
        }
        // `memory/` is never carried, and neither is the memory configured under another name.
        expect(files.some((f) => f.startsWith('knowledge'))).toBe(false);
        expect(files.some((f) => f.startsWith('memory'))).toBe(false);
    });

    it('normalizes modes so the image user can read everything', async () => {
        const into = join(root, 'snap');
        await snapshotProject(project, into);
        const modes = snapshotOf(into);
        expect(modes.get('assets/private.txt')).toBe(0o644);
        expect(modes.get('agents.yaml')).toBe(0o644);
        expect(modes.get('scripts/run.sh')).toBe(0o755);
        expect(modes.get('assets')).toBe(0o755);
        expect(modes.get('assets/docs')).toBe(0o755);
        expect(statSync(into).mode & 0o777).toBe(0o755);
    });
});

describe('releaseDockerfile', () => {
    it('layers the project on the agent image as the image user', () => {
        const text = releaseDockerfile(AGENT.tag, {
            release: 'r42',
            projectId: 'p1',
            seed: false,
            adds: [],
        });
        expect(text).toBe(
            [
                '# Generated by zen server build. A release: the agent image plus the project.',
                `FROM ${AGENT.tag}`,
                'USER root',
                'COPY project/ /project/',
                'USER 10001:10001',
                'ENV ZEN_RELEASE="r42" ZEN_PROJECT_ID="p1"',
                'LABEL zenera.release="r42" zenera.project="p1"',
                '',
            ].join('\n'),
        );
    });

    it('adds the seed and every --add layer in order', () => {
        const text = releaseDockerfile(AGENT.tag, {
            release: 'r42',
            projectId: 'p1',
            seed: true,
            adds: [
                { ctxPath: 'add/0/', dest: '/opt/zenera/plugins/' },
                { ctxPath: 'add/1/file', dest: '/etc/zen/extra.json' },
            ],
        });
        const lines = text.split('\n');
        const at = lines.indexOf('COPY project/ /project/');
        expect(lines.slice(at, at + 5)).toEqual([
            'COPY project/ /project/',
            'COPY seed/ /seed/',
            'COPY add/0/ /opt/zenera/plugins/',
            'COPY add/1/file /etc/zen/extra.json',
            'USER 10001:10001',
        ]);
    });
});

describe('flag validation', () => {
    it('accepts a source that exists and an absolute destination of its own', () => {
        expect(parseAdd('assets:/opt/zenera/plugins/', project)).toEqual({
            src: join(project, 'assets'),
            dest: '/opt/zenera/plugins',
        });
    });

    it.each([
        ['assets:opt/plugins', 'must be absolute'],
        ['assets:/opt/../etc', "must not contain '..'"],
        ['assets:/opt//x', 'not normalized'],
        ['assets:/opt/a b', 'whitespace'],
        ['assets', 'not <src>:<dest>'],
        ['missing:/opt/x', 'does not exist'],
        ...['/project', '/project/x', '/seed', '/state/a', '/workspace', '/opt/zenera/app'].map(
            (d) => [`assets:${d}`, 'would overlay'],
        ),
        ['assets:/opt/zenera/bin/node', 'would overlay'],
        ['assets:/opt/zenera', 'would overlay'],
        ['assets:/', 'would overlay'],
    ])('rejects --add %s', (spec, message) => {
        expect(() => parseAdd(spec, project)).toThrow(message);
    });

    it('checks release ids', () => {
        expect(checkRelease('r42')).toBe('r42');
        expect(checkRelease('2026.11.08-rc_1')).toBe('2026.11.08-rc_1');
        for (const bad of ['', '-r', '.r', 'r/1', 'r 1', 'a'.repeat(65)]) {
            expect(() => checkRelease(bad)).toThrow('not a release id');
        }
    });
});

describe('podman push', () => {
    it('builds the push arguments with and without auth and TLS', () => {
        const tag = 'localhost/zenera-release:abc';
        expect(pushArgs(tag, { ref: 'registry.local:5000/agent-p1:r42' }, '/d')).toEqual([
            'push',
            '--digestfile',
            '/d',
            tag,
            'docker://registry.local:5000/agent-p1:r42',
        ]);
        expect(
            pushArgs(
                tag,
                { ref: 'docker://reg:5000/a:1', authfile: '/auth.json', insecure: true },
                '/d',
            ),
        ).toEqual([
            'push',
            '--digestfile',
            '/d',
            '--authfile',
            '/auth.json',
            '--tls-verify=false',
            tag,
            'docker://reg:5000/a:1',
        ]);
    });
});

describe('buildReleaseImage', () => {
    it('builds the agent image, then the release with project and seed', async () => {
        podman();
        const result = await buildReleaseImage(project, { release: 'r42', projectId: 'p1' });
        expect(buildAgentImage).toHaveBeenCalledWith(project, {
            rebuild: undefined,
            verbose: undefined,
        });
        expect(result).toMatchObject({
            release: 'r42',
            agentImage: AGENT.tag,
            base: AGENT.base,
            built: true,
        });
        expect(result.image).toMatch(/^localhost\/zenera-release:[0-9a-f]{12}$/);
        expect(result.digest).toBeUndefined();
        expect(seen!.dockerfile).toContain('COPY seed/ /seed/');
        expect(seen!.dockerfile).toContain('ENV ZEN_RELEASE="r42" ZEN_PROJECT_ID=');
        expect(seen!.files.get('seed')).toBe(0o755);
        expect(seen!.files.has('project/.env')).toBe(false);
        expect(seen!.files.has('project/knowledge')).toBe(false);
        expect(seen!.files.get('project/scripts/run.sh')).toBe(0o755);
        // The context is gone afterwards.
        expect(readdirSync(join(root, 'home', 'images'))).toEqual([]);
    });

    it('names a release by its content when no id is given, and skips a present image', async () => {
        podman();
        const first = await buildReleaseImage(project, { memorySeed: null });
        podman({ exists: true });
        const second = await buildReleaseImage(project, { memorySeed: null });
        expect(first.release).toMatch(/^r-[0-9a-f]{12}$/);
        expect(second.release).toBe(first.release);
        expect(second.image).toBe(first.image);
        expect(second.built).toBe(false);
        expect(streamAgentBuild).toHaveBeenCalledTimes(1);
        expect(seen!.dockerfile).not.toContain('/seed');
        write('agents.md', 'changed');
        podman();
        expect((await buildReleaseImage(project, { memorySeed: null })).release).not.toBe(
            first.release,
        );
    });

    it('copies --add trees with readable modes', async () => {
        podman();
        const plugins = join(root, 'plugins');
        mkdirSync(join(plugins, 'bin'), { recursive: true });
        writeFileSync(join(plugins, 'bin', 'tool'), '#!/bin/sh\n', { mode: 0o700 });
        writeFileSync(join(plugins, 'plugin.json'), '{}', { mode: 0o600 });
        await buildReleaseImage(project, {
            release: 'r1',
            memorySeed: null,
            adds: [parseAdd(`${plugins}:/opt/zenera/plugins`, root)],
        });
        expect(seen!.dockerfile).toContain('COPY add/0/ /opt/zenera/plugins/');
        expect(seen!.files.get('add/0/plugin.json')).toBe(0o644);
        expect(seen!.files.get('add/0/bin/tool')).toBe(0o755);
        expect(seen!.files.get('add/0/bin')).toBe(0o755);
    });

    it('pushes and reports the digest', async () => {
        podman({ exists: true });
        const result = await buildReleaseImage(project, {
            release: 'r42',
            push: { ref: 'reg:5000/agent-p1:r42', insecure: true },
        });
        expect(result).toMatchObject({ ref: 'reg:5000/agent-p1:r42', digest: DIGEST });
        const push = vi.mocked(runProcess).mock.calls.find(([, a]) => a[0] === 'push')!;
        expect(push[1]).toContain('--tls-verify=false');
        expect(push[1].at(-2)).toBe(result.image);
    });

    it('explains a failed push', async () => {
        podman({
            exists: true,
            push: failed(
                'Getting image source signatures\nError: authentication required\nmore detail',
            ),
        });
        const err = await buildReleaseImage(project, {
            release: 'r42',
            push: { ref: 'reg:5000/a:1' },
        }).catch((e: unknown) => e);
        expect(err).toMatchObject({
            message: expect.stringContaining('authentication required'),
            code: EXIT.failed,
            hint: expect.stringContaining('--authfile'),
        });
        expect((err as Error).message).not.toContain('more detail');
        expect((err as Error).message).not.toContain('signatures');
        expect((err as { hint: string }).hint).toContain('--insecure-registry');
        expect(readdirSync(join(root, 'home', 'images'))).toEqual([]);
    });
});

describe('zen server build', () => {
    it('is in the help and completes', async () => {
        expect(server.usage).toContain('|build|');
        expect(server.details?.join('\n')).toContain('--insecure-registry');
        expect(await complete(['server', 'bu'], root)).toEqual([{ value: 'build' }]);
    });

    it('prints the result as JSON', async () => {
        podman();
        const out: string[] = [];
        vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
            out.push(String(chunk));
            return true;
        });
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        await server.run({
            args: [
                'build',
                '--project',
                project,
                '--release',
                'r7',
                '--push',
                'reg:5000/agent:r7',
                '--insecure-registry',
            ],
            cwd: root,
            json: true,
        });
        const result = JSON.parse(out.join(''));
        expect(result).toEqual({
            release: 'r7',
            image: expect.stringMatching(/^localhost\/zenera-release:/),
            agentImage: AGENT.tag,
            base: AGENT.base,
            built: true,
            ref: 'reg:5000/agent:r7',
            digest: DIGEST,
        });
        expect(seen!.dockerfile).toContain('zenera.project="p1"');
    });

    it('prints the digest alone on stdout without --json', async () => {
        podman();
        const out: string[] = [];
        vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
            out.push(String(chunk));
            return true;
        });
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        await server.run({
            args: ['build', '--project', project, '--push', 'reg:5000/agent:r7'],
            cwd: root,
            json: false,
        });
        expect(out.join('')).toBe(`${DIGEST}\n`);
    });

    it.each([
        [['--release', 'bad/id'], 'not a release id'],
        [['--add', 'assets:/project/x'], 'would overlay'],
        [['--authfile', 'auth.json'], 'go with --push'],
        [['--insecure-registry'], 'go with --push'],
        [['--memory-seed', 'x', '--no-memory-seed'], '--memory-seed or --no-memory-seed'],
    ])('rejects %j before building', async (flags, message) => {
        await expect(
            server.run({
                args: ['build', '--project', project, ...flags],
                cwd: project,
                json: true,
            }),
        ).rejects.toMatchObject({ code: EXIT.usage, message: expect.stringContaining(message) });
        expect(buildAgentImage).not.toHaveBeenCalled();
        expect(existsSync(join(root, 'home', 'images'))).toBe(false);
    });
});
