import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MAX_PAGES, pagesFor, parsePages } from '../src/command.ts';
import { PaginationLimiter, type Paging } from '../src/paging.ts';
import { page, type LongList, type PageOptions } from '../src/runtime.ts';
import { longListOf } from '../src/server.ts';
import { loadSpec, type Operation } from '../src/spec.ts';

// ---------------------------------------------------------------------------
// One operation, a list of a chosen length (`zen gym serve --pages op=200`)
//
// What is pinned: the list runs to exactly the pages asked for, the token
// strictly advances and never repeats, the last page ends it, every page is
// made from the request alone, the backstop still guards it, and no operation's
// cache key moves.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const load = async (name: string): Promise<Operation[]> =>
    loadSpec(join(here, 'specs', `${name}.yaml`));

const MACHINES = [
    { id: 'm-a', name: 'a' },
    { id: 'm-b', name: 'b' },
    { id: 'm-c', name: 'c' },
];

/** Walks a list the way a client does, page after page, until it says it ended. */
function walk<T>(
    items: readonly T[],
    long: LongList,
    first: PageOptions = {},
    turn: (next: { token: string | null; offset: number | null }) => PageOptions = (n) => ({
        token: n.token,
    }),
): { pages: T[][]; tokens: string[] } {
    const pages: T[][] = [];
    const tokens: string[] = [];
    let options: PageOptions = first;
    for (let guard = 0; guard < long.pages + 5; guard++) {
        const p = page(items, options, long);
        pages.push(p.items);
        if (!p.hasMore) {
            expect(p.nextToken).toBeNull();
            expect(p.nextOffset).toBeNull();
            return { pages, tokens };
        }
        tokens.push(p.nextToken!);
        options = { ...first, ...turn({ token: p.nextToken, offset: p.nextOffset }) };
    }
    throw new Error('the list never ended');
}

describe('a stretched list', () => {
    const long: LongList = { pages: 200, id: 'suffix' };

    it('runs to exactly the pages asked for, each one full', () => {
        const { pages } = walk(MACHINES, long, { size: 5 });
        expect(pages).toHaveLength(200);
        expect(pages.every((p) => p.length === 5)).toBe(true);
    });

    it('hands out a token that strictly advances and never repeats', () => {
        const { tokens } = walk(MACHINES, long);
        expect(tokens).toHaveLength(199);
        expect(new Set(tokens).size).toBe(199);
        const offsets = tokens.map(
            (t) => JSON.parse(Buffer.from(t, 'base64url').toString('utf8')).o as number,
        );
        expect(offsets.every((o, i) => i === 0 || o > offsets[i - 1]!)).toBe(true);
    });

    it('tells every item apart, and keeps the real ones as they are', () => {
        const { pages } = walk(MACHINES, long);
        const ids = pages.flat().map((m) => m.id);
        expect(ids).toHaveLength(2000);
        expect(new Set(ids).size).toBe(2000);
        expect(pages[0]!.slice(0, 3)).toEqual(MACHINES);
        expect(pages[0]![3]).toEqual({ id: 'm-a-1', name: 'a' });
    });

    // Nothing is kept between requests: a page is a function of the request.
    it('answers any page the same way, asked cold', () => {
        const { tokens } = walk(MACHINES, long);
        const again = page(MACHINES, { token: tokens[120] }, long);
        const fresh = page([...MACHINES], { token: tokens[120] }, { ...long });
        expect(again).toEqual(fresh);
        expect(again.items[0]!.id).toBe(`m-${'abc'[1210 % 3]}-${Math.floor(1210 / 3)}`);
    });

    it('pages by offset too', () => {
        const { pages } = walk(MACHINES, { pages: 50, id: 'suffix' }, { size: 4 }, (n) => ({
            offset: n.offset,
        }));
        expect(pages).toHaveLength(50);
    });

    it('never touches the items it was handed', () => {
        const before = structuredClone(MACHINES);
        walk(MACHINES, long);
        expect(MACHINES).toEqual(before);
    });

    // A filter that matched nothing is an empty list, not two hundred pages of something.
    it('leaves an empty list empty', () => {
        const p = page([], {}, long);
        expect(p).toMatchObject({ items: [], hasMore: false, nextToken: null, total: 0 });
    });

    it('ends a token it cannot read, rather than starting over', () => {
        expect(page(MACHINES, { token: 'nonsense' }, long)).toMatchObject({
            items: [],
            hasMore: false,
        });
    });

    it('makes a different, valid uuid for each copy', () => {
        const uuids = [{ id: '3f2b8c1e-9a4d-4e6f-8b7a-0c1d2e3f4a5b' }];
        const { pages } = walk(uuids, { pages: 30, id: 'uuid' }, { size: 1 });
        const ids = pages.flat().map((u) => u.id);
        expect(new Set(ids).size).toBe(30);
        expect(ids.every((id) => /^3f2b8c1e-9a4d-4e6f-8b7a-[0-9a-f]{12}$/.test(id))).toBe(true);
    });

    it('moves an integer id past every real one', () => {
        const rows = [{ id: 1 }, { id: 7 }];
        const ids = walk(rows, { pages: 10, id: 'number' }, { size: 2 })
            .pages.flat()
            .map((r) => r.id);
        expect(new Set(ids).size).toBe(20);
        expect(ids.slice(0, 4)).toEqual([1, 7, 9, 15]);
    });

    it('leaves an id alone when the schema has no room to change it', () => {
        const ids = walk(MACHINES, { pages: 3, id: 'keep' }, { size: 3 })
            .pages.flat()
            .map((m) => m.id);
        expect(ids).toEqual(['m-a', 'm-b', 'm-c', 'm-a', 'm-b', 'm-c', 'm-a', 'm-b', 'm-c']);
    });

    it('is the ordinary rule when nothing is stretched', () => {
        expect(page(MACHINES, { size: 2 })).toMatchObject({ total: 3, hasMore: true });
        expect(page(MACHINES, { size: 2 }, undefined)).toEqual(page(MACHINES, { size: 2 }));
    });
});

