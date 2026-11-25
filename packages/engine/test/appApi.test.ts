/**
 * Tests of `zenera.api`, the Python library an html app's `*.api.py` functions run under.
 *
 * System: @zenera/engine runtime libraries (runtime/python/zenera/api.py), mounted at
 * /opt/zenera/runtime in every sandbox.
 * Used by: the html-page skill's pages with functions; hosts that serve /v/ run one call with
 * `python3 -m zenera.api --serve <file>`.
 *
 * Covers: one call through --serve (request on stdin, envelope on stdout), which functions a
 * page may call, how arguments are checked against annotations, errors, the app's SQLite data,
 * and the command an agent tries its functions with; and the engine side (src/appCalls.ts):
 * which path is a call, the script it runs as, and the HTTP answer for what it did.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecOptions, Sandbox } from '@zenera/neo';
import {
    appAnswer,
    appCallCommand,
    resolveAppCall,
    runAppCall,
    runtimeDir,
    type FileTrees,
} from '../src/index.ts';

const python = spawnSync('python3', ['--version']).status === 0;

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const APP = `
import datetime, decimal
from zenera.api import HttpError, Response, connect, request
from helper import shout

def hello(name: str, times: int = 1, loud: bool = False):
    """Says hello."""
    print("to the log")
    text = (shout(name) if loud else name) * times
    return {"text": text, "on": datetime.date(2026, 1, 2), "price": decimal.Decimal("1.50"),
            "nan": float("nan"), "method": request().method}

def tags(names: list):
    return sorted(names)

def make(title: str):
    return Response({"title": title}, status=201)

def missing(id: int):
    raise HttpError(404, f"no item {id}")

def broken():
    raise ValueError("bad data")

def count():
    db = connect()
    with db:
        db.execute("CREATE TABLE IF NOT EXISTS hits (at TEXT)")
        db.execute("INSERT INTO hits VALUES ('x')")
    return db.execute("SELECT count(*) AS n FROM hits").fetchone()

def _private():
    return "secret"
`;

function app(): { dir: string; file: string } {
    const dir = mkdtempSync(join(tmpdir(), 'zen-app-api-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'api'));
    writeFileSync(join(dir, 'api', 'items.api.py'), APP);
    writeFileSync(join(dir, 'api', 'helper.py'), 'def shout(s):\n    return s.upper()\n');
    return { dir: join(dir, 'api'), file: join(dir, 'api', 'items.api.py') };
}

function zenApi(
    cwd: string,
    args: string[],
    input = '',
    env: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
    const { ZEN_APP_DATA: _, ...rest } = process.env;
    return spawnSync('python3', ['-m', 'zenera.api', ...args], {
        cwd,
        input,
        encoding: 'utf8',
        env: {
            ...rest,
            ...env,
            PYTHONPATH: join(runtimeDir(), 'python'),
            PYTHONDONTWRITEBYTECODE: '1',
        },
    });
}

/** One call as a host makes it: the envelope it reads back. */
function serve(req: object, env: Record<string, string> = {}) {
    const { dir } = app();
    const run = zenApi(dir, ['--serve', 'items.api.py'], JSON.stringify(req), env);
    expect(run.status).toBe(0);
    return { ...JSON.parse(run.stdout), stderr: run.stderr, dir };
}

