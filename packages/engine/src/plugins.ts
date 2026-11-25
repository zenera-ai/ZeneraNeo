// Plugins: tools a host brings to the engine (ZenPlugin) - loading them, checking their names
// against the built-ins, closing them, and the ones the machine names in ZEN_PLUGINS. A plugin
// may also say where sandboxes run (SandboxProvider) - a sandbox service instead of podman - and
// whether a failed model call should suspend the run instead of failing it (modelError).
// Used by: engine.ts (openEngine asks every plugin for its tools); the CLI's `zen check`
// (machinePluginTools, cli/src/validate.ts); hosts such as ZeneraLite's project pod (EngineOptions.plugins).
import {
    explain,
    isOutOfCredits,
    ProviderError,
    type AnyTool,
    type ModelErrorHandler,
    type RunIdentity,
    type SandboxConfig,
    type SandboxFactory,
    type SuspendSpec,
} from '@zenera/neo';
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
    tools?(ctx: PluginContext): AnyTool[] | Promise<AnyTool[]>;
    /**
     * Where this run's sandbox lives, when not in podman on this machine.
     * Asked once when the engine opens, before anything else; nothing means
     * "not mine to say". At most one plugin may answer.
     */
    sandbox?(
        ctx: SandboxContext,
    ): SandboxProvider | undefined | Promise<SandboxProvider | undefined>;
    /**
     * A model call failed: return a `SuspendSpec` to suspend the run at that
     * call instead of failing it (see `RunnerOptions.onModelError`), e.g. to
     * wait for a spending limit to be topped up; nothing lets the run fail as
     * usual. Plugins are asked in order and the first answer wins. A plugin
     * that throws is logged and skipped. Only asked for plugins asked for tools.
     */
    modelError?(
        err: unknown,
        ctx: ModelErrorPluginContext,
    ): SuspendSpec | undefined | Promise<SuspendSpec | undefined>;
    /** Called when the engine closes, or when it fails to open after the plugin was asked. */
    close?(): void | Promise<void>;
}

/**
 * What a plugin is told about a model call that failed. Classified here, so a
 * plugin with no dependencies need not pick apart provider errors itself.
 */
export interface ModelErrorPluginContext {
    /** the suspension's id if the run suspends: `llm:<n>` */
    callId: string;
    /** the model's id */
    model: string;
    /** the HTTP status, when the error carried one */
    status?: number;
    /** the provider's or gateway's symbol for the refusal, e.g. `budget_exceeded` */
    code?: string;
    /** the gateway's spending limit is used up (Bifrost's 402 `budget_exceeded`) */
    outOfCredits: boolean;
    /** who the run acts for, when anyone */
    user?: RunIdentity;
    session?: SessionPaths;
}

// ---------------------------------------------------------------------------
// Where sandboxes run
//
// Podman on this machine unless a plugin says otherwise. A host that embeds the
// engine can pass a factory outright (`newSandbox`); a `zen` it does not embed
// — the CLI in a terminal — learns about a sandbox service the only way it
// learns about anything, from a plugin `ZEN_PLUGINS` names. The provider then
// answers for every sandbox this engine opens, files included.
// ---------------------------------------------------------------------------

/** What a plugin is told when it is asked where the sandbox runs. */
export interface SandboxContext {
    project: { dir: string; name: string };
    /** the session the sandbox is for; absent when a project is only checked */
    session?: SessionPaths;
    /** who the run acts for, when anyone */
    user?: RunIdentity;
    /** the project's `sandbox:` block, as written */
    config: SandboxConfig | undefined;
    logger: Logger;
}

/** A plugin's answer: where sandboxes are opened, and how to report on them. */
export interface SandboxProvider {
    /** for people: `zenera-sandbox (http://localhost:7080)` */
    describe: string;
    newSandbox: SandboxFactory;
    /** what `zen sandbox status` prints for it */
    status?(): Promise<SandboxStatusReport>;
    /** what `zen sandbox clean` does for it; returns what it removed */
    clean?(opts: { all?: boolean }): Promise<string[]>;
}

