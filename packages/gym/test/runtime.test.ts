import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Box, type SynthesizeHook } from '../src/box.ts';
import type { HandlerRequest } from '../src/runtime.ts';
import { collectionFor, createContext, matches, page, populatedKey } from '../src/runtime.ts';
import { worldPath, WorldStore } from '../src/store.ts';

const input = (over: Partial<HandlerRequest> = {}): HandlerRequest => ({
    operationId: 'op',
    method: 'get',
    path: '/things',
    pathParams: {},
    query: {},
    headers: {},
    body: undefined,
    seed: 7,
    ...over,
});

describe('paging', () => {
    const items = Array.from({ length: 5 }, (_, i) => i);

    it('advances by token and ends with no token', () => {
        const first = page(items, { size: 2 });
        expect(first).toMatchObject({ items: [0, 1], hasMore: true, total: 5 });
        const second = page(items, { token: first.nextToken, size: 2 });
        expect(second.items).toEqual([2, 3]);
        const last = page(items, { token: second.nextToken, size: 2 });
        expect(last).toMatchObject({
            items: [4],
            nextToken: null,
            nextOffset: null,
            hasMore: false,
        });
    });

    it('reads an offset, for offset-style APIs', () => {
        expect(page(items, { offset: '3', size: '10' })).toMatchObject({
            items: [3, 4],
            hasMore: false,
        });
    });

    // A token it cannot read is the end of the list, never the start of it:
    // the start again is how a client loops forever.
    it('answers an unreadable token with an empty last page', () => {
        expect(page(items, { token: 'nonsense' })).toMatchObject({ items: [], hasMore: false });
    });
});

describe('the world store', () => {
    let root: string;
    let store: WorldStore;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'gym-world-'));
        store = new WorldStore(join(root, 'world.sqlite'));
    });

    afterEach(() => {
        store.close();
        rmSync(root, { recursive: true, force: true });
    });

    it('keeps records by collection and id, in insertion order', () => {
        const col = store.collection('messages');
        col.put('b', { id: 'b' });
        col.putMany([
            { id: 'a', value: { id: 'a' } },
            { id: 'b', value: { id: 'b', v: 2 } },
        ]);
        expect(col.all()).toEqual([{ id: 'b', v: 2 }, { id: 'a' }]);
        expect(col.get('a')).toEqual({ id: 'a' });
        expect(col.has('zz')).toBe(false);
        expect(store.collections()).toEqual([
            { name: 'messages', count: 2, sampleIds: ['b', 'a'] },
        ]);
        expect(col.delete('a')).toBe(true);
        expect(col.count()).toBe(1);
    });

    // Two processes, one file: what one writes, the other reads.
    it('is shared by every connection to the same file', () => {
        const other = new WorldStore(store.path);
        other.collection('events').put(1, { id: 1 });
        expect(store.collection('events').get('1')).toEqual({ id: 1 });
        other.close();
    });

    it('snapshots into a copy that does not write back', () => {
        store.collection('users').put('1', { id: '1' });
        const copy = new WorldStore(store.snapshot(join(root, 'snap.sqlite')));
        copy.collection('users').put('2', { id: '2' });
        expect(store.collection('users').count()).toBe(1);
        expect(copy.collection('users').count()).toBe(2);
        copy.close();
    });

    it('names one world per story, so processes given the same story share it', () => {
        const at = (world?: string, storyDigest?: string): string =>
            worldPath({ root: '/r', cwd: '/c', world, storyDigest });
        expect(at(undefined, 'abc')).toBe(join('/r', 'worlds', 'story-abc.sqlite'));
        expect(at()).toBe(join('/r', 'worlds', 'default.sqlite'));
        expect(at('northwind', 'abc')).toBe(join('/r', 'worlds', 'northwind.sqlite'));
        expect(at('./w.sqlite')).toBe(join('/c', 'w.sqlite'));
        expect(at('/x/w.db')).toBe('/x/w.db');
        expect(() => at('no spaces')).toThrow(/not a world name/);
    });
});

describe('leases', () => {
    let root: string;
    let a: WorldStore;
    let b: WorldStore;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'gym-lease-'));
        a = new WorldStore(join(root, 'w.sqlite'));
        b = new WorldStore(join(root, 'w.sqlite'));
    });

    afterEach(() => {
        a.close();
        b.close();
        rmSync(root, { recursive: true, force: true });
    });

    const me = (tag: string): string => `${process.pid}:${tag}`;

    it('go to one holder at a time, across connections', () => {
        expect(a.claim('fill:x', me('a'), 60_000)).toBe(true);
        expect(b.claim('fill:x', me('b'), 60_000)).toBe(false);
        expect(a.claim('fill:x', me('a'), 60_000)).toBe(true);
        a.release('fill:x', me('a'));
        expect(b.claim('fill:x', me('b'), 60_000)).toBe(true);
    });

    it('cannot be given back by someone else', () => {
        a.claim('fill:x', me('a'), 60_000);
        b.release('fill:x', me('b'));
        expect(b.claim('fill:x', me('b'), 60_000)).toBe(false);
    });

    it('lapse when their time is up', () => {
        expect(a.claim('fill:x', me('a'), -1)).toBe(true);
        expect(b.claim('fill:x', me('b'), 60_000)).toBe(true);
    });

    // A crash must not cost the next process the whole lease.
    it('lapse when their process is gone', () => {
        expect(a.claim('fill:x', '999999:dead', 60_000)).toBe(true);
        expect(b.claim('fill:x', me('b'), 60_000)).toBe(true);
    });
});

