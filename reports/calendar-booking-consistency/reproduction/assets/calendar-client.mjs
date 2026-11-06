#!/usr/bin/env node
// Transport client for the pinned Calendar mock contract. No booking conclusions.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { isIP } from 'node:net';

export const usage = `Calendar mock client (Node 24)

  node calendar-client.mjs list [--calendar ID] [--time-min RFC3339]
      [--time-max RFC3339] [--query TEXT] [--order-by startTime|updated]
      [--max-results 1..2500] [--page-token TOKEN] [--timeout-ms MS]
  node calendar-client.mjs get EVENT_ID [--calendar ID] [--timeout-ms MS]
  node calendar-client.mjs freebusy --body FILE|- [--timeout-ms MS]
  node calendar-client.mjs create --body FILE|- [--calendar ID] [--timeout-ms MS]
  node calendar-client.mjs --help

CALENDAR_API_BASE_URL is required: an HTTP origin using a literal private or
loopback IP, with no credentials, path prefix, query, or fragment. Redirects
are refused. This client does not connect to real calendar providers.
Calendar defaults to primary. Deadline defaults to 180000 ms (maximum 300000).
FILE contains JSON; - reads JSON from stdin. No automatic retries or paging.

freebusy body: {"timeMin":"...","timeMax":"...","items":[{"id":"primary"}]}
create body: {"summary":"...","start":{"dateTime":"...","timeZone":"..."},
  "end":{"dateTime":"...","timeZone":"..."},
  "attendees":[{"email":"...","responseStatus":"needsAction"}]}
Attendees are optional; each supplied attendee requires email and responseStatus.
All four operations expect HTTP 200 according to the pinned contract.
Output records the request, actual status, response text and parsed JSON.
Exit 0 means HTTP 200 with a JSON object, not proof of booking or persistence.
Response fields are preserved, not normalized or fully schema-validated.
`;

class ClientError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
function requireThat(condition, message) {
    if (!condition) throw new ClientError('invalid_input', message);
}
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function text(value, field) {
    requireThat(
        typeof value === 'string' && value.length > 0,
        `${field} must be a nonempty string.`,
    );
}
function dateTime(value, field) {
    text(value, field);
    requireThat(
        /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/.test(value) &&
            Number.isFinite(Date.parse(value)),
        `${field} must be an RFC 3339 date-time with an offset.`,
    );
}
function when(value, field) {
    requireThat(object(value), `${field} must be an object.`);
    dateTime(value.dateTime, `${field}.dateTime`);
    if (value.timeZone !== undefined)
        requireThat(typeof value.timeZone === 'string', `${field}.timeZone must be a string.`);
}
function bodyShape(operation, body) {
    requireThat(object(body), 'The request body must be a JSON object.');
    if (operation === 'freebusy') {
        dateTime(body.timeMin, 'timeMin');
        dateTime(body.timeMax, 'timeMax');
        requireThat(
            Array.isArray(body.items) && body.items.length > 0,
            'items must be a nonempty array.',
        );
        body.items.forEach((item, i) => {
            requireThat(object(item), `items[${i}] must be an object.`);
            requireThat(typeof item.id === 'string', `items[${i}].id must be a string.`);
        });
        return;
    }
    requireThat(typeof body.summary === 'string', 'summary must be a string.');
    when(body.start, 'start');
    when(body.end, 'end');
    for (const field of ['description', 'location']) {
        if (body[field] !== undefined)
            requireThat(typeof body[field] === 'string', `${field} must be a string.`);
    }
    if (body.attendees !== undefined) {
        requireThat(Array.isArray(body.attendees), 'attendees must be an array.');
        body.attendees.forEach((attendee, i) => {
            const field = `attendees[${i}]`;
            requireThat(object(attendee), `${field} must be an object.`);
            requireThat(
                typeof attendee.email === 'string' && /^[^\s@]+@[^\s@]+$/.test(attendee.email),
                `${field}.email must be an email address.`,
            );
            requireThat(
                ['needsAction', 'declined', 'tentative', 'accepted'].includes(
                    attendee.responseStatus,
                ),
                `${field}.responseStatus must be needsAction, declined, tentative, or accepted.`,
            );
            if (attendee.displayName !== undefined)
                requireThat(
                    typeof attendee.displayName === 'string',
                    `${field}.displayName must be a string.`,
                );
            if (attendee.optional !== undefined)
                requireThat(
                    typeof attendee.optional === 'boolean',
                    `${field}.optional must be a boolean.`,
                );
        });
    }
}

