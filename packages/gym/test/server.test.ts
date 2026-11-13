import { Cache as Store } from '@zenera/cli/lib';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GYM_KIND } from '../src/cache.ts';
import { Router } from '../src/router.ts';
import { listen, type Listening, type ServerOptions } from '../src/server.ts';
import {
    call,
    CREATE_USER,
    GET_SELF,
    GET_USER,
    idsAsked,
    rig,
    say,
    scripted,
    STOP_PING,
    writes,
    type Rig,
    type Script,
    type Scripted,
} from './helpers.ts';

// ---------------------------------------------------------------------------
// The HTTP layer, over handlers that are already cached
//
// Nothing here writes a handler unless the test is about writing one: the
// handlers are put in the cache first, as if an earlier run had written them,
// so each test is about what the server does with what a handler answers.
// ---------------------------------------------------------------------------

/** A world agent that makes users and the owner account, and counts itself. */
const people: Script = (turn) => {
    if (turn.results.some((r) => r.name === 'save_records')) {
        return say('done');
    }
    if (turn.brief.includes('`accounts`')) {
        return call('save_records', {
            records: [{ id: '@me', email: 'alex@northwind.io', displayName: 'Alex' }],
        });
    }
    return call('save_records', {
        records: idsAsked(turn.brief).map((id) => ({
            user_id: Number(id),
            email: `user${id}@northwind.io`,
        })),
    });
};

interface Booted {
    r: Rig;
    model: Scripted;
    live: Listening;
    base: string;
    log: string[];
}

async function boot(
    file: string,
    handlers: Record<string, string>,
    opts: {
        world?: Script;
        builder?: Script;
        server?: Partial<ServerOptions>;
        attempts?: number;
    } = {},
): Promise<Booted> {
    const model = scripted({ world: opts.world ?? people, builder: opts.builder });
    const r = await rig(file, model, { attempts: opts.attempts ?? 1 });
    const store = new Store(GYM_KIND, { dir: join(r.root, 'store') });
    for (const o of r.operations) {
        if (handlers[o.operationId]) {
            store.put(o.key, { source: handlers[o.operationId], meta: { model: 'stub' } });
        }
    }
    const log: string[] = [];
    const live = await listen(
        {
            router: new Router(r.operations),
            checks: r.checks,
            box: r.box,
            cache: r.cache,
            seed: 7,
            onRequest: (line) => log.push(line),
            ...opts.server,
        },
        '127.0.0.1',
        0,
    );
    return { r, model, live, base: `http://127.0.0.1:${live.port}`, log };
}

const PETSTORE = {
    getUserById: GET_USER,
    getSelf: GET_SELF,
    createUser: CREATE_USER,
    stopPing: STOP_PING,
};

