import type { Request } from 'express';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { test } from 'vitest';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const { configure, DEFAULTS } = await import('../src/config.ts');
configure({
    ...DEFAULTS,
    projectId: 'p1',
    auth: { mode: 'jwt', publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() },
});
const { verifyCaller } = await import('../src/auth.ts');
const { HttpError } = await import('../src/http.ts');

// Signs the way zenera-app does (server/identity.ts): node:crypto, no JWT library.
function jwt(payload: Record<string, unknown>, key: KeyObject = privateKey): string {
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const input = `${part({ alg: 'EdDSA', typ: 'JWT' })}.${part(payload)}`;
    return `${input}.${sign(null, Buffer.from(input), key).toString('base64url')}`;
}

const now = () => Math.floor(Date.now() / 1000);
const claims = (over: Record<string, unknown> = {}) => ({
    iss: 'zenera-app',
    aud: 'zenera-runtime',
    sub: 'zenera-app',
    prj: 'p1',
    req: 'GET /api/activity',
    iat: now(),
    exp: now() + 60,
    ...over,
});

function request(token: string | null, method = 'GET', url = '/api/activity'): Request {
    return {
        method,
        originalUrl: url,
        get: (name: string) =>
            name.toLowerCase() === 'authorization' && token ? `Bearer ${token}` : undefined,
    } as unknown as Request;
}

async function status(req: Request, aud: 'zenera-runtime' | 'zenera-manager' = 'zenera-runtime') {
    try {
        await verifyCaller(req, aud);
        return 200;
    } catch (err) {
        assert.ok(err instanceof HttpError, String(err));
        return err.status;
    }
}

test('accepts a token zenera-app signed for this project and request', async () => {
    const caller = await verifyCaller(request(jwt(claims({ thr: 't1' }))), 'zenera-runtime');
    assert.equal(caller.sub, 'zenera-app');
    assert.equal(caller.thr, 't1');
});

test('refuses a request without a token', async () => {
    assert.equal(await status(request(null)), 401);
});

test('refuses a token for the other service', async () => {
    assert.equal(await status(request(jwt(claims())), 'zenera-manager'), 401);
});

test('refuses a token for another project', async () => {
    assert.equal(await status(request(jwt(claims({ prj: 'p2' })))), 403);
});

test('refuses a token used for another request', async () => {
    const token = jwt(claims({ req: 'GET /api/activity' }));
    assert.equal(await status(request(token, 'DELETE', '/api/sessions/x')), 401);
    assert.equal(await status(request(token, 'POST', '/api/activity')), 401);
});

test('refuses an expired token', async () => {
    const old = now() - 600;
    assert.equal(await status(request(jwt(claims({ iat: old, exp: old + 60 })))), 401);
});

test('refuses a token signed by another key', async () => {
    const other = generateKeyPairSync('ed25519').privateKey;
    assert.equal(await status(request(jwt(claims(), other))), 401);
});

test('refuses a token from another issuer or without a subject', async () => {
    assert.equal(await status(request(jwt(claims({ iss: 'someone' })))), 401);
    assert.equal(await status(request(jwt(claims({ sub: undefined })))), 401);
});

test('refuses an unsigned token', async () => {
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const none = `${part({ alg: 'none' })}.${part(claims())}.`;
    assert.equal(await status(request(none)), 401);
});
