import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { diagnose } from './diagnose.mjs';

const saved = JSON.parse(await readFile(new URL('./capture.json', import.meta.url), 'utf8'));
// Most probes vary normalized evidence. Wire-consistency probes explicitly keep
// the redundant raw fields so a mismatch cannot mask the condition under test.
const fresh = (withWire = false) => {
    const capture = structuredClone(saved);
    if (!withWire) {
        for (const name of ['create', 'list', 'get']) {
            delete capture[name].request.target;
            delete capture[name].response.bodyText;
        }
    }
    return capture;
};
const target = (capture, name = 'beforeRead') =>
    capture[name].records.find((row) => row.id === capture.create.response.body.id);
const removeEvent = (capture) => {
    for (const name of ['beforeRead', 'afterList', 'afterRead']) {
        capture[name].records = capture[name].records.filter(
            (row) => row.id !== capture.create.response.body.id,
        );
    }
};
const notFound = (capture) => {
    capture.get.response = { status: 404, body: { error: 'Event not found' } };
};
const expectIssue = (change, code) => {
    const capture = fresh();
    change(capture);
    const result = diagnose(capture);
    assert.equal(result.verdict, 'inconclusive');
    assert.ok(
        result.findings.some((item) => item.code === code),
        JSON.stringify(result),
    );
    return result;
};

test('actual capture proves stable persistence and omission without changing input', () => {
    const capture = fresh(true);
    const before = JSON.stringify(capture);
    const result = diagnose(capture);
    assert.equal(result.verdict, 'persisted_omitted_from_list');
    assert.equal(result.evidence.storedBodyMatchesCreateResponse, true);
    assert.equal(result.evidence.getBodyMatchesCreateResponse, true);
    assert.equal(result.evidence.databaseUnchanged, true);
    assert.equal(result.evidence.absentBeforeCreate, true);
    assert.equal(result.evidence.storedCalendarIdPresent, false);
    assert.equal(result.evidence.listMatches, 0);
    assert.equal(JSON.stringify(capture), before);
});

const expectWireIssue = (change, code) => {
    const capture = fresh(true);
    change(capture);
    const result = diagnose(capture);
    assert.equal(result.verdict, 'inconclusive');
    assert.ok(
        result.findings.some((item) => item.code === code),
        JSON.stringify(result),
    );
};
test('raw request time window cannot contradict parsed query fields', () =>
    expectWireIssue((c) => {
        c.list.request.target = c.list.request.target.replaceAll('2026-11-06', '2026-11-07');
    }, 'wire_request_mismatch'));
test('an unescaped plus in the wire offset cannot pass as an encoded plus', () =>
    expectWireIssue((c) => {
        c.list.request.target = c.list.request.target.replaceAll('%2B', '+');
    }, 'wire_request_mismatch'));
test('raw request calendar must match the parsed path', () =>
    expectWireIssue((c) => {
        c.list.request.target = c.list.request.target.replace('/primary/', '/another/');
    }, 'wire_request_mismatch'));
test('duplicate wire query keys are ambiguous even if the final value matches', () =>
    expectWireIssue((c) => {
        c.list.request.target += '&timeMin=' + encodeURIComponent(c.list.request.query.timeMin);
    }, 'wire_request_mismatch'));
for (const target of [
    null,
    'https://example.com/calendars/primary/events',
    '//example.com/events',
    '/events#fragment',
]) {
    test(`unsupported wire target ${String(target)} is inconclusive`, () =>
        expectWireIssue((c) => {
            c.list.request.target = target;
        }, 'invalid_wire_request'));
}
test('raw response JSON cannot contradict the parsed event', () =>
    expectWireIssue((c) => {
        c.get.response.bodyText = '{"id":"different"}';
    }, 'wire_response_mismatch'));
test('invalid raw response text is inconclusive', () =>
    expectWireIssue((c) => {
        c.get.response.bodyText = 'not JSON';
    }, 'invalid_wire_response'));
test('raw JSON formatting differences do not change the result', () => {
    const capture = fresh(true);
    capture.get.response.bodyText = JSON.stringify(capture.get.response.body);
    assert.equal(diagnose(capture).verdict, 'persisted_omitted_from_list');
});

test('a matching visible event passes', () => {
    const capture = fresh();
    capture.list.response.body.items.push(structuredClone(capture.create.response.body));
    assert.equal(diagnose(capture).verdict, 'visible');
});

test('GET success conflicts with absence from supplied snapshots', () => {
    const capture = fresh();
    removeEvent(capture);
    const result = diagnose(capture);
    assert.equal(result.verdict, 'inconclusive');
    assert.ok(result.findings.some((item) => item.code === 'conflicting_presence'));
});

