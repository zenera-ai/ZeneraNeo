import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { finder as matcher, MAX_PATTERN, PatternError } from '../src/match.ts';
import { grepMemory, MAX_GREP_FILE_BYTES } from '../src/memory/grep.ts';
import { MemoryIndex } from '../src/memory/index.ts';
import { FILES_DIR, MemoryStore } from '../src/memory/store.ts';
import { memoryTools } from '../src/memory/tools.ts';
import { MemoryError, type MemoryAccess } from '../src/memory/types.ts';
import { isToolReturn, MEMORY_GREP_TOOL, type AnyTool, type ToolContext } from '../src/types.ts';

// ---------------------------------------------------------------------------
// The exhaustive read
//
// What is under test is mostly the promises `search` cannot make: that `found`
// is the true total rather than the length of what came back, that a file which
// was not read says so, and that a superseded node does not quietly pass for a
// current one. Each of those is a way for a complete answer to be silently
// incomplete, which is the only way this can fail that matters.
// ---------------------------------------------------------------------------

const dirs: string[] = [];

afterEach(() => {
    for (const d of dirs.splice(0)) {
        rmSync(d, { recursive: true, force: true });
    }
});

const AT = '2026-01-01T00:00:00.000Z';

async function store(): Promise<MemoryStore> {
    const dir = mkdtempSync(join(tmpdir(), 'zn-memgrep-'));
    dirs.push(dir);
    return MemoryStore.open(dir);
}

/** Writes a remembered file the way `rememberFile` would name it. */
function put(dir: string, name: string, content: string | Buffer): void {
    mkdirSync(join(dir, FILES_DIR), { recursive: true });
    writeFileSync(join(dir, FILES_DIR, name), content);
}

describe('the pattern', () => {
    it('is a literal by default, so punctuation means itself', () => {
        expect(matcher('user.id')('user.id')).toBe(0);
        expect(matcher('user.id')('userXid')).toBe(-1);
    });

    it('ignores case unless told not to', () => {
        expect(matcher('Timeout')('a timeout happened')).toBe(2);
        expect(matcher('Timeout', { caseSensitive: true })('a timeout happened')).toBe(-1);
    });

    it('reports where it matched, not merely that it did', () => {
        expect(matcher('key')('the api key here')).toBe(8);
    });

    it('is bounded, because it may have come from a model', () => {
        expect(() => matcher('')).toThrow(PatternError);
        expect(() => matcher('x'.repeat(MAX_PATTERN + 1))).toThrow(PatternError);
        expect(() => matcher('(unclosed', { regex: true })).toThrow(PatternError);
    });
});

