import { execFileSync, spawnSync } from 'node:child_process';
import {
    chmodSync,
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const releaseScript = resolve(import.meta.dirname, '../../../scripts/release.mjs');
const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository() {
    const root = mkdtempSync(join(tmpdir(), 'zen-workspace-release-'));
    roots.push(root);
    const write = (path: string, contents: string) => {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), contents);
    };
    const read = (path: string) => readFileSync(join(root, path), 'utf8');
    const manifest = (name: string) => JSON.parse(read(`packages/${name}/package.json`));
    const update = (name: string, fields: Record<string, unknown>) =>
        write(
            `packages/${name}/package.json`,
            JSON.stringify({ ...manifest(name), ...fields }) + '\n',
        );

    write('.gitignore', '.tmp/\n');
    write('.tmp/gitconfig', '');
    write('packages/core/package.json', '{"name":"@example/core","version":"1.2.3"}\n');
    write(
        'packages/cli/package.json',
        JSON.stringify({
            name: '@example/cli',
            version: '1.2.3',
            dependencies: { '@example/core': '^1.2.3', external: '^4.0.0' },
        }) + '\n',
    );
    write('packages/private/package.json', '{"name":"private","version":"0.0.0","private":true}\n');
    write('package-lock.json', '{"lockfileVersion":3,"packages":{}}\n');
    mkdirSync(join(root, 'scripts'));
    copyFileSync(releaseScript, join(root, 'scripts/release.mjs'));

    // Record lockfile updates without allowing the fixture to use the registry.
    write(
        '.tmp/bin/npm',
        `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync('.tmp/npm-calls', JSON.stringify(args) + '\\n');
if (JSON.stringify(args) !== JSON.stringify(['install', '--package-lock-only', '--silent'])) {
    process.exit(1);
}
const { version } = JSON.parse(fs.readFileSync('packages/core/package.json', 'utf8'));
fs.writeFileSync('package-lock.json', JSON.stringify({ fixtureVersion: version }) + '\\n');
`,
    );
    chmodSync(join(root, '.tmp/bin/npm'), 0o755);
    const env = {
        ...Object.fromEntries(
            Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
        ),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: join(root, '.tmp/gitconfig'),
        PATH: `${join(root, '.tmp/bin')}${delimiter}${process.env.PATH}`,
    };
    const git = (...args: string[]) =>
        execFileSync('git', args, { cwd: root, env, encoding: 'utf8' }).trim();
    git('init', '--quiet');
    git('config', 'user.name', 'Release Test');
    git('config', 'user.email', 'release@example.invalid');
    git('add', '.');
    git('commit', '--quiet', '-m', 'Initial packages');

    const snapshot = () => {
        const files: Record<string, { contents: string; mtime: string }> = {};
        const visit = (dir: string) => {
            for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
                if (entry.name === '.git' || entry.name === '.tmp') continue;
                const path = join(dir, entry.name);
                if (entry.isDirectory()) visit(path);
                else {
                    files[path] = {
                        contents: read(path),
                        mtime: statSync(join(root, path), { bigint: true }).mtimeNs.toString(),
                    };
                }
            }
        };
        visit('');
        return {
            files,
            staged: git('diff', '--cached', '--binary'),
            unstaged: git('diff', '--binary'),
            status: git('status', '--porcelain'),
            head: git('rev-parse', 'HEAD'),
            tags: git('show-ref', '--head', '--tags'),
        };
    };
    return {
        git,
        write,
        read,
        manifest,
        update,
        snapshot,
        npmCalls: () => (existsSync(join(root, '.tmp/npm-calls')) ? read('.tmp/npm-calls') : ''),
        run: (...args: string[]) =>
            spawnSync(process.execPath, [join(root, 'scripts/release.mjs'), ...args], {
                cwd: root,
                env,
                encoding: 'utf8',
            }),
    };
}

