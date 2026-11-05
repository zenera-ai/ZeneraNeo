import {
    logicalMounts,
    parseConfig,
    podmanSandbox,
    type PodmanSandbox,
    type RunIdentity,
    type SandboxFactory,
    type SandboxOptions,
} from '@zenera/neo';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    buildSandbox,
    createSessionAt,
    EngineError,
    prepareHome,
    readProjectEnv,
    resolveUser,
    teardown,
    RUNTIME_NODE,
    RUNTIME_PYTHON,
} from '../src/index.ts';

const dirs: string[] = [];
const scratch = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'zen-identity-'));
    dirs.push(dir);
    return dir;
};

afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ANN: RunIdentity = {
    id: 'u-1',
    email: 'ann@example.com',
    name: 'Ann',
    role: 'editor',
    source: 'host',
};

describe('who a run acts for', () => {
    it('is whoever the host says', () => {
        vi.stubEnv('ZEN_USER_ID', 'someone-else');
        expect(resolveUser(ANN)).toEqual(ANN);
    });

    it('is nobody when the host says nobody, whatever the environment holds', () => {
        vi.stubEnv('ZEN_USER_ID', 'someone-else');
        expect(resolveUser(null)).toBeUndefined();
    });

    it('falls back to the environment, and never as more than local', () => {
        vi.stubEnv('ZEN_USER_ID', 'u-9');
        vi.stubEnv('ZEN_USER_SOURCE', 'host');
        expect(resolveUser(undefined)).toEqual({ id: 'u-9', source: 'local' });
    });

    it('is nobody when nothing says otherwise', () => {
        vi.stubEnv('ZEN_USER_ID', '');
        expect(resolveUser(undefined)).toBeUndefined();
    });

    it('refuses a value that would break a variable', () => {
        expect(() => resolveUser({ id: 'u-1\nZEN_USER_ROLE=admin', source: 'host' })).toThrow(
            EngineError,
        );
        expect(() => resolveUser({ id: ' ', source: 'host' })).toThrow(/empty id/);
    });
});

describe('a project .env', () => {
    it('cannot say who the run is for', () => {
        const dir = scratch();
        writeFileSync(join(dir, '.env'), 'ACME_TOKEN=t\nZEN_USER_ID=admin\nZEN_USER_ROLE=owner\n');
        const env = readProjectEnv(dir);
        expect(env?.names).toEqual(['ACME_TOKEN']);
        expect(env?.refused).toEqual(['ZEN_USER_ID', 'ZEN_USER_ROLE']);
    });
});

describe('the sandbox a run gets', () => {
    function setup(identity?: RunIdentity, root = scratch()) {
        const session = createSessionAt(join(root, 'session'), join(root, 'ws'));
        return buildSandbox({
            config: parseConfig('agents:\n  - name: solo\n  - name: other\n', 'agents.yaml'),
            session,
            workspace: join(root, 'ws'),
            root,
            env: ['ACME_TOKEN', 'ZEN_USER_ID'],
            identity,
        });
    }

    it('carries the user on every command, never by name from the host', () => {
        const box = setup(ANN).sandbox as PodmanSandbox;
        expect(box.spec.execEnv).toMatchObject({ ZEN_USER_ID: 'u-1', ZEN_USER_ROLE: 'editor' });
        expect(box.spec.execPaths.PYTHONPATH).toEqual([RUNTIME_PYTHON]);
        expect(box.spec.secrets).not.toContain('ZEN_USER_ID');
        expect(Object.keys(box.spec.env).some((k) => k.startsWith('ZEN_USER_'))).toBe(false);
    });

    it('names the same containers whoever the user is', () => {
        const root = scratch();
        const names = [undefined, ANN, { id: 'u-2', source: 'host' as const }].map(
            (who) => setup(who, root).sandbox.name,
        );
        expect(new Set(names).size).toBe(1);
    });

    it('opens the sandbox the host chose, with the mounts labelled for one that cannot bind them', async () => {
        const root = scratch();
        const opened: SandboxOptions[] = [];
        let closed = 0;
        const newSandbox: SandboxFactory = (opts) => {
            opened.push(opts);
            return Object.assign(podmanSandbox(opts), { close: async () => void closed++ });
        };
        const paths = createSessionAt(join(root, 'session'), join(root, 'ws'));
        const s = buildSandbox({
            config: parseConfig('agents:\n  - name: solo\n', 'agents.yaml'),
            session: paths,
            workspace: join(root, 'ws'),
            root,
            keys: false,
            identity: ANN,
            newSandbox,
        });
        expect(opened).toHaveLength(1);
        expect(opened[0]).toMatchObject({ key: paths.id, root: join(root, 'ws') });
        expect(opened[0].execEnv).toMatchObject({ ZEN_USER_ID: 'u-1' });
        expect(logicalMounts(s.mounts)).toEqual([
            { at: '/home/agent', readOnly: false, source: { kind: 'home' } },
        ]);

        await teardown(s);
        expect(closed).toBe(1);
    });

    it('has no user at all when the run has none', () => {
        expect((setup().sandbox as PodmanSandbox).spec.execEnv).toEqual({});
    });
});