function localOrigin(raw) {
    let url;
    try {
        url = new URL(raw);
    } catch {
        throw new ClientError(
            'invalid_input',
            'Set CALENDAR_API_BASE_URL to the local mock HTTP origin.',
        );
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const parts = host.split('.').map(Number);
    const local =
        host === '::1' ||
        (isIP(host) === 4 &&
            (parts[0] === 127 ||
                parts[0] === 10 ||
                (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
                (parts[0] === 192 && parts[1] === 168)));
    requireThat(
        url.protocol === 'http:' &&
            local &&
            !url.username &&
            !url.password &&
            /^\/*$/.test(url.pathname) &&
            !url.search &&
            !url.hash,
        'CALENDAR_API_BASE_URL must be a local/private literal-IP HTTP origin without credentials, path prefix, query, or fragment.',
    );
    return url.origin;
}
function segment(value, field) {
    text(value, field);
    requireThat(value !== '.' && value !== '..', `${field} cannot be a dot path segment.`);
    return encodeURIComponent(value).replace(
        /[!'()*]/g,
        (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
    );
}

// Dependency injection keeps tests fully offline. Production uses Node's fetch.
export async function execute(
    argv,
    {
        env = process.env,
        fetchImpl = globalThis.fetch,
        readText = (path) => readFileSync(path === '-' ? 0 : path, 'utf8'),
    } = {},
) {
    const transcript = { startedAt: new Date().toISOString() };
    const started = Date.now();
    let timer;
    try {
        const options = Object.fromEntries(
            [
                'calendar',
                'time-min',
                'time-max',
                'query',
                'order-by',
                'max-results',
                'page-token',
                'timeout-ms',
                'body',
            ].map((name) => [name, { type: 'string' }]),
        );
        let parsed;
        try {
            parsed = parseArgs({
                args: argv,
                options: { ...options, help: { type: 'boolean' } },
                allowPositionals: true,
                strict: true,
            });
        } catch {
            throw new ClientError('invalid_input', 'Invalid command-line arguments. Use --help.');
        }
        const { values, positionals } = parsed;
        if (values.help) return { exitCode: 0, help: usage };
        const [operation, eventId, ...extra] = positionals;
        requireThat(
            ['list', 'get', 'freebusy', 'create'].includes(operation),
            'Choose list, get, freebusy, or create. Use --help.',
        );
        requireThat(
            extra.length === 0 &&
                (operation === 'get' ? eventId !== undefined : eventId === undefined),
            'Only get takes a positional event ID. Use --help.',
        );
        const permitted = {
            list: [
                'calendar',
                'time-min',
                'time-max',
                'query',
                'order-by',
                'max-results',
                'page-token',
            ],
            get: ['calendar'],
            freebusy: ['body'],
            create: ['calendar', 'body'],
        }[operation];
        requireThat(
            Object.keys(values).every((key) => key === 'timeout-ms' || permitted.includes(key)),
            'An option does not apply to this operation. Use --help.',
        );
        const deadline = values['timeout-ms'] ?? '180000';
        requireThat(
            /^\d+$/.test(deadline) && Number(deadline) >= 1 && Number(deadline) <= 300000,
            '--timeout-ms must be an integer from 1 to 300000.',
        );
        const timeoutMs = Number(deadline);
        const origin = localOrigin(env.CALENDAR_API_BASE_URL);
        const calendar = segment(values.calendar ?? 'primary', 'calendar');
        const path =
            operation === 'freebusy'
                ? '/freeBusy'
                : `/calendars/${calendar}/events${operation === 'get' ? `/${segment(eventId, 'event ID')}` : ''}`;
        const url = new URL(origin + path);
        if (operation === 'list') {
            for (const key of ['time-min', 'time-max'])
                if (values[key] !== undefined) dateTime(values[key], key);
            if (values['order-by'] !== undefined)
                requireThat(
                    ['startTime', 'updated'].includes(values['order-by']),
                    '--order-by must be startTime or updated.',
                );
            if (values['max-results'] !== undefined)
                requireThat(
                    /^\d+$/.test(values['max-results']) &&
                        Number(values['max-results']) >= 1 &&
                        Number(values['max-results']) <= 2500,
                    '--max-results must be an integer from 1 to 2500.',
                );
            for (const [flag, name] of [
                ['time-min', 'timeMin'],
                ['time-max', 'timeMax'],
                ['query', 'q'],
                ['order-by', 'orderBy'],
                ['max-results', 'maxResults'],
                ['page-token', 'pageToken'],
            ]) {
                if (values[flag] !== undefined) url.searchParams.set(name, values[flag]);
            }
        }
        let body;
        if (operation === 'freebusy' || operation === 'create') {
            text(values.body, '--body');
            let raw;
            try {
                raw = await readText(values.body);
            } catch {
                throw new ClientError('invalid_input', 'The JSON body file could not be read.');
            }
            try {
                body = JSON.parse(raw.replace(/^\uFEFF/, ''));
            } catch {
                throw new ClientError('invalid_input', 'The body file is not valid JSON.');
            }
            bodyShape(operation, body);
        }
        const method = body === undefined ? 'GET' : 'POST';
        const headers = {
            accept: 'application/json',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        };
        transcript.operation = operation;
        transcript.request = {
            method,
            url: url.href,
            headers,
            ...(body === undefined ? {} : { body }),
        };
        const controller = new AbortController();
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => {
                reject(
                    new ClientError(
                        'timeout',
                        `The request exceeded its ${timeoutMs} ms deadline.`,
                    ),
                );
                controller.abort();
            }, timeoutMs);
        });
        await Promise.race([
            timeout,
            (async () => {
                const response = await fetchImpl(url.href, {
                    method,
                    headers,
                    redirect: 'error',
                    signal: controller.signal,
                    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                });
                transcript.response = { status: response.status, statusText: response.statusText };
                const bodyText = await response.text();
                transcript.response.bodyText = bodyText;
                try {
                    transcript.response.body = JSON.parse(bodyText);
                } catch {
                    throw new ClientError(
                        response.status === 200 ? 'invalid_json' : 'http_error',
                        'The response was not valid JSON; inspect its status and bodyText.',
                    );
                }
                if (response.status !== 200)
                    throw new ClientError(
                        'http_error',
                        'The response status differs from HTTP 200 declared by the contract.',
                    );
                if (!object(transcript.response.body))
                    throw new ClientError(
                        'invalid_json_shape',
                        'The contract expects a JSON object; inspect the response body.',
                    );
            })(),
        ]);
        return { exitCode: 0, transcript: { ...transcript, elapsedMs: Date.now() - started } };
    } catch (error) {
        transcript.error =
            error instanceof ClientError
                ? { code: error.code, message: error.message }
                : {
                      code: 'transport_error',
                      message: 'The request could not complete. No automatic retry was made.',
                  };
        return { exitCode: 1, transcript: { ...transcript, elapsedMs: Date.now() - started } };
    } finally {
        clearTimeout(timer);
    }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    const result = await execute(process.argv.slice(2));
    process.stdout.write(result.help ?? `${JSON.stringify(result.transcript, null, 2)}\n`);
    process.exitCode = result.exitCode;
}