describe('the handler context', () => {
    let root: string;
    let store: WorldStore;
    let asked: unknown[];

    const synth = (req: { collection: string; ids?: (string | number)[]; count?: number }) => {
        asked.push(req);
        const col = store.collection(req.collection);
        const ids =
            req.ids ?? Array.from({ length: req.count ?? 1 }, (_, i) => `n${col.count() + i}`);
        const made = ids.map((id) => ({ id: String(id) }));
        col.putMany(made.map((m) => ({ id: m.id, value: m })));
        store.setMeta(populatedKey(req.collection), true);
        return Promise.resolve(made);
    };

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'gym-ctx-'));
        store = new WorldStore(join(root, 'world.sqlite'));
        asked = [];
    });

    afterEach(() => {
        store.close();
        rmSync(root, { recursive: true, force: true });
    });

    it('looks a record up without an agent when the world has it', async () => {
        store.collection('users').put('1', { id: '1', name: 'Ada' });
        const ctx = createContext(input() as never, store, synth);
        expect(await ctx.lookup('users', 1)).toEqual({ id: '1', name: 'Ada' });
        expect(asked).toHaveLength(0);
    });

    it('asks for a record the world does not have, by its id', async () => {
        const ctx = createContext(input() as never, store, synth);
        expect(await ctx.lookup('users', 'u9')).toEqual({ id: 'u9' });
        expect(asked).toEqual([{ collection: 'users', ids: ['u9'] }]);
    });

    // A collection first touched by a write is not populated: the mailbox
    // whose only message is the one the client just sent is not an inbox yet.
    it('populates a collection on first read even when a write got there first', async () => {
        store.collection('messages').put('mine', { id: 'mine' });
        const ctx = createContext(input() as never, store, synth);
        const all = await ctx.ensure('messages', { min: 1 });
        expect(asked).toMatchObject([{ collection: 'messages', populate: true }]);
        expect(all.length).toBeGreaterThan(1);
        await ctx.ensure('messages', { min: 1 });
        expect(asked).toHaveLength(1);
    });

    it('finds a type through its binding, and records what was used', async () => {
        const used: unknown[] = [];
        store.collection('mail').put('m1', { id: 'm1' });
        const ctx = createContext(
            input() as never,
            store,
            synth,
            { Message: { collection: 'mail', idField: 'id' } },
            (u) => used.push(u),
        );
        expect(await ctx.lookup('Message', 'm1')).toEqual({ id: 'm1' });
        ctx.db.collection('Event').put('e1', { id: 'e1' });
        expect(store.collection('events').get('e1')).toEqual({ id: 'e1' });
        ctx.db.collection('mail').count();
        expect(used).toEqual([
            { collection: 'mail', type: 'Message', idField: 'id' },
            { collection: 'events', type: 'Event', idField: undefined },
            { collection: 'mail', type: 'Message', idField: 'id' },
        ]);
    });

    it('names a collection for a type nobody has bound', () => {
        expect(collectionFor('Message')).toBe('messages');
        expect(collectionFor('AvailabilityZone')).toBe('availability_zones');
        expect(collectionFor('Ipv6')).toBe('ipv6s');
        expect(collectionFor('Address')).toBe('address');
    });

    it('matches nested values, list members, and scalars as text', () => {
        const event = { id: 7, organizer: { email: 'a@x.io', name: 'A' }, labels: ['INBOX', 'X'] };
        expect(matches(event, { id: '7' })).toBe(true);
        expect(matches(event, { organizer: { email: 'a@x.io' } })).toBe(true);
        expect(matches(event, { organizer: { email: 'b@x.io' } })).toBe(false);
        expect(matches(event, { labels: 'INBOX' })).toBe(true);
        expect(matches(event, { labels: ['X', 'INBOX'] })).toBe(true);
        expect(matches(event, { labels: ['SENT'] })).toBe(false);
        expect(matches(event, { missing: 'undefined' })).toBe(false);
        expect(populatedKey('events', { organizer: { email: 'a@x.io' } })).not.toBe(
            populatedKey('events', { organizer: { email: 'b@x.io' } }),
        );
        expect(populatedKey('e', { b: 1, a: 2 })).toBe(populatedKey('e', { a: 2, b: 1 }));
    });

    it('seeds its randomness from the request', () => {
        const a = createContext(input() as never, store, synth);
        const b = createContext(input() as never, store, synth);
        expect([a.random(), a.newId(), a.fromPattern('^[0-9a-f]{16}$')]).toEqual([
            b.random(),
            b.newId(),
            b.fromPattern('^[0-9a-f]{16}$'),
        ]);
        expect(a.fromPattern('/^[a-v0-9]{5,8}$/')).toMatch(/^[a-v0-9]{5,8}$/);
    });
});

