import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import {
    checkPage,
    DEFAULT_WIDTHS,
    errorText,
    inSandbox,
    reportLines,
    SANDBOX_WORKDIR,
    SHOT_HEIGHT,
    short,
    widthOf,
    type PageSession,
    type Problem,
    type Target,
} from '@zenera/browser';
import { usageError } from '@zenera/engine';

// ---------------------------------------------------------------------------
// The browser session behind `zen page open`, and the client every other command is
//
// `zen page open <page>` keeps one tab open and listens on a Unix socket (0600); `zen page
// snapshot`, `click e5`, `screenshot`, ... each connect, send one request (a line of JSON), print
// the answer and exit, so the page keeps its state between them. Requests run one at a time.
// After an action the session waits for the page to settle, then answers with what went wrong
// meanwhile and the page as it is now. It closes after `idleMs` without a request, on
// `zen page close`, or with its process.
//
// The socket is in the workspace inside a sandbox (each command there has a /tmp of its own),
// else in a private folder of the user's under the machine's temp.
//
// Main: serveSession, askSession, sessionSocket, SessionRequest, SessionAnswer.
// Used by: commands/page.ts.
// ---------------------------------------------------------------------------

export interface SessionRequest {
    cmd: string;
    args: string[];
    flags: Record<string, string | boolean | undefined>;
    /** text read from the client's stdin (`--stdin`) */
    input?: string;
}

export interface SessionAnswer {
    ok: boolean;
    lines: string[];
}

export interface SessionOptions {
    socket: string;
    session: PageSession;
    target: Target;
    idleMs: number;
    shown: (path: string) => string;
}

const ACT_SETTLE_MS = 5000;

