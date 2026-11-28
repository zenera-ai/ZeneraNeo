/**
 * @zenera/browser with a real browser: skipped where none is installed (`zen page install`), like
 * the other live tests. A page with one of each mistake an agent makes is reported once each;
 * an app's functions are driven through the tab: fill, click, and the list it reloads.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PageHost } from '../src/host.ts';
import { checkPage } from '../src/report.ts';
import { openBrowser, PageSession, SHOT_HEIGHT } from '../src/session.ts';
import { pythonPath } from '../src/target.ts';
import { DEFAULT_WIDTHS } from '../src/widths.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'zen-live-page-')));
const browser = await openBrowser().catch(() => null);
const hasPython = spawnSync('python3', ['--version']).status === 0;

/** A PNG's size, from its header. */
function png(path: string): { width: number; height: number } {
    const b = readFileSync(path);
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function file(path: string, text: string): void {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
}

file(
    'pages/bad/index.html',
    `<!doctype html><body><h1>Bad</h1>
<div class="toolbar" style="width:700px">too wide</div>
<script>
fetch('api/items/boom', { method: 'POST', body: '{}' });
try { localStorage.setItem('a', '1'); } catch (e) { console.error('storage: ' + e.message); }
setTimeout(() => { undefinedFunction(); }, 10);
</script></body>`,
);
file(
    'pages/tall/index.html',
    '<!doctype html><body style="margin:0"><div style="height:4000px">tall</div></body>',
);
file('pages/bad/api/items.api.py', 'def boom():\n    return {}["done"]\n');
file(
    'pages/todo/index.html',
    `<!doctype html><body><label>New item <input id="t"></label><button id="add">Add</button>
<ul id="list"></ul>
<script>
const call = (fn, args) => fetch('api/items/' + fn, { method: 'POST', body: JSON.stringify(args) }).then((r) => r.json());
const show = (items) => { document.getElementById('list').replaceChildren(...items.map((t) => Object.assign(document.createElement('li'), { textContent: t }))); };
document.getElementById('add').onclick = () => call('add', { title: document.getElementById('t').value }).then(show);
call('add', {}).then(show);
</script></body>`,
);
file(
    'pages/todo/api/items.api.py',
    'ITEMS = []\n\ndef add(title=None):\n    if title:\n        ITEMS.append(title)\n    return ITEMS\n',
);

let host: PageHost;
beforeAll(async () => {
    host = await PageHost.start({
        trees: { workspace: root, workdir: root },
        pythonPath: pythonPath(),
    });
});
afterAll(async () => {
    await host.close();
    await browser?.close();
    rmSync(root, { recursive: true, force: true });
});

describe.runIf(browser && hasPython)('zen page in a browser', { timeout: 60_000 }, () => {
    it('reports each mistake once, at the right level, with screenshots', async () => {
        const session = await PageSession.open(host, browser!);
        try {
            const out = join(root, '.tmp/page-check/bad');
            const r = await checkPage(session, join(root, 'pages/bad/index.html'), {
                widths: [...DEFAULT_WIDTHS],
                dark: true,
                outDir: out,
                timeoutMs: 10_000,
                preview: true,
            });
            const errors = r.problems.filter((p) => p.level === 'error').map((p) => p.text);
            expect(errors).toEqual(
                expect.arrayContaining([
                    expect.stringMatching(/^uncaught: undefinedFunction is not defined/),
                    expect.stringMatching(/^console error: storage: .*sandboxed/),
                    expect.stringMatching(/^function POST .*\/api\/items\/boom → 500: .*KeyError/),
                    expect.stringMatching(
                        /^panel \(400 px\): the page is \d+ px wide .*div\.toolbar/,
                    ),
                ]),
            );
            expect(errors).toHaveLength(4);
            expect(r.pending).toEqual([]);
            // Every layout of the kit, and the panel in dark.
            expect(r.screenshots.map((s) => [s.width, s.dark, png(s.file).width])).toEqual([
                [400, false, 400],
                [640, false, 640],
                [1280, false, 1280],
                [400, true, 400],
            ]);
            // The chat's card for the page: beside it, the size of a link preview.
            expect(r.preview).toBe(join(root, 'pages/bad/preview.png'));
            expect(png(r.preview!)).toEqual({ width: 1200, height: 630 });
        } finally {
            await session.close();
        }
    });

    it('keeps a screenshot readable: the top of a tall page, or all of it in parts', async () => {
        const session = await PageSession.open(host, browser!);
        try {
            await session.goto(join(root, 'pages/tall/index.html'));
            const out = join(root, '.tmp/page-check/tall');
            const top = await session.screenshot(join(out, 'top.png'));
            expect(top.height).toBeGreaterThanOrEqual(4000);
            expect(top.files.map((f) => png(f))).toEqual([{ width: 400, height: SHOT_HEIGHT }]);
            const all = await session.screenshot(join(out, 'all.png'), { area: 'full' });
            expect(all.files.map((f) => f.slice(out.length + 1))).toEqual([
                'all-1.png',
                'all-2.png',
                'all-3.png',
            ]);
            expect(all.files.map((f) => png(f).height)).toEqual([
                SHOT_HEIGHT,
                SHOT_HEIGHT,
                top.height - 2 * SHOT_HEIGHT,
            ]);
        } finally {
            await session.close();
        }
    });

    it('drives an app: fill, click, and the list its function answers with', async () => {
        const session = await PageSession.open(host, browser!);
        try {
            await session.goto(join(root, 'pages/todo/index.html'));
            const snap = await session.snapshot();
            const ref = (role: string) =>
                new RegExp(`${role}[^\\n]*\\[ref=(e\\d+)\\]`).exec(snap)![1]!;
            await session.locate(ref('textbox')).fill('Milk');
            await session.locate(ref('button')).click();
            await session.settle();
            expect(await session.snapshot()).toMatch(/listitem[^\n]*: Milk/);
            expect(session.takeProblems()).toEqual([]);
        } finally {
            await session.close();
        }
    });
});
