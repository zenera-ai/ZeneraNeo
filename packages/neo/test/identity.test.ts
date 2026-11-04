import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadProject, parseConfig } from '../src/project/index.ts';
import {
    identityEnv,
    identityFromEnv,
    identityTools,
    type RunIdentity,
} from '../src/tools/identity.ts';
import { PodmanBox, type ProcOptions, type Runner } from '../src/tools/podman.ts';
import { tool, type ToolContext } from '../src/types.ts';

const roots: string[] = [];

afterEach(() => {
    for (const r of roots.splice(0)) {
        rmSync(r, { recursive: true, force: true });
    }
});

function project(yaml: string): string {
    const root = mkdtempSync(join(tmpdir(), 'zn-identity-'));
    roots.push(root);
    const path = join(root, 'agents.yaml');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, yaml, 'utf8');
    return root;
}

const ANN: RunIdentity = {
    id: 'u-1',
    email: 'ann@example.com',
    name: 'Ann',
    role: 'editor',
    source: 'host',
};

const lookup = tool({
    name: 'lookup',
    description: 'Looks something up.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: () => 'ok',
});

describe('the identity as variables', () => {
    it('exports what is known and nothing that is not', () => {
        expect(identityEnv({ id: 'u-1', source: 'host' })).toEqual({
            ZEN_USER_ID: 'u-1',
            ZEN_USER_SOURCE: 'host',
        });
        expect(identityEnv(ANN)).toEqual({
            ZEN_USER_ID: 'u-1',
            ZEN_USER_EMAIL: 'ann@example.com',
            ZEN_USER_NAME: 'Ann',
            ZEN_USER_ROLE: 'editor',
            ZEN_USER_SOURCE: 'host',
        });
        expect(identityEnv(undefined)).toEqual({});
    });

    it('reads back as local, whatever the variables claim', () => {
        const back = identityFromEnv({ ...identityEnv(ANN) });
        expect(back).toEqual({ ...ANN, source: 'local' });
        expect(identityFromEnv({ ZEN_USER_ID: '  ' })).toBeUndefined();
        expect(identityFromEnv({})).toBeUndefined();
    });
});

describe('current_user', () => {
    const call = (identity?: RunIdentity): unknown =>
        identityTools(identity)[0].execute({}, {} as ToolContext);

    it('answers with the user the host named', () => {
        expect(call(ANN)).toEqual({ authenticated: true, ...ANN });
    });

    it('says plainly when there is nobody', () => {
        expect(call()).toMatchObject({ authenticated: false });
    });

    it('describes itself the same whoever is signed in', () => {
        const [a] = identityTools(ANN);
        const [b] = identityTools({ id: 'u-2', source: 'host' });
        expect(a.description).toBe(b.description);
        expect(a.description).not.toContain('u-1');
    });
});

describe('a tool every agent gets', () => {
    async function tools(list: string | undefined): Promise<string[]> {
        const yaml = list
            ? `agents:\n  - name: solo\n    tools: ${list}\n`
            : 'agents:\n  - name: solo\n';
        const p = await loadProject(project(yaml), {
            tools: [lookup],
            alwaysTools: identityTools(ANN),
        });
        return p.registry.get('solo').tools.map((t) => t.name);
    }

    it('reaches an agent that names no tools at all', async () => {
        expect(await tools(undefined)).toEqual(['current_user']);
    });

    it('comes after the ones it chose', async () => {
        expect(await tools('[lookup]')).toEqual(['lookup', 'current_user']);
    });

    it('is not doubled when the config names it too', async () => {
        expect(await tools('[current_user, lookup]')).toEqual(['current_user', 'lookup']);
        expect(await tools("['*']")).toEqual(['lookup', 'current_user']);
        expect(await tools('[identity:*]')).toEqual(['current_user']);
    });

    it('can still be taken away', async () => {
        expect(await tools('[lookup, -current_user]')).toEqual(['lookup']);
        expect(await tools('[lookup, -identity:*]')).toEqual(['lookup']);
    });
});

describe('the config', () => {
    it('refuses to forward a ZEN_USER_ variable of its own', () => {
        expect(() =>
            parseConfig(
                'agents:\n  - name: solo\nsandbox:\n  env: [ACME_TOKEN, ZEN_USER_ID]\n',
                'agents.yaml',
            ),
        ).toThrow(/ZEN_USER_ID is set by the host/);
    });
});

describe('the identity in the sandbox', () => {
    interface Call {
        args: string[];
        opts?: ProcOptions;
    }

    function box(over: Record<string, unknown> = {}): { b: PodmanBox; calls: Call[] } {
        const calls: Call[] = [];
        const run: Runner = (_bin, args, opts) => {
            calls.push({ args: [...args], opts });
            const missing = args.join(' ').includes('container inspect');
            return Promise.resolve({
                code: missing ? 1 : 0,
                stdout: '',
                stderr: missing ? 'no such container' : '',
                truncated: false,
                timedOut: false,
            });
        };
        const b = new PodmanBox({ root: '/host/ws', key: 'session-1', exec: run, ...over });
        return { b, calls };
    }

    it('rides on every command, not on the container', async () => {
        const { b, calls } = box({ execEnv: identityEnv(ANN) });
        await b.exec('id');
        await b.startJob('sleep 60');

        const create = calls.find((c) => c.args[0] === 'run');
        expect(create?.args.join(' ')).not.toContain('ZEN_USER');
        const execs = calls.filter((c) => c.args[0] === 'exec' && c.args.includes('-s'));
        expect(execs.length).toBeGreaterThanOrEqual(2);
        for (const e of execs.filter((c) => !c.args.includes('-c'))) {
            expect(e.args).toContain('ZEN_USER_ID=u-1');
            expect(e.args).toContain('ZEN_USER_ROLE=editor');
        }
    });

    it('does not rename the container', () => {
        const plain = box().b;
        const ann = box({ execEnv: identityEnv(ANN) }).b;
        const bob = box({ execEnv: identityEnv({ id: 'u-2', source: 'host' }) }).b;
        expect(ann.name).toBe(plain.name);
        expect(bob.name).toBe(plain.name);
    });

    it('extends a path in front of what the image set, without parsing the command', async () => {
        const { b, calls } = box({ execPaths: { PYTHONPATH: ['/home/agent/.zenera/python'] } });
        await b.exec('python -c "print($(whoami))"');
        const exec = calls.find((c) => c.args[0] === 'exec');
        expect(exec?.args.slice(-3)).toEqual([
            '/bin/sh',
            '-c',
            `export PYTHONPATH='/home/agent/.zenera/python'"\${PYTHONPATH:+:$PYTHONPATH}"; exec /bin/sh -s`,
        ]);
        expect(exec?.opts?.input).toBe('python -c "print($(whoami))"');
        expect(exec?.args.join(' ')).not.toContain('whoami');
    });

    it('refuses a variable name that is not one', () => {
        expect(() => box({ execEnv: { 'A;rm': 'x' } })).toThrow(/not a variable name/);
        expect(() => box({ execPaths: { 'P ATH': ['/x'] } })).toThrow(/not a variable name/);
    });
});
