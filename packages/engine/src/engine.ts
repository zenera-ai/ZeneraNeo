import {
    AgentRunner,
    FilePayloadStore,
    MemoryError,
    SKILLS_MOUNT,
    Workspace,
    assertState,
    buildRunReport,
    compactIdentity,
    exaTools,
    fileTools,
    identityFromEnv,
    identityTools,
    lastText,
    loadProject,
    memoryDir,
    readProjectConfig,
    renderReportHtml,
    sandboxTools,
    turns,
    type AgentEvent,
    type AgentProject,
    type AgentState,
    type Input,
    type ResumeAnswer,
    type MemoryIndex,
    type RunIdentity,
    type RunResult,
    type SandboxFactory,
} from '@zenera/neo';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { auditModels, describeIssue, type ModelIssue } from './audit.ts';
import { loadProjectEnv } from './env.ts';
import {
    EXIT,
    EngineError,
    invalidError,
    stderrLogger,
    usageError,
    type Logger,
} from './errors.ts';
import { readJson, writeJson } from './home.ts';
import { KeyStore, assertUsable } from './keys.ts';
import {
    envPlugins,
    loadPlugins,
    mergePlugins,
    type LoadedPlugins,
    type ZenPlugin,
} from './plugins.ts';
import { projectMounts, type Project } from './projects.ts';
import {
    buildSandbox,
    prepareHome,
    teardown,
    usesSandbox,
    type Preflight,
    type SandboxSetup,
} from './sandbox.ts';
import {
    acquire,
    createRun,
    readSessionMeta,
    writeRunMeta,
    writeSessionMeta,
    type Held,
    type RunPaths,
    type SessionPaths,
} from './session.ts';

// ---------------------------------------------------------------------------
// The engine
//
// Everything `zen run` does that is not presentation. The TUI, the one-shot
// path and a server call exactly this, in the same order, which is what makes
// each of them a view rather than a mode: nothing is recorded only when someone
// is watching. What differs between hosts - where warnings go, how a container
// engine gets installed, how a run is drawn - comes in through the options.
// ---------------------------------------------------------------------------

/** Who a run acts for — re-exported so a host needs only this package. */
export type { RunIdentity } from '@zenera/neo';

/** A run drawn for a model to read, written beside it as `graph.mmd`. */
export type GraphRenderer = (
    state: AgentState,
    run: { runId: string; dir: string; workspace: string; memory?: string },
) => string;

export interface EngineOptions {
    project: Project;
    session: SessionPaths;
    readOnly?: boolean;
    /** default model override — `--model` */
    model?: string;
    /** sandbox image override — `--image` */
    image?: string;
    /** another directory to remember into — `--memory` */
    memoryDir?: string;
    /** recall only: nothing is written and several runs may share one graph */
    memoryReadOnly?: boolean;
    /**
     * An already-open graph to remember into instead of opening `memoryDir`.
     * Sessions may each open the same directory; handing them one index saves
     * every session loading the graph again.
     */
    memory?: MemoryIndex;
    /** whether credentials reach the sandbox — `--no-keys` sets this false */
    keys?: boolean;
    /** answer the sandbox's install question without asking — `--yes` */
    yes?: boolean;
    /**
     * Hold back the warnings about the project rather than the run. A batch
     * opens one project a hundred times, and a hundred copies of the same
     * complaint is a worse report than one.
     */
    quiet?: boolean;
    /**
     * The session will never be resumed, so its containers are removed on close
     * whatever `persist:` says. A stopped one would only hold an engine lock.
     */
    disposable?: boolean;
    /** where warnings go; stderr when unset */
    logger?: Logger;
    /** a model the run cannot reach; `logger.warn` with a plain sentence when unset */
    onIssue?: (issue: ModelIssue) => void;
    /** readies the container engine when the project can shell out; nothing when unset */
    preflight?: Preflight;
    /**
     * Opens the session's sandbox — where its commands run and its files
     * live. Podman on this machine when unset, which is what `zen run` is; a
     * host with a sandbox service passes its own, and the file tools then read
     * the files where that sandbox keeps them.
     */
    newSandbox?: SandboxFactory;
    /** draws each finished run as `graph.mmd`; no graph when unset */
    graph?: GraphRenderer;
    /**
     * Who the run is acting for — the person the host authenticated, not the
     * project's author and not the owner of the keys. `current_user` answers with it and
     * every sandbox command sees it as `ZEN_USER_*`.
     *
     * Unset, the engine takes `ZEN_USER_*` from its own environment, marked
     * `local`: that is how a `zen run` inside a sandbox keeps acting for the
     * same person, and how `zen run --as` works. `null` means nobody, and reads
     * nothing — a server that knows its runs have no user says so, rather than
     * letting whatever its own environment holds speak for one.
     */
    user?: RunIdentity | null;
    /**
     * Tools the host brings — see `ZenPlugin`. Each plugin is asked once, here,
     * so its tools can hold what this run needs (who it is for, a credential
     * the host minted for it). Config selects them like any other tool, and a
     * name or group that clashes with a built-in is refused. The plugins
     * `ZEN_PLUGINS` names are added too, unless one of these has the same name.
     */
    plugins?: ZenPlugin[];
    /** false: ignore `ZEN_PLUGINS` and use only `plugins` */
    envPlugins?: boolean;
}

