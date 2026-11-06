// The agent server: one project's chats over HTTP, for one user (the agent image) or for every
// user of a project (a shared project pod). zenera-app calls it with a token per request; a host
// without zenera-app with a fixed token.
//   GET  /healthz                         - open, for probes
//   GET  /api/status                      - versions, sandbox, image identity, state layout
//   GET  /api/activity                    - whether a run is going (idle stop asks this)
//   /api/sessions/:tid...                 - history, runs (start, follow, replay, cancel), delete
//   /api/sessions/:tid/{runs,trace,memory}... with `debug` - the Test tab's views of a chat
//   createServer  - the app, configured; `listen` starts it, `stop` ends runs and closes it
import express, { type Express } from 'express';
import type { Server } from 'node:http';
import { requireCaller } from './auth.ts';
import { configure, DEFAULTS, type ServerSettings } from './config.ts';
import { historyRouter } from './history.ts';
import { errorHandler, notFound } from './http.ts';
import { memoryRouter } from './memory.ts';
import { acceptRuns, activeRuns, runDebugRouter, runsRouter, stopAllRuns } from './runs.ts';
import { openState } from './state.ts';
import { serverStatus } from './status.ts';
import { privateStore } from './store.ts';
import { traceRouter } from './trace.ts';

export type ServerOptions = Partial<ServerSettings> & Pick<ServerSettings, 'projectId' | 'auth'>;

export interface AgentServer {
    app: Express;
    settings: ServerSettings;
    listen(port: number, host?: string): Promise<Server>;
    /** ends every run as interrupted (they save their sessions), then closes the listener */
    stop(graceMs?: number): Promise<void>;
}

export function createServer(opts: ServerOptions): AgentServer {
    const settings: ServerSettings = { ...DEFAULTS, ...opts };
    configure(settings);
    openState(settings.stateDir, settings);
    acceptRuns();

    const app = express();
    app.disable('x-powered-by');
    app.use(requireCaller('zenera-runtime'));
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
        listen: (port, host = '0.0.0.0') =>
            new Promise((resolve, reject) => {
                // Express 5 hands a listen error (EADDRINUSE) to this callback instead of throwing it.
                const s = app.listen(port, host, (err?: Error) => {
                    if (err) reject(err);
                    else resolve(s);
                });
                server = s;
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
        },
    };
}
