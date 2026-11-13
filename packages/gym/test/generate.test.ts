import { cacheItems, Cache as Store } from '@zenera/cli/lib';
import type { Model } from '@zenera/neo';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HANDLERS } from '../src/box.ts';
import { GYM_KIND } from '../src/cache.ts';
import { build, BuildFailed, reason, unfence, type BuildOptions } from '../src/generate.ts';
import type { HandlerRequest } from '../src/runtime.ts';
import type { Operation } from '../src/spec.ts';
import {
    call,
    GET_USER,
    GET_USER_CONSTANT,
    GET_USER_NO_EMAIL,
    knowing,
    op,
    rig,
    say,
    scripted,
    writes,
    type Rig,
    type Script,
} from './helpers.ts';

const options = (r: Rig, model: Model, attempts = 3): BuildOptions => ({
    model,
    box: r.box,
    checks: r.checks,
    catalog: r.catalog,
    world: r.world,
    bindings: r.bindings,
    operations: r.operations,
    sourceOf: (o) => r.cache.getSource(o.key),
    attempts,
});

/** A getUserById that passes the judge and says which version it is by its email. */
const answering = (email: string): string =>
    `export default (req: any) => ({ user_id: Number(req.pathParams.user_id), email: '${email}' });`;

/** A live request for one user, as the server would send it. */
const asking = (operation: Operation, userId: string): HandlerRequest => ({
    operationId: operation.operationId,
    method: operation.method,
    path: operation.path,
    pathParams: { user_id: userId },
    query: {},
    headers: {},
    body: undefined,
    seed: 1,
});

