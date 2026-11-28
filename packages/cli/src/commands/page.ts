import { readFileSync } from 'node:fs';
import { parse } from '../args.ts';
import type { Command } from '../command.ts';
import { CliError, EXIT, json, note, usageError, write, writeAll } from '../term.ts';

// ---------------------------------------------------------------------------
// zen page - an html page in a real browser: checked, driven, photographed
//
// For the html-page skill's pages (and any URL): `check` loads a page once and reports what
// went wrong, with screenshots; `open` keeps a browser session that `snapshot`, `click`,
// `fill`, `screenshot`, ... drive one command at a time. Local pages are served as `/v/` serves
// them (@zenera/browser's PageHost); the browser is ZEN_BROWSER_URL's, else a local headless Chromium
// (`zen page install` fetches it).
//
// Main: page (the Command). The browser, the page's requests and the check are @zenera/browser's;
// page/daemon.ts is the session behind `zen page open`.
// Used by: commands/index.ts; agents through the html-page skill (run_command), people by hand.
// ---------------------------------------------------------------------------

const USAGE = 'zen page <check|open|install|snapshot|click|fill|screenshot|...> [args] [options]';

const OPTIONS = {
    root: { type: 'string' },
    widths: { type: 'string' },
    'no-dark': { type: 'boolean' },
    out: { type: 'string' },
    timeout: { type: 'string' },
    idle: { type: 'string' },
    width: { type: 'string' },
    dark: { type: 'boolean' },
    light: { type: 'boolean' },
    viewport: { type: 'boolean' },
    full: { type: 'boolean' },
    stdin: { type: 'boolean' },
    text: { type: 'string' },
    gone: { type: 'string' },
    time: { type: 'string' },
    lines: { type: 'string' },
    'no-snapshot': { type: 'boolean' },
} as const;

interface Flags {
    root?: string;
    widths?: string;
    'no-dark'?: boolean;
    out?: string;
    timeout?: string;
    idle?: string;
    width?: string;
    dark?: boolean;
    light?: boolean;
    viewport?: boolean;
    full?: boolean;
    stdin?: boolean;
    text?: string;
    gone?: string;
    time?: string;
    lines?: string;
    'no-snapshot'?: boolean;
}

/** Commands sent to a running session. */
const SESSION = new Set([
    'status',
    'snapshot',
    'click',
    'dblclick',
    'hover',
    'fill',
    'type',
    'press',
    'select',
    'goto',
    'reload',
    'back',
    'wait',
    'resize',
    'dark',
    'light',
    'screenshot',
    'console',
    'eval',
    'close',
]);

function seconds(v: string | undefined, fallback: number, what: string): number {
    if (v === undefined) return fallback;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw usageError(`${what} takes seconds`, `got "${v}"`);
    return n;
}

/** A browser's failure as the CLI says it: one line, not Playwright's call log. */
async function plainly<T>(work: Promise<T>): Promise<T> {
    try {
        return await work;
    } catch (err) {
        if (err instanceof CliError) throw err;
        const { errorText } = await import('@zenera/browser');
        throw new CliError(errorText(err), EXIT.failed);
    }
}

function missingBrowser(): CliError {
    return new CliError(
        'no browser for zen page: none installed here, and ZEN_BROWSER_URL is not set',
        EXIT.usage,
        'run `zen page install` (a headless Chromium, ~100 MB), or set ZEN_BROWSER_URL',
    );
}

async function check(ctx: Parameters<Command['run']>[0], positionals: string[], v: Flags) {
    const [asked] = positionals;
    if (!asked || positionals.length > 1)
        throw usageError('usage: zen page check <page folder|file|url>');
    const {
        BrowserMissing,
        checkPage,
        errorsIn,
        PageHost,
        PageSession,
        pythonPath,
        reportLines,
        resolveTarget,
        shown,
        widthsOf,
    } = await import('@zenera/browser');
    const target = resolveTarget(asked, ctx.cwd, v.root);
    const outDir = v.out ?? target.outDir;
    const host = target.trees
        ? await PageHost.start({ trees: target.trees, pythonPath: pythonPath() })
        : null;
    let session;
    try {
        session = await PageSession.open(host);
    } catch (err) {
        await host?.close();
        if (err instanceof BrowserMissing) throw missingBrowser();
        return plainly(Promise.reject(err));
    }
    const reports = [];
    try {
        for (const page of target.pages) {
            reports.push(
                await plainly(
                    checkPage(session, page, {
                        widths: widthsOf(v.widths),
                        dark: !v['no-dark'],
                        outDir,
                        timeoutMs: seconds(v.timeout, 15, '--timeout') * 1000,
                        preview: target.trees !== null,
                    }),
                ),
            );
        }
    } finally {
        await session.close();
        await host?.close();
    }
    if (ctx.json) {
        json({ pages: reports });
    } else {
        for (const r of reports) writeAll(reportLines(r, (p) => shown(p, ctx.cwd)));
    }
    const errors = reports.reduce((n, r) => n + errorsIn(r), 0);
    if (errors) {
        throw new CliError(
            `${errors} error${errors > 1 ? 's' : ''} on the page`,
            EXIT.failed,
            'fix them, build again, and check again',
        );
    }
}

