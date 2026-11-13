import { Cache as Store } from '@zenera/cli/lib';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GYM_KIND } from '../src/cache.ts';
import { RegenerationLimiter } from '../src/logger.ts';
import { Router } from '../src/router.ts';
import { listen, type Listening } from '../src/server.ts';
import { Checks, issues, describeIssues } from '../src/validate.ts';
import { loadSpec } from '../src/spec.ts';
import { rig, say, scripted, type Rig, type Script } from './helpers.ts';

// ---------------------------------------------------------------------------
// QA-6 Contract Suite Test
//
// Covers all 9 operations across calendar.yaml and mail.yaml:
// - Positive contract tests with valid static handlers and schema validation.
// - Negative tests for required, type, and pattern schema violations.
// - Direct validation via Checks API and HTTP-level failure checks.
// ---------------------------------------------------------------------------

interface Booted {
    r: Rig;
    model: ReturnType<typeof scripted>;
    live: Listening;
    base: string;
}

interface BootOptions {
    builder?: Script;
    regenLimit?: number;
    limiter?: RegenerationLimiter;
    attempts?: number;
}

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const RIG_SPECS = join(TEST_DIR, 'specs');
const SPEC_DIR = resolve(TEST_DIR, '../../../examples/mock-apis/specs');
const CALENDAR_SPEC = join(SPEC_DIR, 'calendar.yaml');
const MAIL_SPEC = join(SPEC_DIR, 'mail.yaml');

async function bootSpec(
    specFile: string,
    handlers: Record<string, string>,
    opts: BootOptions = {},
): Promise<Booted> {
    const model = scripted({
        builder:
            opts.builder ??
            (() => {
                throw new Error('builder should not be called with stubs');
            }),
        world: () => say('done'),
    });

    // rig() resolves names against packages/gym/test/specs, so hand it the
    // spec path relative to that directory rather than a cwd-dependent path.
    const r = await rig(relative(RIG_SPECS, specFile), model, { attempts: opts.attempts });

    const store = new Store(GYM_KIND, { dir: join(r.root, 'store') });
    for (const o of r.operations) {
        if (handlers[o.operationId]) {
            store.put(o.key, { source: handlers[o.operationId], meta: { model: 'stub' } });
        }
    }

    const router = new Router(r.operations);
    const live = await listen(
        {
            router,
            checks: r.checks,
            box: r.box,
            cache: r.cache,
            seed: 7,
            regenLimit: opts.regenLimit,
            limiter: opts.limiter,
        },
        '127.0.0.1',
        0,
    );
    return { r, model, live, base: `http://127.0.0.1:${live.port}` };
}

function operation(b: Booted, operationId: string) {
    const found = b.r.operations.find((o) => o.operationId === operationId);
    if (!found) {
        throw new Error(`no operation ${operationId}`);
    }
    return found;
}

function expectResponseSchema(b: Booted, operationId: string, value: unknown): void {
    const validator = b.r.checks.for(operation(b, operationId)).response;
    if (!validator) {
        throw new Error(`no response schema for ${operationId}`);
    }
    const valid = validator(value);
    expect(valid, describeIssues(issues('response', validator.errors))).toBe(true);
}

async function operationFromSpec(specFile: string, operationId: string) {
    const operations = await loadSpec(specFile);
    const found = operations.find((o) => o.operationId === operationId);
    if (!found) {
        throw new Error(`no operation ${operationId} in ${specFile}`);
    }
    return found;
}

const CALENDAR_HANDLERS = {
    listEvents: `export default async () => ({ items: [], timeZone: 'UTC' });`,
    insertEvent: `export default async () => ({
        id: '1234567890abcdef',
        status: 'confirmed',
        summary: 'Meeting',
        start: { dateTime: '2026-11-02T10:00:00Z' },
        end: { dateTime: '2026-11-02T11:00:00Z' },
        organizer: { email: 'organizer@orbital-bakery.test' },
        created: '2026-11-02T00:00:00Z',
        updated: '2026-11-02T00:00:00Z'
    });`,
    getEvent: `export default async () => ({
        id: '1234567890abcdef',
        status: 'confirmed',
        summary: 'Meeting',
        start: { dateTime: '2026-11-02T10:00:00Z' },
        end: { dateTime: '2026-11-02T11:00:00Z' },
        organizer: { email: 'organizer@orbital-bakery.test' },
        created: '2026-11-02T00:00:00Z',
        updated: '2026-11-02T00:00:00Z'
    });`,
    queryFreeBusy: `export default async (req: any) => ({
        timeMin: req.body.timeMin,
        timeMax: req.body.timeMax,
        calendars: { primary: { busy: [] } }
    });`,
};

