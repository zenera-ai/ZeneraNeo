import {
    readProjectConfig,
    type RunIdentity,
    type Sandbox,
    type SandboxFactory,
} from '@zenera/neo';
import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { posix, resolve } from 'node:path';
import { resolveUser } from './engine.ts';
import { loadProjectEnv } from './env.ts';
import {
    AgentFileError,
    agentFileStatus,
    resolveAgentFile,
    sendAgentFile,
    type AgentFile,
    type FileTrees,
} from './files.ts';
import { KeyStore } from './keys.ts';
import { projectMounts } from './projects.ts';
import { buildSandbox, prepareHome, type SandboxSetup } from './sandbox.ts';
import { readSessionMeta, type SessionPaths } from './session.ts';

// ---------------------------------------------------------------------------
// App calls: an html page calling the Python functions of an `*.api.py` beside it
//
// Part of @zenera/engine, for the html-page skill's pages with functions. A page at
// `/v/<token>/workspace/pages/todo/index.html` calls `api('api/items').add_item({...})`,
// which is `POST /v/<token>/workspace/pages/todo/api/items/add_item`: the function
// `add_item` of `/workspace/pages/todo/api/items.api.py`. The call runs in the session's
// sandbox, exactly as a command of the agent's would, as
// `python3 -m zenera.api --serve items.api.py` in the file's folder, with the request on
// stdin and one JSON envelope `{status, headers, body}` back on stdout (the runtime
// library's zenera/api.py).
//
// Main functions:
//   serveViewPath      - one request for a path under a page's view URL: the file (GET|HEAD), or
//                        a call of a function; what both zen server and zenera-project serve
//   AppCalls           - a host's calls: a sandbox kept per thread, a limit per user, the body
//                        read with a cap, the answer sent (marked X-Zenera-Call)
//   ViewError          - what serveViewPath throws: an HTTP status and message for the host
//   resolveAppCall     - a path under /v/ -> the .api.py and the function it names, or null
//   isAppApiFile       - whether a path is an .api.py (never sent as a file through /v/)
//   appCallCommand     - the shell script one call runs as (request in a here-document)
//   runAppCall         - runs a call in a sandbox and maps the outcome to an HTTP answer
//   openSessionSandbox - a session's sandbox without a turn: the mounts, environment, user
//                        and limits a turn's commands get, so a call sees no more than they do
//
// Used by: @zenera/server views.ts and appCalls.ts (zen server's /v/ route and, in jwt mode,
// /api/sessions/:tid/view/*), ZeneraLite's zenera-project (the Test tab's view route).
// ---------------------------------------------------------------------------

export const APP_API_SUFFIX = '.api.py';

/** What a page may name as a function: what zenera.api calls (public, a Python identifier). */
const FUNCTION = /^[A-Za-z][A-Za-z0-9_]{0,99}$/;

/** The largest request body a call takes; it travels inside the call's script. */
export const MAX_APP_REQUEST_BYTES = 1024 * 1024;

/**
 * The most a call may print, on stdout and on stderr each. Far above a command's 64 KB:
 * the answer is a page's data (a whole report, say), not text for a model's context.
 */
export const MAX_APP_ANSWER_BYTES = 10 * 1024 * 1024;

/** How long one call may take, in seconds. */
export const APP_CALL_TIMEOUT_SECONDS = 30;

const STDERR_TAIL = 4000;

export interface AppCall {
    /** the .api.py, resolved and contained like any file a page reads */
    file: AgentFile;
    /** the function's name */
    fn: string;
    /**
     * Where the call keeps its data (ZEN_APP_DATA), when not beside the file: a file under the
     * read-only /assets keeps each user's data in their own workspace.
     */
    dataDir?: string;
}

export function isAppApiFile(path: string): boolean {
    return path.toLowerCase().endsWith(APP_API_SUFFIX);
}

/**
 * The call a path names, `<dir>/<file>/<function>` for `<dir>/<file>.api.py`, or null when it
 * names none (no such file, or not a function's name). A file that is there but may not be
 * read (a dot-folder, outside the trees) throws its AgentFileError, as it would for the page.
 */
