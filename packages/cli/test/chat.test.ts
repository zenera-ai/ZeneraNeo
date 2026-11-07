import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chatUrl } from '../src/chat.ts';

describe('standalone chat launch URL', () => {
    it.each(['127.0.0.1', 'localhost', '::1'])(
        'uses a packaged file and a fragment for %s',
        (host) => {
            const link = new URL(chatUrl({ host, port: 3931 }, 'dev.jwt.'));
            expect(link.protocol).toBe('file:');
            expect(link.pathname).toMatch(/\/assets\/chat.html$/);
            expect(link.search).toBe('');
            const parameters = new URLSearchParams(link.hash.slice(1));
            expect(parameters.get('jwt')).toBe('dev.jwt.');
            expect(parameters.get('server')).toBe(`http://${host === '::1' ? '[::1]' : host}:3931`);
            link.hash = '';
            const page = readFileSync(link, 'utf8');
            expect(page).toContain('<title>Zenera test chat</title>');
            expect(page).not.toMatch(/<script[^>]+\bsrc=/i);
            expect(page).not.toMatch(/<link[^>]+\brel=["']stylesheet/i);
        },
    );
});
