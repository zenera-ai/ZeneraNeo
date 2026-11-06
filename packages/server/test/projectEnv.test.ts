import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll as after, afterEach, test } from 'vitest';

const projectDir = mkdtempSync(join(tmpdir(), 'zen-project-env-'));
const { configure, DEFAULTS } = await import('../src/config.ts');
configure({ ...DEFAULTS, projectId: 'p', auth: { mode: 'token', token: 't' }, projectDir });
// Set before the module loads, so it counts as the pod's own.
process.env.ZEN_POD_ONLY = 'pod';
const { applyProjectEnv, withoutProjectEnv } = await import('../src/projectEnv.ts');

const write = (name: string, text: string) => writeFileSync(join(projectDir, name), text);

afterEach(() => {
    delete process.env.ZEN_ENV_FILE;
    write('.env', '');
    applyProjectEnv();
});
after(() => {
    rmSync(projectDir, { recursive: true, force: true });
    delete process.env.ZEN_POD_ONLY;
});

test('an edit reaches the next turn: changed values replace, removed names go', () => {
    write('.env', 'ZEN_A=one\nZEN_B=one\n');
    applyProjectEnv();
    assert.equal(process.env.ZEN_A, 'one');
    assert.equal(process.env.ZEN_B, 'one');

    write('.env', 'ZEN_A=two\nZEN_C=new\n');
    applyProjectEnv();
    assert.equal(process.env.ZEN_A, 'two');
    assert.equal(process.env.ZEN_B, undefined);
    assert.equal(process.env.ZEN_C, 'new');
});

test('ZEN_ENV_FILE=.env.test reads that file instead of .env', () => {
    write('.env', 'ZEN_A=real\nZEN_B=real\n');
    write('.env.test', 'ZEN_A=test\n');
    process.env.ZEN_ENV_FILE = '.env.test';
    applyProjectEnv();
    assert.equal(process.env.ZEN_A, 'test');
    assert.equal(process.env.ZEN_B, undefined);
});

test("a project file cannot override the pod's own variables", () => {
    write('.env', 'ZEN_POD_ONLY=project\n');
    applyProjectEnv();
    assert.equal(process.env.ZEN_POD_ONLY, 'pod');
    write('.env', '');
    applyProjectEnv();
    assert.equal(process.env.ZEN_POD_ONLY, 'pod');
});

test('a zen subprocess gets none of it, and no ZEN_ENV_FILE', () => {
    write('.env.test', 'ZEN_A=test\n');
    process.env.ZEN_ENV_FILE = '.env.test';
    applyProjectEnv();
    const env = withoutProjectEnv(process.env);
    assert.equal(env.ZEN_A, undefined);
    assert.equal(env.ZEN_ENV_FILE, undefined);
    assert.equal(env.ZEN_POD_ONLY, 'pod');
});
