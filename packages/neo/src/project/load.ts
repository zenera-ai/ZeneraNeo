import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { Agent, AgentRegistry, type ForkOptions } from '../agent.ts';
import type { Embedder } from '../embedding.ts';
import { RunStream } from '../events.ts';
import { frontmatter, toList } from '../frontmatter.ts';
import type { FileSource, WorkspaceWriter } from '../memory/files.ts';
import { MemoryIndex } from '../memory/index.ts';
import { DEFAULT_SEEDS } from '../memory/recall.ts';
import { MemoryStore } from '../memory/store.ts';
import type { MemoryBinding } from '../memory/types.ts';
import type { Model } from '../model.ts';
import {
    ModelRegistry,
    type EmbeddingRef,
    type ModelRef,
    type ProviderSpec,
} from '../models/factory.ts';
import type { PayloadStore } from '../payload.ts';
import { promptFile, type PromptPart, type PromptText } from '../prompt.ts';
import { AgentRunner, type RunnerOptions, type RunOptions } from '../runner.ts';
import { FileSkillProvider, type SkillDir } from '../skill-providers/file.ts';
import type { SkillBinding, SkillProvider, SkillSummary } from '../skills.ts';
import { selectTools, type AnyTool, type Input } from '../types.ts';
import { parseConfig, type AgentConfig, type ProjectConfig } from './config.ts';
import { projectDir, projectFile, projectRoot } from './refs.ts';

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

/**
 * A folder is an agentic system:
 *
 * ```
 * agents.yaml                   who exists, what they may reach for
 * agents/instructions.md        house rules, prepended to every agent
 * agents/<topic>-instructions.md   more of them, added as the project grows
 * agents/prompts/<role>.md      one agent's own instructions
 * agents/skills/<name>/SKILL.md
 * assets/                       reference material, mounted read-only at /assets
 * ```
 *
 * The loader turns that into the objects an author would otherwise write by
 * hand — it introduces no runtime concept of its own. Everything below is
 * assembly, which is the point: a project is a *serialisation* of a registry,
 * not a second way to run agents.
 */

export interface ProjectOptions<TCtx = unknown> {
    /**
     * Tool implementations, keyed by name. Config can name a tool; it cannot
     * contain one, so this is the seam where code re-enters a declarative
     * system. Both `agents[].tools` and a skill's `tools:` frontmatter resolve
     * against it.
     */
    tools?: AnyTool<TCtx>[];
    /**
     * Tools every agent gets without naming them — `current_user`, from the engine. Config
     * can still select one by name, and take it away with `-name`; what it
     * cannot do is forget it, which is the point for a tool whose whole value
     * is that the model can always ask.
     */
    alwaysTools?: AnyTool<TCtx>[];
    /**
     * Credentials for the names the config declares — or names it does not, so
     * a deployment can add a provider the repository never mentions. Merged
     * over `providers:`, host last, which is how ops repoints a key without a
     * commit.
     */
    providers?: Record<string, ProviderSpec>;
    /**
     * Aliases for `model:` values, so a project can say `model: fast` and the
     * host decides what fast means this week. Merged over the config's
     * `models:` map; a name in neither falls through to the shorthand.
     */
    models?: Record<string, ModelRef>;
    /** the same, for `embeddings:` — host last, for the same reason */
    embeddings?: Record<string, EmbeddingRef>;
    /**
     * A registry to populate and use instead of a fresh one. Share it across
     * projects and they share clients; pre-load it with a stub provider and the
     * project never reaches the network.
     */
    registry?: ModelRegistry;
    memory?: MemoryIndex;
    /**
     * Another directory to keep the memory graph in, relative to the project
     * root when it is not absolute.
     */
    memoryDir?: string;
    /**
     * Recall only: the graph is opened read-only and every agent's `access` is
     * clamped to `read`, so the writing tools are never offered and the house
     * rules never claim they are. It is what lets several runs share one
     * warmed memory at once, which the directory lock otherwise forbids.
     */
    memoryReadOnly?: boolean;
    /** reads a file the agent names, so it can be remembered */
    resolveFile?: (path: string) => FileSource;
    /** writes into the workspace, so a remembered file can be copied back out */
    writeFile?: WorkspaceWriter;
    payloads?: PayloadStore;
    /** extra providers merged with the ones the project declares */
    skills?: SkillProvider[];
    /**
     * Where the host has mounted the skill catalog for the agent to reach —
     * `/skills` from the CLI, which bind-mounts it into the container.
     *
     * Set it and a loaded skill carries the path of its own folder, so one that
     * ships a script can say where the script is. Left unset, a skill is text
     * and nothing claims otherwise: a promise of a directory that is not there
     * is worse than no directory.
     */
    skillsAt?: string;
}

