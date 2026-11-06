// The server's bearer token, when its host gave none: one per state directory, kept beside the
// state it guards (which no sandboxed command can see), readable by its owner only.
//   TOKEN_FILE   - <state>/server.token
//   serverToken  - $ZEN_SERVER_TOKEN, else the file, else a new one written there (`create`)
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const TOKEN_FILE = 'server.token';
export const TOKEN_ENV = 'ZEN_SERVER_TOKEN';
export const MIN_TOKEN_LENGTH = 32;

export interface ServerToken {
    token: string;
    /** where it came from: the environment, or the file */
    from: 'env' | string;
}

export function serverToken(
    stateDir: string,
    opts: { create?: boolean; env?: NodeJS.ProcessEnv } = {},
): ServerToken | undefined {
    const given = (opts.env ?? process.env)[TOKEN_ENV]?.trim();
    if (given) return { token: given, from: 'env' };
    const file = join(stateDir, TOKEN_FILE);
    if (existsSync(file)) return { token: readFileSync(file, 'utf8').trim(), from: file };
    if (!opts.create) return undefined;
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const token = randomBytes(32).toString('base64url');
    writeFileSync(file, `${token}\n`, { mode: 0o600, flag: 'wx' });
    chmodSync(file, 0o600);
    return { token, from: file };
}
