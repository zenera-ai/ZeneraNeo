import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    AgentFileError,
    agentFilePath,
    agentFileStatus,
    contentTypeOf,
    resolveAgentFile,
    sendAgentFile,
    type FileTrees,
} from '../src/index.ts';

// A session's workspace and the project's assets and skills, side by side, with a secret
// outside all of them that links try to reach.
const root = mkdtempSync(join(tmpdir(), 'zen-files-'));
const workspace = join(root, 'workspace');
const assets = join(root, 'assets');
const skills = join(root, 'skills');
const secret = join(root, 'secret.txt');
const trees: FileTrees = { workspace, workdir: '/workspace', assets };

beforeAll(() => {
    for (const d of [workspace, assets, skills, join(workspace, 'out'), join(workspace, '.data')]) {
        mkdirSync(d, { recursive: true });
    }
    writeFileSync(join(workspace, 'a b.txt'), 'spaces');
    writeFileSync(join(workspace, 'out', 'chart.png'), 'png');
    writeFileSync(join(workspace, 'page.html'), '<script>alert(1)</script>');
    writeFileSync(join(workspace, 'data.parquet'), '0123456789');
    writeFileSync(join(workspace, '.env'), 'KEY=1');
    writeFileSync(join(workspace, '.data', 'state.json'), '{}');
    writeFileSync(join(assets, 'logo.svg'), '<svg/>');
    writeFileSync(join(skills, 'SKILL.md'), 'skill');
    writeFileSync(secret, 'secret');
    symlinkSync(secret, join(workspace, 'escape.txt'));
    symlinkSync(join(workspace, '.env'), join(workspace, 'env-link'));
    symlinkSync(join(assets, 'logo.svg'), join(workspace, 'logo-link.svg'));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const refused = (link: string, t: FileTrees = trees): string | undefined => {
    try {
        resolveAgentFile(link, t);
        return undefined;
    } catch (err) {
        return err instanceof AgentFileError ? err.code : String(err);
    }
};

describe('agentFilePath', () => {
    it('reads file: urls, absolute and relative paths', () => {
        expect(agentFilePath('file:///workspace/a%20b.png#top')).toBe('/workspace/a b.png');
        expect(agentFilePath('file:///workspace/x.csv?v=2')).toBe('/workspace/x.csv');
        expect(agentFilePath('file://workspace/x.json')).toBe('/workspace/x.json');
        expect(agentFilePath('/assets/logo.svg')).toBe('/assets/logo.svg');
        expect(agentFilePath('out/chart.png', '/src')).toBe('/src/out/chart.png');
        expect(agentFilePath('file:///workspace/%2E%2E/etc/passwd')).toBe('/etc/passwd');
    });

    it('names nothing for other schemes or broken urls', () => {
        expect(agentFilePath('https://example.com/a.png')).toBeUndefined();
        expect(agentFilePath('javascript:alert(1)')).toBeUndefined();
        expect(agentFilePath('file:///workspace/%E0%A4%A')).toBeUndefined();
        expect(agentFilePath('/workspace/a\0b')).toBeUndefined();
        expect(agentFilePath('')).toBeUndefined();
    });
});

describe('resolveAgentFile', () => {
    it('finds files in the workspace and the assets', () => {
        const file = resolveAgentFile('file:///workspace/a%20b.txt', trees);
        expect(file).toMatchObject({ path: '/workspace/a b.txt', tree: 'workspace', size: 6 });
        expect(resolveAgentFile('out/chart.png', trees).tree).toBe('workspace');
        expect(resolveAgentFile('/assets/logo.svg', trees).tree).toBe('assets');
        // A link from the workspace into the assets still lands in a tree that is shown.
        expect(resolveAgentFile('/workspace/logo-link.svg', trees).size).toBe(6);
    });

    it('follows a custom workdir', () => {
        const src = { ...trees, workdir: '/src' };
        expect(resolveAgentFile('/src/out/chart.png', src).path).toBe('/src/out/chart.png');
        expect(refused('/workspace/out/chart.png', src)).toBe('outside');
    });

    it('refuses what is outside, hidden or not a file', () => {
        expect(refused('/etc/passwd')).toBe('outside');
        expect(refused('/workspace/../secret.txt')).toBe('outside');
        expect(refused('file:///workspace/%2E%2E/secret.txt')).toBe('outside');
        expect(refused('/skills/SKILL.md')).toBe('outside');
        expect(refused('/workspace/escape.txt')).toBe('outside');
        expect(refused('/workspace/.env')).toBe('hidden');
        expect(refused('/workspace/.data/state.json')).toBe('hidden');
        expect(refused('/workspace/env-link')).toBe('hidden');
        expect(refused('/workspace/out')).toBe('missing');
        expect(refused('/workspace/nope.png')).toBe('missing');
        expect(refused('/assets/logo.svg', { ...trees, assets: undefined })).toBe('outside');
        expect(refused('https://example.com/x')).toBe('invalid');
        expect(agentFileStatus('invalid')).toBe(400);
        expect(agentFileStatus('hidden')).toBe(403);
        expect(agentFileStatus('missing')).toBe(404);
    });

    it('reads a dot-folder only where the host allows it', () => {
        expect(
            resolveAgentFile('/workspace/.data/state.json', {
                ...trees,
                dotted: ['/workspace/.data'],
            }).size,
        ).toBe(2);
        expect(refused('/workspace/.env', { ...trees, dotted: ['/workspace/.data'] })).toBe(
            'hidden',
        );
    });
});

describe('sendAgentFile', () => {
    let server: Server;
    let url: string;
    beforeAll(async () => {
        server = createServer((req, res) => {
            const query = new URL(req.url!, 'http://x').searchParams;
            const path = query.get('path')!;
            const view = query.has('view')
                ? { frameAncestors: ['https://chat.example'] }
                : undefined;
            try {
                void sendAgentFile(req, res, resolveAgentFile(path, trees), { view });
            } catch (err) {
                res.statusCode = agentFileStatus((err as AgentFileError).code);
                res.end();
            }
        });
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/?path=`;
    });
    afterAll(() => server.close());
    const get = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
        fetch(url + encodeURIComponent(path), { headers, method });

    it('sends the file with its type, validators and safety headers', async () => {
        const res = await get('/workspace/out/chart.png');
        expect(res.status).toBe(200);
        expect(await res.text()).toBe('png');
        expect(res.headers.get('content-type')).toBe('image/png');
        expect(res.headers.get('content-disposition')).toMatch(/^inline; filename="chart.png"/);
        expect(res.headers.get('cache-control')).toBe('private, no-cache');
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        expect(res.headers.get('content-security-policy')).toBe('sandbox');
        expect(res.headers.get('etag')).toMatch(/^"[\da-z]+-[\da-z]+"$/);
        expect((await get('/assets/logo.svg')).headers.get('cache-control')).toBe(
            'private, max-age=300',
        );
    });

    it('sends what could run as a page as a download', async () => {
        for (const path of ['/workspace/page.html', '/assets/logo.svg']) {
            const res = await get(path);
            expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
            expect(res.headers.get('content-security-policy')).toBe('sandbox');
            expect(res.headers.get('access-control-allow-origin')).toBeNull();
        }
    });

    it('serves a page for viewing in an opaque origin that reads only its own files', async () => {
        const res = await fetch(`${url}${encodeURIComponent('/workspace/page.html')}&view`);
        expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
        expect(res.headers.get('content-disposition')).toMatch(/^inline;/);
        expect(res.headers.get('access-control-allow-origin')).toBe('*');
        const csp = res.headers.get('content-security-policy')!.split('; ');
        expect(csp[0]).toBe('sandbox allow-scripts allow-popups');
        expect(csp).toContain("connect-src 'self'");
        expect(csp).toContain("form-action 'none'");
        expect(csp).toContain('frame-ancestors https://chat.example');
        expect(csp.find((d) => d.startsWith('script-src'))).toContain('https://cdn.jsdelivr.net');
        expect(csp.find((d) => d.startsWith('img-src'))).not.toContain('https:');
    });

    it('answers 304 to a client that has the file', async () => {
        const etag = (await get('/workspace/a b.txt')).headers.get('etag')!;
        const res = await get('/workspace/a b.txt', { 'if-none-match': etag });
        expect(res.status).toBe(304);
        expect(await res.text()).toBe('');
    });

    it('sends one byte range, or says none fits', async () => {
        const part = await get('/workspace/data.parquet', { range: 'bytes=2-5' });
        expect(part.status).toBe(206);
        expect(part.headers.get('content-range')).toBe('bytes 2-5/10');
        expect(await part.text()).toBe('2345');
        const tail = await get('/workspace/data.parquet', { range: 'bytes=-3' });
        expect(await tail.text()).toBe('789');
        const none = await get('/workspace/data.parquet', { range: 'bytes=20-' });
        expect(none.status).toBe(416);
        expect(none.headers.get('content-range')).toBe('bytes */10');
        const stale = await get('/workspace/data.parquet', {
            range: 'bytes=2-5',
            'if-range': '"old"',
        });
        expect(stale.status).toBe(200);
        expect(await stale.text()).toBe('0123456789');
    });

    it('answers HEAD without a body', async () => {
        const res = await get('/workspace/data.parquet', {}, 'HEAD');
        expect(res.status).toBe(200);
        expect(res.headers.get('content-length')).toBe('10');
    });

    it('types files by name', () => {
        expect(contentTypeOf('x.parquet')).toBe('application/vnd.apache.parquet');
        expect(contentTypeOf('x.CSV')).toBe('text/csv; charset=utf-8');
        expect(contentTypeOf('x.unknown')).toBe('application/octet-stream');
    });
});
