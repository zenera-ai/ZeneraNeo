// The per-run plugins a host configures through the environment: the MCP plugin `ZEN_PLUGINS`
// names (a `…/mcp.mjs` exporting `mcpPlugin`) and the broker `ZEN_MCP_BROKER_URL` it calls. Each
// run gets its own instance, given the broker token zenera-app minted for that run; it replaces
// the tokenless one ZEN_PLUGINS loads by name, so the agent's mcp_* tools reach the user's
// accounts for that run only.
//   envRunPlugins - settings.plugins for a server configured from its environment
import type { ZenPlugin } from '@zenera/engine';
import { pathToFileURL } from 'node:url';

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
