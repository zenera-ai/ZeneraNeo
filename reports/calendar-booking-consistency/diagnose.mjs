import { readFile } from 'node:fs/promises';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = (value) =>
    Array.isArray(value)
        ? `[${value.map(canonical).join(',')}]`
        : object(value)
          ? `{${Object.keys(value)
                .sort()
                .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
                .join(',')}}`
          : JSON.stringify(value);
const equal = (a, b) => canonical(a) === canonical(b);

// This diagnostic supports timed events with explicit RFC 3339 offsets, not all-day
// events, recurrence expansion, leap seconds, or IANA time-zone rule validation.
function instant(value) {
    if (typeof value !== 'string') return NaN;
    const parts =
        /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/i.exec(
            value,
        );
    if (!parts) return NaN;
    const [, year, month, day, hour, minute, second, fraction = '', offset] = parts;
    const local = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}${fraction}Z`);
    if (
        local.getUTCFullYear() !== +year ||
        local.getUTCMonth() + 1 !== +month ||
        local.getUTCDate() !== +day ||
        +hour > 23 ||
        +minute > 59 ||
        +second > 59 ||
        (offset.toUpperCase() !== 'Z' && (+offset.slice(1, 3) > 23 || +offset.slice(4) > 59))
    )
        return NaN;
    return Date.parse(value);
}

function route(path, withId) {
    if (typeof path !== 'string') return null;
    const match = (
        withId ? /^\/calendars\/([^/?#]+)\/events\/([^/?#]+)$/ : /^\/calendars\/([^/?#]+)\/events$/
    ).exec(path);
    if (!match) return null;
    try {
        return match.slice(1).map(decodeURIComponent);
    } catch {
        return null;
    }
}

/** Compare captured evidence only. This function performs no I/O and changes no input. */
export function diagnose(capture) {
    if (!object(capture) || capture.formatVersion !== 1) {
        throw new TypeError('Expected a capture object with formatVersion 1.');
    }
    const findings = [];
    const readFailures = [];
    const evidence = { eventCollection: 'events', httpStatuses: {} };
    const intervals = {};
    const flag = (code, message) => findings.push({ code, message });
    const result = (verdict, summary) => ({
        formatVersion: 1,
        verdict,
        summary,
        findings: [...findings, ...readFailures],
        evidence,
    });
    const inconclusive = () =>
        result(
            'inconclusive',
            'The capture cannot establish a stable, matching create/list/get comparison.',
        );

    for (const name of ['create', 'list', 'get']) {
        const exchange = capture[name];
        if (exchange == null || exchange.request == null || exchange.response == null) {
            flag('missing_capture', `The ${name} request or response is missing.`);
            continue;
        }
        if (!object(exchange) || !object(exchange.request) || !object(exchange.response)) {
            throw new TypeError('Each exchange must contain request and response objects.');
        }
        const { request, response } = exchange;
        const start = instant(exchange.startedAt);
        if (
            !Number.isFinite(start) ||
            typeof exchange.elapsedMs !== 'number' ||
            !Number.isFinite(exchange.elapsedMs) ||
            exchange.elapsedMs < 0 ||
            !Number.isFinite(start + exchange.elapsedMs)
        ) {
            flag(
                'invalid_request_time',
                `The ${name} request needs a valid startedAt and finite nonnegative elapsedMs.`,
            );
        } else intervals[name] = { start, end: start + exchange.elapsedMs };
        if (
            typeof request.method !== 'string' ||
            typeof request.path !== 'string' ||
            !Number.isInteger(response.status) ||
            response.status < 100 ||
            response.status > 599
        ) {
            throw new TypeError(
                'Request method/path and integer HTTP status from 100 through 599 are required.',
            );
        }
        evidence.httpStatuses[name] = response.status;
        if (request.query === undefined) {
            flag('missing_query', `The ${name} request query was not captured.`);
        } else if (!object(request.query)) {
            throw new TypeError('Request query must be an object.');
        }
        // Preserve wire evidence when available. Parsed fields must not conceal a
        // different time window, path, duplicate parameter, or response body.
        if (request.target !== undefined) {
            try {
                if (
                    typeof request.target !== 'string' ||
                    !request.target.startsWith('/') ||
                    request.target.startsWith('//') ||
                    /[#\\]/.test(request.target)
                )
                    throw new Error('Expected an origin-relative request target.');
                const target = new URL(request.target, 'http://capture.invalid');
                const pairs = [...target.searchParams];
                const parsedQuery = Object.fromEntries(
                    Object.entries(request.query ?? {}).map(([key, value]) => [key, String(value)]),
                );
                if (
                    target.pathname !== request.path ||
                    new Set(pairs.map(([key]) => key)).size !== pairs.length ||
                    !equal(Object.fromEntries(pairs), parsedQuery)
                )
                    flag(
                        'wire_request_mismatch',
                        `The ${name} encoded target disagrees with the parsed path or query, or repeats a query key.`,
                    );
            } catch {
                flag(
                    'invalid_wire_request',
                    `The ${name} encoded target is not a supported origin-relative request target.`,
                );
            }
        }
        if (response.bodyText !== undefined) {
            try {
                if (typeof response.bodyText !== 'string') throw new Error('Expected text.');
                if (!equal(JSON.parse(response.bodyText), response.body))
                    flag(
                        'wire_response_mismatch',
                        `The ${name} raw response text disagrees with its parsed body.`,
                    );
            } catch {
                flag(
                    'invalid_wire_response',
                    `The ${name} raw response text is not valid JSON text.`,
                );
            }
        }
        if (response.status !== 200) {
            const issue = {
                code: 'http_status',
                message: `The ${name} response is not the contract's completed HTTP 200 response.`,
            };
            (name === 'create' ? findings : readFailures).push(issue);
        }
        if (!object(response.body))
            flag('invalid_body', `The ${name} response body is not an object.`);
    }

    const snapshots = {};
    for (const name of ['beforeCreate', 'beforeRead', 'afterList', 'afterRead']) {
        const snapshot = capture[name];
        if (snapshot == null) {
            if (name === 'beforeRead' || name === 'afterRead')
                flag('missing_snapshot', `The ${name} database snapshot is missing.`);
            continue;
        }
        if (!object(snapshot) || !Array.isArray(snapshot.records)) {
            throw new TypeError('Each snapshot must contain a records array.');
        }
        if (snapshot.complete !== true)
            flag('incomplete_snapshot', `The ${name} database snapshot is not declared complete.`);
        const time = instant(snapshot.observedAt);
        if (!Number.isFinite(time))
            flag(
                'invalid_snapshot_time',
                `The ${name} observation time is missing or unsupported.`,
            );
        const keys = new Set();
        const records = snapshot.records.map((row) => {
            if (
                !object(row) ||
                typeof row.collection !== 'string' ||
                row.collection.length === 0 ||
                !['string', 'number'].includes(typeof row.id) ||
                !object(row.data) ||
                typeof row.updated_at !== 'string'
            ) {
                throw new TypeError(
                    'Snapshot rows require collection, id, object data, and updated_at.',
                );
            }
            const key = canonical([row.collection, row.id]);
            if (keys.has(key))
                flag('duplicate_record', `The ${name} snapshot repeats a collection and row ID.`);
            keys.add(key);
            return {
                collection: row.collection,
                id: row.id,
                data: row.data,
                updated_at: row.updated_at,
            };
        });
        snapshots[name] = { time, records, signature: records.map(canonical).sort() };
    }
    const responseId = capture.create?.response?.body?.id;
    if (typeof responseId === 'string' && responseId.length) {
        for (const name of ['beforeCreate', 'beforeRead', 'afterList', 'afterRead']) {
            if (snapshots[name])
                evidence[`${name}Matches`] = snapshots[name].records.filter(
                    (row) =>
                        row.collection === 'events' &&
                        (row.id === responseId || row.data.id === responseId),
                ).length;
        }
    }
    const ordered = ['beforeCreate', 'beforeRead', 'afterList', 'afterRead'].filter(
        (name) => snapshots[name],
    );
    for (let i = 1; i < ordered.length; i++) {
        if (snapshots[ordered[i]].time < snapshots[ordered[i - 1]].time) {
            flag('snapshot_order', 'Database observation times are out of order.');
        }
    }
    if (snapshots.beforeRead && snapshots.afterRead) {
        evidence.databaseUnchanged =
            equal(snapshots.beforeRead.signature, snapshots.afterRead.signature) &&
            (!snapshots.afterList ||
                equal(snapshots.beforeRead.signature, snapshots.afterList.signature));
        if (!evidence.databaseUnchanged)
            flag(
                'database_changed',
                'Database records changed during the read observations. This can include read-time synthesis.',
            );
    }
    // This ordering check assumes the capture's HTTP and snapshot clocks are comparable.
    if (
        intervals.create &&
        intervals.list &&
        intervals.get &&
        snapshots.beforeRead &&
        snapshots.afterRead
    ) {
        evidence.requestSnapshotOrderMatches =
            intervals.create.end <= snapshots.beforeRead.time &&
            intervals.list.start >= snapshots.beforeRead.time &&
            intervals.get.start >= snapshots.beforeRead.time &&
            intervals.list.end <= intervals.get.start &&
            intervals.get.end <= snapshots.afterRead.time &&
            intervals.list.end <= snapshots.afterRead.time &&
            (!snapshots.beforeCreate || snapshots.beforeCreate.time <= intervals.create.start) &&
            (!snapshots.afterList ||
                (intervals.list.end <= snapshots.afterList.time &&
                    snapshots.afterList.time <= intervals.get.start));
        if (!evidence.requestSnapshotOrderMatches)
            flag(
                'request_snapshot_order',
                'Request intervals do not fit the create, snapshot, list, GET, snapshot sequence on a common clock.',
            );
    }
    // Stop before using incomplete or malformed exchange shapes.
    if (findings.length) return inconclusive();

    const created = capture.create.response.body;
    const listed = capture.list.response.body;
    const got = capture.get.response.body;
    const input = capture.create.request.body;
    const id = created.id;
    if (typeof id !== 'string' || !id.length)
        flag('missing_event_id', 'The create response has no nonempty event ID.');
    else evidence.eventId = id;
    if (!['confirmed', 'tentative'].includes(created.status))
        flag(
            'unsupported_status',
            'Only confirmed or tentative events are supported. Default list visibility of other statuses is ambiguous.',
        );
    if (!object(input))
        flag('missing_create_body', 'The create request body is missing or is not an object.');
    else {
        evidence.requestMatchesCreateResponse = Object.keys(input).every((key) =>
            equal(input[key], created[key]),
        );
        if (!evidence.requestMatchesCreateResponse)
            flag(
                'create_body_mismatch',
                'The create response does not exactly retain the submitted fields.',
            );
    }

    const createRoute = route(capture.create.request.path, false);
    const listRoute = route(capture.list.request.path, false);
    const getRoute = route(capture.get.request.path, true);
    evidence.calendarPathsMatch = Boolean(
        createRoute &&
        listRoute &&
        getRoute &&
        createRoute[0] === listRoute[0] &&
        createRoute[0] === getRoute[0],
    );
    if (
        !evidence.calendarPathsMatch ||
        capture.create.request.method !== 'POST' ||
        capture.list.request.method !== 'GET' ||
        capture.get.request.method !== 'GET'
    ) {
        flag(
            'request_scope_mismatch',
            'Requests do not target the supported operations on the same decoded calendar ID. Calendar aliases are not assumed equivalent.',
        );
    }
    if (!getRoute || getRoute[1] !== id || (capture.get.response.status === 200 && got.id !== id))
        flag('get_id_mismatch', 'The GET request or response identifies a different event.');
    evidence.getBodyMatchesCreateResponse =
        capture.get.response.status === 200 ? equal(got, created) : null;
    if (evidence.getBodyMatchesCreateResponse === false)
        flag('get_body_mismatch', 'The GET response differs from the complete create response.');

    const query = capture.list.request.query;
    if (query.pageToken !== undefined && query.pageToken !== '')
        flag('partial_list', 'The list request starts from a page token.');
    if (
        capture.list.response.status === 200 &&
        listed.nextPageToken !== undefined &&
        listed.nextPageToken !== ''
    )
        flag(
            'partial_list',
            'The list response indicates another page or has an invalid continuation token.',
        );
    if (query.q !== undefined && query.q !== '')
        flag('filtered_list', 'A text filter prevents this diagnostic from proving list omission.');
    const knownQuery = new Set(['timeMin', 'timeMax', 'pageToken', 'q', 'maxResults', 'orderBy']);
    if (
        Object.keys(query).some((key) => !knownQuery.has(key)) ||
        Object.keys(capture.create.request.query).length ||
        Object.keys(capture.get.request.query).length
    ) {
        flag(
            'unsupported_query',
            'The capture uses query parameters outside this diagnostic scope.',
        );
    }
    if (
        (query.orderBy !== undefined && !['startTime', 'updated'].includes(query.orderBy)) ||
        (query.maxResults !== undefined &&
            (!['string', 'number'].includes(typeof query.maxResults) ||
                !/^(?:[1-9]\d*)$/.test(String(query.maxResults)) ||
                Number(query.maxResults) > 2500))
    ) {
        flag('invalid_query', 'The captured ordering or page size is invalid.');
    }

    const start = instant(created.start?.dateTime);
    const end = instant(created.end?.dateTime);
    const lower = instant(query.timeMin);
    const upper = instant(query.timeMax);
    if (![start, end, lower, upper].every(Number.isFinite) || start >= end || lower >= upper) {
        flag(
            'invalid_time_window',
            'A positive timed event and list window with explicit RFC 3339 offsets are required. Precision above milliseconds is unsupported.',
        );
    } else {
        evidence.windowOverlapsEvent = end > lower && start < upper;
        if (!evidence.windowOverlapsEvent)
            flag(
                'event_outside_window',
                'The event does not overlap the list window using its exclusive bounds.',
            );
    }
    if (
        created.start?.date !== undefined ||
        created.end?.date !== undefined ||
        (created.recurrence !== undefined &&
            (!Array.isArray(created.recurrence) || created.recurrence.length))
    ) {
        flag(
            'unsupported_event',
            'All-day and recurring events are outside this diagnostic scope.',
        );
    }

    if (capture.list.response.status !== 200) {
        evidence.listMatches = null;
        evidence.listBodyMatchesCreateResponse = null;
    } else if (!Array.isArray(listed.items))
        flag('missing_list_items', 'The list response has no items array.');
    else {
        const ids = new Set();
        // A full-sized page without a continuation token may be truncated by a
        // faulty mock. The captured handler's default is 20, not a universal API default.
        const pageSize = query.maxResults === undefined ? 20 : Number(query.maxResults);
        if (listed.items.length >= pageSize)
            flag(
                'list_at_capacity',
                'The list reaches its requested or captured default page size. A missing token alone cannot prove completeness.',
            );
        for (const item of listed.items) {
            if (!object(item) || typeof item.id !== 'string' || !item.id.length) {
                flag('invalid_list_item', 'A list item has no nonempty event ID.');
                continue;
            }
            if (ids.has(item.id))
                flag('duplicate_list_id', 'The list contains a duplicate event ID.');
            ids.add(item.id);
        }
        const matches = listed.items.filter((item) => object(item) && item.id === id);
        evidence.listMatches = matches.length;
        evidence.listBodyMatchesCreateResponse =
            matches.length === 1 ? equal(matches[0], created) : null;
        if (matches.length === 1 && !evidence.listBodyMatchesCreateResponse)
            flag(
                'list_body_mismatch',
                'The listed event has the created ID but a different complete body.',
            );
    }

    const matches = (name) =>
        snapshots[name]?.records.filter(
            (row) => row.collection === 'events' && (row.id === id || row.data.id === id),
        ) ?? [];
    const before = matches('beforeRead');
    const after = matches('afterRead');
    evidence.beforeReadMatches = before.length;
    evidence.afterReadMatches = after.length;
    const foreignMatches = (name) =>
        snapshots[name].records.filter(
            (row) => row.collection !== 'events' && (row.id === id || row.data.id === id),
        ).length;
    evidence.beforeReadOtherCollectionMatches = foreignMatches('beforeRead');
    evidence.afterReadOtherCollectionMatches = foreignMatches('afterRead');
    if (
        before.length === 0 &&
        (evidence.beforeReadOtherCollectionMatches || evidence.afterReadOtherCollectionMatches)
    ) {
        flag(
            'collection_ambiguous',
            'The event ID appears outside the events collection. This capture does not establish the collection binding.',
        );
    }
    if (before.length > 1 || after.length > 1)
        flag('ambiguous_record_id', 'More than one database row matches the event ID.');
    if (
        before.some((row) => row.id !== id || row.data.id !== id) ||
        after.some((row) => row.id !== id || row.data.id !== id)
    ) {
        flag('record_id_mismatch', 'A matching database row has inconsistent row and body IDs.');
    }
    evidence.storedBodyMatchesCreateResponse =
        before.length === 1 ? equal(before[0].data, created) : null;
    if (before.length === 1 && !evidence.storedBodyMatchesCreateResponse)
        flag('stored_body_mismatch', 'The stored event differs from the complete create response.');
    if (before.length === 1)
        evidence.storedCalendarIdPresent = Object.hasOwn(before[0].data, 'calendarId');
    if (snapshots.beforeCreate) {
        evidence.absentBeforeCreate = matches('beforeCreate').length === 0;
        if (!evidence.absentBeforeCreate)
            flag(
                'preexisting_event_id',
                'The event ID already existed before the captured create.',
            );
    }
    if (
        before.length === 0 &&
        (!snapshots.beforeCreate ||
            !equal(snapshots.beforeCreate.signature, snapshots.beforeRead.signature))
    )
        flag(
            'unexplained_row_change',
            'Snapshot absence requires an unchanged pre-create baseline. Otherwise a different ID, changed world or wrong database remains possible.',
        );
    if (findings.length) return inconclusive();
    if (before.length === 0) {
        if (capture.get.response.status === 200 || evidence.listMatches > 0) {
            flag(
                'conflicting_presence',
                'A read returns the event but the supplied database snapshots do not contain it. Verify store identity, caches and read-time synthesis.',
            );
            return inconclusive();
        }
        return result(
            'absent_from_snapshots',
            'The supplied complete snapshots contain no matching event and retain the pre-create baseline. This is conditional on observing the authoritative serving store. It does not establish whether a row existed between snapshots.',
        );
    }
    if (readFailures.length) return inconclusive();
    if (evidence.listMatches === 1)
        return result(
            'visible',
            'The event is stored unchanged and appears with the same complete body in list and GET.',
        );
    return result(
        'persisted_omitted_from_list',
        'The event is stored unchanged and GET returns the same body, but the complete matching list omits its ID. Omission does not mean deletion.',
    );
}

if (import.meta.main) {
    try {
        if (process.argv.length !== 3) throw new TypeError('Usage: node diagnose.mjs capture.json');
        if (process.argv[2] === '--help') {
            console.log(
                JSON.stringify({
                    usage: 'node diagnose.mjs capture.json',
                    input: 'formatVersion 1 saved JSON capture',
                    network: false,
                    writes: false,
                }),
            );
        } else {
            const capture = JSON.parse(await readFile(process.argv[2], 'utf8'));
            console.log(JSON.stringify(diagnose(capture), null, 2));
        }
    } catch (error) {
        console.error(
            JSON.stringify({
                error: 'invalid_input',
                message:
                    error instanceof TypeError
                        ? error.message
                        : 'Could not read and diagnose a valid JSON capture.',
            }),
        );
        process.exitCode = 2;
    }
}