const AGENTS_DIR = 'agents';
const PROMPTS_DIR = 'agents/prompts';
const SKILLS_DIR = 'agents/skills';
/** Reference material, by convention, when `assets:` says nothing. */
const ASSETS_DIR = 'assets';
const CONFIG_NAMES = ['agents.yaml', 'agents.yml', 'agents/agents.yaml', 'agents/agents.yml'];
// Deliberately not `AGENTS.md`: every coding assistant now reads that name out
// of an open folder, and `zen open` opens exactly this directory. The house
// rules here address *this project's* agents, not the editor's.
const HOUSE_RULES = 'agents/instructions.md';
/** Every other `agents/<topic>-instructions.md`, in filename order. */
const INSTRUCTIONS_SUFFIX = '-instructions.md';

/** A project's declaration, before anything is assembled from it. */
export interface ProjectSource {
    root: string;
    /** the config file that was read */
    source: string;
    config: ProjectConfig;
}

/**
 * Finds and validates `agents.yaml`, and stops there. Loading a project builds
 * its model clients, which needs credentials — so anything that wants to *look*
 * at what a project declares, credentials included, has to be able to read it
 * without that.
 */
export function readProjectConfig(dir: string): ProjectSource {
    const root = projectRoot(dir);
    const source = findConfig(root);
    return { root, source, config: parseConfig(readFileSync(source, 'utf8'), source) };
}

/**
 * Reads a project into memory. Every file it will ever need is read here, so a
 * broken path, an unknown tool or a hand-off to nobody fails at startup with
 * the offending key named — not on some later turn, in production, as a model
 * error nobody can act on.
 */
export async function loadProject<TCtx = unknown>(
    dir: string,
    opts: ProjectOptions<TCtx> = {},
): Promise<AgentProject<TCtx>> {
    const { root, source, config: declared } = readProjectConfig(dir);
    // Clamped here rather than at each use, so the tools, the house rules and
    // the report all read the same access and cannot disagree about it.
    const config = opts.memoryReadOnly ? recallOnly(declared) : declared;

    // Read once and share the objects: every agent's prompt then reports the
    // same paths and the same content hashes, so the report says "one document,
    // five prompts" instead of showing five identical blobs.
    const houseRules = readHouseRules(root);

    const providers = [...skillProviders(root, config, opts), ...(opts.skills ?? [])];
    const catalogs = await indexOf(providers);
    const models = projectRegistry(config, opts);
    // Resolved here rather than where it is mounted, so an `assets:` naming a
    // directory that is not there fails at load like every other bad path.
    const assets = assetsDir(root, config);

    const registry = new AgentRegistry<TCtx>();
    const resolve = modelResolver(config, opts, models);
    for (const spec of config.agents) {
        registry.agent({
            name: spec.name,
            description: spec.description,
            instructions: instructionsFor(root, spec, houseRules),
            model: resolve(spec.model ?? config.model, `agents.${spec.name}.model`),
            tools: toolsFor(spec, opts.tools ?? [], opts.alwaysTools ?? []),
            handoffs: spec.handoffs,
            skills: bindingFor(spec, providers),
            fork: forkFor(spec),
            memory: memoryFor(spec),
        });
    }

    validate(config, registry, providers, catalogs, models);

    const embedders = embedderResolver(config, opts, models);
    // The default is resolved here rather than on first use, so a broken
    // `embedding:` fails at load like a broken `model:` does.
    embedders(config.embedding, 'embedding');

    const memory =
        opts.memory ??
        (await openMemory(root, config, embedders, opts.memoryDir, opts.memoryReadOnly));

    return new AgentProject<TCtx>({
        root,
        source,
        config,
        entry: entrypoint(config),
        registry,
        memory,
        skillProviders: providers,
        assets,
        models,
        embedders,
        options: opts,
    });
}

