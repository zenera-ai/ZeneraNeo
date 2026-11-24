// A page's calls to the Python functions of its `*.api.py` files, served by zen server
// (@zenera/server) under /v/ in `insecure` mode (views.ts).
//
// `POST /v/<token>/workspace/pages/todo/api/items/add_item` runs `add_item` of
// `/workspace/pages/todo/api/items.api.py` in the thread's sandbox, the one its turns' commands
// run in, as the token's user (@zenera/engine appCalls.ts). A sandbox is kept per thread while
// its page calls, so podman starts its container once, and closed after it goes quiet.
//
// Main functions:
//   serveAppCall      - one call: the body read (capped), the sandbox found, the answer sent
//   closeAppSandboxes - closes every kept sandbox (server stop)
// Used by: views.ts; server.ts (closeAppSandboxes on stop).
import {
    MAX_APP_REQUEST_BYTES,
    openSessionSandbox,
    runAppCall,
    type AppCall,
    type RunIdentity,
    type SandboxSetup,
    type SessionPaths,
} from '@zenera/engine';
import type { Request, Response } from 'express';
import { settings } from './config.ts';
import { HttpError } from './http.ts';
import { applyProjectEnv } from './projectEnv.ts';
import { asHttpError, imageReady, serverSandbox, type ChatThread } from './store.ts';
import { userStates } from './userState.ts';

/** A thread's sandbox is closed this long after its last call. */
const IDLE_MS = 2 * 60_000;
/** Calls one user may have running at once; more answer 429. */
const MAX_USER_CALLS = 4;

interface Kept {
    setup: Promise<SandboxSetup>;
    calls: number;
    timer?: NodeJS.Timeout;
}

const kept = new Map<string, Kept>();
const running = new Map<string, number>();

function close(key: string, entry: Kept): void {
    if (kept.get(key) === entry) kept.delete(key);
    void entry.setup
        .then((s) => s.sandbox.close())
        .catch((err) => console.warn(`appCalls ${key}: closing the sandbox failed; dropped`, err));
}

function sandboxFor(t: ChatThread, session: SessionPaths, user: RunIdentity): Kept {
    const key = `${t.owner}/${t.id}`;
    let entry = kept.get(key);
    if (!entry) {
        const fresh: Kept = {
            calls: 0,
            setup: (async () => {
                applyProjectEnv();
                const setup = await openSessionSandbox({
                    projectDir: settings().projectDir,
                    session,
                    user,
                    newSandbox: serverSandbox(),
                    provider: settings().sandboxProvider,
                });
                await (settings().preflight ?? imageReady)(setup);
                return setup;
            })(),
        };
        // A sandbox that did not open is not kept: the next call tries again.
        fresh.setup.catch(() => {
            if (kept.get(key) === fresh) kept.delete(key);
        });
        kept.set(key, fresh);
        entry = fresh;
    }
    clearTimeout(entry.timer);
    return entry;
}

async function readBody(req: Request): Promise<string> {
    if (req.method === 'GET' || req.method === 'HEAD') return '';
    const declared = Number(req.get('content-length') ?? 0);
    if (declared > MAX_APP_REQUEST_BYTES) {
        throw new HttpError(413, `the arguments are larger than ${MAX_APP_REQUEST_BYTES} bytes`);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > MAX_APP_REQUEST_BYTES) {
            throw new HttpError(
                413,
                `the arguments are larger than ${MAX_APP_REQUEST_BYTES} bytes`,
            );
        }
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}

function queryOf(req: Request): Record<string, string | string[]> {
    const out: Record<string, string | string[]> = {};
    for (const [k, v] of new URL(req.originalUrl, 'http://x').searchParams) {
        const had = out[k];
        out[k] = had === undefined ? v : Array.isArray(had) ? [...had, v] : [had, v];
    }
    return out;
}

/**
 * One call of a page's, for the token's thread, acting for `user` (ZEN_USER_* in the call, as in
 * the thread's turns); the caller has checked the session is there.
 */
export async function serveAppCall(
    req: Request,
    res: Response,
    t: ChatThread,
    session: SessionPaths,
    call: AppCall,
    user: RunIdentity,
): Promise<void> {
    const body = await readBody(req);
    const busy = running.get(t.owner) ?? 0;
    if (busy >= MAX_USER_CALLS) {
        res.set('Retry-After', '1');
        throw new HttpError(429, 'too many calls at once: try again in a moment');
    }
    running.set(t.owner, busy + 1);
    const key = `${t.owner}/${t.id}`;
    const entry = sandboxFor(t, session, user);
    entry.calls++;
    const left = new AbortController();
    res.on('close', () => left.abort());
    try {
        let setup: SandboxSetup;
        try {
            setup = await entry.setup;
        } catch (err) {
            throw asHttpError(err);
        }
        const answer = await runAppCall(
            setup.sandbox,
            call,
            {
                method: req.method,
                query: queryOf(req),
                headers: { 'content-type': req.get('content-type') ?? '' },
                body,
            },
            left.signal,
        );
        if (answer.status >= 500) {
            console.warn(
                `appCalls ${key}: ${call.file.path} ${call.fn} answered ${answer.status}`,
                answer.body.slice(0, 2000),
            );
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') userStates.changed(t.owner, 'changed');
        res.status(answer.status);
        res.set({
            ...answer.headers,
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': answer.headers['cache-control'] ?? 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer',
            // The page's origin is opaque; the URL is the credential, nothing else rides along.
            'Access-Control-Allow-Origin': '*',
            'Content-Security-Policy': 'sandbox',
        });
        res.send(answer.body);
    } finally {
        running.set(t.owner, (running.get(t.owner) ?? 1) - 1);
        if (running.get(t.owner) === 0) running.delete(t.owner);
        entry.calls--;
        if (entry.calls === 0 && kept.get(key) === entry) {
            entry.timer = setTimeout(() => close(key, entry), IDLE_MS);
            entry.timer.unref();
        }
    }
}

export async function closeAppSandboxes(): Promise<void> {
    const all = [...kept.entries()];
    kept.clear();
    await Promise.all(
        all.map(async ([key, entry]) => {
            clearTimeout(entry.timer);
            try {
                await (await entry.setup).sandbox.close();
            } catch (err) {
                console.warn(`appCalls ${key}: closing the sandbox on stop failed; dropped`, err);
            }
        }),
    );
}
