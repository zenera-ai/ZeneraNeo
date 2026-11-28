/**
 * The html-page skill's build (templates/project/agents/skills/html-page/scripts/build.ts), run
 * as an agent runs it: `node build.ts <page folder>`. Here it finds esbuild, typescript and
 * react in the repository's node_modules; in the sandbox, through NODE_PATH.
 */
import { spawnSync } from 'node:child_process';
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const SKILL = fileURLToPath(
    new URL('../templates/project/agents/skills/html-page/', import.meta.url),
);
const BUILD = join(SKILL, 'scripts', 'build.ts');
const root = mkdtempSync(join(tmpdir(), 'zen-page-build-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let pages = 0;
function page(files: Record<string, string>): string {
    const dir = join(root, `page-${++pages}`);
    for (const [name, text] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, name)), { recursive: true });
        writeFileSync(join(dir, name), text);
    }
    mkdirSync(dir, { recursive: true });
    return dir;
}

function build(dir: string, ...args: string[]) {
    const run = spawnSync(process.execPath, [BUILD, dir, ...args], { encoding: 'utf8' });
    return { status: run.status, out: run.stdout, err: run.stderr };
}

/** The page's inlined module script, as the browser would cut it out of the html. */
function moduleScript(html: string): string {
    const start = html.indexOf('<script type="module">');
    return html.slice(start, html.indexOf('</script>', start));
}

const DATA = JSON.stringify({
    title: 'Sales',
    source: 'orders.csv',
    rows: [{ date: '2026-01-02', category: 'Books', region: 'EU', amount: 12 }],
});

