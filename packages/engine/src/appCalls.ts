import {
    readProjectConfig,
    type RunIdentity,
    type Sandbox,
    type SandboxFactory,
} from '@zenera/neo';
import { randomBytes } from 'node:crypto';
import { posix, resolve } from 'node:path';
import { resolveUser } from './engine.ts';
import { loadProjectEnv } from './env.ts';
import { AgentFileError, resolveAgentFile, type AgentFile, type FileTrees } from './files.ts';
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
//   resolveAppCall     - a path under /v/ -> the .api.py and the function it names, or null
//   isAppApiFile       - whether a path is an .api.py (never sent as a file through /v/)
//   appCallCommand     - the shell script one call runs as (request in a here-document)
//   runAppCall         - runs a call in a sandbox and maps the outcome to an HTTP answer
//   openSessionSandbox - a session's sandbox without a turn: the mounts, environment, user
//                        and limits a turn's commands get, so a call sees no more than they do
//
// Used by: @zenera/server views.ts and appCalls.ts (zen server's /v/ route).
// ---------------------------------------------------------------------------

export const APP_API_SUFFIX = '.api.py';

/** What a page may name as a function: what zenera.api calls (public, a Python identifier). */
const FUNCTION = /^[A-Za-z][A-Za-z0-9_]{0,99}$/;

/** The largest request body a call takes; it travels inside the call's script. */
export const MAX_APP_REQUEST_BYTES = 1024 * 1024;

/** How long one call may take, in seconds. */
export const APP_CALL_TIMEOUT_SECONDS = 30;

const STDERR_TAIL = 4000;

export interface AppCall {
    /** the .api.py, resolved and contained like any file a page reads */
    file: AgentFile;
    /** the function's name */
    fn: string;
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
        return { file: resolveAgentFile(`${base}${APP_API_SUFFIX}`, trees), fn };
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
export function appCallCommand(file: string, req: AppRequest): string {
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
        `cd ${quote(posix.dirname(file))} && exec python3 -m zenera.api --serve ${quote(posix.basename(file))} <<'${end}'`,
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
    if (result.truncated) return failed(502, `${name} answered with too much output`);
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
    const result = await sandbox.exec(appCallCommand(call.file.path, { ...req, fn: call.fn }), {
        timeout: APP_CALL_TIMEOUT_SECONDS,
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
