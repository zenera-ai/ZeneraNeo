/**
 * Express middleware allowing the standalone file:// chat to reach an insecure runtime.
 * localFileCors handles Origin: null responses and restricted preflight methods/headers;
 * server.ts installs it before requireCaller so preflights work without bypassing
 * authentication on actual API requests. Secure servers do not enable this CORS policy.
 */
import type { NextFunction, Request, Response } from 'express';
import { settings } from './config.ts';
import { HttpError } from './http.ts';

const METHODS = new Set(['GET', 'POST', 'DELETE']);
const HEADERS = new Set(['authorization', 'content-type', 'accept']);

/** Local HTML has an opaque origin. This opt-in exists only for insecure dev servers. */
export function localFileCors(req: Request, res: Response, next: NextFunction): void {
    if (settings().auth.mode !== 'insecure' || req.get('origin') !== 'null') {
        next();
        return;
    }
    res.vary('Origin');
    res.set('Access-Control-Allow-Origin', 'null');
    if (req.method !== 'OPTIONS') {
        next();
        return;
    }
    const method = req.get('access-control-request-method');
    const headers = (req.get('access-control-request-headers') ?? '')
        .split(',')
        .map((header) => header.trim().toLowerCase())
        .filter(Boolean);
    if (!method || !METHODS.has(method) || headers.some((header) => !HEADERS.has(header))) {
        next(new HttpError(403, 'local-file request method or headers are not allowed'));
        return;
    }
    res.set('Access-Control-Allow-Methods', [...METHODS].join(', '));
    res.set('Access-Control-Allow-Headers', [...HEADERS].join(', '));
    // Older Chromium versions request this for a local-network preflight.
    if (req.get('access-control-request-private-network') === 'true') {
        res.set('Access-Control-Allow-Private-Network', 'true');
    }
    res.sendStatus(204);
}