export interface Engine {
    project: AgentProject;
    runner: AgentRunner;
    name: string;
    workspace: string;
    /** where the workspace appears inside the container */
    workspaceMount: string;
    /** every tree the file tools reach, and the names they reach them by */
    files: Workspace;
    /** whether the agent was denied every writing tool */
    readOnly: boolean;
    session: SessionPaths;
    /** the graph this session remembers into, when any agent has one */
    memory?: string;
    /** the session's accumulated state, when it has one */
    state?: AgentState;
    /** the containers this session may start; present whether or not it does */
    sandbox: SandboxSetup;
    lock: Held;
    graph?: GraphRenderer;
    /** who the run is acting for, when anyone */
    user?: RunIdentity;
    close(): Promise<void>;
}

/**
 * Wires the library to a session directory. Every store is file-backed and
 * rooted inside `.data/`, so a session is self-contained: copy the directory
 * and the whole conversation, its memory and its blobs travel with it.
 */
export async function openEngine(opts: EngineOptions): Promise<Engine> {
    const logger = opts.logger ?? stderrLogger;
    const onIssue = opts.onIssue ?? ((issue: ModelIssue) => logger.warn(describeIssue(issue)));
    const user = resolveUser(opts.user);

    // The machine's plugins are imported before the project's env file is read: a plugin may
    // configure itself from the environment when imported, and that must be the host's.
    const machinePlugins = opts.envPlugins === false ? [] : await envPlugins(logger);

    // Before the keyring, so the project's own file wins over the machine's
    // keys, and before the load, so `${VAR}` in agents.yaml can name anything
    // in it. The real environment still beats both.
    const env = loadProjectEnv(opts.project.dir);
    if (env?.refused.length && !opts.quiet) {
        logger.warn(
            `${env.path} sets ${env.refused.join(', ')} — ignored: who a run acts for, and ` +
                'which plugins load, are the host’s to say (zen run --as <user> to try one)',
        );
    }
    const hostPlugins = mergePlugins(opts.plugins ?? [], machinePlugins);

    const keys = await KeyStore.open();
    keys.materialize();
    assertUsable(keys);

    // Said before the load, because the load stops at the first model it cannot
    // build: one SDK's words about one model, when the useful answer is which
    // of the project's models are reachable and which are not.
    for (const issue of auditModels(opts.project.dir, keys)) {
        if (!opts.quiet) {
            onIssue(issue);
        }
    }

    const meta = await readSessionMeta(opts.session);
    const workspace = resolve(meta.workspace);

    const payloads = new FilePayloadStore({ dir: opts.session.blobs, id: 'file' });

    // The config is read before the project is loaded because the sandbox is
    // configured by it and the tools have to exist before selectors can be
    // resolved against them. They are always registered, whether or not anyone
    // selects them: a project that names `sandbox:*` against an empty tool list
    // fails to load with "unknown tool", which would be a lie.
    let setup: SandboxSetup;
    let project: AgentProject;
    let files: Workspace;
    let memory: string | undefined;
    let plugins: LoadedPlugins | undefined;
    try {
        const { root, config } = readProjectConfig(opts.project.dir);
        // Naming a directory declares the graph, but it cannot bind anyone to
        // it — so say when the run is pointed at a memory no agent will touch.
        if (opts.memoryDir && !opts.quiet && !config.agents.some((a) => a.memory)) {
            logger.warn('--memory names a directory no agent uses — none has `memory: true`');
        }
        memory = memoryDir(root, config, opts.memoryDir);
        // Assets and the skill catalog are mounted for both, under one name.
        const mounts = projectMounts(root, config);
        setup = buildSandbox({
            config,
            root,
            session: opts.session,
            workspace,
            readOnly: opts.readOnly,
            image: opts.image,
            keys: opts.keys,
            env: env?.names,
            mounts,
            identity: user,
            newSandbox: opts.newSandbox,
            ...(opts.disposable ? { persist: false } : {}),
        });
        const workspaceOptions = setup.sandbox.files({
            root: workspace,
            readOnly: opts.readOnly,
            mount: setup.workdir,
            mounts,
        });
        // The same view the file tools have, so a path the agent just wrote
        // resolves the same way when it asks memory to keep a copy.
        files = new Workspace(workspaceOptions);
        const builtins = [
            // Both groups are pointed at one directory, so both are told the
            // one name for it: whatever `run_command` prints a path as,
            // `read_file` accepts.
            ...fileTools(workspaceOptions),
            ...sandboxTools(setup.sandbox),
            // Registered whether or not a key exists: the credential is
            // read when a tool is called, so a project that names `exa:*`
            // loads on a machine that cannot yet search, and says so on the
            // turn that tried.
            ...exaTools(),
        ];
        // Every agent can ask who it is acting for without the project
        // having to know the tool exists; `-current_user` still takes it away.
        const always = identityTools(user);
        plugins = await loadPlugins(
            hostPlugins,
            { user, project: opts.project, session: opts.session, logger },
            [...builtins, ...always],
        );
        project = await loadProject(opts.project.dir, {
            tools: [...builtins, ...plugins.tools],
            alwaysTools: always,
            skillsAt: SKILLS_MOUNT,
            memory: opts.memory,
            memoryDir: opts.memoryDir,
            memoryReadOnly: opts.memoryReadOnly,
            payloads,
            files,
        });
    } catch (err) {
        await plugins?.close();
        throw invalidError(
            err instanceof Error ? err.message : String(err),
            err instanceof MemoryError && err.hint ? err.hint : `while loading ${opts.project.dir}`,
        );
    }
    const loaded = plugins;

    let state: AgentState | undefined;
    let lock: Held;
    let runner: AgentRunner;
    try {
        // Asked here rather than at the first `run_command`, so a host with no
        // container engine costs an error instead of a round trip. Nothing is
        // started: the container itself waits until something actually runs.
        if (usesSandbox(project)) {
            prepareHome(setup);
            await opts.preflight?.(setup, opts.yes);
        }

        // `recordRequests` is what makes the report show the exact bytes sent
        // rather than a reconstruction. It costs state size, and a CLI run is
        // written to disk once and inspected by a human — exactly the case the
        // library leaves it off for by default.
        //
        // `--model` becomes the runner's fallback rather than an alias, so it
        // overrides the config's `model:` without touching agents that pinned one.
        runner = project.runner({
            recordRequests: true,
            model: opts.model ? project.models.model(opts.model) : undefined,
        });

        state = await loadState(opts.session);
        lock = acquire(opts.session);
    } catch (err) {
        await loaded.close();
        throw err;
    }

    return {
        project,
        runner,
        name: opts.project.name,
        workspace,
        workspaceMount: setup.workdir,
        files,
        readOnly: Boolean(opts.readOnly),
        session: opts.session,
        memory,
        state,
        sandbox: setup,
        lock,
        graph: opts.graph,
        user,
        close: async () => {
            await teardown(setup, logger);
            // A host-supplied graph is the host's to release.
            if (!opts.memory) {
                project.close();
            }
            await loaded.close();
            lock.release();
        },
    };
}

