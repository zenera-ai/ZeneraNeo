// The server's settings: what `createServer` was given, read by every route at call time.
// One server per process — the agent image's — so they are module state rather than
// threaded through every router; `configure` replaces them whole.
import type { ZenPlugin } from '@zenera/engine';
import { bwrapSandbox, type SandboxFactory } from '@zenera/sandbox';

export type ServerAuth =
    /** zenera-app: an EdDSA token signed for each request (auth.ts) */
    | { mode: 'jwt'; publicKey: string }
    /** a fixed bearer token: ZeneraSrv, a laptop */
    | { mode: 'token'; token: string };

export interface ServerSettings {
    /** the project the agents come from; read-only to the server */
    projectDir: string;
    projectId: string;
    /** everything the server writes: the chats, their runs, the memory */
    stateDir: string;
    /**
     * The one user this server is for: `stateDir/data/` is theirs, and a token
     * for anyone else is refused. Unset, any user a token names, each under
     * `stateDir/users/<id>/` — a project pod shared by its users.
     */
    userId?: string;
    auth: ServerAuth;
    /** the Test tab's routes: recorded runs, traces, the memory graph */
    debug: boolean;
    /**
     * Where commands run: bwrap in the agent image; `'podman'` is the engine's own default,
     * as `zen run` has it (a project pod that still runs its sandboxes in podman).
     */
    sandbox: SandboxFactory | 'podman';
    /** what to call it, for `/api/status` and the engine's messages */
    sandboxProvider: string;
    /** this run's own plugins (the MCP tools for its user), given the token zenera-app sent */
    plugins: (run: { mcpToken: string | null }) => Promise<ZenPlugin[]>;
    maxRuns: number;
    maxUserRuns: number;
    maxRunMinutes: number;
    runLogMaxBytes: number;
}

export const DEFAULTS: Omit<ServerSettings, 'projectId' | 'auth'> = {
    projectDir: '/project',
    stateDir: '/state',
    debug: false,
    sandbox: bwrapSandbox,
    sandboxProvider: 'bwrap (this container)',
    plugins: async () => [],
    maxRuns: 4,
    maxUserRuns: 2,
    maxRunMinutes: 120,
    runLogMaxBytes: 50 * 1024 * 1024,
};

let current: ServerSettings | undefined;

export function configure(settings: ServerSettings): void {
    current = settings;
}

export function settings(): ServerSettings {
    if (!current) {
        throw new Error('the server is not configured: call createServer() first');
    }
    return current;
}