const MAIL_HANDLERS = {
    listMessages: `export default async () => ({ messages: [], resultSizeEstimate: 0 });`,
    getMessage: `export default async () => ({
        id: '0123456789abcdef',
        threadId: '0123456789abcdef',
        labelIds: ['INBOX'],
        snippet: 'Hello test',
        internalDate: '1730000000000',
        from: 'sender@example.com',
        to: ['recipient@example.com'],
        subject: 'Test Subject'
    });`,
    sendMessage: `export default async () => ({
        id: '0123456789abcdef',
        threadId: '0123456789abcdef',
        labelIds: ['SENT'],
        snippet: 'Hello test',
        internalDate: '1730000000000',
        from: 'sender@example.com',
        to: ['recipient@example.com'],
        subject: 'Test Subject'
    });`,
    listLabels: `export default async () => ({
        labels: [{ id: 'INBOX', name: 'Inbox', type: 'system' }]
    });`,
    listThreads: `export default async () => ({
        threads: [],
        resultSizeEstimate: 0
    });`,
};

const INVALID_LIST_EVENTS = `export default async () => ({ items: [] });`;

describe('QA-6 Contract Suite: Calendar API (Positive)', () => {
    let b: Booted;

    beforeAll(async () => {
        b = await bootSpec(CALENDAR_SPEC, CALENDAR_HANDLERS);
    }, 20_000);

    afterAll(async () => {
        await b?.live.close();
        await b?.r.close();
    });

    it('listEvents successfully calls and validates', async () => {
        const res = await fetch(`${b.base}/calendars/primary/events`);
        expect(res.status).toBe(200);
        const data = await res.json();
        expectResponseSchema(b, 'listEvents', data);
        expect(data).toHaveProperty('items');
        expect(data).toHaveProperty('timeZone');
    }, 20_000);

    it('insertEvent successfully calls and validates', async () => {
        const res = await fetch(`${b.base}/calendars/primary/events`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                summary: 'New Event',
                start: { dateTime: '2026-11-02T10:00:00Z' },
                end: { dateTime: '2026-11-02T11:00:00Z' },
            }),
        });
        expect(res.status).toBe(200);
        const data = await res.json();
        expectResponseSchema(b, 'insertEvent', data);
        expect(data).toHaveProperty('id');
        expect(data).toHaveProperty('summary');
    }, 20_000);

    it('getEvent successfully calls and validates', async () => {
        const res = await fetch(`${b.base}/calendars/primary/events/1234567890abcdef`);
        expect(res.status).toBe(200);
        const data = await res.json();
        expectResponseSchema(b, 'getEvent', data);
        expect(data).toHaveProperty('id');
    }, 20_000);

    it('queryFreeBusy successfully calls and validates', async () => {
        const res = await fetch(`${b.base}/freeBusy`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                timeMin: '2026-11-02T00:00:00Z',
                timeMax: '2026-11-03T00:00:00Z',
                items: [{ id: 'primary' }],
            }),
        });
        expect(res.status).toBe(200);
        const data = await res.json();
        expectResponseSchema(b, 'queryFreeBusy', data);
        expect(data).toHaveProperty('calendars');
    }, 20_000);
});

describe('QA-6 Contract Suite: Mail API (Positive)', () => {
    let b: Booted;

    beforeAll(async () => {
        b = await bootSpec(MAIL_SPEC, MAIL_HANDLERS);
    }, 20_000);

    afterAll(async () => {
        await b?.live.close();
        await b?.r.close();
    });

    it('listMessages successfully calls and validates', async () => {
        const res = await fetch(`${b.base}/users/me/messages`);
        expect(res.status).toBe(200);
        const data = await res.json();
        expectResponseSchema(b, 'listMessages', data);
        expect(data).toHaveProperty('resultSizeEstimate');
    }, 20_000);

    it('getMessage successfully calls and validates', async () => {
        const res = await fetch(`${b.base}/users/me/messages/0123456789abcdef`);
        expect(res.status).toBe(200);
        const data = await res.json();
        expectResponseSchema(b, 'getMessage', data);
        expect(data).toHaveProperty('id');
        expect(data).toHaveProperty('internalDate');
    }, 20_000);

    it('sendMessage successfully calls and validates', async () => {
        const res = await fetch(`${b.base}/users/me/messages/send`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                to: ['test@example.com'],
                subject: 'Hello',
                body: 'World',
            }),
        });
        expect(res.status).toBe(200);
        const data = await res.json();
        expectResponseSchema(b, 'sendMessage', data);
        expect(data).toHaveProperty('id');
    }, 20_000);

    it('listLabels successfully calls and validates', async () => {
        const res = await fetch(`${b.base}/users/me/labels`);
        expect(res.status).toBe(200);
        const data = await res.json();
        expectResponseSchema(b, 'listLabels', data);
        expect(data).toHaveProperty('labels');
    }, 20_000);

    it('listThreads successfully calls and validates', async () => {
        const res = await fetch(`${b.base}/users/me/threads`);
        expect(res.status).toBe(200);
        const data = await res.json();
        expectResponseSchema(b, 'listThreads', data);
        expect(data).toHaveProperty('resultSizeEstimate');
    }, 20_000);
});

