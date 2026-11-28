import { mkdtempSync, rmSync } from 'node:fs';
import {
    createServer,
    request,
    type IncomingHttpHeaders,
    type IncomingMessage,
    type Server,
    type ServerResponse,
} from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    AppCalls,
    serveViewPath,
    ViewError,
    type AppCallThread,
    type FileTrees,
} from '@zenera/engine';
import { ProcessSandbox } from '@zenera/sandbox';

// ---------------------------------------------------------------------------
// Serving a page to `zen page`'s browser the way `/v/` serves it
//
// The browser asks for `https://page.invalid/<agent path>`; `zen page` hands every such request
// here, to the very `serveViewPath` zen server's `/v/` route and zenera-project's Test-tab views
// call: what a path is (a file, a function of an `*.api.py`, or nothing), the view CSP, the
// call limits. Nothing here knows how a page's functions run. By default they run in a
// ProcessSandbox, for `zen page`, which is already where the session's commands run (inside its
// sandbox) or on a person's own machine for their own folder. A host outside the sandbox (zen
// server's browser tools) passes its own `calls`: the session's AppCalls, which run them there.
//
// `serveViewPath` speaks Node's http, so it is served on a Unix socket in a private temp
// folder (no port: a pod's loopback is shared by its users) and asked over it.
//
// Main: PageHost.start(trees) - the server; host.fetch(...) - one request through it;
// PAGE_ORIGIN - the origin pages are opened under.
// Used by: session.ts (the browser's request handler); @zenera/cli `zen page`.
// ---------------------------------------------------------------------------

/** Where a local page is opened from: a name that never resolves, answered by the host only. */
export const PAGE_ORIGIN = 'https://page.invalid';

export interface PageRequest {
    method: string;
    /** the agent path with its query: `/workspace/pages/todo/api/items/list?x=1` */
    path: string;
    headers: Record<string, string>;
    body?: Buffer;
}

export interface PageAnswer {
    status: number;
    headers: Record<string, string>;
    body: Buffer;
}

export interface PageHostOptions {
    trees: FileTrees;
    /** directories in front of PYTHONPATH for a page's functions: zen's runtime library */
    pythonPath?: readonly string[];
    /**
     * Where a page's functions run, and for whom: a host's AppCalls for the session's thread.
     * Unset: in this process's environment (a ProcessSandbox), acting for nobody in particular.
     */
    calls?: { calls: AppCalls; thread: AppCallThread; user: Parameters<AppCalls['serve']>[4] };
}

/**
 * Request headers not passed on: the host answers uncompressed and whole (a routed browser keeps
 * no cache to revalidate), and is no one's host.
 */
const DROPPED = new Set([
    'host',
    'accept-encoding',
    'connection',
    'content-length',
    'if-none-match',
    'if-modified-since',
    'if-range',
]);

/** Response headers about the connection to the host, not about the answer. */
const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'date']);

export class PageHost {
    readonly trees: FileTrees;
    readonly #server: Server;
    readonly #dir: string;
    readonly #socket: string;
    readonly #calls: NonNullable<PageHostOptions['calls']>;
    /** ours to close: the default, not a host's */
    readonly #ownCalls: AppCalls | null;

    private constructor(opts: PageHostOptions, server: Server, dir: string, socket: string) {
        this.trees = opts.trees;
        this.#server = server;
        this.#dir = dir;
        this.#socket = socket;
        // A fresh one each time: AppCalls closes a kept sandbox after a while without calls.
        const sandbox = () =>
            new ProcessSandbox({
                root: opts.trees.workspace,
                ...(opts.pythonPath?.length
                    ? {
                          execPaths: { PYTHONPATH: opts.pythonPath },
                          // zen's own runtime sources: no __pycache__ written beside them.
                          env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
                      }
                    : {}),
            });
        this.#ownCalls = opts.calls
            ? null
            : new AppCalls({ open: async () => ({ sandbox: sandbox() }) });
        this.#calls = opts.calls ?? {
            calls: this.#ownCalls!,
            // One page session, one owner; the sandbox is ours, so no session to open.
            thread: { owner: 'zen-page', id: 'page', session: undefined as never },
            user: null,
        };
    }

    static async start(opts: PageHostOptions): Promise<PageHost> {
        // mkdtemp makes the folder 0700: nobody else on the machine reaches the socket.
        const dir = mkdtempSync(join(tmpdir(), 'zen-page-'));
        const socket = join(dir, 'view.sock');
        const holder: { host?: PageHost } = {};
        const server = createServer((req, res) => void holder.host!.#serve(req, res));
        const host = new PageHost(opts, server, dir, socket);
        holder.host = host;
        await new Promise<void>((settle, fail) => {
            server.once('error', fail);
            server.listen(socket, () => {
                server.off('error', fail);
                settle();
            });
        });
        return host;
    }

    async #serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
        let path: string;
        try {
            path = decodeURIComponent(new URL(req.url ?? '/', PAGE_ORIGIN).pathname);
        } catch {
            res.statusCode = 400;
            res.end('bad path');
            return;
        }
        try {
            await serveViewPath(req, res, {
                path,
                trees: this.trees,
                calls: this.#calls,
            });
        } catch (err) {
            if (!(err instanceof ViewError)) {
                console.warn(`zen page: serving ${path} failed:`, err);
            }
            if (res.headersSent) {
                res.destroy();
                return;
            }
            res.statusCode = err instanceof ViewError ? err.status : 500;
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.end(err instanceof Error ? err.message : String(err));
        }
    }

    /** One request, as the browser made it, answered as `/v/` would answer it. */
    fetch(req: PageRequest): Promise<PageAnswer> {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) {
            if (!DROPPED.has(k.toLowerCase())) headers[k] = v;
        }
        if (req.body?.length) headers['content-length'] = String(req.body.length);
        return new Promise<PageAnswer>((settle, fail) => {
            const out = request(
                { socketPath: this.#socket, method: req.method, path: req.path, headers },
                (res) => {
                    const chunks: Buffer[] = [];
                    res.on('data', (c: Buffer) => chunks.push(c));
                    res.on('end', () =>
                        settle({
                            status: res.statusCode ?? 500,
                            headers: flat(res.headers),
                            body: Buffer.concat(chunks),
                        }),
                    );
                    res.on('error', fail);
                },
            );
            out.on('error', fail);
            out.end(req.body);
        });
    }

    async close(): Promise<void> {
        await this.#ownCalls?.close();
        await new Promise<void>((settle) => this.#server.close(() => settle()));
        rmSync(this.#dir, { recursive: true, force: true });
    }
}

function flat(headers: IncomingHttpHeaders): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
        if (v === undefined || HOP.has(k)) continue;
        out[k] = Array.isArray(v) ? v.join(', ') : v;
    }
    return out;
}
