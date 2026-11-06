// Who a request is for: the user, thread and role in the token zenera-app signed for it, already
// verified by requireCaller (auth.ts) - signature, project and the request it is for. A token-mode
// caller is the server's own user, as owner, on the thread the route names.
//   identify   - the runtime caller (a user's private chat), or an HttpError
//   runUser    - who a run acts for, as the engine takes it: what the agent's `current_user` answers and
//                its sandbox sees as ZEN_USER_*. Test-tab runs come through the manager and name
//                the editor who started them; anything else names nobody.
import type { RunIdentity } from '@zenera/engine';
import type { Request } from 'express';
import type { CallerClaims } from './auth.ts';
import { HttpError } from './http.ts';

export interface Identity {
    userId: string;
    projectId: string;
    threadId: string;
    role: 'owner' | 'editor' | 'viewer' | 'admin';
    email?: string;
}

// Both ids become path segments under /data, so nothing but a UUID gets through.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLES = new Set<string>(['owner', 'editor', 'viewer', 'admin']);
// An email goes into an environment variable, so it is held to the shape of one.
const EMAIL = /^[^\s@]{1,200}@[^\s@]{1,200}$/;
// A token-mode server's user is the host's to name: still one safe path segment.
const LOCAL_USER = /^[A-Za-z0-9][\w.@-]{0,99}$/;

function userOk(claims: CallerClaims): boolean {
    return UUID.test(claims.sub) || (claims.local === true && LOCAL_USER.test(claims.sub));
}

function caller(req: Request): CallerClaims | undefined {
    return req.res?.locals.caller as CallerClaims | undefined;
}

function emailOf(claims: CallerClaims): string | undefined {
    return typeof claims.email === 'string' && EMAIL.test(claims.email) ? claims.email : undefined;
}

export function identify(req: Request): Identity {
    const claims = caller(req);
    if (!claims) throw new HttpError(401, 'no verified caller');
    const { sub: userId, role = '' } = claims;
    const threadId = claims.local ? String(req.params.tid ?? '') : (claims.thr ?? '');
    if (!userOk(claims) || !UUID.test(threadId) || !ROLES.has(role)) {
        throw new HttpError(401, 'the token names no user, thread or role');
    }
    if (threadId !== req.params.tid) throw new HttpError(403, 'the token is for another thread');
    return {
        userId: claims.local ? userId : userId.toLowerCase(),
        projectId: claims.prj,
        threadId: threadId.toLowerCase(),
        role: role as Identity['role'],
        email: emailOf(claims),
    };
}

export function runUser(req: Request): RunIdentity | null {
    const claims = caller(req);
    if (!claims || !userOk(claims)) return null;
    return {
        id: claims.local ? claims.sub : claims.sub.toLowerCase(),
        ...(claims.role && ROLES.has(claims.role) ? { role: claims.role } : {}),
        ...(emailOf(claims) ? { email: emailOf(claims) } : {}),
        source: 'host',
    };
}
