// The server root's own description: which layout it is in and which project it serves, so a
// server never reads (or writes over) a root it does not understand. Written on first start.
//   LAYOUT_VERSION   - the layout this server writes
//   openLayout       - create or check <root>/server.json
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 1: users/<user>/{sessions/<thread>/, memory/}. */
export const LAYOUT_VERSION = 1;

export interface Layout {
    version: number;
    projectId: string;
    createdAt: string;
}

export class LayoutError extends Error {
    override name = 'LayoutError';
}

/** `create: false` only reads (a check must not claim a directory): missing is `undefined`. */
export function openLayout(
    root: string,
    projectId: string,
    opts: { create?: boolean } = {},
): Layout | undefined {
    const file = join(root, 'server.json');
    if (!existsSync(file)) {
        if (opts.create === false) return undefined;
        // Every user's chats: nobody else on the machine reads them.
        mkdirSync(root, { recursive: true, mode: 0o700 });
        const layout: Layout = {
            version: LAYOUT_VERSION,
            projectId,
            createdAt: new Date().toISOString(),
        };
        writeFileSync(`${file}.tmp`, `${JSON.stringify(layout, null, 2)}\n`);
        renameSync(`${file}.tmp`, file);
        return layout;
    }
    let layout: Layout;
    try {
        layout = JSON.parse(readFileSync(file, 'utf8')) as Layout;
    } catch (err) {
        throw new LayoutError(
            `${file} is not readable: ${err instanceof Error ? err.message : err}`,
        );
    }
    if (!Number.isInteger(layout.version) || layout.version < 1) {
        throw new LayoutError(`${file} names no layout version`);
    }
    if (layout.version > LAYOUT_VERSION) {
        throw new LayoutError(
            `${root} is in layout ${layout.version}, written by a newer server; this one knows ${LAYOUT_VERSION}`,
        );
    }
    if (layout.projectId !== projectId) {
        throw new LayoutError(`${root} belongs to project ${layout.projectId}, not ${projectId}`);
    }
    return layout;
}
