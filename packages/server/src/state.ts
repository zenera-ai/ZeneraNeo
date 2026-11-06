// The state directory's own description: which layout it is in, so a server never reads (or
// writes over) a layout it does not know. Written on first start; a newer one is refused.
//   STATE_VERSION   - the layout this server writes
//   openState       - create or check <state>/state.json, answering what it says
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 1: data/{sessions,runs,memory}, one user's. */
export const STATE_VERSION = 1;

export interface StateInfo {
    version: number;
    createdAt: string;
    /** whose state it is */
    userId: string;
    projectId: string;
}

export class StateError extends Error {
    override name = 'StateError';
}

/**
 * The state directory's description, checked against who opens it: the same project and the
 * same user. `create: false` only reads (a check must not claim a directory): a missing file
 * is then `undefined`.
 */
export function openState(
    dir: string,
    owner: { userId: string; projectId: string },
    opts: { create?: boolean } = {},
): StateInfo | undefined {
    const file = join(dir, 'state.json');
    if (!existsSync(file)) {
        if (opts.create === false) return undefined;
        // The user's chats: nobody else on the machine reads them.
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const info: StateInfo = {
            version: STATE_VERSION,
            createdAt: new Date().toISOString(),
            userId: owner.userId,
            projectId: owner.projectId,
        };
        writeFileSync(`${file}.tmp`, `${JSON.stringify(info, null, 2)}\n`);
        renameSync(`${file}.tmp`, file);
        return info;
    }
    let info: StateInfo;
    try {
        info = JSON.parse(readFileSync(file, 'utf8')) as StateInfo;
    } catch (err) {
        throw new StateError(
            `${file} is not readable: ${err instanceof Error ? err.message : err}`,
        );
    }
    if (!Number.isInteger(info.version) || info.version < 1) {
        throw new StateError(`${file} names no layout version`);
    }
    if (info.version > STATE_VERSION) {
        throw new StateError(
            `${dir} is in layout ${info.version}, written by a newer server; this one knows ${STATE_VERSION}`,
        );
    }
    if (info.projectId !== owner.projectId) {
        throw new StateError(`${dir} belongs to project ${info.projectId}, not ${owner.projectId}`);
    }
    if (info.userId !== owner.userId) {
        throw new StateError(`${dir} belongs to user ${info.userId}, not ${owner.userId}`);
    }
    return info;
}
