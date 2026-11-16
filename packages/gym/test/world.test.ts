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

    it('satisfies a 120-record minimum when the world agent cannot', async () => {
        const model = scripted({
            world: () => say('No additional records available.'),
        });

        r = await rig('petstore.yaml', model);

        const made = await synth(r, {
            collection: 'users',
            type: 'User',
            idField: 'user_id',
            min: 120,
            count: 120,
        });

        const stored = r.store.collection('users').all();

        expect(stored).toHaveLength(120);
        expect(made).toHaveLength(120);

        const ids = stored.map((record) => String(record.user_id));
        expect(new Set(ids).size).toBe(120);

        expect(stored.every((record) => r!.catalog.validator('User')!(record))).toBe(true);
    });

    it('expands a populated collection without changing existing records', async () => {
        const model = scripted({
            world: () => say('No additional records available.'),
        });

        r = await rig('petstore.yaml', model);

        const collection = r.store.collection('users');

        for (let i = 1; i <= 60; i++) {
            collection.put(String(i), {
                user_id: i,
                email: `original${i}@acme.io`,
            });
        }

        const before = collection.all();
        expect(before).toHaveLength(60);

        await synth(r, {
            collection: 'users',
            type: 'User',
            idField: 'user_id',
            min: 120,
            count: 120,
        });

        const after = collection.all();

        expect(after).toHaveLength(120);

        for (let i = 1; i <= 60; i++) {
            expect(collection.get(String(i))).toEqual({
                user_id: i,
                email: `original${i}@acme.io`,
            });
        }

        expect(new Set(after.map((record) => String(record.user_id))).size).toBe(120);

        expect(model.world.length).toBeGreaterThan(0);
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

    it('populates 120 records during a judgement without calling the agent', async () => {
        const model = scripted({});
        r = await rig('petstore.yaml', model);

        const made = await synth(
            r,
            {
                collection: 'users',
                type: 'User',
                idField: 'user_id',
                min: 120,
                count: 120,
            },
            true,
        );

        expect(made).toHaveLength(120);

        const stored = r.store.collection('users').all();
        expect(stored).toHaveLength(120);

        const ids = stored.map((record) => String(record.user_id));
        expect(new Set(ids).size).toBe(120);

        expect(stored.every((record) => r!.catalog.validator('User')!(record))).toBe(true);
        expect(model.world).toHaveLength(0);
    });

    it('keeps existing probe records when requesting more', async () => {
        const model = scripted({});
        r = await rig('petstore.yaml', model);

        const first = await synth(
            r,
            {
                collection: 'users',
                type: 'User',
                idField: 'user_id',
                min: 60,
                count: 60,
            },
            true,
        );

        expect(first).toHaveLength(60);

        const before = r.store.collection('users').all();
        const originalIds = new Set(before.map((record) => String(record.user_id)));

        await synth(
            r,
            {
                collection: 'users',
                type: 'User',
                idField: 'user_id',
                min: 120,
                count: 120,
            },
            true,
        );

        const after = r.store.collection('users').all();

        expect(after).toHaveLength(120);

        for (const id of originalIds) {
            expect(r.store.collection('users').has(id)).toBe(true);
        }

        expect(new Set(after.map((record) => String(record.user_id))).size).toBe(120);

        expect(model.world).toHaveLength(0);
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

    it('keeps count-only probe synthesis additive', async () => {
        const model = scripted({});
        r = await rig('paged.yaml', model);

        const request = {
            collection: 'machines',
            type: 'Machine',
            idField: 'id',
            count: 2,
        };

        const first = await synth(r, request, true);
        const second = await synth(r, request, true);

        expect(first).toHaveLength(2);
        expect(second).toHaveLength(2);
        expect(r.store.collection('machines').count()).toBe(4);

        const ids = [...first, ...second].map((record) => record.id);
        expect(new Set(ids).size).toBe(4);
    });

    it('keeps count-only fallback synthesis additive', async () => {
        const model = scripted({
            world: () => say('Unable to generate records.'),
        });

        r = await rig('paged.yaml', model);

        const request = {
            collection: 'machines',
            type: 'Machine',
            idField: 'id',
            count: 2,
        };

        const first = await synth(r, request);
        const second = await synth(r, request);

        expect(first).toHaveLength(2);
        expect(second).toHaveLength(2);
        expect(r.store.collection('machines').count()).toBe(4);

        const ids = [...first, ...second].map((record) => record.id);
        expect(new Set(ids).size).toBe(4);
    });

    it('generates 400 unique schema-valid machine records', async () => {
        const model = scripted({});
        r = await rig('paged.yaml', model);

        const records = await synth(
            r,
            {
                collection: 'machines',
                type: 'Machine',
                idField: 'id',
                min: 400,
                count: 400,
            },
            true,
        );

        expect(records).toHaveLength(400);
        expect(r.store.collection('machines').count()).toBe(400);

        const ids = records.map((record) => record.id);
        expect(new Set(ids).size).toBe(400);

        const validate = r.catalog.validator('Machine');
        expect(validate).toBeDefined();
        for (const record of records) {
            expect(validate!(record)).toBe(true);
        }
    });

    it('generates 120 unique schema-valid numeric IDs', async () => {
        const model = scripted({});
        r = await rig('petstore.yaml', model);

        const records = await synth(
            r,
            {
                collection: 'users',
                type: 'User',
                idField: 'user_id',
                min: 120,
                count: 120,
            },
            true,
        );

        expect(records).toHaveLength(120);

        const ids = records.map((record) => record.user_id);

        expect(ids.every((id) => typeof id === 'number')).toBe(true);
        expect(new Set(ids).size).toBe(120);

        const validate = r.catalog.validator('User');
        expect(validate).toBeDefined();
        expect(records.every((record) => validate!(record))).toBe(true);
    });
});