describe('grep over a memory', () => {
    it('matches the text, the metadata and the file, and says which', async () => {
        const s = await store();
        put(s.dir, 'f.py', 'import os\nTOKEN = env("ZEN_TOKEN")\n');
        s.graph.add(
            { id: 'a', kind: 'fact', text: 'the ZEN_TOKEN is per project', audience: ['*'] },
            AT,
        );
        s.graph.add(
            {
                id: 'b',
                kind: 'operation',
                text: 'the deploy call',
                audience: ['*'],
                metadata: { env: 'ZEN_TOKEN' },
            },
            AT,
        );
        s.graph.add(
            {
                id: 'c',
                kind: 'file',
                text: 'the deploy script',
                audience: ['*'],
                file: { path: '/memory/f.py', bytes: 34, sha256: 'x', format: 'py' },
            },
            AT,
        );

        const res = await grepMemory(s, 'ZEN_TOKEN');

        expect(res.found).toBe(3);
        const where = new Map(res.matches.map((m) => [m.node.id, m.hits.map((h) => h.where)]));
        expect(where.get('a')).toEqual(['text']);
        expect(where.get('b')).toEqual(['metadata']);
        expect(where.get('c')).toEqual(['file']);
    });

    it('numbers lines from one, within the field it matched', async () => {
        const s = await store();
        put(s.dir, 'f.py', 'import os\n\nTOKEN = 1\n');
        s.graph.add(
            {
                id: 'c',
                kind: 'file',
                text: 'a script',
                audience: ['*'],
                file: { path: '/memory/f.py', bytes: 22, sha256: 'x', format: 'py' },
            },
            AT,
        );

        const [match] = (await grepMemory(s, 'TOKEN')).matches;

        expect(match!.hits).toEqual([{ where: 'file', line: 3, text: 'TOKEN = 1' }]);
    });

    it('indents metadata, so a line number names a key rather than everything', async () => {
        const s = await store();
        s.graph.add(
            {
                id: 'a',
                kind: 'fact',
                text: 'a call',
                audience: ['*'],
                metadata: { host: 'db.internal' },
            },
            AT,
        );

        const [match] = (await grepMemory(s, 'db.internal')).matches;

        expect(match!.hits[0]!.where).toBe('metadata');
        expect(match!.hits[0]!.text).toContain('"host"');
    });

    it('reports the true total even when the list was cut', async () => {
        const s = await store();
        for (const id of ['a', 'b', 'c', 'd']) {
            s.graph.add({ id, kind: 'fact', text: `the ${id} timeout`, audience: ['*'] }, AT);
        }

        const res = await grepMemory(s, 'timeout', { limit: 2 });

        expect(res.matches).toHaveLength(2);
        expect(res.found).toBe(4);
        expect(res.truncated).toBe(true);
    });

    it('leaves out what was superseded, and marks it when asked for', async () => {
        const s = await store();
        s.graph.add({ id: 'old', kind: 'fact', text: 'the port is 8080', audience: ['*'] }, AT);
        s.graph.add({ id: 'new', kind: 'fact', text: 'the port is 9090', audience: ['*'] }, AT);
        s.graph.link('new', 'old', 'SUPERSEDES', AT);

        expect((await grepMemory(s, 'the port')).matches.map((m) => m.node.id)).toEqual(['new']);

        const all = await grepMemory(s, 'the port', { stale: 'include' });
        expect(new Map(all.matches.map((m) => [m.node.id, m.stale]))).toEqual(
            new Map([
                ['new', false],
                ['old', true],
            ]),
        );

        const only = await grepMemory(s, 'the port', { stale: 'only' });
        expect(only.matches.map((m) => m.node.id)).toEqual(['old']);
    });

    it('applies the audience mask, so a hit cannot confirm a node exists', async () => {
        const s = await store();
        s.graph.add({ id: 'a', kind: 'fact', text: 'the shared rate limit', audience: ['*'] }, AT);
        s.graph.add(
            { id: 'b', kind: 'fact', text: 'the audit rate limit', audience: ['audit'] },
            AT,
        );

        expect((await grepMemory(s, 'rate limit', { sees: [] })).found).toBe(1);
        expect((await grepMemory(s, 'rate limit', { sees: ['audit'] })).found).toBe(2);
        expect((await grepMemory(s, 'rate limit')).found).toBe(2);
    });

    it('narrows by kind, audience, file and field', async () => {
        const s = await store();
        s.graph.add({ id: 'a', kind: 'fact', text: 'deploy notes', audience: ['audit'] }, AT);
        s.graph.add({ id: 'b', kind: 'plan', text: 'deploy notes', audience: ['*'] }, AT);

        expect((await grepMemory(s, 'deploy', { kinds: ['plan'] })).found).toBe(1);
        expect((await grepMemory(s, 'deploy', { audience: 'audit' })).found).toBe(1);
        expect((await grepMemory(s, 'deploy', { files: true })).found).toBe(0);
        expect((await grepMemory(s, 'deploy', { in: ['file'] })).found).toBe(0);
    });

    it('reads a regex per line, as grep does', async () => {
        const s = await store();
        put(s.dir, 'f.py', 'x = 1\ndef run():\n    pass\n');
        s.graph.add(
            {
                id: 'c',
                kind: 'file',
                text: 'a script',
                audience: ['*'],
                file: { path: '/memory/f.py', bytes: 27, sha256: 'x', format: 'py' },
            },
            AT,
        );

        const [match] = (await grepMemory(s, '^def ', { regex: true })).matches;

        expect(match!.hits).toEqual([{ where: 'file', line: 2, text: 'def run():' }]);
    });

    it('refuses a broken pattern as a MemoryError, so a caller can hand it back', async () => {
        const s = await store();
        await expect(grepMemory(s, '(unclosed', { regex: true })).rejects.toBeInstanceOf(
            MemoryError,
        );
    });

    it('names a file it could not search, so a miss is never mistaken for absence', async () => {
        const s = await store();
        put(s.dir, 'big.txt', 'needle\n'.padEnd(MAX_GREP_FILE_BYTES + 1, '.'));
        put(s.dir, 'blob.bin', Buffer.from([0x6e, 0x00, 0x65]));
        s.graph.add(
            {
                id: 'big',
                kind: 'file',
                text: 'a large one',
                audience: ['*'],
                file: { path: '/memory/big.txt', bytes: 1, sha256: 'x', format: 'txt' },
            },
            AT,
        );
        s.graph.add(
            {
                id: 'blob',
                kind: 'file',
                text: 'a binary one',
                audience: ['*'],
                file: { path: '/memory/blob.bin', bytes: 3, sha256: 'x', format: 'bin' },
            },
            AT,
        );
        s.graph.add(
            {
                id: 'gone',
                kind: 'file',
                text: 'one whose bytes went missing',
                audience: ['*'],
                file: { path: '/memory/gone.txt', bytes: 1, sha256: 'x', format: 'txt' },
            },
            AT,
        );

        const res = await grepMemory(s, 'needle');

        expect(res.found).toBe(0);
        expect(new Map(res.skipped.map((s) => [s.id, s.reason]))).toEqual(
            new Map([
                ['big', 'too-big'],
                ['blob', 'binary'],
                ['gone', 'missing'],
            ]),
        );
    });

    it('does not count as use, because only a load does', async () => {
        const s = await store();
        s.graph.add({ id: 'a', kind: 'fact', text: 'a timeout', audience: ['*'] }, AT);
        const before = { ...s.graph.get('a')! };

        await grepMemory(s, 'timeout');

        expect(s.graph.get('a')!.lastUsedAt).toBe(before.lastUsedAt);
        expect(s.graph.get('a')!.useCount).toBe(before.useCount);
    });

    it('keeps a long line to a window around the match', async () => {
        const s = await store();
        s.graph.add(
            { id: 'a', kind: 'fact', text: 'x'.repeat(4000) + 'needle', audience: ['*'] },
            AT,
        );

        const [match] = (await grepMemory(s, 'needle')).matches;

        expect(match!.hits[0]!.text).toContain('needle');
        expect(match!.hits[0]!.text.length).toBeLessThan(300);
    });

    it('caps the hits it keeps per node, and says how many it dropped', async () => {
        const s = await store();
        s.graph.add(
            { id: 'a', kind: 'fact', text: Array(10).fill('needle').join('\n'), audience: ['*'] },
            AT,
        );

        const [match] = (await grepMemory(s, 'needle', { hitsPerNode: 3 })).matches;

        expect(match!.hits).toHaveLength(3);
        expect(match!.more).toBe(7);
    });
});

