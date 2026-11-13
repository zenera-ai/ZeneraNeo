import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    chmodSync,
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const templates = resolve(import.meta.dirname, '../templates');
const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project() {
    const root = mkdtempSync(join(tmpdir(), 'zen-template-scripts-'));
    roots.push(root);
    cpSync(join(templates, 'editor/.github'), join(root, '.github'), { recursive: true });
    mkdirSync(join(root, 'agents'), { recursive: true });
    writeFileSync(join(root, 'agents.yaml'), 'model: example:old\n');
    writeFileSync(join(root, 'SPECIFICATION.md'), '# Example\n');
    const bin = join(root, '.tmp/bin');
    mkdirSync(bin, { recursive: true });
    const zen = join(bin, 'zen');
    writeFileSync(
        zen,
        `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] === '--version') {
    console.log(process.env.TEST_ZEN_VERSION || '1.0.0');
} else {
    fs.appendFileSync('.tmp/calls', process.argv.slice(2).join(' ') + '\\n');
    if (process.env.TEST_REPAIR) fs.writeFileSync('agents.yaml', 'model: example:repaired\\n');
    process.exitCode = Number(process.env.TEST_CHECK_EXIT || 0);
}
`,
    );
    chmodSync(zen, 0o755);
    const run = (skill: string, script: string, args: string[], env = {}) =>
        spawnSync('bash', [join(root, '.github/skills', skill, 'scripts', script), ...args], {
            cwd: tmpdir(),
            encoding: 'utf8',
            env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env },
        });
    return {
        root,
        snapshot: (...args: string[]) => run('zen-spec-sync', 'snapshot.sh', args),
        review: (args: string[], env = {}) => run('zen-review', 'review.sh', args, env),
    };
}

describe('spec-sync snapshot helpers', () => {
    it('separates generated maintenance without losing its diff or integrity checks', () => {
        const { root, snapshot } = project();
        const shared = 'agents/memory-instructions.md';
        writeFileSync(join(root, shared), 'old rules\n');
        expect(snapshot('status').stdout).toContain('mode: full');
        mkdirSync(join(root, '.spec-sync/history'), { recursive: true });
        writeFileSync(join(root, '.spec-sync/history/2026-01-01T000000Z.md'), '# pass\n');
        expect(snapshot('commit').status).toBe(0);

        writeFileSync(join(root, shared), 'new rules\n');
        writeFileSync(join(root, 'agents/instructions.md'), 'project policy\n');
        const status = snapshot('status');
        expect(status.status).toBe(0);
        expect(status.stdout).toContain(`maintenance: ${shared}`);
        expect(status.stdout).not.toContain(`changed: ${shared}`);
        expect(status.stdout).toContain('changed: agents/instructions.md');
        expect(snapshot('diff').stdout).toContain('+new rules');

        rmSync(join(root, shared));
        expect(snapshot('status').stdout).toContain(`maintenance: ${shared}`);
        writeFileSync(join(root, '.spec-sync/baseline', shared), 'tampered\n');
        expect(snapshot('status').stdout).toContain('mode: tampered');
    });

    it('records explicit sections and hashes without advancing the baseline', () => {
        const { root, snapshot } = project();
        const result = snapshot(
            'record',
            '--mode',
            'incremental',
            '--scope',
            'model-reference-only',
            '--changed',
            'agents.yaml: model reference',
            '--changed',
            'SPECIFICATION.md: requirement',
            '--feedback',
            'None',
            '--still-open',
            'Q1 remains unresolved',
            '--checks',
            'models and setup pass',
        );
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain('baseline: unchanged');
        expect(existsSync(join(root, '.spec-sync/baseline/manifest.txt'))).toBe(false);
        const entries = readdirSync(join(root, '.spec-sync/history'));
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{6}Z\.md$/);
        const entry = readFileSync(join(root, '.spec-sync/history', entries[0]!), 'utf8');
        const sha = createHash('sha256')
            .update(readFileSync(join(root, 'SPECIFICATION.md')))
            .digest('hex');
        expect(entry).toContain(`**Spec sha** - ${sha}`);
        expect(entry).toContain('- agents.yaml: model reference\n- SPECIFICATION.md: requirement');
        expect(entry).toContain('## Still open\n\n- Q1 remains unresolved');
        expect(snapshot('commit').status).toBe(0);
        expect(snapshot('commit').status).toBe(1);
    });

    it('never overwrites a history entry or leaves a draft on timestamp collision', () => {
        const { root, snapshot } = project();
        const date = join(root, '.tmp/bin/date');
        writeFileSync(date, '#!/bin/sh\nprintf "2026-01-01T000000Z\\n"\n');
        chmodSync(date, 0o755);
        const args = [
            'record',
            '--mode',
            'full',
            '--scope',
            'None',
            '--changed',
            'None',
            '--feedback',
            'None',
            '--still-open',
            'None',
            '--checks',
            'pass',
        ];
        expect(snapshot(...args).status).toBe(0);
        const entry = join(root, '.spec-sync/history/2026-01-01T000000Z.md');
        const content = readFileSync(entry, 'utf8');
        expect(snapshot(...args).status).toBe(1);
        expect(readFileSync(entry, 'utf8')).toBe(content);
        expect(readdirSync(join(root, '.spec-sync/history'))).toEqual(['2026-01-01T000000Z.md']);
    });

    it('rejects missing sections, invalid modes and missing specifications', () => {
        const { root, snapshot } = project();
        expect(snapshot('record', '--mode', 'full').status).toBe(2);
        expect(snapshot('record', '--mode', 'fast').status).toBe(2);
        expect(snapshot('record', '--unknown', 'value').status).toBe(2);
        expect(snapshot('record', '--scope').status).toBe(2);
        expect(readdirSync(join(root, '.spec-sync/history'))).toEqual([]);
        rmSync(join(root, 'SPECIFICATION.md'));
        const result = snapshot(
            'record',
            '--mode',
            'full',
            '--scope',
            'None',
            '--changed',
            'None',
            '--feedback',
            'None',
            '--still-open',
            'None',
            '--checks',
            'pass',
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('SPECIFICATION.md is missing');
    });
});

