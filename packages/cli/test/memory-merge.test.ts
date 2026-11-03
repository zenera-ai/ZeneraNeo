import { MemoryGraph, MemoryStore, type MemoryNode } from '@zenera/neo';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memory as command } from '../src/commands/memory.ts';
import { CliError, EXIT } from '../src/term.ts';

// ---------------------------------------------------------------------------
// zen memory merge
//
// Driven through `run` with `--json`, which is the contract the warmup script
// uses. Every memory here is built by hand rather than by running an agent:
// the merge is offline, so the test can be too.
// ---------------------------------------------------------------------------

const T0 = '2026-01-01T00:00:00.000Z';

function node(id: string, over: Partial<MemoryNode> = {}): MemoryNode {
    return {
        id,
        kind: 'task',
        text: `remembered ${id}`,
        audience: ['*'],
        createdAt: T0,
        updatedAt: T0,
        lastUsedAt: T0,
        useCount: 0,
        revision: 1,
        ...over,
    };
}

describe('zen memory merge', () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'zen-merge-'));
    });

    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
    });

    /** Runs the command, giving back parsed stdout and whatever it threw. */
    async function run(...args: string[]): Promise<{ out: any; err: unknown }> {
        const lines: string[] = [];
        const write = vi
            .spyOn(process.stdout, 'write')
            .mockImplementation((chunk: string | Uint8Array) => {
                lines.push(String(chunk));
                return true;
            });
        const quiet = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        let err: unknown;
        try {
            await command.run({ args, json: true, cwd: root });
        } catch (e) {
            err = e;
        } finally {
            write.mockRestore();
            quiet.mockRestore();
        }
        return { out: lines.length ? JSON.parse(lines.join('')) : undefined, err };
    }

    async function memory(name: string, nodes: MemoryNode[]): Promise<string> {
        const store = await MemoryStore.open(join(root, name));
        for (const n of nodes) {
            store.graph.adopt(n);
        }
        await store.commit();
        store.release();
        return name;
    }

    it('wants at least one memory to merge', async () => {
        const { err } = await run('merge', '--dir', 'into');

        expect(err).toBeInstanceOf(CliError);
        expect((err as CliError).code).toBe(EXIT.usage);
        expect((err as CliError).message).toContain('at least one memory directory');
    });

    it('folds several memories into a directory that does not exist yet', async () => {
        await memory('a', [node('A1'), node('A2')]);
        await memory('b', [node('B1')]);

        const { out, err } = await run('merge', 'a', 'b', '--dir', 'into');

        expect(err).toBeUndefined();
        expect(out).toMatchObject({ added: 3, shared: 0, twins: 0 });
        expect(out.sources.map((s: { added: number }) => s.added)).toEqual([2, 1]);
        expect(existsSync(join(root, 'into', 'memory.db'))).toBe(true);

        const back = await MemoryStore.open(join(root, 'into'), { readOnly: true });
        expect(back.graph.order).toBe(3);
        back.release();
    });

    it('adds nothing on a dry run', async () => {
        await memory('a', [node('A1')]);

        const { out } = await run('merge', 'a', '--dir', 'into', '--dry-run');

        expect(out).toMatchObject({ added: 1, dryRun: true });
        expect(existsSync(join(root, 'into', 'memory.db'))).toBe(false);
    });

    it('merges into a memory that already holds something when told to', async () => {
        await memory('a', [node('A1')]);
        await memory('b', [node('B1')]);
        await run('merge', 'a', '--dir', 'into');

        const { out, err } = await run('merge', 'b', '--dir', 'into', '--yes');

        expect(err).toBeUndefined();
        expect(out).toMatchObject({ added: 1 });
        const back = await MemoryStore.open(join(root, 'into'), { readOnly: true });
        expect(back.graph.order).toBe(2);
        back.release();
    });

    it('fails with the ids to look at when two copies of a memory disagree', async () => {
        await memory('a', [node('D1', { text: 'the left answer', revision: 2 })]);
        await memory('b', [node('D1', { text: 'the right answer', revision: 3 })]);

        const { out, err } = await run('merge', 'a', 'b', '--dir', 'into');

        expect(err).toBeInstanceOf(CliError);
        expect((err as CliError).code).toBe(EXIT.failed);
        expect(out.conflicts).toEqual([
            { id: 'D1', dir: join(root, 'b'), mine: 2, theirs: 3, text: 'the right answer' },
        ]);
        expect(existsSync(join(root, 'into', 'memory.db'))).toBe(false);
    });

    it('picks the newest of two disagreeing copies under --force', async () => {
        await memory('a', [node('D1', { text: 'the left answer', revision: 2 })]);
        await memory('b', [node('D1', { text: 'the right answer', revision: 3 })]);

        const { out, err } = await run('merge', 'a', 'b', '--dir', 'into', '--force');

        expect(err).toBeUndefined();
        expect(out).toMatchObject({ added: 1, shared: 1 });
        const back = await MemoryStore.open(join(root, 'into'), { readOnly: true });
        expect(back.graph.get('D1')).toMatchObject({ text: 'the right answer', revision: 3 });
        back.release();
    });

    it('keeps memories that read alike when told not to dedupe', async () => {
        await memory('a', [node('A1', { text: 'the same thing' })]);
        await memory('b', [node('B1', { text: 'the same thing' })]);

        expect((await run('merge', 'a', 'b', '--dir', 'into')).out).toMatchObject({
            added: 1,
            twins: 1,
        });
        expect((await run('merge', 'a', 'b', '--dir', 'other', '--no-dedupe')).out).toMatchObject({
            added: 2,
            twins: 0,
        });
    });

    it('converts a version 1 memory once, and says how when one is opened', async () => {
        const dir = join(root, 'old');
        mkdirSync(dir);
        const graph = new MemoryGraph();
        graph.adopt(node('V1'));
        writeFileSync(join(dir, 'graph.json'), JSON.stringify(graph.export()));
        writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version: 1 }));

        const refused = await run('stats', '--dir', 'old');
        expect(refused.err).toBeInstanceOf(CliError);
        expect((refused.err as CliError).hint).toMatch(/zen memory migrate/);

        const { out, err } = await run('migrate', '--dir', 'old');
        expect(err).toBeUndefined();
        expect(out).toMatchObject({ nodes: 1, edges: 0 });
        expect((await run('stats', '--dir', 'old')).err).toBeUndefined();
        expect((await run('migrate', '--dir', 'old')).err).toBeInstanceOf(CliError);
    });
});
