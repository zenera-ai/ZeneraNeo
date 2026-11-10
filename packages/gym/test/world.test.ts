import { afterEach, describe, expect, it } from 'vitest';
import type { HandlerRequest } from '../src/runtime.ts';
import { populatedKey } from '../src/runtime.ts';
import { WorldStore } from '../src/store.ts';
import { World } from '../src/synth.ts';
import { call, idsAsked, knowing, rig, say, scripted, type Rig, type Script } from './helpers.ts';

const request: HandlerRequest = {
    operationId: 'getUserById',
    method: 'get',
    path: '/users/{user_id}',
    pathParams: { user_id: '7' },
    query: {},
    headers: {},
    body: undefined,
    seed: 3,
};

describe('the world agent', () => {
    let r: Rig | undefined;
    afterEach(async () => {
        await r?.close();
        r = undefined;
    });

    const synth = (rr: Rig, req: Parameters<Rig['world']['synthesize']>[0], probe = false) =>
        rr.world.synthesize(req, { db: rr.store.path, probe, input: request });

    it('writes the records asked for, validated against the type, and keeps them', async () => {
        const world: Script = (turn) =>
            turn.results.length > 0
                ? say('done')
                : call('save_records', {
                      records: idsAsked(turn.brief).map((id) => ({
                          user_id: Number(id),
                          email: `u${id}@acme.io`,
                      })),
                  });
        const model = scripted({ world });
        r = await rig('petstore.yaml', model);
        const made = await synth(r, {
            collection: 'users',
            type: 'User',
            idField: 'user_id',
            ids: ['7'],
        });
        expect(made).toEqual([{ user_id: 7, email: 'u7@acme.io' }]);
        expect(r.store.collection('users').get('7')).toEqual({ user_id: 7, email: 'u7@acme.io' });
        expect(model.world[0]!.brief).toContain('export interface User');
    });

    it('hands invalid records back with what is wrong, and saves the fixed ones', async () => {
        const world: Script = (turn) => {
            const saves = turn.results.filter((x) => x.name === 'save_records').length;
            if (saves === 0) {
                return call('save_records', { records: [{ user_id: 7, email: 'not-an-email' }] });
            }
            if (saves === 1) {
                return call('save_records', { records: [{ user_id: 7, email: 'u7@acme.io' }] });
            }
            return say('done');
        };
        const model = scripted({ world });
        r = await rig('petstore.yaml', model);
        await synth(r, { collection: 'users', type: 'User', idField: 'user_id', ids: ['7'] });
        const first = model.world[1]!.results[0]!.content;
        expect(first).toContain('"saved":0');
        expect(first).toContain('/email');
        expect(r.store.collection('users').get('7')).toMatchObject({ email: 'u7@acme.io' });
    });

    it('is briefed with the story, the docs and what the world already holds', async () => {
        const world: Script = () => say('nothing to do');
        const model = scripted({ world });
        r = await rig('petstore.yaml', model, {
            knowledge: knowing('THE STORY: everyone works at Acme.', {
                docs: { files: 1, chunks: 1, search: 'text', reused: false },
                recall: (q) => Promise.resolve(`kb/ranges.md:3 | ASN range for ${q.split(' ')[0]}`),
            }),
        });
        r.store.collection('accounts').put('@me', { id: '@me', email: 'a@acme.io' });
        await synth(r, { collection: 'users', type: 'User', idField: 'user_id', count: 2 });
        expect(model.world[0]!.req.system).toContain('THE STORY: everyone works at Acme.');
        expect(model.world[0]!.req.system).toContain('REFERENCE DOCUMENTS');
        expect(model.world[0]!.brief).toContain('FROM THE REFERENCE DOCUMENTS');
        expect(model.world[0]!.brief).toContain('kb/ranges.md:3 | ASN range for User');
        expect(model.world[0]!.brief).toContain('accounts: 1 records');
    });

    // A failed agent costs realism, not the request.
    it('stands sampled records in for what the agent did not deliver', async () => {
        const model = scripted({ world: () => say('I would rather not.') });
        r = await rig('petstore.yaml', model);
        const made = await synth(r, {
            collection: 'users',
            type: 'User',
            idField: 'user_id',
            ids: ['12'],
        });
        expect(made).toHaveLength(1);
        expect(made[0]!.user_id).toBe(12);
        expect(r.store.collection('users').has('12')).toBe(true);
    });

    it('answers a judgement from the schema, without an agent', async () => {
        const model = scripted({});
        r = await rig('petstore.yaml', model);
        const made = await synth(
            r,
            { collection: 'users', type: 'User', idField: 'user_id', count: 3 },
            true,
        );
        expect(made).toHaveLength(3);
        expect(model.world).toHaveLength(0);
        expect(r.catalog.validator('User')!(made[0])).toBe(true);
        expect(r.store.getMeta(populatedKey('users'))).toBe(true);
    });

    // The story says three database VMs: three ports, not the suggested eight
    // padded out with samples.
    it('lets the story decide how many records a first fill makes', async () => {
        const world: Script = (turn) =>
            turn.results.length > 0
                ? say('That is everyone the story has.')
                : call('save_records', {
                      records: [1, 2, 3].map((n) => ({ user_id: n, email: `u${n}@acme.io` })),
                  });
        const model = scripted({ world });
        r = await rig('petstore.yaml', model);
        const made = await synth(r, {
            collection: 'users',
            type: 'User',
            idField: 'user_id',
            count: 8,
            min: 1,
            populate: true,
        });
        expect(made).toHaveLength(3);
        expect(r.store.collection('users').count()).toBe(3);
        expect(model.world[0]!.brief).toContain(
            'Make the records the story says exist; where it does not say, about 8.',
        );
    });

    // Two requests that both found the inbox empty must not both fill it.
    it('makes a collection once for requests that arrive together', async () => {
        const world: Script = async (turn) => {
            await new Promise((res) => setTimeout(res, 20));
            return turn.results.length > 0
                ? say('done')
                : call('save_records', {
                      records: [1, 2].map((n) => ({ user_id: n, email: `u${n}@acme.io` })),
                  });
        };
        const model = scripted({ world });
        r = await rig('petstore.yaml', model);
        const ask = () =>
            synth(r!, {
                collection: 'users',
                type: 'User',
                idField: 'user_id',
                count: 2,
                min: 2,
                populate: true,
            });
        await Promise.all([ask(), ask(), ask()]);
        expect(model.world.filter((t) => t.call === 1)).toHaveLength(1);
        expect(r.store.collection('users').count()).toBe(2);
    });

    describe('making what records refer to', () => {
        const thing = (zone: string) => ({ id: 't1', label: 'first', zone_path: zone });
        const ask = (rr: Rig) =>
            rr.world.synthesize(
                { collection: 'things', type: 'Thing', idField: 'id', ids: ['t1'] },
                { db: rr.store.path, probe: false, input: request },
            );

        const rigWith = async (
            world: Script,
        ): Promise<{ r: Rig; model: ReturnType<typeof scripted> }> => {
            const model = scripted({ world });
            return { r: await rig('shared.yaml', model), model };
        };

        it('lists the reference fields and the types already placed', async () => {
            const { r: rr, model } = await rigWith(() => say('done'));
            r = rr;
            r.bindings.bind('Zone', { collection: 'zones', idField: 'id' });
            await ask(r);
            const brief = model.world[0]!.brief;
            expect(brief).toContain('REFERENCES');
            expect(brief).toContain('zone_path: string  — Path of the zone this thing belongs to.');
            expect(brief).toContain('Zone → zones, keyed by id: 0 records');
        });

        it('saves the entities they refer to into their own collections, placing new types', async () => {
            const { r: rr } = await rigWith((turn) =>
                turn.results.length === 0
                    ? call('save_records', {
                          type: 'Zone',
                          records: [{ id: 'z1', name: 'overlay' }],
                      })
                    : call('save_records', { records: [thing('/zones/z1')] }),
            );
            r = rr;
            await ask(r);
            expect(r.bindings.of('Zone')).toEqual({ collection: 'zones', idField: 'id' });
            expect(r.store.collection('zones').get('z1')).toEqual({ id: 'z1', name: 'overlay' });
            expect(r.store.collection('things').get('t1')).toMatchObject({
                zone_path: '/zones/z1',
            });
            // made as a dependency, not read as a list: the zones are not "populated"
            expect(r.store.getMeta(populatedKey('zones'))).toBeUndefined();
        });

        it('validates dependents against their own type', async () => {
            const { r: rr, model } = await rigWith((turn) =>
                turn.results.length === 0
                    ? call('save_records', { type: 'Zone', records: [{ id: 'z1' }] })
                    : say('done'),
            );
            r = rr;
            await ask(r);
            expect(model.world[1]!.results[0]!.content).toContain('name');
            expect(r.store.collection('zones').count()).toBe(0);
        });

        it('knows which type a reference field names', async () => {
            r = await rig('shared.yaml', scripted({}));
            expect(r.catalog.referent('zone_path')).toBe('Zone');
            expect(r.catalog.referent('zoneIds')).toBe('Zone');
            expect(r.catalog.referent('threadId')).toBeUndefined();
        });

        it('reports a reference to nothing', async () => {
            const made: { dangling?: string[] }[] = [];
            const model = scripted({
                world: (turn) =>
                    turn.results.length === 0
                        ? call('save_records', { records: [thing('/zones/nowhere')] })
                        : say('done'),
            });
            r = await rig('shared.yaml', model);
            const world = new World({
                model,
                knowledge: knowing(),
                catalog: r.catalog,
                bindings: r.bindings,
                store: r.store,
                onMade: (e) => made.push(e),
            });
            await world.synthesize(
                { collection: 'things', type: 'Thing', idField: 'id', ids: ['t1'] },
                { db: r.store.path, probe: false, input: request },
            );
            expect(made[0]!.dangling).toEqual(['zone_path=/zones/nowhere']);
        });
    });

    // Two processes on one world: here two Worlds with their own leases,
    // locks and connections, sharing nothing but the file.
    it('fills a collection once across processes sharing a world', async () => {
        let runs = 0;
        const world: Script = async (turn) => {
            if (turn.call === 1) {
                runs++;
            }
            await new Promise((res) => setTimeout(res, 300));
            return turn.results.length > 0
                ? say('done')
                : call('save_records', {
                      records: [1, 2].map((n) => ({ user_id: n, email: `u${n}@acme.io` })),
                  });
        };
        const model = scripted({ world });
        r = await rig('petstore.yaml', model);
        const second = new WorldStore(r.store.path);
        const other = new World({
            model,
            knowledge: knowing(),
            catalog: r.catalog,
            bindings: r.bindings,
            store: second,
        });
        const ask = (w: World, db: string) =>
            w.synthesize(
                {
                    collection: 'users',
                    type: 'User',
                    idField: 'user_id',
                    count: 2,
                    min: 2,
                    populate: true,
                },
                { db, probe: false, input: request },
            );
        try {
            const [mine, theirs] = await Promise.all([
                ask(r.world, r.store.path),
                ask(other, second.path),
            ]);
            expect(runs).toBe(1);
            expect(mine).toHaveLength(2);
            expect(theirs).toHaveLength(2);
        } finally {
            other.close();
            second.close();
        }
    });
});