interface ProjectParts<TCtx> {
    root: string;
    source: string;
    config: ProjectConfig;
    entry: string;
    registry: AgentRegistry<TCtx>;
    skillProviders: SkillProvider[];
    assets: string | undefined;
    models: ModelRegistry;
    memory: MemoryIndex | undefined;
    embedders: (ref: string | undefined, where: string) => Embedder | undefined;
    options: ProjectOptions<TCtx>;
}
/**
 * A loaded project: immutable, and therefore shareable.
 *
 * Load once per process and let every chat use the same instance. Nothing
 * per-conversation lives here — a conversation *is* its `AgentState`, and the
 * caller's data reaches tools through `RunOptions.context`. Two chats holding
 * this object cannot observe each other.
 *
 * There is a second, quieter payoff. Because tool schemas no longer change as
 * skills activate, every chat on a shared project sends a byte-identical
 * `[tool schemas][system prompt]` prefix. That is a provider cache hit *across*
 * conversations, not merely within one.
 */
export class AgentProject<TCtx = unknown> {
    readonly root: string;
    /** the config file that was read, for error messages and reloads */
    readonly source: string;
    readonly config: ProjectConfig;
    /** agent the project starts with */
    readonly entry: string;
    readonly registry: AgentRegistry<TCtx>;
    readonly skillProviders: readonly SkillProvider[];
    /** reference material to mount read-only, if the project has any */
    readonly assets: string | undefined;
    /** the providers this project declared, and the clients behind them */
    readonly models: ModelRegistry;
    /** the one memory graph, when this project has one */
    readonly memory: MemoryIndex | undefined;
    readonly #embedders: (ref: string | undefined, where: string) => Embedder | undefined;
    readonly #options: ProjectOptions<TCtx>;
    #runner?: AgentRunner<TCtx>;

    constructor(parts: ProjectParts<TCtx>) {
        this.root = parts.root;
        this.source = parts.source;
        this.config = parts.config;
        this.entry = parts.entry;
        this.registry = parts.registry;
        this.skillProviders = parts.skillProviders;
        this.assets = parts.assets;
        this.models = parts.models;
        this.memory = parts.memory;
        this.#embedders = parts.embedders;
        this.#options = parts.options;
    }

    /** Releases the memory lock. A project that holds no memory need not be closed. */
    close(): void {
        this.memory?.store.release();
    }

    get agents(): readonly Agent<TCtx>[] {
        return [...this.registry.agents.values()];
    }

    /**
     * A declared vectoriser, memoized. Named or not: with no argument this is
     * the project's `embedding:`, and `undefined` when it declares none.
     */
    embedder(name?: string): Embedder | undefined {
        const ref = name ?? this.config.embedding;
        return this.#embedders(ref, name ? `embeddings.${name}` : 'embedding');
    }

