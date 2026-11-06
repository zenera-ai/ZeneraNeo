// Where a chat's session, run logs and memory live, and the engine opened on one for a turn.
// The chat code (runs.ts, history.ts, trace.ts, memory.ts) is the same for every kind of chat; a
// ChatStore says where a thread's things are and who it belongs to.
//   privateStore - the users' own chats, under the server's state directory:
//     single user (settings.userId):   <state>/data/{sessions,runs}/<thread id>/, <state>/data/memory/
//     any user (a shared project pod): <state>/users/<user id>/{sessions,runs}/<thread id>/, .../memory/
//     A thread id is only ever looked up under its caller's own folder, so another user's thread
//     is simply not there. The runs folder is outside the session, which the sandbox sees part of.
//   ChatStore, ChatThread       - the contract (a host may serve other chats with it: the Test tab)
//   usesMemory                  - whether any agent remembers, so the memory explorer has a graph
//   openEngineFor               - the project wired to a session, memory and the user the run acts
//                                 for, its env file applied
//   errorMessage, asHttpError   - what an EngineError says, and means to an HTTP caller
import {
    createSessionAt,
    EngineError,
    EXIT,
    openEngine,
    sessionPathsAt,
    type Engine,
    type RunIdentity,
    type SandboxSetup,
    type SessionPaths,
} from '@zenera/engine';
import { readProjectConfig } from '@zenera/neo';
import type { Request } from 'express';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { settings } from './config.ts';
import { HttpError } from './http.ts';
import { identify, type Identity } from './identity.ts';
import { applyProjectEnv } from './projectEnv.ts';

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
    /** The graph a run remembers into; undefined lets the engine use the project's, as `zen run` does. */
    engineMemoryDir(t: ChatThread): string | undefined;
    removeThread(t: ChatThread): Promise<void>;
    /**
     * How many runs one owner may have going at once. Memory does not lower it: the graph is a
     * SQLite database that several runs remember into at the same time.
     */
    maxOwnerRuns: number;
    /** Why a run is refused when the owner has that many going. */
    ownerBusy: string;
}

/** Where one user's chats and memory are. */
export function userDir(userId: string): string {
    const s = settings();
    return s.userId ? join(s.stateDir, 'data') : join(s.stateDir, 'users', userId);
}

const privateSessionDir = (t: ChatThread) => join(userDir(t.owner), 'sessions', t.id);

export function userMemoryDir(userId: string): string {
    return join(userDir(userId), 'memory');
}

export const privateStore: ChatStore = {
    thread(req) {
        const id: Identity = identify(req);
        return { id: id.threadId, owner: id.userId };
    },
    existingSession(t) {
        const p = sessionPathsAt(privateSessionDir(t));
        return existsSync(p.meta) ? p : null;
    },
    sessionFor(t) {
        const dir = privateSessionDir(t);
        return this.existingSession(t) ?? createSessionAt(dir, join(dir, 'workspace'));
    },
    runsDir: (t) => join(userDir(t.owner), 'runs', t.id),
    memoryDir: (t) => userMemoryDir(t.owner),
    engineMemoryDir: (t) => userMemoryDir(t.owner),
    async removeThread(t) {
        await rm(privateSessionDir(t), { recursive: true, force: true });
        await rm(this.runsDir(t), { recursive: true, force: true });
    },
    get maxOwnerRuns() {
        return settings().maxUserRuns;
    },
    ownerBusy: 'your other chats in this project are still answering',
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
        preflight: imageReady,
        ...(s.sandbox === 'podman' ? {} : { newSandbox: s.sandbox, sandboxPlugins: false }),
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