describe('the handler agent', () => {
    let r: Rig | undefined;
    afterEach(async () => {
        await r?.close();
        r = undefined;
    });

    it('keeps the first handler the judge passes', async () => {
        const model = scripted({ builder: writes(GET_USER) });
        r = await rig('petstore.yaml', model);
        const built = await build(op(r, 'getUserById'), options(r, model));
        expect(built).toMatchObject({ source: GET_USER.trim(), attempts: 1 });
        // A pass ends the run: nobody waits on a closing remark.
        expect(model.builder).toHaveLength(1);
    });

    it('is briefed in TypeScript, with the world and the siblings', async () => {
        const model = scripted({ builder: writes(GET_USER) });
        r = await rig('petstore.yaml', model);
        await build(op(r, 'getUserById'), options(r, model));
        const brief = model.builder[0]!.brief;
        expect(brief).toContain('OPERATION  GET /users/{user_id}');
        expect(brief).toContain('export interface User');
        expect(brief).toContain('RELATED OPERATIONS');
        expect(brief).toContain('createUser');
        expect(brief).toContain('THE WORLD SO FAR');
    });

    it('hands every problem back, and a fix is tested again', async () => {
        const model = scripted({ builder: writes(GET_USER_NO_EMAIL, GET_USER) });
        r = await rig('petstore.yaml', model);
        const built = await build(op(r, 'getUserById'), options(r, model));
        expect(built.attempts).toBe(2);
        const verdict = model.builder[1]!.results.at(-1)!.content;
        expect(verdict).toContain('"ok":false');
        expect(verdict).toContain('email');
    });

    // The rule schema validation cannot see: a body can be perfectly shaped
    // and still be about somebody else.
    it('rejects a handler that ignores the request and answers about someone else', async () => {
        const model = scripted({ builder: writes(GET_USER_CONSTANT, GET_USER_CONSTANT) });
        r = await rig('petstore.yaml', model);
        const failed = await build(op(r, 'getUserById'), options(r, model, 2)).catch(
            (e: unknown) => e,
        );
        expect(failed).toBeInstanceOf(BuildFailed);
        expect((failed as BuildFailed).diagnostics.join('\n')).toContain('echo the path parameter');
    });

    it('gives up after the attempt limit rather than looping', async () => {
        const broken = 'export default () => { throw new Error("boom"); };';
        const model = scripted({ builder: writes(broken, broken, broken, broken) });
        r = await rig('petstore.yaml', model);
        const failed = await build(op(r, 'getUserById'), options(r, model, 2)).catch(
            (e: unknown) => e,
        );
        expect(failed).toBeInstanceOf(BuildFailed);
        expect((failed as BuildFailed).diagnostics.join('\n')).toContain('boom');
        const tests = model.builder
            .flatMap((t) => t.req.messages)
            .filter((m) => m.role === 'assistant' && JSON.stringify(m).includes('test_handler'));
        expect(tests.length).toBeLessThanOrEqual(2);
    });

    it('starts again when the agent stops without passing', async () => {
        let runs = 0;
        const model = scripted({
            builder: (turn) => {
                if (turn.call === 1) {
                    runs++;
                }
                return runs === 1
                    ? say('I think it is fine.')
                    : call('test_handler', { source: GET_USER });
            },
        });
        r = await rig('petstore.yaml', model);
        await expect(build(op(r, 'getUserById'), options(r, model))).resolves.toMatchObject({
            source: GET_USER.trim(),
        });
        expect(model.builder.at(-1)!.brief).toContain('has not passed test_handler');
    });

    // Judging writes content into a copy: probe traffic must not become part
    // of the world real requests see.
    it('judges in a copy of the world', async () => {
        const model = scripted({ builder: writes(GET_USER) });
        r = await rig('petstore.yaml', model);
        await build(op(r, 'getUserById'), options(r, model));
        expect(r.store.collections()).toEqual([]);
    });

    it('can read the handlers its siblings already have', async () => {
        const model = scripted({
            builder: (turn) =>
                turn.call === 1
                    ? call('read_handler', { operationId: 'getUserById' })
                    : call('test_handler', { source: GET_USER }),
        });
        r = await rig('petstore.yaml', model);
        vi.spyOn(r.cache, 'getSource').mockResolvedValue(GET_USER);
        await build(op(r, 'getSelf'), options(r, model)).catch(() => undefined);
        expect(model.builder[1]!.results[0]!.content).toContain("ctx.lookup('User'");
    });

    it('rejects pages that answer with the token they were given', async () => {
        const looping = `export default () => ({ results: [], cursor: 'same', has_more: true });`;
        const model = scripted({ builder: writes(looping, looping) });
        r = await rig('paged.yaml', model);
        const failed = await build(op(r, 'listMachines'), options(r, model, 1)).catch(
            (e: unknown) => e,
        );
        expect((failed as BuildFailed).diagnostics.join('\n')).toMatch(
            /the token the request sent|never run out|cycle/,
        );
    });

    it('accepts pages made with ctx.page', async () => {
        const paged = `
export default async function handle(req: any, ctx: any) {
    const all = await ctx.ensure('machines', { type: 'Machine', min: 5, count: 5 });
    const p = ctx.page(all, { token: req.query.cursor, size: req.query.page_size });
    return { results: p.items, cursor: p.nextToken, has_more: p.hasMore };
}`;
        const model = scripted({ builder: writes(paged) });
        r = await rig('paged.yaml', model);
        await expect(build(op(r, 'listMachines'), options(r, model))).resolves.toMatchObject({
            attempts: 1,
        });
    });

    // Candidates are judged away from the live key, so the pass has to be put there.
    it('puts the handler the judge passed where live requests run it', async () => {
        const model = scripted({
            builder: writes(GET_USER_CONSTANT, answering('passed@northwind.io')),
        });
        r = await rig('petstore.yaml', model);
        const operation = op(r, 'getUserById');
        await r.box.write(operation.key, answering('old@northwind.io'));
        const write = vi.spyOn(r.box, 'write');
        await build(operation, options(r, model));
        expect(await r.box.run(operation.key, asking(operation, '7'))).toMatchObject({
            ok: true,
            value: { user_id: 7, email: 'passed@northwind.io' },
        });
        // The live file changes once, to the pass, and never to a candidate on the way.
        const live = write.mock.calls.filter(([key]) => key === operation.key);
        expect(live).toEqual([[operation.key, answering('passed@northwind.io')]]);
    });

    it('leaves nothing of a candidate behind, whether it passed or not', async () => {
        const failing = scripted({ builder: writes(GET_USER_CONSTANT, GET_USER_CONSTANT) });
        r = await rig('petstore.yaml', failing);
        const operation = op(r, 'getUserById');
        const handlers = join(r.root, HANDLERS);
        await expect(build(operation, options(r, failing, 2))).rejects.toBeInstanceOf(BuildFailed);
        expect(readdirSync(handlers)).toEqual(['package.json']);

        const passing = scripted({
            builder: writes(GET_USER_CONSTANT, answering('passed@northwind.io')),
        });
        await build(operation, options(r, passing));
        expect(readdirSync(handlers).sort()).toEqual([operation.key, 'package.json'].sort());
        expect(readdirSync(join(r.root, 'scratch'))).toEqual([]);
    });
});

