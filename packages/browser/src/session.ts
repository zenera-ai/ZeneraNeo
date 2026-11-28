import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { VIEW_CDNS } from '@zenera/engine';
import type { Browser, BrowserContext, Locator, Page, Request, Route } from 'playwright-core';
import { PAGE_ORIGIN, type PageHost } from './host.ts';
import { WIDTH_PRESETS } from './widths.ts';

// ---------------------------------------------------------------------------
// A page in a browser, for an agent or a person to check and drive
//
// One browser, one context, one tab. The browser is a remote one when ZEN_BROWSER_URL names it
// (a Playwright run-server `ws://…`, or a Chrome DevTools endpoint `http://…`), else a local
// headless Chromium. Either way a local page's requests are answered by this process
// (route → PageHost → serveViewPath), so a remote browser never needs to reach the files.
//
// A local page may load from itself and VIEW_CDNS only, as under its CSP: anything else is
// refused here and reported. A URL (`https://app/v/<token>/…`, any site) goes to the network,
// with loopback and private addresses refused (a courtesy; the network policy is the boundary).
//
// Main: openBrowser, PageSession (open, goto, settle, problems, snapshot, act, screenshot,
// overflow), Problem.
// Used by: report.ts; @zenera/cli `zen page` (commands/page.ts, and page/daemon.ts: the session
// behind `zen page open`).
// ---------------------------------------------------------------------------

export type Level = 'error' | 'warning';

export interface Problem {
    level: Level;
    text: string;
}

export interface Settled {
    ms: number;
    /** requests still going when the wait gave up: what the page waits on */
    pending: string[];
}

export interface Overflow {
    width: number;
    viewport: number;
    elements: string[];
}

export interface ShotOptions {
    width?: number;
    dark?: boolean;
    /**
     * `top` (default): the page from its top, at most SHOT_HEIGHT tall; `full`: all of it, in
     * parts of SHOT_HEIGHT (`<name>-1.png`, `-2.png`, ...); `viewport`: what a window shows
     */
    area?: 'top' | 'full' | 'viewport';
    /** one element only: a ref or a selector */
    target?: string;
}

export interface Shot {
    /** the files written, top to bottom */
    files: string[];
    /** the page's whole height, px */
    height: number;
}

/**
 * The tallest image a screenshot is: a model looking at it shrinks anything with a longer edge
 * than ~1568 px, and a 400 px wide page 4000 px tall would arrive too small to read.
 */
export const SHOT_HEIGHT = 1600;

/** The picture of a page the chat's card shows (og:image): a wide first screen, light, 1.91:1. */
export const PREVIEW = { width: 1200, height: 630 } as const;
/** A `full` screenshot stops after this many parts. */
const MAX_PARTS = 8;

const PANEL = { width: WIDTH_PRESETS.panel, height: 900 };
const QUIET_MS = 500;
const ACTION_TIMEOUT_MS = 10_000;
const CDN_HOSTS = new Set(VIEW_CDNS.map((u) => new URL(u).host));

export class BrowserMissing extends Error {}

/**
 * What runs in the page, as source: this package is typed for Node, not the DOM, and these
 * never run here.
 */
