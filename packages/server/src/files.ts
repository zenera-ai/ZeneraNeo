// A chat's files, for the person to look at: the links and images an agent's answer names
// (`file:///workspace/chart.png`, `/assets/logo.svg`), sent from the session's workspace or the
// project's assets under the same containment the file tools have (@zenera/engine files.ts).
//   filesRouter(store) - GET|HEAD /:tid/files?path=<the agent's path or file: url>
// The caller is already the thread's owner (store.thread); a thread with no session yet has no
// files, and asking does not make one.
import {
    AgentFileError,
    agentFileStatus,
    fileTrees,
    resolveAgentFile,
    sendAgentFile,
    type FileTrees,
} from '@zenera/engine';
import { Router } from 'express';
import { settings } from './config.ts';
import { HttpError } from './http.ts';
import type { ChatStore } from './store.ts';

function asHttp(err: unknown): unknown {
    if (!(err instanceof AgentFileError)) return err;
    return Object.assign(new HttpError(agentFileStatus(err.code), err.message), {
        code: err.code,
    });
}

/**
 * `trees` says where a session's workspace's neighbours are; by default the server's project:
 * its workdir and assets, read once (the project does not change under a running server).
 */
export function filesRouter(store: ChatStore, trees?: (workspace: string) => FileTrees): Router {
    const router = Router();
    let project: Omit<FileTrees, 'workspace'> | undefined;
    const treesOf =
        trees ??
        ((workspace: string) => {
            project ??= fileTrees(settings().projectDir, workspace);
            return { ...project, workspace };
        });

    router.get('/:tid/files', async (req, res) => {
        const t = store.thread(req);
        const path = req.query.path;
        if (typeof path !== 'string' || !path) throw new HttpError(400, 'name the file: ?path=');
        const session = store.existingSession(t);
        if (!session) throw new HttpError(404, `no such file: ${path.slice(0, 200)}`);
        try {
            const file = resolveAgentFile(path, treesOf(session.workspace));
            await sendAgentFile(req, res, file);
        } catch (err) {
            throw asHttp(err);
        }
    });

    return router;
}