describe.runIf(python)('zenera.api', () => {
    it('answers a call with what the function returned, as JSON, and logs its prints', () => {
        const res = serve({
            method: 'POST',
            path: '/hello',
            // The page sends JSON as text/plain, so a host passes the raw text on.
            body: '{"name": "ann", "times": 2, "loud": true}',
        });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            text: 'ANNANN',
            on: '2026-01-02',
            price: 1.5,
            nan: null,
            method: 'POST',
        });
        expect(res.stderr).toContain('to the log');
    });

    it('takes a read as a query string, converted by the annotations', () => {
        const res = serve({
            method: 'GET',
            path: '/hello',
            query: { name: 'bo', times: '3', loud: 'false' },
        });
        expect(res.body.text).toBe('bobobo');
        expect(serve({ method: 'POST', path: '/tags', body: { names: ['b', 'a'] } }).body).toEqual([
            'a',
            'b',
        ]);
    });

    it('lets the page call only the public functions defined in the file', () => {
        for (const path of ['/_private', '/shout', '/nope', '/']) {
            const res = serve({ method: 'POST', path, body: {} });
            expect(res.status, path).toBe(404);
            expect(res.body.error).toContain('broken, count, hello, make, missing, tags');
        }
    });

    it('refuses arguments that do not fit the function, with the reason', () => {
        const call = (body: unknown) => serve({ method: 'POST', path: '/hello', body });
        expect(call({ name: 'x', times: 'many' })).toMatchObject({
            status: 400,
            body: { error: 'times must be a whole number, not "many"' },
        });
        expect(call({ name: 'x', loud: 'maybe' }).body.error).toMatch(/loud must be true or false/);
        expect(call({ name: true }).body.error).toMatch(/name must be text/);
        expect(call({ times: 2 }).body.error).toMatch(/missing a required argument: 'name'/);
        expect(call({ name: 'x', extra: 1 }).status).toBe(400);
        expect(call([1, 2]).body.error).toMatch(/JSON object/);
        expect(call('not json').body.error).toMatch(/not JSON/);
    });

    it('answers HttpError with its status, a Response with its own, anything else with 500', () => {
        expect(serve({ path: '/missing', body: { id: 7 } })).toMatchObject({
            status: 404,
            body: { error: 'no item 7' },
        });
        expect(serve({ path: '/make', body: { title: 't' } })).toMatchObject({
            status: 201,
            body: { title: 't' },
        });
        const broken = serve({ path: '/broken', body: {} });
        expect(broken).toMatchObject({
            status: 500,
            body: { error: 'broken failed: ValueError: bad data' },
        });
        expect(broken.stderr).toContain('Traceback');
    });

    it('keeps data in .data beside the file, or where ZEN_APP_DATA says', () => {
        const { dir } = app();
        const call = (env: Record<string, string> = {}) =>
            JSON.parse(zenApi(dir, ['--serve', 'items.api.py'], '{"path":"/count"}', env).stdout);
        expect(call().body).toEqual({ n: 1 });
        expect(call().body).toEqual({ n: 2 });
        expect(existsSync(join(dir, '.data', 'app.sqlite'))).toBe(true);

        const elsewhere = mkdtempSync(join(tmpdir(), 'zen-app-data-'));
        dirs.push(elsewhere);
        expect(call({ ZEN_APP_DATA: elsewhere }).body).toEqual({ n: 1 });
        expect(existsSync(join(elsewhere, 'app.sqlite'))).toBe(true);
    });

    it('lists and calls the functions from a shell, failing on an error status', () => {
        const { dir, file } = app();
        const listed = zenApi(dir, [file]);
        expect(listed.stdout).toContain(
            'hello(name: str, times: int = 1, loud: bool = False)  - Says hello.',
        );
        expect(listed.stdout).not.toContain('_private');

        const called = zenApi(dir, [file, 'hello', '{"name": "x"}']);
        expect(called.status).toBe(0);
        expect(JSON.parse(called.stdout).text).toBe('x');

        const failed = zenApi(dir, [file, 'missing', '{"id": 3}']);
        expect(failed.status).toBe(1);
        expect(failed.stderr.trim()).toBe('404: no item 3');
    });
});