    /**
     * The shared runner, or a fresh one when a caller needs different wiring.
     *
     * Memoized without overrides because a runner holds only immutable
     * configuration; handing the same one to every chat is safe and saves
     * re-registering the agents.
     */
    runner(overrides?: RunnerOptions<TCtx>): AgentRunner<TCtx> {
        if (overrides) {
            return this.#build(overrides);
        }
        return (this.#runner ??= this.#build());
    }

    /** Starts a run on the entry agent with the shared runner. */
    run<T = string>(input?: Input, opts: RunOptions<T, TCtx> = {}): RunStream<T> {
        return this.runner().run<T>(this.entry, input, opts);
    }

    #build(overrides: RunnerOptions<TCtx> = {}): AgentRunner<TCtx> {
        const runner = new AgentRunner<TCtx>({
            payloads: this.#options.payloads,
            memory: this.memory,
            resolveFile: this.#options.resolveFile,
            writeFile: this.#options.writeFile,
            skills: [...this.skillProviders],
            ...overrides,
        });
        runner.add(...this.agents);
        return runner;
    }
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function findConfig(root: string): string {
    for (const name of CONFIG_NAMES) {
        const path = join(root, name);
        if (existsSync(path)) {
            return path;
        }
    }
    throw new Error(`no project configuration in ${root} (looked for ${CONFIG_NAMES.join(', ')})`);
}

/** The project-relative name of a file, which is the name the model is given. */
function within(root: string, path: string): string {
    return relative(root, path).split(sep).join('/');
}

/**
 * Every house-rules document, in the order they are prepended.
 *
 * The set is a glob rather than a list in `agents.yaml` because these are read
 * by every agent without exception — there is nothing to decide, so there is
 * nothing to declare. Order is the filename's, which is the only ordering that
 * is the same on every machine and is visible without opening another file.
 *
 * The exception a document declares for itself: `requires:` in its frontmatter
 * names capabilities, and the document then reaches only the agents that have
 * them. That stays a property of the document rather than of `agents.yaml`
 * because the condition and the prose it guards are the same edit.
 *
 * All of it is optional: a one-agent project whose whole prompt is its role
 * file should not need a second, empty document.
 */
function readHouseRules(root: string): HouseRule[] {
    const rules: HouseRule[] = [];
    const take = (rel: string): void => {
        const path = join(root, rel);
        if (!existsSync(path)) {
            return;
        }
        const { data, body } = frontmatter(readFileSync(path, 'utf8'));
        const requires = toList(data.requires);
        for (const cap of requires) {
            if (!(cap in CAPABILITIES)) {
                throw new Error(
                    `${rel}: unknown capability "${cap}" in requires: ` +
                        `(known: ${Object.keys(CAPABILITIES).join(', ')})`,
                );
            }
        }
        // One object per document, shared by every agent it reaches, so the
        // report says "one document, five prompts" rather than showing five
        // identical blobs.
        rules.push({ rel, requires, part: { text: body, path, section: 'house_rules', src: rel } });
    };
    take(HOUSE_RULES);
    for (const name of topics(root)) {
        take(`${AGENTS_DIR}/${name}`);
    }
    return rules;
}

/** A house-rules document and the conditions its frontmatter declared. */
interface HouseRule {
    /** project-relative name, which is the name the model is given */
    rel: string;
    requires: string[];
    part: PromptText;
}

const FILE_TOOLS = [
    'read_file',
    'list_dir',
    'find_files',
    'write_file',
    'apply_patch',
    'copy_file',
    'move_file',
    'delete_file',
] as const;

const FILE_WRITE_TOOLS = new Set([
    'write_file',
    'apply_patch',
    'copy_file',
    'move_file',
    'delete_file',
]);

function activeFileTools(selectors: readonly string[] | undefined): Set<string> {
    const active = new Set<string>();
    if (!selectors?.length) {
        return active;
    }
    for (const raw of selectors) {
        const drop = raw.startsWith('-');
        const selector = (drop ? raw.slice(1) : raw).trim();
        if (selector === '*' || selector === 'files:*' || selector === 'workspace:*') {
            for (const t of FILE_TOOLS) {
                if (drop) {
                    active.delete(t);
                } else {
                    active.add(t);
                }
            }
            continue;
        }
        const colon = selector.lastIndexOf(':');
        const name = colon >= 0 ? selector.slice(colon + 1) : selector;
        const group = colon >= 0 ? selector.slice(0, colon) : undefined;
        if (FILE_TOOLS.includes(name as (typeof FILE_TOOLS)[number])) {
            if (!group || group === 'files' || group === 'workspace') {
                if (drop) {
                    active.delete(name);
                } else {
                    active.add(name);
                }
            }
        }
    }
    return active;
}

function hasFileTools(spec: AgentConfig): boolean {
    return activeFileTools(spec.tools).size > 0;
}

function hasFileWriteTools(spec: AgentConfig): boolean {
    const active = activeFileTools(spec.tools);
    for (const t of FILE_WRITE_TOOLS) {
        if (active.has(t)) {
            return true;
        }
    }
    return false;
}

/**
 * What `requires:` may name, and what each one means. A closed vocabulary
 * rather than an expression language: these are the capabilities the runtime
 * can turn on and off, so the set of useful conditions is finite and knowable,
 * and a typo is a load error instead of a rule that silently never fires.
 *
 * Every entry reads `agents.yaml` and nothing else. In particular none of them
 * consults the resolved tool set, which is a function of the *state* — a prompt
 * that varied with it would move the provider's cache prefix mid-run.
 *
 * A capability may also contribute a run-time half, returned as `when`: `fork`
 * does, because the tool is withdrawn at the depth cap and a rule about a tool
 * the model does not have is a rule it can only be confused by.
 */
const CAPABILITIES: Record<string, (spec: AgentConfig) => PromptText['when'] | boolean> = {
    fork: (spec) => Boolean(spec.fork) && ((_ctx, run) => run.forkDepth < run.maxForkDepth),
    memory: (spec) => Boolean(spec.memory),
    'memory-write': (spec) =>
        spec.memory?.access === 'read-write' || spec.memory?.access === 'full',
    'memory-forget': (spec) => spec.memory?.access === 'full',
    files: (spec) => hasFileTools(spec),
    'files-write': (spec) => hasFileWriteTools(spec),
    workspace: (spec) => hasFileTools(spec),
    'workspace-write': (spec) => hasFileWriteTools(spec),
};

/**
 * The document as this agent gets it, or `undefined` when its conditions rule
 * the agent out. Several run-time conditions are met by meeting all of them.
 */
function ruleFor(rule: HouseRule, spec: AgentConfig): PromptText | undefined {
    const gates: NonNullable<PromptText['when']>[] = [];
    for (const cap of rule.requires) {
        const resolved = CAPABILITIES[cap](spec);
        if (!resolved) {
            return undefined;
        }
        if (typeof resolved === 'function') {
            gates.push(resolved);
        }
    }
    if (!gates.length) {
        return rule.part;
    }
    return { ...rule.part, when: (ctx, run) => gates.every((g) => g(ctx, run)) };
}

/** `agents/<topic>-instructions.md`, sorted. Subdirectories are not searched. */
function topics(root: string): string[] {
    const dir = join(root, AGENTS_DIR);
    if (!existsSync(dir)) {
        return [];
    }
    return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(INSTRUCTIONS_SUFFIX))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
}

