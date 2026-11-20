import { envNames, KeyStore, paths, PROVIDERS } from '@zenera/cli/lib';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GYM_KIND } from '../src/cache.ts';
import { chooseEmbedding, chooseModel, readSettings, writeSettings } from '../src/setup.ts';

describe('Gym setup', () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'gym-setup-'));
        vi.stubEnv('ZENERA_HOME', root);
        vi.stubEnv('ZENERA_GYM_MODEL', undefined);
        // The default model and embedding follow any provider with a key, one in
        // the developer's shell or `.env` included. Start every test with none.
        for (const provider of PROVIDERS) {
            for (const name of envNames(provider)) {
                vi.stubEnv(name, undefined);
            }
        }
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        rmSync(root, { recursive: true, force: true });
    });

    it('uses Gym workspace and cache names', () => {
        expect(paths.gym()).toBe(join(root, 'gym'));
        expect(GYM_KIND).toBe('gym-handler');
    });

    it('reads and writes Gym settings, including a cleared model', async () => {
        expect(await readSettings()).toEqual({ version: 1 });
        writeSettings({ version: 1, model: 'openai:stored' });
        expect(await readSettings()).toEqual({ version: 1, model: 'openai:stored' });
        expect(existsSync(join(root, 'gym.json'))).toBe(true);
        writeSettings({ version: 1 });
        expect(await readSettings()).toEqual({ version: 1 });
    });

    it('reports malformed settings', async () => {
        writeFileSync(join(root, 'gym.json'), '{');
        await expect(readSettings()).rejects.toThrow('is not valid JSON');
    });

    it('keeps flag, environment, settings and default precedence', async () => {
        const keys = await KeyStore.open();
        keys.add('openai', 'default', 'sk-test');
        writeSettings({ version: 1, model: 'openai:stored' });
        vi.stubEnv('ZENERA_GYM_MODEL', 'openai:env');
        expect(await chooseModel(undefined, keys)).toEqual({ ref: 'openai:env', from: 'env' });
        expect(await chooseModel('openai:flag', keys)).toEqual({
            ref: 'openai:flag',
            from: 'flag',
        });
        vi.stubEnv('ZENERA_GYM_MODEL', '');
        expect(await chooseModel(undefined, keys)).toEqual({ ref: 'openai:stored', from: 'store' });
        writeSettings({ version: 1 });
        expect(await chooseModel(undefined, keys)).toMatchObject({ from: 'default' });
    });

    it('embeds the docs only when --embedding asks', async () => {
        const keys = await KeyStore.open();
        vi.stubEnv('ZENERA_GYM_EMBEDDING', undefined);
        await expect(chooseEmbedding('on', keys)).rejects.toThrow('no embedding model');

        keys.add('openai', 'default', 'sk-test');
        vi.stubEnv('OPENAI_API_KEY', 'sk-test');
        writeSettings({ version: 1, embedding: 'openai:stored' });
        vi.stubEnv('ZENERA_GYM_EMBEDDING', 'openai:env');
        // Configured everywhere, yet off without the flag.
        for (const off of [undefined, '', 'off', 'none']) {
            expect(await chooseEmbedding(off, keys)).toEqual({ from: 'none' });
        }
        expect(await chooseEmbedding('openai:flag', keys)).toEqual({
            ref: 'openai:flag',
            from: 'flag',
        });

        // `on` takes the variable, then the setting, then the keys' default.
        expect(await chooseEmbedding('on', keys)).toEqual({ ref: 'openai:env', from: 'env' });
        vi.stubEnv('ZENERA_GYM_EMBEDDING', '');
        expect(await chooseEmbedding('default', keys)).toEqual({
            ref: 'openai:stored',
            from: 'store',
        });
        writeSettings({ version: 1 });
        expect(await chooseEmbedding('on', keys)).toMatchObject({
            ref: expect.stringMatching(/^openai:/),
            from: 'default',
        });
        vi.stubEnv('ZENERA_GYM_EMBEDDING', 'none');
        expect(await chooseEmbedding('on', keys)).toEqual({ from: 'env' });
    });
});
