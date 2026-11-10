/**
 * Vitest coverage for the server's environment-configured state store and limits (plugins.ts).
 * envStateStore loads a ZEN_STATE_STORE module and checks what it returns; envServerLimits
 * reads checkpoint interval, host subject, disk quota, command limits and the stop grace.
 * Uses temporary plugin modules only; no server is started.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULTS, envServerLimits, envStateStore, USER_LAYOUT } from '../src/index.ts';

const dir = mkdtempSync(join(tmpdir(), 'zen-state-plugin-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function plugin(name: string, body: string): string {
    const path = join(dir, name);
    writeFileSync(path, body);
    return path;
}

describe('envStateStore', () => {
    it('is undefined without ZEN_STATE_STORE: the local store', async () => {
        expect(await envStateStore({}, { projectId: 'p', root: '/r' })).toBeUndefined();
    });

    it('makes the store a module exports, given the project, root and layout', async () => {
        const path = plugin(
            'good.mjs',
            `export function userStateStore(o) {
                return { name: 'probe:' + o.projectId + ':' + o.root + ':' + o.layout.sessionMeta + ':' + o.env.X,
                    durable: true, load: async () => {}, checkpoint: async () => {} };
            }`,
        );
        const store = await envStateStore(
            { ZEN_STATE_STORE: path, X: 'y' },
            { projectId: 'p1', root: '/state' },
        );
        expect(store?.name).toBe(`probe:p1:/state:${USER_LAYOUT.sessionMeta}:y`);
        expect(store?.durable).toBe(true);
    });

    it('refuses a module without the factory, or a factory returning no store', async () => {
        const none = plugin('none.mjs', 'export const x = 1;');
        await expect(
            envStateStore({ ZEN_STATE_STORE: none }, { projectId: 'p', root: '/r' }),
        ).rejects.toThrow(/exports no userStateStore/);
        const bad = plugin('bad.mjs', 'export const userStateStore = () => ({ name: "x" });');
        await expect(
            envStateStore({ ZEN_STATE_STORE: bad }, { projectId: 'p', root: '/r' }),
        ).rejects.toThrow(/did not return a store/);
        await expect(
            envStateStore(
                { ZEN_STATE_STORE: join(dir, 'missing.mjs') },
                { projectId: 'p', root: '/r' },
            ),
        ).rejects.toThrow();
    });
});

describe('envServerLimits', () => {
    it('keeps the defaults when nothing is set', () => {
        expect(envServerLimits({})).toEqual({
            checkpointSeconds: DEFAULTS.checkpointSeconds,
            systemSubject: 'zenera-app',
            userDiskQuotaBytes: 0,
            commandLimits: { nice: 10, fileSizeBytes: 0, tmpBytes: 0 },
            stopGraceSeconds: 0,
        });
    });

    it('reads whole numbers in MB, caps nice, and ignores what is not a number', () => {
        expect(
            envServerLimits({
                ZEN_STATE_CHECKPOINT_SECONDS: '60',
                ZEN_SERVER_SYSTEM_SUBJECT: 'host',
                ZEN_RUNTIME_USER_DISK_MB: '2048',
                ZEN_RUNTIME_NICE: '50',
                ZEN_RUNTIME_MAX_FILE_MB: '512',
                ZEN_RUNTIME_TMP_MB: 'lots',
                ZEN_SERVER_STOP_GRACE_SECONDS: '540',
            }),
        ).toEqual({
            checkpointSeconds: 60,
            systemSubject: 'host',
            userDiskQuotaBytes: 2048 * 2 ** 20,
            commandLimits: { nice: 19, fileSizeBytes: 512 * 2 ** 20, tmpBytes: 0 },
            stopGraceSeconds: 540,
        });
        expect(envServerLimits({ ZEN_RUNTIME_NICE: '0' }).commandLimits.nice).toBe(0);
    });
});
