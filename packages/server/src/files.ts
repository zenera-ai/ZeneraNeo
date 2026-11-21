// The file links in a chat, served by zen server (@zenera/server). An agent's answer names files
// the way its sandbox sees them (`file:///workspace/chart.png`, `/assets/logo.svg`); the chat
// turns each into GET /api/sessions/:tid/files?path=<that name> and shows the answer as an image
// or a link. The caller is already checked to own the thread (store.thread); finding and sending
// the file safely is @zenera/engine files.ts.
//
// What a request gets:
//   - most files: the file (a download for anything that could run: html, svg, js)
//   - an html page on an `insecure` server: a 303 to its view URL /v/<token>/... (views.ts), so
//     the files the page loads by relative path are found too
//   - `view=1` (a host such as zenera-app serving /v/ itself): the file shown inline, sandboxed
//
// Main functions:
//   filesRouter  - the GET|HEAD /:tid/files route
//   projectTrees - where a session's files may come from: its workspace and the project's assets
//   asHttp       - an AgentFileError as the HttpError it means (404, 403, 400)
// Used by: server.ts (mounted under /api/sessions); views.ts uses projectTrees and asHttp.
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
