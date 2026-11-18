import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
    ensurePodmanImage,
    ensureSandboxBases,
    SAME_PYTHON_CHECK,
    SANDBOX_BASE_IMAGES,
    SANDBOX_BASE_REPO,
    SANDBOX_BASE_SNAPSHOT,
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
            'npm install -g --before="$published" "@zenera/cli@$ZEN_VERSION" "@zenera/rag@$ZEN_VERSION"',
        );
        // An ARG busts the cache of every RUN after it: only the zen install may follow it.
        const arg = dockerfile.indexOf('ARG ZEN_VERSION');
        expect(dockerfile.indexOf('@lancedb/lancedb')).toBeLessThan(arg);
        // Tools and libraries for agents' scripts, cached with the slow layers, require()-able in Node.
        expect(dockerfile.indexOf('apt-get install -y --no-install-recommends')).toBeLessThan(arg);
        for (const tool of ['ca-certificates', 'curl', 'jq', 'ripgrep', 'unzip']) {
            expect(dockerfile).toMatch(new RegExp(`--no-install-recommends .*\\b${tool}\\b`));
        }
        for (const lib of [
            'requests',
            'jsonschema',
            'pyyaml',
            'python-dateutil',
            'beautifulsoup4',
        ]) {
            expect(dockerfile.indexOf(`"${lib}>=`)).toBeGreaterThan(-1);
            expect(dockerfile.indexOf(`"${lib}>=`)).toBeLessThan(arg);
        }
        expect(dockerfile).toContain(`&& ${SAME_PYTHON_CHECK} \\`);
        expect(dockerfile).toContain(
            'python -c "import bs4, dateutil, jsonschema, requests, yaml"',
        );
        // indexOf is -1 when it is missing, which is also less than arg: check both.
        expect(dockerfile.indexOf('"axios@^1"')).toBeGreaterThan(-1);
        expect(dockerfile.indexOf('"axios@^1"')).toBeLessThan(arg);
        expect(dockerfile).toContain('ENV NODE_PATH=/usr/local/lib/node_modules');
        expect(dockerfile).toContain('LABEL zenera.sandbox-base=1 zenera.version=$ZEN_VERSION');
    });

    it('sandbox-base.Dockerfile is sandboxBaseDockerfile() (npm run sandbox-base:dockerfile)', () => {
        const file = fileURLToPath(new URL('../sandbox-base.Dockerfile', import.meta.url));
        expect(readFileSync(file, 'utf8')).toBe(sandboxBaseDockerfile());
    });
});

