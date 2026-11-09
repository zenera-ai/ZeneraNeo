/**
 * Vitest coverage for chatUrl, the insecure server CLI's standalone-chat launcher.
 * Parameterized tests check IPv4/IPv6 HTTP URLs, intact JWTs and terminal-safe endings, then read
 * the packaged HTML to verify that no external scripts or stylesheets are required.
 * Run by the CLI test suite without starting a server or browser.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chatPage, chatUrl } from '../src/chat.ts';

describe('standalone chat launch URL', () => {
    it.each(['127.0.0.1', 'localhost', '::1'])(
        'uses an HTTP chat route and a fragment for %s',
        (host) => {
            const link = new URL(chatUrl({ host, port: 3931 }, 'dev.jwt.'));
            expect(link.protocol).toBe('http:');
            expect(link.pathname).toBe('/chat');
            expect(link.search).toBe('');
            const parameters = new URLSearchParams(link.hash.slice(1));
            expect(parameters.get('jwt')).toBe('dev.jwt.');
            expect(parameters.get('open')).toBe('1');
            expect(link.href).toMatch(/&open=1$/);
            expect(parameters.get('server')).toBe(`http://${host === '::1' ? '[::1]' : host}:3931`);
            expect(`${link.origin}${link.pathname}`).not.toContain('dev.jwt.');
            const page = readFileSync(chatPage(), 'utf8');
            expect(page).toContain('<title>Zenera test chat</title>');
            expect(page).not.toMatch(/<script[^>]+\bsrc=/i);
            expect(page).not.toMatch(/<link[^>]+\brel=["']stylesheet/i);
        },
    );
});