async function open(ctx: Parameters<Command['run']>[0], positionals: string[], v: Flags) {
    const [asked] = positionals;
    if (!asked || positionals.length > 1)
        throw usageError('usage: zen page open <page folder|file|url>');
    const { BrowserMissing, PageHost, PageSession, pythonPath, resolveTarget, short, shown } =
        await import('@zenera/browser');
    const { serveSession, sessionSocket } = await import('../page/daemon.ts');
    const target = resolveTarget(asked, ctx.cwd, v.root);
    if (v.out) target.outDir = v.out;
    const host = target.trees
        ? await PageHost.start({ trees: target.trees, pythonPath: pythonPath() })
        : null;
    let session;
    try {
        session = await PageSession.open(host);
    } catch (err) {
        await host?.close();
        if (err instanceof BrowserMissing) throw missingBrowser();
        return plainly(Promise.reject(err));
    }
    try {
        const settled = await plainly(
            session.goto(target.pages[0]!, seconds(v.timeout, 15, '--timeout') * 1000),
        );
        const socket = sessionSocket(ctx.cwd);
        const idleMs = seconds(v.idle, 600, '--idle') * 1000;
        write(`✓ ${short(target.pages[0]!)} loaded in ${(settled.ms / 1000).toFixed(1)} s`);
        for (const p of session.takeProblems())
            write(`${p.level === 'error' ? '✗' : '⚠'} ${p.text}`);
        if (settled.pending.length) write(`⚠ still waiting on: ${settled.pending.join(', ')}`);
        write(
            `ready: zen page snapshot | click <ref> | fill <ref> <text> | screenshot | console | close`,
        );
        note(
            `session at ${shown(socket, ctx.cwd)}; closes after ${idleMs / 1000} s without a command`,
        );
        await serveSession({ socket, session, target, idleMs, shown: (p) => shown(p, ctx.cwd) });
    } finally {
        await session.close();
        await host?.close();
    }
}

async function install(): Promise<void> {
    const { installBrowser } = await import('@zenera/browser');
    if (installBrowser() !== 0) {
        throw new CliError('installing the browser failed', EXIT.failed, 'see the output above');
    }
}

export const page: Command = {
    summary: 'Check an html page in a real browser, drive it, and take screenshots.',
    usage: USAGE,
    details: [
        "For the html-page skill's pages (a folder with index.html), a single html file, or a URL.",
        'Local pages are served as the chat serves them (its CSP, files and *.api.py functions);',
        'only cdn.jsdelivr.net, unpkg.com and cdnjs.cloudflare.com are reached besides them.',
        "The browser is ZEN_BROWSER_URL's when set (ws:// Playwright server, http:// DevTools),",
        'else a local headless Chromium.',
        '',
        'One shot:',
        '  check <page>            load, report errors, scrolling sideways, screenshots; exit 1 on error',
        '      --widths <list>     presets or px (default panel,wide-panel,tab; the first is the panel)',
        '      --no-dark           no dark shot of the panel',
        '      --out <dir>         where screenshots go (default <workspace>/.tmp/page-check/<page>)',
        '  install                 fetch the headless Chromium',
        '',
        'A session (start `open` in the background; each command after it acts on the same tab):',
        '  open <page|url>         open and keep the browser   --idle <s> (default 600)',
        '  snapshot                the page as text; elements carry refs: [ref=e5]',
        '  click|dblclick|hover <ref|selector>',
        '  fill|type <ref|selector> <text>    (--stdin: the text from stdin)',
        '  press <key> [ref]       select <ref> <value...>',
        '  goto <page|url>   reload   back',
        '  wait [--text <t>|--gone <t>|--time <s>]',
        '  screenshot [ref] [--width <w>] [--dark|--light] [--full|--viewport] [--out <file>]',
        '                          the top 1600 px; --full: the whole page, in parts of 1600 px',
        '  resize <w>[x<h>]   dark   light',
        '  console                 errors and failed requests since the last command',
        '  eval <js>               (--stdin: the script from stdin)',
        '  status   close',
        "Actions answer with new errors and the page's snapshot (--no-snapshot: without).",
        '',
        "Widths: panel (400 px, the chat's side panel), wide-panel (640), tab (1280), or px.",
        '',
        'Examples:',
        '  zen page check /workspace/pages/todo',
        '  zen page open /workspace/pages/todo        (in the background)',
        '  zen page fill e5 "Milk" && zen page click e6 && zen page screenshot --width panel',
    ],
    banner: { head: 'Zenera', accent: 'Page', subtitle: 'Browser Check', hue: 'red' },
    run: async (ctx) => {
        const [sub, ...rest] = ctx.args;
        const { values, positionals } = parse<Flags>(rest, OPTIONS, USAGE);
        if (!sub) throw usageError('which page command?', USAGE);
        if (sub === 'check') return check(ctx, positionals, values);
        if (sub === 'open') return open(ctx, positionals, values);
        if (sub === 'install') return install();
        if (!SESSION.has(sub)) throw usageError(`unknown command: zen page ${sub}`, USAGE);
        const { askSession, sessionSocket } = await import('../page/daemon.ts');
        const flags: Record<string, string | boolean | undefined> = { ...values };
        if (values['no-snapshot']) flags.snapshot = false;
        const answer = await askSession(sessionSocket(ctx.cwd), {
            cmd: sub,
            args: positionals,
            flags,
            ...(values.stdin ? { input: readFileSync(0, 'utf8') } : {}),
        });
        if (ctx.json) json(answer);
        else writeAll(answer.lines);
        if (!answer.ok) throw new CliError(`zen page ${sub} failed`, EXIT.failed);
    },
};
