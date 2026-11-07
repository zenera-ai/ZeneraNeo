// The agent server: a project's chats over HTTP, for every user its host vouches for. Every request
// but /healthz carries a JWT the host signed for that request (auth.ts), whose `sub` is the user;
// each user's things are in a folder of their own (store.ts). A sandboxed command shares the
// container's network, so it can reach the port, and is refused: it can make no token.
//   GET  /healthz                         - for probes
//   GET  /api/status                      - versions, auth, sandbox, image identity, root, seed
//   GET  /api/activity                    - whether a run is going (idle stop asks this)
//   /api/sessions/:tid...                 - history, runs (start, follow, replay, cancel), delete
//   /api/sessions/:tid/{runs,trace,memory}... with `debug` - the Test tab's views of a chat
//   createServer  - the app, configured; `listen` starts it, `stop` ends runs and closes it
import express, { type Express } from 'express';
import type { Server } from 'node:http';
import { configure, DEFAULTS, type ServerSettings } from './config.ts';
import { historyRouter } from './history.ts';
import { errorHandler, notFound } from './http.ts';
import { requireCaller } from './auth.ts';
import { inAgentImage } from './config.ts';
import { openLayout } from './layout.ts';
import { memoryRouter } from './memory.ts';
import { acceptRuns, activeRuns, runDebugRouter, runsRouter, stopAllRuns } from './runs.ts';
import { serverStatus, setListening } from './status.ts';
import { privateStore } from './store.ts';
import { traceRouter } from './trace.ts';

export type ServerOptions = Partial<ServerSettings> &
    Pick<ServerSettings, 'projectId' | 'auth' | 'root'>;

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
    if (settings.auth.mode === 'jwt' && !settings.auth.publicKey.trim()) {
        throw new Error('a jwt server needs the public key its tokens are signed for');
    }
    configure(settings);
    openLayout(settings.root, settings.projectId);
    acceptRuns();

    const app = express();
    app.disable('x-powered-by');
    app.use(requireCaller());
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
                if (settings.auth.mode === 'insecure' && !LOOPBACK.has(host) && !insecureHere()) {
                    reject(new Error(`an insecure server listens on loopback only, not ${host}`));
                    return;
                }
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

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/** The env `zen server start --container` sets on the container it runs, port on loopback. */
export const INSECURE_LOCAL_ENV = 'ZEN_SERVER_INSECURE_LOCAL';

/**
 * Inside the agent image an insecure server listens on 0.0.0.0 for the port to be published; only
 * the host that runs it on this machine, its port on loopback, says that is all right.
 */
export function insecureHere(env: NodeJS.ProcessEnv = process.env): boolean {
    return inAgentImage() && env[INSECURE_LOCAL_ENV] === '1';
}
