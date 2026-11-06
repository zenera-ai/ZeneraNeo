import type { Request } from 'express';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { configure, DEFAULTS } from '../src/config.ts';
import { HttpError } from '../src/http.ts';
import { checkUser, identify, runUser } from '../src/identity.ts';

const THREAD = '9b1d2c3e-aaaa-4bbb-8ccc-dddd0000ffff';
const request = (tid: string) => ({ params: { tid } }) as unknown as Request;

test('a run acts for the server’s user, as its host named them', () => {
    configure({
        ...DEFAULTS,
        token: 'x'.repeat(32),
        projectId: 'p',
        user: { id: 'ann', role: 'editor', email: 'ann@acme.com' },
    });
    assert.deepEqual(runUser(), {
        id: 'ann',
        role: 'editor',
        email: 'ann@acme.com',
        source: 'host',
    });
    assert.deepEqual(identify(request(THREAD)), { userId: 'ann', threadId: THREAD });
});

test('a thread id is one safe path segment', () => {
    configure({ ...DEFAULTS, token: 'x'.repeat(32), projectId: 'p', user: { id: 'ann' } });
    for (const bad of ['', '..', 'a/b', '.hidden', 'x'.repeat(81)]) {
        assert.throws(() => identify(request(bad)), HttpError);
    }
    assert.equal(identify(request('thread_1-a')).threadId, 'thread_1-a');
});

test('a host cannot name a user, role or email that is not one', () => {
    assert.throws(() => checkUser({ id: '../x' }), /not a user id/);
    assert.throws(() => checkUser({ id: 'a', role: 'root' as never }), /not a role/);
    assert.throws(() => checkUser({ id: 'a', email: 'a@b\nZEN_USER_ROLE=owner' }), /not an email/);
    assert.doesNotThrow(() => checkUser({ id: '3f0c1e2a-1111-4222-8333-444455556666' }));
});
