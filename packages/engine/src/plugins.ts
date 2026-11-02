import type { AnyTool, RunIdentity } from '@zenera/neo';
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
    session: SessionPaths;
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
