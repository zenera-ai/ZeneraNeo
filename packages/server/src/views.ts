// Html pages in a chat, with the files they load, served by zen server (@zenera/server) in
// `insecure` mode: `zen server start --insecure` and its /chat page.
//
// An agent's page (a dashboard, a report) loads other files by relative path, e.g.
// `<script src="data.js">` or `fetch('../data/prices.json')`. The browser cannot attach a login
// to those requests, so the page is opened at a URL with a token in its path:
//   /api/sessions/t1/files?path=/workspace/charts/dash.html  -> 303 (files.ts)
//   /v/<token>/workspace/charts/dash.html                    -> the page
//   /v/<token>/workspace/data/prices.json                    -> what it fetches
// The token (@zenera/engine viewTokens.ts) names the user and the thread and lasts an hour; it
// reaches what the chat's own file links reach and nothing more. Files go out in `view` mode:
// inline, sandboxed, readable by the page (engine viewCsp).
// In `jwt` mode there is no /v/ here: the host (ZeneraLite's zenera-app) serves it and asks for
// each file with `files?path=...&view=1`.
//
// Main functions:
//   viewUrl     - the /v/<token>/... URL of a page in a thread (used by files.ts)
//   viewsRouter - GET|HEAD /v/:token/*path (mounted by server.ts before the JWT check)
import {
    mintViewToken,
    resolveAgentFile,
    sendAgentFile,
    verifyViewToken,
    viewKey,
    type FileTrees,
} from '@zenera/engine';
import { Router } from 'express';
import { join } from 'node:path';
import { settings } from './config.ts';
import { asHttp, projectTrees } from './files.ts';
import { HttpError } from './http.ts';
import type { ChatStore, ChatThread } from './store.ts';
import { userStates } from './userState.ts';

/** Beside users/ in the server's root, which no sandbox sees. */
const KEY_FILE = 'view.key';

let cached: { file: string; key: Buffer } | undefined;

function key(): Buffer {
    const file = join(settings().root, KEY_FILE);
    if (cached?.file !== file) cached = { file, key: viewKey(file) };
    return cached.key;
}

/** `/v/<token>/<agent path>`, each segment encoded, for a resolved agent path (`/workspace/x`). */
export function viewUrl(t: ChatThread, agentPath: string): string {
    const token = mintViewToken(key(), { sub: t.owner, tid: t.id });
    return `/v/${token}${agentPath.split('/').map(encodeURIComponent).join('/')}`;
}

export function viewsRouter(
    store: ChatStore,
    trees: (workspace: string) => FileTrees = projectTrees,
): Router {
    const router = Router();
    router.get('/v/:token/*path', async (req, res) => {
        const claims = verifyViewToken(key(), req.params.token);
        if (!claims) {
            throw new HttpError(
                403,
                'this link is not valid or has expired: open it from the chat',
            );
        }
        const t: ChatThread = { id: claims.tid, owner: claims.sub };
        await userStates.acquire(t.owner);
        await userStates.session(t.owner, t.id);
        const session = store.existingSession(t);
        const path = `/${(req.params.path as unknown as string[]).join('/')}`;
        if (!session) throw new HttpError(404, `no such file: ${path.slice(0, 200)}`);
        try {
            const file = resolveAgentFile(path, trees(session.workspace));
            await sendAgentFile(req, res, file, { view: { frameAncestors: ["'self'"] } });
        } catch (err) {
            throw asHttp(err);
        }
    });
    return router;
}