describe('what the handler agent is told', () => {
    let r: Rig | undefined;
    afterEach(async () => {
        await r?.close();
        r = undefined;
    });

    // The operations share nothing but a type: no path prefix, no name.
    it('finds the operations that carry the same records, however far apart their paths', async () => {
        const model = scripted({
            builder: writes('export default () => ({ id: "x", label: "y" });'),
        });
        r = await rig('shared.yaml', model);
        expect(r.catalog.itemType(op(r, 'listThings'))).toBe('Thing');
        expect(r.catalog.itemType(op(r, 'getThing'))).toBe('Thing');
        await build(op(r, 'getThing'), options(r, model)).catch(() => undefined);
        const brief = model.builder[0]!.brief;
        expect(brief).toContain('This operation is about `Thing` records.');
        expect(brief).toMatch(/GET \/b\/thing-list\s+listThings\s+→ Thing/);
        expect(brief).toMatch(/POST \/c\/make\s+makeThing/);
        expect(brief).not.toContain('getOther');
    });

    it('can trace and grep the API graph without an index', async () => {
        const model = scripted({
            builder: (turn) =>
                turn.call === 1
                    ? call('trace_api', { of: 'Thing', kind: 'type' })
                    : call('test_handler', {
                          source: 'export default () => ({ id: "x", label: "y" });',
                      }),
        });
        r = await rig('shared.yaml', model);
        await build(op(r, 'getThing'), options(r, model)).catch(() => undefined);
        const names = model.builder[0]!.req.tools.map((t) => t.name);
        expect(names).toEqual(expect.arrayContaining(['trace_api', 'grep_api', 'list_api']));
        const traced = model.builder[1]!.results[0]!.content;
        expect(traced).toContain('/b/thing-list');
        expect(traced).toContain('/c/make');
    });

    it('quotes the reference documents about the operation, and can search them', async () => {
        const search = {
            name: 'search_docs',
            description: 'search',
            parameters: { type: 'object' as const, properties: {} },
            execute: () => ({ found: 0 }),
        };
        const model = scripted({ builder: writes(GET_USER) });
        r = await rig('petstore.yaml', model, {
            knowledge: knowing(undefined, {
                tools: [search],
                recall: (q) =>
                    Promise.resolve(`kb/users.md:4 | ${q.split(' — ')[0]} refuses unknown ids`),
            }),
        });
        await build(op(r, 'getUserById'), options(r, model));
        const turn = model.builder[0]!;
        expect(turn.brief).toContain('FROM THE REFERENCE DOCUMENTS');
        expect(turn.brief).toContain('One user by id. refuses unknown ids');
        expect(turn.req.tools.map((t) => t.name)).toContain('search_docs');
    });
});

