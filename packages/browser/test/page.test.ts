/**
 * @zenera/browser's serving (host.ts) and target resolution (target.ts), without a
 * browser: a page's requests are answered as `/v/` answers them - its files under the view CSP,
 * its functions run by zen's Python runtime, its sources and dot-folders never sent.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PageHost } from '../src/host.ts';
import { pythonPath, resolveTarget } from '../src/target.ts';
import { widthName, widthsOf } from '../src/widths.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'zen-page-host-')));
const hasPython = spawnSync('python3', ['--version']).status === 0;

function file(path: string, text: string): void {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
}

file('pages/todo/index.html', '<!doctype html><title>Todo</title><p>hi</p>');
file('pages/todo/report.html', '<!doctype html><p>report</p>');
file('pages/todo/api/items.api.py', 'def count(n=1):\n    return {"count": n + 1}\n');
file('pages/todo/api/.data/secret.txt', 'nope');
file('pages/empty/notes.md', '# not a page');

let host: PageHost;
beforeAll(async () => {
    host = await PageHost.start({
        trees: { workspace: root, workdir: root },
        pythonPath: pythonPath(),
    });
});
afterAll(async () => {
    await host.close();
    rmSync(root, { recursive: true, force: true });
});

const get = (path: string) => host.fetch({ method: 'GET', path: join(root, path), headers: {} });

describe('zen page: serving a page as /v/ does', () => {
    it('sends a page under the view CSP, readable by its opaque origin', async () => {
        const res = await get('pages/todo/index.html');
        expect(res.status).toBe(200);
        expect(res.body.toString()).toContain('<p>hi</p>');
        expect(res.headers['content-security-policy']).toContain('sandbox allow-scripts');
        expect(res.headers['access-control-allow-origin']).toBe('*');
    });

    it('never sends a function file or a dot-folder', async () => {
        const source = await get('pages/todo/api/items.api.py');
        expect(source.status).toBe(404);
        expect(source.body.toString()).not.toContain('def count');
        const hidden = await get('pages/todo/api/.data/secret.txt');
        expect(hidden.status).toBeGreaterThanOrEqual(400);
        expect(hidden.body.toString()).not.toContain('nope');
    });

    it.runIf(hasPython)('runs a function of an *.api.py with the page’s arguments', async () => {
        const res = await host.fetch({
            method: 'POST',
            path: join(root, 'pages/todo/api/items/count'),
            headers: { 'content-type': 'text/plain' },
            body: Buffer.from(JSON.stringify({ n: 41 })),
        });
        expect(res.headers['x-zenera-call']).toBe('1');
        expect(res.status).toBe(200);
        expect(JSON.parse(res.body.toString())).toEqual({ count: 42 });
    });
});

describe('zen page: what it was pointed at', () => {
    it('pins the Playwright whose browser the sandbox base carries', async () => {
        const { PLAYWRIGHT_VERSION } = await import('@zenera/sandbox');
        const pkg = JSON.parse(
            readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
        ) as { dependencies: Record<string, string> };
        expect(pkg.dependencies['playwright-core']).toBe(PLAYWRIGHT_VERSION);
    });

    it('takes a folder’s index.html first, then its other pages', () => {
        const t = resolveTarget('pages/todo', root);
        expect(t.pages).toEqual([
            join(root, 'pages/todo/index.html'),
            join(root, 'pages/todo/report.html'),
        ]);
        expect(t.trees?.workdir).toBe(root);
        expect(t.outDir).toBe(join(root, '.tmp/page-check/todo'));
    });

    it('says to build first when a folder has no page', () => {
        expect(() => resolveTarget('pages/empty', root)).toThrow(/no built page/);
    });

    it('takes a URL as it is, with nothing to serve', () => {
        const t = resolveTarget('https://example.com/v/tok/workspace/pages/todo/index.html', root);
        expect(t.trees).toBeNull();
        expect(t.pages).toEqual(['https://example.com/v/tok/workspace/pages/todo/index.html']);
    });
});

describe('zen page: widths', () => {
    it('takes the layouts by name, or px, the panel first by default', () => {
        expect(widthsOf(undefined)).toEqual([400, 640, 1280]);
        expect(widthsOf('tab,panel,900')).toEqual([1280, 400, 900]);
        expect(widthName(640)).toBe('wide-panel');
        expect(widthName(900)).toBe('900');
    });

    it('refuses what is not a width', () => {
        expect(() => widthsOf('phone')).toThrow(/not a width/);
        expect(() => widthsOf('50')).toThrow(/not a width/);
    });
});
