// Where a chat's session, run logs and memory live, and the engine opened on one for a turn.
// The chat code (runs.ts, history.ts, trace.ts, memory.ts) is the same for every kind of chat; a
// ChatStore says where a thread's things are and who it belongs to.
//   privateStore - each user's chats, under that user's own folder:
//     <root>/users/<user>/sessions/<thread id>/  - one zen session per chat thread, as `zen run`
//                                                  keeps one: .data/ (state), runs/ (the engine's
//                                                  records), workspace/, and agui/ (its runs'
//                                                  AG-UI events, runLog.ts — never in the
//                                                  sandbox's view)
//     <root>/users/<user>/memory/                - the user's graph: a copy of the seed, made the
//                                                  first time a run of theirs remembers, shared by
//                                                  all their sessions and nobody else's
//     A thread id is only ever looked up under its caller's own folder, so another user's
//     thread is simply not there.
//   userMemory                  - the user's graph, copied from the seed first if it has to be
//   ChatStore, ChatThread       - the contract (a host may serve other chats with it: the Test tab)
//   usesMemory                  - whether any agent remembers, so the memory explorer has a graph
//   openEngineFor               - the project wired to a session, memory and the user the run acts
//                                 for, its env file applied
//   errorMessage, asHttpError   - what an EngineError says, and means to an HTTP caller
import {
    createSessionAt,
    home,
    EngineError,
    EXIT,
    openEngine,
    sessionPathsAt,
    type Engine,
    type RunIdentity,
    type SandboxSetup,
    type SessionPaths,
} from '@zenera/engine';
import {
    copyMemory,
    isMemory,
    LEGACY_GRAPH_FILE,
    memoryDir as projectMemoryDir,
    readProjectConfig,
} from '@zenera/neo';
import type { Request } from 'express';
import { existsSync } from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BwrapSandbox, type SandboxFactory } from '@zenera/sandbox';
import { settings, type ServerSettings } from './config.ts';
import { HttpError } from './http.ts';
import { identify, type Identity } from './identity.ts';
import { applyProjectEnv } from './projectEnv.ts';
import { userStates } from './userState.ts';

export interface ChatThread {
    id: string;
    /** who the thread's runs count against: a user, or the project for shared chats */
    owner: string;
}

export interface ChatStore {
    /** The thread a request names, checked to be the caller's; throws an HttpError otherwise. */
    thread(req: Request): ChatThread;
    existingSession(t: ChatThread): SessionPaths | null;
    /** The session, created on the thread's first turn. */
    sessionFor(t: ChatThread): SessionPaths;
    /** The thread's run logs and run records. */
    runsDir(t: ChatThread): string;
    /** The graph the memory explorer reads; undefined when the project declares none. */
    memoryDir(t: ChatThread): string | undefined;
    /** The graph a run remembers into, ready; undefined lets the engine use the project's. */
    engineMemoryDir(t: ChatThread): Promise<string | undefined>;
    removeThread(t: ChatThread): Promise<void>;
    /**
     * How many runs one owner may have going at once. Memory does not lower it: the graph is a
     * SQLite database that several runs remember into at the same time.
     */
    maxOwnerRuns: number;
    /** Why a run is refused when the owner has that many going. */
    ownerBusy: string;
    /** Before a run takes its slot: throw an HttpError to refuse it (e.g. storage over quota). */
    admit?(t: ChatThread): Promise<void>;
    /** After a run ended or the thread was deleted: the owner's data changed. */
    changed?(t: ChatThread, reason: 'run-end' | 'changed'): void;
}

/** Where one user's things are. */
export function userDir(user: string): string {
    return join(settings().root, 'users', user);
}

const sessionDir = (t: ChatThread) => join(userDir(t.owner), 'sessions', t.id);

/** The user's graph, whether or not it has been made yet. */
export function memoryDir(user: string): string {
    return join(userDir(user), 'memory');
}

/** What a user's memory starts as: the server's seed, else the project's own graph. */
export function memorySeed(): string | undefined {
    const s = settings();
    if (s.memorySeed === null) return undefined;
    if (s.memorySeed) return s.memorySeed;
    try {
        const { root, config } = readProjectConfig(s.projectDir);
        return projectMemoryDir(root, config);
    } catch {
        return undefined;
    }
}

const copying = new Map<string, Promise<string>>();

/**
 * The user's graph, made first from the seed when they have none: a consistent copy of it
 * (`copyMemory`, the seed opened read-only) into a directory of its own, renamed into place, so
 * a crash never leaves half a graph and two first runs at once make one. No seed, or one not made
 * yet: the user starts with nothing, and their first run makes their graph.
 */
export function userMemory(user: string): Promise<string> {
    const dir = memoryDir(user);
    const pending = copying.get(dir);
    if (pending) return pending;
    const made = (async () => {
        if (existsSync(dir)) return dir;
        const seed = memorySeed();
        if (seed && !isMemory(seed) && existsSync(join(seed, LEGACY_GRAPH_FILE))) {
            throw new EngineError(
                `the memory seed ${seed} holds a version 1 memory`,
                EXIT.invalid,
                `convert it first: zen memory migrate --dir ${seed}`,
            );
        }
        if (!seed || !isMemory(seed)) return dir;
        const tmp = `${dir}.copy-${process.pid}-${Date.now()}`;
        try {
            await copyMemory(seed, tmp);
            await writeFile(
                join(tmp, SEED_FILE),
                `${JSON.stringify({ seed, copiedAt: new Date().toISOString() }, null, 2)}\n`,
            );
            await rename(tmp, dir);
        } finally {
            await rm(tmp, { recursive: true, force: true });
        }
        return dir;
    })().finally(() => copying.delete(dir));
    copying.set(dir, made);
    return made;
}