describe('workspace release dry runs', () => {
    it.each([
        ['patch', '1.2.4'],
        ['minor', '1.3.0'],
        ['major', '2.0.0'],
        ['2.0.0-rc.1', '2.0.0-rc.1'],
    ])('previews %s without rewriting a clean checkout', (spec, version) => {
        const repo = repository();
        const before = repo.snapshot();
        const result = repo.run(spec, '--dry-run');

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain(`release: @example/core 1.2.3 -> ${version}`);
        expect(result.stdout).toContain(`release: @example/cli 1.2.3 -> ${version}`);
        expect(result.stdout).not.toContain('release: private');
        expect(repo.snapshot()).toEqual(before);
        expect(repo.npmCalls()).toBe('');
    });

    it.each(['unstaged', 'staged', 'staged and unstaged'])(
        'preserves %s manifest edits',
        (state) => {
            const repo = repository();
            repo.update('core', { description: 'Local description' });
            if (state !== 'unstaged') repo.git('add', 'packages/core/package.json');
            if (state === 'staged and unstaged') {
                repo.update('core', { description: 'Further local edits' });
            }
            const before = repo.snapshot();
            const result = repo.run('patch', '--dry-run');

            expect(result.status, result.stderr).toBe(0);
            expect(repo.snapshot()).toEqual(before);
            expect(repo.npmCalls()).toBe('');
        },
    );

    it('leaves private packages and unrelated untracked files alone', () => {
        const repo = repository();
        repo.update('private', { description: 'Local private package edit' });
        repo.write('notes.txt', 'Untracked release notes\n');
        const before = repo.snapshot();
        const result = repo.run('patch', '--dry-run');

        expect(result.status, result.stderr).toBe(0);
        expect(repo.snapshot()).toEqual(before);
        expect(repo.npmCalls()).toBe('');
    });

    it.each(['invalid version', 'unchanged version', 'version mismatch', 'existing tag'])(
        'rejects %s without changes',
        (failure) => {
            const repo = repository();
            let spec = 'patch';
            let message = '';
            if (failure === 'invalid version') {
                spec = 'not-a-version';
                message = 'unknown version';
            } else if (failure === 'unchanged version') {
                spec = '1.2.3';
                message = 'already at 1.2.3';
            } else if (failure === 'version mismatch') {
                repo.update('core', { version: '1.2.2' });
                message = 'out of lockstep';
            } else {
                repo.git('tag', 'v1.2.4');
                message = 'tag v1.2.4 already exists';
            }
            const before = repo.snapshot();
            const result = repo.run(spec, '--dry-run');

            expect(result.status).toBe(1);
            expect(result.stderr).toContain(message);
            expect(repo.snapshot()).toEqual(before);
            expect(repo.npmCalls()).toBe('');
        },
    );
});

describe('workspace releases', () => {
    it.each([true, false])('commits package and lockfile updates (tag: %s)', (tag) => {
        const repo = repository();
        const head = repo.git('rev-parse', 'HEAD');
        const privatePackage = repo.read('packages/private/package.json');
        const result = repo.run('patch', ...(tag ? [] : ['--no-tag']));

        expect(result.status, result.stderr).toBe(0);
        expect(repo.manifest('core').version).toBe('1.2.4');
        expect(repo.manifest('cli')).toMatchObject({
            version: '1.2.4',
            dependencies: { '@example/core': '^1.2.4', external: '^4.0.0' },
        });
        expect(repo.read('packages/private/package.json')).toBe(privatePackage);
        expect(repo.npmCalls()).toBe('["install","--package-lock-only","--silent"]\n');
        expect(JSON.parse(repo.read('package-lock.json')).fixtureVersion).toBe('1.2.4');
        expect(repo.git('status', '--porcelain')).toBe('');
        expect(repo.git('rev-parse', 'HEAD')).not.toBe(head);
        expect(repo.git('log', '-1', '--format=%s')).toBe('release: v1.2.4');
        expect(
            repo.git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').split('\n'),
        ).toEqual(['package-lock.json', 'packages/cli/package.json', 'packages/core/package.json']);
        expect(repo.git('tag', '--list')).toBe(tag ? 'v1.2.4' : '');
        if (tag) {
            expect(repo.git('cat-file', '-t', 'v1.2.4')).toBe('tag');
            expect(repo.git('rev-parse', 'v1.2.4^{}')).toBe(repo.git('rev-parse', 'HEAD'));
        }
        expect(repo.run('verify', 'v1.2.4').status).toBe(0);
    });

    it('still refuses to release a dirty checkout', () => {
        const repo = repository();
        repo.update('core', { description: 'Local description' });
        const before = repo.snapshot();
        const result = repo.run('patch');

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('the working tree is dirty');
        expect(repo.snapshot()).toEqual(before);
        expect(repo.npmCalls()).toBe('');
    });
});