describe('the server', () => {
    let b: Booted | undefined;
    afterEach(async () => {
        await b?.live.close();
        await b?.r.close();
        b = undefined;
    });

    it('answers from the world, made up on first read and kept', async () => {
        b = await boot('petstore.yaml', PETSTORE);
        const first = await fetch(`${b.base}/users/12324`);
        expect(first.status).toBe(200);
        expect(await first.json()).toEqual({ user_id: 12324, email: 'user12324@northwind.io' });
        expect(b.model.world.length).toBeGreaterThan(0);

        const asked = b.model.world.length;
        expect(await (await fetch(`${b.base}/users/12324`)).json()).toEqual({
            user_id: 12324,
            email: 'user12324@northwind.io',
        });
        expect(b.model.world).toHaveLength(asked);
    });

    it('lets a write be read back', async () => {
        b = await boot('petstore.yaml', PETSTORE);
        const made = await fetch(`${b.base}/users`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ user_id: 5, email: 'new@northwind.io' }),
        });
        expect(made.status).toBe(201);
        expect(await (await fetch(`${b.base}/users/5`)).json()).toEqual({
            user_id: 5,
            email: 'new@northwind.io',
        });
        expect(b.model.world).toHaveLength(0);
    });

    it('resolves the caller to the account the world says it is', async () => {
        b = await boot('petstore.yaml', PETSTORE);
        expect(await (await fetch(`${b.base}/users/me`)).json()).toEqual({
            user_id: 1,
            email: 'alex@northwind.io',
        });
    });

    it('runs the handler of an operation with no body, and answers 204', async () => {
        b = await boot('petstore.yaml', PETSTORE);
        const res = await fetch(`${b.base}/ping`, { method: 'DELETE' });
        expect(res.status).toBe(204);
        expect(await res.text()).toBe('');
        expect(b.r.store.collection('pings').has('stopped')).toBe(true);
    });

    it('reports whether the handler came out of the cache', async () => {
        b = await boot('petstore.yaml', PETSTORE);
        const res = await fetch(`${b.base}/users/1`);
        expect(res.headers.get('x-gym-cache')).toBe('hit');
        expect(res.headers.get('x-gym-operation')).toBe('getUserById');
    });

    it('rejects a path parameter of the wrong type before running anything', async () => {
        b = await boot('petstore.yaml', PETSTORE);
        const res = await fetch(`${b.base}/users/not-a-number`);
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ issues: [{ where: 'path/user_id' }] });
    });

    it('404s an unknown path and 405s a known one', async () => {
        b = await boot('petstore.yaml', PETSTORE);
        expect((await fetch(`${b.base}/nope`)).status).toBe(404);
        const wrong = await fetch(`${b.base}/users`, { method: 'PUT' });
        expect(wrong.status).toBe(405);
        expect(wrong.headers.get('allow')).toBe('POST');
    });

    it('passes on an error the handler chose to answer with', async () => {
        b = await boot('petstore.yaml', {
            ...PETSTORE,
            getUserById: `export default (req: any, ctx: any) => ctx.fail(404, { error: 'no such user' });`,
        });
        const res = await fetch(`${b.base}/users/3`);
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'no such user' });
    });

    // The handler's request can be quoted to the world agent, so this is the
    // test about what does *not* travel.
    it('keeps credentials out of what the handler sees', async () => {
        b = await boot('petstore.yaml', {
            ...PETSTORE,
            getUserById: `
export default (req: any, ctx: any) => {
    ctx.db.collection('seen').put('h', { id: 'h', headers: req.headers });
    return { user_id: Number(req.pathParams.user_id), email: 'a@b.com' };
};`,
        });
        await fetch(`${b.base}/users/1`, {
            headers: {
                authorization: 'Bearer nope',
                cookie: 'session=1',
                'x-api-key': 'nope',
                'accept-language': 'en-GB',
            },
        });
        const headers = (
            b.r.store.collection('seen').get('h') as { headers: Record<string, string> }
        ).headers;
        expect(headers['accept-language']).toBe('en-GB');
        expect(headers.authorization).toBeUndefined();
        expect(headers.cookie).toBeUndefined();
        expect(headers['x-api-key']).toBeUndefined();
    });

    it('seeds the same request the same way when a base seed is set', async () => {
        b = await boot('petstore.yaml', {
            ...PETSTORE,
            getUserById: `export default (req: any) => ({ user_id: Number(req.pathParams.user_id), email: 's' + req.seed + '@x.io' });`,
        });
        const email = async (id: number) =>
            ((await (await fetch(`${b!.base}/users/${id}`)).json()) as { email: string }).email;
        expect(await email(12324)).toBe(await email(12324));
        expect(await email(999)).not.toBe(await email(12324));
    });

    // The world agent failed, not the handler: rewriting working code cannot
    // bring a provider back.
    it('falls back to sampled content when the world agent fails, and never rewrites the handler', async () => {
        b = await boot('petstore.yaml', PETSTORE, {
            world: () => {
                throw new Error('provider down');
            },
            builder: () => {
                throw new Error('the builder must not be asked');
            },
        });
        const res = await fetch(`${b.base}/users/77`);
        // With the agent down, sampled records stand in rather than failing the request.
        expect(res.status).toBe(200);
        expect(b.model.builder).toHaveLength(0);
        expect(b.log.join('\n')).not.toContain('[REGENERATING]');
    });

    it('lists what it serves, and is healthy', async () => {
        b = await boot('petstore.yaml', PETSTORE);
        expect(((await (await fetch(`${b.base}/__gym/routes`)).json()) as unknown[]).length).toBe(
            4,
        );
        expect(await (await fetch(`${b.base}/__gym/health`)).json()).toEqual({
            ok: true,
            operations: 4,
        });
    });

    it('answers the root with a contents page with a Run button per operation', async () => {
        b = await boot('petstore.yaml', PETSTORE);
        const page = await (await fetch(`${b.base}/`)).text();
        expect(page).toContain('<title>Zenera Gym</title>');
        expect(page).toContain('/users/{user_id}');
        expect(page.match(/class="try" data-op="\d+"/g)).toHaveLength(4);
    });

    it('serves two operations on one path and method under their own query', async () => {
        const answer = `export default (req: any) => ({ state: req.query.action });`;
        b = await boot('action.yaml', {
            RetryDeviceGroupRealization: answer,
            ApplyDeviceGroupProfile: answer,
        });
        const at = (search: string) =>
            fetch(`${b!.base}/api/v1/device-groups/123${search}`, { method: 'POST' });
        const retry = await at('?action=retry_profile_realization');
        expect(retry.headers.get('x-gym-operation')).toBe('RetryDeviceGroupRealization');
        expect(await retry.json()).toEqual({ state: 'retry_profile_realization' });
        const bare = await at('');
        expect(bare.status).toBe(404);
    });

    it('writes a handler on first use when none is cached', async () => {
        b = await boot('petstore.yaml', {}, { builder: writes(GET_USER) });
        const res = await fetch(`${b.base}/users/42`);
        expect(res.status).toBe(200);
        expect(res.headers.get('x-gym-cache')).toBe('miss');
        expect(await res.json()).toEqual({ user_id: 42, email: 'user42@northwind.io' });
    });
});