/** Beside a user's graph: which seed it was copied from, and when. */
export const SEED_FILE = 'seed.json';

export const privateStore: ChatStore = {
    thread(req) {
        const id: Identity = identify(req);
        return { id: id.threadId, owner: id.userId };
    },
    existingSession(t) {
        const p = sessionPathsAt(sessionDir(t));
        return existsSync(p.meta) ? p : null;
    },
    sessionFor(t) {
        const dir = sessionDir(t);
        return this.existingSession(t) ?? createSessionAt(dir, join(dir, 'workspace'));
    },
    runsDir: (t) => join(sessionDir(t), 'agui'),
    memoryDir: (t) => memoryDir(t.owner),
    engineMemoryDir: (t) => userMemory(t.owner),
    async removeThread(t) {
        await rm(sessionDir(t), { recursive: true, force: true });
    },
    get maxOwnerRuns() {
        return settings().maxUserRuns;
    },
    ownerBusy: 'your other chats are still answering',
    admit: (t) => userStates.admit(t.owner),
    changed: (t, reason) => userStates.changed(t.owner, reason),
};

export function usesMemory(): boolean {
    try {
        return readProjectConfig(settings().projectDir).config.agents.some((a) =>
            Boolean(a.memory),
        );
    } catch (err) {
        throw new EngineError(err instanceof Error ? err.message : String(err), EXIT.invalid);
    }
}

// A turn must not start a build of its own: the image is built ahead (the editor, `zen image
// build`). Whichever sandbox the run gets, it says how its image is made ready.
export async function imageReady(setup: SandboxSetup): Promise<void> {
    try {
        await setup.sandbox.prepare({ allowBuild: false });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const notBuilt = /is not built/.test(message);
        throw new EngineError(
            notBuilt
                ? `the sandbox image ${setup.image} is not built`
                : `the sandbox image is not ready: ${message}`,
            EXIT.sandbox,
            notBuilt ? 'rebuild it from the project editor' : (err as { hint?: string }).hint,
        );
    }
}

/** Where the agent image installs zen and the server. */
const AGENT_APP_DIR = '/opt/zenera/app';

/** The factory a run's engine opens its sandbox with. */
function sandboxFactory(s: ServerSettings): SandboxFactory {
    if (s.sandbox !== 'bwrap') return s.sandbox as SandboxFactory;
    // Every user's chats and graphs, the seed (the server's to read and write, through its
    // tools), the zen home (its keyring), the project (its .env) and, in the agent image, the
    // server's own install are not the command's; its own workspace and home are bound back in.
    const seed = memorySeed();
    const hidden = [
        s.root,
        ...(seed ? [seed] : []),
        home(),
        s.projectDir,
        ...(existsSync(AGENT_APP_DIR) ? [AGENT_APP_DIR] : []),
        ...s.hidden,
    ];
    return (opts) => new BwrapSandbox(opts, { hidden, limits: s.commandLimits });
}

export async function openEngineFor(
    session: SessionPaths,
    memoryDir: string | undefined,
    // Who the run acts for; null is nobody, and stops the engine reading ZEN_USER_* from this process.
    user: RunIdentity | null,
    // The run's MCP broker token from zenera-app, if it gave one.
    mcpToken: string | null = null,
): Promise<Engine> {
    const s = settings();
    applyProjectEnv();
    const plugins = await s.plugins({ mcpToken });
    return openEngine({
        project: { dir: s.projectDir, name: s.projectId },
        session,
        memoryDir,
        user,
        quiet: true,
        yes: true,
        // Each turn's sandbox goes away; the sandbox HOME is in the session folder and stays.
        disposable: true,
        logger: { warn: (message) => console.warn(`[engine] ${message}`) },
        preflight: s.preflight ?? imageReady,
        // The sandbox is the server's to choose: a plugin in ZEN_PLUGINS does not get to replace it.
        sandboxPlugins: false,
        ...(s.sandbox === 'podman' ? {} : { newSandbox: sandboxFactory(s) }),
        ...(plugins.length ? { plugins } : {}),
    });
}

const STATUS: Record<number, number> = {
    [EXIT.usage]: 400,
    [EXIT.invalid]: 422,
    [EXIT.credentials]: 503,
    [EXIT.sandbox]: 503,
};

/** The HTTP status for a zen exit code or EngineError code. */
export function statusFor(code: number): number {
    return STATUS[code] ?? 500;
}

export function errorMessage(err: unknown): string {
    if (err instanceof EngineError) return err.hint ? `${err.message} (${err.hint})` : err.message;
    return err instanceof Error ? err.message : String(err);
}

export function asHttpError(err: unknown): unknown {
    if (!(err instanceof EngineError)) return err;
    return new HttpError(statusFor(err.code), errorMessage(err));
}