describe('review check receipts', () => {
    it('reuses one successful model probe while still sweeping paths', () => {
        const { root, review } = project();
        expect(review(['check', 'no-sandbox']).status).toBe(0);
        const result = review(['--skip-check', 'no-sandbox']);
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain('reusing successful no-sandbox check');
        expect(result.stdout).toContain('--- paths (check-paths.sh) ---');
        expect(result.stdout).not.toContain('spec-sync');
        expect(readFileSync(join(root, '.tmp/calls'), 'utf8')).toBe('check --no-sandbox\n');
        expect(review(['--skip-check']).status).toBe(1);
        expect(review(['--skip-check', 'fast']).status).toBe(0);

        writeFileSync(join(root, 'agents/instructions.md'), 'Read /tmp/wrong.txt\n');
        expect(review(['check', 'no-sandbox']).status).toBe(0);
        expect(review(['--skip-check', 'no-sandbox']).status).toBe(1);
    });

    it('rejects stale inputs, added and deleted files, and a different CLI version', () => {
        const { root, review } = project();
        expect(review(['--skip-check']).status).toBe(1);
        expect(review(['check', 'full', '--fix']).status).toBe(0);
        expect(review(['--skip-check']).status).toBe(0);
        expect(review(['--skip-check'], { TEST_ZEN_VERSION: '2.0.0' }).status).toBe(1);
        writeFileSync(join(root, 'SPECIFICATION.md'), '# Changed\n');
        expect(review(['--skip-check']).status).toBe(1);
        expect(review(['check']).status).toBe(0);
        writeFileSync(join(root, 'new file.txt'), 'new\n');
        expect(review(['--skip-check']).status).toBe(1);
        expect(review(['check']).status).toBe(0);
        rmSync(join(root, 'new file.txt'));
        expect(review(['--skip-check']).status).toBe(1);
        expect(review(['check']).status).toBe(0);
        chmodSync(join(root, 'agents.yaml'), 0o600);
        expect(review(['--skip-check']).status).toBe(1);
    });

    it('does not invalidate a check when history or scratch output is written', () => {
        const { root, review } = project();
        expect(review(['check']).status).toBe(0);
        mkdirSync(join(root, '.spec-sync/history'), { recursive: true });
        writeFileSync(join(root, '.spec-sync/history/pass.md'), '# pass\n');
        writeFileSync(join(root, '.tmp/log'), 'progress\n');
        expect(review(['--skip-check']).status).toBe(0);
    });

    it('invalidates an older success when the next check fails', () => {
        const { review } = project();
        expect(review(['check']).status).toBe(0);
        expect(review(['check'], { TEST_CHECK_EXIT: '3' }).status).toBe(3);
        expect(review(['--skip-check']).status).toBe(1);
    });

    it('requires a full check after partial repairs and rejects insufficient probe coverage', () => {
        const { review } = project();
        const partial = review(['check', 'no-sandbox', '--fix'], { TEST_REPAIR: '1' });
        expect(partial.status).toBe(1);
        expect(partial.stderr).toContain('run check full');
        expect(review(['--skip-check', 'no-sandbox']).status).toBe(1);
        expect(review(['check', 'full', '--fix'], { TEST_REPAIR: '1' }).status).toBe(0);
        expect(review(['--skip-check']).status).toBe(0);
        expect(review(['check', 'fast']).status).toBe(0);
        expect(review(['--skip-check', 'no-sandbox']).status).toBe(1);
        expect(review(['--skip-check', 'fast']).status).toBe(0);
    });

    it('rejects malformed receipts, unsupported symlinks and invalid arguments explicitly', () => {
        const { root, review } = project();
        writeFileSync(join(root, '.tmp/review-check.json'), '{broken');
        expect(review(['--skip-check']).status).toBe(1);
        expect(review(['check', 'unknown']).status).toBe(1);
        expect(review(['check', 'full', '--unknown']).status).toBe(1);
        expect(review(['--skip-check', 'full', '--fix']).status).toBe(2);
        symlinkSync(join(root, 'agents.yaml'), join(root, 'linked.yaml'));
        const result = review(['check']);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('symlink or special file');
    });

    it('preserves ordinary full and fast review modes', () => {
        const { root, review } = project();
        expect(review([]).status).toBe(0);
        expect(review(['fast']).status).toBe(0);
        expect(readFileSync(join(root, '.tmp/calls'), 'utf8')).toBe(
            'check\ncheck --no-models --no-sandbox\n',
        );
    });

    it('runs the slow half as one full check, warns, and leaves a reusable receipt', () => {
        const { root, review } = project();
        const slow = review(['slow', '--fix']);
        expect(slow.status, slow.stderr).toBe(0);
        expect(slow.stderr).toContain('several minutes');
        expect(slow.stdout).not.toContain('--- paths (check-paths.sh) ---');
        expect(readFileSync(join(root, '.tmp/calls'), 'utf8')).toBe('check --fix\n');
        expect(review(['--skip-check']).status).toBe(0);
        expect(review(['slow', 'fast']).status).toBe(2);
    });

    it('names the exact fast check and suggests the setup run when setup is not done', () => {
        const { root, review } = project();
        mkdirSync(join(root, 'scripts'));
        writeFileSync(join(root, 'scripts/_setup.sh'), 'echo "docs_index: needs setup"\nexit 1\n');
        const result = review(['fast']);
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('--- zen check --no-models --no-sandbox ---');
        expect(result.stdout).toContain('docs_index: needs setup');
        expect(result.stdout).toContain('setup: not done - run scripts/_setup.sh');
    });

    it('hints at a sandbox rebuild when sandbox/ changed since the last commit, without failing', () => {
        const { root, review } = project();
        const git = (...args: string[]) =>
            spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root });
        mkdirSync(join(root, 'sandbox'));
        writeFileSync(join(root, 'sandbox/Dockerfile'), 'FROM scratch\n');
        git('init', '-q');
        git('add', 'sandbox');
        git('commit', '-qm', 'init');
        expect(review(['fast']).stdout).toContain('sandbox: unchanged');

        writeFileSync(join(root, 'sandbox/Dockerfile'), 'FROM alpine\n');
        const changed = review(['fast']);
        expect(changed.status).toBe(0);
        expect(changed.stdout).toContain('zen sandbox pull');
    });
});

it('accepts one dry run as the complete proof for an empty setup runner', () => {
    const { root } = project();
    mkdirSync(join(root, 'scripts'));
    cpSync(join(templates, 'project/scripts/_setup.sh'), join(root, 'scripts/_setup.sh'));
    const result = spawnSync('bash', [join(root, 'scripts/_setup.sh'), '--check'], {
        cwd: tmpdir(),
        encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('nothing to set up');
    expect(existsSync(join(root, '.tmp/logs'))).toBe(false);
});
