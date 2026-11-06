import type { Request } from 'express';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { CallerClaims } from '../src/auth.ts';
import { identify, runUser } from '../src/identity.ts';

const USER = '3F0C1E2A-1111-4222-8333-444455556666';
const THREAD = '9b1d2c3e-aaaa-4bbb-8ccc-dddd0000ffff';

function request(claims: Partial<CallerClaims> | undefined, tid = THREAD): Request {
    return {
        params: { tid },
        res: { locals: claims ? { caller: { prj: 'p1', req: 'POST /', ...claims } } : {} },
    } as unknown as Request;
}

test('a user call acts for the user the token names, as the host vouches', () => {
    const req = request({ sub: USER, thr: THREAD, role: 'editor', email: 'ann@acme.com' });
    assert.deepEqual(runUser(req), {
        id: USER.toLowerCase(),
        role: 'editor',
        email: 'ann@acme.com',
        source: 'host',
    });
    assert.equal(identify(req).email, 'ann@acme.com');
});

test("zenera-app's own calls act for nobody", () => {
    assert.equal(runUser(request({ sub: 'zenera-app' })), null);
    assert.equal(runUser(request(undefined)), null);
});

test('a role or email that is not one is left out, not passed on', () => {
    const req = request({ sub: USER, role: 'root', email: 'ann@acme.com\nZEN_USER_ROLE=owner' });
    assert.deepEqual(runUser(req), { id: USER.toLowerCase(), source: 'host' });
});