export interface SandboxStatusReport {
    /** whether a sandbox could be opened right now */
    ready: boolean;
    /** one line each, for a person */
    lines: string[];
}

/**
 * The provider among `plugins`, if any. Two answers is an error rather than a
 * choice: which one wins would be an accident of the order the machine listed
 * them in, and the loser's users would never know their sandbox moved.
 */
export async function resolveSandboxProvider(
    plugins: readonly ZenPlugin[],
    ctx: SandboxContext,
): Promise<{ provider: SandboxProvider; plugin: ZenPlugin } | undefined> {
    let found: { provider: SandboxProvider; plugin: ZenPlugin } | undefined;
    for (const plugin of plugins) {
        if (!plugin.sandbox) {
            continue;
        }
        let provider: SandboxProvider | undefined;
        try {
            provider = await plugin.sandbox(ctx);
        } catch (err) {
            throw new Error(`plugin ${plugin.name}: ${message(err)}`);
        }
        if (!provider) {
            continue;
        }
        if (typeof provider.newSandbox !== 'function') {
            throw new Error(`plugin ${plugin.name}: its sandbox provider has no newSandbox`);
        }
        if (found) {
            throw new Error(
                `plugins ${found.plugin.name} and ${plugin.name} both provide the sandbox — ` +
                    'remove one of them from ZEN_PLUGINS',
            );
        }
        found = { provider, plugin };
    }
    return found;
}

export interface LoadedPlugins {
    tools: AnyTool[];
    /** Asks the plugins' `modelError` hooks in order; absent when no plugin has one. */
    onModelError?: ModelErrorHandler;
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
                given = (await plugin.tools?.(ctx)) ?? [];
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
    return { tools, onModelError: modelErrorHandler(asked, ctx), close };
}

/** One runner hook over the plugins that have `modelError`, asked in order. */
function modelErrorHandler(
    plugins: readonly ZenPlugin[],
    ctx: PluginContext,
): ModelErrorHandler | undefined {
    const hooked = plugins.filter((p) => p.modelError);
    if (!hooked.length) {
        return undefined;
    }
    return async (err, { callId, model }) => {
        const said = err instanceof ProviderError ? err : explain(err);
        const info: ModelErrorPluginContext = {
            callId,
            model,
            status: said.status,
            code: said.code,
            outOfCredits: isOutOfCredits(err),
            user: ctx.user,
            session: ctx.session,
        };
        for (const plugin of hooked) {
            try {
                const spec = await plugin.modelError!(err, info);
                if (spec) {
                    return spec;
                }
            } catch (hookErr) {
                // The run still fails with the model's error, which is the one that matters.
                ctx.logger.warn(`plugin ${plugin.name}: modelError failed: ${message(hookErr)}`);
            }
        }
        return undefined;
    };
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
            const usable =
                plugin &&
                typeof plugin.name === 'string' &&
                (typeof plugin.tools === 'function' || typeof plugin.sandbox === 'function');
            if (!usable || !plugin) {
                logger.warn(
                    `${PLUGINS_ENV}: ${path} has no default export with a name and tools() or sandbox() — ignored`,
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

/**
 * The sandbox provider the machine's plugins name, for checking a project
 * rather than running it: asked with no user and no session. The caller closes
 * the plugin once it is done with the provider. A plugin that fails is a
 * warning, and podman is used.
 */
export async function machineSandboxProvider(
    project: { dir: string; name: string },
    config: SandboxConfig | undefined,
    logger: Logger,
): Promise<{ provider: SandboxProvider; plugin: ZenPlugin } | undefined> {
    try {
        return await resolveSandboxProvider(await envPlugins(logger), { project, config, logger });
    } catch (err) {
        logger.warn(`${PLUGINS_ENV}: ${message(err)} — the sandbox is checked in podman`);
        return undefined;
    }
}
