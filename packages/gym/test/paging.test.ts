import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cutLoop, PaginationLimiter, pagingSeen, tokenOf, type Paging } from '../src/paging.ts';
import { loadSpec, type Operation } from '../src/spec.ts';

const here = dirname(fileURLToPath(import.meta.url));

const load = async (name: string): Promise<Map<string, Operation>> => {
    const ops = await loadSpec(join(here, 'specs', `${name}.yaml`));
    return new Map(ops.map((o) => [o.operationId, o]));
};

describe('recognising a paged operation', () => {
    it('finds the cursor, the size, the token and the items', async () => {
        const op = (await load('paged')).get('listMachines')!;
        expect(op.paging).toEqual({
            style: 'cursor',
            param: 'cursor',
            size: 'page_size',
            next: 'cursor',
            nextNullable: true,
            nextRequired: false,
            more: 'has_more',
            items: 'results',
        });
    });

    it('reads an offset style, and camelCase, as the same thing', async () => {
        const op = (await load('paged')).get('listEvents')!;
        expect(op.paging?.style).toBe('offset');
        expect(op.paging?.param).toBe('offset');
        expect(op.paging?.size).toBe('limit');
        expect(op.paging?.next).toBe('next_offset');
        expect(op.paging?.more).toBe('hasMore');
        expect(op.paging?.items).toBe('data');
    });

    it('finds the cursor when declared in the request body', async () => {
        const op = (await load('paged')).get('collectAuditLogs')!;
        expect(op.paging).toEqual({
            style: 'cursor',
            param: 'cursor',
            paramIn: 'body',
            size: 'page_size',
            next: 'cursor',
            nextNullable: true,
            nextRequired: false,
            more: 'has_more',
            items: 'results',
        });
    });

    // A cap on how much comes back is not an invitation to come back.
    it('does not call a bare `limit` pagination', async () => {
        const op = (await load('paged')).get('listTags')!;
        expect(op.paging).toBeUndefined();
    });

    it('leaves an operation with no query controls alone', async () => {
        const op = (await load('petstore')).get('getUserById')!;
        expect(op.paging).toBeUndefined();
    });

    // The parameter is missing from the document, so nothing static can see it.
    it('says nothing about an operation whose paging parameter is undeclared', async () => {
        const op = (await load('paged')).get('listAlarms')!;
        expect(op.paging).toBeUndefined();
    });

    // Pinned, so a change to what goes into a key is a decision rather than an
    // accident: every pin moving means every cached handler is rebuilt.
    it('pins the cache keys for CONTRACT_VERSION = 4', async () => {
        const ops = await load('petstore');
        expect(ops.get('getUserById')!.key).toBe('3a108d9dbb5e7c1b');
        expect(ops.get('createUser')!.key).toBe('0e659fe12f76bcf4');
        expect((await load('paged')).get('listTags')!.key).toBe('f7b26c53bc752f82');
    });
});

describe('cutting a looping token', () => {
    const paging: Paging = {
        style: 'cursor',
        param: 'cursor',
        next: 'cursor',
        nextNullable: true,
        nextRequired: false,
        more: 'has_more',
        items: 'results',
    };

    it('reads the token out of a nested envelope', () => {
        expect(tokenOf({ page: { cursor: 'abc' } }, paging)).toBe('abc');
        expect(tokenOf({ page: { cursor: null } }, paging)).toBeUndefined();
        expect(tokenOf({ page: {} }, paging)).toBeUndefined();
    });

    it('nulls a token that came straight back, and says the pages ended', () => {
        const body = { results: [], cursor: '8fde793b', has_more: true };
        expect(cutLoop(body, paging, '8fde793b')).toBe(true);
        expect(body).toEqual({ results: [], cursor: null, has_more: false });
    });

    it('leaves a token that advanced alone', () => {
        const body = { results: [], cursor: 'page-2', has_more: true };
        expect(cutLoop(body, paging, 'page-1')).toBe(false);
        expect(body.cursor).toBe('page-2');
    });

    it('drops an optional token that cannot be nulled', () => {
        const optional: Paging = { ...paging, nextNullable: false };
        const body: Record<string, unknown> = { results: [], cursor: 'x' };
        expect(cutLoop(body, optional, 'x')).toBe(true);
        expect('cursor' in body).toBe(false);
    });

    // Nothing re-validates a handler's output on the way out, so a required
    // non-nullable property is left as it is: a hang is better than a lie.
    it('will not break the schema to break the loop', async () => {
        const op = (await load('paged')).get('listEvents')!;
        const body = { data: [], next_offset: 40 };
        expect(cutLoop(body, op.paging!, '40')).toBe(false);
        expect(body.next_offset).toBe(40);
    });
});