// ---------------------------------------------------------------------------
// The backstop still stands
// ---------------------------------------------------------------------------

describe('the backstop over a stretched list', () => {
    const paging: Paging = {
        style: 'cursor',
        param: 'cursor',
        next: 'cursor',
        nextNullable: true,
        nextRequired: false,
        more: 'has_more',
        items: 'results',
    };
    const long: LongList = { pages: 200, id: 'suffix' };
    const body = (token?: string) => {
        const p = page(MACHINES, { token }, long);
        return { results: p.items, cursor: p.nextToken, has_more: p.hasMore };
    };

    it('lets all of it through, the last page included, and cuts nothing', () => {
        // A random limit of 2 for everything else; this operation says 200.
        const limiter = new PaginationLimiter(2);
        let sent: string | undefined;
        for (let n = 1; n <= 200; n++) {
            const b = body(sent);
            expect(limiter.process('op', 'client', sent, b, paging, 200)).toBeUndefined();
            if (n < 200) {
                expect(b.cursor).not.toBeNull();
                sent = b.cursor!;
            } else {
                expect(b).toMatchObject({ cursor: null, has_more: false });
                expect(b.results).toHaveLength(10);
            }
        }
    });

    it('still cuts a handler that will not stop, at the length asked for', () => {
        const limiter = new PaginationLimiter(2);
        let sent: string | undefined;
        let cut;
        for (let n = 1; n <= 200 && !cut; n++) {
            const b = { results: [n], cursor: `t${n}`, has_more: true };
            cut = limiter.process('op', 'client', sent, b, paging, 200);
            sent = b.cursor ?? undefined;
            if (cut) {
                expect(n).toBe(200);
            }
        }
        expect(cut).toEqual({ cut: true, reason: 'cut pagination at max pages (200)' });
    });

    it('still cuts a token that comes straight back', () => {
        const limiter = new PaginationLimiter(2);
        const first = body();
        limiter.process('op', 'client', undefined, first, paging, 200);
        const echo = { results: [], cursor: first.cursor, has_more: true };
        expect(limiter.process('op', 'client', first.cursor!, echo, paging, 200)).toEqual({
            cut: true,
            reason: 'cut a looping page token',
        });
    });

    // ctx.page mints the same offset tokens for every list.
    it('keeps two lists that share tokens apart', () => {
        const limiter = new PaginationLimiter(3);
        let long200: string | undefined;
        let short3: string | undefined;
        let shortCut;
        for (let n = 1; n <= 200; n++) {
            const a = body(long200);
            expect(limiter.process('long', 'long:c', long200, a, paging, 200)).toBeUndefined();
            long200 = a.cursor ?? undefined;
            if (!shortCut) {
                const b = body(short3);
                shortCut = limiter.process('short', 'short:c', short3, b, paging);
                short3 = b.cursor ?? undefined;
            }
        }
        expect(long200).toBeUndefined();
        expect(shortCut).toEqual({ cut: true, reason: 'cut pagination at max pages (3)' });
    });
});

// ---------------------------------------------------------------------------
// Asking for it, and what it leaves alone
// ---------------------------------------------------------------------------

describe('--pages', () => {
    it('reads one or more operationId=n', () => {
        expect(parsePages(['listMachines=200', 'listEvents=3'])).toEqual({
            listMachines: 200,
            listEvents: 3,
        });
        expect(parsePages(undefined)).toBeUndefined();
    });

    it.each([
        'listMachines',
        'listMachines=',
        'listMachines=0',
        '=5',
        'a=1.5',
        `a=${MAX_PAGES + 1}`,
    ])('refuses %s', (raw) => {
        expect(() => parsePages([raw])).toThrow(/--pages wants <operationId>=<n>/);
    });

    it('refuses the same operation twice', () => {
        expect(() => parsePages(['a=1', 'a=2'])).toThrow(/names a twice/);
    });

    it('refuses an operation that does not exist, or does not page', async () => {
        const ops = await load('paged');
        expect(pagesFor({ listMachines: 200 }, ops)).toEqual({ listMachines: 200 });
        expect(() => pagesFor({ listMachine: 200 }, ops)).toThrow(/no loaded spec defines/);
        expect(() => pagesFor({ listTags: 200 }, ops)).toThrow(/declares no paging parameter/);
    });

    it('reads how ids may change off the response schema', async () => {
        const ops = new Map((await load('paged')).map((o) => [o.operationId, o]));
        expect(longListOf(ops.get('listMachines')!, { listMachines: 200 })).toEqual({
            pages: 200,
            id: 'suffix',
        });
        expect(longListOf(ops.get('listEvents')!, { listMachines: 200 })).toBeUndefined();
        expect(longListOf(ops.get('listMachines')!, undefined)).toBeUndefined();
    });

    // The pins in paging.test.ts stay as they are; this says why they must.
    it('moves no cache key, the stretched operation’s included', async () => {
        for (const spec of ['paged', 'petstore']) {
            const ops = await load(spec);
            const before = ops.map((o) => [o.operationId, o.key]);
            const paged = ops.filter((o) => o.paging).map((o) => o.operationId);
            const asked = Object.fromEntries(paged.map((id) => [id, 200]));
            if (paged.length) {
                pagesFor(asked, ops);
            }
            for (const o of ops) {
                longListOf(o, asked);
            }
            expect(ops.map((o) => [o.operationId, o.key])).toEqual(before);
            expect((await load(spec)).map((o) => [o.operationId, o.key])).toEqual(before);
        }
    });
});
