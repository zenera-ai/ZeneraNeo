// Who a request is for: the server's one user, on the thread the route names. Nothing of it
// comes from the request but the thread id, which becomes a path segment and is held to one.
//   checkUser  - a user a host may name (createServer refuses any other)
//   identify   - the user and thread of a chat request, or an HttpError
//   runUser    - who a run acts for, as the engine takes it: what the agent's `current_user`
//                answers and its sandbox sees as ZEN_USER_*
import type { RunIdentity } from '@zenera/engine';
import type { Request } from 'express';
import { settings, type ServerUser } from './config.ts';
import { HttpError } from './http.ts';

export interface Identity {
    userId: string;
    threadId: string;
}

const USER_ID = /^[A-Za-z0-9][\w.@-]{0,99}$/;
const THREAD_ID = /^[A-Za-z0-9][\w-]{0,79}$/;
const ROLES = new Set<string>(['owner', 'editor', 'viewer', 'admin']);
// An email goes into an environment variable, so it is held to the shape of one.
const EMAIL = /^[^\s@]{1,200}@[^\s@]{1,200}$/;

export function checkUser(user: ServerUser): ServerUser {
    if (!USER_ID.test(user.id)) {
        throw new Error(`not a user id: ${JSON.stringify(user.id)} (letters, digits, . _ @ -)`);
    }
    if (user.role !== undefined && !ROLES.has(user.role)) {
        throw new Error(`not a role: ${JSON.stringify(user.role)}`);
    }
    if (user.email !== undefined && !EMAIL.test(user.email)) {
        throw new Error(`not an email: ${JSON.stringify(user.email)}`);
    }
    return user;
}

export function identify(req: Request): Identity {
    const threadId = String(req.params.tid ?? '');
    if (!THREAD_ID.test(threadId)) throw new HttpError(400, 'not a thread id');
    return { userId: settings().user.id, threadId };
}

export function runUser(): RunIdentity {
    const { id, role, email } = settings().user;
    return { id, ...(role ? { role } : {}), ...(email ? { email } : {}), source: 'host' };
}