describe('paging the document never declared', () => {
    const query = (search: string): URLSearchParams => new URLSearchParams(search);

    it('takes the parameter from the request when the document has none', async () => {
        const op = (await load('paged')).get('listAlarms')!;
        expect(pagingSeen(op.params, op.success.schema, query('cursor=eyJwIjoyfQ=='))).toEqual({
            style: 'cursor',
            param: 'cursor',
            size: undefined,
            next: 'cursor',
            nextNullable: true,
            nextRequired: false,
            more: undefined,
            items: 'results',
        });
    });

    it('detects paging when cursor is sent in the request body', async () => {
        const op = (await load('paged')).get('listAlarms')!;
        expect(
            pagingSeen(op.params, op.success.schema, query(''), { cursor: 'eyJwIjoyfQ==' }),
        ).toEqual({
            style: 'cursor',
            param: 'cursor',
            paramIn: 'body',
            size: undefined,
            next: 'cursor',
            nextNullable: true,
            nextRequired: false,
            more: undefined,
            items: 'results',
        });
    });

    it('asks nothing of a request that carries no extra parameter', async () => {
        const op = (await load('paged')).get('listAlarms')!;
        expect(pagingSeen(op.params, op.success.schema, query(''))).toBeUndefined();
    });

    // The word has to mean paging in the response too, or every stray query
    // parameter with a familiar name becomes a page turn.
    it('does not invent paging out of an unrelated parameter', async () => {
        const op = (await load('paged')).get('listTags')!;
        expect(pagingSeen(op.params, op.success.schema, query('cursor=abc'))).toBeUndefined();
    });
});