export function resolveAppCall(path: string, trees: FileTrees): AppCall | null {
    const clean = posix.normalize(path.replace(/\\/g, '/')).replace(/\/+$/, '');
    const cut = clean.lastIndexOf('/');
    const fn = clean.slice(cut + 1);
    const base = clean.slice(0, cut);
    if (cut <= 0 || !FUNCTION.test(fn) || !base || base.endsWith('/')) return null;
    try {
        const file = resolveAgentFile(`${base}${APP_API_SUFFIX}`, trees);
        if (file.tree !== 'assets') return { file, fn };
        const id = createHash('sha256').update(file.path).digest('hex').slice(0, 16);
        return {
            file,
            fn,
            dataDir: posix.join(posix.normalize(trees.workdir), '.data', 'apps', id),
        };
    } catch (err) {
        if (err instanceof AgentFileError && (err.code === 'missing' || err.code === 'invalid')) {
            return null;
        }
        throw err;
    }
}

/** What a call is asked with: the page's request, as zenera.api reads it. */
export interface AppRequest {
    method: string;
    fn: string;
    query: Record<string, string | string[]>;
    headers: Record<string, string>;
    /** the raw body: the page sends JSON as text/plain, zenera.api parses it */
    body: string;
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The script a call runs: into the file's folder, then zenera.api with the request in a
 * here-document. The request is one line of JSON (JSON.stringify escapes every newline), so a
 * random delimiter on a line of its own cannot occur in it; nothing of the page's is ever
 * parsed by the shell.
 */
export function appCallCommand(file: string, req: AppRequest, dataDir?: string): string {
    const json = JSON.stringify({
        method: req.method,
        path: `/${req.fn}`,
        query: req.query,
        headers: req.headers,
        body: req.body,
    });
    let end: string;
    do end = `ZEN_REQ_${randomBytes(12).toString('hex')}`;
    while (json.includes(end));
    return [
        `cd ${quote(posix.dirname(file))} && ${dataDir ? `ZEN_APP_DATA=${quote(dataDir)} ` : ''}exec python3 -m zenera.api --serve ${quote(posix.basename(file))} <<'${end}'`,
        json,
        end,
        '',
    ].join('\n');
}

export interface AppAnswer {
    status: number;
    /** besides Content-Type, which is always JSON */
    headers: Record<string, string>;
    /** JSON text */
    body: string;
}

/** Headers a function may set on its answer; the rest are the server's. */
const PASSED_HEADER = /^(cache-control|x-[a-z0-9-]+)$/i;

const failed = (status: number, error: string, stderr?: string): AppAnswer => ({
    status,
    headers: {},
    body: JSON.stringify(stderr ? { error, stderr } : { error }),
});

const tail = (text: string) => (text.length > STDERR_TAIL ? text.slice(-STDERR_TAIL) : text);

/** The HTTP answer for what a call's process did. */
export function appAnswer(result: Awaited<ReturnType<Sandbox['exec']>>, file: string): AppAnswer {
    const name = posix.basename(file);
    const stderr = tail(result.stderr.trim());
    if (result.timed_out) {
        return failed(504, `${name} took longer than ${APP_CALL_TIMEOUT_SECONDS} seconds`);
    }
    if (result.out_of_memory) {
        return failed(503, `${name} ran out of memory: ${result.out_of_memory.hint}`);
    }
    if (result.truncated) {
        return failed(
            502,
            `${name} answered with more than ${MAX_APP_ANSWER_BYTES / (1024 * 1024)} MB of output`,
        );
    }
    const last = result.stdout.trim().split('\n').pop() ?? '';
    let envelope: unknown;
    try {
        envelope = JSON.parse(last);
    } catch {
        envelope = undefined;
    }
    const e = envelope as { status?: unknown; headers?: unknown; body?: unknown } | undefined;
    if (result.exit_code !== 0 || !e || typeof e.status !== 'number') {
        const why =
            /python3: (not found|command not found)|No such file or directory.*python3/.test(stderr)
                ? 'python3 is not installed in the sandbox'
                : /No module named zenera/.test(stderr)
                  ? 'the zenera library is not in the sandbox'
                  : `${name} failed (exit ${result.exit_code})`;
        return failed(500, why, stderr);
    }
    const headers: Record<string, string> = {};
    if (e.headers && typeof e.headers === 'object') {
        for (const [k, v] of Object.entries(e.headers)) {
            if (PASSED_HEADER.test(k) && typeof v === 'string' && !/[\r\n]/.test(v)) headers[k] = v;
        }
    }
    const status =
        Number.isInteger(e.status) && e.status >= 200 && e.status <= 599 ? e.status : 500;
    return { status, headers, body: JSON.stringify(e.body ?? null) };
}

/** Runs one call in the sandbox; never throws for what the call did, only for the sandbox. */
export async function runAppCall(
    sandbox: Sandbox,
    call: AppCall,
    req: Omit<AppRequest, 'fn'>,
    signal?: AbortSignal,
): Promise<AppAnswer> {
    if (Buffer.byteLength(req.body) > MAX_APP_REQUEST_BYTES) {
        return failed(413, `the arguments are larger than ${MAX_APP_REQUEST_BYTES} bytes`);
    }
    const command = appCallCommand(call.file.path, { ...req, fn: call.fn }, call.dataDir);
    const result = await sandbox.exec(command, {
        timeout: APP_CALL_TIMEOUT_SECONDS,
        maxBytes: MAX_APP_ANSWER_BYTES,
        ...(signal ? { signal } : {}),
    });
    return appAnswer(result, call.file.path);
}

export interface SessionSandboxOptions {
    /** the project the session belongs to */
    projectDir: string;
    session: SessionPaths;
    /** who the calls act for: ZEN_USER_* in every command; null is nobody */
    user: RunIdentity | null;
    /** the host's sandbox; podman on this machine when unset */
    newSandbox?: SandboxFactory;
    provider?: string;
}

/**
 * A session's sandbox as a turn would open it (buildSandbox with the project's config, mounts,
 * `.env` names, keys and user), with no model, plugins or tools: for running a page's calls
 * between turns. Never persisted; the caller closes it.
 */
export async function openSessionSandbox(opts: SessionSandboxOptions): Promise<SandboxSetup> {
    const env = loadProjectEnv(opts.projectDir);
    // As a turn does, so the credentials a command is given are the same.
    (await KeyStore.open()).materialize();
    const { root, config } = readProjectConfig(opts.projectDir);
    const meta = await readSessionMeta(opts.session);
    const setup = buildSandbox({
        config,
        root,
        session: opts.session,
        workspace: resolve(meta.workspace),
        env: env?.names,
        mounts: projectMounts(root, config),
        identity: resolveUser(opts.user),
        newSandbox: opts.newSandbox,
        provider: opts.provider,
        persist: false,
    });
    prepareHome(setup);
    return setup;
}

/** What serveViewPath and AppCalls throw for the host to answer: a status and a message. */
export class ViewError extends Error {
    readonly status: number;
    readonly code?: string;
    constructor(status: number, message: string, code?: string) {
        super(message);
        this.name = 'ViewError';
        this.status = status;
        if (code) this.code = code;
    }
}

/** Marks every answer a call gave, so a host in front never asks a pod again for it. */
export const APP_CALL_HEADER = 'X-Zenera-Call';

/** A thread's sandbox is closed this long after its last call. */
export const APP_SANDBOX_IDLE_MS = 2 * 60_000;
/** Calls one owner may have running at once; more answer 429. */
export const MAX_OWNER_APP_CALLS = 4;

/** A thread whose page calls: whose it is, and its session. */
export interface AppCallThread {
    /** the user the thread belongs to (its folder); the calls limit counts per owner */
    owner: string;
    id: string;
    session: SessionPaths;
}

export interface AppCallsOptions {
    /**
     * opens the thread's sandbox, ready to run (image checked): openSessionSandbox and a
     * preflight; or, for code already inside one (`zen page`), a ProcessSandbox
     */
    open(t: AppCallThread, user: RunIdentity | null): Promise<Pick<SandboxSetup, 'sandbox'>>;
    /** after a call that may have changed the thread's files (any but GET|HEAD) */
    changed?(t: AppCallThread): void;
    /** what a call that failed is said as in the host's log */
    warn?(message: string, detail: string): void;
}

interface Kept {
    setup: Promise<Pick<SandboxSetup, 'sandbox'>>;
    calls: number;
    timer?: NodeJS.Timeout;
}

const READS = new Set(['GET', 'HEAD']);

/** The headers a call's answer goes out with, besides what its function set. */
function callHeaders(res: ServerResponse, extra: Record<string, string> = {}): void {
    for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (!extra['cache-control']) res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // The page's origin is opaque; the URL is the credential, nothing else rides along.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Security-Policy', 'sandbox');
    res.setHeader(APP_CALL_HEADER, '1');
}

function answerWith(
    res: ServerResponse,
    status: number,
    body: string,
    extra?: Record<string, string>,
) {
    res.statusCode = status;
    callHeaders(res, extra);
    res.end(body);
}

async function readBody(req: IncomingMessage): Promise<string> {
    if (READS.has(req.method ?? 'GET')) return '';
    const declared = Number(req.headers['content-length'] ?? 0);
    const tooLarge = () =>
        new ViewError(413, `the arguments are larger than ${MAX_APP_REQUEST_BYTES} bytes`);
    if (declared > MAX_APP_REQUEST_BYTES) throw tooLarge();
    // A host's body parser may have read a JSON body already.
    const parsed = (req as IncomingMessage & { body?: unknown }).body;
    if (parsed !== undefined && req.readableEnded) {
        const text = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
        if (Buffer.byteLength(text) > MAX_APP_REQUEST_BYTES) throw tooLarge();
        return text;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > MAX_APP_REQUEST_BYTES) throw tooLarge();
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}

function queryOf(req: IncomingMessage): Record<string, string | string[]> {
    const out: Record<string, string | string[]> = {};
    for (const [k, v] of new URL(req.url ?? '/', 'http://x').searchParams) {
        const had = out[k];
        out[k] = had === undefined ? v : Array.isArray(had) ? [...had, v] : [had, v];
    }
    return out;
}

const errorText = (err: unknown) =>
    (err as { hint?: string }).hint
        ? `${(err as Error).message} (${(err as { hint: string }).hint})`
        : err instanceof Error
          ? err.message
          : String(err);

/**
 * A host's page calls. One sandbox per thread, opened by the first call and kept while calls
 * come (so podman starts its container once), closed after APP_SANDBOX_IDLE_MS without one.
 * Every answer of a call, its function's or the reason it could not run, is marked
 * X-Zenera-Call; what goes wrong before (a body too large) is thrown as a ViewError.
 */
export class AppCalls {
    readonly #opts: AppCallsOptions;
    readonly #kept = new Map<string, Kept>();
    readonly #running = new Map<string, number>();

