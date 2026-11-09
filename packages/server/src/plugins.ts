// The per-run plugins a host configures through the environment: the MCP plugin `ZEN_PLUGINS`
// names (a `…/mcp.mjs` exporting `mcpPlugin`) and the broker `ZEN_MCP_BROKER_URL` it calls. Each
// run gets its own instance, given the broker token zenera-app minted for that run; it replaces
// the tokenless one ZEN_PLUGINS loads by name, so the agent's mcp_* tools reach the user's
// accounts for that run only. And the server-wide ones: where users' data is kept.
//   envRunPlugins   - settings.plugins for a server configured from its environment
//   envStateStore   - the UserStateStore `ZEN_STATE_STORE` names (a module exporting
//                     `userStateStore(options)`), e.g. ZeneraLite's S3 store; none: local only
//   envServerLimits - checkpoint interval, host subject, disk quota and command limits from
//                     ZEN_STATE_CHECKPOINT_SECONDS, ZEN_SERVER_SYSTEM_SUBJECT,
//                     ZEN_RUNTIME_{USER_DISK_MB,NICE,MAX_FILE_MB,TMP_MB}
import type { ZenPlugin } from '@zenera/engine';
import { pathToFileURL } from 'node:url';
import { DEFAULTS, type ServerSettings } from './config.ts';
import { USER_LAYOUT, type UserStateStore } from './userState.ts';

type McpModule = { mcpPlugin?: (o: { brokerUrl: string; token: string }) => ZenPlugin };

export function envRunPlugins(
    env: NodeJS.ProcessEnv = process.env,
): (run: { mcpToken: string | null }) => Promise<ZenPlugin[]> {
    const plugin =
        (env.ZEN_PLUGINS ?? '')
            .split(',')
            .map((p) => p.trim())
            .find((p) => p.endsWith('/mcp.mjs')) ?? '';
    const brokerUrl = env.ZEN_MCP_BROKER_URL ?? '';
    let loaded: Promise<McpModule> | null = null;
    return async ({ mcpToken }) => {
        if (!mcpToken || !plugin || !brokerUrl) return [];
        loaded ??= (import(pathToFileURL(plugin).href) as Promise<McpModule>).catch((err) => {
            console.warn(`mcp plugin ${plugin}: ${err instanceof Error ? err.message : err}`);
            loaded = null;
            return {};
        });
        const { mcpPlugin } = await loaded;
        return mcpPlugin ? [mcpPlugin({ brokerUrl, token: mcpToken })] : [];
    };
}

/** What a state store module is given: who it serves, and the user folder's layout. */
export interface StateStoreOptions {
    projectId: string;
    root: string;
    layout: typeof USER_LAYOUT;
    env: NodeJS.ProcessEnv;
    log: { info(message: string): void; warn(message: string): void };
}

type StateStoreModule = {
    userStateStore?: (options: StateStoreOptions) => UserStateStore | Promise<UserStateStore>;
};

/** The store `ZEN_STATE_STORE` names, made and checked; a broken one stops the server starting. */
export async function envStateStore(
    env: NodeJS.ProcessEnv,
    at: { projectId: string; root: string },
): Promise<UserStateStore | undefined> {
    const path = env.ZEN_STATE_STORE?.trim();
    if (!path) return undefined;
    const mod = (await import(pathToFileURL(path).href)) as StateStoreModule;
    if (typeof mod.userStateStore !== 'function') {
        throw new Error(`${path} exports no userStateStore(options)`);
    }
    const store = await mod.userStateStore({
        ...at,
        layout: USER_LAYOUT,
        env,
        log: {
            info: (message) => console.log(`[state] ${message}`),
            warn: (message) => console.warn(`[state] ${message}`),
        },
    });
    const ok =
        store &&
        typeof store.name === 'string' &&
        typeof store.durable === 'boolean' &&
        typeof store.load === 'function' &&
        typeof store.checkpoint === 'function';
    if (!ok) throw new Error(`${path}: userStateStore() did not return a store`);
    return store;
}

function whole(text: string | undefined, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
    const n = Number(text?.trim());
    return text?.trim() && Number.isInteger(n) && n >= 0 ? Math.min(n, max) : fallback;
}

const MB = 2 ** 20;

export function envServerLimits(
    env: NodeJS.ProcessEnv,
): Pick<
    ServerSettings,
    'checkpointSeconds' | 'systemSubject' | 'userDiskQuotaBytes' | 'commandLimits'
> {
    const limits = DEFAULTS.commandLimits;
    return {
        checkpointSeconds: whole(env.ZEN_STATE_CHECKPOINT_SECONDS, DEFAULTS.checkpointSeconds),
        systemSubject: env.ZEN_SERVER_SYSTEM_SUBJECT?.trim() || DEFAULTS.systemSubject,
        userDiskQuotaBytes: whole(env.ZEN_RUNTIME_USER_DISK_MB, 0) * MB,
        commandLimits: {
            nice: whole(env.ZEN_RUNTIME_NICE, limits.nice ?? 0, 19),
            fileSizeBytes: whole(env.ZEN_RUNTIME_MAX_FILE_MB, 0) * MB,
            tmpBytes: whole(env.ZEN_RUNTIME_TMP_MB, 0) * MB,
        },
    };
}
