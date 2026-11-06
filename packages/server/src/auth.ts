// Who may call the server.
//   jwt   - zenera-app, with an EdDSA token it signs for each request (zenera-app server/identity.ts):
//           this project, this request, and - for a single-user server - this user. Anything else
//           that reaches the port, a sandboxed command included, has no token, and the server
//           holds only the public key, so it cannot mint one.
//   token - a fixed bearer token, for a host with no zenera-app (ZeneraSrv, a laptop): the caller
//           is the server's one user, acting as its owner.
//   verifyCaller   - the verified claims of a request, or an HttpError (401, 403, 503)
//   requireCaller  - middleware: every route but /healthz needs a caller; claims in res.locals.caller
import type { NextFunction, Request, Response } from 'express';
import { importSPKI, jwtVerify, type JWTPayload } from 'jose';
import { createHash, timingSafeEqual } from 'node:crypto';
import { settings } from './config.ts';
import { HttpError } from './http.ts';

export type Audience = 'zenera-manager' | 'zenera-runtime';

export interface CallerClaims extends JWTPayload {
    sub: string;
    prj: string;
    req: string;
    thr?: string;
    role?: string;
    email?: string;
    /** a token-mode caller: the thread is the one the route names */
    local?: boolean;
}

const OPEN = new Set(['/healthz']);

let key: { pem: string; key: ReturnType<typeof importSPKI> } | undefined;

function publicKey(pem: string): ReturnType<typeof importSPKI> {
    if (!pem) {
        throw new HttpError(503, 'this server has no identity public key, so it accepts no caller');
    }
    if (key?.pem !== pem) key = { pem, key: importSPKI(pem, 'EdDSA') };
    return key.key;
}

function bearer(req: Request): string {
    const header = req.get('authorization') ?? '';
    if (!header.startsWith('Bearer ')) throw new HttpError(401, 'no caller token');
    return header.slice('Bearer '.length);
}

function sameToken(given: string, expected: string): boolean {
    const a = createHash('sha256').update(given).digest();
    const b = createHash('sha256').update(expected).digest();
    return timingSafeEqual(a, b);
}

export async function verifyCaller(req: Request, audience: Audience): Promise<CallerClaims> {
    const s = settings();
    if (!s.projectId) throw new HttpError(503, 'this server has no project id');
    const token = bearer(req);
    if (s.auth.mode === 'token') {
        if (!s.userId) throw new HttpError(503, 'a token-mode server needs its user');
        if (!sameToken(token, s.auth.token)) throw new HttpError(401, 'invalid caller token');
        return {
            sub: s.userId,
            prj: s.projectId,
            req: `${req.method} ${req.originalUrl}`,
            role: 'owner',
            local: true,
        };
    }
    let verifyKey: Awaited<ReturnType<typeof importSPKI>>;
    try {
        verifyKey = await publicKey(s.auth.publicKey);
    } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(503, `the identity public key is not an Ed25519 public key: ${err}`);
    }
    let payload: JWTPayload;
    try {
        ({ payload } = await jwtVerify(token, verifyKey, {
            algorithms: ['EdDSA'],
            issuer: 'zenera-app',
            audience,
            requiredClaims: ['sub', 'iat', 'exp'],
            clockTolerance: 30,
            maxTokenAge: '2m',
        }));
    } catch (err) {
        throw new HttpError(
            401,
            `invalid caller token: ${err instanceof Error ? err.message : err}`,
        );
    }
    if (payload.prj !== s.projectId) throw new HttpError(403, 'the token is for another project');
    // Bound to one request: a token seen in transit is no good for any other route.
    if (payload.req !== `${req.method} ${req.originalUrl}`) {
        throw new HttpError(401, 'the token is for another request');
    }
    // A single-user server serves its user's files and nobody else's.
    if (s.userId && String(payload.sub).toLowerCase() !== s.userId.toLowerCase()) {
        throw new HttpError(403, 'the token is for another user');
    }
    return payload as CallerClaims;
}

export function requireCaller(audience: Audience) {
    return async (req: Request, res: Response, next: NextFunction) => {
        if (OPEN.has(req.path)) {
            next();
            return;
        }
        res.locals.caller = await verifyCaller(req, audience);
        next();
    };
}