/**
 * The house rules first, the agent's own file second — shared context before
 * the specific job, and the stable half of the prompt in front where a cache
 * can reuse it.
 */
function instructionsFor(root: string, spec: AgentConfig, houseRules: HouseRule[]): PromptPart[] {
    const parts: PromptPart[] = [];
    for (const rule of houseRules) {
        const part = ruleFor(rule, spec);
        if (part) {
            parts.push(part);
        }
    }
    const role = spec.system
        ? projectFile(root, spec.system, `agents.${spec.name}.system`)
        : join(root, PROMPTS_DIR, `${spec.name}.md`);
    // A named prompt that is missing is `projectFile`'s to refuse; a
    // conventional one that is missing is simply an agent without a role file.
    if (spec.system || existsSync(role)) {
        parts.push(promptFile(role, 'role', within(root, role)));
    }
    return parts;
}

/**
 * Assembles the project's providers. Declaring one contacts nothing and reads
 * no environment: a project may name a vendor a given deployment has no key
 * for, and only pay for it if an agent actually reaches for it.
 */
export function projectRegistry<TCtx>(
    config: ProjectConfig,
    opts: ProjectOptions<TCtx> = {},
): ModelRegistry {
    const models = opts.registry ?? new ModelRegistry();
    for (const [name, spec] of Object.entries(config.providers ?? {})) {
        models.provider(name, spec);
    }
    // Host last: a deployment overrides the repository, never the other way.
    for (const [name, spec] of Object.entries(opts.providers ?? {})) {
        models.provider(name, spec);
    }
    if (config.provider) {
        models.setDefault(config.provider);
    }
    return models;
}

/**
 * `model:` values, resolved through the alias tables and memoized.
 *
 * Memoized because two agents naming `fast` should be two references to one
 * model over one client, not two of each — and because the error a bad ref
 * raises should be raised once, at the agent that wrote it.
 */
function modelResolver<TCtx>(
    config: ProjectConfig,
    opts: ProjectOptions<TCtx>,
    models: ModelRegistry,
): (ref: string | undefined, where: string) => Model | undefined {
    const cache = new Map<string, Model>();
    return (ref, where) => {
        if (!ref) {
            return undefined;
        }
        const cached = cache.get(ref);
        if (cached) {
            return cached;
        }
        const resolved = opts.models?.[ref] ?? config.models?.[ref] ?? ref;
        try {
            // `reasoningEffort` is widened to `string` by the schema on purpose
            // (see config.ts); the request is the authority on rejecting a bad
            // one, so this cast hands it over rather than guessing the vendor's
            // current set.
            const model = models.model(resolved as ModelRef);
            cache.set(ref, model);
            return model;
        } catch (e) {
            throw new Error(`${where}: ${(e as Error).message}`);
        }
    };
}

/**
 * `embeddings:` values, resolved the same way `model:` values are — through the
 * alias tables, memoized, and with the offending key named when a ref will not
 * resolve.
 */