describe('the box', () => {
    let root: string;
    let store: WorldStore;
    let box: Box;
    let hook: SynthesizeHook;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'gym-box-'));
        store = new WorldStore(join(root, 'world.sqlite'));
        hook = (req, c) => {
            const made = (req.ids ?? ['x']).map((id) => ({ id: String(id), probe: c.probe }));
            new WorldStore(c.db)
                .collection(req.collection)
                .putMany(made.map((m) => ({ id: m.id, value: m })));
            return Promise.resolve(made);
        };
        box = new Box({ root, db: store.path, timeout: 1, synthesize: (r, c) => hook(r, c) });
    });

    afterEach(async () => {
        await box.dispose();
        store.close();
        rmSync(root, { recursive: true, force: true });
    });

    it('runs a TypeScript module, types and all', async () => {
        await box.write(
            'k',
            `
            interface Answer { echoed: string; n: number }
            export default async function handle(req: { query: Record<string, string> }): Promise<Answer> {
                return { echoed: req.query.q, n: 1 as number };
            }`,
        );
        expect(await box.run('k', input({ query: { q: 'hi' } }))).toMatchObject({
            ok: true,
            value: { echoed: 'hi', n: 1 },
        });
    });

    it('runs the newest version of a module it already loaded', async () => {
        await box.write('k', 'export default () => 1;');
        expect((await box.run('k', input())).value).toBe(1);
        await box.write('k', 'export default () => 2;');
        expect((await box.run('k', input())).value).toBe(2);
    });

    it('replaces a module in one step, so a reader never sees it half written', async () => {
        const old = 'export default () => "old";';
        await box.write('k', old);
        // A reader that opened the file before the write must still read the
        // whole old file: the write replaced the file, it did not truncate it.
        const reader = await open(box.sourceOf('k'), 'r');
        try {
            await box.write('k', 'export default () => "new";');
            expect(await reader.readFile('utf8')).toBe(old);
        } finally {
            await reader.close();
        }
        expect((await box.run('k', input())).value).toBe('new');
        expect(readdirSync(dirname(box.sourceOf('k')))).toEqual(['handler.ts']);
    });

    it('turns ctx.fail into a status, not a fault', async () => {
        await box.write(
            'k',
            `export default (req: any, ctx: any) => ctx.fail(404, { error: 'gone' });`,
        );
        expect(await box.run('k', input())).toMatchObject({
            ok: true,
            status: 404,
            value: { error: 'gone' },
        });
    });

    it('reports a throw with its stack', async () => {
        await box.write('k', `export default () => { throw new TypeError('nope'); };`);
        const out = await box.run('k', input());
        expect(out).toMatchObject({ ok: false, fault: 'threw TypeError: nope' });
        expect(out.stderr).toContain('TypeError');
    });

    it('says what a module without a handler is missing', async () => {
        await box.write('k', `export const x = 1;`);
        expect((await box.run('k', input())).fault).toContain(
            'export default async function handle',
        );
    });

    // The whole reason it is a thread: a synchronous loop costs one request.
    it('stops a handler that never returns, and keeps serving', async () => {
        await box.write('loop', 'export default () => { while (true) {} };');
        await box.write('ok', 'export default () => "fine";');
        expect(await box.run('loop', input())).toMatchObject({
            ok: false,
            fault: 'took longer than 1s',
        });
        expect(await box.run('ok', input())).toMatchObject({ ok: true, value: 'fine' });
    });

    it('stops the clock while an agent writes content', async () => {
        hook = async (req) => {
            await new Promise((r) => setTimeout(r, 1500));
            return [{ id: String(req.ids?.[0]) }];
        };
        await box.write(
            'k',
            `export default async (req: any, ctx: any) => (await ctx.synthesize({ collection: 'c', ids: ['a'] }))[0];`,
        );
        expect(await box.run('k', input())).toMatchObject({ ok: true, value: { id: 'a' } });
    });

    it('reads through to the world, and tells the hook when it is a judgement', async () => {
        await box.write('k', `export default (req: any, ctx: any) => ctx.lookup('things', 'a');`);
        const snap = store.snapshot(join(root, 'snap.sqlite'));
        expect((await box.run('k', input(), { db: snap, probe: true })).value).toEqual({
            id: 'a',
            probe: true,
        });
        expect(store.collection('things').count()).toBe(0);
        expect((await box.run('k', input())).value).toEqual({ id: 'a', probe: false });
        expect(store.collection('things').count()).toBe(1);
    });

    // An agent that cannot answer is not a reason to rewrite working code.
    it('marks a failure of the world agent as such', async () => {
        hook = () => Promise.reject(new Error('rate limited'));
        await box.write('k', `export default (req: any, ctx: any) => ctx.lookup('things', 'a');`);
        expect(await box.run('k', input())).toMatchObject({
            ok: false,
            agentFault: true,
            fault: expect.stringContaining('rate limited'),
        });
    });
});
