import type { Request } from 'express';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { configure, DEFAULTS } from '../src/config.ts';
import { HttpError } from '../src/http.ts';
import { identify, runUser, userFolder } from '../src/identity.ts';

const THREAD = '9b1d2c3e-aaaa-4bbb-8ccc-dddd0000ffff';
const USER = '3F0C1E2A-1111-4222-8333-444455556666';

function request(claims: Record<string, unknown>, tid = THREAD): Request {
    return { params: { tid }, res: { locals: { caller: claims } } } as unknown as Request;
}

const server = (mode: 'jwt' | 'insecure') =>
    configure({
        ...DEFAULTS,
        projectId: 'p',
        root: '/tmp/none',
        auth:
            mode === 'jwt'
                ? { mode, publicKey: 'k', issuer: 'zenera-app', audience: 'zenera-runtime' }
                : { mode },
    });

test('a run acts for the user the token names, as the host vouched for them', () => {
    server('jwt');
    const req = request({ sub: USER, role: 'editor', email: 'ann@acme.com', name: 'Ann' });
    assert.deepEqual(runUser(req), {
        id: USER.toLowerCase(),
        role: 'editor',
        email: 'ann@acme.com',
        name: 'Ann',
        source: 'host',
    });
    assert.deepEqual(identify(req), { userId: USER.toLowerCase(), threadId: THREAD });
});

test('an unchecked token is only someone’s say-so', () => {
    server('insecure');
    assert.equal(runUser(request({ sub: 'carol' }))?.source, 'local');
});

test('a role, email or name that is not one is left out, not passed on', () => {
    server('jwt');
    const req = request({ sub: 'ann', role: 'root', email: 'ann@acme.com\nZEN_USER_ROLE=owner' });
    assert.deepEqual(runUser(req), { id: 'ann', source: 'host' });
});

test('a time zone and picture pass on only as a known IANA zone and a plain https URL', () => {
    server('jwt');
    const user = (zoneinfo: unknown, picture: unknown) =>
        runUser(request({ sub: 'ann', zoneinfo, picture }));
    assert.deepEqual(user('Asia/Dubai', 'https://cdn.acme.com/a.png?s=96'), {
        id: 'ann',
        timeZone: 'Asia/Dubai',
        picture: 'https://cdn.acme.com/a.png?s=96',
        source: 'host',
    });
    // Google's avatar URLs run over 1 KB.
    const google = `https://lh3.googleusercontent.com/a-/${'A'.repeat(1100)}=s96-c`;
    assert.equal(user(undefined, google)?.picture, google);
    for (const [zone, picture] of [
        ['Mars/Olympus', 'http://cdn.acme.com/a.png'],
        ['Asia/Dubai\nZEN_USER_ROLE=owner', 'https://u:p@cdn.acme.com/a.png'],
        [42, `https://cdn.acme.com/${'a'.repeat(2100)}.png`],
        ['../etc', 'javascript:alert(1)'],
    ]) {
        assert.deepEqual(user(zone, picture), { id: 'ann', source: 'host' });
    }
});

test('a thread id is one safe path segment, and the token’s own when it names one', () => {
    server('jwt');
    for (const bad of ['', '..', 'a/b', '.hidden', 'x'.repeat(81)]) {
        assert.throws(() => identify(request({ sub: 'ann' }, bad)), HttpError);
    }
    assert.throws(() => identify(request({ sub: 'ann', thr: 'other' })), /another thread/);
    assert.equal(identify(request({ sub: 'ann', thr: THREAD.toUpperCase() })).threadId, THREAD);
});

test('a user id is a folder name only when it is one safe segment', () => {
    assert.equal(userFolder('ann'), 'ann');
    assert.equal(userFolder(USER), USER.toLowerCase());
    assert.match(userFolder('../x'), /^u-[0-9a-f]{32}$/);
    assert.notEqual(userFolder('a/b'), userFolder('a/c'));
});