function embedderResolver<TCtx>(
    config: ProjectConfig,
    opts: ProjectOptions<TCtx>,
    models: ModelRegistry,
): (ref: string | undefined, where: string) => Embedder | undefined {
    const cache = new Map<string, Embedder>();
    return (ref, where) => {
        if (!ref) {
            return undefined;
        }
        const cached = cache.get(ref);
        if (cached) {
            return cached;
        }
        const resolved = opts.embeddings?.[ref] ?? config.embeddings?.[ref] ?? ref;
        try {
            // `routing` is widened to plain strings by the schema on purpose
            // (see config.ts); the request is the authority on rejecting one.
            const embedder = models.embedder(resolved as EmbeddingRef);
            cache.set(ref, embedder);
            return embedder;
        } catch (e) {
            throw new Error(`${where}: ${(e as Error).message}`);
        }
    };
}

function toolsFor<TCtx>(
    spec: AgentConfig,
    available: AnyTool<TCtx>[],
    always: AnyTool<TCtx>[],
): AnyTool<TCtx>[] {
    // One namespace, so `current_user` and `identity:*` resolve, and `-current_user` is a removal
    // rather than an unknown tool.
    const names = new Set(available.map((t) => t.name));
    const all = [...available, ...always.filter((t) => !names.has(t.name))];
    const where = { where: `agents.${spec.name}.tools`, hint: 'pass it in ProjectOptions.tools' };
    const selectors = spec.tools ?? [];
    const chosen = selectors.length ? selectTools(all, selectors, where) : [];
    if (!always.length) {
        return chosen;
    }
    // What `*` and the removals leave of everything is what the author did
    // not take away; an always-tool survives unless it was among the taken.
    const drops = selectors.filter((s) => s.trim().startsWith('-'));
    const kept = new Set(selectTools(all, ['*', ...drops], where).map((t) => t.name));
    const have = new Set(chosen.map((t) => t.name));
    return [...chosen, ...always.filter((t) => kept.has(t.name) && !have.has(t.name))];
}

function bindingFor(spec: AgentConfig, providers: SkillProvider[]): SkillBinding | undefined {
    if (!spec.skills) {
        return undefined;
    }
    const provider = spec.skills.provider ?? providers[0]?.id;
    if (!provider) {
        throw new Error(
            `agents.${spec.name}.skills: no skill provider — add a top-level ` +
                `\`skills:\` directory or pass one in ProjectOptions.skills`,
        );
    }
    return {
        provider,
        discovery: spec.skills.discovery,
        allow: spec.skills.allow,
        preload: spec.skills.preload,
        maxIndexEntries: spec.skills.maxIndexEntries,
    };
}

/**
 * `true` and `{}` both mean "opt in, no limits", because the kernel offers the
 * tool on the binding's presence alone. `false` folds back to absent, so a
 * project can write the "no" it was going to write anyway without that being a
 * different state from omitting the key.
 */
function forkFor(spec: AgentConfig): ForkOptions | undefined {
    if (!spec.fork) {
        return undefined;
    }
    return spec.fork === true ? {} : spec.fork;
}

/**
 * `memory: true` is the whole feature working the obvious way: read and write,
 * and recall before a turn that follows new user input. An agent that has to
 * remember to go looking mostly does not, so auto-recall is on by default and
 * `autoRecall: false` is how you turn it off.
 */
function memoryFor(spec: AgentConfig): MemoryBinding | undefined {
    const b = spec.memory;
    if (!b) {
        return undefined;
    }
    const auto = b.autoRecall ?? true;
    return {
        access: b.access,
        sees: b.sees,
        writes: b.writes,
        autoRecall: auto
            ? { query: 'last_user_input', limit: auto === true ? DEFAULT_SEEDS : auto.limit }
            : undefined,
    };
}

/**
 * Where this project's memory lives, or `undefined` when it has none. Shared
 * with the front end, which reports and exports the same directory: two
 * answers to this question would mean two graphs.
 *
 * `override` is the host pointing the run at another graph — `zen run
 * --memory`. It answers for a project that declares no memory at all, because
 * naming a directory is the declaration; the agents bound to it are still the
 * ones that said `memory: true`.
 */