test('a missing row and GET 404 establish snapshot absence with explicit facts', () => {
    const capture = fresh();
    removeEvent(capture);
    notFound(capture);
    const result = diagnose(capture);
    assert.equal(result.verdict, 'absent_from_snapshots');
    assert.equal(result.evidence.beforeReadMatches, 0);
    assert.equal(result.evidence.afterReadMatches, 0);
    assert.equal(result.evidence.beforeReadOtherCollectionMatches, 0);
    assert.equal(result.evidence.afterReadOtherCollectionMatches, 0);
    assert.equal(result.evidence.databaseUnchanged, true);
    assert.equal(result.evidence.httpStatuses.get, 404);
    assert.equal(result.evidence.getBodyMatchesCreateResponse, null);
    assert.ok(result.findings.some((item) => item.code === 'http_status'));
});

test('read HTTP failures do not erase valid snapshot absence', () => {
    const capture = fresh();
    removeEvent(capture);
    notFound(capture);
    capture.list.response = { status: 500, body: { error: 'Internal error' } };
    const result = diagnose(capture);
    assert.equal(result.verdict, 'absent_from_snapshots');
    assert.equal(result.evidence.listMatches, null);
    assert.equal(result.evidence.httpStatuses.list, 500);
});

test('a listed event conflicts with absent snapshots even when GET fails', () =>
    expectIssue((c) => {
        removeEvent(c);
        notFound(c);
        c.list.response.body.items.push(structuredClone(c.create.response.body));
    }, 'conflicting_presence'));
for (const pageSize of [1, 20]) {
    test(`a full page of ${pageSize} unrelated items without a token is inconclusive`, () =>
        expectIssue((c) => {
            if (pageSize === 1) c.list.request.query.maxResults = 1;
            c.list.response.body.items = Array.from({ length: pageSize }, (_, i) => ({
                ...structuredClone(c.create.response.body),
                id: `other${i}`,
            }));
        }, 'list_at_capacity'));
}
test('changed snapshots still expose before and after event counts', () => {
    const result = expectIssue((c) => {
        c.beforeRead.records = c.beforeRead.records.filter(
            (row) => row.id !== c.create.response.body.id,
        );
    }, 'database_changed');
    assert.equal(result.evidence.beforeReadMatches, 0);
    assert.equal(result.evidence.afterReadMatches, 1);
});
for (const name of ['create', 'list', 'get']) {
    test(`wrong ${name} HTTP method is inconclusive`, () =>
        expectIssue((c) => {
            c[name].request.method = 'DELETE';
        }, 'request_scope_mismatch'));
}
test('a failed create with absent snapshots cannot establish successful creation', () =>
    expectIssue((c) => {
        removeEvent(c);
        notFound(c);
        c.create.response.status = 500;
    }, 'http_status'));
for (const name of ['create', 'list', 'get']) {
    test(`unknown ${name} query parameters are inconclusive`, () =>
        expectIssue((c) => {
            c[name].request.query.unknown = 'filter';
        }, 'unsupported_query'));
}
test('invalid ordering is inconclusive', () =>
    expectIssue((c) => {
        c.list.request.query.orderBy = 'name';
    }, 'invalid_query'));
test('an all-day date cannot silently coexist with a timed-event diagnosis', () =>
    expectIssue((c) => {
        c.create.response.body.start.date = '2026-11-06';
    }, 'unsupported_event'));
test('a list item without an ID is inconclusive', () =>
    expectIssue((c) => {
        c.list.response.body.items.push({ summary: 'Missing ID' });
    }, 'invalid_list_item'));

for (const collection of ['events', 'other']) {
    test(`a new row with a different ID in ${collection} prevents a missing-persistence verdict`, () =>
        expectIssue((capture) => {
            notFound(capture);
            for (const name of ['beforeRead', 'afterList', 'afterRead']) {
                const row = target(capture, name);
                row.id = 'different-saved-id';
                row.data.id = row.id;
                row.collection = collection;
            }
        }, 'unexplained_row_change'));
}
test('a different saved ID appearing in the list is inconclusive', () =>
    expectIssue((capture) => {
        notFound(capture);
        for (const name of ['beforeRead', 'afterList', 'afterRead']) {
            const row = target(capture, name);
            row.id = 'different-saved-id';
            row.data.id = row.id;
        }
        capture.list.response.body.items.push(
            structuredClone(
                capture.beforeRead.records.find((row) => row.id === 'different-saved-id').data,
            ),
        );
    }, 'unexplained_row_change'));
