// A chat's files, for the person to look at: the links and images an agent's answer names
// (`file:///workspace/chart.png`, `/assets/logo.svg`), sent from the session's workspace or the
// project's assets under the same containment the file tools have (@zenera/engine files.ts).
//   filesRouter(store) - GET|HEAD /:tid/files?path=<the agent's path or file: url>[&view=1]
// The caller is already the thread's owner (store.thread); a thread with no session yet has no
// files, and asking does not make one. An html page is sent as a download, except: an `insecure`
// server sends its own chat page on to /v/<token>/... (views.ts), where the page's relative
// links resolve; `view=1` (a host serving /v/ itself) sends any file for viewing.
//   projectTrees - a session's workspace and the server's project's assets
import {
    AgentFileError,
    agentFileStatus,
    contentTypeOf,
    fileTrees,
    resolveAgentFile,
    sendAgentFile,
    type FileTrees,
} from '@zenera/engine';
import { Router } from 'express';
import { settings } from './config.ts';
import { HttpError } from './http.ts';
import type { ChatStore } from './store.ts';
import { viewUrl } from './views.ts';

export function asHttp(err: unknown): unknown {
    if (!(err instanceof AgentFileError)) return err;
    return Object.assign(new HttpError(agentFileStatus(err.code), err.message), {
        code: err.code,
    });
}

let project: { dir: string; trees: Omit<FileTrees, 'workspace'> } | undefined;

/** Read once per project: the project does not change under a running server. */
export function projectTrees(workspace: string): FileTrees {
    const dir = settings().projectDir;
    if (project?.dir !== dir) project = { dir, trees: fileTrees(dir, workspace) };
    return { ...project.trees, workspace };
}

const isPage = (path: string) => contentTypeOf(path).startsWith('text/html');

/** `trees` says where a session's workspace's neighbours are; by default the server's project. */
export function filesRouter(
    store: ChatStore,
    trees: (workspace: string) => FileTrees = projectTrees,
): Router {
    const router = Router();

    router.get('/:tid/files', async (req, res) => {
        const t = store.thread(req);
        const path = req.query.path;
        if (typeof path !== 'string' || !path) throw new HttpError(400, 'name the file: ?path=');
        const session = store.existingSession(t);
        if (!session) throw new HttpError(404, `no such file: ${path.slice(0, 200)}`);
        const view = req.query.view === '1';
        try {
            const file = resolveAgentFile(path, trees(session.workspace));
            if (!view && isPage(file.path) && settings().auth.mode === 'insecure') {
                res.set('Cache-Control', 'no-store');
                res.redirect(303, viewUrl(t, file.path));
                return;
            }
            await sendAgentFile(req, res, file, view ? { view: {} } : {});
        } catch (err) {
            throw asHttp(err);
        }
    });

    return router;
}