export function memoryDir(
    root: string,
    config: ProjectConfig,
    override?: string,
): string | undefined {
    if (override) {
        return resolve(root, override);
    }
    if (!config.memory && !config.agents.some((a) => a.memory)) {
        return undefined;
    }
    return join(root, config.memory?.dir ?? 'memory');
}

/**
 * The same project with every memory binding demoted to `read`. A read-only
 * graph refuses a commit, so an agent offered `memory_commit` would only find
 * that out by having one fail mid-run.
 */
function recallOnly(config: ProjectConfig): ProjectConfig {
    return {
        ...config,
        agents: config.agents.map((spec) =>
            spec.memory ? { ...spec, memory: { ...spec.memory, access: 'read' as const } } : spec,
        ),
    };
}

/**
 * Opened only when something will use it, so an ordinary project neither
 * creates a directory nor takes a lock. A `memory:` block with no agent bound
 * to it still counts: it is how a project declares the graph `zen memory`
 * inspects between runs.
 */
async function openMemory(
    root: string,
    config: ProjectConfig,
    embedders: (ref: string | undefined, where: string) => Embedder | undefined,
    override?: string,
    readOnly?: boolean,
): Promise<MemoryIndex | undefined> {
    const dir = memoryDir(root, config, override);
    if (!dir) {
        return undefined;
    }
    const declared = config.memory;
    const embedder = embedders(declared?.embedding ?? config.embedding, 'memory.embedding');
    return new MemoryIndex({
        store: await MemoryStore.open(dir, { readOnly }),
        embedder,
        kinds: declared?.kinds,
        relations: declared?.relations,
    });
}

function skillProviders<TCtx>(
    root: string,
    config: ProjectConfig,
    opts: ProjectOptions<TCtx>,
): SkillProvider[] {
    const declared = skillDirs(root, config);
    if (!declared.length) {
        return [];
    }
    // One provider over several directories rather than several providers: a
    // binding names exactly one, and "which folder is this skill in?" is not a
    // question an agent author should have to answer.
    return [
        new FileSkillProvider({
            id: 'project',
            dir: opts.skillsAt ? skillMounts(declared, opts.skillsAt) : declared,
            tools: opts.tools,
        }),
    ];
}

/**
 * Where each skill directory appears in the agent's namespace.
 *
 * One catalog is the whole of `/skills`, which is what a project normally has.
 * Several cannot all be it, so each takes its own last segment underneath — and
 * two directories ending in the same name would mean one hid the other, which
 * is a load error rather than a catalog that silently went missing.
 */
export function skillMounts(dirs: readonly string[], at: string): SkillDir[] {
    if (dirs.length === 1) {
        return [{ path: dirs[0], at }];
    }
    const taken = new Map<string, string>();
    return dirs.map((dir) => {
        const name = basename(dir);
        const clash = taken.get(name);
        if (clash) {
            throw new Error(`skills: ${dir} and ${clash} would both be mounted at ${at}/${name}`);
        }
        taken.set(name, dir);
        return { path: dir, at: `${at}/${name}` };
    });
}

/**
 * The directories the skill catalog is built from, resolved. `skills:` if it is
 * there, otherwise the conventional folder if it exists, otherwise none — a
 * project without skills is a project, not an error.
 */
export function skillDirs(root: string, config: ProjectConfig): string[] {
    const declared = config.skills
        ? Array.isArray(config.skills)
            ? config.skills
            : [config.skills]
        : existsSync(join(root, SKILLS_DIR))
          ? [SKILLS_DIR]
          : [];
    return declared.map((d, i) => projectDir(root, d, `skills[${i}]`));
}

/**
 * The project's reference material, resolved, or undefined if it has none.
 *
 * Convention first — `assets/` next to `agents.yaml` is enough, and a project
 * that only wants somewhere to put a handbook writes no config at all. The key
 * exists for the project that keeps its material elsewhere in the tree; a key
 * naming a directory that is not there is a mistake in the file and fails at
 * load, where the conventional folder merely being absent does not.
 */
