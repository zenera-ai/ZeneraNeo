import { buildSandbox, sessionPaths } from '@zenera/engine';
import { MemoryStore, parseConfig, type AgentEvent } from '@zenera/neo';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    concurrency,
    containersPerItem,
    keepWritten,
    pool,
    prepareMemories,
} from '../src/batch.ts';
import { BatchProgress } from '../src/progress.ts';
import { parseBatch, readBatch, type BatchItem } from '../src/request.ts';

/**
 * A batch pays for every mistake once per item, so the file is read strictly
 * and completely before a single model is called. These are the refusals.
 */

const BASE = '/cases';
const at = (body: unknown) => () => parseBatch(JSON.stringify(body), BASE, 'cases.json');

/** What the person actually reads: the refusal and the way out of it. */
function said(fn: () => unknown): string {
    try {
        fn();
    } catch (err) {
        const e = err as { message: string; hint?: string };
        return `${e.message} ${e.hint ?? ''}`;
    }
    throw new Error('expected a refusal');
}

describe('a batch item\u2019s sandbox', () => {
    // Every item is a fresh session nobody resumes, so a stopped container per
    // item only holds an engine lock — 2048 of them and nothing can start.
    it('is removed on close, whatever the project or an agent says', () => {
        const config = parseConfig(
            'version: 1\nsandbox:\n  image: base\n  persist: true\nagents:\n' +
                '  - name: a\n  - name: b\n    sandbox:\n      image: other\n      persist: true\n',
            'agents.yaml',
        );
        const setup = (persist?: boolean) =>
            buildSandbox({
                config,
                root: '/p',
                session: sessionPaths('/p', '20261007-120000-abcd'),
                workspace: '/p/ws',
                keys: false,
                ...(persist === undefined ? {} : { persist }),
            });

        const kept = setup();
        expect(kept.pool.for('a').spec.persist).toBe(true);
        expect(kept.pool.for('b').spec.persist).toBe(true);

        const dropped = setup(false);
        expect(dropped.pool.for('a').spec.persist).toBe(false);
        expect(dropped.pool.for('b').spec.persist).toBe(false);
    });

    it('counts the containers one item can start, so the locks are asked for up front', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'zen-boxes-'));
        const count = async (yaml: string): Promise<number> => {
            await writeFile(join(dir, 'agents.yaml'), `version: 1\nagents:\n${yaml}`);
            return containersPerItem(dir);
        };
        try {
            expect(await count('  - name: a\n    tools: ["files:*"]\n')).toBe(0);
            expect(
                await count(
                    '  - name: a\n    tools: ["sandbox:*"]\n  - name: b\n    tools: [run_command]\n',
                ),
            ).toBe(1);
            expect(
                await count(
                    '  - name: a\n    tools: ["sandbox:*"]\n' +
                        '  - name: b\n    tools: [run_command]\n    sandbox:\n      image: other\n',
                ),
            ).toBe(2);
            expect(await count('  - name: a\n    tools: [nope]\n')).toBe(0);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

describe('reading a batch file', () => {
    it('takes a list of requests and numbers them', () => {
        const { items } = parseBatch(
            JSON.stringify({ batch: [{ input: 'one' }, { id: 'two', input: 'two' }] }),
            BASE,
            'cases.json',
        );
        expect(items).toEqual([
            { id: '0', index: 0, input: 'one', workspace: undefined },
            { id: 'two', index: 1, input: 'two', workspace: undefined },
        ]);
    });

    it('resolves an item workspace against the file, not the cwd', () => {
        const { items } = parseBatch(
            JSON.stringify({ batch: [{ input: 'x', workspace: './here' }] }),
            BASE,
            'cases.json',
        );
        expect(items[0]!.workspace).toBe(join(BASE, 'here'));
    });

    it('refuses anything that is not a list of requests', () => {
        expect(at([])).toThrow(/expected a JSON object/);
        expect(at({})).toThrow(/no "batch" array/);
        expect(at({ batch: {} })).toThrow(/no "batch" array/);
        expect(at({ batch: [] })).toThrow(/is empty/);
        expect(at({ batch: ['ask'] })).toThrow(/expected an object/);
        expect(at({ batch: [{ prompt: 'ask' }] })).toThrow(/no "input"/);
        expect(() => parseBatch('{', BASE, 'cases.json')).toThrow(/cases\.json/);
    });

    it('names the flag when the file tries to say what a flag says', () => {
        expect(said(at({ memory: './m', batch: [{ input: 'x' }] }))).toMatch(/--memory/);
        expect(said(at({ workspace: './w', batch: [{ input: 'x' }] }))).toMatch(/--workspace/);
        expect(said(at({ project: 'acme', batch: [{ input: 'x' }] }))).toMatch(/--project/);
        expect(said(at({ batch: [{ input: 'x', memory: './m' }] }))).toMatch(/--memory/);
        expect(said(at({ batch: [{ input: 'x', project: 'acme' }] }))).toMatch(/--project/);
    });

    it('refuses two items that would share a directory', () => {
        expect(
            at({
                batch: [
                    { id: 'a', input: 'x' },
                    { id: 'a', input: 'y' },
                ],
            }),
        ).toThrow(/share the id "a"/);
        expect(
            at({
                batch: [
                    { input: 'x', workspace: './w' },
                    { input: 'y', workspace: './w' },
                ],
            }),
        ).toThrow(/share the workspace/);
    });

    it('refuses an id that is not a directory name', () => {
        expect(at({ batch: [{ id: '../escape', input: 'x' }] })).toThrow(/cannot be an id/);
        expect(at({ batch: [{ id: 'a/b', input: 'x' }] })).toThrow(/cannot be an id/);
        expect(at({ batch: [{ id: '..', input: 'x' }] })).toThrow(/cannot be an id/);
        expect(at({ batch: [{ id: '', input: 'x' }] })).toThrow(/non-empty string/);
    });
});

describe('the batch file on disk', () => {
    let dir: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'zen-batch-'));
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it('resolves paths against the file wherever it was run from', async () => {
        const file = join(dir, 'cases.json');
        await writeFile(file, JSON.stringify({ batch: [{ input: 'x', workspace: './w' }] }));
        const { items } = await readBatch(file, '/elsewhere');
        expect(items[0]!.workspace).toBe(join(dir, 'w'));
    });

    it('takes the batch on stdin, and then the cwd is what paths mean', async () => {
        const body = JSON.stringify({ batch: [{ input: 'x', workspace: './w' }] });
        const { items } = await readBatch('-', dir, body);
        expect(items[0]!.workspace).toBe(join(dir, 'w'));
    });

    it('says which file it could not read', async () => {
        await expect(readBatch(join(dir, 'missing.json'), dir)).rejects.toThrow(/cannot read/);
    });
});