test('an empty database after a populated baseline is inconclusive', () =>
    expectIssue((capture) => {
        notFound(capture);
        for (const name of ['beforeRead', 'afterList', 'afterRead']) capture[name].records = [];
    }, 'unexplained_row_change'));
test('disappearing baseline records prevent a missing-persistence verdict', () =>
    expectIssue((capture) => {
        removeEvent(capture);
        notFound(capture);
        for (const name of ['beforeRead', 'afterList', 'afterRead']) capture[name].records.pop();
    }, 'unexplained_row_change'));
test('missing persistence requires a pre-create baseline', () =>
    expectIssue((capture) => {
        removeEvent(capture);
        notFound(capture);
        delete capture.beforeCreate;
    }, 'unexplained_row_change'));

test('GET 404 with an existing stored event is inconclusive and retains row counts', () => {
    const result = expectIssue(notFound, 'http_status');
    assert.equal(result.evidence.beforeReadMatches, 1);
    assert.equal(result.evidence.afterReadMatches, 1);
    assert.equal(result.evidence.storedBodyMatchesCreateResponse, true);
});

test('GET 404 cannot hide a read-created database row', () =>
    expectIssue((capture) => {
        notFound(capture);
        capture.beforeRead.records = capture.beforeRead.records.filter(
            (row) => row.id !== capture.create.response.body.id,
        );
    }, 'database_changed'));

test('snapshot absence plus GET 404 still requires complete evidence and timing', () => {
    expectIssue((capture) => {
        removeEvent(capture);
        notFound(capture);
        capture.afterRead.complete = false;
    }, 'incomplete_snapshot');
    expectIssue((capture) => {
        removeEvent(capture);
        notFound(capture);
        delete capture.get.startedAt;
    }, 'invalid_request_time');
    expectIssue((capture) => {
        removeEvent(capture);
        notFound(capture);
        delete capture.list;
    }, 'missing_capture');
    expectIssue((capture) => {
        removeEvent(capture);
        notFound(capture);
        delete capture.get.response.body;
    }, 'invalid_body');
});

for (const name of ['create', 'list', 'get']) {
    test(`${name} HTTP failure is inconclusive`, () =>
        expectIssue((c) => {
            c[name].response.status = 500;
        }, 'http_status'));
    test(`missing ${name} capture is inconclusive`, () =>
        expectIssue((c) => {
            delete c[name];
        }, 'missing_capture'));
}

test('missing query capture cannot prove first-page completeness', () =>
    expectIssue((c) => {
        delete c.list.request.query;
    }, 'missing_query'));
test('a starting page token prevents omission inference', () =>
    expectIssue((c) => {
        c.list.request.query.pageToken = 'second-page';
    }, 'partial_list'));
test('a remaining page prevents omission inference', () =>
    expectIssue((c) => {
        c.list.response.body.nextPageToken = 'next';
    }, 'partial_list'));
test('a text filter is outside scope', () =>
    expectIssue((c) => {
        c.list.request.query.q = 'different title';
    }, 'filtered_list'));
test('a different calendar is outside scope', () =>
    expectIssue((c) => {
        c.list.request.path = '/calendars/other/events';
    }, 'request_scope_mismatch'));
test('primary and canonical IDs are not assumed equal', () =>
    expectIssue((c) => {
        c.get.request.path = c.get.request.path.replace('/primary/', '/%40me/');
    }, 'request_scope_mismatch'));
test('a different GET path ID is inconclusive', () =>
    expectIssue((c) => {
        c.get.request.path += 'a';
    }, 'get_id_mismatch'));
test('a different GET body is inconclusive', () =>
    expectIssue((c) => {
        c.get.response.body.summary = 'changed';
    }, 'get_body_mismatch'));
test('a different create request is inconclusive', () =>
    expectIssue((c) => {
        c.create.request.body.summary = 'different request';
    }, 'create_body_mismatch'));
test('same listed ID with changed fields is inconclusive', () =>
    expectIssue((c) => {
        c.list.response.body.items = [{ ...c.create.response.body, status: 'cancelled' }];
    }, 'list_body_mismatch'));
test('duplicate list IDs are inconclusive', () =>
    expectIssue((c) => {
        c.list.response.body.items = [c.create.response.body, c.create.response.body];
    }, 'duplicate_list_id'));

