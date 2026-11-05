import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    buildIdentity,
    ensurePodmanImage,
    ImageBuildError,
    localImageTag,
    MAX_CONTEXT_FILES,
    PodmanSandbox,
    SandboxError,
    type ProcResult,
    type Runner,
} from '../src/index.ts';

const dirs: string[] = [];
afterEach(() => {
    for (const d of dirs.splice(0)) {
        rmSync(d, { recursive: true, force: true });
    }
});

function context(files: Record<string, string> = {}): { dockerfile: string; context: string } {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'zen-image-')));
    dirs.push(dir);
    writeFileSync(join(dir, 'Dockerfile'), 'FROM scratch\n');
    for (const [rel, body] of Object.entries(files)) {
        mkdirSync(join(dir, rel, '..'), { recursive: true });
        writeFileSync(join(dir, rel), body);
    }
    return { dockerfile: join(dir, 'Dockerfile'), context: dir };
}

/** A podman that answers from a table, and remembers what it was asked. */
function engine(answers: Record<string, Partial<ProcResult>> = {}) {
    const seen: string[] = [];
    const run: Runner = async (bin, args) => {
        const line = [bin, ...args].join(' ');
        seen.push(line);
        const hit = Object.entries(answers).find(([prefix]) => line.startsWith(prefix))?.[1];
        return { code: 0, stdout: '', stderr: '', truncated: false, timedOut: false, ...hit };
    };
    return { run, seen };
}

describe('build identity', () => {
    it('is a function of the Dockerfile and every file in the context', () => {
        const a = context({ 'app/main.py': 'print(1)' });
        const before = buildIdentity(a);
        expect(before.hash).toMatch(/^[0-9a-f]{12}$/);
        expect(before.files).toEqual(['Dockerfile', 'app/main.py']);
        expect(buildIdentity(a)).toEqual(before);

        writeFileSync(join(a.context, 'app/main.py'), 'print(2)');
        expect(buildIdentity(a).hash).not.toBe(before.hash);
    });

    it('hashes arguments only when there are any', () => {
        const a = context();
        const bare = buildIdentity(a).hash;
        expect(buildIdentity({ ...a, args: {} }).hash).toBe(bare);
        const one = buildIdentity({ ...a, args: { ZEN_VERSION: '1.2.0' } }).hash;
        expect(one).not.toBe(bare);
        expect(buildIdentity({ ...a, args: { ZEN_VERSION: '1.2.1' } }).hash).not.toBe(one);
    });

    it('tags a build under the local repository', () => {
        const a = context();
        expect(localImageTag(a)).toBe(`localhost/zenera-sandbox:${buildIdentity(a).hash}`);
    });

    it('refuses a context too large to be one', () => {
        const files: Record<string, string> = {};
        for (let i = 0; i <= MAX_CONTEXT_FILES; i++) {
            files[`f${i}`] = '';
        }
        expect(() => buildIdentity(context(files))).toThrow(SandboxError);
    });
});