describe('running them a few at a time', () => {
    it('keeps the order of the file, whatever order they finish in', async () => {
        const items = [40, 10, 30, 0, 20];
        const out = await pool(items, 3, async (ms) => {
            await new Promise((r) => setTimeout(r, ms));
            return ms;
        });
        expect(out).toEqual(items);
    });

    it('never has more than the limit in flight', async () => {
        let live = 0;
        let peak = 0;
        await pool(
            Array.from({ length: 20 }, (_, i) => i),
            4,
            async () => {
                live += 1;
                peak = Math.max(peak, live);
                await new Promise((r) => setTimeout(r, 1));
                live -= 1;
            },
        );
        expect(peak).toBe(4);
    });

    it('starts no more workers than there is work', async () => {
        let started = 0;
        await pool([1, 2], 16, async () => {
            started += 1;
        });
        expect(started).toBe(2);
    });

    it('reads --concurrency as a whole number within reach', () => {
        expect(concurrency(undefined)).toBe(16);
        expect(concurrency('1')).toBe(1);
        expect(concurrency('32')).toBe(32);
        expect(() => concurrency('0')).toThrow(/1 or more/);
        expect(() => concurrency('2.5')).toThrow(/whole number/);
        expect(() => concurrency('many')).toThrow(/whole number/);
        expect(said(() => concurrency('64'))).toMatch(/32 is the most/);
    });
});

