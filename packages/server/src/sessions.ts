/**
 * Per-user session-list endpoint mounted by server.ts at GET /api/sessions.
 * sessionsRouter reads engine metadata under the authenticated JWT subject's folder,
 * honors thread-scoped claims, adds current run ids and whether the last run failed unseen
 * (runs.ts writes it, POST /:tid/seen clears it), and sorts by latest activity.
 * The standalone chat uses this list without opening engines or creating user memory.
 */
import { readSessionMeta, sessionPathsAt, type SessionMeta } from '@zenera/engine';
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
    /**
     * The last run failed and the user has not opened the chat since: the list's red mark.
     * `code` model_unavailable: POST /:tid/runs { retry: true } continues it.
     */
    failed: { at: string; code: string; message: string } | null;
}

/** The failure a chat list shows, if any: the last run's, unless the user has seen it. */
export function unseenFailure(meta: SessionMeta): SessionInfo['failed'] {
    const f = meta.lastFailure;
    if (!f || (meta.failureSeenAt && meta.failureSeenAt >= f.at)) return null;
    return { at: f.at, code: f.code, message: f.message };
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
            const running = currentRun({ id: entry.name, owner });
            sessions.push({
                id: entry.name,
                title: meta.title || entry.name,
                createdAt: meta.createdAt,
                updatedAt: meta.lastRunAt ?? meta.createdAt,
                running,
                failed: running ? null : unseenFailure(meta),
            });
        }
        sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
        res.json({ sessions });
    });
    return router;
}