describe('ensurePodmanImage', () => {
    it('does nothing when the engine already has the image', async () => {
        const f = engine();
        await ensurePodmanImage({ image: 'img:present' }, { exec: f.run });
        expect(f.seen).toEqual(['podman image exists img:present']);
    });

    it('pulls an image it does not have, and says so', async () => {
        const f = engine({ 'podman image exists': { code: 1 } });
        const lines: string[] = [];
        await ensurePodmanImage(
            { image: 'img:pull' },
            { exec: f.run },
            { onProgress: (l) => lines.push(l) },
        );
        expect(f.seen).toEqual(['podman image exists img:pull', 'podman pull img:pull']);
        expect(lines[0]).toContain('pulling img:pull');
    });

    it('builds a Dockerfile under its tag, with its arguments', async () => {
        const f = engine({ 'podman image exists': { code: 1 } });
        const build = { dockerfile: '/p/D', context: '/p', args: { ZEN_VERSION: '9' } };
        await ensurePodmanImage({ image: 'local:b', build }, { exec: f.run });
        expect(f.seen).toContain(
            'podman build --tag local:b --file /p/D --build-arg ZEN_VERSION=9 /p',
        );
    });

    it('runs a step through the host’s slow wrapper', async () => {
        const f = engine({ 'podman image exists': { code: 1 } });
        const labels: string[] = [];
        await ensurePodmanImage(
            { image: 'img:slow' },
            { exec: f.run },
            {
                slow: (label, work) => {
                    labels.push(label);
                    return work;
                },
            },
        );
        expect(labels).toEqual(['pulling']);
    });

    it('rebuilds when forced, even with the image present', async () => {
        const f = engine();
        const build = { dockerfile: '/p/D', context: '/p' };
        await ensurePodmanImage({ image: 'local:f', build }, { exec: f.run }, { force: true });
        expect(f.seen).toEqual(['podman build --tag local:f --file /p/D /p']);
    });

    it('refuses to build when the host says images are built elsewhere', async () => {
        const f = engine({ 'podman image exists': { code: 1 } });
        const build = { dockerfile: '/p/D', context: '/p' };
        await expect(
            ensurePodmanImage({ image: 'local:no', build }, { exec: f.run }, { allowBuild: false }),
        ).rejects.toThrow(/not built/);
        expect(f.seen.some((l) => l.includes(' build '))).toBe(false);
    });

    it('tells a failed build from an engine that could not be asked', async () => {
        const f = engine({
            'podman image exists': { code: 1 },
            'podman build': { code: 1, stderr: 'STEP 2/3\nError: npm ERR! 404' },
        });
        const build = { dockerfile: '/p/D', context: '/p' };
        const err = await ensurePodmanImage({ image: 'local:bad', build }, { exec: f.run }).catch(
            (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(ImageBuildError);
        expect((err as ImageBuildError).hint).toContain('npm ERR! 404');
    });

    it('settles one image once, however many ask at the same time', async () => {
        const f = engine({ 'podman image exists': { code: 1 } });
        await Promise.all([
            ensurePodmanImage({ image: 'img:once' }, { exec: f.run }),
            ensurePodmanImage({ image: 'img:once' }, { exec: f.run }),
        ]);
        await ensurePodmanImage({ image: 'img:once' }, { exec: f.run });
        expect(f.seen.filter((l) => l.startsWith('podman pull'))).toHaveLength(1);
    });

    it('does not remember a failure', async () => {
        let fail = true;
        const seen: string[] = [];
        const run: Runner = async (bin, args) => {
            seen.push(args.join(' '));
            const code = args[0] === 'image' ? 1 : fail ? 1 : 0;
            return { code, stdout: '', stderr: 'nope', truncated: false, timedOut: false };
        };
        await expect(ensurePodmanImage({ image: 'img:retry' }, { exec: run })).rejects.toThrow();
        fail = false;
        await ensurePodmanImage({ image: 'img:retry' }, { exec: run });
        expect(seen.filter((l) => l.startsWith('pull'))).toHaveLength(2);
    });
});

describe('PodmanSandbox and its image', () => {
    it('runs a build under the tag of its content, and builds it before creating', async () => {
        const a = context();
        const f = engine({
            'podman container inspect': { code: 1 },
            'podman image exists': { code: 1 },
        });
        const box = new PodmanSandbox({ root: a.context, key: 's', build: a }, { exec: f.run });
        expect(box.spec.image).toBe(localImageTag(a));
        await box.start();
        const build = f.seen.findIndex((l) => l.startsWith('podman build'));
        const run = f.seen.findIndex((l) => l.startsWith('podman run'));
        expect(build).toBeGreaterThan(-1);
        expect(run).toBeGreaterThan(build);
    });

    it('leaves a registry image to `podman run`, and prepares it only when asked', async () => {
        const f = engine({ 'podman container inspect': { code: 1 } });
        const box = new PodmanSandbox({ root: '/w', key: 's', image: 'img:run' }, { exec: f.run });
        await box.start();
        expect(f.seen.some((l) => l.includes('image exists'))).toBe(false);

        const g = engine();
        const other = new PodmanSandbox(
            { root: '/w', key: 't', image: 'img:prep' },
            { exec: g.run },
        );
        await other.prepare();
        await other.prepare();
        expect(g.seen).toEqual(['podman image exists img:prep']);
        expect(other.started).toBe(false);
    });
});
