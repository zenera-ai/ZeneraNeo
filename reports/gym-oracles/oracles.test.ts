import { describe, expect, it } from 'vitest';
import {
    atMost,
    exactKeys,
    notGrowing,
    overlapsWindow,
    positiveInt,
    report,
    sameSet,
    walk,
    type FetchJson,
    type Json,
} from './oracles.ts';

// ---------------------------------------------------------------------------
// The oracles, tested against data with a known answer. No server, no model:
// this file runs in seconds, with no keys. Every relation gets at least one
// case that MUST fail, because a check never seen to fail proves nothing.
// ---------------------------------------------------------------------------

const ids = (...xs: string[]) => xs.map((id) => ({ id }));

const event = (id: string, start: string, end: string) => ({
    id,
    start: { dateTime: start },
    end: { dateTime: end },
});

describe('R1 atMost', () => {
    it('passes at and under the limit', () => {
        expect(atMost(ids('a', 'b'), 2).ok).toBe(true);
        expect(atMost(ids('a'), 2).ok).toBe(true);
    });
    it('fails over the limit and names the ids', () => {
        const v = atMost(ids('a', 'b', 'c'), 2);
        expect(v.ok).toBe(false);
        expect(v.detail).toContain('got 3');
    });
    it('flags an empty list as vacuous, not as evidence', () => {
        expect(atMost([], 5)).toMatchObject({ ok: true, vacuous: true });
    });
});

describe('R2 notGrowing', () => {
    it('passes for a subset', () => {
        expect(notGrowing(ids('a', 'b', 'c'), ids('b')).ok).toBe(true);
    });
    it('fails when the narrower query finds something new', () => {
        const v = notGrowing(ids('a', 'b'), ids('b', 'z'));
        expect(v.ok).toBe(false);
        expect(v.detail).toContain('z');
    });
});

describe('R3 sameSet', () => {
    it('passes for the same ids in any order', () => {
        expect(sameSet(ids('b', 'a'), ids('a', 'b')).ok).toBe(true);
    });
    it('fails on a missing id', () => {
        expect(sameSet(ids('a'), ids('a', 'b')).detail).toContain('missing from pages: b');
    });
    it('fails on an extra id', () => {
        expect(sameSet(ids('a', 'x'), ids('a')).detail).toContain('only in pages: x');
    });
    it('fails on an id repeated across pages', () => {
        expect(sameSet(ids('a', 'a'), ids('a')).detail).toContain('repeated');
    });
});

describe('R4 overlapsWindow', () => {
    const lo = '2026-11-16T00:00:00Z';
    const hi = '2026-11-23T00:00:00Z';
    it('passes for events inside or straddling the window', () => {
        const v = overlapsWindow(
            [
                event('inside', '2026-11-17T09:00:00Z', '2026-11-17T10:00:00Z'),
                event('straddles-start', '2026-11-15T23:00:00Z', '2026-11-16T01:00:00Z'),
                event('straddles-end', '2026-11-22T23:00:00Z', '2026-11-23T01:00:00Z'),
            ],
            lo,
            hi,
        );
        expect(v.ok, v.detail).toBe(true);
    });
    it('fails for an event ending exactly at timeMin (bounds are exclusive)', () => {
        const v = overlapsWindow([event('edge', '2026-11-15T23:00:00Z', lo)], lo, hi);
        expect(v.ok).toBe(false);
    });
    it('fails for an event starting exactly at timeMax', () => {
        const v = overlapsWindow([event('edge', hi, '2026-11-23T01:00:00Z')], lo, hi);
        expect(v.ok).toBe(false);
    });
    it('fails for an event with no parseable time instead of skipping it', () => {
        const v = overlapsWindow([{ id: 'broken', start: {}, end: {} }], lo, hi);
        expect(v.detail).toContain('unparseable');
    });
    it('compares instants, not strings, across time zones', () => {
        // 10:00 Berlin (UTC+1 in November) is 09:00Z — inside a window that opens at 08:30Z.
        const v = overlapsWindow(
            [event('berlin', '2026-11-17T10:00:00+01:00', '2026-11-17T10:30:00+01:00')],
            '2026-11-17T08:30:00Z',
            '2026-11-17T09:15:00Z',
        );
        expect(v.ok, v.detail).toBe(true);
    });
});

describe('R5 exactKeys', () => {
    it('passes for exactly the ids asked', () => {
        expect(exactKeys({ a: { busy: [] }, b: { busy: [] } }, ['b', 'a']).ok).toBe(true);
    });
    it('fails when an id is missing', () => {
        expect(exactKeys({ a: { busy: [] } }, ['a', 'b']).detail).toContain('missing: b');
    });
    it('fails when an id was not asked for', () => {
        expect(exactKeys({ a: {}, z: {} }, ['a']).detail).toContain('not asked for: z');
    });
    it('fails when calendars is not an object', () => {
        expect(exactKeys([], ['a']).ok).toBe(false);
    });
});

