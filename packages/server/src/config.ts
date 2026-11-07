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
import { ZENERA_BWRAP, type SandboxFactory } from '@zenera/sandbox';
import { existsSync } from 'node:fs';

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
