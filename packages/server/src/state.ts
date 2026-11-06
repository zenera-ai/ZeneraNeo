// The state directory's own description: which layout it is in, so a server never reads (or
// writes over) a layout it does not know. Written on first start; a newer one is refused.
//   STATE_VERSION   - the layout this server writes
//   openState       - create or check <state>/state.json, answering what it says
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 1: data/{sessions,runs,memory} for one user, users/<id>/… for a shared pod. */
export const STATE_VERSION = 1;

export interface StateInfo {
    version: number;
    createdAt: string;
    /** single: one user's, in data/; shared: any user's, each in users/<id>/ */
    mode: 'single' | 'shared';
    /** whose state it is, when single */
    userId?: string;
    projectId: string;
}

export class StateError extends Error {
    override name = 'StateError';
}

/**
 * The state directory's description, checked against who opens it: the same project, the same
 * mode, and for a single-user one the same user. `create: false` only reads (a check must not
 * claim a directory): a missing file is then `undefined`.
 */
export function openState(
    dir: string,
    owner: { userId?: string; projectId: string },
    opts: { create?: boolean } = {},
): StateInfo | undefined {
    const file = join(dir, 'state.json');
    if (!existsSync(file)) {
        if (opts.create === false) return undefined;
        mkdirSync(dir, { recursive: true });
        const info: StateInfo = {
            version: STATE_VERSION,
            createdAt: new Date().toISOString(),
            mode: owner.userId ? 'single' : 'shared',
            projectId: owner.projectId,
            ...(owner.userId ? { userId: owner.userId } : {}),
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
    const mode = owner.userId ? 'single' : 'shared';
    if (info.mode !== mode) {
        throw new StateError(
            info.mode === 'single'
                ? `${dir} holds one user's state (${info.userId}); a server for any user cannot use it`
                : `${dir} holds the state of many users; a server for one user cannot use it`,
        );
    }
    if (mode === 'single' && info.userId !== owner.userId) {
        throw new StateError(`${dir} belongs to user ${info.userId}, not ${owner.userId}`);
    }
    return info;
}