describe('sandbox base, pinned', () => {
    const dockerfile = sandboxBaseDockerfile();
    /** Every shell command the RUN lines chain, continuation lines joined. */
    const commands = dockerfile
        .replace(/\s*\\\n\s*/g, ' ')
        .split('\n')
        .filter((line) => line.startsWith('RUN '))
        .flatMap((line) => line.slice(4).split(' && '))
        .map((command) => command.trim());

    it('starts FROM its bases by digest, not by a tag that moves', () => {
        const froms = dockerfile.split('\n').filter((line) => line.startsWith('FROM '));
        expect(froms).toHaveLength(2);
        for (const from of froms) {
            expect(from).toMatch(/^FROM \S+:\S+@sha256:[0-9a-f]{64}( AS \w+)?$/);
        }
        expect(froms[0]).toContain(SANDBOX_BASE_IMAGES.node);
        expect(froms[1]).toBe(`FROM ${SANDBOX_BASE_IMAGES.python}`);
    });

    it('resolves every install as of one moment, the transitive dependencies too', () => {
        const installs = commands.filter((c) =>
            /\b(npm install|pip install|apt-get (update|install))\b/.test(c),
        );
        // apt-get update and install, pip, axios, the third-party npm layer, zen.
        expect(installs).toHaveLength(6);
        const at = SANDBOX_BASE_SNAPSHOT;
        for (const command of installs) {
            if (command.startsWith('npm install')) {
                expect(command).toMatch(new RegExp(`--before=(${at}|"\\$published") `));
            } else if (command.startsWith('pip install')) {
                expect(command).toContain(`--uploaded-prior-to=${at} `);
            } else {
                expect(command).toMatch(/ \$snapshot( |$)/);
            }
        }
    });

    it('reads Debian from the snapshot without leaving the snapshot in the image', () => {
        const stamp = SANDBOX_BASE_SNAPSHOT.replace(/[-:]/g, '');
        expect(stamp).toMatch(/^\d{8}T\d{6}Z$/);
        for (const [archive, suite] of [
            ['debian', 'bookworm'],
            ['debian', 'bookworm-updates'],
            ['debian-security', 'bookworm-security'],
        ]) {
            expect(dockerfile).toContain(`${archive}/${stamp} ${suite} \\`);
        }
        expect(dockerfile).toContain('http://snapshot.debian.org/archive/%s %s main');
        // A project's own apt-get, FROM this base, must still reach deb.debian.org.
        expect(dockerfile).not.toMatch(/\/etc\/apt\/sources/);
        expect(commands).toContain('rm -rf /var/lib/apt/lists/* /tmp/snapshot.list');
    });

    describe('installs zen as of the moment its version was complete on npm', () => {
        // The command as the shell receives it: the Dockerfile joins `\` continuation lines.
        const joined = dockerfile.replace(/\s*\\\n\s*/g, ' ');
        const published = /published="\$\((.+?)\)" &&/.exec(joined)?.[1];
        const dir = realpathSync(mkdtempSync(join(tmpdir(), 'zen-npm-')));
        afterAll(() => rmSync(dir, { recursive: true, force: true }));

        type Registry = Record<string, { time?: string; deps?: string[] }>;

        /**
         * Runs the Dockerfile's own command against an npm that answers `npm view <pkg>@<v>
         * dependencies` and `npm view <pkg> time` from a table, and 404s anything else.
         */
        function publishedAt(registry: Registry, v: string) {
            for (const [pkg, { time, deps }] of Object.entries(registry)) {
                const file = (spec: string) => join(dir, spec.replaceAll('/', '+'));
                writeFileSync(file(`${pkg}.time`), JSON.stringify(time ? { [v]: time } : {}));
                writeFileSync(
                    file(`${pkg}@${v}.dependencies`),
                    deps ? JSON.stringify(Object.fromEntries(deps.map((d) => [d, `^${v}`]))) : '',
                );
            }
            writeFileSync(
                join(dir, 'npm'),
                '#!/bin/sh\n' +
                    `f="${dir}/$(printf %s "$2.$3" | tr / +)"\n` +
                    '[ -f "$f" ] || { echo "npm error 404 $2" >&2; exit 1; }\ncat "$f"\n',
                { mode: 0o755 },
            );
            return spawnSync('sh', ['-c', `published="$(${published})" && echo "$published"`], {
                encoding: 'utf8',
                env: { ...process.env, PATH: `${dir}:${process.env['PATH']}`, ZEN_VERSION: v },
            });
        }

        it('takes the latest publish of every @zenera package it pulls in, in any order', () => {
            expect(published).toBeDefined();
            // 1.3.13 as published: @zenera/sandbox and @zenera/server a minute after the CLI.
            // Here sandbox is only reachable through server, a dependency of a dependency.
            const out = publishedAt(
                {
                    '@zenera/rag': { time: '2026-11-18T20:44:11.145Z', deps: ['@zenera/neo'] },
                    '@zenera/neo': { time: '2026-11-18T20:44:13.205Z' },
                    '@zenera/cli': {
                        time: '2026-11-18T20:45:23.993Z',
                        deps: ['@zenera/neo', '@zenera/server', 'ink'],
                    },
                    '@zenera/server': {
                        time: '2026-11-18T20:46:07.087Z',
                        deps: ['@zenera/sandbox'],
                    },
                    '@zenera/sandbox': { time: '2026-11-18T20:46:31.961Z' },
                },
                '1.3.13',
            );
            expect(out.stderr).toBe('');
            expect(out.stdout.trim()).toBe('2026-11-18T20:46:31.961Z');
        });

        it('fails the build when a package of that version is not on npm', () => {
            const out = publishedAt(
                {
                    '@zenera/cli': { time: '2026-11-10T17:44:13.168Z', deps: ['@zenera/neo'] },
                    '@zenera/neo': {},
                    '@zenera/rag': { time: '2026-11-10T17:41:25.626Z' },
                },
                '1.2.8',
            );
            expect(out.status).not.toBe(0);
            expect(out.stderr).toContain('not on npm: 1.2.8');
        });
    });

    it('labels the image with what it was pinned to', () => {
        expect(dockerfile).toContain(`zenera.snapshot=${SANDBOX_BASE_SNAPSHOT}`);
        expect(dockerfile).toContain(
            `org.opencontainers.image.base.digest=${SANDBOX_BASE_IMAGES.python.split('@')[1]}`,
        );
    });
});
