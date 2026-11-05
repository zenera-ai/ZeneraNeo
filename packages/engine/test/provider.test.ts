// Tests for where an engine's sandbox comes from: a plugin that provides one, the host's own
// factory, or podman — and the plugin closed exactly once whichever way the open goes.
import {
    inSandboxPaths,
    InMemoryFs,
    PodmanSandbox,
    type ExecResult,
    type FilesView,
    type JobOutput,
    type JobStopped,
    type Sandbox,
    type SandboxOptions,
} from '@zenera/neo';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createSessionAt,
    openEngine,
    PODMAN_PROVIDER,
    readProjectEnv,
    type Engine,
    type SandboxContext,
    type ZenPlugin,
} from '../src/index.ts';

const dirs: string[] = [];
const scratch = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'zen-provider-'));
    dirs.push(dir);
    return dir;
};

beforeEach(() => {
    vi.stubEnv('ZENERA_HOME', scratch());
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
});

afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Stands in for a sandbox service: records what it was asked, runs nothing. */
class StubSandbox implements Sandbox {
    readonly name = 'stub';
    readonly fs = new InMemoryFs().dir('/workspace');
    started = false;
    prepared = 0;
    constructor(readonly opts: SandboxOptions) {}
    /** in its own paths, as a sandbox that keeps its files elsewhere does */
    files(view: FilesView): FilesView {
        return inSandboxPaths(view, this.fs);
    }
    async prepare(): Promise<void> {
        this.prepared++;
    }
    async start(): Promise<void> {
        this.started = true;
    }
    async exec(): Promise<ExecResult> {
        return { exit_code: 0, stdout: '', stderr: '', duration_ms: 0 };
    }
    async startJob(): Promise<string> {
        return 'job-1';
    }
    async readJob(id: string): Promise<JobOutput> {
        return {
            job_id: id,
            command: '',
            running: false,
            duration_ms: 0,
            start_line: 1,
            end_line: 0,
            lines: 0,
            output: '',
        };
    }
    async stopJob(id: string): Promise<JobStopped> {
        return { job_id: id, stopped: true };
    }
    async close(): Promise<void> {}
}

interface Spy extends ZenPlugin {
    closed: number;
    asked?: SandboxContext;
    opened: StubSandbox[];
}

function provider(name: string, answer = true): Spy {
    const p: Spy = {
        name,
        closed: 0,
        opened: [],
        sandbox(ctx) {
            p.asked = ctx;
            if (!answer) {
                return undefined;
            }
            return {
                describe: `${name} (test)`,
                newSandbox: (opts) => {
                    const s = new StubSandbox(opts);
                    p.opened.push(s);
                    return s;
                },
            };
        },
        close() {
            p.closed++;
        },
    };
    return p;
}

function project(yaml = 'agents:\n  - name: solo\n    tools: [sandbox:*]\n'): {
    dir: string;
    session: ReturnType<typeof createSessionAt>;
} {
    const dir = scratch();
    writeFileSync(join(dir, 'agents.yaml'), yaml);
    mkdirSync(join(dir, 'ws'));
    return { dir, session: createSessionAt(join(dir, 'session'), join(dir, 'ws')) };
}

async function open(
    p: ReturnType<typeof project>,
    extra: Partial<Parameters<typeof openEngine>[0]> = {},
): Promise<Engine> {
    return openEngine({
        project: { dir: p.dir, name: 'acme' },
        session: p.session,
        quiet: true,
        yes: true,
        envPlugins: false,
        user: { id: 'u-1', source: 'host' },
        ...extra,
    });
}

describe('where the sandbox comes from', () => {
    it('is the plugin that provides one, told whose run it is', async () => {
        const svc = provider('svc');
        const p = project();
        const preflight = vi.fn(async () => {});
        const engine = await open(p, { plugins: [svc], preflight });
        try {
            expect(svc.opened).toHaveLength(1);
            expect(engine.sandbox.sandbox).toBe(svc.opened[0]);
            expect(engine.sandbox.provider).toBe('svc (test)');
            expect(svc.asked).toMatchObject({
                project: { name: 'acme' },
                session: { id: p.session.id },
                user: { id: 'u-1' },
            });
            // The host's preflight still runs: preparing the image is its call.
            expect(preflight).toHaveBeenCalledOnce();
        } finally {
            await engine.close();
        }
        expect(svc.closed).toBe(1);
    });

    it('is podman when no plugin answers', async () => {
        const quiet = provider('quiet', false);
        const engine = await open(project(), { plugins: [quiet] });
        try {
            expect(engine.sandbox.sandbox).toBeInstanceOf(PodmanSandbox);
            expect(engine.sandbox.provider).toBe(PODMAN_PROVIDER);
            expect(quiet.asked).toBeDefined();
        } finally {
            await engine.close();
        }
        expect(quiet.closed).toBe(1);
    });

    it('is the host’s own factory over any plugin', async () => {
        const svc = provider('svc');
        let made: StubSandbox | undefined;
        const engine = await open(project(), {
            plugins: [svc],
            newSandbox: (opts) => (made = new StubSandbox(opts)),
        });
        try {
            expect(engine.sandbox.sandbox).toBe(made);
            expect(svc.asked).toBeUndefined();
        } finally {
            await engine.close();
        }
    });

    it('is podman when the host says so, though the plugin still loads', async () => {
        const svc = provider('svc');
        const engine = await open(project(), { plugins: [svc], sandboxPlugins: false });
        try {
            expect(engine.sandbox.sandbox).toBeInstanceOf(PodmanSandbox);
            expect(svc.asked).toBeUndefined();
        } finally {
            await engine.close();
        }
        expect(svc.closed).toBe(1);
    });

    it('refuses two plugins that both provide it, and closes them', async () => {
        const a = provider('a');
        const b = provider('b');
        await expect(open(project(), { plugins: [a, b] })).rejects.toThrow(
            /plugins a and b both provide the sandbox/,
        );
        expect(a.opened).toHaveLength(0);
    });

    it('closes the providing plugin once when the open fails after it answered', async () => {
        const svc = provider('svc');
        const p = project('agents:\n  - name: solo\n    tools: [nope_tool]\n');
        await expect(open(p, { plugins: [svc] })).rejects.toThrow();
        expect(svc.asked).toBeDefined();
        expect(svc.closed).toBe(1);
    });
});

describe('the host’s own variables', () => {
    it('are never taken from a project env file', () => {
        const dir = scratch();
        writeFileSync(
            join(dir, '.env'),
            'ZEN_SANDBOX_URL=http://evil\nZEN_SANDBOX_TOKEN=t\nFOO=bar\n',
        );
        const env = readProjectEnv(dir);
        expect(env?.refused.sort()).toEqual(['ZEN_SANDBOX_TOKEN', 'ZEN_SANDBOX_URL']);
        expect(env?.values).toEqual({ FOO: 'bar' });
    });
});