describe('where types live', () => {
    let r: Rig | undefined;
    afterEach(async () => {
        await r?.close();
        r = undefined;
    });

    const GET_THING = `export default (req: any, ctx: any) => ctx.lookup('Thing', req.pathParams.id);`;

    it('binds a type to the collection its first handler used, once that handler passes', async () => {
        const model = scripted({ builder: writes(GET_THING) });
        r = await rig('shared.yaml', model);
        const built = await build(op(r, 'getThing'), options(r, model));
        expect(built.bindings).toEqual({ Thing: { collection: 'things', idField: 'id' } });
        expect(r.bindings.of('Thing')).toEqual({ collection: 'things', idField: 'id' });
    });

    it('tells the next handler, which finds the records by type alone', async () => {
        r = await rig('shared.yaml', scripted({}));
        r.bindings.bind('Thing', { collection: 'stuff', idField: 'id' });
        const list = `
export default async (req: any, ctx: any) => ({ results: await ctx.ensure('Thing', { count: 2 }) });`;
        const model = scripted({ builder: writes(list) });
        const again = await rig('shared.yaml', model, { root: r.root });
        try {
            await build(op(again, 'listThings'), options(again, model));
            expect(model.builder[0]!.brief).toContain('Thing → stuff (keyed by id)');
        } finally {
            await again.box.dispose();
        }
    });

    it('refuses a handler that stores a type somewhere else, and says where it lives', async () => {
        const model = scripted({
            builder: writes(
                `export default (req: any, ctx: any) => ctx.lookup('elsewhere', req.pathParams.id, { type: 'Thing' });`,
                GET_THING,
            ),
        });
        r = await rig('shared.yaml', model);
        r.bindings.bind('Thing', { collection: 'things', idField: 'id' });
        await build(op(r, 'getThing'), options(r, model));
        const verdict = model.builder[1]!.results.at(-1)!.content;
        expect(verdict).toContain('`Thing` lives in `things`, not `elsewhere`');
    });

    it('refuses a collection used without a type', async () => {
        const model = scripted({
            builder: writes(
                `export default (req: any, ctx: any) => ctx.lookup('things', req.pathParams.id);`,
                GET_THING,
            ),
        });
        r = await rig('shared.yaml', model);
        await build(op(r, 'getThing'), options(r, model));
        expect(model.builder[1]!.results.at(-1)!.content).toContain('used without a type');
    });

    it('refuses a type the documents do not declare', async () => {
        const model = scripted({
            builder: writes(
                `export default (req: any, ctx: any) => ctx.lookup('Widget', req.pathParams.id);`,
                GET_THING,
            ),
        });
        r = await rig('shared.yaml', model);
        await build(op(r, 'getThing'), options(r, model));
        expect(model.builder[1]!.results.at(-1)!.content).toContain('`Widget` is not a type');
    });

    // A handler written against a placement that no longer holds would read and
    // write where nobody else looks.
    it('treats a cached handler whose bindings disagree as a miss', async () => {
        const first = scripted({ builder: writes(GET_THING) });
        r = await rig('shared.yaml', first);
        await r.cache.ensure(op(r, 'getThing'));

        const other = scripted({ builder: writes(GET_THING) });
        const again = await rig('shared.yaml', other, {
            root: r.root,
            cacheDir: join(r.root, 'elsewhere'),
        });
        try {
            // A fresh bindings store, where Thing lives elsewhere: the old handler's
            // placement no longer holds.
            again.bindings.bind('Thing', { collection: 'other_things', idField: 'id' });
            const kept = new Store(GYM_KIND, { dir: join(r.root, 'store') }).get<unknown>(
                op(r, 'getThing').key,
            );
            new Store(GYM_KIND, { dir: join(r.root, 'elsewhere') }).put(
                op(r, 'getThing').key,
                kept,
            );
            const got = await again.cache.ensure(op(again, 'getThing'));
            expect(got.cached).toBe(false);
        } finally {
            await again.box.dispose();
        }
    });
});

