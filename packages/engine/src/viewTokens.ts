import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// View tokens: the credential in a page's URL
//
// An html page an agent wrote is opened at `/v/<token>/workspace/charts/dash.html`, so the
// files it names by relative path (`../data/prices.json`) resolve under the same token: the
// browser cannot attach a JWT or a cookie to what a sandboxed page asks for, but it keeps the
// path. The token is `<claims>.<HMAC-SHA256 of them>`, both base64url: whoever holds the key
// mints and checks it; anyone may read it, nobody else can make or alter one.
//   mintViewToken   - a token for these claims, valid for `ttlSeconds`
//   verifyViewToken - the claims of a genuine, unexpired token, else null
//   viewKey         - the key in a file, made (32 random bytes, 0600) the first time
// ---------------------------------------------------------------------------

export interface ViewClaims {
    /** whose files: the user (a folder name, a subject: whatever the minter means) */
    sub: string;
    /** which chat thread's session */
    tid: string;
    /** seconds since the epoch after which the token is refused */
    exp: number;
    /** anything else the minter needs back (a project, a kind of chat), as strings */
    [extra: string]: string | number;
}

export const VIEW_TOKEN_TTL_SECONDS = 3600;

const KEY_BYTES = 32;
const MAX_TOKEN = 2048;

function sign(key: Buffer, payload: string): Buffer {
    return createHmac('sha256', key).update(payload).digest();
}

export function mintViewToken(
    key: Buffer,
    claims: Omit<ViewClaims, 'exp'>,
    ttlSeconds = VIEW_TOKEN_TTL_SECONDS,
    now = Date.now(),
): string {
    const exp = Math.floor(now / 1000) + ttlSeconds;
    const payload = Buffer.from(JSON.stringify({ ...claims, exp })).toString('base64url');
    return `${payload}.${sign(key, payload).toString('base64url')}`;
}

export function verifyViewToken(key: Buffer, token: string, now = Date.now()): ViewClaims | null {
    if (typeof token !== 'string' || token.length > MAX_TOKEN) return null;
    const dot = token.indexOf('.');
    if (dot <= 0 || dot !== token.lastIndexOf('.')) return null;
    const payload = token.slice(0, dot);
    const given = Buffer.from(token.slice(dot + 1), 'base64url');
    const expected = sign(key, payload);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    let claims: unknown;
    try {
        claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
        return null;
    }
    if (!claims || typeof claims !== 'object') return null;
    const { sub, tid, exp } = claims as Partial<ViewClaims>;
    if (typeof sub !== 'string' || !sub || typeof tid !== 'string' || !tid) return null;
    if (typeof exp !== 'number' || exp * 1000 <= now) return null;
    return claims as ViewClaims;
}

/** The key kept in `file`; the first caller makes it, and a second at once reads the first's. */
export function viewKey(file: string): Buffer {
    try {
        const key = readFileSync(file);
        if (key.length === KEY_BYTES) return key;
        throw new Error(`not a view key: ${file}`);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    mkdirSync(dirname(file), { recursive: true });
    // Written whole beside it, then linked into place: nobody reads half a key.
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}`;
    writeFileSync(tmp, randomBytes(KEY_BYTES), { mode: 0o600, flag: 'wx' });
    try {
        linkSync(tmp, file);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    } finally {
        rmSync(tmp, { force: true });
    }
    return readFileSync(file);
}
