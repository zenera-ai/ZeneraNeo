// The server's bearer token, when its host gave none: one per project and user, in the zen home
// (which no sandboxed command can see), readable by its owner only.
//   tokenFile    - <zen home>/servers/<project>/<user>.token
//   serverToken  - $ZEN_SERVER_TOKEN, else the file, else a new one written there (`create`)
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { home } from '@zenera/engine';
import { dirname, join } from 'node:path';

export const TOKEN_ENV = 'ZEN_SERVER_TOKEN';
export const MIN_TOKEN_LENGTH = 32;

export interface ServerToken {
    token: string;
    /** where it came from: the environment, or the file */
    from: 'env' | string;
}

/** Where a project's server for a user keeps its token. Both are single path segments here. */
export function tokenFile(project: string, user: string): string {
    const segment = (s: string) => s.replace(/[^\w.@-]/g, '_');
    return join(home(), 'servers', segment(project), `${segment(user)}.token`);
}

export function serverToken(
    file: string,
    opts: { create?: boolean; env?: NodeJS.ProcessEnv } = {},
): ServerToken | undefined {
    const given = (opts.env ?? process.env)[TOKEN_ENV]?.trim();
    if (given) return { token: given, from: 'env' };
    if (existsSync(file)) return { token: readFileSync(file, 'utf8').trim(), from: file };
    if (!opts.create) return undefined;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const token = randomBytes(32).toString('base64url');
    writeFileSync(file, `${token}\n`, { mode: 0o600, flag: 'wx' });
    chmodSync(file, 0o600);
    return { token, from: file };
}
