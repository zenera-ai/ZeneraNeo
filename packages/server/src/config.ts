// The server's settings: what `createServer` was given, read by every route at call time.
// One server per process — the agent image's — so they are module state rather than
// threaded through every router; `configure` replaces them whole.
//
// Who the server is for is its host's to say (`user`), never a request's. A request only proves
// it may reach the server at all, with the one bearer `token` the host gave it: a secret that
// names nobody. Logging people in, and deciding who may use which server, stays in front of it
// (zenera-app, a ZeneraSrv proxy), so that can change without the server.
import type { ZenPlugin } from '@zenera/engine';
import type { SandboxFactory } from '@zenera/sandbox';

/** Who the server is for: what the agent's `current_user` answers, and its commands see as ZEN_USER_*. */
export interface ServerUser {
    /** a path segment: letters, digits, `.`, `_`, `@`, `-` */
    id: string;
    email?: string;
    role?: 'owner' | 'editor' | 'viewer' | 'admin';
}

export interface ServerSettings {
    /** the project the agents come from; read-only to the server */
    projectDir: string;
    projectId: string;
    /** everything the server writes: the chats, their runs, the memory */
    stateDir: string;
    user: ServerUser;
    /** the bearer token every request but /healthz must carry; at least 32 characters */
    token: string;
    /** the Test tab's routes: recorded runs, traces, the memory graph */
    debug: boolean;
    /**
     * Where commands run: `'bwrap'` in the agent image, with `hidden` and the state directory
     * kept from them; `'podman'` is the engine's own default, as `zen run` has it; or a factory.
     */
    sandbox: 'bwrap' | 'podman' | SandboxFactory;
    /** what to call it, for `/api/status` */
    sandboxProvider: string;
    /** more paths bwrap commands never see (the state directory always) */
    hidden: string[];
    /** this run's own plugins (the MCP tools for its user), given the token its caller sent */
    plugins: (run: { mcpToken: string | null }) => Promise<ZenPlugin[]>;
    maxRuns: number;
    maxRunMinutes: number;
    runLogMaxBytes: number;
}

export const DEFAULTS: Omit<ServerSettings, 'projectId' | 'user' | 'token'> = {
    projectDir: '/project',
    stateDir: '/state',
    debug: false,
    sandbox: 'bwrap',
    sandboxProvider: 'bwrap (this container)',
    hidden: [],
    plugins: async () => [],
    maxRuns: 4,
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