// ---------------------------------------------------------------------------
// The backstop
//
// A handler is judged on its pages before it is kept, but a client that
// ignores an ended list must still not loop forever. This is the only thing
// here that edits what a handler answered.
// ---------------------------------------------------------------------------

describe('a looping page token', () => {
    let b: Booted | undefined;
    afterEach(async () => {
        await b?.live.close();
        await b?.r.close();
        b = undefined;
    });

    const every = (body: string) => ({
        listMachines: body,
        listEvents: body,
        listAlarms: body,
        collectAuditLogs: body,
        listTags: body,
    });

    it('is cut back to the last page, and narrated', async () => {
        b = await boot(
            'paged.yaml',
            every(`export default () => ({ results: [], cursor: '8fde793b', has_more: true });`),
        );
        const res = await fetch(`${b.base}/machines?cursor=8fde793b`);
        expect(await res.json()).toEqual({ results: [], cursor: null, has_more: false });
        expect(b.log.at(-1)).toContain('cut a looping page token');
    });

    it('is left alone when it advanced', async () => {
        b = await boot(
            'paged.yaml',
            every(`export default () => ({ results: [], cursor: 'page-2', has_more: true });`),
        );
        const res = await fetch(`${b.base}/machines?cursor=page-1`);
        expect(await res.json()).toMatchObject({ cursor: 'page-2' });
        expect(b.log.at(-1)).not.toContain('cut');
    });

    // The document never declared `cursor`, so only the request says this is a page turn.
    it('is cut even where the document never declared the parameter', async () => {
        b = await boot(
            'paged.yaml',
            every(`export default () => ({ results: [], cursor: 'eyJwIjoyfQ==' });`),
        );
        const res = await fetch(`${b.base}/alarms?cursor=${encodeURIComponent('eyJwIjoyfQ==')}`);
        expect(await res.json()).toEqual({ results: [], cursor: null });
    });

    it('is cut when a looping cursor is sent in the request body', async () => {
        b = await boot(
            'paged.yaml',
            every(
                `export default () => ({ results: ['audit1'], cursor: 'eyJwIjoyfQ==', has_more: true });`,
            ),
        );
        const res = await fetch(`${b.base}/audit-logs`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ cursor: 'eyJwIjoyfQ==' }),
        });
        expect(await res.json()).toEqual({ results: ['audit1'], cursor: null, has_more: false });
    });

    it('terminates pagination at maxPages', async () => {
        b = await boot(
            'paged.yaml',
            every(`
export default (req: any) => {
    const n = req.query.cursor ? Number(req.query.cursor) : 1;
    return { results: [{ id: 'm' + n }], cursor: String(n + 1), has_more: true };
};`),
            { server: { maxPages: 2 } },
        );
        expect(await (await fetch(`${b.base}/machines`)).json()).toMatchObject({ cursor: '2' });
        expect(await (await fetch(`${b.base}/machines?cursor=2`)).json()).toEqual({
            results: [{ id: 'm2' }],
            cursor: null,
            has_more: false,
        });
        expect(b.log.at(-1)).toContain('cut pagination at max pages (2)');
    });
});

// ---------------------------------------------------------------------------
// Logging, dumps and regeneration
// ---------------------------------------------------------------------------

