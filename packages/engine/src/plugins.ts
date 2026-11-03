// Plugins: tools a host brings to the engine (ZenPlugin) - loading them, checking their names
// against the built-ins, closing them, and the ones the machine names in ZEN_PLUGINS.
// Used by: engine.ts (openEngine asks every plugin for its tools); the CLI's `zen check`
// (machinePluginTools, cli/src/validate.ts); hosts such as ZeneraLite's project pod (EngineOptions.plugins).
import type { AnyTool, RunIdentity } from '@zenera/neo';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Logger } from './errors.ts';
import type { SessionPaths } from './session.ts';

/** What a plugin needs to write a tool — re-exported so a host needs only this package. */
export { tool, type AnyTool, type ToolContext } from '@zenera/neo';

// ---------------------------------------------------------------------------
// Tools the host brings
//
// A host that runs projects for other people has tools the library cannot know
// about: its users' connected accounts, its own services. A plugin hands them
// in. They are registered like the built-in ones — config selects them by name
// or `<group>:*`, nothing reaches an agent that did not ask — and a plugin is
// asked for its tools once per engine, so a tool can close over who this run
// is for and whatever credential the host gave it for that person.
//
// Names are one namespace with the built-ins. A clash is refused rather than
// resolved: tool selection keeps whichever came last, so a plugin's
// `read_file` would quietly replace the real one, and a plugin group named
// after a built-in group would make `files:*` hand out tools the author never
// heard of.
// ---------------------------------------------------------------------------

/** What a plugin is told when it is asked for its tools. */
export interface PluginContext {
    /** who the run acts for, when anyone; the same value `current_user` answers with */
    user?: RunIdentity;
    project: { dir: string; name: string };
    /** the session the run belongs to; absent when tools are only listed (`zen check`) */
    session?: SessionPaths;
    logger: Logger;
}

export interface ZenPlugin {
    /** for error messages: which plugin a tool or a failure came from */
    name: string;
    /** Called once when the engine opens. May return nothing, which adds nothing. */
    tools(ctx: PluginContext): AnyTool[] | Promise<AnyTool[]>;
    /** Called when the engine closes, or when it fails to open after the plugin was asked. */
    close?(): void | Promise<void>;
}

export interface LoadedPlugins {
    tools: AnyTool[];
    /** Closes every plugin that was asked for tools, latest first. Never throws: failures are warnings. */
    close(): Promise<void>;
}

/**
 * Asks each plugin for its tools and checks them against the built-ins and each
 * other. When a plugin fails or a check does, the plugins already asked are
 * closed before the error is thrown.
 */
export async function loadPlugins(
    plugins: readonly ZenPlugin[],
    ctx: PluginContext,
    builtins: readonly AnyTool[],
): Promise<LoadedPlugins> {
    const asked: ZenPlugin[] = [];
    const close = async (): Promise<void> => {
        for (const plugin of asked.splice(0).reverse()) {
            try {
                await plugin.close?.();
            } catch (err) {
                ctx.logger.warn(`plugin ${plugin.name}: close failed: ${message(err)}`);
            }
        }
    };

    const owner = new Map<string, string>(builtins.map((t) => [t.name, 'built-in']));
    const builtinGroups = new Set(builtins.map((t) => t.group).filter((g) => g !== undefined));
    const names = new Set<string>();
    const tools: AnyTool[] = [];
    try {
        for (const plugin of plugins) {
            const name = plugin.name?.trim();
            if (!name) {
                throw new Error('a plugin has no name');
            }
            if (names.has(name)) {
                throw new Error(`two plugins are named ${name}`);
            }
            names.add(name);
            asked.push(plugin);
            let given: AnyTool[];
            try {
                given = (await plugin.tools(ctx)) ?? [];
            } catch (err) {
                throw new Error(`plugin ${name}: ${message(err)}`);
            }
            for (const t of given) {
                if (!t?.name?.trim()) {
                    throw new Error(`plugin ${name}: a tool has no name`);
                }
                const taken = owner.get(t.name);
                if (taken) {
                    throw new Error(
                        `plugin ${name}: tool ${t.name} is already ` +
                            (taken === 'built-in'
                                ? 'a built-in tool'
                                : `provided by plugin ${taken}`),
                    );
                }
                if (t.group && builtinGroups.has(t.group)) {
                    throw new Error(
                        `plugin ${name}: tool ${t.name} is in group ${t.group}, which belongs to the built-in tools`,
                    );
                }
                owner.set(t.name, name);
                tools.push(t);
            }
        }
    } catch (err) {
        await close();
        throw err;
    }
    return { tools, close };
}

