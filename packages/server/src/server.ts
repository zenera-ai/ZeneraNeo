// The agent server: one user's chats with one project, over HTTP. It does no authentication: it
// serves its user to whoever can reach it, and reaching it is its host's to control. By default
// it listens on a Unix socket in a directory no sandboxed command can see; on TCP only when asked.
// In ZeneraLite a guard in front of it checks zenera-app's tokens; on a laptop, the socket's
// file permissions are the guard.
//   GET  /healthz                         - for probes
//   GET  /api/status                      - versions, sandbox, image identity, state layout
//   GET  /api/activity                    - whether a run is going (idle stop asks this)
//   /api/sessions/:tid...                 - history, runs (start, follow, replay, cancel), delete
//   /api/sessions/:tid/{runs,trace,memory}... with `debug` - the Test tab's views of a chat
//   createServer  - the app, configured; `listen` starts it, `stop` ends runs and closes it
import express, { type Express } from 'express';
import { chmodSync, mkdirSync, rmSync, statSync } from 'node:fs';
import type { Server } from 'node:http';
import { dirname } from 'node:path';
import { configure, DEFAULTS, type ServerSettings } from './config.ts';
import { historyRouter } from './history.ts';
import { errorHandler, notFound } from './http.ts';
import { checkUser } from './identity.ts';
import { memoryRouter } from './memory.ts';
import { acceptRuns, activeRuns, runDebugRouter, runsRouter, stopAllRuns } from './runs.ts';
import { openState } from './state.ts';
import { owner, serverStatus, setListening } from './status.ts';
import { privateStore } from './store.ts';
import { traceRouter } from './trace.ts';

export type ServerOptions = Partial<ServerSettings> & Pick<ServerSettings, 'projectId' | 'user'>;

/** `{ socket }`: a Unix socket, owner-only; `{ port, host }`: TCP, loopback unless named. */
export type ListenOn = { socket: string } | { port: number; host?: string };

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
    configure(settings);
    openState(settings.stateDir, owner(settings));
    acceptRuns();

    const app = express();
    app.disable('x-powered-by');
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
    let socket: string | undefined;
    return {
        app,
        settings,
        listen: (on) =>
            new Promise((resolve, reject) => {
                // Express 5 hands a listen error (EADDRINUSE) to this callback instead of throwing it.
                const ready = (err?: Error) => {
                    if (err) return reject(err);
                    // The directory is the owner's alone already; the socket says so too.
                    if (socket) chmodSync(socket, 0o600);
                    resolve(server!);
                };
                if ('socket' in on) {
                    socket = on.socket;
                    // Its directory is kept from every command, so no agent can call its own server.
                    settings.hidden.push(dirname(socket));
                    mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
                    removeStaleSocket(socket);
                    setListening(`unix:${socket}`);
                    server = app.listen(socket, ready);
                } else {
                    const host = on.host ?? '127.0.0.1';
                    setListening(`tcp:${host}:${on.port}`);
                    server = app.listen(on.port, host, ready);
                }
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
            if (socket) rmSync(socket, { force: true });
            setListening(undefined);
        },
    };
}

/** A socket a previous process left behind; anything else at that path is not ours to remove. */
function removeStaleSocket(path: string): void {
    try {
        if (statSync(path).isSocket()) rmSync(path);
    } catch {
        // nothing there
    }
}
