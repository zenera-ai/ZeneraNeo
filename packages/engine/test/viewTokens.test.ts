import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { mintViewToken, verifyViewToken, viewKey } from '../src/index.ts';

const dir = mkdtempSync(join(tmpdir(), 'zen-view-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('view tokens', () => {
    const key = viewKey(join(dir, 'view.key'));
    const claims = { sub: 'ann', tid: 't1', prj: 'p' };

    it('gives back the claims of a token it minted, until it expires', () => {
        const now = Date.UTC(2026, 0, 1);
        const token = mintViewToken(key, claims, 60, now);
        expect(token).toMatch(/^[\w-]+\.[\w-]+$/);
        expect(verifyViewToken(key, token, now)).toMatchObject({ ...claims, exp: now / 1000 + 60 });
        expect(verifyViewToken(key, token, now + 60_000)).toBeNull();
    });

    it('refuses a token altered, signed with another key or malformed', () => {
        const token = mintViewToken(key, claims);
        const [payload, sig] = token.split('.');
        const other = Buffer.from(JSON.stringify({ ...claims, tid: 't2', exp: 9e9 }));
        expect(verifyViewToken(key, `${other.toString('base64url')}.${sig}`)).toBeNull();
        expect(verifyViewToken(Buffer.alloc(32, 1), token)).toBeNull();
        expect(verifyViewToken(key, payload)).toBeNull();
        expect(verifyViewToken(key, `${token}.x`)).toBeNull();
        expect(verifyViewToken(key, '')).toBeNull();
    });

    it('keeps one key, readable by the owner only', () => {
        const file = join(dir, 'view.key');
        expect(viewKey(file).equals(key)).toBe(true);
        expect(statSync(file).mode & 0o777).toBe(0o600);
        writeFileSync(join(dir, 'short.key'), 'x');
        expect(() => viewKey(join(dir, 'short.key'))).toThrow(/not a view key/);
    });
});
