// The server's settings: what `createServer` was given, read by every route at call time.
// One server per process — the agent image's — so they are module state rather than
// threaded through every router; `configure` replaces them whole.
//
// The server serves every user its host vouches for, each in a folder of their own:
//   <root>/users/<user>/sessions/<thread>/   one zen session per chat thread
//   <root>/users/<user>/memory/              the user's graph, copied from the seed on first use
// Who a request is for is the `sub` of a JWT the host signs for that one request (auth.ts); the
// server holds only the public key. `insecure` reads the token without checking its signature,
// for trying a server on this machine.
import type { SandboxSetup, ZenPlugin } from '@zenera/engine';
import { ZENERA_BWRAP, type CommandLimits, type SandboxFactory } from '@zenera/sandbox';
import { existsSync } from 'node:fs';
import type { UserStateStore } from './userState.ts';

export type ServerAuth =
    /** EdDSA tokens signed per request by the host (zenera-app), checked with its public key */
    | { mode: 'jwt'; publicKey: string; issuer: string; audience: string }
    /** the same tokens, their signature, issuer, audience, age and binding not checked */
    | { mode: 'insecure' };

export interface ServerSettings {
    /** the project the agents come from; read-only to the server */
    projectDir: string;
    projectId: string;
    /** everything the server writes: `<root>/users/<user>/{sessions,memory}`, `<root>/server.json` */
    root: string;
    /**
     * The graph each user's memory starts as, copied the first time they need one. Unset: the
     * project's own (`memory:` in agents.yaml); `null`: none, every user starts empty.
     */
    memorySeed?: string | null;
    auth: ServerAuth;
    /** the Test tab's routes: recorded runs, traces, the memory graph */
    debug: boolean;
    /**
     * Where commands run: `'podman'` as `zen run` has it, a container per session on this
     * machine; `'bwrap'` in the agent image, with `hidden`, the root and the seed kept from
     * them; or a factory. `defaultSandbox()` picks between the first two.
     */
    sandbox: 'bwrap' | 'podman' | SandboxFactory;
    /** what to call it, for `/api/status` */
    sandboxProvider: string;
    /**
     * Readies a turn's sandbox before it runs. Unset: its image must already be there
     * (`imageReady`) — the agent image's, or one built ahead of time.
     */
    preflight?: (setup: SandboxSetup) => Promise<void>;
    /** more paths bwrap commands never see (the root, the seed, the zen home and the project always) */
    hidden: string[];
    /** this run's own plugins (the MCP tools for its user), given the token its caller sent */
    plugins: (run: { mcpToken: string | null }) => Promise<ZenPlugin[]>;
    maxRuns: number;
    /** how many runs one user may have going at once */
    maxUserRuns: number;
    maxRunMinutes: number;
    runLogMaxBytes: number;
    /**
     * Where users' data lives beyond this disk (userState.ts): loaded before their first request,
     * saved at safe points, released on the host's word. Unset: only here (`localStore`).
     */
    stateStore?: UserStateStore;
    /** how often users with runs going (or a failed save) are saved again; 0: never */
    checkpointSeconds: number;
    /** the `sub` of the host's own calls, the only one /api/admin answers */
    systemSubject: string;
    /** soft limit on one user's folder; over it, no new runs and running ones stop; 0: none */
    userDiskQuotaBytes: number;
    /** what each bwrap command is held to: priority, largest file, size of its /tmp; 0: none */
    commandLimits: CommandLimits;
    /**
     * How long a stopping server (SIGTERM) lets the runs going finish, taking no new users or
     * runs, before it interrupts the rest; 0: interrupts them at once.
     */
    stopGraceSeconds: number;
}

/**
 * bwrap inside the agent image, which ships it at /opt/zenera/bin/bwrap; podman anywhere else,
 * as `zen run`. The image is the container, so podman has nothing to run there.
 */
export function defaultSandbox(): 'bwrap' | 'podman' {
    return existsSync(ZENERA_BWRAP) ? 'bwrap' : 'podman';
}

/** Inside the agent image: where `--insecure` is refused unless the host that runs it says so. */
export function inAgentImage(): boolean {
    return existsSync(ZENERA_BWRAP);
}

export const SANDBOX_PROVIDERS = {
    bwrap: 'bwrap (this container)',
    podman: 'podman (this machine)',
} as const;

/** What zenera-app's tokens say today. */
export const DEFAULT_ISSUER = 'zenera-app';
export const DEFAULT_AUDIENCE = 'zenera-runtime';

const sandbox = defaultSandbox();

export const DEFAULTS: Omit<ServerSettings, 'projectId' | 'auth' | 'root'> = {
    projectDir: '/project',
    debug: false,
    sandbox,
    sandboxProvider: SANDBOX_PROVIDERS[sandbox],
    hidden: [],
    plugins: async () => [],
    maxRuns: 4,
    maxUserRuns: 2,
    maxRunMinutes: 120,
    runLogMaxBytes: 50 * 1024 * 1024,
    checkpointSeconds: 300,
    systemSubject: DEFAULT_ISSUER,
    userDiskQuotaBytes: 0,
    commandLimits: { nice: 10, fileSizeBytes: 0, tmpBytes: 0 },
    stopGraceSeconds: 0,
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