export function assetsDir(root: string, config: ProjectConfig): string | undefined {
    if (config.assets) {
        return projectDir(root, config.assets, 'assets');
    }
    const at = join(root, ASSETS_DIR);
    return existsSync(at) && statSync(at).isDirectory() ? at : undefined;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

async function indexOf(providers: SkillProvider[]): Promise<Map<string, Set<string>>> {
    const out = new Map<string, Set<string>>();
    for (const p of providers) {
        out.set(p.id, new Set((await p.list()).map((s: SkillSummary) => s.name)));
    }
    return out;
}

/**
 * Cross-references the config against what was actually loaded.
 *
 * The schema can only check shape. Whether `handoffs: [resolver]` names a real
 * agent, or `preload: [house_style]` a real skill, is knowable only once
 * everything is in memory — and getting it wrong is the failure that would
 * otherwise surface as a confused model halfway through a run.
 */
function validate<TCtx>(
    config: ProjectConfig,
    registry: AgentRegistry<TCtx>,
    providers: SkillProvider[],
    catalogs: Map<string, Set<string>>,
    models: ModelRegistry,
): void {
    const ids = new Set(providers.map((p) => p.id));

    // Provider *names* are checkable without credentials, so a typo in an entry
    // no agent happens to use is still caught — unlike the key it would need.
    for (const [alias, spec] of Object.entries(config.models ?? {})) {
        const named = typeof spec === 'string' ? undefined : spec.provider;
        if (named && !models.has(named)) {
            throw new Error(
                `models.${alias}.provider: unknown provider "${named}" ` +
                    `(known: ${models.names().join(', ')})`,
            );
        }
    }

    for (const [alias, spec] of Object.entries(config.embeddings ?? {})) {
        const named = typeof spec === 'string' ? undefined : spec.provider;
        if (named && !models.has(named)) {
            throw new Error(
                `embeddings.${alias}.provider: unknown provider "${named}" ` +
                    `(known: ${models.names().join(', ')})`,
            );
        }
    }

    for (const spec of config.agents) {
        for (const target of spec.handoffs ?? []) {
            if (!registry.find(target)) {
                throw new Error(
                    `agents.${spec.name}.handoffs: unknown agent "${target}" ` +
                        `(known: ${registry.names().join(', ')})`,
                );
            }
            if (target === spec.name) {
                throw new Error(`agents.${spec.name}.handoffs: an agent cannot hand off to itself`);
            }
        }

        // Unlike a hand-off, naming yourself is the common case here — one role
        // fanned out over ten regions — so only unknown names are an error.
        for (const target of registry.get(spec.name).fork?.agents ?? []) {
            if (!registry.find(target)) {
                throw new Error(
                    `agents.${spec.name}.fork.agents: unknown agent "${target}" ` +
                        `(known: ${registry.names().join(', ')})`,
                );
            }
        }

        const binding = registry.get(spec.name).skills;
        if (!binding) {
            continue;
        }
        if (!ids.has(binding.provider)) {
            throw new Error(
                `agents.${spec.name}.skills.provider: unknown provider "${binding.provider}" ` +
                    `(known: ${[...ids].join(', ') || 'none'})`,
            );
        }
        const known = catalogs.get(binding.provider) ?? new Set<string>();
        for (const [key, names] of [
            ['allow', spec.skills?.allow],
            ['preload', spec.skills?.preload],
        ] as const) {
            for (const skill of names ?? []) {
                if (!known.has(skill)) {
                    throw new Error(
                        `agents.${spec.name}.skills.${key}: unknown skill "${skill}" ` +
                            `(catalog "${binding.provider}" has: ${[...known].join(', ') || 'none'})`,
                    );
                }
            }
        }
        // A skill that is preloaded but not allowed would be activated by the
        // runner and then hidden from the index — contradictory, and silent.
        for (const skill of spec.skills?.preload ?? []) {
            if (spec.skills?.allow && !spec.skills.allow.includes(skill)) {
                throw new Error(
                    `agents.${spec.name}.skills.preload: "${skill}" is not in \`allow\``,
                );
            }
        }
    }
}

/** Explicit `default:` wins, then an agent that claims it, then the first declared. */
function entrypoint(config: ProjectConfig): string {
    if (config.default) {
        const named = config.agents.find((a) => a.name === config.default);
        if (!named) {
            throw new Error(
                `default: unknown agent "${config.default}" ` +
                    `(declared: ${config.agents.map((a) => a.name).join(', ')})`,
            );
        }
        return named.name;
    }
    const claimed = config.agents.filter((a) => a.default);
    if (claimed.length > 1) {
        throw new Error(
            `more than one agent claims \`default: true\`: ${claimed.map((a) => a.name).join(', ')}`,
        );
    }
    return claimed[0]?.name ?? config.agents[0].name;
}
