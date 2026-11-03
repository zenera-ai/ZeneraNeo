import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { renderMemoryHtml } from '../src/memory/page.ts';
import { buildMemoryReport } from '../src/memory/report.ts';
import { FILES_DIR, MemoryStore } from '../src/memory/store.ts';

const dirs: string[] = [];

afterEach(() => {
    for (const d of dirs.splice(0)) {
        rmSync(d, { recursive: true, force: true });
    }
});

const AT = '2026-01-01T00:00:00.000Z';

async function store(): Promise<MemoryStore> {
    const dir = mkdtempSync(join(tmpdir(), 'zn-memreport-'));
    dirs.push(dir);
    return MemoryStore.open(dir);
}

/** Writes a remembered file the way `rememberFile` would name it. */
function put(dir: string, name: string, content: string | Buffer): void {
    mkdirSync(join(dir, FILES_DIR), { recursive: true });
    writeFileSync(join(dir, FILES_DIR, name), content);
}

describe('the memory report', () => {
    it('carries every node, unmasked, whatever its audience', async () => {
        const s = await store();
        s.graph.add({ id: 'a', kind: 'fact', text: 'public', audience: ['*'] }, AT);
        s.graph.add({ id: 'b', kind: 'fact', text: 'private', audience: ['audit'] }, AT);

        const report = await buildMemoryReport(s);

        expect(report.nodes.map((n) => n.id).sort()).toEqual(['a', 'b']);
        expect(report.audiences).toEqual(['*', 'audit']);
        expect(report.kinds).toEqual(['fact']);
    });

    it('counts edges as degree, in either direction', async () => {
        const s = await store();
        s.graph.add({ id: 'a', kind: 'task', text: 'ask', audience: ['*'] }, AT);
        s.graph.add({ id: 'b', kind: 'plan', text: 'plan', audience: ['*'] }, AT);
        s.graph.add({ id: 'c', kind: 'fact', text: 'lonely', audience: ['*'] }, AT);
        s.graph.link('a', 'b', 'PRODUCED', AT);

        const report = await buildMemoryReport(s);
        const by = new Map(report.nodes.map((n) => [n.id, n]));

        expect(by.get('a')!.degree).toBe(1);
        expect(by.get('b')!.degree).toBe(1);
        expect(by.get('c')!.degree).toBe(0);
        expect(report.edges).toEqual([{ source: 'a', target: 'b', relation: 'PRODUCED' }]);
    });

    it('marks what a later node superseded', async () => {
        const s = await store();
        s.graph.add({ id: 'old', kind: 'fact', text: 'wrong', audience: ['*'] }, AT);
        s.graph.add({ id: 'new', kind: 'fact', text: 'right', audience: ['*'] }, AT);
        s.graph.link('new', 'old', 'SUPERSEDES', AT);

        const report = await buildMemoryReport(s);
        const by = new Map(report.nodes.map((n) => [n.id, n]));

        expect(by.get('old')!.stale).toBe(true);
        expect(by.get('new')!.stale).toBe(false);
    });

    it('inlines a remembered file so the page needs nothing else', async () => {
        const s = await store();
        put(s.dir, 'f1.py', 'print("audited")\n');
        s.graph.add(
            {
                id: 'f',
                kind: 'file',
                text: 'the audit script',
                audience: ['*'],
                file: { path: 'f1.py', bytes: 17, sha256: 'abc', format: 'py' },
            },
            AT,
        );

        const [node] = (await buildMemoryReport(s)).nodes;

        expect(node!.content).toBe('print("audited")\n');
        expect(node!.omitted).toBeUndefined();
    });

    it('names and measures a file too big to inline, rather than dropping it', async () => {
        const s = await store();
        put(s.dir, 'big.txt', 'x'.repeat(5000));
        s.graph.add(
            {
                id: 'f',
                kind: 'file',
                text: 'big',
                audience: ['*'],
                file: { path: 'big.txt', bytes: 5000, sha256: 'abc', format: 'txt' },
            },
            AT,
        );

        const [node] = (await buildMemoryReport(s, { maxContentBytes: 100 })).nodes;

        expect(node!.omitted).toBe('too-big');
        expect(node!.content).toBeUndefined();
        expect(node!.file!.bytes).toBe(5000);
    });

    it('says so when the graph records a file that is not on disk', async () => {
        const s = await store();
        s.graph.add(
            {
                id: 'f',
                kind: 'file',
                text: 'gone',
                audience: ['*'],
                file: { path: 'gone.py', bytes: 10, sha256: 'abc', format: 'py' },
            },
            AT,
        );

        expect((await buildMemoryReport(s)).nodes[0]!.omitted).toBe('missing');
    });

    it('refuses to inline bytes that are not text', async () => {
        const s = await store();
        put(s.dir, 'blob.bin', Buffer.from([0x41, 0x00, 0x42]));
        s.graph.add(
            {
                id: 'f',
                kind: 'file',
                text: 'binary',
                audience: ['*'],
                file: { path: 'blob.bin', bytes: 3, sha256: 'abc', format: 'bin' },
            },
            AT,
        );

        expect((await buildMemoryReport(s)).nodes[0]!.omitted).toBe('binary');
    });

    it('carries an image as a data url, so the page still opens offline', async () => {
        const s = await store();
        put(s.dir, 'shot.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        s.graph.add(
            {
                id: 'f',
                kind: 'file',
                text: 'a screenshot',
                audience: ['*'],
                file: { path: 'shot.png', bytes: 4, sha256: 'abc', format: 'png' },
            },
            AT,
        );

        const [node] = (await buildMemoryReport(s)).nodes;

        expect(node!.image).toBe('data:image/png;base64,iVBORw==');
        expect(node!.content).toBeUndefined();
    });
});

