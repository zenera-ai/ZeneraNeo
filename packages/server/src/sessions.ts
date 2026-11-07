/**
 * Per-user session-list endpoint mounted by server.ts at GET /api/sessions.
 * sessionsRouter reads engine metadata under the authenticated JWT subject's folder,
 * honors thread-scoped claims, adds current run ids and sorts by latest activity.
 * The standalone chat uses this list without opening engines or creating user memory.
 */
import { readSessionMeta, sessionPathsAt } from '@zenera/engine';
import { Router } from 'express';
import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { caller, isThreadId, userFolder } from './identity.ts';
import { currentRun } from './runs.ts';
import { userDir } from './store.ts';

export interface SessionInfo {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    running: { runId: string } | null;
}

/** A user's real sessions, without opening engines or creating memory. */
export function sessionsRouter(): Router {
    const router = Router();
    router.get('/', async (req, res) => {
        const claims = caller(req);
        const owner = userFolder(claims.sub);
        const dir = join(userDir(owner), 'sessions');
        let entries: Dirent[];
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
            res.json({ sessions: [] });
            return;
        }
        const sessions: SessionInfo[] = [];
        for (const entry of entries) {
            if (!entry.isDirectory() || !isThreadId(entry.name)) continue;
            if (
                claims.thr !== undefined &&
                String(claims.thr).toLowerCase() !== entry.name.toLowerCase()
            )
                continue;
            const paths = sessionPathsAt(join(dir, entry.name));
            try {
                await stat(paths.meta);
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
                throw err;
            }
            const meta = await readSessionMeta(paths);
            sessions.push({
                id: entry.name,
                title: meta.title || entry.name,
                createdAt: meta.createdAt,
                updatedAt: meta.lastRunAt ?? meta.createdAt,
                running: currentRun({ id: entry.name, owner }),
            });
        }
        sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
        res.json({ sessions });
    });
    return router;
}
