// A page a chat names, and the files it loads by relative path, for an `insecure` server's own
// chat page: GET /files?path=<x.html> answers 303 to /v/<token>/workspace/.../x.html, and the
// page's `../data/prices.json` resolves to /v/<token>/workspace/data/prices.json. The browser
// cannot sign what a sandboxed page asks for, so the token in the path is the credential
// (@zenera/engine viewTokens.ts): the user and the thread, for an hour. It reaches what the chat's
// own file links reach, the session's workspace and the project's assets, and nothing else.
// In `jwt` mode the host mints and serves /v/ itself and asks for files with `?view=1`.
//   viewUrl     - where a page of a thread is viewed
//   viewsRouter - GET|HEAD /v/:token/*path, mounted before requireCaller
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