const IN_PAGE = {
    drawn: `new Promise((done) => document.fonts.ready.then(() =>
        requestAnimationFrame(() => requestAnimationFrame(() => done()))))`,
    busy: `document.querySelector('[aria-busy="true"]') !== null`,
    height: `document.documentElement.scrollHeight`,
    empty: `!document.body || (document.body.innerText.trim() === '' &&
        !document.querySelector('img, canvas, svg, video'))`,
    // Whether the page scrolls sideways, and the outermost elements that stick out furthest
    // (an element whose parent sticks out as far is not the cause).
    overflow: `(() => {
        const root = document.documentElement;
        const viewport = root.clientWidth;
        if (root.scrollWidth <= viewport + 1) return null;
        const name = (e) => {
            const id = e.id ? '#' + e.id : '';
            const cls = [...e.classList].slice(0, 2).map((c) => '.' + c).join('');
            const text = (e.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 30);
            return e.tagName.toLowerCase() + id + cls + (text ? ' "' + text + '"' : '');
        };
        const elements = [...document.body.querySelectorAll('*')]
            .map((e) => ({ e, r: e.getBoundingClientRect() }))
            .filter((x) => x.r.width > 0 && x.r.right > viewport + 1)
            .filter((x) => {
                const p = x.e.parentElement && x.e.parentElement.getBoundingClientRect();
                return !p || p.right < x.r.right - 1;
            })
            .sort((a, b) => b.r.right - a.r.right)
            .slice(0, 3)
            .map((x) => name(x.e) + ' (to ' + Math.round(x.r.right) + ' px)');
        return { width: root.scrollWidth, viewport, elements };
    })()`,
};

/** The browser ZEN_BROWSER_URL names, else a local headless Chromium. */
export async function openBrowser(): Promise<Browser> {
    const { chromium } = await import('playwright-core');
    const remote = process.env.ZEN_BROWSER_URL;
    if (remote) {
        return /^wss?:/i.test(remote) ? chromium.connect(remote) : chromium.connectOverCDP(remote);
    }
    try {
        return await chromium.launch({
            headless: true,
            args: process.platform === 'linux' ? ['--disable-dev-shm-usage', '--disable-gpu'] : [],
        });
    } catch (err) {
        if (/Executable doesn't exist|install/i.test(String((err as Error).message))) {
            throw new BrowserMissing('no browser installed for zen page');
        }
        throw err;
    }
}

const isRef = (s: string) => /^@?(f\d+)?e\d+$/.test(s);

/** A private or loopback name or address, as far as it can be told without resolving it. */
function privateHost(host: string): boolean {
    const h = host.replace(/^\[|\]$/g, '').toLowerCase();
    if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal')) return true;
    if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) {
        return h.includes(':');
    }
    const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(h);
    if (!m) return false;
    const [a, b] = [Number(m[1]), Number(m[2])];
    return (
        a === 0 ||
        a === 10 ||
        a === 127 ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 100 && b >= 64 && b <= 127)
    );
}

export class PageSession {
    readonly browser: Browser;
    readonly context: BrowserContext;
    readonly page: Page;
    readonly #host: PageHost | null;
    readonly #owned: boolean;
    readonly #inflight = new Map<Request, number>();
    #problems: Problem[] = [];
    #seen = new Map<string, number>();

    private constructor(
        browser: Browser,
        context: BrowserContext,
        page: Page,
        host: PageHost | null,
        owned: boolean,
    ) {
        this.browser = browser;
        this.context = context;
        this.page = page;
        this.#host = host;
        this.#owned = owned;
    }

    /** A tab at the panel's width, answering local pages through `host` when given. */
    static async open(host: PageHost | null, browser?: Browser): Promise<PageSession> {
        const b = browser ?? (await openBrowser());
        const context = await b.newContext({
            viewport: PANEL,
            colorScheme: 'light',
            deviceScaleFactor: 1,
            serviceWorkers: 'block',
        });
        // An action on what is not there (yet) fails in 10 s, not Playwright's 30.
        context.setDefaultTimeout(ACTION_TIMEOUT_MS);
        const page = await context.newPage();
        const session = new PageSession(b, context, page, host, browser === undefined);
        await session.#wire();
        return session;
    }