describe('PaginationLimiter', () => {
    const paging: Paging = {
        style: 'cursor',
        param: 'cursor',
        next: 'cursor',
        nextNullable: true,
        nextRequired: false,
        more: 'has_more',
        items: 'results',
    };

    it('cuts a 1-page stream immediately on the first page', () => {
        const limiter = new PaginationLimiter(1);
        const body = { results: ['a'], cursor: 'token-2', has_more: true };
        const result = limiter.process('op1', 'client1', undefined, body, paging);
        expect(result).toEqual({ cut: true, reason: 'cut pagination at max pages (1)' });
        expect(body.cursor).toBeNull();
        expect(body.has_more).toBe(false);
    });

    it('allows pages until maxPages is reached, then terminates', () => {
        const limiter = new PaginationLimiter(3);
        // Page 1 (initial request, no cursor sent)
        const p1 = { results: ['a'], cursor: 't1', has_more: true };
        expect(limiter.process('op1', 'c1', undefined, p1, paging)).toBeUndefined();
        expect(p1.cursor).toBe('t1');

        // Page 2
        const p2 = { results: ['b'], cursor: 't2', has_more: true };
        expect(limiter.process('op1', 'c1', 't1', p2, paging)).toBeUndefined();
        expect(p2.cursor).toBe('t2');

        // Page 3 (hits maxPages = 3)
        const p3 = { results: ['c'], cursor: 't3', has_more: true };
        const cut = limiter.process('op1', 'c1', 't2', p3, paging);
        expect(cut).toEqual({ cut: true, reason: 'cut pagination at max pages (3)' });
        expect(p3.cursor).toBeNull();
        expect(p3.has_more).toBe(false);

        // Page 4 (client continues calling in a while True loop with terminated cursor)
        const p4 = { results: ['d'], cursor: 't4', has_more: true };
        const empty = limiter.process('op1', 'c1', 't2', p4, paging);
        expect(empty).toEqual({ cut: true, reason: 'cut pagination at max pages (3)' });
        expect(p4.results).toEqual([]);
    });

    it('cuts cycling page tokens', () => {
        const limiter = new PaginationLimiter(10);
        const p1 = { results: ['a'], cursor: 'A', has_more: true };
        limiter.process('op1', 'c1', undefined, p1, paging);

        const p2 = { results: ['b'], cursor: 'B', has_more: true };
        limiter.process('op1', 'c1', 'A', p2, paging);

        // Server returns A again (cycle!)
        const p3 = { results: ['c'], cursor: 'A', has_more: true };
        const cut = limiter.process('op1', 'c1', 'B', p3, paging);
        expect(cut).toEqual({ cut: true, reason: 'cut a cycling page token' });
        expect(p3.cursor).toBeNull();
    });

    it('cuts when base64 cursor index reaches maxPages', () => {
        const limiter = new PaginationLimiter(5);
        const tokenP5 = Buffer.from(JSON.stringify({ p: 5 })).toString('base64');
        const body = { results: ['e'], cursor: 'next-p6', has_more: true };
        const cut = limiter.process('op1', 'c1', tokenP5, body, paging);
        expect(cut).toEqual({ cut: true, reason: 'cut pagination at max pages (5)' });
        expect(body.cursor).toBeNull();
    });

    it('supports 1000 consecutive pages without premature termination', () => {
        const limiter = new PaginationLimiter(1000);

        for (let page = 1; page <= 1000; page++) {
            const currentToken = page === 1 ? undefined : `token-${page}`;

            const body = {
                results: [`item-${page}`],
                cursor: `token-${page + 1}` as string | null,
                has_more: true,
            };

            const result = limiter.process('long-list', 'client-1', currentToken, body, paging);

            if (page < 1000) {
                expect(result).toBeUndefined();
                expect(body.cursor).toBe(`token-${page + 1}`);
                expect(body.has_more).toBe(true);
            } else {
                expect(result).toEqual({
                    cut: true,
                    reason: 'cut pagination at max pages (1000)',
                });
                expect(body.cursor).toBeNull();
                expect(body.has_more).toBe(false);
            }
        }
    });

    it('isolates identical cursors across operations and streams', () => {
        const limiter = new PaginationLimiter((operationKey) =>
            operationKey === 'machines' ? 200 : 2,
        );

        // Both operations produce the same continuation token.
        const machines1 = {
            results: ['machine-1'],
            cursor: '2' as string | null,
            has_more: true,
        };

        const audit1 = {
            results: ['audit-1'],
            cursor: '2' as string | null,
            has_more: true,
        };

        expect(
            limiter.process('machines', 'client-1', undefined, machines1, paging),
        ).toBeUndefined();

        expect(limiter.process('audit', 'client-1', undefined, audit1, paging)).toBeUndefined();

        // The machine stream must retain its 200-page limit.
        const machines2 = {
            results: ['machine-2'],
            cursor: '3' as string | null,
            has_more: true,
        };

        expect(limiter.process('machines', 'client-1', '2', machines2, paging)).toBeUndefined();

        expect(machines2.cursor).toBe('3');

        // The audit stream must independently stop on page 2.
        const audit2 = {
            results: ['audit-2'],
            cursor: '3' as string | null,
            has_more: true,
        };

        expect(limiter.process('audit', 'client-1', '2', audit2, paging)).toMatchObject({
            cut: true,
            reason: 'cut pagination at max pages (2)',
        });

        expect(audit2.cursor).toBeNull();

        // A different client must not inherit an existing stream's state.
        const otherClient1 = {
            results: ['machine-A'],
            cursor: '2' as string | null,
            has_more: true,
        };

        expect(
            limiter.process('machines', 'client-2', undefined, otherClient1, paging),
        ).toBeUndefined();

        const otherClient2 = {
            results: ['machine-B'],
            cursor: '3' as string | null,
            has_more: true,
        };

        expect(limiter.process('machines', 'client-2', '2', otherClient2, paging)).toBeUndefined();

        expect(otherClient2.cursor).toBe('3');
    });
});
