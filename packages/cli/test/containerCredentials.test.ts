/**
 * Vitest coverage for staging container credential files into the server's private home.
 * Exercises exact file copies, private permissions, rewritten environment paths and
 * failure cleanup without using live credentials, cloud APIs or a container engine.
 */
import { home } from '@zenera/engine';
import {
    chmodSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { stageContainerCredentials } from '../src/containerCredentials.ts';

let root: string;
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'zen-runtime-credentials-'));
    vi.stubEnv('ZENERA_HOME', join(root, 'zen-home'));
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', undefined);
});
afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
});

it('copies credentials into an ephemeral private directory without changing the source', async () => {
    const source = join(root, 'secret.json');
    const contents = '{"type":"service_account","project_id":"test-project"}';
    writeFileSync(source, contents, { mode: 0o400 });
    chmodSync(source, 0o400);
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', source);
    await stageContainerCredentials();
    const staged = process.env.GOOGLE_APPLICATION_CREDENTIALS!;
    expect(staged).not.toBe(source);
    expect(staged.startsWith(home())).toBe(true);
    expect(readFileSync(staged, 'utf8')).toBe(contents);
    expect(statSync(staged).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(staged)).mode & 0o777).toBe(0o700);
    expect(statSync(source).mode & 0o777).toBe(0o400);
    expect(readFileSync(source, 'utf8')).toBe(contents);
});

it('does not create credential directories when there are no file credentials', async () => {
    await stageContainerCredentials();
    expect(readdirSync(root)).toEqual([]);
});

it('reports unreadable files and removes incomplete staged credentials', async () => {
    const source = join(root, 'missing.json');
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', source);
    await expect(stageContainerCredentials()).rejects.toThrow(
        'cannot stage runtime credential files',
    );
    expect(process.env.GOOGLE_APPLICATION_CREDENTIALS).toBe(source);
    expect(readdirSync(home())).toEqual([]);
});