    async #wire(): Promise<void> {
        await this.context.route('**/*', (route) => this.#route(route));
        const p = this.page;
        p.on('request', (r) => this.#inflight.set(r, Date.now()));
        p.on('requestfinished', (r) => this.#inflight.delete(r));
        p.on('requestfailed', (r) => {
            this.#inflight.delete(r);
            const why = r.failure()?.errorText ?? 'failed';
            // Refused by our own route or by the CSP: reported there, with the reason.
            if (why.includes('ERR_BLOCKED_BY_CLIENT') || why === 'csp') return;
            this.#add('error', `request failed: ${r.method()} ${short(r.url())} (${why})`);
        });
        p.on('pageerror', (err) => this.#add('error', `uncaught: ${err.message}`));
        p.on('console', (m) => {
            const t = m.type();
            if (t !== 'error' && t !== 'warning') return;
            // Chrome's line for a failed request: the request itself is reported, better.
            if (m.text().startsWith('Failed to load resource')) return;
            const where = m.location();
            const at = where.url ? ` (${short(where.url)}:${where.lineNumber + 1})` : '';
            const level: Level = t === 'error' ? 'error' : 'warning';
            this.#add(level, `console ${t}: ${m.text().slice(0, 500)}${at}`);
        });
        p.on('response', (res) => {
            const req = res.request();
            // A local answer is whole when it arrives (the host sent it in one piece); a page
            // that never reads a body would otherwise keep it in flight.
            if (req.url().startsWith(PAGE_ORIGIN)) this.#inflight.delete(req);
            // A function's failure is reported by #route, with its message.
            if (res.status() < 400 || res.headers()['x-zenera-call']) return;
            this.#add('error', `${req.method()} ${short(req.url())} → ${res.status()}`);
        });
        p.on('dialog', (d) => {
            this.#add('error', `${d.type()} dialog opened: ${d.message().slice(0, 200)}`);
            void d.dismiss().catch((err) => {
                console.warn('zen page: dismissing a dialog failed; left open', err);
            });
        });
    }

    async #route(route: Route): Promise<void> {
        const req = route.request();
        const url = new URL(req.url());
        if (url.origin === PAGE_ORIGIN && this.#host) {
            const answer = await this.#host.fetch({
                method: req.method(),
                path: url.pathname + url.search,
                headers: await req.allHeaders(),
                ...(req.postDataBuffer() ? { body: req.postDataBuffer()! } : {}),
            });
            if (answer.status >= 400 && answer.headers['x-zenera-call']) {
                this.#add(
                    'error',
                    `function ${req.method()} ${short(req.url())} → ${answer.status}${callDetail(answer.body)}`,
                );
            }
            await route.fulfill({
                status: answer.status,
                headers: answer.headers,
                body: answer.body,
            });
            return;
        }
        const local = this.#host !== null;
        if (local ? CDN_HOSTS.has(url.host) : !privateHost(url.hostname)) {
            await route.continue();
            return;
        }
        this.#add(
            'error',
            local
                ? `blocked: ${url.host} - a page may load only its own files and ${[...CDN_HOSTS].join(', ')}`
                : `blocked: ${url.host} is a private address`,
        );
        await route.abort('blockedbyclient');
    }

    #add(level: Level, text: string): void {
        const n = (this.#seen.get(text) ?? 0) + 1;
        this.#seen.set(text, n);
        if (n === 1) this.#problems.push({ level, text });
    }

    /** What went wrong since the last call, each once (with how often it happened). */
    takeProblems(): Problem[] {
        const out = this.#problems.map((p) => {
            const n = this.#seen.get(p.text) ?? 1;
            return n > 1 ? { ...p, text: `${p.text} (×${n})` } : p;
        });
        this.#problems = [];
        this.#seen = new Map();
        return out;
    }

    /** The URL a target opens at: a local agent path under PAGE_ORIGIN, or a URL as it is. */
    urlOf(target: string): string {
        if (/^https?:\/\//i.test(target)) return target;
        if (!this.#host) throw new Error(`not a URL: ${target}`);
        return PAGE_ORIGIN + target.split('/').map(encodeURIComponent).join('/');
    }

    async goto(target: string, capMs = 15_000): Promise<Settled> {
        const started = Date.now();
        const url = this.urlOf(target);
        try {
            await this.page.goto(url, { waitUntil: 'load', timeout: capMs });
        } catch (err) {
            if (!/ERR_BLOCKED_BY_CLIENT/.test(String(err))) throw err;
            const why = this.takeProblems().map((p) => p.text);
            throw new Error(why.length ? why.join('; ') : `blocked: ${short(url)}`);
        }
        const settled = await this.settle(Math.max(1000, capMs - (Date.now() - started)));
        return { ...settled, ms: Date.now() - started };
    }

    async reload(capMs = 15_000): Promise<Settled> {
        const started = Date.now();
        await this.page.reload({ waitUntil: 'load', timeout: capMs });
        const settled = await this.settle(capMs);
        return { ...settled, ms: Date.now() - started };
    }

    /**
     * Waits until nothing has been in flight for QUIET_MS (page functions included: they are
     * requests), nothing says `aria-busy="true"`, fonts are in and two frames are drawn.
     */
    async settle(capMs = 5000): Promise<Settled> {
        const started = Date.now();
        const deadline = started + capMs;
        let quietSince = 0;
        while (Date.now() < deadline) {
            if (this.#inflight.size === 0) {
                quietSince ||= Date.now();
                if (Date.now() - quietSince >= QUIET_MS && !(await this.#busy())) break;
            } else {
                quietSince = 0;
            }
            await new Promise((r) => setTimeout(r, 50));
        }
        await this.page.evaluate(IN_PAGE.drawn).catch((err) => {
            // A page navigating away mid-wait: the next command sees the new one.
            if (!/navigat|destroyed|closed/i.test(String(err))) throw err;
        });
        const now = Date.now();
        const pending = [...this.#inflight.entries()].map(
            ([r, at]) => `${r.method()} ${short(r.url())} (${((now - at) / 1000).toFixed(1)} s)`,
        );
        return { ms: now - started, pending };
    }

    async #busy(): Promise<boolean> {
        return this.page.evaluate<boolean>(IN_PAGE.busy).catch((err) => {
            // A page navigating away mid-check is not busy; the wait goes on with the new one.
            if (/navigat|destroyed|closed/i.test(String(err))) return false;
            throw err;
        });
    }

    /** The page as text, each element with a ref (`[ref=e5]`) the actions take. */
    async snapshot(maxLines = 300): Promise<string> {
        const text = await this.page.ariaSnapshot({ mode: 'ai' });
        const lines = text.split('\n');
        return lines.length > maxLines
            ? [...lines.slice(0, maxLines), `… ${lines.length - maxLines} more lines`].join('\n')
            : text;
    }

    /** A ref from the last snapshot (`e5`, `@e5`), or a Playwright selector. */
    locate(target: string): Locator {
        return isRef(target)
            ? this.page.getByRef(target.replace(/^@/, ''))
            : this.page.locator(target);
    }

    /**
     * locate, refusing at once a ref the last snapshot does not have (the page changed, or no
     * snapshot was taken) rather than waiting for it to appear.
     */
    async element(target: string): Promise<Locator> {
        const l = this.locate(target);
        if (isRef(target) && (await l.count()) === 0) {
            throw new Error(
                `no element ${target} in the page's last snapshot: take a new one (zen page snapshot) and use its refs`,
            );
        }
        return l;
    }

    async setView(opts: { width?: number; dark?: boolean }): Promise<void> {
        if (opts.width !== undefined) {
            const size = this.page.viewportSize() ?? PANEL;
            if (size.width !== opts.width) {
                await this.page.setViewportSize({ width: opts.width, height: size.height });
            }
        }
        if (opts.dark !== undefined) {
            await this.page.emulateMedia({ colorScheme: opts.dark ? 'dark' : 'light' });
        }
    }

    /** The page at its current width and scheme (or those asked for), into `file` (or parts of it). */
    async screenshot(file: string, opts: ShotOptions = {}): Promise<Shot> {
        await this.setView(opts);
        await this.settle(3000);
        mkdirSync(dirname(file), { recursive: true });
        const common = { animations: 'disabled', caret: 'hide' } as const;
        const height = await this.page.evaluate<number>(IN_PAGE.height);
        if (opts.target) {
            await this.locate(opts.target).screenshot({ ...common, path: file });
            return { files: [file], height };
        }
        if (opts.area === 'viewport') {
            await this.page.screenshot({ ...common, path: file });
            return { files: [file], height };
        }
        const width = this.page.viewportSize()?.width ?? PANEL.width;
        const parts =
            opts.area === 'full' ? Math.min(MAX_PARTS, Math.ceil(height / SHOT_HEIGHT)) : 1;
        const files: string[] = [];
        for (let i = 0; i < parts; i++) {
            const path = parts > 1 ? file.replace(/(\.png)?$/i, `-${i + 1}.png`) : file;
            const top = i * SHOT_HEIGHT;
            await this.page.screenshot({
                ...common,
                path,
                fullPage: true,
                clip: {
                    x: 0,
                    y: top,
                    width,
                    height: Math.max(1, Math.min(SHOT_HEIGHT, height - top)),
                },
            });
            files.push(path);
        }
        return { files, height };
    }

    /**
     * The page's first screen at PREVIEW's size, light, into `file`: the picture its card shows.
     * The window is put back as it was.
     */
    async preview(file: string): Promise<void> {
        const size = this.page.viewportSize() ?? PANEL;
        await this.page.setViewportSize(PREVIEW);
        await this.page.emulateMedia({ colorScheme: 'light' });
        try {
            await this.settle(3000);
            mkdirSync(dirname(file), { recursive: true });
            await this.page.screenshot({ animations: 'disabled', caret: 'hide', path: file });
        } finally {
            await this.page.setViewportSize(size);
        }
    }

    /** Whether the page scrolls sideways at its width, and the elements furthest out. */
    async overflow(): Promise<Overflow | null> {
        return this.page.evaluate<Overflow | null>(IN_PAGE.overflow);
    }

    /** A page that drew nothing: no text and no picture. */
    async empty(): Promise<boolean> {
        return this.page.evaluate<boolean>(IN_PAGE.empty);
    }

    async close(): Promise<void> {
        await this.context.close().catch((err) => {
            console.warn('zen page: closing the browser context failed; dropped', err);
        });
        if (this.#owned) {
            await this.browser.close().catch((err) => {
                console.warn('zen page: closing the browser failed; dropped', err);
            });
        }
    }
}

/** An error as one line: Playwright's carry a call log after the first lines. */
export function errorText(err: unknown): string {
    const text = err instanceof Error ? err.message : String(err);
    const head = text.split(/\n\s*Call log:/)[0] ?? text;
    return head.split('\n').slice(0, 3).join(' ').replace(/\s+/g, ' ').trim();
}

/** What a function that failed said: its error and the end of its stderr. */
function callDetail(body: Buffer): string {
    try {
        const parsed = JSON.parse(body.toString('utf8')) as { error?: string; stderr?: string };
        const said = [parsed.error, parsed.stderr?.trim().split('\n').slice(-3).join(' | ')]
            .filter(Boolean)
            .join(' - ');
        return said ? `: ${said.slice(0, 600)}` : '';
    } catch {
        // Not JSON: the status says enough.
        return '';
    }
}

/** A URL as worth reading: a local page's agent path, else the URL without its query. */
export function short(url: string): string {
    if (url.startsWith(PAGE_ORIGIN)) {
        try {
            return decodeURIComponent(url.slice(PAGE_ORIGIN.length));
        } catch {
            return url.slice(PAGE_ORIGIN.length);
        }
    }
    // A /v/ URL carries a token: never print it.
    return url.replace(/\/v\/[^/]+\//, '/v/…/').replace(/[?#].*$/, '');
}
