// `zen check` and `zen run --podman` with a plugin that provides the sandbox: ZEN_PLUGINS is read
// when the engine is first imported, so each test stubs it and imports a fresh module graph.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'zen-provider-cli-'));
let n = 0;
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    delete (globalThis as { __svc?: unknown }).__svc;
});

interface Seen {
    prepared: number;
    exec: string[];
    closed: number;
    opened: { key: string; build?: unknown }[];
}

/** A plugin module providing a sandbox that answers like one, and records what it was asked. */
function plugin(prepare = 'async () => {}'): string {
    const path = join(root, `svc-${n++}.mjs`);
    writeFileSync(
        path,
        `
const seen = (globalThis.__svc ??= { prepared: 0, exec: [], closed: 0, opened: [] });
export default {
    name: 'svc',
    sandbox: () => ({
        describe: 'svc (test)',
        newSandbox: (opts) => {
            seen.opened.push({ key: opts.key, build: opts.build });
            return {
                name: 'svc-box', started: false, fs: undefined,
                files: (v) => v,
                prepare: async (...a) => { seen.prepared++; return (${prepare})(...a); },
                start: async () => {},
                exec: async (cmd) => { seen.exec.push(cmd); return { exit_code: 0, stdout: 'zen-check\\n/workspace\\n', stderr: '', duration_ms: 1 }; },
                startJob: async () => 'job', readJob: async () => ({}), stopJob: async () => ({}),
                close: async () => { seen.closed++; },
            };
        },
    }),
};
`,
    );
    return path;
}

function project(): string {
    const dir = join(root, `p${n++}`);
    mkdirSync(join(dir, 'sandbox'), { recursive: true });
    writeFileSync(join(dir, 'sandbox', 'Dockerfile'), 'FROM scratch\n');
    writeFileSync(
        join(dir, 'agents.yaml'),
        'version: 1\nmodel: gpt-4o\n' +
            'sandbox:\n    build:\n        dockerfile: sandbox/Dockerfile\n' +
            'agents:\n  - name: solo\n    tools: [sandbox:*]\n',
    );
    return dir;
}

const seen = (): Seen => (globalThis as unknown as { __svc: Seen }).__svc;

describe('zen check with a plugin that provides the sandbox', () => {
    it('prepares and smoke-tests the sandbox there, never podman', async () => {
        vi.stubEnv('ZEN_PLUGINS', plugin());
        const { validateProject } = await import('../src/validate.ts');
        const podman = vi.fn();
        const report = await validateProject({
            dir: project(),
            sandbox: { enabled: true, exec: podman },
        });

        expect(report.findings.filter((f) => f.severity === 'error')).toEqual([]);
        expect(report.sandbox.probed).toBe(true);
        expect(podman).not.toHaveBeenCalled();
        expect(seen().opened).toEqual([
            { key: 'check', build: expect.objectContaining({ dockerfile: expect.any(String) }) },
        ]);
        expect(seen().prepared).toBe(1);
        expect(seen().exec[0]).toContain('zen-check');
        expect(seen().closed).toBe(1);
    });

    it('reports a sandbox the plugin could not prepare', async () => {
        vi.stubEnv('ZEN_PLUGINS', plugin("async () => { throw new Error('service down'); }"));
        const { validateProject } = await import('../src/validate.ts');
        const report = await validateProject({
            dir: project(),
            sandbox: { enabled: true, exec: vi.fn() },
        });
        const found = report.findings.find((f) => f.code === 'sandbox.unreachable');
        expect(found?.severity).toBe('error');
        expect(found?.message).toContain('svc (test)');
        expect(found?.message).toContain('service down');
        expect(report.sandbox.probed).toBe(false);
    });

    it('blames the Dockerfile for a build the service ran and failed', async () => {
        vi.stubEnv(
            'ZEN_PLUGINS',
            plugin(
                "async () => { throw Object.assign(new Error('could not build'), { name: 'ImageBuildError', hint: 'npm ERR! 404' }); }",
            ),
        );
        const { validateProject } = await import('../src/validate.ts');
        const report = await validateProject({
            dir: project(),
            sandbox: { enabled: true, exec: vi.fn() },
        });
        const found = report.findings.find((f) => f.code === 'sandbox.build');
        expect(found?.message).toContain('npm ERR! 404');
    });
});

describe('getting the image ready with a plugin that provides the sandbox', () => {
    it('prepares it there, on a sandbox it never starts, and says where', async () => {
        vi.stubEnv('ZEN_PLUGINS', plugin('async (o) => { globalThis.__svc.force = o?.force; }'));
        const { prepareOnProvider } = await import('../src/sandbox.ts');
        const { resolveBuild } = await import('@zenera/engine');
        const dir = project();
        const build = resolveBuild(dir, { build: { dockerfile: 'sandbox/Dockerfile' } });

        const where = await prepareOnProvider({ dir, name: 'p' }, undefined, build, {
            force: true,
        });

        expect(where).toBe('svc (test)');
        expect(seen().opened).toEqual([
            { key: 'prepare', build: { dockerfile: build!.dockerfile, context: build!.context } },
        ]);
        expect(seen().prepared).toBe(1);
        expect((seen() as Seen & { force?: boolean }).force).toBe(true);
        expect(seen().exec).toEqual([]);
        expect(seen().closed).toBe(1);
    });

    it('is not its business when no plugin provides the sandbox', async () => {
        vi.stubEnv('ZEN_PLUGINS', '');
        const { prepareOnProvider } = await import('../src/sandbox.ts');
        expect(await prepareOnProvider({ dir: project(), name: 'p' }, undefined, undefined)).toBe(
            undefined,
        );
    });

    it('reports a build the service ran and failed as a build error', async () => {
        vi.stubEnv(
            'ZEN_PLUGINS',
            plugin(
                "async () => { throw Object.assign(new Error('could not build'), { name: 'ImageBuildError', hint: 'npm ERR! 404' }); }",
            ),
        );
        const { prepareOnProvider } = await import('../src/sandbox.ts');
        const { BuildError } = await import('../src/podman.ts');
        await expect(
            prepareOnProvider({ dir: project(), name: 'p' }, undefined, undefined),
        ).rejects.toBeInstanceOf(BuildError);
        expect(seen().closed).toBe(1);
    });
});
