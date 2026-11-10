import { MemoryStore, type MemoryNode } from '@zenera/neo';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memory as command } from '../src/commands/memory.ts';
import { CliError, EXIT, plain } from '../src/term.ts';

// ---------------------------------------------------------------------------
// zen memory diff
//
// A run that started from a copy of <base>: what it added, which of those
// `merge` would have folded (a re-commit), what it revised and what it read.
// No vectors here, so nearness is the text rule merge falls back to.
// ---------------------------------------------------------------------------

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-02T00:00:00.000Z';

function node(id: string, over: Partial<MemoryNode> = {}): MemoryNode {
    return {
        id,
        kind: 'operation',
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

describe('zen memory diff', () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'zen-diff-'));
    });

    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
    });

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

    async function memory(
        name: string,
        nodes: MemoryNode[],
        edges: [string, string, 'SUPERSEDES' | 'INFORMED'][] = [],
    ): Promise<void> {
        const store = await MemoryStore.open(join(root, name));
        for (const n of nodes) {
            store.graph.adopt(n);
        }
        for (const [source, target, relation] of edges) {
            store.graph.adoptEdge(source, target, { relation, createdAt: T1 });
        }
        await store.commit();
        store.release();
    }

    const base = [
        node('KEEP', { text: 'the firewall rules are listed at /api/v1/firewall/rules' }),
        node('READ', { text: 'gateways are paged with cursor' }),
        node('OLD', { text: 'the old answer' }),
        node('GONE'),
    ];

    it('says what a run added, re-committed, revised, read and dropped', async () => {
        await memory('base', base);
        await memory(
            'copy',
            [
                base[0]!,
                { ...base[1]!, useCount: 2, lastUsedAt: T1 },
                { ...base[2]!, text: 'the corrected answer', revision: 2, updatedAt: T1 },
                node('NEW', {
                    text: 'subnets live under /api/v1/subnets',
                    createdAt: T1,
                }),
                node('AGAIN', {
                    text: '  The firewall rules are listed at /api/v1/firewall/rules ',
                    createdAt: T1,
                }),
                node('FIX', { text: 'the answer, superseded properly', createdAt: T1 }),
            ],
            [['FIX', 'OLD', 'SUPERSEDES']],
        );

        const { out, err } = await run('diff', 'base', '--dir', 'copy');

        expect(err).toBeUndefined();
        expect(out.by).toBe('text');
        const added = Object.fromEntries(
            out.added.map((a: any) => [a.node.id, { twin: a.twin, near: a.nearest?.id }]),
        );
        expect(added.AGAIN).toEqual({ twin: true, near: 'KEEP' });
        expect(added.NEW.twin).toBe(false);
        expect(added.NEW.near).toBe('KEEP');
        expect(out.revised.map((r: any) => [r.before.revision, r.after.revision])).toEqual([
            [1, 2],
        ]);
        expect(out.used).toEqual([expect.objectContaining({ loads: 2 })]);
        expect(out.used[0].node.id).toBe('READ');
        expect(out.removed.map((n: MemoryNode) => n.id)).toEqual(['GONE']);
        expect(out.supersedes).toEqual([{ source: 'FIX', target: 'OLD' }]);
        expect(out.edges).toBe(1);
    });

    it('never folds onto a node of another kind or audience', async () => {
        await memory('base', [node('A', { text: 'same words' })]);
        await memory('copy', [
            node('A', { text: 'same words' }),
            node('B', { text: 'same words', kind: 'rule' }),
            node('C', { text: 'same words', audience: ['reviewer'] }),
        ]);

        const { out } = await run('diff', 'base', '--dir', 'copy');

        expect(out.added.every((a: any) => !a.twin && !a.nearest)).toBe(true);
    });

    it('reads a memory another process holds', async () => {
        await memory('base', base);
        await memory('copy', base);
        const held = await MemoryStore.open(join(root, 'copy'));
        try {
            const { out, err } = await run('diff', 'base', '--dir', 'copy');
            expect(err).toBeUndefined();
            expect(out.added).toEqual([]);
        } finally {
            held.release();
        }
    });

    it('wants exactly one base, and one that is a memory', async () => {
        await memory('copy', base);

        const none = await run('diff', '--dir', 'copy');
        expect((none.err as CliError).code).toBe(EXIT.usage);

        const missing = await run('diff', 'nowhere', '--dir', 'copy');
        expect((missing.err as CliError).message).toContain('is not a memory');
    });

    describe('and ls, read as text', () => {
        const long = `${'a long memory that says a great deal '.repeat(6)}and ends here`;

        async function text(tty: boolean, ...args: string[]): Promise<string> {
            const lines: string[] = [];
            const was = process.stdout.isTTY;
            const cols = process.stdout.columns;
            process.stdout.isTTY = tty;
            process.stdout.columns = 100;
            const write = vi
                .spyOn(process.stdout, 'write')
                .mockImplementation((chunk: string | Uint8Array) => {
                    lines.push(String(chunk));
                    return true;
                });
            try {
                await command.run({ args, json: false, cwd: root });
            } finally {
                write.mockRestore();
                process.stdout.isTTY = was;
                process.stdout.columns = cols;
            }
            return plain(lines.join(''));
        }

        it('shows audience and revision, and the whole text to a pipe', async () => {
            await memory('m', [node('A', { text: long, audience: ['audit'], revision: 3 })]);

            const out = await text(false, 'ls', '--dir', 'm');

            expect(out).toContain('audit');
            expect(out).toContain('r3');
            expect(out).toContain('and ends here');
        });

        it('cuts the text to the terminal, and only the text', async () => {
            await memory('m', [node('A', { text: long, audience: ['audit'] })]);

            const out = await text(true, 'ls', '--dir', 'm');

            expect(out).toContain('audit');
            expect(out).not.toContain('and ends here');
            expect(Math.max(...out.split('\n').map((l) => l.length))).toBeLessThanOrEqual(100);
        });
    });
});