function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Plugins the machine names
//
// A host that embeds the engine passes its plugins in. A `zen` it does not
// embed — the CLI in a terminal, a job, `zen check` — has no such call, so the
// machine names them instead: `ZEN_PLUGINS` is a comma-separated list of
// absolute paths to ES modules whose default export is a `ZenPlugin`. A project
// naming one of their groups then loads the same way everywhere.
//
// It is read once, when this module is first imported, and only from the real
// environment: a plugin runs inside this process, with every credential the
// process holds, so a project must not be able to name one. `readProjectEnv`
// refuses the name for the same reason, should a host apply a project's env
// file before importing the engine.
// ---------------------------------------------------------------------------

export const PLUGINS_ENV = 'ZEN_PLUGINS';

const STARTUP_PLUGINS = process.env[PLUGINS_ENV];

let fromEnv: Promise<ZenPlugin[]> | undefined;

/** The plugins `ZEN_PLUGINS` named when this process started, imported once. */
export function envPlugins(logger: Logger): Promise<ZenPlugin[]> {
    fromEnv ??= importPlugins(STARTUP_PLUGINS, logger);
    return fromEnv;
}

/**
 * Imports the plugins a `ZEN_PLUGINS`-style list names. One that cannot be
 * loaded is a warning, not a failure: a project that never names its tools
 * should still run, and one that does fails on the unknown tool, which says
 * more than a missing file does.
 */
export async function importPlugins(
    list: string | undefined,
    logger: Logger,
): Promise<ZenPlugin[]> {
    const plugins: ZenPlugin[] = [];
    const paths = (list ?? '')
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
    for (const path of paths) {
        if (!isAbsolute(path)) {
            logger.warn(`${PLUGINS_ENV}: ${path} is not an absolute path — ignored`);
            continue;
        }
        try {
            const mod = (await import(pathToFileURL(path).href)) as { default?: unknown };
            const plugin = mod.default as ZenPlugin | undefined;
            if (!plugin || typeof plugin.name !== 'string' || typeof plugin.tools !== 'function') {
                logger.warn(
                    `${PLUGINS_ENV}: ${path} has no default export with a name and tools() — ignored`,
                );
                continue;
            }
            plugins.push(plugin);
        } catch (err) {
            logger.warn(`${PLUGINS_ENV}: cannot load ${path}: ${message(err)} — ignored`);
        }
    }
    return plugins;
}

/** The host's plugins and the machine's, the host's winning where both name one. */
export function mergePlugins(
    given: readonly ZenPlugin[],
    machine: readonly ZenPlugin[],
): ZenPlugin[] {
    const names = new Set(given.map((p) => p.name));
    return [...given, ...machine.filter((p) => !names.has(p.name))];
}

/**
 * The tools the machine's plugins add, for checking a project rather than
 * running it: the plugins are asked with no user and no session, and closed
 * again. A plugin that fails or clashes is a warning, and adds nothing.
 */
export async function machinePluginTools(
    project: { dir: string; name: string },
    builtins: readonly AnyTool[],
    logger: Logger,
): Promise<AnyTool[]> {
    const tools: AnyTool[] = [];
    for (const plugin of await envPlugins(logger)) {
        try {
            const loaded = await loadPlugins([plugin], { project, logger }, [
                ...builtins,
                ...tools,
            ]);
            await loaded.close();
            tools.push(...loaded.tools);
        } catch (err) {
            logger.warn(`${PLUGINS_ENV}: ${message(err)} — its tools are left out`);
        }
    }
    return tools;
}