describe('html-page build', { timeout: 60_000 }, () => {
    it('builds each template into one stamped html with React and the kit inlined', () => {
        const dashboard = page({ 'data.json': DATA });
        cpSync(join(SKILL, 'assets', 'dashboard.tsx'), join(dashboard, 'app.tsx'));
        const app = join(root, 'app-template');
        cpSync(join(SKILL, 'assets', 'app'), app, { recursive: true });

        for (const dir of [dashboard, app]) {
            const run = build(dir);
            expect(run.err).toBe('');
            expect(run.status).toBe(0);
            expect(run.out).toMatch(/✓ wrote index\.html \(\d+ KB\) from app\.tsx/);
            const html = readFileSync(join(dir, 'index.html'), 'utf8');
            expect(html).toMatch(
                /^<!doctype html>\n<!-- Built by the html-page skill from app\.tsx/,
            );
            expect(html).not.toContain('@page/kit');
            expect(html).not.toMatch(/<script[^>]+src="(?!https:\/\/cdn\.jsdelivr\.net\/)/);
            expect(moduleScript(html)).toContain('createRoot');
        }
        // A CDN library only where the page uses it.
        const charts = readFileSync(join(dashboard, 'index.html'), 'utf8');
        expect(charts).toContain('echarts@5.6.0/dist/echarts.min.js');
        expect(charts).toContain('tabulator-tables@6.3.1/dist/js/tabulator.min.js');
        expect(readFileSync(join(app, 'index.html'), 'utf8')).not.toMatch(
            /echarts@|tabulator-tables@/,
        );
        expect(build(app, '--check').status).toBe(0);
    });

    it('reports type errors and what a page cannot do, with where, and writes nothing', () => {
        const dir = page({
            'app.tsx': [
                `import { createRoot } from 'react-dom/client';`,
                `import { api, useData } from '@page/kit';`,
                `interface Expense { amount: number }`,
                `export default function App() {`,
                `    const data = useData<Expense[]>('missing.json');`,
                `    localStorage.setItem('k', 'v');`,
                `    if (!confirm('sure?')) return null;`,
                `    api('api/nothing');`,
                `    return <div dangerouslySetInnerHTML={{ __html: 'x' }}><img src="https://evil.example/x.png" />{data.data?.[0].ammount}</div>;`,
                `}`,
            ].join('\n'),
            'Inbox.tsx': `export function Inbox() { return null; }`,
        });
        const run = build(dir);
        expect(run.status).toBe(1);
        expect(run.err).toContain(
            "app.tsx:9:115  Property 'ammount' does not exist on type 'Expense'. Did you mean 'amount'?",
        );
        for (const expected of [
            'Inbox.tsx:1:1  a .tsx beside the page is a page of its own',
            'app.tsx:1:10  the build mounts the page itself',
            "app.tsx:5:37  'missing.json': there is no such file beside the page",
            'app.tsx:6:5  localStorage is not available to pages',
            'app.tsx:7:10  confirm() is blocked in pages',
            "app.tsx:8:9  api('api/nothing'): there is no api/nothing.api.py beside the page",
            'app.tsx:9:17  no raw html',
            'app.tsx:9:68  evil.example is blocked',
        ]) {
            expect(run.err).toContain(expected);
        }
        expect(run.err).toContain('Nothing was written.');
        expect(existsSync(join(dir, 'index.html'))).toBe(false);
    });

    it('catches a crash on the first render, at its line', () => {
        const dir = page({
            'app.tsx': `import { List } from './components/List';\nexport default function App() { return <List />; }\n`,
            'components/List.tsx': `export function List({ items }: { items?: string[] }) {\n    return <ul>{items!.map((i) => <li key={i}>{i}</li>)}</ul>;\n}\n`,
        });
        const run = build(dir);
        expect(run.status).toBe(1);
        expect(run.err).toContain(
            "components/List.tsx:2:24  the page crashed on its first render: Cannot read properties of undefined (reading 'map')",
        );
    });

    it('checks React itself: hooks, events and props are typed', () => {
        const dir = page({
            'app.tsx': [
                `import { useState } from 'react';`,
                `import { Split } from '@page/kit';`,
                `export default function App() {`,
                `    const [n, setN] = useState(0);`,
                `    return <div onClick={() => setN('x')}><Split list={n} detail={null} open={false} /></div>;`,
                `}`,
            ].join('\n'),
        });
        const run = build(dir);
        expect(run.status).toBe(1);
        expect(run.err).toContain("app.tsx:5:37  Argument of type 'string' is not assignable");
        expect(run.err).toMatch(/app\.tsx:5:\d+ {2}.*Property 'open' does not exist/);
    });

    it('rejects layouts that break or hide things on the narrow side panel', () => {
        const dir = page({
            'app.tsx': [
                `import './app.css';`,
                `export default function App() {`,
                `    return <div style={{ width: 640, gridTemplateColumns: '200px 1fr', maxWidth: 900 }}>x</div>;`,
                `}`,
            ].join('\n'),
            'app.css': [
                `.row { display: grid; grid-template-columns: 160px minmax(0, 1fr) auto; }`,
                `.cards { grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); }`,
                `.ok { grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr)) 24px; }`,
                `@media (max-width: 700px) { .sidebar { display: none; } }`,
                `@container page (min-width: 900px) { .wide { width: 800px; grid-template-columns: 300px 1fr; } }`,
                `body { height: 100vh; overflow: hidden; }`,
            ].join('\n'),
        });
        const run = build(dir);
        expect(run.status).toBe(1);
        for (const expected of [
            'app.tsx:3:26  width: 640px is wider than',
            'app.tsx:3:38  fixed columns of 200 px',
            'app.css:1:23  fixed columns of 160 px',
            'app.css:2:10  minmax(420px, …) overflows a narrow panel',
            'app.css:4:40  display: none in a media or container query',
            'app.css:6:8  height: 100vh on the page itself',
            'app.css:6:23  overflow: hidden on the page itself',
        ]) {
            expect(run.err).toContain(expected);
        }
        // Fine: a floor that gives way, a small fixed column, a max-width, wide-only sizes.
        expect(run.err).not.toMatch(/app\.css:[35]:/);
        expect(run.err).not.toContain('max-width: 900');
    });

    it('keeps a string that closes a script from closing the inlined one', () => {
        const dir = page({
            'app.tsx': `const s = '</script><script>alert(1)</script><!-- x';\nexport default function App() { return <p>{s}</p>; }\n`,
        });
        expect(build(dir).status).toBe(0);
        const script = moduleScript(readFileSync(join(dir, 'index.html'), 'utf8'));
        expect(script).toContain('<\\/script><script>alert(1)<\\/script><\\!-- x');
        expect(script).toContain('createRoot');
    });

    it('builds each page of a folder, and never overwrites an html it did not write', () => {
        const dir = page({
            'app.tsx': `export default function App() { return <p>home</p>; }\n`,
            'report.tsx': `import logo from './logo.svg';\nexport const title = 'Monthly report';\nexport default function Report() { return <img src={logo} alt="logo" />; }\n`,
            'logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
            'index.html': '<p>written by hand</p>',
        });
        const refused = build(dir);
        expect(refused.status).toBe(1);
        expect(refused.err).toContain('index.html  is not a page this build wrote');
        expect(readFileSync(join(dir, 'index.html'), 'utf8')).toBe('<p>written by hand</p>');

        rmSync(join(dir, 'index.html'));
        const run = build(dir);
        expect(run.status).toBe(0);
        expect(run.out).toContain('✓ wrote report.html');
        const report = readFileSync(join(dir, 'report.html'), 'utf8');
        expect(report).toContain('<title>Monthly report</title>');
        expect(report).toContain('data:image/svg+xml');
        expect(run.out).toMatch(/Link it as \[Page \d+\]\(file:\/\/.*\/index\.html\)/);
    });

    it("puts the page's card in meta tags at the top, and reminds of what is missing", () => {
        const dir = page({
            'app.tsx': [
                `export const title = 'Mail';`,
                `export const description = "Inbox you can search; it's <demo> & fake mail.";`,
                `export const previewAlt = 'Inbox list with a search box';`,
                `export default function App() { return <p>mail</p>; }`,
            ].join('\n'),
            'report.tsx': `export default function Report() { return <p>report</p>; }\n`,
        });
        const run = build(dir);
        expect(run.status).toBe(0);
        const html = readFileSync(join(dir, 'index.html'), 'utf8');
        expect(html).toContain(
            `<meta name="description" content="Inbox you can search; it's &lt;demo&gt; &amp; fake mail." />`,
        );
        // The picture `zen page check` writes beside each page.
        expect(html).toContain('<meta property="og:image" content="preview.png" />');
        expect(html).toContain(
            '<meta property="og:image:alt" content="Inbox list with a search box" />',
        );
        // Near the top, so the chat reads it with the first few KB of the file.
        expect(html.indexOf('og:image:alt')).toBeLessThan(1024);
        const report = readFileSync(join(dir, 'report.html'), 'utf8');
        expect(report).toContain('<meta property="og:image" content="report.preview.png" />');
        expect(report).toContain('<meta property="og:image:alt" content="Preview of Report" />');
        expect(run.out).not.toMatch(/app\.tsx has no (description|previewAlt)/);
        expect(run.out).toContain('report.tsx has no description');
        expect(run.out).toContain('report.tsx has no previewAlt');
    });

    it('--check says when a page is out of date with its sources, and writes nothing', () => {
        const dir = page({ 'app.tsx': `export default function App() { return <p>one</p>; }\n` });
        const unbuilt = build(dir, '--check');
        expect(unbuilt.status).toBe(1);
        expect(unbuilt.err).toContain('index.html  not built yet');
        expect(existsSync(join(dir, 'index.html'))).toBe(false);

        expect(build(dir).status).toBe(0);
        expect(build(dir, '--check').status).toBe(0);
        writeFileSync(
            join(dir, 'app.tsx'),
            `export default function App() { return <p>two</p>; }\n`,
        );
        const stale = build(dir, '--check');
        expect(stale.status).toBe(1);
        expect(stale.err).toContain('index.html  out of date with app.tsx');
    });
});
