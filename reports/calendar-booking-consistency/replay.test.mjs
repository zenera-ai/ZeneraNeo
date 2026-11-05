import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import insert from './fixtures/insert-original.mjs';
import list from './fixtures/list-original.mjs';
import get from './fixtures/get-original.mjs';

const capture = JSON.parse(readFileSync(new URL('./capture.json', import.meta.url), 'utf8'));

// This is an in-memory handler replay, not a running Gym instance. Existing
// records are returned without synthesis. No network or model calls are made.
function context() {
    const records = new Map(
        capture.beforeCreate.records
            .filter((row) => row.collection === 'events')
            .map((row) => [row.id, structuredClone(row.data)]),
    );
    const owner = capture.beforeCreate.records.find((row) => row.collection === 'accounts').data;
    const ctx = {
        owner: async () => structuredClone(owner),
        now: () => capture.create.response.body.created,
        newId: () => capture.create.response.body.id,
        db: {
            collection(type) {
                assert.equal(type, 'Event');
                return {
                    async put(id, value) {
                        records.set(id, structuredClone(value));
                    },
                };
            },
        },
        async ensure(type, options) {
            assert.equal(type, 'Event');
            return [...records.values()].filter(
                (row) => row.calendarId === options.where.calendarId,
            );
        },
        async lookup(type, id) {
            assert.equal(type, 'Event');
            assert.ok(records.has(id), 'This replay only permits lookup of an existing ID');
            return structuredClone(records.get(id));
        },
        async synthesize() {
            throw new Error('Read verification must not synthesize a record');
        },
        page(items) {
            return { items: items.slice(0, 20) };
        },
    };
    return { records, ctx, owner };
}

const listRequest = (calendarId = 'primary') => ({
    pathParams: { calendarId },
    query: { ...capture.list.request.query },
});

test('captured handler bytes match the recorded source fingerprints', () => {
    for (const name of ['insert', 'list', 'get']) {
        const source = readFileSync(new URL(`./fixtures/${name}-original.mjs`, import.meta.url));
        assert.equal(
            createHash('sha256').update(source).digest('hex'),
            capture.provenance.handlerSha256[name],
        );
    }
});

test('captured encoded request targets agree with the reported paths and query fields', () => {
    for (const name of ['create', 'list', 'get']) {
        const request = capture[name].request;
        const target = new URL(request.target, 'http://capture.invalid');
        assert.equal(target.pathname, request.path);
        assert.equal(new Set(target.searchParams.keys()).size, [...target.searchParams].length);
        assert.deepEqual(Object.fromEntries(target.searchParams), request.query);
    }
});

test('observed create persists the event but the captured list omits it', async () => {
    const { records, ctx } = context();
    const initial = structuredClone([...records]);
    const returned = await insert(
        { pathParams: { calendarId: 'primary' }, body: capture.create.request.body },
        ctx,
    );

    // Observe storage before calling a read handler, so reads cannot manufacture
    // the evidence that the create was supposed to persist.
    assert.equal(records.size, initial.length + 1);
    assert.deepEqual(
        JSON.parse(JSON.stringify(records.get(returned.id))),
        capture.create.response.body,
    );
    assert.equal(Object.hasOwn(records.get(returned.id), 'calendarId'), false);
    const storedBeforeList = structuredClone([...records]);

    const result = await list(listRequest(), ctx);
    assert.deepEqual(result.items, []);
    assert.deepEqual([...records], storedBeforeList);
    for (const [id, value] of initial) assert.deepEqual(records.get(id), value);
});

test('calendar association control restores visibility in a copy and excludes another calendar', async () => {
    const { records, ctx, owner } = context();
    const returned = await insert(
        { pathParams: { calendarId: 'primary' }, body: capture.create.request.body },
        ctx,
    );
    const unmodified = structuredClone(records.get(returned.id));
    records.set(returned.id, { ...unmodified, calendarId: owner.id });

    const result = await list(listRequest(), ctx);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].id, returned.id);
    assert.equal((await list(listRequest('another-calendar'), ctx)).items.length, 0);
    assert.equal(Object.hasOwn(unmodified, 'calendarId'), false);
});

test('the captured GET retrieves the existing ID but does not establish calendar membership', async () => {
    const { records, ctx } = context();
    const returned = await insert(
        { pathParams: { calendarId: 'primary' }, body: capture.create.request.body },
        ctx,
    );
    const before = structuredClone([...records]);

    const primary = await get({ pathParams: { calendarId: 'primary', eventId: returned.id } }, ctx);
    const other = await get(
        { pathParams: { calendarId: 'another-calendar', eventId: returned.id } },
        ctx,
    );
    assert.deepEqual(primary, returned);
    assert.deepEqual(other, returned);
    assert.deepEqual([...records], before);
});
