// Html pages in a chat, with the files they load, served by zen server (@zenera/server) in
// `insecure` mode: `zen server start --insecure` and its /chat page.
//
// An agent's page (a dashboard, a report) loads other files by relative path, e.g.
// `<script src="data.js">` or `fetch('../data/prices.json')`. The browser cannot attach a login
// to those requests, so the page is opened at a URL with a token in its path:
//   /api/sessions/t1/files?path=/workspace/charts/dash.html  -> 303 (files.ts)
//   /v/<token>/workspace/charts/dash.html                    -> the page
//   /v/<token>/workspace/data/prices.json                    -> what it fetches
// The token (@zenera/engine viewTokens.ts) names the user (their folder, and id, email, name and
// role, which a page's calls act as) and the thread, and lasts an hour; it
// reaches what the chat's own file links reach and nothing more. Files go out in `view` mode:
// inline, sandboxed, readable by the page (engine viewCsp).
// A path that names no file but a function of an `*.api.py` beside it is a call:
//   POST /v/<token>/workspace/pages/todo/api/items/add_item  -> add_item() of api/items.api.py,
// run in the thread's sandbox (appCalls.ts). An `*.api.py` itself is never sent through /v/.
// In `jwt` mode there is no /v/ here: the host (ZeneraLite's zenera-app) serves it, checks the
// user, and asks for each path, file or call, with any method at
// /api/sessions/:tid/view/<path>, its own JWT the caller (sessionView).
//
// Main functions:
//   viewUrl     - the /v/<token>/... URL of a page in a thread (used by files.ts)
//   viewsRouter - any method on /v/:token/*path: files on GET|HEAD, calls on any (mounted by
//                 server.ts before the JWT check)
//   sessionView - any method on /api/sessions/:tid/view/*path for a host, as the token's caller
//                 (mounted by server.ts after the JWT check, before the JSON body parser)
import {
    mintViewToken,
    serveViewPath,
    verifyViewToken,
    viewKey,
    type FileTrees,
    type RunIdentity,
} from '@zenera/engine';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { join } from 'node:path';
import { appCalls } from './appCalls.ts';
import { settings } from './config.ts';
import { projectTrees } from './files.ts';
import { HttpError } from './http.ts';
import { identify, identityOf, runUser } from './identity.ts';
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

/**
 * `/v/<token>/<agent path>`, each segment encoded, for a resolved agent path (`/workspace/x`).
 * The token carries who opened it (`user`: id, email, name, role), so the page's calls act for
 * them as the chat's turns do.
 */
export function viewUrl(t: ChatThread, agentPath: string, user?: RunIdentity | null): string {
    const who: Record<string, string> = {};
    if (user) {
        who.uid = user.id;
        if (user.email) who.email = user.email;
        if (user.name) who.name = user.name;
        if (user.role) who.role = user.role;
    }
    const token = mintViewToken(key(), { sub: t.owner, tid: t.id, ...who });
    return `/v/${token}${agentPath.split('/').map(encodeURIComponent).join('/')}`;
}

/** A path of a thread's page, a file or a call, served for `user`. */
async function serveThreadPath(
    req: Request,
    res: Response,
    store: ChatStore,
    trees: (workspace: string) => FileTrees,
    t: ChatThread,
    user: RunIdentity,
    path: string,
): Promise<void> {
    const session = store.existingSession(t);
    if (!session) throw new HttpError(404, `no such file: ${path.slice(0, 200)}`);
    await serveViewPath(req, res, {
        path,
        trees: trees(session.workspace),
        calls: { calls: appCalls(), thread: { owner: t.owner, id: t.id, session }, user },
        frameAncestors: ["'self'"],
    });
}

const pathOf = (req: Request) => `/${(req.params.path as unknown as string[]).join('/')}`;

export function viewsRouter(
    store: ChatStore,
    trees: (workspace: string) => FileTrees = projectTrees,
): Router {
    const router = Router();
    router.all('/v/:token/*path', async (req, res) => {
        const claims = verifyViewToken(key(), req.params.token);
        if (!claims) {
            throw new HttpError(
                403,
                'this link is not valid or has expired: open it from the chat',
            );
        }
        const t: ChatThread = { id: claims.tid, owner: claims.sub };
        // Checked as a turn's caller is; a token from before uid was kept acts for its folder.
        const user = identityOf({
            ...claims,
            sub: typeof claims.uid === 'string' && claims.uid ? claims.uid : claims.sub,
        });
        await userStates.acquire(t.owner);
        await userStates.session(t.owner, t.id);
        await serveThreadPath(req, res, store, trees, t, user, pathOf(req));
    });
    return router;
}

/**
 * For a host (jwt mode): any method on /api/sessions/:tid/view/*path, a path of the caller's
 * thread, file or call, as its page asked for it. The caller's data is loaded first
 * (userState.ts loadCaller and loadThread, mounted in front of it).
 */
export function sessionView(
    store: ChatStore,
    trees: (workspace: string) => FileTrees = projectTrees,
): RequestHandler {
    return async (req, res) => {
        const id = identify(req);
        const t: ChatThread = { id: id.threadId, owner: id.userId };
        const user = runUser(req);
        if (!user) throw new HttpError(401, 'no verified caller');
        await serveThreadPath(req, res, store, trees, t, user, pathOf(req));
    };
}
