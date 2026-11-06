// Shared error handling for the manager's routes.
//   HttpError     - throw it from a route to answer with that status and message
//   notFound      - JSON 404 for unknown paths
//   errorHandler  - turns any thrown error into a JSON `{ error }` response
import type { NextFunction, Request, Response } from 'express';

export class HttpError extends Error {
    readonly status: number;
    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

export function errorMessage(err: unknown): string {
    const e = err as { stderr?: string; message?: string };
    return (e?.stderr || e?.message || String(err)).trim();
}

export function notFound(_req: Request, res: Response): void {
    res.status(404).json({ error: 'Not found' });
}

// Express 5 forwards rejected async handlers here, so routes just throw.
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
    if (res.headersSent) {
        res.end();
        return;
    }
    const status =
        err instanceof HttpError ? err.status : ((err as { status?: number })?.status ?? 500);
    if (status >= 500) console.error(`${req.method} ${req.originalUrl}:`, err);
    res.status(status).json({ error: errorMessage(err) });
}
