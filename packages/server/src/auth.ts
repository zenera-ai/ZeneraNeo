// Who may call the server, and as whom: a JWT in `Authorization: Bearer …`, signed per request by
// the host (zenera-app) with its EdDSA key. The server holds only the public key, so neither it
// nor a sandboxed command that reaches its port can make one.
//   verifyCaller   - the verified claims of a request, or an HttpError (401, 403, 503)
//   requireCaller  - middleware: every route but /healthz needs a caller; claims in res.locals.caller
//   unsignedToken  - a token for an `insecure` server: `zen server token`
//
// Checked, in `jwt` mode: the signature (EdDSA only), issuer, audience, age (at most 2 minutes,
// 30 s of clock skew), `prj` (this project), `req` ("<METHOD> <url>" of this very request).
// In `insecure` mode none of that: the token is only read. In both, `sub` names the user, and
// `thr`, `role` and `email`, when there, are checked by identity.ts.
import type { NextFunction, Request, Response } from 'express';
import { decodeJwt, importSPKI, jwtVerify, type JWTPayload } from 'jose';
import { settings } from './config.ts';
import { HttpError } from './http.ts';

export interface CallerClaims extends JWTPayload {
    sub: string;
    prj?: string;
    req?: string;
    thr?: string;
    role?: string;
    email?: string;
    name?: string;
}

const OPEN = new Set(['/healthz']);

let key: { pem: string; key: ReturnType<typeof importSPKI> } | undefined;

function publicKey(pem: string): ReturnType<typeof importSPKI> {
    if (key?.pem !== pem) key = { pem, key: importSPKI(pem, 'EdDSA') };
    return key.key;
}

function bearer(req: Request): string {
    const header = req.get('authorization') ?? '';
    if (!header.startsWith('Bearer ')) throw new HttpError(401, 'no caller token');
    return header.slice('Bearer '.length).trim();
}

export async function verifyCaller(req: Request): Promise<CallerClaims> {
    const s = settings();
    const token = bearer(req);
    let payload: JWTPayload;
    if (s.auth.mode === 'insecure') {
        try {
            payload = decodeJwt(token);
        } catch (err) {
            throw new HttpError(401, `not a token: ${err instanceof Error ? err.message : err}`);
        }
    } else {
        let verifyKey: Awaited<ReturnType<typeof importSPKI>>;
        try {
            verifyKey = await publicKey(s.auth.publicKey);
        } catch (err) {
            throw new HttpError(503, `the server's public key is not an Ed25519 key: ${err}`);
        }
        try {
            ({ payload } = await jwtVerify(token, verifyKey, {
                algorithms: ['EdDSA'],
                issuer: s.auth.issuer,
                audience: s.auth.audience,
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
        if (payload.prj !== s.projectId) {
            throw new HttpError(403, 'the token is for another project');
        }
        // Bound to one request: a token seen in transit is no good for any other.
        if (payload.req !== `${req.method} ${req.originalUrl}`) {
            throw new HttpError(401, 'the token is for another request');
        }
    }
    if (typeof payload.sub !== 'string' || !payload.sub.trim()) {
        throw new HttpError(401, 'the token names no user (sub)');
    }
    return payload as CallerClaims;
}

export function requireCaller() {
    return async (req: Request, res: Response, next: NextFunction) => {
        if (OPEN.has(req.path)) {
            next();
            return;
        }
        res.locals.caller = await verifyCaller(req);
        next();
    };
}

/** A token an `insecure` server takes: the claims, no signature. */
export function unsignedToken(claims: Record<string, unknown>): string {
    const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    return `${part({ alg: 'none', typ: 'JWT' })}.${part({ iat: now, ...claims })}.`;
}