// --- walk(): the three ways it must stop on its own -------------------------

/** A stub server: page N answers with pages[N]. Records every URL it was asked for. */
function stub(pages: Json[]): FetchJson & { calls: string[] } {
    const calls: string[] = [];
    const f = (async (url: string) => {
        calls.push(url);
        const token = new URL(url).searchParams.get('pageToken');
        const index = token === null ? 0 : Number(token.replace(/\D/g, '')) || 0;
        return pages[Math.min(index, pages.length - 1)]!;
    }) as FetchJson & { calls: string[] };
    f.calls = calls;
    return f;
}

describe('walk', () => {
    const url = 'http://stub.test/list';

    it('stops at the end and returns every item', async () => {
        const f = stub([
            { items: ids('a', 'b'), nextPageToken: 't1' },
            { items: ids('c'), nextPageToken: 't2' },
            { items: ids('d') },
        ]);
        const w = await walk(url, 'items', { fetch: f });
        expect(w).toMatchObject({ stop: 'end', pages: 3 });
        expect(w.items.map((x) => (x as { id: string }).id)).toEqual(['a', 'b', 'c', 'd']);
    });

    it('stops when the server hands back the token it was sent', async () => {
        const f = stub([
            { items: ids('a'), nextPageToken: 't1' },
            { items: ids('b'), nextPageToken: 't1' },
        ]);
        expect((await walk(url, 'items', { fetch: f })).stop).toBe('repeated-token');
    });

    it('stops when a token from earlier in the walk comes back', async () => {
        const f = stub([
            { items: ids('a'), nextPageToken: 't1' },
            { items: ids('b'), nextPageToken: 't2' },
            { items: ids('c'), nextPageToken: 't1' },
        ]);
        expect((await walk(url, 'items', { fetch: f })).stop).toBe('seen-token');
    });

    it('stops at the page cap on a server that never ends', async () => {
        let n = 0;
        const endless: FetchJson = async () => ({ items: ids(`x${n}`), nextPageToken: `t${++n}` });
        const w = await walk(url, 'items', { fetch: endless, maxPages: 4 });
        expect(w).toMatchObject({ stop: 'page-cap', pages: 4 });
    });

    it('treats a missing items array as an empty page, not a crash (listLabels-style end)', async () => {
        const w = await walk(url, 'items', { fetch: stub([{}]) });
        expect(w).toMatchObject({ stop: 'end', pages: 1, items: [] });
    });

    it('rejects an items field that is not an array', async () => {
        await expect(walk(url, 'items', { fetch: stub([{ items: 'nope' }]) })).rejects.toThrow(
            /not an array/,
        );
    });
});

describe('report', () => {
    it('computes a pass rate per relation and shows the first failure', () => {
        const md = report(
            [
                { relation: 'R1', case: 'n=1', run: 1, verdict: atMost(ids('a'), 1) },
                { relation: 'R1', case: 'n=1', run: 2, verdict: atMost(ids('a', 'b'), 1) },
            ],
            { seed: '42' },
        );
        expect(md).toContain('| R1 | 2 | 1 | 50% | 0 |');
        expect(md).toContain('got 2');
    });
});

describe('positiveInt', () => {
    it('uses the fallback when unset and accepts a positive integer', () => {
        expect(positiveInt('N', undefined, 3)).toBe(3);
        expect(positiveInt('N', '5', 3)).toBe(5);
    });
    it('rejects values that would run a case zero times or never stop', () => {
        for (const raw of ['', ' ', '0', '-1', '2.5', 'abc', 'Infinity', 'NaN']) {
            expect(() => positiveInt('N', raw, 3), raw).toThrow(/positive integer/);
        }
    });
});

describe('report table cells', () => {
    it('keeps a detail with line breaks on one table row', () => {
        const md = report(
            [
                {
                    relation: 'R1',
                    case: 'n=1',
                    run: 1,
                    verdict: {
                        ok: false,
                        vacuous: false,
                        detail: 'error: 500\n<html>\r\nboom</html>',
                    },
                },
            ],
            {},
        );
        const rows = md.split('\n').filter((l) => l.startsWith('| R1 '));
        expect(rows).toHaveLength(2); // summary row + every-trial row, each on one line
        expect(rows.every((r) => r.includes('error: 500 <html> boom</html>'))).toBe(true);
    });
});