    constructor(opts: AppCallsOptions) {
        this.#opts = opts;
    }

    #sandbox(t: AppCallThread, user: RunIdentity | null): { key: string; entry: Kept } {
        const key = `${t.owner}/${t.id}`;
        let entry = this.#kept.get(key);
        if (!entry) {
            const fresh: Kept = { calls: 0, setup: this.#opts.open(t, user) };
            // Not kept when it did not open, so the next call tries again; the call that
            // awaits it answers with the reason.
            fresh.setup.catch(() => {
                if (this.#kept.get(key) === fresh) this.#kept.delete(key);
            });
            this.#kept.set(key, fresh);
            entry = fresh;
        }
        clearTimeout(entry.timer);
        return { key, entry };
    }

    #close(key: string, entry: Kept): void {
        if (this.#kept.get(key) === entry) this.#kept.delete(key);
        void entry.setup
            .then((s) => s.sandbox.close())
            .catch((err) =>
                console.warn(`app calls ${key}: closing the sandbox failed; dropped`, err),
            );
    }

    /** One call of a page's, for `t`, acting for `user` (ZEN_USER_* in the call). */
    async serve(
        req: IncomingMessage,
        res: ServerResponse,
        t: AppCallThread,
        call: AppCall,
        user: RunIdentity | null,
    ): Promise<void> {
        const body = await readBody(req);
        const busy = this.#running.get(t.owner) ?? 0;
        if (busy >= MAX_OWNER_APP_CALLS) {
            answerWith(
                res,
                429,
                JSON.stringify({ error: 'too many calls at once: try again in a moment' }),
                {
                    'Retry-After': '1',
                },
            );
            return;
        }
        this.#running.set(t.owner, busy + 1);
        const { key, entry } = this.#sandbox(t, user);
        entry.calls++;
        const left = new AbortController();
        res.on('close', () => left.abort());
        try {
            let setup: Pick<SandboxSetup, 'sandbox'>;
            try {
                setup = await entry.setup;
            } catch (err) {
                const status =
                    typeof (err as { status?: unknown }).status === 'number'
                        ? (err as { status: number }).status
                        : 503;
                this.#opts.warn?.(`app calls ${key}: the sandbox did not open`, errorText(err));
                answerWith(
                    res,
                    status,
                    JSON.stringify({ error: `the sandbox is not ready: ${errorText(err)}` }),
                );
                return;
            }
            const method = req.method ?? 'POST';
            const answer = await runAppCall(
                setup.sandbox,
                call,
                {
                    method,
                    query: queryOf(req),
                    headers: { 'content-type': String(req.headers['content-type'] ?? '') },
                    body,
                },
                left.signal,
            );
            if (answer.status >= 500) {
                this.#opts.warn?.(
                    `app calls ${key}: ${call.file.path} ${call.fn} answered ${answer.status}`,
                    answer.body.slice(0, 2000),
                );
            }
            if (!READS.has(method)) this.#opts.changed?.(t);
            answerWith(res, answer.status, answer.body, answer.headers);
        } finally {
            const left = (this.#running.get(t.owner) ?? 1) - 1;
            if (left > 0) this.#running.set(t.owner, left);
            else this.#running.delete(t.owner);
            entry.calls--;
            if (entry.calls === 0 && this.#kept.get(key) === entry) {
                entry.timer = setTimeout(() => this.#close(key, entry), APP_SANDBOX_IDLE_MS);
                entry.timer.unref();
            }
        }
    }

    /** Closes a thread's kept sandbox now (the thread deleted, its user released). */
    forget(owner: string, id: string): void {
        const key = `${owner}/${id}`;
        const entry = this.#kept.get(key);
        if (entry) {
            clearTimeout(entry.timer);
            this.#close(key, entry);
        }
    }

    /** Closes every kept sandbox (the host stops). */
    async close(): Promise<void> {
        const all = [...this.#kept.entries()];
        this.#kept.clear();
        await Promise.all(
            all.map(async ([key, entry]) => {
                clearTimeout(entry.timer);
                try {
                    await (await entry.setup).sandbox.close();
                } catch (err) {
                    console.warn(
                        `app calls ${key}: closing the sandbox on stop failed; dropped`,
                        err,
                    );
                }
            }),
        );
    }
}

export interface ServeViewOptions {
    /** the agent path asked for: `/workspace/pages/todo/api/items/add` */
    path: string;
    trees: FileTrees;
    /** the thread's calls; none: the path is a file or nothing (a host without calls) */
    calls?: { calls: AppCalls; thread: AppCallThread; user: RunIdentity | null };
    /** who may frame a page (viewCsp); `'self'` by default */
    frameAncestors?: readonly string[];
}

const pathText = (path: string) => path.slice(0, 200);

/**
 * One request under a page's view URL: on GET|HEAD the file, sent for viewing; otherwise, or
 * when there is no such file, a call of the `*.api.py` function the path names. An `*.api.py`
 * itself is never sent. Throws ViewError (the file's AgentFileError as its status).
 */
export async function serveViewPath(
    req: IncomingMessage,
    res: ServerResponse,
    opts: ServeViewOptions,
): Promise<void> {
    const read = READS.has(req.method ?? 'GET');
    try {
        if (read) {
            try {
                const file = resolveAgentFile(opts.path, opts.trees);
                if (isAppApiFile(file.path)) {
                    throw new ViewError(404, `no such file: ${pathText(opts.path)}`, 'missing');
                }
                await sendAgentFile(req, res, file, {
                    view: { frameAncestors: opts.frameAncestors ?? ["'self'"] },
                });
                return;
            } catch (err) {
                // Not a file: it may still be a function's name.
                if (!(err instanceof AgentFileError && err.code === 'missing')) throw err;
            }
        }
        const call = opts.calls ? resolveAppCall(opts.path, opts.trees) : null;
        if (!call || !opts.calls) {
            throw new ViewError(
                404,
                read
                    ? `no such file: ${pathText(opts.path)}`
                    : `no function at ${pathText(opts.path)}`,
                'missing',
            );
        }
        await opts.calls.calls.serve(req, res, opts.calls.thread, call, opts.calls.user);
    } catch (err) {
        if (err instanceof AgentFileError) {
            throw new ViewError(agentFileStatus(err.code), err.message, err.code);
        }
        throw err;
    }
}
