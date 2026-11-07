// Request identity helpers used by session/history/run/debug routes. Claims come from
// requireCaller (auth.ts), which verifies JWTs in secure mode and decodes them in insecure mode.
// The JWT's `sub`, not a startup flag, determines whose sessions and memory a request uses.
//   caller      - the claims attached by authentication, or an HttpError
//   userFolder  - a user's folder name: the id itself when it is one safe path segment, else a hash
//   isThreadId  - whether a thread id is safe to use as a session folder name
//   identify    - the user and thread of a chat request, or an HttpError
//   runUser     - who a run acts for, as the engine takes it: what the agent's `current_user`
//                 answers and its sandbox sees as ZEN_USER_*
import type { RunIdentity } from '@zenera/engine';
import type { Request } from 'express';
import { createHash } from 'node:crypto';
import type { CallerClaims } from './auth.ts';
import { settings } from './config.ts';
import { HttpError } from './http.ts';

export interface Identity {
    /** the folder under <root>/users/ */
    userId: string;
    threadId: string;
}

const SAFE_ID = /^[A-Za-z0-9][\w.@-]{0,99}$/;
const THREAD_ID = /^[A-Za-z0-9][\w-]{0,79}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLES = new Set<string>(['owner', 'editor', 'viewer', 'admin']);
// An email goes into an environment variable, so it is held to the shape of one.
const EMAIL = /^[^\s@]{1,200}@[^\s@]{1,200}$/;
const NAME = /^[^\n\r\0]{1,200}$/;

export function isThreadId(id: string): boolean {
    return THREAD_ID.test(id);
}

/**
 * Where a user's things are: their id when it is one safe path segment (a UUID lower-cased, as
 * zenera-app's are), else `u-` and a hash of it — so no id is ever a path of its own.
 */
export function userFolder(sub: string): string {
    if (UUID.test(sub)) return sub.toLowerCase();
    if (SAFE_ID.test(sub)) return sub;
    return `u-${createHash('sha256').update(sub).digest('hex').slice(0, 32)}`;
}

export function caller(req: Request): CallerClaims {
    const claims = req.res?.locals.caller as CallerClaims | undefined;
    if (!claims) throw new HttpError(401, 'no verified caller');
    return claims;
}

export function identify(req: Request): Identity {
    const claims = caller(req);
    const threadId = String(req.params.tid ?? '');
    if (!isThreadId(threadId)) throw new HttpError(400, 'not a thread id');
    if (claims.thr !== undefined && String(claims.thr).toLowerCase() !== threadId.toLowerCase()) {
        throw new HttpError(403, 'the token is for another thread');
    }
    return { userId: userFolder(claims.sub), threadId };
}

export function runUser(req: Request): RunIdentity | null {
    const claims = caller(req);
    const role =
        typeof claims.role === 'string' && ROLES.has(claims.role) ? claims.role : undefined;
    const email =
        typeof claims.email === 'string' && EMAIL.test(claims.email) ? claims.email : undefined;
    const name =
        typeof claims.name === 'string' && NAME.test(claims.name) ? claims.name : undefined;
    return {
        id: UUID.test(claims.sub) ? claims.sub.toLowerCase() : claims.sub,
        ...(role ? { role } : {}),
        ...(email ? { email } : {}),
        ...(name ? { name } : {}),
        // An unsigned token is only someone's say-so.
        source: settings().auth.mode === 'jwt' ? 'host' : 'local',
    };
}
