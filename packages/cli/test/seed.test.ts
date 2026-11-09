/**
 * Vitest regression coverage for startup snapshots of SQLite/WAL memory seeds.
 * Tests exercise prepareMemorySeed, read-only seed access and the server's userMemory
 * copy path, including committed WAL data, fixed startup contents, private writable
 * copies, project defaults, disabled seeds and cleanup after snapshot failures.
 */
import { MEMORY_DB, MemoryStore } from '@zenera/neo';
import { configure, DEFAULTS, userMemory } from '@zenera/server';
import assert from 'node:assert/strict';
import {
    chmodSync,
    existsSync,
    mkdtempSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareMemorySeed } from '../src/seed.ts';

let root: string;
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'zen-seed-test-'));
    writeFileSync(
        join(root, 'agents.yaml'),
        'version: 1\nmemory:\n  dir: memory\nagents:\n  - name: main\n    model: openai:gpt-4o-mini\n',
    );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function remember(store: MemoryStore, id: string): void {
    store.write(() => {
        store.graph.add({ id, kind: 'fact', text: id, audience: ['*'] }, new Date().toISOString());
    });
}

describe('startup memory seeds', () => {
    it('captures committed WAL data and gives users private writable copies of a read-only snapshot', async () => {
        const source = await MemoryStore.open(join(root, 'memory'));
        let seed: Awaited<ReturnType<typeof prepareMemorySeed>> = null;
        try {
            remember(source, 'startup');
            writeFileSync(source.filePath('note.txt'), 'startup attachment');
            chmodSync(source.filePath('note.txt'), 0o600);
            expect(existsSync(join(source.dir, `${MEMORY_DB}-wal`))).toBe(true);
            seed = await prepareMemorySeed(root, join(root, 'state'));
            assert(seed);
            expect(statSync(join(seed.dir, MEMORY_DB)).mode & 0o777).toBe(0o644);
            expect(statSync(join(seed.dir, 'files', 'note.txt')).mode & 0o777).toBe(0o644);
            expect(statSync(source.filePath('note.txt')).mode & 0o777).toBe(0o600);
            remember(source, 'after-startup');
            chmodSync(seed.dir, 0o555);
            chmodSync(join(seed.dir, MEMORY_DB), 0o444);
            const db = new DatabaseSync(join(seed.dir, MEMORY_DB), { readOnly: true });
            try {
                expect(db.prepare('PRAGMA journal_mode').get()).toMatchObject({
                    journal_mode: 'delete',
                });
                expect(db.prepare('SELECT id FROM nodes').all()).toEqual([{ id: 'startup' }]);
            } finally {
                db.close();
            }
            configure({
                ...DEFAULTS,
                projectId: 'test',
                projectDir: root,
                root: join(root, 'state'),
                memorySeed: seed.dir,
                auth: { mode: 'insecure' },
            });
            const [a1, a2] = await Promise.all([userMemory('alice'), userMemory('alice')]);
            expect(a1).toBe(a2);
            const bobDir = await userMemory('bob');
            expect(bobDir).not.toBe(a1);
            const alice = await MemoryStore.open(a1);
            const bob = await MemoryStore.open(bobDir);
            try {
                expect(alice.graph.order).toBe(1);
                expect(bob.graph.order).toBe(1);
                remember(alice, 'alice-only');
                expect(alice.graph.order).toBe(2);
                expect(bob.graph.has('alice-only')).toBe(false);
                expect(source.graph.has('alice-only')).toBe(false);
                expect(existsSync(alice.filePath('note.txt'))).toBe(true);
                expect(readdirSync(seed.dir).sort()).toEqual(['files', MEMORY_DB].sort());
            } finally {
                alice.release();
                bob.release();
            }
            chmodSync(seed.dir, 0o755);
            await seed.cleanup();
            expect(existsSync(seed.dir)).toBe(false);
            expect(existsSync(join(a1, MEMORY_DB))).toBe(true);
            const restarted = await prepareMemorySeed(root, join(root, 'state'));
            assert(restarted);
            try {
                configure({
                    ...DEFAULTS,
                    projectId: 'test',
                    root: join(root, 'state'),
                    memorySeed: restarted.dir,
                    auth: { mode: 'insecure' },
                });
                expect(await userMemory('alice')).toBe(a1);
                const existing = await MemoryStore.open(a1, { readOnly: true });
                try {
                    expect(existing.graph.has('after-startup')).toBe(false);
                    expect(existing.graph.has('alice-only')).toBe(true);
                } finally {
                    existing.release();
                }
                const carol = await MemoryStore.open(await userMemory('carol'), {
                    readOnly: true,
                });
                try {
                    expect(carol.graph.has('after-startup')).toBe(true);
                    expect(carol.graph.has('alice-only')).toBe(false);
                } finally {
                    carol.release();
                }
            } finally {
                await restarted.cleanup();
            }
        } finally {
            source.release();
            if (seed && existsSync(seed.dir)) {
                chmodSync(seed.dir, 0o755);
                await seed.cleanup();
            }
        }
    });

    it('does not read the project when seeding is disabled', async () => {
        expect(await prepareMemorySeed('/not-a-project', join(root, 'state'), null)).toBeNull();
        expect(existsSync(join(root, 'state'))).toBe(false);
    });

    it('fixes an uninitialized startup seed as empty', async () => {
        expect(await prepareMemorySeed(root, join(root, 'state'))).toBeNull();
        expect(existsSync(join(root, 'state'))).toBe(false);
    });

    it('rejects legacy seeds with migration instructions', async () => {
        writeFileSync(join(root, 'graph.json'), '{}');
        await expect(prepareMemorySeed(root, join(root, 'state'), root)).rejects.toThrow(
            'version 1 memory',
        );
        expect(existsSync(join(root, 'state'))).toBe(false);
    });

    it('reports corrupt seeds and removes incomplete snapshots', async () => {
        writeFileSync(join(root, MEMORY_DB), 'not a SQLite database');
        await expect(prepareMemorySeed(root, join(root, 'state'), root)).rejects.toThrow(
            'cannot snapshot the memory seed',
        );
        expect(readdirSync(join(root, 'state'))).toEqual([]);
    });
});
