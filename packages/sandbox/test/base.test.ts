import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
    ensurePodmanImage,
    ensureSandboxBases,
    SANDBOX_BASE_REPO,
    sandboxBaseDockerfile,
    sandboxBasesOf,
    type ProcResult,
    type Runner,
} from '../src/index.ts';

const dirs: string[] = [];
afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function project(dockerfile: string): { dockerfile: string; context: string } {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'zen-base-')));
    dirs.push(dir);
    writeFileSync(join(dir, 'Dockerfile'), dockerfile);
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

const BASE = `${SANDBOX_BASE_REPO}:1.2.5`;

describe('sandbox base', () => {
    it('finds the zenera bases a Dockerfile starts FROM, by version', () => {
        expect(
            sandboxBasesOf(
                `# FROM ${SANDBOX_BASE_REPO}:0.0.1 in a comment is not a FROM\n` +
                    `FROM ${BASE} AS base\nfrom --platform=linux/amd64 ${SANDBOX_BASE_REPO}:2.0.0\n` +
                    'FROM docker.io/library/python:3.14\n',
            ),
        ).toEqual([
            { image: BASE, version: '1.2.5' },
            { image: `${SANDBOX_BASE_REPO}:2.0.0`, version: '2.0.0' },
        ]);
        expect(sandboxBasesOf('FROM python:3.14\n')).toEqual([]);
    });

    it('leaves a base that is already here alone', async () => {
        const { run, seen } = engine();
        await ensureSandboxBases('podman', run, project(`FROM ${BASE}\n`).dockerfile);
        expect(seen).toEqual([`podman image exists ${BASE}`]);
    });

    it('pulls a missing base', async () => {
        const { run, seen } = engine({ 'podman image exists': { code: 1 } });
        await ensureSandboxBases('podman', run, project(`FROM ${BASE}\n`).dockerfile);
        expect(seen).toEqual([`podman image exists ${BASE}`, `podman pull ${BASE}`]);
    });

    it('builds the base here, under its own name, when it cannot be pulled', async () => {
        const { run, seen } = engine({
            'podman image exists': { code: 1 },
            'podman pull': { code: 125, stderr: 'unauthorized' },
        });
        const said: string[] = [];
        await ensureSandboxBases('podman', run, project(`FROM ${BASE}\n`).dockerfile, {
            onProgress: (line) => said.push(line),
        });
        const build = seen[2]!;
        expect(build).toMatch(
            new RegExp(
                `^podman build --tag ${BASE} --build-arg ZEN_VERSION=1\\.2\\.5 --file \\S+Dockerfile \\S+$`,
            ),
        );
        expect(said.join('\n')).toContain('building it here instead');
    });

    it('runs before the project build, which then finds the base', async () => {
        const { run, seen } = engine({
            [`podman image exists ${BASE}`]: { code: 1 },
            'podman image exists localhost': { code: 1 },
        });
        const p = project(`FROM ${BASE}\nRUN pip install x\n`);
        await ensurePodmanImage({ image: 'localhost/zenera-sandbox:abc', build: p }, { exec: run });
        expect(seen.slice(0, 3)).toEqual([
            'podman image exists localhost/zenera-sandbox:abc',
            `podman image exists ${BASE}`,
            `podman pull ${BASE}`,
        ]);
        expect(seen[3]).toMatch(/^podman build --tag localhost\/zenera-sandbox:abc /);
    });

    it('installs this zen into the base, declared after the slow layers', () => {
        const dockerfile = sandboxBaseDockerfile();
        expect(dockerfile).toContain(
            'npm install -g "@zenera/cli@$ZEN_VERSION" "@zenera/rag@$ZEN_VERSION"',
        );
        // An ARG busts the cache of every RUN after it: only the zen install may follow it.
        const arg = dockerfile.indexOf('ARG ZEN_VERSION');
        expect(dockerfile.indexOf('@lancedb/lancedb')).toBeLessThan(arg);
        // HTTP clients for agents' scripts, cached with the slow layers, require()-able in Node.
        expect(dockerfile.indexOf('pip install --no-cache-dir "requests')).toBeLessThan(arg);
        expect(dockerfile.indexOf('npm install -g "axios@')).toBeLessThan(arg);
        expect(dockerfile).toContain('ENV NODE_PATH=/usr/local/lib/node_modules');
        expect(dockerfile).toContain('LABEL zenera.sandbox-base=1 zenera.version=$ZEN_VERSION');
    });

    it('sandbox-base.Dockerfile is sandboxBaseDockerfile() (npm run sandbox-base:dockerfile)', () => {
        const file = fileURLToPath(new URL('../sandbox-base.Dockerfile', import.meta.url));
        expect(readFileSync(file, 'utf8')).toBe(sandboxBaseDockerfile());
    });
});