describe('the cache', () => {
    let r: Rig | undefined;
    afterEach(async () => {
        await r?.close();
        r = undefined;
    });

    it('builds once for however many callers arrive at the same time', async () => {
        const model = scripted({ builder: writes(GET_USER) });
        r = await rig('petstore.yaml', model);
        const all = await Promise.all(
            Array.from({ length: 10 }, () => r!.cache.ensure(op(r!, 'getUserById'))),
        );
        expect(model.builder).toHaveLength(1);
        expect(new Set(all.map((g) => g.source)).size).toBe(1);
    });

    // Two processes serving the same documents: one writes, the other waits
    // and reads what was written.
    it('writes a handler once across processes sharing the cache', async () => {
        let starts = 0;
        const slow: Script = async (turn) => {
            if (turn.call === 1) {
                starts++;
            }
            await new Promise((res) => setTimeout(res, 200));
            return writes(GET_USER)(turn);
        };
        r = await rig('petstore.yaml', scripted({ builder: slow }));
        const other = await rig('petstore.yaml', scripted({ builder: slow }), {
            root: r.root,
            cacheDir: join(r.root, 'store'),
        });
        try {
            const [mine, theirs] = await Promise.all([
                r.cache.ensure(op(r, 'getUserById')),
                other.cache.ensure(op(other, 'getUserById')),
            ]);
            expect(starts).toBe(1);
            expect(mine.source).toBe(theirs.source);
            expect([mine.cached, theirs.cached].sort()).toEqual([false, true]);
        } finally {
            await other.box.dispose();
        }
    });

    it('reads what is cached on a later start instead of asking again', async () => {
        const first = scripted({ builder: writes(GET_USER) });
        r = await rig('petstore.yaml', first);
        await r.cache.ensure(op(r, 'getUserById'));

        const second = scripted({});
        const again = await rig('petstore.yaml', second, {
            root: r.root,
            cacheDir: join(r.root, 'store'),
        });
        try {
            const got = await again.cache.ensure(op(again, 'getUserById'));
            expect(got.cached).toBe(true);
            expect(second.builder).toHaveLength(0);
            // A hit is copied back into the box, which runs only what is on its disk.
            expect(readFileSync(again.box.sourceOf(got.key), 'utf8')).toContain(
                "ctx.lookup('User'",
            );
        } finally {
            await again.box.dispose();
        }
    });

    it('records what wrote it', async () => {
        const model = scripted({ builder: writes(GET_USER) });
        r = await rig('petstore.yaml', model);
        await r.cache.ensure(op(r, 'getUserById'));
        const { rows } = cacheItems(GYM_KIND, { dir: join(r.root, 'store') });
        const meta = (rows[0]!.value as { meta: Record<string, unknown> }).meta;
        expect(meta).toMatchObject({
            model: 'scripted',
            operationId: 'getUserById',
            rulesVersion: 4,
        });
    });

    it('does not re-ask a model that already gave up', async () => {
        const broken = 'export default () => { throw new Error("boom"); };';
        const model = scripted({ builder: writes(broken, broken, broken) });
        r = await rig('petstore.yaml', model, { attempts: 1 });
        await expect(r.cache.ensure(op(r, 'getUserById'))).rejects.toBeInstanceOf(BuildFailed);
        const asked = model.builder.length;
        await expect(r.cache.ensure(op(r, 'getUserById'))).rejects.toBeInstanceOf(BuildFailed);
        expect(model.builder).toHaveLength(asked);
    });

    it('writes one report per failed build, source and all', async () => {
        const broken = 'export default () => { throw new Error("boom"); };';
        const model = scripted({ builder: writes(broken, broken) });
        let failure: { error: Error; dump?: string } | undefined;
        r = await rig('petstore.yaml', model, {
            attempts: 2,
            onFail: (e) => {
                failure = e;
            },
        });
        await expect(r.cache.ensure(op(r, 'getUserById'))).rejects.toBeInstanceOf(BuildFailed);
        const report = readFileSync(failure!.dump!, 'utf8');
        expect(report).toContain('getUserById');
        expect(report).toContain('gave up after 2 of 2');
        expect(report).toContain('## Attempt 2 of 2');
        expect(report).toContain('```ts');
        expect(report).toContain('boom');
    });

    // A rate limit is about this minute, not about this operation.
    it('forgets a transient failure and tries again on the next request', async () => {
        let calls = 0;
        const model = scripted({
            builder: (turn) => {
                calls++;
                if (calls === 1) {
                    throw Object.assign(new Error('429 rate limited'), { status: 429 });
                }
                return writes(GET_USER)(turn);
            },
        });
        r = await rig('petstore.yaml', model);
        await expect(r.cache.ensure(op(r, 'getUserById'))).rejects.toThrow(/rate limited/);
        await expect(r.cache.ensure(op(r, 'getUserById'))).resolves.toMatchObject({
            cached: false,
        });
    });

    it('writes no more than `concurrency` handlers at once', async () => {
        let inFlight = 0;
        let peak = 0;
        const model = scripted({
            builder: async () => {
                inFlight++;
                peak = Math.max(peak, inFlight);
                await new Promise((res) => setTimeout(res, 5));
                inFlight--;
                return say('giving up');
            },
        });
        r = await rig('petstore.yaml', model, { concurrency: 2, attempts: 1 });
        await Promise.allSettled(r.operations.map((o) => r!.cache.ensure(o)));
        expect(peak).toBeLessThanOrEqual(2);
    });

    it('runs the repaired handler once a repair passes', async () => {
        const model = scripted({ builder: writes(answering('new@northwind.io')) });
        r = await rig('petstore.yaml', model);
        const operation = op(r, 'getUserById');
        const OLD = answering('old@northwind.io');
        await r.box.write(operation.key, OLD);
        const repaired = await r.cache.regenerate(operation, {
            currentSource: OLD,
            failingInput: asking(operation, '5'),
            fault: 'threw',
        });
        expect(await r.box.run(operation.key, asking(operation, '7'))).toMatchObject({
            value: { user_id: 7, email: 'new@northwind.io' },
        });
        expect(await r.cache.getSource(operation.key)).toBe(repaired.source);
    });

    // Two repairs of one handler overlap. The one that fails last must not put
    // the file it started from back over the one the other repair just kept.
    it('keeps running the repaired handler when an overlapping repair fails after it', async () => {
        let winnerKept!: () => void;
        const kept = new Promise<void>((settle) => {
            winnerKept = settle;
        });
        const model = scripted({
            builder: async (turn) => {
                if (!turn.brief.includes('FAULT: the losing repair')) {
                    return writes(answering('new@northwind.io'))(turn);
                }
                if (turn.results.length > 0) {
                    return say('done');
                }
                await kept;
                return call('test_handler', { source: GET_USER_CONSTANT });
            },
        });
        r = await rig('petstore.yaml', model, { attempts: 1 });
        const operation = op(r, 'getUserById');
        const OLD = answering('old@northwind.io');
        await r.box.write(operation.key, OLD);
        const repair = (fault: string) => ({
            currentSource: OLD,
            failingInput: asking(operation, '5'),
            fault,
        });

        const losing = r.cache
            .regenerate(operation, repair('the losing repair'))
            .catch((err: unknown) => err);
        const winning = await r.cache.regenerate(operation, repair('the winning repair'));
        winnerKept();
        expect(await losing).toBeInstanceOf(BuildFailed);

        expect(await r.cache.getSource(operation.key)).toBe(winning.source);
        expect(await r.box.run(operation.key, asking(operation, '7'))).toMatchObject({
            value: { user_id: 7, email: 'new@northwind.io' },
        });
    });
});

describe('unfencing an answer', () => {
    it('leaves a bare module alone', () => {
        expect(unfence('export default () => 1;\n')).toBe('export default () => 1;');
    });

    it('strips a fence the model added anyway', () => {
        expect(unfence('```ts\nexport default () => 1;\n```')).toBe('export default () => 1;');
    });
});

describe('reporting why something failed', () => {
    it('unwraps the cause chain, which is where the real reason hides', () => {
        const inner = Object.assign(new Error('connect ETIMEDOUT 1.2.3.4:443'), {
            code: 'ETIMEDOUT',
        });
        expect(reason(new Error('fetch failed', { cause: inner }))).toBe(
            'fetch failed — ETIMEDOUT connect ETIMEDOUT 1.2.3.4:443',
        );
    });

    it('names the status a provider answered with', () => {
        expect(reason(Object.assign(new Error('Rate limit reached'), { status: 429 }))).toBe(
            '429 Rate limit reached',
        );
    });

    it('survives a cause that points back at itself', () => {
        const loop = new Error('round');
        (loop as Error & { cause?: unknown }).cause = loop;
        expect(reason(loop)).toBe('round');
    });
});
