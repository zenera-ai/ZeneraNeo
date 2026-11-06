// Where a chat's session, run logs and memory live, and the engine opened on one for a turn.
// The chat code (runs.ts, history.ts, trace.ts, memory.ts) is the same for every kind of chat; a
// ChatStore says where a thread's things are and who it belongs to.
//   privateStore - the user's chats, as `zen run` keeps sessions:
//     <sessions>/<thread id>/             - one zen session per chat thread: .data/ (state),
//                                           runs/ (the engine's records), workspace/ (unless the
//                                           server has one workspace), agui/ (its runs' AG-UI
//                                           events, runLog.ts — never in the sandbox's view)
//     memory                              - the project's own graph, or the server's `memoryDir`
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
import { memoryDir as projectMemoryDir, readProjectConfig } from '@zenera/neo';
import type { Request } from 'express';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { BwrapSandbox, type SandboxFactory } from '@zenera/sandbox';
import { settings, type ServerSettings } from './config.ts';
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

const sessionDir = (t: ChatThread) => join(settings().sessionsDir, t.id);

/** The graph the runs remember into: the server's, else the project's own, as `zen run`. */
export function memoryDir(): string | undefined {
    const s = settings();
    if (s.memoryDir) return s.memoryDir;
    try {
        const { root, config } = readProjectConfig(s.projectDir);
        return projectMemoryDir(root, config);
    } catch {
        return undefined;
    }
}

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
        return (
            this.existingSession(t) ??
            createSessionAt(dir, settings().workspace ?? join(dir, 'workspace'))
        );
    },
    runsDir: (t) => join(sessionDir(t), 'agui'),
    memoryDir: () => memoryDir(),
    // Unset is the project's own: what `zen run` does with no --memory.
    engineMemoryDir: () => settings().memoryDir,
    async removeThread(t) {
        await rm(sessionDir(t), { recursive: true, force: true });
    },
    get maxOwnerRuns() {
        return settings().maxRuns;
    },
    ownerBusy: 'your other chats are still answering',
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

/** The factory a run's engine opens its sandbox with. */
function sandboxFactory(s: ServerSettings): SandboxFactory {
    if (s.sandbox !== 'bwrap') return s.sandbox as SandboxFactory;
    // Other chats, the graph (the server's to read and write, through its tools) and the zen
    // home (its keyring) are not the command's; its own workspace and home are bound back in.
    const memory = memoryDir();
    const hidden = [s.sessionsDir, ...(memory ? [memory] : []), home(), ...s.hidden];
    return (opts) => new BwrapSandbox(opts, { hidden });
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