/**
 * The identity a run acts for: what the host said, or — when it said nothing —
 * what the environment carries, which is never more than `local`. Validated
 * here because it is about to become variables and a container's argv: a
 * newline in an id is not an id.
 */
export function resolveUser(given: RunIdentity | null | undefined): RunIdentity | undefined {
    if (given === null) {
        return undefined;
    }
    const user = given ? compactIdentity(given) : identityFromEnv(process.env);
    if (!user) {
        return undefined;
    }
    if (!user.id.trim()) {
        throw usageError('the run’s user has an empty id');
    }
    for (const [key, value] of Object.entries(user)) {
        if (typeof value === 'string' && /[\0\r\n]/.test(value)) {
            throw usageError(`the run’s user ${key} has a control character in it`);
        }
    }
    return user;
}

async function loadState(session: SessionPaths): Promise<AgentState | undefined> {
    if (!existsSync(session.state)) {
        return undefined;
    }
    const json = await readJson<unknown>(session.state, undefined);
    try {
        return assertState(json);
    } catch {
        throw invalidError(
            `${session.state} is not a usable run state`,
            'start a fresh session with --new',
        );
    }
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

export interface Mount {
    /** the directory on this machine */
    host: string;
    /** where it appears to the agent */
    at: string;
    readOnly: boolean;
}

/** Every tree the agent can see, the workspace first. */
export function mounts(engine: Engine): Mount[] {
    return [
        { host: engine.workspace, at: engine.workspaceMount, readOnly: engine.readOnly },
        ...engine.sandbox.mounts.map((m) => ({
            host: m.host,
            at: m.at,
            readOnly: Boolean(m.readOnly),
        })),
    ];
}

export interface RunOutcome {
    run: RunPaths;
    result: RunResult<string>;
    text: string;
    durationMs: number;
    /** where the report landed, when one could be rendered */
    report?: string;
    /** where the Mermaid graph landed, when one could be emitted */
    graph?: string;
}

/**
 * What one finished run looks like to a program: `zen run --json` prints it,
 * and a batch writes one beside every item. The same function on purpose — a
 * batch whose items were shaped differently would make every consumer of a
 * single run a special case.
 */
export function envelope(engine: Engine, outcome: RunOutcome): Record<string, unknown> {
    return {
        session: { id: engine.session.id, dir: engine.session.dir },
        run: {
            id: outcome.run.id,
            dir: outcome.run.dir,
            input: outcome.run.input,
            output: outcome.run.output,
            state: outcome.run.state,
            meta: outcome.run.meta,
            ...(outcome.report ? { report: outcome.report } : {}),
            ...(outcome.graph ? { graph: outcome.graph } : {}),
        },
        mounts: mounts(engine),
        ...(engine.user ? { user: engine.user } : {}),
        agent: outcome.result.agent,
        stopReason: outcome.result.stopReason,
        durationMs: outcome.durationMs,
        usage: outcome.result.usage,
        output: outcome.text,
    };
}

/**
 * One turn. The session's state decides whether this starts a run or continues
 * one — which is the whole of what `resume` used to be, and why it is not a
 * command.
 */
export async function runEngine(
    engine: Engine,
    input: Input,
    onEvent?: (event: AgentEvent) => void,
    signal?: AbortSignal,
): Promise<RunOutcome> {
    const startedAt = new Date();
    const stream = engine.state
        ? engine.runner.send<string>(engine.state, input, { signal })
        : engine.runner.run<string>(engine.project.entry, input, { signal });

    if (onEvent) {
        for await (const event of stream) {
            onEvent(event);
        }
    }
    const result = await stream.final();
    const durationMs = Date.now() - startedAt.getTime();

    engine.state = result.state;
    const outcome = await record(engine, input, result, startedAt, durationMs);
    if (result.stopReason === 'failed') {
        throw new EngineError(
            result.state.error ?? 'the run failed',
            EXIT.failed,
            `report: ${outcome.run.report}`,
        );
    }
    return outcome;
}

/**
 * Continues a session whose last run stopped `suspended`: `answers` answer its
 * suspended calls (re-run, a result, or cancelled - see `ResumeAnswer`). The
 * run is recorded like any other turn; its input reads as the answers given.
 * Calls left unanswered keep it suspended.
 */
export async function resumeEngine(
    engine: Engine,
    answers: Record<string, ResumeAnswer>,
    onEvent?: (event: AgentEvent) => void,
    signal?: AbortSignal,
): Promise<RunOutcome> {
    if (!engine.state?.suspended?.length) {
        throw usageError('this session is not waiting on anything to resume');
    }
    const startedAt = new Date();
    const stream = engine.runner.resume<string>(engine.state, { answers, signal });
    if (onEvent) {
        for await (const event of stream) {
            onEvent(event);
        }
    }
    const result = await stream.final();
    const durationMs = Date.now() - startedAt.getTime();
    engine.state = result.state;
    const input = `(resumed: ${Object.entries(answers)
        .map(([id, a]) => `${id} ${a.status}`)
        .join(', ')})`;
    const outcome = await record(engine, input, result, startedAt, durationMs);
    if (result.stopReason === 'failed') {
        throw new EngineError(
            result.state.error ?? 'the run failed',
            EXIT.failed,
            `report: ${outcome.run.report}`,
        );
    }
    return outcome;
}

/**
 * Everything a finished turn leaves behind. The session state is written first:
 * if the report fails to render, the conversation is still resumable, which is
 * the ordering that loses least.
 */
async function record(
    engine: Engine,
    input: Input,
    result: RunResult<string>,
    startedAt: Date,
    durationMs: number,
): Promise<RunOutcome> {
    const { session } = engine;
    writeJson(session.state, result.state, 0o644);

    const meta = await readSessionMeta(session);
    meta.lastRunAt = new Date().toISOString();
    meta.title ??= title(input);
    writeSessionMeta(session, meta);

    const run = createRun(session);
    const text = await lastText(result.state, engine.runner.services.payloads);

    await writeFile(run.input, `${asText(input)}\n`, 'utf8');
    await writeFile(run.output, `${text}\n`, 'utf8');
    writeJson(run.state, result.state, 0o644);

    let report: string | undefined;
    try {
        const built = await buildRunReport(result.state, engine.runner.services.payloads, {
            title: `${engine.name} · ${run.id}`,
            architecture: await engine.runner.describe(),
            memory: engine.runner.services.memory?.store,
            mounts: [
                { at: engine.workspaceMount, href: pathToFileURL(engine.files.root).href },
                ...engine.files.mounts.map((m) => ({ at: m.at, href: pathToFileURL(m.host).href })),
            ],
        });
        await writeFile(run.report, renderReportHtml(built), 'utf8');
        report = run.report;
    } catch {
        // A report is a convenience. Losing it must not lose the run.
    }

    // The same trajectory for the other reader. `report.html` is for a person;
    // this is what `zen inspect graph` prints, written down while the state is
    // already in hand — a batch of a hundred items is otherwise a hundred more
    // commands to run before anything can be read.
    let graph: string | undefined;
    try {
        if (engine.graph) {
            await writeFile(
                run.graph,
                engine.graph(result.state, {
                    runId: run.id,
                    dir: run.dir,
                    workspace: engine.workspace,
                    memory: engine.memory,
                }),
                'utf8',
            );
            graph = run.graph;
        }
    } catch {
        // Same rule as the report: a view of the run is not the run.
    }

    writeRunMeta(run, {
        version: 1,
        id: run.id,
        session: session.id,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs,
        agent: result.agent,
        stopReason: result.stopReason,
        turns: turns(result.state),
        usage: result.usage,
        workspace: engine.workspace,
        memory: engine.memory,
        ...(engine.user ? { user: engine.user } : {}),
        error: result.state.error,
    });

    return { run, result, text, durationMs, report, graph };
}

function asText(input: Input): string {
    if (typeof input === 'string') {
        return input;
    }
    return input
        .map((part) => {
            if (typeof part === 'string') {
                return part;
            }
            if ('text' in part && typeof part.text === 'string') {
                return part.text;
            }
            // A media shorthand is a single key; naming it is more useful in a
            // transcript than printing the url or the base64 behind it.
            return `[${Object.keys(part)[0] ?? 'part'}]`;
        })
        .join('\n');
}

/** A session's label in a picker: the first thing that was ever asked of it. */
function title(input: Input): string {
    const text = asText(input).replace(/\s+/g, ' ').trim();
    return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}