describe('the memory page', () => {
    it('cannot be escaped by node text that closes the script tag', async () => {
        const s = await store();
        s.graph.add(
            {
                id: 'x',
                kind: 'fact',
                text: '</script><img src=x onerror=alert(1)>',
                audience: ['*'],
            },
            AT,
        );

        const html = renderMemoryHtml(await buildMemoryReport(s));

        // Exactly the script elements the page opens on purpose, and no more.
        expect(html.match(/<\/script>/g)).toHaveLength(2);
        // The payload survives as text but cannot form a tag: every `<` it had
        // is escaped, so there is no `<img` for a parser to find.
        expect(html).not.toContain('<img');
        expect(html).toContain('\\u003c/script\\u003e');
        expect(html).toContain('\\u003cimg src=x onerror=alert(1)\\u003e');
    });

    it('cannot be escaped by the contents of a remembered file', async () => {
        const s = await store();
        put(s.dir, 'evil.html', '</script><script>alert(1)</script>');
        s.graph.add(
            {
                id: 'f',
                kind: 'file',
                text: 'a page someone kept',
                audience: ['*'],
                file: { path: 'evil.html', bytes: 34, sha256: 'abc', format: 'html' },
            },
            AT,
        );

        const html = renderMemoryHtml(await buildMemoryReport(s));

        expect(html.match(/<\/script>/g)).toHaveLength(2);
        expect(html).not.toContain('<script>alert(1)');
    });

    it('is one self-contained file with the graph in it', async () => {
        const s = await store();
        s.graph.add({ id: 'a', kind: 'task', text: 'audit the rules', audience: ['*'] }, AT);
        s.graph.add({ id: 'b', kind: 'plan', text: 'read them first', audience: ['*'] }, AT);
        s.graph.link('a', 'b', 'PRODUCED', AT);

        const html = renderMemoryHtml(await buildMemoryReport(s, { title: 'acme · memory' }));

        expect(html.startsWith('<!doctype html>')).toBe(true);
        expect(html).toContain('acme · memory');
        expect(html).toContain('audit the rules');
        expect(html).toContain('PRODUCED');
        // The three panes the page is for.
        expect(html).toContain('id="list"');
        expect(html).toContain('class="canvas"');
        expect(html).toContain('id="detail"');
    });

    it('opens on an empty memory instead of failing', async () => {
        const s = await store();
        const html = renderMemoryHtml(await buildMemoryReport(s));
        expect(html).toContain('this memory is empty');
    });
});