/** Where the session listens: the same for `open` and every command after it. */
export function sessionSocket(cwd: string): string {
    if (process.env.ZEN_PAGE_SOCKET) return process.env.ZEN_PAGE_SOCKET;
    if (inSandbox(cwd)) {
        const dir = join(SANDBOX_WORKDIR, '.tmp', 'page-check');
        mkdirSync(dir, { recursive: true });
        return join(dir, 'session.sock');
    }
    const id = createHash('sha256').update(userInfo().username).digest('hex').slice(0, 12);
    const dir = join(tmpdir(), `zen-page-${id}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return join(dir, 'session.sock');
}

/** Ends a running session at `socket`, if there is one, and clears a stale socket file. */
async function replaceOld(socket: string): Promise<void> {
    if (!existsSync(socket)) return;
    try {
        await askSession(socket, { cmd: 'close', args: [], flags: {} }, 0);
    } catch {
        // Nothing answered: a socket file left by a session that died.
    }
    if (existsSync(socket)) unlinkSync(socket);
}

/** Serves `opts.session` until it is closed; resolves then. */
export async function serveSession(opts: SessionOptions): Promise<void> {
    await replaceOld(opts.socket);
    let shot = 0;
    let queue = Promise.resolve();
    let idle: NodeJS.Timeout | undefined;
    let server: Server;
    let ended!: () => void;
    const done = new Promise<void>((settle) => (ended = settle));
    const stop = () => {
        clearTimeout(idle);
        server.close(() => ended());
    };
    const touch = () => {
        clearTimeout(idle);
        idle = setTimeout(stop, opts.idleMs);
        idle.unref();
    };
    const run = (req: SessionRequest) => handle(opts, req, () => ++shot);

    server = createServer((sock: Socket) => {
        let buf = '';
        sock.setEncoding('utf8');
        sock.on('data', (chunk: string) => {
            buf += chunk;
            const nl = buf.indexOf('\n');
            if (nl < 0) return;
            let req: SessionRequest;
            try {
                req = JSON.parse(buf.slice(0, nl)) as SessionRequest;
            } catch (err) {
                sock.end(
                    `${JSON.stringify({ ok: false, lines: [`bad request: ${String(err)}`] })}\n`,
                );
                return;
            }
            touch();
            queue = queue.then(async () => {
                let answer: SessionAnswer;
                try {
                    answer = req.cmd === 'close' ? { ok: true, lines: ['closed'] } : await run(req);
                } catch (err) {
                    answer = { ok: false, lines: [errorLine(err)] };
                }
                sock.end(`${JSON.stringify(answer)}\n`);
                if (req.cmd === 'close') stop();
            });
        });
        sock.on('error', (err) =>
            console.warn('zen page: a client connection failed; dropped', err),
        );
    });
    await new Promise<void>((settle, fail) => {
        server.once('error', fail);
        server.listen(opts.socket, () => {
            server.off('error', fail);
            settle();
        });
    });
    chmodSync(opts.socket, 0o600);
    touch();
    for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, stop);
    try {
        await done;
    } finally {
        if (existsSync(opts.socket)) unlinkSync(opts.socket);
    }
}

function errorLine(err: unknown): string {
    return `✗ ${errorText(err)}`;
}

const problemLines = (ps: Problem[]) =>
    ps.map((p) => `${p.level === 'error' ? '✗' : '⚠'} ${p.text}`);

async function afterAction(s: PageSession, flags: SessionRequest['flags']): Promise<string[]> {
    const settled = await s.settle(ACT_SETTLE_MS);
    const lines = problemLines(s.takeProblems());
    if (settled.pending.length) lines.push(`⚠ still waiting on: ${settled.pending.join(', ')}`);
    if (flags.snapshot !== false) lines.push('', await s.snapshot());
    return lines;
}

function need(args: string[], n: number, usage: string): void {
    if (args.length < n) throw usageError(`usage: zen page ${usage}`);
}

async function handle(
    opts: SessionOptions,
    req: SessionRequest,
    nextShot: () => number,
): Promise<SessionAnswer> {
    const s = opts.session;
    const { args, flags } = req;
    const text = (at: number) => req.input ?? args[at];
    switch (req.cmd) {
        case 'status':
            return {
                ok: true,
                lines: [`open: ${short(s.page.url())}`, `title: ${await s.page.title()}`],
            };
        case 'snapshot':
            return { ok: true, lines: [await s.snapshot(Number(flags.lines ?? 300))] };
        case 'click':
        case 'dblclick':
        case 'hover': {
            need(args, 1, `${req.cmd} <ref|selector>`);
            const l = await s.element(args[0]!);
            await (req.cmd === 'click'
                ? l.click()
                : req.cmd === 'dblclick'
                  ? l.dblclick()
                  : l.hover());
            return {
                ok: true,
                lines: [`✓ ${req.cmd} ${args[0]}`, ...(await afterAction(s, flags))],
            };
        }
        case 'fill':
        case 'type': {
            need(args, req.input === undefined ? 2 : 1, `${req.cmd} <ref|selector> <text>|--stdin`);
            const l = await s.element(args[0]!);
            const value = text(1) ?? '';
            await (req.cmd === 'fill' ? l.fill(value) : l.pressSequentially(value));
            return {
                ok: true,
                lines: [`✓ ${req.cmd} ${args[0]}`, ...(await afterAction(s, flags))],
            };
        }
        case 'press': {
            need(args, 1, 'press <key> [ref|selector]');
            await (args[1]
                ? (await s.element(args[1])).press(args[0]!)
                : s.page.keyboard.press(args[0]!));
            return { ok: true, lines: [`✓ press ${args[0]}`, ...(await afterAction(s, flags))] };
        }
        case 'select': {
            need(args, 2, 'select <ref|selector> <value...>');
            await (await s.element(args[0]!)).selectOption(args.slice(1));
            return {
                ok: true,
                lines: [`✓ select ${args.slice(1).join(', ')}`, ...(await afterAction(s, flags))],
            };
        }
        case 'goto': {
            need(args, 1, 'goto <page|url>');
            const settled = await s.goto(args[0]!);
            return {
                ok: true,
                lines: [
                    `✓ ${short(s.page.url())} loaded in ${(settled.ms / 1000).toFixed(1)} s`,
                    ...(await afterAction(s, flags)),
                ],
            };
        }
        case 'reload': {
            const settled = await s.reload();
            return {
                ok: true,
                lines: [
                    `✓ reloaded in ${(settled.ms / 1000).toFixed(1)} s`,
                    ...(await afterAction(s, flags)),
                ],
            };
        }
        case 'back':
            await s.page.goBack({ waitUntil: 'load' });
            return { ok: true, lines: ['✓ back', ...(await afterAction(s, flags))] };
        case 'wait': {
            const timeout = Number(flags.timeout ?? 10) * 1000;
            if (typeof flags.text === 'string') {
                await s.page.getByText(flags.text).first().waitFor({ state: 'visible', timeout });
            } else if (typeof flags.gone === 'string') {
                await s.page.getByText(flags.gone).first().waitFor({ state: 'hidden', timeout });
            } else if (flags.time !== undefined) {
                await new Promise((r) => setTimeout(r, Math.min(Number(flags.time), 60) * 1000));
            } else {
                await s.settle(timeout);
            }
            return { ok: true, lines: ['✓ waited', ...problemLines(s.takeProblems())] };
        }
        case 'resize': {
            const m = /^([a-z-]+|\d+)(?:x(\d+))?$/i.exec(args[0] ?? '');
            if (!m) {
                throw usageError('usage: zen page resize <panel|wide-panel|tab|width>[x<height>]');
            }
            const width = widthOf(m[1]!);
            const height = Number(m[2] ?? s.page.viewportSize()?.height ?? 900);
            await s.page.setViewportSize({ width, height });
            await s.settle(2000);
            return { ok: true, lines: [`✓ ${width} px wide`, ...problemLines(s.takeProblems())] };
        }
        case 'dark':
        case 'light':
            await s.setView({ dark: req.cmd === 'dark' });
            return { ok: true, lines: [`✓ ${req.cmd}`] };
        case 'screenshot': {
            const file =
                typeof flags.out === 'string'
                    ? flags.out
                    : join(opts.target.outDir, `shot-${nextShot()}.png`);
            const area = flags.full ? 'full' : flags.viewport ? 'viewport' : 'top';
            const shot = await s.screenshot(file, {
                ...(typeof flags.width === 'string' ? { width: widthOf(flags.width) } : {}),
                ...(flags.dark ? { dark: true } : flags.light ? { dark: false } : {}),
                area,
                ...(args[0] ? { target: args[0] } : {}),
            });
            const lines = shot.files.map((f) => `✓ ${opts.shown(f)}`);
            lines.push(
                shot.files.length > 1
                    ? 'look at them: one view_image each, in the same reply'
                    : 'look at it: view_image',
            );
            if (area === 'top' && !args[0] && shot.height > SHOT_HEIGHT) {
                lines.push(
                    `the page is ${shot.height} px tall: this is its top ${SHOT_HEIGHT} px; --full takes the rest in parts`,
                );
            }
            return { ok: true, lines: [...lines, ...problemLines(s.takeProblems())] };
        }
        case 'console': {
            const lines = problemLines(s.takeProblems());
            return { ok: true, lines: lines.length ? lines : ['no errors since the last command'] };
        }
        case 'eval': {
            const js = text(0);
            if (!js) throw usageError('usage: zen page eval <expression>|--stdin');
            const value: unknown = await s.page.evaluate(js);
            return {
                ok: true,
                lines: [
                    JSON.stringify(value, null, 2) ?? 'undefined',
                    ...problemLines(s.takeProblems()),
                ],
            };
        }
        case 'check': {
            const r = await checkPage(
                s,
                s.page.url(),
                {
                    widths: [...DEFAULT_WIDTHS],
                    dark: true,
                    outDir: opts.target.outDir,
                    timeoutMs: 15_000,
                },
                true,
            );
            return { ok: true, lines: reportLines(r, opts.shown) };
        }
        default:
            throw usageError(`unknown command: zen page ${req.cmd}`, 'zen page --help lists them');
    }
}

/**
 * Sends one request to the session at `socket` and returns its answer. Waits up to `waitMs` for
 * a session that is still starting.
 */
export async function askSession(
    socket: string,
    req: SessionRequest,
    waitMs = 10_000,
): Promise<SessionAnswer> {
    const deadline = Date.now() + waitMs;
    for (;;) {
        try {
            return await once(socket, req);
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            const absent = code === 'ENOENT' || code === 'ECONNREFUSED';
            if (!absent) throw err;
            if (Date.now() >= deadline) {
                throw usageError(
                    'no zen page session is running',
                    'start one in the background first: zen page open <page folder|url> (run_command_background)',
                );
            }
            await new Promise((r) => setTimeout(r, 200));
        }
    }
}

function once(socket: string, req: SessionRequest): Promise<SessionAnswer> {
    return new Promise((settle, fail) => {
        const sock = connect(socket);
        let buf = '';
        sock.setEncoding('utf8');
        sock.on('connect', () => sock.write(`${JSON.stringify(req)}\n`));
        sock.on('data', (c: string) => (buf += c));
        sock.on('end', () => {
            try {
                settle(JSON.parse(buf) as SessionAnswer);
            } catch {
                fail(new Error(`the zen page session answered nothing (${buf.slice(0, 200)})`));
            }
        });
        sock.on('error', fail);
    });
}
