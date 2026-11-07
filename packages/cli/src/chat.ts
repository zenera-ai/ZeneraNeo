/**
 * Packaged standalone-chat URL helper, used by the server CLI after insecure startup.
 * chatUrl locates assets/chat.html and puts the runtime address and dev JWT in its
 * fragment, handling IPv6 addresses and reporting a missing packaged page explicitly.
 * A trailing open parameter keeps terminals from trimming the unsigned JWT's final dot.
 */
import { existsSync } from 'node:fs';
import { CliError, EXIT } from './term.ts';

/** The packaged, self-contained page; its fragment never reaches an HTTP server. */
export function chatUrl(on: { host: string; port: number }, token: string): string {
    const page = new URL('../assets/chat.html', import.meta.url);
    if (!existsSync(page)) {
        throw new CliError('the packaged test chat page is missing', EXIT.failed, 'reinstall zen');
    }
    const host = on.host.includes(':') ? `[${on.host}]` : on.host;
    page.hash = new URLSearchParams({
        jwt: token,
        server: `http://${host}:${on.port}`,
        open: '1',
    }).toString();
    return page.href;
}