describe('the zenera libraries', () => {
    function installed(): { home: string; python: string; node: string } {
        const s = (() => {
            const root = scratch();
            return buildSandbox({
                config: parseConfig('agents:\n  - name: solo\n', 'agents.yaml'),
                session: createSessionAt(join(root, 'session'), join(root, 'ws')),
                workspace: join(root, 'ws'),
                root,
            });
        })();
        prepareHome(s);
        const at = (p: string) => join(s.home, p.replace('/home/agent/', ''));
        return { home: s.home, python: at(RUNTIME_PYTHON), node: at(RUNTIME_NODE) };
    }

    const env = (extra: Record<string, string>): NodeJS.ProcessEnv => {
        const clean = Object.fromEntries(
            Object.entries(process.env).filter(([k]) => !k.startsWith('ZEN_USER_')),
        );
        return { ...clean, ...extra };
    };

    it('are written into the home the container mounts', () => {
        const { python, node } = installed();
        expect(existsSync(join(python, 'zenera', '__init__.py'))).toBe(true);
        expect(existsSync(join(node, 'index.cjs'))).toBe(true);
        expect(existsSync(join(node, 'index.mjs'))).toBe(true);
    });

    it('answer from node, both module systems', () => {
        const { node } = installed();
        const vars = env({ ZEN_USER_ID: 'u-1', ZEN_USER_ROLE: 'viewer', ZEN_USER_SOURCE: 'host' });
        const cjs = spawnSync(
            process.execPath,
            ['-e', `console.log(JSON.stringify(require(${JSON.stringify(node)}).identity()))`],
            { env: vars, encoding: 'utf8' },
        );
        expect(JSON.parse(cjs.stdout)).toMatchObject({ id: 'u-1', role: 'viewer', source: 'host' });

        const esm = spawnSync(
            process.execPath,
            [
                '--input-type=module',
                '-e',
                `import { identity } from ${JSON.stringify(join(node, 'index.mjs'))}; console.log(JSON.stringify(identity()))`,
            ],
            { env: vars, encoding: 'utf8' },
        );
        expect(JSON.parse(esm.stdout)).toMatchObject({ id: 'u-1' });

        const none = spawnSync(
            process.execPath,
            ['-e', `require(${JSON.stringify(node)}).requireIdentity()`],
            { env: env({}), encoding: 'utf8' },
        );
        expect(none.status).not.toBe(0);
        expect(none.stderr).toMatch(/no signed-in user/);
    });

    const python = spawnSync('python3', ['--version']).status === 0;

    it.runIf(python)('answer from python', () => {
        const { python: path } = installed();
        const run = (vars: Record<string, string>, code: string) =>
            spawnSync('python3', ['-c', code], {
                env: env({ ...vars, PYTHONPATH: path }),
                encoding: 'utf8',
            });
        const ok = run(
            { ZEN_USER_ID: 'u-1', ZEN_USER_EMAIL: 'ann@example.com', ZEN_USER_SOURCE: 'host' },
            'import zenera, json; print(json.dumps(zenera.identity()._asdict()))',
        );
        expect(JSON.parse(ok.stdout)).toEqual({
            id: 'u-1',
            email: 'ann@example.com',
            name: null,
            role: null,
            source: 'host',
        });
        const none = run({}, 'import zenera; print(zenera.identity()); zenera.require_identity()');
        expect(none.stdout.trim()).toBe('None');
        expect(none.stderr).toMatch(/NoIdentityError/);
    });
});