describe('the memory each item is given', () => {
    let dir: string;
    const items = [
        { index: 0, id: 'one', input: 'a' },
        { index: 1, id: 'two', input: 'b' },
    ] as BatchItem[];

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'zen-batch-mem-'));
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it('copies the graph per item, as of one moment, while a run is still writing it', async () => {
        const source = join(dir, 'memory');
        const live = await MemoryStore.open(source);
        live.write(() =>
            live.graph.add(
                { id: 'N1', kind: 'fact', text: 'kept', audience: ['*'] },
                '2026-01-01T00:00:00.000Z',
            ),
        );

        const out = join(dir, 'batch');
        let prepared;
        try {
            prepared = await prepareMemories(items, {
                dir: out,
                mode: 'copied',
                source,
                seeded: true,
            });
        } finally {
            live.release();
        }

        expect(prepared.get('one')).toBe(join(out, 'one', 'memory'));
        expect(prepared.get('two')).toBe(join(out, 'two', 'memory'));
        expect(existsSync(join(out, 'one', 'memory', 'memory.db-wal'))).toBe(false);
        const copy = await MemoryStore.open(join(out, 'one', 'memory'), { readOnly: true });
        expect(copy.graph.get('N1')?.text).toBe('kept');
        copy.release();
    });

    /**
     * Warming a cold project: the config names a memory directory that the
     * first run has yet to make. There is nothing to copy, which is not the
     * same as nothing to write to.
     */
    it('still gives an item its own memory when there is no graph to copy yet', async () => {
        const out = join(dir, 'batch');
        const prepared = await prepareMemories(items, {
            dir: out,
            mode: 'copied',
            source: join(dir, 'never-run'),
            seeded: false,
        });

        expect(prepared.get('one')).toBe(join(out, 'one', 'memory'));
        expect(existsSync(join(out, 'one'))).toBe(true);
        expect(existsSync(join(out, 'one', 'memory'))).toBe(false);
    });

    it('hands every item the one graph when nothing is going to write', async () => {
        const source = join(dir, 'memory');
        await mkdir(source, { recursive: true });

        const out = join(dir, 'batch');
        const prepared = await prepareMemories(items, {
            dir: out,
            mode: 'read-only',
            source,
            seeded: true,
        });

        expect(prepared.get('one')).toBe(source);
        expect(prepared.get('two')).toBe(source);
        expect(existsSync(join(out, 'one', 'memory'))).toBe(false);
    });

    it('gives an item no memory at all when the project has none', async () => {
        const out = join(dir, 'batch');
        const prepared = await prepareMemories(items, { dir: out, mode: 'none', seeded: false });

        expect(prepared.size).toBe(0);
        expect(existsSync(join(out, 'one'))).toBe(true);
    });

    /**
     * The command prints `zen memory merge <dir>/*` + `/memory` when it is
     * done, and `merge` refuses a directory that is not a memory. So advice
     * that fails is the thing being prevented here.
     */
    it('drops the memories nothing was committed to, and counts the rest', async () => {
        const wrote = join(dir, 'one', 'memory');
        const did_not = join(dir, 'two', 'memory');
        await mkdir(wrote, { recursive: true });
        await mkdir(join(did_not, 'files'), { recursive: true });
        await writeFile(join(wrote, 'memory.db'), '');

        const kept = await keepWritten(
            new Map([
                ['one', wrote],
                ['two', did_not],
            ]),
        );

        expect(kept).toBe(1);
        expect(existsSync(wrote)).toBe(true);
        expect(existsSync(did_not)).toBe(false);
    });
});

/**
 * A batch narrates nowhere else, so the file IS the progress. What is asserted
 * here is what someone watching it needs: which item is running, what it is
 * doing right now, and what the finished ones cost.
 */