test('equivalent query offsets compare as instants', () => {
    const capture = fresh();
    capture.list.request.query.timeMin = '2026-11-06T13:00:00Z';
    capture.list.request.query.timeMax = '2026-11-06T07:45:00-06:00';
    assert.equal(diagnose(capture).verdict, 'persisted_omitted_from_list');
});
test('exclusive end boundary is outside the window', () =>
    expectIssue((c) => {
        c.list.request.query.timeMin = c.create.response.body.end.dateTime;
        c.list.request.query.timeMax = '2026-11-06T20:00:00Z';
    }, 'event_outside_window'));
test('exclusive start boundary is outside the window', () =>
    expectIssue((c) => {
        c.list.request.query.timeMin = '2026-11-06T00:00:00Z';
        c.list.request.query.timeMax = c.create.response.body.start.dateTime;
    }, 'event_outside_window'));
for (const value of [
    '2026-11-06T14:00:00',
    '2026-02-30T14:00:00Z',
    '2026-11-06T24:00:00Z',
    '2026-11-06T13:00:00+24:00',
]) {
    test(`rejects unsupported timestamp ${value}`, () =>
        expectIssue((c) => {
            c.list.request.query.timeMin = value;
        }, 'invalid_time_window'));
}
test('a missing time is inconclusive', () =>
    expectIssue((c) => {
        delete c.list.request.query.timeMin;
    }, 'invalid_time_window'));
test('recurrence is not silently treated as one timed event', () =>
    expectIssue((c) => {
        c.create.response.body.recurrence = ['RRULE:FREQ=DAILY'];
    }, 'unsupported_event'));

test('read-created target is inconclusive', () =>
    expectIssue((c) => {
        c.beforeRead.records = c.beforeRead.records.filter(
            (row) => row.id !== c.create.response.body.id,
        );
    }, 'database_changed'));
test('unrelated database changes also prevent a stable-state verdict', () =>
    expectIssue((c) => {
        c.afterRead.records[0].data.review = true;
    }, 'database_changed'));
test('an intermediate mutation is detected even if later reversed', () =>
    expectIssue((c) => {
        target(c, 'afterList').data.summary = 'temporary change';
    }, 'database_changed'));
test('updated_at changes count as database changes', () =>
    expectIssue((c) => {
        target(c, 'afterRead').updated_at = '2026-11-05T03:14:00Z';
    }, 'database_changed'));
test('metadata outside database rows is not treated as a record mutation', () => {
    const capture = fresh();
    capture.afterRead.reports = [{ changed: true }];
    capture.afterRead.populationMarkers = ['different'];
    capture.afterRead.records.reverse();
    assert.equal(diagnose(capture).verdict, 'persisted_omitted_from_list');
});
test('stable stored body mismatch is inconclusive', () =>
    expectIssue((c) => {
        for (const name of ['beforeRead', 'afterList', 'afterRead'])
            target(c, name).data.summary = 'different';
    }, 'stored_body_mismatch'));
test('an event found only in another collection has an ambiguous binding', () => {
    const capture = fresh();
    for (const name of ['beforeRead', 'afterList', 'afterRead'])
        target(capture, name).collection = 'other';
    const result = diagnose(capture);
    assert.equal(result.verdict, 'inconclusive');
    assert.equal(result.evidence.beforeReadMatches, 0);
    assert.equal(result.evidence.beforeReadOtherCollectionMatches, 1);
    assert.ok(result.findings.some((item) => item.code === 'collection_ambiguous'));
});
test('GET 404 does not resolve a foreign collection binding', () =>
    expectIssue((capture) => {
        notFound(capture);
        for (const name of ['beforeRead', 'afterList', 'afterRead'])
            target(capture, name).collection = 'other';
    }, 'collection_ambiguous'));
test('snapshot absence still rejects a mismatched successful GET body', () =>
    expectIssue((capture) => {
        removeEvent(capture);
        capture.get.response.body.summary = 'different';
    }, 'get_body_mismatch'));
test('a foreign collection cannot make an events row ambiguous', () => {
    const capture = fresh();
    for (const name of ['beforeRead', 'afterList', 'afterRead'])
        capture[name].records.push({ ...target(capture, name), collection: 'other' });
    assert.equal(diagnose(capture).verdict, 'persisted_omitted_from_list');
});
test('duplicate snapshot keys are inconclusive', () =>
    expectIssue((c) => {
        c.beforeRead.records.push(target(c));
    }, 'duplicate_record'));
test('inconsistent row and data IDs are inconclusive', () =>
    expectIssue((c) => {
        for (const name of ['beforeRead', 'afterList', 'afterRead'])
            target(c, name).data.id = 'other';
    }, 'record_id_mismatch'));