describe('app calls', () => {
    function trees(): { trees: FileTrees; dir: string } {
        const { dir } = app();
        const workspace = join(dir, '..');
        // The agent's name for the workspace is its real path, so a host shell can run the call.
        return { trees: { workspace, workdir: workspace }, dir: workspace };
    }

    it('names a function of the .api.py its path leads to, and nothing else', () => {
        const { trees: t, dir } = trees();
        const call = resolveAppCall(`${dir}/api/items/hello`, t);
        expect(call?.fn).toBe('hello');
        expect(call?.file.path).toBe(`${dir}/api/items.api.py`);
        expect(resolveAppCall(`${dir}/api/items/_private`, t)).toBeNull();
        expect(resolveAppCall(`${dir}/api/items/a/hello`, t)).toBeNull();
        expect(resolveAppCall(`${dir}/api/nope/hello`, t)).toBeNull();
        expect(resolveAppCall(`${dir}/api/items.api.py/hello`, t)).toBeNull();
        mkdirSync(join(dir, '.hidden'));
        writeFileSync(join(dir, '.hidden', 'x.api.py'), 'def f(): pass\n');
        expect(() => resolveAppCall(`${dir}/.hidden/x/f`, t)).toThrow(/hidden/);
    });

    it("keeps the data of a published page (under /assets) in the user's workspace", () => {
        const { dir } = app();
        const workspace = mkdtempSync(join(tmpdir(), 'zen-app-ws-'));
        dirs.push(workspace);
        const t: FileTrees = { workspace, workdir: '/workspace', assets: join(dir, '..') };
        const call = resolveAppCall('/assets/api/items/hello', t)!;
        expect(call.file.tree).toBe('assets');
        expect(call.dataDir).toMatch(/^\/workspace\/\.data\/apps\/[0-9a-f]{16}$/);
        const script = appCallCommand(
            call.file.path,
            { method: 'GET', fn: 'hello', query: {}, headers: {}, body: '' },
            call.dataDir,
        );
        expect(script.split('\n')[0]).toContain(`&& ZEN_APP_DATA='${call.dataDir}' exec python3`);
        // A workspace page keeps its data beside its file.
        expect(resolveAppCall(`${workspace}/x/f`, { workspace, workdir: workspace })).toBeNull();
    });

    it('carries the request in the script, never as shell text', () => {
        const script = appCallCommand("/workspace/it's/a.api.py", {
            method: 'POST',
            fn: 'f',
            query: {},
            headers: {},
            body: '{"x": "$(rm -rf /)\nZEN_REQ_"}',
        });
        const lines = script.split('\n');
        expect(lines[0]).toMatch(
            /^cd '\/workspace\/it'\\''s' && exec python3 -m zenera\.api --serve 'a\.api\.py' <<'(ZEN_REQ_[0-9a-f]+)'$/,
        );
        const end = /<<'(\w+)'$/.exec(lines[0])![1];
        expect(lines).toHaveLength(4);
        expect(lines[2]).toBe(end);
        expect(JSON.parse(lines[1]).body).toBe('{"x": "$(rm -rf /)\nZEN_REQ_"}');
    });

    it.runIf(python)("runs in a sandbox and answers with the function's result", async () => {
        const { trees: t, dir } = trees();
        const shell = {
            // Keeps what a real sandbox keeps of the output: 64 KB unless asked for more.
            exec: async (command: string, opts: ExecOptions = {}) => {
                const run = spawnSync('/bin/sh', ['-s'], {
                    input: command,
                    encoding: 'utf8',
                    env: { ...process.env, PYTHONPATH: join(runtimeDir(), 'python') },
                    maxBuffer: 64 * 1024 * 1024,
                });
                const max = opts.maxBytes ?? 64 * 1024;
                return {
                    exit_code: run.status ?? 1,
                    stdout: run.stdout.slice(0, max),
                    stderr: run.stderr.slice(0, max),
                    truncated: run.stdout.length > max || run.stderr.length > max || undefined,
                    duration_ms: 1,
                };
            },
        } as unknown as Sandbox;
        const ask = (fn: string, body: string, method = 'POST') =>
            runAppCall(shell, resolveAppCall(`${dir}/api/items/${fn}`, t)!, {
                method,
                query: {},
                headers: {},
                body,
            });
        expect(await ask('hello', '{"name": "o\'k $HOME"}')).toEqual({
            status: 200,
            headers: {},
            body: expect.stringContaining('"text":"o\'k $HOME"'),
        });
        expect(await ask('make', '{"title": "t"}')).toMatchObject({ status: 201 });
        expect(await ask('missing', '{"id": 2}')).toMatchObject({
            status: 404,
            body: '{"error":"no item 2"}',
        });
        expect((await ask('count', '')).body).toBe('{"n":1}');
        expect(existsSync(join(dir, 'api', '.data', 'app.sqlite'))).toBe(true);
        expect(await ask('hello', 'x'.repeat(1024 * 1024 + 1))).toMatchObject({ status: 413 });
        // An answer far above a command's 64 KB, as a page's report may be.
        const big = await ask('hello', JSON.stringify({ name: 'x'.repeat(1000), times: 200 }));
        expect(big.status).toBe(200);
        expect(JSON.parse(big.body).text).toHaveLength(200_000);
    });

    it('answers what the process did when it did not answer', () => {
        const res = (r: object) => ({ exit_code: 0, stdout: '', stderr: '', duration_ms: 1, ...r });
        expect(appAnswer(res({ timed_out: true, exit_code: 124 }), '/w/a.api.py').status).toBe(504);
        expect(appAnswer(res({ truncated: true }), '/w/a.api.py').status).toBe(502);
        const missing = appAnswer(
            res({ exit_code: 127, stderr: 'sh: 1: exec: python3: not found' }),
            '/w/a.api.py',
        );
        expect(missing.status).toBe(500);
        expect(JSON.parse(missing.body).error).toBe('python3 is not installed in the sandbox');
        const ok = appAnswer(
            res({
                stdout: 'noise\n{"status":200,"headers":{"x-n":"1","set-cookie":"a"},"body":[1]}\n',
            }),
            '/w/a.api.py',
        );
        expect(ok).toEqual({ status: 200, headers: { 'x-n': '1' }, body: '[1]' });
    });
});