describe('logging and regeneration', () => {
    let b: Booted | undefined;
    let requestsDir: string;
    afterEach(async () => {
        await b?.live.close();
        await b?.r.close();
        b = undefined;
    });

    const FAILS_ON_999 = `
export default async function handle(req: any, ctx: any) {
    if (req.pathParams.user_id === '999') { throw new RangeError('no user 999'); }
    return await ctx.lookup('User', req.pathParams.user_id, { idField: 'user_id' });
}`;

    const start = async (builder?: Script, regenLimit = 3): Promise<Booted> => {
        const booted = await boot(
            'petstore.yaml',
            { ...PETSTORE, getUserById: FAILS_ON_999 },
            {
                builder,
                server: { regenLimit },
            },
        );
        requestsDir = join(booted.r.root, 'requests');
        return booted;
    };

    beforeEach(() => {
        requestsDir = '';
    });

    it('logs a timestamped line and writes a markdown dump of the exchange', async () => {
        b = await start();
        expect((await fetch(`${b.base}/users/100`)).status).toBe(200);
        const line = b.log.at(-1)!;
        expect(line).toMatch(/\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\]/);
        expect(line).toContain('[SUCCESS]');
        const dump = /file:\/\/(.+?\.md)/.exec(line)![1]!;
        const md = readFileSync(dump, 'utf8');
        expect(md).toContain('# Request: GET /users/100');
        expect(md).toContain('"email": "user100@northwind.io"');
    });

    it('does not regenerate on client errors', async () => {
        b = await start(() => {
            throw new Error('must not be asked');
        });
        expect((await fetch(`${b.base}/users/not-an-integer`)).status).toBe(400);
        expect(b.log.at(-1)).toContain('[CLIENT_ERROR: VALIDATION_FAILED]');
        expect(b.model.builder).toHaveLength(0);
    });

    it('repairs a handler that fails on a real request, with what it knows', async () => {
        b = await start(writes(GET_USER));
        expect((await fetch(`${b.base}/users/1`)).status).toBe(200);
        const res = await fetch(`${b.base}/users/999`);
        expect(res.status).toBe(200);
        expect(res.headers.get('x-gym-cache')).toBe('regenerated');
        expect(await res.json()).toEqual({ user_id: 999, email: 'user999@northwind.io' });

        const brief = b.model.builder[0]!.brief;
        expect(brief).toContain('THE CURRENT HANDLER FAILED ON A REAL REQUEST');
        expect(brief).toContain("throw new RangeError('no user 999')");
        expect(brief).toContain('"user_id": "999"');
        expect(brief).toContain('no user 999');
        expect(brief).toContain('EARLIER SUCCESSFUL REQUEST 1');
        expect(b.log.join('\n')).toContain('[REGENERATED]');
    });

    // A request that arrives while a repair is being judged must be answered by
    // the handler already kept, never by a candidate the judge threw out — and
    // that candidate must not reach the live world through it either.
    it('answers with the kept handler while a repair is judged, never with a rejected candidate', async () => {
        const FAILS_ON_5 = `
export default (req: any) => {
    if (req.pathParams.user_id === '5') { throw new RangeError('no user 5'); }
    return { user_id: Number(req.pathParams.user_id), email: 'kept@northwind.io' };
};`;
        const REJECTED = `
export default (req: any, ctx: any) => {
    ctx.db.collection('leaks').put('rejected', { id: 'rejected' });
    return { user_id: 999, email: 'rejected@northwind.io' };
};`;
        let verdict = '';
        let during: { status: number; body: unknown } | undefined;
        const builder: Script = async (turn) => {
            const tested = turn.results.filter((r) => r.name === 'test_handler');
            if (tested.length === 0) {
                return call('test_handler', { source: REJECTED });
            }
            if (tested.length === 1) {
                verdict = tested[0]!.content;
                const res = await fetch(`${b!.base}/users/7`);
                during = { status: res.status, body: await res.json() };
                return call('test_handler', { source: GET_USER });
            }
            return say('done');
        };
        b = await boot(
            'petstore.yaml',
            { ...PETSTORE, getUserById: FAILS_ON_5 },
            { builder, attempts: 3 },
        );

        const res = await fetch(`${b.base}/users/5`);
        expect(res.headers.get('x-gym-cache')).toBe('regenerated');
        expect(await res.json()).toEqual({ user_id: 5, email: 'user5@northwind.io' });
        expect(verdict).toContain('"ok":false');
        // Soft, so a leak through the body and a leak into the world are reported apart.
        expect.soft(during).toEqual({
            status: 200,
            body: { user_id: 7, email: 'kept@northwind.io' },
        });
        expect.soft(b.r.store.collection('leaks').has('rejected')).toBe(false);
    });

    it('limits regenerations per url and says so', async () => {
        b = await start(writes(FAILS_ON_999, FAILS_ON_999, FAILS_ON_999, FAILS_ON_999), 1);
        expect((await fetch(`${b.base}/users/999`)).status).toBe(502);
        const asked = b.model.builder.length;
        const res = await fetch(`${b.base}/users/999`);
        expect(res.status).toBe(502);
        expect(await res.json()).toMatchObject({
            regenerationLimitHit: true,
            regenerationLimit: 1,
        });
        expect(b.model.builder).toHaveLength(asked);
        expect(b.log.join('\n')).toContain('[REGENERATION_LIMIT_HIT]');
    });

    it('dumps only requests to real operations', async () => {
        b = await start();
        await fetch(`${b.base}/`);
        await fetch(`${b.base}/__gym/health`);
        await fetch(`${b.base}/not-a-route`);
        expect(existsSync(requestsDir) ? readdirSync(requestsDir) : []).toEqual([]);
        await fetch(`${b.base}/users/1`);
        expect(readdirSync(requestsDir)).toHaveLength(1);
    });
});