test('a preexisting ID is not attributed to this create', () =>
    expectIssue((c) => {
        c.beforeCreate.records.push(structuredClone(target(c)));
    }, 'preexisting_event_id'));
test('missing beforeCreate does not claim the row is new', () => {
    const capture = fresh();
    delete capture.beforeCreate;
    const result = diagnose(capture);
    assert.equal(result.verdict, 'persisted_omitted_from_list');
    assert.equal(result.evidence.absentBeforeCreate, undefined);
});
test('missing and incomplete snapshots are inconclusive', () => {
    expectIssue((c) => {
        delete c.beforeRead;
    }, 'missing_snapshot');
    expectIssue((c) => {
        c.afterRead.complete = false;
    }, 'incomplete_snapshot');
});
test('out-of-order snapshots are inconclusive', () =>
    expectIssue((c) => {
        c.afterRead.observedAt = '2026-11-01T00:00:00Z';
    }, 'snapshot_order'));
test('a pre-read snapshot taken after list is not proof of create persistence', () =>
    expectIssue((c) => {
        c.beforeRead.observedAt = c.list.startedAt;
        c.list.startedAt = '2026-11-05T03:07:20Z';
    }, 'request_snapshot_order'));
test('create must finish before the pre-read snapshot', () =>
    expectIssue((c) => {
        c.create.elapsedMs = 120000;
    }, 'request_snapshot_order'));
test('the final snapshot must be after GET finishes', () =>
    expectIssue((c) => {
        c.get.elapsedMs = 120000;
    }, 'request_snapshot_order'));
test('the list snapshot must follow the list response', () =>
    expectIssue((c) => {
        c.afterList.observedAt = c.list.startedAt;
    }, 'request_snapshot_order'));
test('the list snapshot must precede GET', () =>
    expectIssue((c) => {
        c.afterList.observedAt = c.afterRead.observedAt;
    }, 'request_snapshot_order'));
test('the pre-create snapshot must precede create', () =>
    expectIssue((c) => {
        c.beforeCreate.observedAt = c.beforeRead.observedAt;
    }, 'request_snapshot_order'));
for (const duration of [undefined, null, -1, Infinity, '10']) {
    test(`invalid request duration ${String(duration)} is inconclusive`, () =>
        expectIssue((c) => {
            c.list.elapsedMs = duration;
        }, 'invalid_request_time'));
}
test('a missing request start time is inconclusive', () =>
    expectIssue((c) => {
        delete c.get.startedAt;
    }, 'invalid_request_time'));
for (const status of ['cancelled', 'unknown', undefined]) {
    test(`unsupported event status ${String(status)} is inconclusive`, () =>
        expectIssue((c) => {
            c.create.response.body.status = status;
        }, 'unsupported_status'));
}
test('page sizes above the API cap are inconclusive', () =>
    expectIssue((c) => {
        c.list.request.query.maxResults = 2501;
    }, 'invalid_query'));
test('decoded opaque calendar IDs are compared once', () => {
    const capture = fresh();
    capture.create.request.path = capture.create.request.path.replace('/primary/', '/team%2Fone/');
    capture.list.request.path = capture.list.request.path.replace('/primary/', '/team%2fone/');
    capture.get.request.path = capture.get.request.path.replace('/primary/', '/team%2Fone/');
    assert.equal(diagnose(capture).verdict, 'persisted_omitted_from_list');
});
test('malformed capture schema is rejected', () => {
    assert.throws(() => diagnose(null), TypeError);
    assert.throws(() => diagnose({ formatVersion: 2 }), TypeError);
    const capture = fresh();
    capture.beforeRead.records[0].data = 'not a parsed object';
    assert.throws(() => diagnose(capture), TypeError);
});

test('CLI prints JSON with exit zero for a diagnosed issue', () => {
    const cli = spawnSync(
        process.execPath,
        [
            fileURLToPath(new URL('./diagnose.mjs', import.meta.url)),
            fileURLToPath(new URL('./capture.json', import.meta.url)),
        ],
        { encoding: 'utf8' },
    );
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(cli.stderr, '');
    assert.equal(JSON.parse(cli.stdout).verdict, 'persisted_omitted_from_list');
});
test('CLI rejects missing input with JSON and nonzero exit', () => {
    const cli = spawnSync(
        process.execPath,
        [fileURLToPath(new URL('./diagnose.mjs', import.meta.url))],
        { encoding: 'utf8' },
    );
    assert.equal(cli.status, 2);
    assert.equal(cli.stdout, '');
    assert.equal(JSON.parse(cli.stderr).error, 'invalid_input');
});