describe('the dashboard a batch writes', () => {
    let dir: string;
    const items = [
        { index: 0, id: 'vat', input: 'what is VAT?' },
        { index: 1, id: 'paye', input: [{ text: 'and PAYE?' }, { image: './p.png' }] },
    ] as BatchItem[];

    const progress = (): BatchProgress =>
        new BatchProgress({
            dir,
            project: 'acme',
            projectDir: dir,
            input: 'cases.json',
            concurrency: 4,
            memory: 'copied',
            items,
        });

    const event = (e: Record<string, unknown>) =>
        ({ runId: 'r1', agent: 'default', ...e }) as unknown as AgentEvent;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'zen-batch-dash-'));
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it('says what every item is doing, and what it has spent', () => {
        const board = progress();
        const watch = board.watch('vat');
        watch(event({ type: 'before_tool_call', state: {}, call: { name: 'run_command' } }));
        watch(event({ type: 'thinking_delta', delta: 'the rate has been 20% since 2011' }));

        const text = board.render();
        expect(text).toContain('# acme — batch');
        expect(text).toContain('0/2');
        expect(text).toContain('## Running now');
        expect(text).toContain('▶ #0 vat');
        expect(text).toContain('what is VAT?');
        expect(text).toContain('thinking · ');
        expect(text).toContain('↳ the rate has been 20% since 2011');
        expect(text).toContain('## Waiting');
        expect(text).toContain('`paye`');
    });

    /**
     * A panel that grows and shrinks as items come and go drags everything
     * below it up and down the screen, which is unreadable at a glance. While
     * work is still queued it is drawn at the height it will keep.
     */
    it('holds its height while there is work left to start', () => {
        const board = new BatchProgress({
            dir,
            project: 'acme',
            projectDir: dir,
            input: 'cases.json',
            concurrency: 2,
            memory: 'copied',
            items: [...items, { index: 2, id: 'cgt', input: 'and CGT?' }] as BatchItem[],
        });
        const height = (text: string) =>
            text.split('## Running now')[1]?.split('\n## ')[0]?.split('\n').length;

        board.watch('vat');
        const started = height(board.render());
        expect(board.render()).toContain('· idle');

        board.finish('vat', { ok: true });
        board.watch('paye');
        expect(height(board.render())).toBe(started);
    });

    it('keeps the media out of the question it prints', () => {
        const board = progress();
        board.watch('paye');
        expect(board.render()).toContain('and PAYE? [image]');
    });

    it('counts the tokens a finished item reported, not the ones it streamed', () => {
        const board = progress();
        const watch = board.watch('vat');
        watch(
            event({
                type: 'after_llm_call',
                state: {},
                node: {
                    usage: {
                        inputTokens: 10,
                        outputTokens: 2,
                        cachedInputTokens: 0,
                        reasoningTokens: 0,
                    },
                },
            }),
        );
        board.finish('vat', {
            ok: true,
            usage: {
                inputTokens: 12_000,
                outputTokens: 1200,
                cachedInputTokens: 0,
                reasoningTokens: 400,
            },
        });

        const text = board.render();
        expect(text).toContain('## Finished');
        expect(text).toContain('12k in · 1.2k out (400 thinking)');
    });

    /**
     * A project can put each agent on a different model, and a fork on another
     * again. One total then belongs to none of them, which is the question
     * anyone reading a batch asks first: what did the expensive one cost?
     */
    it('says which model spent what, live', () => {
        const board = progress();
        const watch = board.watch('vat');
        const spent = (model: string, inputTokens: number) =>
            watch(
                event({
                    type: 'after_llm_call',
                    state: {},
                    node: {
                        model,
                        usage: {
                            inputTokens,
                            outputTokens: 100,
                            cachedInputTokens: 0,
                            reasoningTokens: 0,
                        },
                    },
                }),
            );
        spent('gemini-3-flash', 1000);
        spent('gpt-5.4', 9000);
        spent('gemini-3-flash', 2000);

        const rows = board.render().split('## Tokens by model')[1].split('\n## ')[0];
        // Heaviest first, however the calls happened to interleave.
        expect(rows).toMatch(/`gpt-5.4` \| 1 \| 9.0k \|[\s\S]*`gemini-3-flash` \| 2 \| 3.0k \|/);
    });

    it('takes the finished split from the result, not from the stream', () => {
        const board = progress();
        const watch = board.watch('vat');
        watch(
            event({
                type: 'after_llm_call',
                state: {},
                node: {
                    model: 'gemini-3-flash',
                    usage: {
                        inputTokens: 10,
                        outputTokens: 2,
                        cachedInputTokens: 0,
                        reasoningTokens: 0,
                    },
                },
            }),
        );
        board.finish('vat', {
            ok: true,
            usage: { inputTokens: 500, outputTokens: 40, cachedInputTokens: 0, reasoningTokens: 0 },
            models: [
                {
                    model: 'gemini-3-flash',
                    calls: 4,
                    usage: {
                        inputTokens: 500,
                        outputTokens: 40,
                        cachedInputTokens: 0,
                        reasoningTokens: 0,
                    },
                },
            ],
        });

        const rows = board.render().split('## Tokens by model')[1].split('\n## ')[0];
        expect(rows).toContain('`gemini-3-flash` | 4 | 500 |');
    });

    it('leaves the file as the record, with an interrupted item accounted for', async () => {
        const board = progress();
        board.watch('vat');
        board.finish('vat', { ok: false, error: 'the model refused' });
        board.watch('paye');
        board.begin();
        await board.close();

        const text = await readFile(join(dir, 'README.md'), 'utf8');
        expect(text).toContain('**Finished**');
        expect(text).toContain('## What went wrong');
        expect(text).toContain('the model refused');
        expect(text).toContain('interrupted');
        expect(text).not.toContain('## Running now');
    });
});