describe('the memory_grep tool', () => {
    const tc = {
        callId: 'call1',
        state: { runId: 'run1' },
        services: {},
    } as unknown as ToolContext;

    async function grepTool(access: MemoryAccess = 'read'): Promise<[AnyTool, MemoryStore]> {
        const s = await store();
        const tools = memoryTools({
            index: new MemoryIndex({ store: s }),
            binding: { access, sees: [], writes: ['*'] },
        });
        return [tools.find((t) => t.name === MEMORY_GREP_TOOL)!, s];
    }

    const unwrap = (ret: unknown) => (isToolReturn(ret) ? ret.output : ret);

    it('is offered at every access level, being strictly a read', async () => {
        for (const access of ['read', 'read-write', 'full'] as const) {
            const [tool] = await grepTool(access);
            expect(tool).toBeDefined();
        }
    });

    it('hands a broken pattern back as a refusal rather than ending the turn', async () => {
        const [tool] = await grepTool();

        const res = unwrap(await tool.execute({ pattern: '(unclosed', regex: true }, tc)) as never;

        expect(res).toMatchObject({ error: expect.stringContaining('invalid pattern') });
    });

    it('says so plainly when nothing matches, because that is the answer', async () => {
        const [tool] = await grepTool();

        expect(await tool.execute({ pattern: 'nowhere' }, tc)).toContain('nothing in memory');
    });

    it('returns the matching lines, and records the nodes the model saw', async () => {
        const [tool, s] = await grepTool();
        s.graph.add({ id: 'a', kind: 'fact', text: 'the staging host', audience: ['*'] }, AT);

        const ret = await tool.execute({ pattern: 'staging' }, tc);
        const out = unwrap(ret) as { found: number; matches: { id: string; hits: unknown[] }[] };

        expect(out.found).toBe(1);
        expect(out.matches[0]!.id).toBe('a');
        expect(out.matches[0]!.hits).toEqual([{ in: 'text', line: 1, text: 'the staging host' }]);
        expect(isToolReturn(ret) && ret.effects[0]).toMatchObject({
            kind: 'memory_op',
            spec: { op: 'grep', nodes: [{ id: 'a', kind: 'fact' }] },
        });
    });

    it('does not offer an audience parameter, which would defeat the mask', async () => {
        const [tool] = await grepTool();
        const props = (tool.parameters as { properties: Record<string, unknown> }).properties;

        expect(Object.keys(props)).not.toContain('audience');
        expect(Object.keys(props)).not.toContain('sees');
    });
});
