// The agent server: one user's chats with one project, over HTTP. Every request but /healthz
// carries the one bearer token its host gave it; the token names nobody — who the server is
// for is the host's to say, and who may use it is decided in front of it (zenera-app, a proxy).
// A sandboxed command shares the container's network but not the server's environment or
// state, so it can reach the port and is still refused.
//   GET  /healthz                         - for probes
//   GET  /api/status                      - versions, sandbox, image identity, state layout
//   GET  /api/activity                    - whether a run is going (idle stop asks this)
//   /api/sessions/:tid...                 - history, runs (start, follow, replay, cancel), delete
//   /api/sessions/:tid/{runs,trace,memory}... with `debug` - the Test tab's views of a chat
//   createServer  - the app, configured; `listen` starts it, `stop` ends runs and closes it
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Server } from 'node:http';
import { configure, DEFAULTS, type ServerSettings } from './config.ts';
import { historyRouter } from './history.ts';
import { errorHandler, notFound } from './http.ts';
import { checkUser } from './identity.ts';
import { memoryRouter } from './memory.ts';
import { acceptRuns, activeRuns, runDebugRouter, runsRouter, stopAllRuns } from './runs.ts';
import { openState } from './state.ts';
import { owner, serverStatus, setListening } from './status.ts';
import { privateStore } from './store.ts';
import { MIN_TOKEN_LENGTH } from './token.ts';
import { traceRouter } from './trace.ts';

export type ServerOptions = Partial<ServerSettings> &
    Pick<ServerSettings, 'projectId' | 'user' | 'token'>;

/** TCP; loopback unless a host is named. */
export interface ListenOn {
    port: number;
    host?: string;
}

export interface AgentServer {
    app: Express;
    settings: ServerSettings;
    listen(on: ListenOn): Promise<Server>;
    /** stops taking runs, ends the running ones as interrupted (they save), closes the listener */
    stop(graceMs?: number): Promise<void>;
}

export function createServer(opts: ServerOptions): AgentServer {
    const settings: ServerSettings = { ...DEFAULTS, ...opts, hidden: [...(opts.hidden ?? [])] };
    checkUser(settings.user);
    if ((settings.token ?? '').length < MIN_TOKEN_LENGTH) {
        throw new Error(`the server token must be at least ${MIN_TOKEN_LENGTH} characters`);
    }
    configure(settings);
    openState(settings.stateDir, owner(settings));
    acceptRuns();

    const app = express();
    app.disable('x-powered-by');
    app.use(requireToken(settings.token));
    app.use(express.json({ limit: '1mb' }));
    app.get('/healthz', (_req, res) => {
        res.type('text/plain').send('ok');
    });
    app.get('/api/status', async (_req, res) => {
        res.json(await serverStatus());
    });
    app.get('/api/activity', (_req, res) => {
        res.json({ busy: activeRuns() > 0, runs: activeRuns() });
    });
    app.use('/api/sessions', runsRouter(privateStore));
    app.use('/api/sessions', historyRouter(privateStore));
    if (settings.debug) {
        app.use('/api/sessions', runDebugRouter(privateStore));
        app.use('/api/sessions', traceRouter(privateStore));
        app.use('/api/sessions', memoryRouter(privateStore));
    }
    app.use(notFound);
    app.use(errorHandler);

    let server: Server | undefined;
    return {
        app,
        settings,
        listen: ({ port, host = '127.0.0.1' }) =>
            new Promise((resolve, reject) => {
                setListening(`${host}:${port}`);
                // Express 5 hands a listen error (EADDRINUSE) to this callback instead of throwing it.
                server = app.listen(port, host, (err?: Error) =>
                    err ? reject(err) : resolve(server!),
                );
            }),
        stop: async (graceMs = 20_000) => {
            // No new connections, and no new runs on the ones still open, before the drain.
            const closed = new Promise<void>((resolve) =>
                server ? server.close(() => resolve()) : resolve(),
            );
            await stopAllRuns(graceMs);
            // Followers of runs that have ended, idle keep-alives: nothing left to answer.
            server?.closeAllConnections();
            await closed;
            setListening(undefined);
        },
    };
}

/** Every route but /healthz: `Authorization: Bearer <token>`, compared in constant time. */
function requireToken(token: string) {
    const expected = digest(token);
    return (req: Request, res: Response, next: NextFunction) => {
        if (req.path === '/healthz') return next();
        const given = /^Bearer (.+)$/.exec(req.get('authorization') ?? '')?.[1] ?? '';
        if (!timingSafeEqual(digest(given), expected)) {
            res.status(401).json({ error: 'this server wants its token' });
            return;
        }
        next();
    };
}

function digest(text: string): Buffer {
    return createHash('sha256').update(text).digest();
}
