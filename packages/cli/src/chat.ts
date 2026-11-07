import { existsSync } from 'node:fs';
import { CliError, EXIT } from './term.ts';

/** The packaged, self-contained page; its fragment never reaches an HTTP server. */
export function chatUrl(on: { host: string; port: number }, token: string): string {
    const page = new URL('../assets/chat.html', import.meta.url);
    if (!existsSync(page)) {
        throw new CliError('the packaged test chat page is missing', EXIT.failed, 'reinstall zen');
    }
    const host = on.host.includes(':') ? `[${on.host}]` : on.host;
    page.hash = new URLSearchParams({ server: `http://${host}:${on.port}`, jwt: token }).toString();
    return page.href;
}
