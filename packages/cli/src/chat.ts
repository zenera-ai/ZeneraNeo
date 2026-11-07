/**
 * Packaged standalone-chat URL helper, used by the server CLI after insecure startup.
 * chatPage locates assets/chat.html for the insecure HTTP route; chatUrl puts the
 * runtime address and dev JWT in that route's fragment, handling IPv6 addresses.
 * A trailing open parameter keeps terminals from trimming the unsigned JWT's final dot.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CliError, EXIT } from './term.ts';

export function chatPage(): string {
    const page = new URL('../assets/chat.html', import.meta.url);
    if (!existsSync(page)) {
        throw new CliError('the packaged test chat page is missing', EXIT.failed, 'reinstall zen');
    }
    return fileURLToPath(page);
}

/** The fragment never reaches the server; HTTP links retain it when opened by macOS. */
export function chatUrl(on: { host: string; port: number }, token: string): string {
    chatPage();
    const host = on.host.includes(':') ? `[${on.host}]` : on.host;
    const page = new URL(`http://${host}:${on.port}/chat`);
    page.hash = new URLSearchParams({
        jwt: token,
        server: `http://${host}:${on.port}`,
        open: '1',
    }).toString();
    return page.href;
}