describe('QA-6 Contract Suite: Negative Schema Violations', () => {
    it('fails validation on required property missing (direct Checks API)', async () => {
        const op = await operationFromSpec(CALENDAR_SPEC, 'listEvents');
        const checks = new Checks();
        const validator = checks.for(op).response!;

        // Missing required 'items' and 'timeZone'
        const invalidResponse = {};
        const valid = validator(invalidResponse);
        expect(valid).toBe(false);

        const errs = validator.errors || [];
        expect(errs.some((e) => e.keyword === 'required')).toBe(true);
        const desc = describeIssues(issues('response', errs));
        expect(desc).toContain('required');
    });

    it('fails validation on incorrect type (direct Checks API)', async () => {
        const op = await operationFromSpec(MAIL_SPEC, 'listMessages');
        const checks = new Checks();
        const validator = checks.for(op).response!;

        // resultSizeEstimate must be integer, passed as string
        const invalidResponse = { resultSizeEstimate: 'not-a-number' };
        const valid = validator(invalidResponse);
        expect(valid).toBe(false);

        const errs = validator.errors || [];
        expect(errs.some((e) => e.keyword === 'type')).toBe(true);
    });

    it('fails validation on pattern mismatch (direct Checks API)', async () => {
        const op = await operationFromSpec(MAIL_SPEC, 'getMessage');
        const checks = new Checks();
        const validator = checks.for(op).response!;

        // internalDate pattern is '^[0-9]{13}$'
        const invalidResponse = {
            id: '0123456789abcdef',
            threadId: '0123456789abcdef',
            labelIds: ['INBOX'],
            snippet: 'Test',
            internalDate: 'abc', // fails pattern
            from: 'a@b.com',
            to: ['b@c.com'],
            subject: 'Sub',
        };
        const valid = validator(invalidResponse);
        expect(valid).toBe(false);

        const errs = validator.errors || [];
        expect(errs.some((e) => e.keyword === 'pattern')).toBe(true);
    });
});

describe('QA-6 Contract Suite: HTTP Negative', () => {
    let b: Booted;

    beforeAll(async () => {
        // Start the limiter one attempt in, so the limit is reached on the
        // first request. This keeps the negative path deterministic and avoids
        // invoking the handler builder while still exercising the limit branch.
        const limiter = new RegenerationLimiter(1);
        limiter.increment('/calendars/primary/events');
        b = await bootSpec(
            CALENDAR_SPEC,
            { ...CALENDAR_HANDLERS, listEvents: INVALID_LIST_EVENTS },
            { regenLimit: 1, limiter, attempts: 1 },
        );
    }, 20_000);

    afterAll(async () => {
        await b?.live.close();
        await b?.r.close();
    });

    it('reports the operation and response schema mismatch at the regeneration limit', async () => {
        const res = await fetch(`${b.base}/calendars/primary/events`);
        expect(res.status).toBe(502);
        expect(res.headers.get('x-gym-operation')).toBe('listEvents');
        const body = (await res.json()) as {
            error: string;
            regenerationLimitHit?: boolean;
            regenerationLimit?: number;
        };
        expect(body.regenerationLimitHit).toBe(true);
        expect(body.regenerationLimit).toBe(1);
        expect(body.error).toContain('listEvents');
        expect(body.error).toContain('does not match response schema');
        expect(b.model.builder).toHaveLength(0);

        const validator = b.r.checks.for(operation(b, 'listEvents')).response!;
        const invalid = { items: [] };
        expect(validator(invalid)).toBe(false);
        expect(validator.errors?.some((e) => e.keyword === 'required')).toBe(true);
    }, 20_000);
});
