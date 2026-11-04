import {
    SHAPES,
    auditModels,
    credentialFor,
    envNames,
    form,
    machinePluginTools,
    PLUGINS_ENV,
    resolveBuild,
    type DeclaredRole,
    type KeyStore,
    type Liveness,
    type ModelIssue,
    type ResolvedBuild,
    type Service,
} from '@zenera/engine';
import {
    EXA_GROUP,
    FileSkillProvider,
    PodmanBox,
    SANDBOX_MOUNT,
    exaTools,
    fileTools,
    frontmatter,
    projectRegistry,
    readProjectConfig,
    sandboxTools,
    selectTools,
    toList,
    type AgentConfig,
    type AnyTool,
    type EmbeddingRef,
    type ModelRef,
    type ProjectConfig,
    type Runner,
    type SkillSummary,
} from '@zenera/neo';
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    realpathSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { probeModels, type ModelTarget } from './liveness.ts';
import { BuildError, ensurePodmanReady } from './podman.ts';
import { ownVersion, staleShared } from './scaffold.ts';

// ---------------------------------------------------------------------------
// The project check
//
// The loader already validates everything here — and stops at the first thing
// it does not like, with the offending key named. That is exactly right for a
// run: nothing should start on a project that will not hold together.
//
// It is exactly wrong for someone *fixing* the project. A first error is a
// keyhole: fix it, run again, find the next one, six times. So this walks the
// same ground and refuses to stop, collecting every finding it can reach, and
// says what it found rather than throwing it.
//
// Two consequences shape the whole module. Nothing here throws for a problem
// *in the project* — a throw would end the walk and cost the findings after it
// — so every check that could throw is wrapped and turned into a `Finding`.
// And nothing here *needs* a credential or a network: a check that only works
// on a machine already set up is no use to the machine that is not.
//
// Two steps are the exception, and both are deliberate. A Dockerfile that does
// not build is a broken project, and nothing short of building it says so — the
// file parses, the path exists, and the failure waits for the first run. So the
// check builds it and runs one command in it, against a temporary directory
// rather than anyone's workspace, and takes the container down again on the way
// out. For the same reason it asks each model it can pay for to answer once: a
// credential that authenticates says nothing about the model id it is spent on,
// so a misspelt or retired id is invisible to every reading of the files.
// `--no-sandbox` and `--no-models` turn them off. A missing container engine, or
// a provider that never answered, stays a warning — the machine that is not set
// up yet is still owed the rest.
// ---------------------------------------------------------------------------

/**
 * `error` — the project will not load, or will not run.
 * `warning` — it loads, and something about it is probably not what was meant.
 * `note` — worth knowing, wrong in no sense at all.
 */
export type Severity = 'error' | 'warning' | 'note';

export interface Finding {
    severity: Severity;
    /** stable identifier, e.g. `prompt.missing` — safe to match on */
    code: string;
    /** the config key or path this is about, e.g. `agents.triage.system` */
    where: string;
    message: string;
    /** what to do about it, naming a file or a command */
    fix?: string;
}

export interface FileCheck {
    /** relative to the project root */
    path: string;
    /** what the file is for, in words */
    role: string;
    kind: 'file' | 'directory';
    exists: boolean;
    /** the project does not load without it */
    required: boolean;
    bytes?: number;
    /** the config key that named it, when a key did rather than a convention */
    from?: string;
}

export interface AgentReport {
    name: string;
    /** the agent a bare `zen run` starts on */
    entry: boolean;
    description?: string;
    /** the model as written, before aliases are resolved */
    model?: string;
    /** where that value came from */
    modelSource: 'agent' | 'project' | 'none';
    /** prompt files, in the order they are concatenated */
    instructions: string[];
    /** `tools:` as written */
    toolSelectors: string[];
    /** what those selectors resolve to */
    tools: string[];
    handoffs: string[];
    skills?: {
        provider: string;
        discovery: string;
        allow?: string[];
        preload?: string[];
    };
    fork?: { agents?: string[]; maxBranches?: number };
    /** true when the agent overrides the project's container */
    ownSandbox: boolean;
}

export interface SkillReport {
    name: string;
    description: string;
    /** the SKILL.md, relative to the project root */
    path: string;
    tools?: string[];
    /** other files in the skill folder, which the agent can reach under /skills */
    files?: string[];
    /** agents whose binding can see it */
    usedBy: string[];
}

export interface ModelReport {
    /** the alias it is declared under, or the reference itself */
    name: string;
    /** what `name` resolves to, when it is an alias rather than a reference */
    ref?: string;
    /** what the config declared it for */
    role: DeclaredRole;
    /** the provider it resolves to */
    provider?: string;
    kind?: string;
    /** the variable that would carry the credential */
    env?: string;
    credential: 'present' | 'missing' | 'rejected' | 'unknown';
    detail?: string;
    /** the provider's own answer, when the model was actually asked */
    check?: { state: Liveness; detail?: string; fix?: string; ms: number };
    /** agents that would use it */
    usedBy: string[];
}

export interface Report {
    /** no errors — the project loads */
    ok: boolean;
    project: {
        name: string | null;
        root: string;
        /** whether the registry knows this path, i.e. whether `zen list` shows it */
        registered: boolean;
        /** the config file that wins, relative to the root */
        config: string | null;
        /** other config files present, which the loader will ignore */
        shadowed: string[];
        version: number | null;
        entry: string | null;
    };
    files: FileCheck[];
    agents: AgentReport[];
    skills: {
        /** the directories the catalog is built from */
        dirs: string[];
        entries: SkillReport[];
    };
    providers: string[];
    models: ModelReport[];
    sandbox: {
        image: string | null;
        /** the Dockerfile that image is built from, when it is built rather than pulled */
        dockerfile: string | null;
        declared: boolean;
        used: boolean;
        /** whether the image was actually built and a container started */
        probed: boolean;
    };
    findings: Finding[];
    counts: { errors: number; warnings: number; notes: number };
}

export interface ValidateOptions {
    /** the project directory */
    dir: string;
    /** the registered name, when there is one */
    name?: string;
    /**
     * Whether the registry knows this path. Passed in rather than looked up,
     * because nothing in this check may depend on `$HOME` being readable: the
     * machine that is not set up yet is the one that most needs the report.
     */
    registered?: boolean;
    /**
     * The keyring, materialised. Given, every model the project names is
     * checked for a credential; omitted, that section says `unknown` and no
     * finding is raised — a project is not invalid because this laptop cannot
     * pay for it.
     */
    keys?: KeyStore;
    /**
     * Whether to build the image and start a container. Everything else here
     * is a reading of files; this is the one part that runs something, so it
     * is named separately and can be turned off.
     */
    sandbox?: {
        enabled: boolean;
        engine?: string;
        /** the test seam, as elsewhere — a check can be watched without an engine */
        exec?: Runner;
        /** called with each slow step, so the caller can narrate one */
        onProgress?: (what: string) => void;
    };
    /**
     * Whether to ask each model that has a credential to answer once. Costs a
     * few tokens apiece and needs the network, so like the sandbox it is named
     * separately. Without `keys` there is nothing to ask with and it is skipped.
     */
    models?: {
        enabled: boolean;
        onProgress?: (what: string) => void;
    };
}

// Mirrors the loader's own constants (`packages/neo/src/project/load.ts`).
// Duplicated rather than exported, because a check that agreed with the loader
// by construction could not report that the two had diverged.
const CONFIG_NAMES = ['agents.yaml', 'agents.yml', 'agents/agents.yaml', 'agents/agents.yml'];
const AGENTS_DIR = 'agents';
const HOUSE_RULES = 'agents/instructions.md';
const INSTRUCTIONS_SUFFIX = '-instructions.md';
/** How file tools are used; without it the model has schemas only. */
const FILE_RULES = 'agents/files-instructions.md';
/** The only place memory is explained to a model; the runtime composes none of it. */
const MEMORY_RULES = 'agents/memory-instructions.md';
/** The only place forking is explained to a model; the same holds. */
const FORK_RULES = 'agents/fork-instructions.md';
/** The conditioned documents `zen` ships, which land whether or not they apply. */
const OURS = new Set([FILE_RULES, MEMORY_RULES, FORK_RULES]);
const PROMPTS_DIR = 'agents/prompts';
const SKILLS_DIR = 'agents/skills';
const SKILL_FILE = 'SKILL.md';
const ASSETS_DIR = 'assets';

/** What `allow:` and `preload:` accept, so a skill outside it cannot be named. */
const REFERABLE = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

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

/** What `requires:` may name. Mirrors `CAPABILITIES` in the loader. */
const CAPABILITIES: Record<string, (spec: AgentConfig) => boolean> = {
    fork: (spec) => Boolean(spec.fork),
    memory: (spec) => Boolean(spec.memory),
    'memory-write': (spec) =>
        spec.memory?.access === 'read-write' || spec.memory?.access === 'full',
    'memory-forget': (spec) => spec.memory?.access === 'full',
    files: (spec) => hasFileTools(spec),
    'files-write': (spec) => hasFileWriteTools(spec),
    workspace: (spec) => hasFileTools(spec),
    'workspace-write': (spec) => hasFileWriteTools(spec),
};

/** A house-rules document as found on disk, with what its frontmatter asked for. */
interface RuleFile {
    rel: string;
    requires: string[];
}

/**
 * Mirrors `readHouseRules` in the loader, in the same order:
 * `agents/instructions.md`, then every `agents/<topic>-instructions.md` by
 * filename — each with the `requires:` its frontmatter declared.
 */
function houseRules(root: string): RuleFile[] {
    const found: RuleFile[] = [];
    const take = (rel: string): void => {
        const path = join(root, rel);
        if (!existsSync(path)) {
            return;
        }
        const { data } = frontmatter(readFileSync(path, 'utf8'));
        found.push({ rel, requires: toList(data.requires) });
    };
    take(HOUSE_RULES);
    const dir = join(root, AGENTS_DIR);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
        return found;
    }
    const topics = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(INSTRUCTIONS_SUFFIX))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
    for (const name of topics) {
        take(`${AGENTS_DIR}/${name}`);
    }
    return found;
}

/**
 * The documents this agent's prompt actually gets. Unknown capabilities are
 * reported once, against the file, rather than silently excluding every agent.
 */
function rulesFor(rules: RuleFile[], spec: AgentConfig): string[] {
    return rules
        .filter((r) => r.requires.every((cap) => CAPABILITIES[cap]?.(spec) ?? true))
        .map((r) => r.rel);
}

export async function validateProject(opts: ValidateOptions): Promise<Report> {
    const root = resolve(opts.dir);
    const findings: Finding[] = [];
    const files: FileCheck[] = [];
    const agents: AgentReport[] = [];
    const skills: SkillReport[] = [];
    const models: ModelReport[] = [];
    let skillDirs: string[] = [];
    let providers: string[] = [];
    let config: ProjectConfig | undefined;
    let configPath: string | null = null;
    let shadowed: string[] = [];
    let entry: string | null = null;
    let registered = opts.registered ?? false;
    let name = opts.name ?? null;
    let build: ResolvedBuild | undefined;
    let probed = false;

    const add = (f: Finding): void => {
        findings.push(f);
    };

    const record = (
        rel: string,
        role: string,
        kind: 'file' | 'directory',
        required: boolean,
        from?: string,
    ): boolean => {
        const path = join(root, rel);
        const stat = existsSync(path) ? statSync(path) : undefined;
        const exists = Boolean(stat) && (kind === 'file' ? stat!.isFile() : stat!.isDirectory());
        files.push({
            path: rel,
            role,
            kind,
            exists,
            required,
            ...(stat?.isFile() ? { bytes: stat.size } : {}),
            ...(from ? { from } : {}),
        });
        return exists;
    };

    const done = (): Report =>
        finish(root, name, registered, configPath, shadowed, {
            version: config?.version ?? null,
            entry,
            files,
            agents,
            skills,
            skillDirs,
            providers,
            models,
            sandbox: sandboxSummary(config, agents, build, probed),
            findings,
        });

    // -----------------------------------------------------------------------
    // The directory itself
    // -----------------------------------------------------------------------

    if (!existsSync(root) || !statSync(root).isDirectory()) {
        add({
            severity: 'error',
            code: 'root.missing',
            where: root,
            message: 'not a directory, so there is no project here to check',
            fix: `create one: zen init ${root}`,
        });
        return done();
    }

    // A project is a directory the loader can read; being *listed* is a
    // separate question, and one the caller has already answered — the registry
    // lives in `$HOME`, which this check does not read.
    if (!registered) {
        add({
            severity: 'warning',
            code: 'project.unregistered',
            where: root,
            message:
                'this directory is not registered, so `zen open` and `zen list` will not ' +
                'find it by name (naming it by path, as now, works either way)',
            fix: `register it: zen init ${root}`,
        });
    }

    // -----------------------------------------------------------------------
    // agents.yaml: which one, and does it parse
    // -----------------------------------------------------------------------

    const found = CONFIG_NAMES.filter((n) => existsSync(join(root, n)));
    configPath = found[0] ?? null;
    shadowed = found.slice(1);
    for (const n of CONFIG_NAMES) {
        if (existsSync(join(root, n))) {
            record(
                n,
                n === configPath ? 'project configuration' : 'ignored: another config wins',
                'file',
                false,
            );
        }
    }
    if (!configPath) {
        record(CONFIG_NAMES[0], 'project configuration', 'file', true);
        add({
            severity: 'error',
            code: 'config.missing',
            where: root,
            message:
                'no project configuration — the loader looks for ' +
                `${CONFIG_NAMES.join(', ')} and found none of them`,
            fix: `scaffold one: zen init ${root} --force`,
        });
        return done();
    }
    if (shadowed.length) {
        add({
            severity: 'warning',
            code: 'config.shadowed',
            where: shadowed.join(', '),
            message:
                `more than one project configuration is present; the loader takes the ` +
                `first it finds (${configPath}) and never reads ${shadowed.join(', ')}`,
            fix: `delete the ones that are not in use, or merge them into ${configPath}`,
        });
    }

    try {
        config = readProjectConfig(root).config;
    } catch (err) {
        for (const f of parseFailure(err, configPath)) {
            add(f);
        }
        // The schema failed, so nothing below can be trusted to have the shape
        // it reads. The file inventory is still worth having: it is what says
        // whether the prompts a broken config points at are even there.
        inventory(root, record);
        return done();
    }

    // -----------------------------------------------------------------------
    // Files the config and the conventions name
    // -----------------------------------------------------------------------

    const rules = houseRules(root);
    for (const { rel, requires } of rules) {
        record(rel, 'house rules — prepended to every agent prompt', 'file', false);
        if (empty(join(root, rel))) {
            add({
                severity: 'warning',
                code: 'house-rules.empty',
                where: rel,
                message: `${rel} is empty, so it contributes nothing but a prompt section`,
                fix: 'write the rules that hold whichever agent is answering, or delete it',
            });
        }
        for (const cap of requires) {
            if (!(cap in CAPABILITIES)) {
                add({
                    severity: 'error',
                    code: 'rules.requires.unknown',
                    where: rel,
                    message:
                        `\`requires: ${cap}\` names no capability, so the loader refuses the ` +
                        'project',
                    fix: `use one of: ${Object.keys(CAPABILITIES).join(', ')}`,
                });
            }
        }
        // Ours are copied into every project whether or not it uses the
        // capability, so an inert one says nothing about the project. One the
        // project wrote is different: it was written to be read.
        const reached = config.agents.some((a) => rulesFor([{ rel, requires }], a).length > 0);
        if (requires.length && !reached && !OURS.has(rel)) {
            add({
                severity: 'note',
                code: 'rules.unreached',
                where: rel,
                message: `no agent has ${requires.join(' and ')}, so this document reaches no prompt`,
                fix: 'relax `requires:`, or give an agent the capability it is written for',
            });
        }
    }
    if (rules.length === 0) {
        record(HOUSE_RULES, 'house rules — prepended to every agent prompt', 'file', false);
        add({
            severity: 'note',
            code: 'house-rules.missing',
            where: HOUSE_RULES,
            message:
                'no house rules, which is allowed: every agent then runs on its own role ' +
                'prompt alone, with nothing shared between them',
        });
    }

    // The runtime composes the preference block and nothing else, so this file
    // is the whole of what an agent is told about memory. Without it the tools
    // are still granted and still callable, with only their schemas to go on -
    // which is not a project that works less well, it is one that will write
    // the graph wrong and cannot be told otherwise.
    if (config.agents.some((a) => a.memory) || config.memory) {
        const path = join(root, MEMORY_RULES);
        if (!existsSync(path) || empty(path)) {
            add({
                severity: 'error',
                code: 'memory.uninstructed',
                where: MEMORY_RULES,
                message:
                    'memory is on, but nothing tells an agent how to use it — the memory_* ' +
                    'tools are granted with only their schemas to explain them',
                fix: 'zen check --fix, which writes the current rules back',
            });
        }
    }

    // The same again for forking, and for the same reason: the runtime used to
    // compose this block and no longer does, so the file is the whole of what
    // an agent is told about what survives a join.
    if (config.agents.some((a) => a.fork)) {
        const path = join(root, FORK_RULES);
        if (!existsSync(path) || empty(path)) {
            add({
                severity: 'error',
                code: 'fork.uninstructed',
                where: FORK_RULES,
                message:
                    'an agent can fork, but nothing tells it what a branch can and cannot do — ' +
                    'the fork tool is granted with only its schema to explain it',
                fix: 'zen check --fix, which writes the current rules back',
            });
        }
    }

    // The same again for file operations: the file tools need instructions on
    // discovery, safe reading, and patching. Without them the tools are granted
    // with only their schemas to explain them.
    if (config.agents.some((a) => hasFileTools(a))) {
        const path = join(root, FILE_RULES);
        if (!existsSync(path) || empty(path)) {
            add({
                severity: 'error',
                code: 'files.uninstructed',
                where: FILE_RULES,
                message:
                    'an agent has file tools, but nothing tells it how to use them — ' +
                    'the tools are granted with only their schemas to explain them',
                fix: 'zen check --fix, which writes the current rules back',
            });
        }
    }

    // Present is not the same as current. These files are copies of ours
    // and nobody is meant to be maintaining them, so bytes that differ are an
    // older `zen`'s — prose about a runtime that has since moved, which reads
    // exactly as authoritative as the version that is true. The frontmatter
    // that conditions them arrived this way: every project scaffolded before it
    // carries a copy that reaches every agent, memory or no memory.
    for (const rel of staleShared(root)) {
        // An empty one is already reported, as missing or as empty.
        if (empty(join(root, rel))) {
            continue;
        }
        add({
            severity: 'warning',
            code: 'rules.stale',
            where: rel,
            message:
                `${rel} is not the copy this \`zen\` ships — it came from an older version, ` +
                'or was edited in place, and either way it describes behaviour that may no ' +
                'longer be the behaviour',
            fix: 'zen check --fix, which replaces it; rules of your own belong in a topic file beside it',
        });
    }

    // -----------------------------------------------------------------------
    // Agents
    // -----------------------------------------------------------------------

    const declaredNames = config.agents.map((a) => a.name);
    for (const [duplicate, times] of tally(declaredNames)) {
        if (times > 1) {
            add({
                severity: 'error',
                code: 'agent.duplicate',
                where: `agents.${duplicate}`,
                message: `declared ${times} times; a later entry silently replaces the earlier`,
                fix: 'give each agent its own name',
            });
        }
    }

    entry = entrypoint(config, add);

    // The tools a `zen run` would actually offer, so a selector is checked
    // against the real set rather than a list written down twice: the built-ins
    // and whatever the plugins `ZEN_PLUGINS` names add.
    const builtins = availableTools(root, config);
    const plugged = await machinePluginTools(
        { dir: root, name: name ?? basename(root) },
        builtins,
        {
            warn: (message) =>
                add({
                    severity: 'warning',
                    code: 'plugins.load',
                    where: PLUGINS_ENV,
                    message,
                    fix: `fix or remove the entry in ${PLUGINS_ENV}; projects naming its tools will not load`,
                }),
        },
    );
    const available = [...builtins, ...plugged];

    for (const spec of config.agents) {
        agents.push(checkAgent(root, config, spec, entry, available, rules, record, add));
    }

    checkReturnPaths(config, add);

    // -----------------------------------------------------------------------
    // Skills
    // -----------------------------------------------------------------------

    const catalog = await checkSkills(root, config, available, record, add);
    skillDirs = catalog.dirs;
    skills.push(...catalog.entries);
    bindSkills(config, skills, catalog.names, add);

    // -----------------------------------------------------------------------
    // Assets
    // -----------------------------------------------------------------------

    checkAssets(root, config, record, add);

    // -----------------------------------------------------------------------
    // The sandbox
    // -----------------------------------------------------------------------

    build = checkSandbox(root, config, record, add);

    // -----------------------------------------------------------------------
    // Models and credentials
    // -----------------------------------------------------------------------

    // Nothing to ask with is the same as not asking: the missing credential is
    // already a finding, and a call that cannot be made teaches nothing twice.
    const asking = opts.models?.enabled && opts.keys ? opts.models : undefined;
    const resolved = checkModels(root, config, opts.keys, add, Boolean(asking));
    providers = resolved.providers;
    models.push(...resolved.models);

    checkServices(agents, available, opts.keys, add);

    // Last, and in this order, because these are the two steps that leave the
    // machine: everything a reading of the files can tell you is already on the
    // report by now, so an interrupted check is still a useful one.
    if (asking && resolved.targets.length) {
        await askModels(resolved.targets, asking, add);
    }
    if (opts.sandbox?.enabled && sandboxSummary(config, agents).used) {
        probed = await probeSandbox(config, build, opts.sandbox, add);
    }

    return done();
}

/**
 * One round trip per model, and a verdict per model.
 *
 * A refusal is an error: the provider looked at this reference and said no, and
 * every run of this project will meet the same answer. Silence is a warning —
 * it is the network's problem, not the project's, and a report that failed
 * because a train went into a tunnel would teach the wrong lesson.
 *
 * A *blocked* model is an error too, but a different one: the credential was
 * accepted and the account then refused, so the fix is the vendor's own —
 * enabling an api, adding credit, choosing a model this account is granted.
 * Telling someone to check their spelling there costs them an afternoon.
 */
async function askModels(
    targets: readonly [ModelReport, ModelTarget][],
    opts: NonNullable<ValidateOptions['models']>,
    add: Add,
): Promise<void> {
    opts.onProgress?.(`asking ${targets.length} model${targets.length === 1 ? '' : 's'}`);
    const probes = await probeModels(
        targets.map(([, target]) => target),
        (target, done, total) => opts.onProgress?.(`asked ${target.ref} … ${done}/${total}`),
    );
    probes.forEach((probe, i) => {
        const [report] = targets[i]!;
        report.check = {
            state: probe.check.state,
            ...(probe.check.detail ? { detail: probe.check.detail } : {}),
            ...(probe.check.fix ? { fix: probe.check.fix } : {}),
            ms: probe.ms,
        };
        if (probe.check.state === 'live') {
            return;
        }
        const where = named(report);
        if (probe.check.state === 'blocked') {
            const list = report.role === 'embedding' ? '--embeddings' : '--chat';
            add({
                severity: 'error',
                code: `${report.role}.blocked`,
                where,
                message: `the credential was accepted and then refused: ${probe.check.detail ?? 'no reason given'}`,
                fix: `${probe.check.fix ?? 'resolve it in the vendor console'}, or find one that works: zen models ls ${list}`,
            });
            return;
        }
        add(
            probe.check.state === 'dead'
                ? {
                      severity: 'error',
                      code: `${report.role}.refused`,
                      where,
                      message: `the provider refused it: ${probe.check.detail ?? 'no reason given'}`,
                      fix: `check that ${probe.id} is spelt right, still served, and granted to this account`,
                  }
                : {
                      severity: 'warning',
                      code: `${report.role}.unreachable`,
                      where,
                      message: `it could not be asked: ${probe.check.detail ?? 'no answer'}`,
                      fix: 'try again, or pass --no-models to skip this',
                  },
        );
    });
}

/**
 * A tool that needs a key of its own is invisible to the model audit, which
 * walks `models:` and finds nothing to say about `web_search`. The project is
 * still valid — the credential is read at call time and a missing one is a
 * failed turn, not a failed load — so this is a warning, and only when the
 * keyring was readable at all.
 */
function checkServices(
    agents: AgentReport[],
    available: AnyTool<unknown>[],
    keys: KeyStore | undefined,
    add: Add,
): void {
    if (!keys) {
        return;
    }
    const byService: Record<Service, Set<string>> = {
        exa: new Set(available.filter((t) => t.group === EXA_GROUP).map((t) => t.name)),
    };
    for (const [service, names] of Object.entries(byService) as [Service, Set<string>][]) {
        const users = agents.filter((a) => a.tools.some((t) => names.has(t)));
        if (users.length === 0) {
            continue;
        }
        const shape = SHAPES[service];
        if (envNames(service).some((name) => process.env[name]) || keys.active(service)) {
            continue;
        }
        add({
            severity: 'warning',
            code: 'service.credential',
            where: users.map((a) => `agents.${a.name}`).join(', '),
            message:
                `uses the ${shape.label} tools, and nothing on this machine holds a ` +
                `${shape.label} key — those tools will refuse every call`,
            fix: `zen key add ${service}, or set $${form(service).env}`,
        });
    }
}

// ---------------------------------------------------------------------------
// The config file
// ---------------------------------------------------------------------------

/**
 * Turns a loader failure back into findings.
 *
 * `parseConfig` already renders every schema issue, one indented line each —
 * so the message is a report that has been flattened into a string, and this
 * unflattens it. A yaml syntax error arrives as a single line instead, and
 * carries its own line and column, which is the one thing worth keeping.
 */
function parseFailure(err: unknown, where: string): Finding[] {
    const message = err instanceof Error ? err.message : String(err);
    const lines = message.split('\n');
    const issues = lines
        .slice(1)
        .map((l) => l.trim())
        .filter(Boolean);

    if (!issues.length) {
        return [
            {
                severity: 'error',
                code: 'config.unreadable',
                where,
                message: lines[0].replace(/^.*?: /, ''),
                fix: 'fix the syntax — nothing else can be checked until the file parses',
            },
        ];
    }

    return issues.map((issue) => {
        const [key, ...rest] = issue.split(' — ');
        return {
            severity: 'error' as const,
            code: 'config.invalid',
            where: `${where}: ${key}`,
            message: rest.join(' — ') || issue,
            fix: 'see docs/agents-yaml.md for the keys this file accepts',
        };
    });
}

/** The layout, whether or not a config named any of it. */
function inventory(root: string, record: Recorder): void {
    record(HOUSE_RULES, 'house rules — prepended to every agent prompt', 'file', false);
    record(PROMPTS_DIR, 'role prompts, one per agent, by convention', 'directory', false);
    record(SKILLS_DIR, 'skill catalog', 'directory', false);
}

type Recorder = (
    rel: string,
    role: string,
    kind: 'file' | 'directory',
    required: boolean,
    from?: string,
) => boolean;

type Add = (f: Finding) => void;

/** Replicates the loader's `entrypoint`, reporting instead of throwing. */
function entrypoint(config: ProjectConfig, add: Add): string | null {
    const names = config.agents.map((a) => a.name);
    if (config.default) {
        if (!names.includes(config.default)) {
            add({
                severity: 'error',
                code: 'entry.unknown',
                where: 'default',
                message: `unknown agent "${config.default}" (declared: ${names.join(', ')})`,
                fix: 'name one of the declared agents, or drop the key and let the first win',
            });
            return null;
        }
        return config.default;
    }
    const claimed = config.agents.filter((a) => a.default);
    if (claimed.length > 1) {
        add({
            severity: 'error',
            code: 'entry.ambiguous',
            where: 'agents[].default',
            message:
                `${claimed.map((a) => a.name).join(' and ')} both claim \`default: true\`, ` +
                'so which agent a bare `zen run` starts on is undecided',
            fix: 'leave it on one of them, or settle it with a top-level `default:`',
        });
        return null;
    }
    return claimed[0]?.name ?? names[0] ?? null;
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export function availableTools(root: string, config: ProjectConfig): AnyTool<unknown>[] {
    // Constructed, not started: a pool creates its container on the first
    // command, so naming one here costs nothing and needs no container engine.
    return [
        ...fileTools<unknown>({
            root,
            mount: config.sandbox?.workdir ?? SANDBOX_MOUNT,
        }),
        ...sandboxTools<unknown>({ root, key: 'check' }),
        ...exaTools<unknown>(),
    ];
}

function checkAgent(
    root: string,
    config: ProjectConfig,
    spec: AgentConfig,
    entry: string | null,
    available: AnyTool<unknown>[],
    rules: RuleFile[],
    record: Recorder,
    add: Add,
): AgentReport {
    const where = `agents.${spec.name}`;
    const instructions: string[] = rulesFor(rules, spec);

    // The role prompt: named by `system:`, or found by convention. A named one
    // that is not there is an error — the loader says so too. An absent
    // conventional one is not, because a project may keep everything it has to
    // say in its house rules.
    if (spec.system) {
        const rel = normalise(root, spec.system);
        const outside = rel === undefined;
        const exists = outside
            ? false
            : record(rel, `role prompt for agent "${spec.name}"`, 'file', true, `${where}.system`);
        if (outside) {
            add({
                severity: 'error',
                code: 'prompt.outside',
                where: `${where}.system`,
                message: `"${spec.system}" resolves outside the project root, which is refused`,
                fix: 'keep prompts inside the project so it stays portable',
            });
        } else if (!exists) {
            add({
                severity: 'error',
                code: 'prompt.missing',
                where: `${where}.system`,
                message: `no such file: ${rel} — the project will not load`,
                fix: `create ${rel}, or point \`system:\` at a file that exists`,
            });
        } else {
            instructions.push(rel);
            if (empty(join(root, rel))) {
                add({
                    severity: 'warning',
                    code: 'prompt.empty',
                    where: `${where}.system`,
                    message: `${rel} is empty, so this agent has no instructions of its own`,
                    fix: `write what this agent is for in ${rel}`,
                });
            }
        }
    } else {
        const rel = join(PROMPTS_DIR, `${spec.name}.md`);
        const exists = record(
            rel,
            `role prompt for agent "${spec.name}" (by convention)`,
            'file',
            false,
        );
        if (exists) {
            instructions.push(rel);
        }
    }

    if (instructions.length === 0) {
        add({
            severity: 'warning',
            code: 'agent.no-instructions',
            where,
            message:
                'this agent has no prompt at all — no house rules and no role file — so ' +
                'it runs on the tool descriptions alone',
            fix: `write ${join(PROMPTS_DIR, `${spec.name}.md`)}, or name one with \`system:\``,
        });
    }

    // Tools
    const selectors = spec.tools ?? [];
    let tools: string[] = [];
    if (selectors.length) {
        let resolved = true;
        try {
            tools = selectTools(available, [...selectors], {
                where: `${where}.tools`,
                hint: 'this CLI provides the files and sandbox groups',
            }).map((t) => t.name);
        } catch (err) {
            resolved = false;
            add({
                severity: 'error',
                code: 'tools.unresolved',
                where: `${where}.tools`,
                message:
                    (err instanceof Error
                        ? err.message.replace(`${where}.tools: `, '')
                        : String(err)) + ' — `zen run` will refuse to load the project',
                fix:
                    'correct the name, or drop it. A tool this CLI does not ship reaches an ' +
                    `agent through a plugin: ${PLUGINS_ENV} on this machine, or a TypeScript ` +
                    'host passing it to openEngine',
            });
        }
        if (resolved && tools.length === 0) {
            add({
                severity: 'warning',
                code: 'tools.empty',
                where: `${where}.tools`,
                message: `${selectors.join(', ')} resolves to no tools at all`,
                fix: 'a selector that subtracts everything it added leaves nothing behind',
            });
        }
    } else {
        add({
            severity: 'note',
            code: 'tools.none',
            where,
            message:
                'no `tools:`, so this agent can only talk, hand off and use whatever a ' +
                'skill unlocks',
        });
    }

    // Hand-offs
    for (const target of spec.handoffs ?? []) {
        if (target === spec.name) {
            add({
                severity: 'error',
                code: 'handoff.self',
                where: `${where}.handoffs`,
                message: 'an agent cannot hand off to itself',
                fix: 'remove the entry',
            });
        } else if (!config.agents.some((a) => a.name === target)) {
            add({
                severity: 'error',
                code: 'handoff.unknown',
                where: `${where}.handoffs`,
                message:
                    `unknown agent "${target}" (declared: ` +
                    `${config.agents.map((a) => a.name).join(', ')})`,
                fix: `declare "${target}" under \`agents:\`, or correct the spelling`,
            });
        }
    }

    // Forks
    const fork = spec.fork === true ? {} : spec.fork === false ? undefined : spec.fork;
    for (const target of fork?.agents ?? []) {
        if (!config.agents.some((a) => a.name === target)) {
            add({
                severity: 'error',
                code: 'fork.unknown',
                where: `${where}.fork.agents`,
                message:
                    `unknown agent "${target}" (declared: ` +
                    `${config.agents.map((a) => a.name).join(', ')})`,
                fix: `declare "${target}" under \`agents:\`, or correct the spelling`,
            });
        }
    }

    if (!spec.description && (config.agents.length > 1 || (spec.handoffs ?? []).length)) {
        add({
            severity: 'warning',
            code: 'agent.no-description',
            where,
            message:
                'no `description:` — it is what a sibling agent’s `transfer_to_' +
                `${spec.name}` +
                '` tool tells the model, so without it a hand-off is a guess',
            fix: 'one line saying what this agent is for',
        });
    }

    const model = spec.model ?? config.model;

    return {
        name: spec.name,
        entry: spec.name === entry,
        ...(spec.description ? { description: spec.description } : {}),
        ...(model ? { model } : {}),
        modelSource: spec.model ? 'agent' : config.model ? 'project' : 'none',
        instructions,
        toolSelectors: [...selectors],
        tools,
        handoffs: [...(spec.handoffs ?? [])],
        ...(spec.skills
            ? {
                  skills: {
                      provider: spec.skills.provider ?? 'project',
                      discovery: spec.skills.discovery,
                      ...(spec.skills.allow ? { allow: [...spec.skills.allow] } : {}),
                      ...(spec.skills.preload ? { preload: [...spec.skills.preload] } : {}),
                  },
              }
            : {}),
        ...(fork ? { fork: { ...fork } } : {}),
        ownSandbox: Boolean(spec.sandbox),
    };
}

/**
 * Every hand-off must be returnable.
 *
 * A hand-off is a one-way door: control moves to the other agent and stays
 * there. Nothing hands it back on its own, so an agent reached by an edge that
 * has no way home owns the conversation for the rest of the session — the next
 * question, whatever it is about, is answered by the specialist the router sent
 * the user to. That is not a runtime error; it is a system that quietly stops
 * being the system that was drawn.
 *
 * So for every `A → B` there must be a path from B back to A. Indirect counts:
 * `B → C → A` is a way home, which is the same as saying every hand-off edge
 * lies on a cycle.
 *
 * Forks are exempt, and always will be. A branch runs, answers, and control
 * returns to the agent that forked it — the return is the mechanism, not an
 * edge someone has to remember to declare. An agent that wants an answer rather
 * than to give up the conversation should fork, not hand off.
 *
 * A warning rather than an error: the project loads, runs, and answers. What it
 * cannot do is come back. `--strict` is for the repository that wants that to
 * fail the build.
 */
function checkReturnPaths(config: ProjectConfig, add: Add): void {
    const known = new Set(config.agents.map((a) => a.name));
    // Unknown names and self-hand-offs are already errors of their own; walking
    // them here would only report the same mistake in a second vocabulary.
    const edges = new Map<string, string[]>(
        config.agents.map((a) => [
            a.name,
            (a.handoffs ?? []).filter((to) => to !== a.name && known.has(to)),
        ]),
    );

    const reaches = (from: string, to: string): boolean => {
        const seen = new Set([from]);
        const queue = [from];
        while (queue.length) {
            for (const next of edges.get(queue.shift()!) ?? []) {
                if (next === to) {
                    return true;
                }
                if (!seen.has(next)) {
                    seen.add(next);
                    queue.push(next);
                }
            }
        }
        return false;
    };

    for (const [from, targets] of edges) {
        for (const to of targets) {
            if (reaches(to, from)) {
                continue;
            }
            add({
                severity: 'warning',
                code: 'handoff.one-way',
                where: `agents.${from}.handoffs`,
                message:
                    `"${to}" has no way back to "${from}": nothing it can hand off to, ` +
                    `directly or through another agent, reaches "${from}" again. A hand-off ` +
                    `does not return by itself, so once control moves to "${to}" it stays ` +
                    `there — every later question in the session is answered by "${to}", ` +
                    'whether or not it is that agent’s job',
                fix:
                    `add "${from}" to agents.${to}.handoffs (or to the handoffs of an agent ` +
                    `"${to}" can reach), or — if "${from}" wants an answer rather than to give ` +
                    `up the conversation — drop the edge and declare fork: { agents: [${to}] } ` +
                    `on "${from}", because a branch returns on its own`,
            });
        }
    }
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

interface Catalog {
    dirs: string[];
    entries: SkillReport[];
    names: Set<string>;
}

async function checkSkills(
    root: string,
    config: ProjectConfig,
    available: AnyTool<unknown>[],
    record: Recorder,
    add: Add,
): Promise<Catalog> {
    const declared = config.skills
        ? Array.isArray(config.skills)
            ? config.skills
            : [config.skills]
        : existsSync(join(root, SKILLS_DIR))
          ? [SKILLS_DIR]
          : [];

    const dirs: string[] = [];
    for (const [i, ref] of declared.entries()) {
        const rel = normalise(root, ref);
        if (rel === undefined) {
            add({
                severity: 'error',
                code: 'skills.outside',
                where: `skills[${i}]`,
                message: `"${ref}" resolves outside the project root, which is refused`,
                fix: 'keep the catalog inside the project',
            });
            continue;
        }
        const named = config.skills !== undefined;
        const exists = record(
            rel,
            'skill catalog',
            'directory',
            named,
            named ? `skills[${i}]` : undefined,
        );
        if (!exists) {
            add({
                severity: 'error',
                code: 'skills.missing',
                where: `skills[${i}]`,
                message: `no such directory: ${rel} — the project will not load`,
                fix: `create ${rel}, or drop the \`skills:\` key`,
            });
            continue;
        }
        dirs.push(rel);
    }

    if (!dirs.length) {
        return { dirs, entries: [], names: new Set() };
    }

    const provider = new FileSkillProvider({
        id: 'project',
        dir: dirs.map((d) => join(root, d)),
        tools: available,
    });

    let summaries: SkillSummary[] = [];
    try {
        summaries = await provider.list();
    } catch (err) {
        add({
            severity: 'error',
            code: 'skills.unreadable',
            where: dirs.join(', '),
            message: err instanceof Error ? err.message : String(err),
        });
        return { dirs, entries: [], names: new Set() };
    }

    const entries: SkillReport[] = [];
    for (const summary of summaries) {
        const report: SkillReport = {
            name: summary.name,
            description: summary.description,
            path: '',
            usedBy: [],
        };
        // Loading is what resolves the skill's own `tools:` frontmatter, and
        // an unknown name there fails the *run*, not the load — so it is worth
        // paying a read to find out here.
        try {
            const skill = await provider.load(summary.name);
            report.path = display(root, skill.file ?? '');
            const files = siblings(skill.file);
            if (files.length) {
                report.files = files;
            }
            if (skill.tools?.length) {
                report.tools = skill.tools.map((t) => t.name);
            }
        } catch (err) {
            report.path = locate(root, dirs, summary.name) ?? '';
            add({
                severity: 'error',
                code: 'skill.unloadable',
                where: `skill "${summary.name}"`,
                message:
                    (err instanceof Error ? err.message : String(err)) +
                    ' — the skill is indexed, so the model can ask for it, and the turn ' +
                    'that does will fail',
                fix:
                    "correct the skill's `tools:` frontmatter, or provide the tool from a " +
                    'TypeScript host through ProjectOptions.tools',
            });
        }

        if (!REFERABLE.test(summary.name)) {
            add({
                severity: 'warning',
                code: 'skill.unreferable',
                where: `skill "${summary.name}"`,
                message:
                    `"${summary.name}" is not a name \`allow:\` or \`preload:\` accept — ` +
                    'those take lower-case words joined by "-" or "_", so this skill can be ' +
                    'discovered but never pinned',
                fix: `rename the file or folder, or set \`name:\` in its frontmatter`,
            });
        }
        if (!summary.description.trim()) {
            add({
                severity: 'warning',
                code: 'skill.no-description',
                where: `skill "${summary.name}"`,
                message:
                    'no description — the description is the whole of what the model sees ' +
                    'in the skill index, so an empty one means it is never chosen',
                fix: 'add `description:` to the frontmatter, or open the body with one line',
            });
        }
        entries.push(report);
    }

    for (const finding of ignored(root, dirs, new Set(summaries.map((s) => s.name)))) {
        add(finding);
    }

    return { dirs, entries, names: new Set(summaries.map((s) => s.name)) };
}

/**
 * Where a skill's markdown lives, for the report a failed `load` cannot fill
 * in. Best effort: a skill renamed by its frontmatter is not findable by name.
 */
function locate(root: string, dirs: string[], name: string): string | undefined {
    for (const dir of dirs) {
        for (const rel of [join(dir, name, 'SKILL.md'), join(dir, `${name}.md`)]) {
            if (existsSync(join(root, rel))) {
                return rel;
            }
        }
    }
    return undefined;
}

/** Anything in a catalog that is not a `<name>/SKILL.md` folder. */ function ignored(
    root: string,
    dirs: string[],
    known: Set<string>,
): Finding[] {
    const out: Finding[] = [];
    for (const dir of dirs) {
        let items;
        try {
            items = readdirSync(join(root, dir), { withFileTypes: true });
        } catch {
            continue;
        }
        for (const item of items) {
            // A bare `<name>.md` is still indexed, so this is not a skill that
            // went missing — it is one that can never grow a file of its own.
            if (item.isFile() && item.name.endsWith('.md')) {
                const folder = join(dir, item.name.slice(0, -'.md'.length));
                out.push({
                    severity: 'error',
                    code: 'skill.flat',
                    where: join(dir, item.name),
                    message:
                        'a skill is a folder holding SKILL.md — a bare markdown file has no ' +
                        'directory of its own, so it can never ship the table, example or ' +
                        'script that is half of what a skill is for',
                    fix: `move it to ${join(folder, SKILL_FILE)}`,
                });
                continue;
            }
            if (!item.isDirectory() || known.has(item.name)) {
                continue;
            }
            if (existsSync(join(root, dir, item.name, SKILL_FILE))) {
                // It has one; it is in the catalog under a frontmatter name.
                continue;
            }
            out.push({
                severity: 'warning',
                code: 'skill.no-skill-md',
                where: join(dir, item.name),
                message:
                    'a folder in the skill catalog with no SKILL.md is silently ignored, ' +
                    'so nothing in it will ever reach an agent',
                fix: `add ${join(dir, item.name, 'SKILL.md')}, or move the folder out of the catalog`,
            });
        }
    }
    return out;
}

/** `allow:` / `preload:` against the catalog that was actually read. */
function bindSkills(
    config: ProjectConfig,
    entries: SkillReport[],
    known: Set<string>,
    add: Add,
): void {
    const byName = new Map(entries.map((e) => [e.name, e]));
    const list = [...known].join(', ') || 'none';

    for (const spec of config.agents) {
        if (!spec.skills) {
            continue;
        }
        const where = `agents.${spec.name}.skills`;
        const provider = spec.skills.provider ?? 'project';
        if (provider !== 'project') {
            add({
                severity: 'error',
                code: 'skills.provider-unknown',
                where: `${where}.provider`,
                message:
                    `unknown provider "${provider}" — a project has one, called "project", ` +
                    'built from the `skills:` directories',
                fix: 'drop `provider:` and let it default',
            });
            continue;
        }
        // A contradiction inside the binding itself, so it is worth saying
        // whether or not there is a catalog to check the names against.
        for (const skill of spec.skills.preload ?? []) {
            if (spec.skills.allow && !spec.skills.allow.includes(skill)) {
                add({
                    severity: 'error',
                    code: 'skills.preload-not-allowed',
                    where: `${where}.preload`,
                    message:
                        `"${skill}" is preloaded but not in \`allow\`, so it would be ` +
                        'activated and then hidden from the index',
                    fix: `add "${skill}" to \`allow\`, or stop preloading it`,
                });
            }
        }
        if (!known.size) {
            add({
                severity: 'error',
                code: 'skills.no-catalog',
                where,
                message: 'this agent binds skills, but the project has no catalog to bind to',
                fix: 'add a top-level `skills:` directory, or create agents/skills/<name>/SKILL.md',
            });
            continue;
        }

        for (const [key, names] of [
            ['allow', spec.skills.allow],
            ['preload', spec.skills.preload],
        ] as const) {
            for (const skill of names ?? []) {
                if (!known.has(skill)) {
                    add({
                        severity: 'error',
                        code: `skills.${key}-unknown`,
                        where: `${where}.${key}`,
                        message: `unknown skill "${skill}" (the catalog has: ${list})`,
                        fix: 'the name is the frontmatter `name:`, or the folder name when it has none',
                    });
                }
            }
        }
        if (spec.skills.discovery === 'none' && !spec.skills.preload?.length) {
            add({
                severity: 'warning',
                code: 'skills.unreachable',
                where: `${where}.discovery`,
                message:
                    'discovery is `none` and nothing is preloaded, so this agent is bound ' +
                    'to a catalog it can never see into',
                fix: 'preload what it should always have, or use `index` or `search`',
            });
        }

        for (const skill of known) {
            if (!spec.skills.allow || spec.skills.allow.includes(skill)) {
                byName.get(skill)?.usedBy.push(spec.name);
            }
        }
    }

    for (const entry of entries) {
        if (entry.usedBy.length === 0) {
            add({
                severity: 'note',
                code: 'skill.unused',
                where: `skill "${entry.name}"`,
                message: 'no agent binds a catalog that includes it, so nothing can load it',
                fix: 'add `skills: {}` to an agent, or add it to that agent’s `allow:`',
            });
        }
    }
}

// ---------------------------------------------------------------------------
// Assets
//
// The folder every agent can read and none can write. It is a convention, so
// not having one is not a finding — but *naming* one that is not there is, and
// so is naming one so wide that the run's own working files are inside it.
// ---------------------------------------------------------------------------

function checkAssets(root: string, config: ProjectConfig, record: Recorder, add: Add): void {
    const named = config.assets !== undefined;
    const ref = config.assets ?? ASSETS_DIR;
    const rel = normalise(root, ref);
    if (rel === undefined) {
        add({
            severity: 'error',
            code: 'assets.outside',
            where: 'assets',
            message: `"${ref}" resolves outside the project root, which is refused`,
            fix: 'keep the material inside the project, or copy it in',
        });
        return;
    }
    // The conventional folder is optional; a project with nothing to share has
    // nothing to say about it.
    if (!named && !existsSync(join(root, rel))) {
        return;
    }

    const role = 'reference material, mounted read-only at /assets';
    if (!record(rel, role, 'directory', named, named ? 'assets' : undefined)) {
        add({
            severity: 'error',
            code: 'assets.missing',
            where: 'assets',
            message: `no such directory: ${rel} — the project will not load`,
            fix: `create ${rel}, or drop the \`assets:\` key`,
        });
        return;
    }

    const at = join(root, rel);
    // Mounting the project root, or anything holding the sessions directory,
    // hands every agent the transcripts of every run — including this one.
    if (rel === '' || rel === '.' || existsSync(join(at, 'sessions'))) {
        add({
            severity: 'warning',
            code: 'assets.overbroad',
            where: 'assets',
            message:
                `${rel || '.'} contains the project's own files, so every run's ` +
                'transcripts, prompts and configuration are readable by every agent',
            fix: 'point `assets:` at a directory that holds only what agents should read',
        });
        return;
    }

    if (contents(at).length === 0) {
        add({
            severity: 'note',
            code: 'assets.empty',
            where: 'assets',
            message: `${rel} is empty, so /assets is mounted with nothing in it`,
            fix: 'put something in it, or remove it',
        });
    }
}

function contents(dir: string): string[] {
    try {
        return readdirSync(dir);
    } catch {
        return [];
    }
}

// ---------------------------------------------------------------------------
// The sandbox
//
// Two halves. The first reads the `build:` block and says whether the files it
// names are there — cheap, and true on any machine. The second builds the
// image and runs one command in it, which is the only way to find out whether
// the Dockerfile works, and is the only thing in this module that starts
// anything.
// ---------------------------------------------------------------------------

/**
 * Resolves `sandbox.build:` and records the files it names. Returns what the
 * probe would build, or nothing when the project pulls an image instead.
 */
function checkSandbox(
    root: string,
    config: ProjectConfig,
    record: Recorder,
    add: Add,
): ResolvedBuild | undefined {
    const spec = config.sandbox?.build;
    if (!spec) {
        return undefined;
    }

    const file = normalise(root, spec.dockerfile);
    const context = spec.context === undefined ? undefined : normalise(root, spec.context);
    if (file === undefined || (spec.context !== undefined && context === undefined)) {
        add({
            severity: 'error',
            code: 'sandbox.outside',
            where: 'sandbox.build',
            message: 'the build resolves outside the project root, which is refused',
            fix: 'keep the Dockerfile and its context inside the project',
        });
        return undefined;
    }

    let ok = record(file, 'the sandbox image is built from this', 'file', true, 'sandbox.build');
    if (!ok) {
        add({
            severity: 'error',
            code: 'sandbox.dockerfile.missing',
            where: 'sandbox.build.dockerfile',
            message: `no such file: ${file} — the project will not load`,
            fix: `create ${file}, or replace \`build:\` with \`image: <ref>\``,
        });
    }
    if (context !== undefined) {
        const found = record(
            context,
            'what the sandbox build may COPY from',
            'directory',
            true,
            'sandbox.build.context',
        );
        if (!found) {
            add({
                severity: 'error',
                code: 'sandbox.context.missing',
                where: 'sandbox.build.context',
                message: `no such directory: ${context} — the project will not load`,
                fix: `create ${context}, or drop \`context:\` to use the Dockerfile's own folder`,
            });
        }
        ok &&= found;
    }
    if (!ok) {
        return undefined;
    }

    checkPin(join(root, file), file, add);

    try {
        return resolveBuild(root, config.sandbox);
    } catch (err) {
        add({
            severity: 'error',
            code: 'sandbox.build.invalid',
            where: 'sandbox.build',
            message: err instanceof Error ? err.message : String(err),
        });
        return undefined;
    }
}

/** `@zenera/cli`, and the version after it when the line pins one. */
const ZENERA_INSTALL = /@zenera\/([a-z0-9-]+)(?:@([^\s\\'"]+))?/g;

/**
 * Whether the Dockerfile's `@zenera/*` installs name this `zen`.
 *
 * `zen init` writes the version it was run by and never rewrites the file
 * again — the scaffold keeps what the project already has — so the pin is fixed
 * at creation and falls behind the host on the next upgrade. Nothing else
 * notices: the file parses, the image builds, and the container simply holds a
 * different `zen` than the session outside it, which is a mismatch that shows
 * up as a tool behaving unlike its documentation.
 *
 * Read rather than run, so it is true on the laptop with no container engine —
 * the one `--no-sandbox` leaves with no other word on the subject.
 */
function checkPin(path: string, rel: string, add: Add): void {
    let text: string;
    try {
        // Existence is already a finding; an unreadable file is not worth a
        // second one, and a throw here would cost every check after it.
        text = readFileSync(path, 'utf8');
    } catch {
        return;
    }

    const mine = ownVersion();
    const stale = new Set<string>();
    const loose = new Set<string>();
    for (const line of text.split('\n')) {
        // A comment naming the package is prose about the pin, not the pin.
        if (/^\s*#/.test(line)) {
            continue;
        }
        for (const match of line.matchAll(ZENERA_INSTALL)) {
            const name = `@zenera/${match[1]}`;
            const pinned: string | undefined = match[2];
            if (pinned === undefined) {
                loose.add(name);
            } else if (pinned !== mine) {
                stale.add(`${name}@${pinned}`);
            }
        }
    }

    const fix = `pin them to ${mine}, the version \`zen --version\` reports — \`zen check --fix\` does it`;
    if (stale.size > 0) {
        add({
            severity: 'warning',
            code: 'sandbox.pin.stale',
            where: rel,
            message:
                `installs ${[...stale].join(', ')}, but this \`zen\` is ${mine} — the CLI an ` +
                'agent runs inside the container is not the one that built the session',
            fix,
        });
    }
    if (loose.size > 0) {
        add({
            severity: 'warning',
            code: 'sandbox.pin.absent',
            where: rel,
            message:
                `installs ${[...loose].join(', ')} unpinned, so the next image build takes ` +
                'whatever is current and drifts away from the host without saying so',
            fix,
        });
    }
}

/**
 * Pins every `@zenera/*` install in the project's Dockerfile to this `zen`,
 * which is what `zen check --fix` does about `sandbox.pin.stale` and
 * `sandbox.pin.absent`. Only the version after each name is touched, and only
 * on lines `checkPin` reads, so whatever else the file holds is left alone.
 *
 * Returns the project-relative path when the file was rewritten, and nothing
 * when there is no Dockerfile, it resolves outside the project, or it already
 * pins this version — a project that does not load is the report's to explain.
 */
export function repinDockerfile(root: string): string[] {
    let rel: string | undefined;
    try {
        const ref = readProjectConfig(root).config.sandbox?.build?.dockerfile;
        rel = ref === undefined ? undefined : normalise(root, ref);
    } catch {
        return [];
    }
    if (rel === undefined) {
        return [];
    }

    const path = join(root, rel);
    let text: string;
    try {
        text = readFileSync(path, 'utf8');
    } catch {
        return [];
    }

    const mine = ownVersion();
    const next = text
        .split('\n')
        .map((line) =>
            /^\s*#/.test(line)
                ? line
                : line.replace(ZENERA_INSTALL, (_, name: string) => `@zenera/${name}@${mine}`),
        )
        .join('\n');
    if (next === text) {
        return [];
    }
    writeFileSync(path, next);
    return [rel.split(sep).join('/')];
}

/** Written by the smoke test and read back, to prove the mount is real. */
const SMOKE = 'zen-check';

/**
 * Builds the image and runs one command in it.
 *
 * The container is given a temporary directory rather than anybody's
 * workspace: this is a check, and a check that can write to the work is not
 * one. `persist` is off, so closing it removes it — a `zen check` that left a
 * container behind would be a slow leak nobody attributed to it.
 */
async function probeSandbox(
    config: ProjectConfig,
    build: ResolvedBuild | undefined,
    opts: NonNullable<ValidateOptions['sandbox']>,
    add: Add,
): Promise<boolean> {
    const image = build?.tag ?? config.sandbox?.image;
    const engine = opts.engine ?? 'podman';

    // The pre-flight narrates the build and the pull itself, so this only has
    // to cover the silence before it: installing, and starting a machine.
    opts.onProgress?.('checking the sandbox');
    try {
        await ensurePodmanReady({ image, build, engine, exec: opts.exec, yes: true });
    } catch (err) {
        if (err instanceof BuildError) {
            const rel = config.sandbox?.build?.dockerfile ?? 'the Dockerfile';
            add({
                severity: 'error',
                code: 'sandbox.build',
                where: 'sandbox.build.dockerfile',
                message: `${rel} does not build: ${err.hint ?? reason(err)}`,
                fix: 'run the build by hand to see the whole log',
            });
            return false;
        }
        // A laptop with no container engine is not a broken project, and this
        // report is most valuable on exactly that laptop.
        add({
            severity: 'warning',
            code: 'sandbox.unchecked',
            where: 'sandbox',
            message: `${reason(err)} — so the sandbox was not tried`,
            fix: 'run `zen sandbox up`, or pass --no-sandbox to skip this',
        });
        return false;
    }

    const root = realpathSync(mkdtempSync(join(tmpdir(), 'zen-check-')));
    const box = new PodmanBox({
        root,
        key: 'check',
        image,
        cpus: config.sandbox?.cpus,
        memory: config.sandbox?.memory,
        network: config.sandbox?.network,
        workdir: config.sandbox?.workdir,
        user: config.sandbox?.user,
        engine,
        exec: opts.exec,
        // Not the project's: a check forwards no host values, and keeping the
        // container is the caller's choice about their work, not about this.
        env: {},
        persist: false,
    });

    opts.onProgress?.(`starting ${image ?? 'the container'}`);
    try {
        const res = await box.exec(
            [
                `printf '%s\\n' ${SMOKE} > ${SMOKE}.txt`,
                `cat ${SMOKE}.txt`,
                `rm ${SMOKE}.txt`,
                'pwd',
            ].join('\n'),
            { timeout: 60 },
        );
        if (res.exit_code !== 0 || !res.stdout.includes(SMOKE)) {
            add({
                severity: 'error',
                code: 'sandbox.smoke',
                where: 'sandbox',
                message:
                    `${image} starts, but the workspace is not usable inside it: ` +
                    (res.stderr.trim().split('\n')[0] || `exit ${res.exit_code}`),
                fix: 'check `workdir:` and `user:` — the image must be able to write there',
            });
            return false;
        }
        return true;
    } catch (err) {
        add({
            severity: 'error',
            code: 'sandbox.start',
            where: 'sandbox',
            message: `could not start a container from ${image}: ${reason(err)}`,
            fix: 'run `zen sandbox status` to see what the engine says',
        });
        return false;
    } finally {
        await box.dispose().catch(() => undefined);
        rmSync(root, { recursive: true, force: true });
    }
}

function reason(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/**
 * What else is in a skill's folder — the files the agent reaches under /skills,
 * and the reason a skill can ship a script instead of describing one. A bare
 * `<name>.md` has no folder of its own, and its neighbours are other skills.
 */
function siblings(skillFile: string | undefined): string[] {
    if (!skillFile || basename(skillFile) !== SKILL_FILE) {
        return [];
    }
    const folder = dirname(skillFile);
    try {
        return readdirSync(folder, { withFileTypes: true })
            .filter((e) => e.name !== SKILL_FILE)
            .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
            .sort();
    } catch {
        return [];
    }
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

function checkModels(
    root: string,
    config: ProjectConfig,
    keys: KeyStore | undefined,
    add: Add,
    probe = false,
): {
    providers: string[];
    models: ModelReport[];
    targets: [ModelReport, ModelTarget][];
} {
    let registry;
    try {
        registry = projectRegistry(config);
    } catch (err) {
        add({
            severity: 'error',
            code: 'provider.invalid',
            where: 'providers',
            message: err instanceof Error ? err.message : String(err),
            fix: 'see the `providers:` section of docs/agents-yaml.md',
        });
        return { providers: [], models: [], targets: [] };
    }

    // Declared under an alias first, so an alias keeps its own name in the
    // report and a `model:` that names one collapses onto it. Mirrors the
    // credential audit, which is what the verdicts below are matched against.
    const declared = new Map<string, { ref: ModelRef; usedBy: string[] }>();
    for (const [alias, spec] of Object.entries(config.models ?? {})) {
        declared.set(alias, { ref: spec as ModelRef, usedBy: [] });
    }
    const use = (ref: string | undefined, by: string): void => {
        if (!ref) {
            return;
        }
        const known = declared.get(ref);
        if (known) {
            known.usedBy.push(by);
            return;
        }
        declared.set(ref, { ref, usedBy: [by] });
    };
    const inherited = config.agents.filter((a) => !a.model).map((a) => a.name);
    if (config.model && inherited.length) {
        for (const agent of inherited) {
            use(config.model, agent);
        }
    } else if (config.model) {
        use(config.model, '(project default)');
    }
    for (const agent of config.agents) {
        use(agent.model, agent.name);
    }

    if (!config.model && inherited.length) {
        add({
            severity: 'warning',
            code: 'model.none',
            where: 'model',
            message:
                `no project-wide \`model:\`, and ${inherited.join(', ')} pin none of their ` +
                'own — those agents cannot run without `zen run --model <ref>`',
            fix: 'set a top-level `model:`',
        });
    }

    // A verdict per model, from the same audit `zen run` prints as a warning.
    // Keyed by role too: an alias may name a model and an embedding at once.
    const issues = new Map<string, ModelIssue>();
    if (keys) {
        for (const issue of auditModels(root, keys)) {
            issues.set(`${issue.role}:${issue.name}`, issue);
        }
    }

    const models: ModelReport[] = [];
    const targets: [ModelReport, ModelTarget][] = [];

    const describe = (
        role: DeclaredRole,
        name: string,
        ref: ModelRef | EmbeddingRef,
        usedBy: string[],
    ): void => {
        const report: ModelReport = {
            name,
            role,
            credential: keys ? 'present' : 'unknown',
            usedBy,
        };
        try {
            const need = registry.requirement(ref);
            const held = credentialFor(need);
            report.provider = need.provider;
            report.kind = need.kind;
            report.env = held.env;
            if (keys) {
                report.credential = held.present ? 'present' : 'missing';
            }
            // An alias is the one name the provider has never heard of, so the
            // report says what it stands for — otherwise `main was refused`
            // names nothing anyone can look up or retype.
            const spec = typeof ref === 'string' ? registry.parse(ref) : ref;
            const api = 'api' in spec && spec.api ? `/${spec.api}` : '';
            const resolved = `${need.provider}${api}:${spec.model}`;
            if (resolved !== name) {
                report.ref = resolved;
            }
            // Reported here rather than left to the probe below: a knob for the
            // wrong vendor is a config mistake that wants naming whether or not
            // there is a credential to build the model with.
            if (role === 'model') {
                for (const stray of registry.knobs(ref as ModelRef)) {
                    add({
                        severity: 'error',
                        code: 'model.knob',
                        where: whereFor(config, role, name, usedBy),
                        message:
                            `\`${stray.knob}\` means nothing to a ${stray.target} model — ` +
                            'it would never reach the request',
                        fix: `this model takes: ${stray.supported.join(', ')}`,
                    });
                }
            }
        } catch (err) {
            add({
                severity: 'error',
                code: `${role}.unresolvable`,
                where: whereFor(config, role, name, usedBy),
                message: err instanceof Error ? err.message : String(err),
                fix:
                    role === 'embedding'
                        ? 'a reference is `[provider:]model`; see docs/agents-yaml.md'
                        : 'a reference is `[provider[/api]:]model`; see docs/agents-yaml.md',
            });
            report.credential = 'unknown';
            models.push(report);
            return;
        }

        const issue = issues.get(`${role}:${name}`);
        if (issue) {
            report.credential = issue.reason === 'missing' ? 'missing' : 'rejected';
            report.env = issue.env;
            if (issue.detail) {
                report.detail = issue.detail;
            }
            add({
                severity: 'warning',
                code: `credential.${issue.reason}`,
                where: named(report, issue.provider),
                message:
                    issue.reason === 'missing'
                        ? `nothing to authenticate with — ${issue.env} is not set, and the ` +
                          'keyring holds no key for this provider'
                        : `the provider rejected this key when it was last checked${
                              issue.detail ? `: ${issue.detail}` : ''
                          }`,
                fix: issue.add ? `zen key add ${issue.add}` : `set ${issue.env} in the environment`,
            });
        }
        models.push(report);

        // Only what there is something to ask with. Constructing the client is
        // what reads the credential, so a model with none cannot be built, let
        // alone asked — and the missing key is already a finding of its own.
        if (probe && report.credential === 'present') {
            try {
                targets.push([
                    report,
                    role === 'model'
                        ? { ref: name, kind: 'model', model: registry.model(ref as ModelRef) }
                        : {
                              ref: name,
                              kind: 'embedding',
                              embedder: registry.embedder(ref as EmbeddingRef),
                          },
                ]);
            } catch (err) {
                add({
                    severity: 'error',
                    code: `${role}.unusable`,
                    where: whereFor(config, role, name, usedBy),
                    message: err instanceof Error ? err.message : String(err),
                    fix: 'the provider is declared but cannot be built — see `providers:`',
                });
            }
        }
    };

    for (const [name, { ref, usedBy }] of declared) {
        describe('model', name, ref, usedBy);
    }
    // `usedBy` stays empty for embeddings: nothing in the runtime consumes one
    // yet, so there is no agent to attribute it to.
    for (const [name, spec] of Object.entries(config.embeddings ?? {})) {
        describe('embedding', name, spec as EmbeddingRef, []);
    }
    if (config.embedding && !config.embeddings?.[config.embedding]) {
        describe('embedding', config.embedding, config.embedding, []);
    }

    return { providers: registry.names(), models, targets };
}

/** How a finding names a model: as written, and as resolved when the two differ. */
function named(report: ModelReport, provider = report.provider): string {
    return (
        `${report.role} "${report.name}"` +
        (report.ref ? ` = ${report.ref}` : '') +
        (provider ? ` (${provider})` : '')
    );
}

/** The config key a bad reference was written under. */
function whereFor(
    config: ProjectConfig,
    role: DeclaredRole,
    name: string,
    usedBy: string[],
): string {
    if (role === 'embedding') {
        return config.embeddings?.[name] ? `embeddings.${name}` : 'embedding';
    }
    if (config.models?.[name]) {
        return `models.${name}`;
    }
    return usedBy.length && usedBy[0] !== '(project default)'
        ? `agents.${usedBy[0]}.model`
        : 'model';
}

// ---------------------------------------------------------------------------
// Odds and ends
// ---------------------------------------------------------------------------

function sandboxSummary(
    config: ProjectConfig | undefined,
    agents: AgentReport[],
    build?: ResolvedBuild,
    probed = false,
): Report['sandbox'] {
    const used = agents.some((a) => a.tools.some((t) => SANDBOX_TOOLS.has(t)));
    return {
        image: build?.tag ?? config?.sandbox?.image ?? null,
        // As written, not as resolved: this is read by someone about to edit it.
        dockerfile: config?.sandbox?.build?.dockerfile ?? null,
        declared: Boolean(config?.sandbox) || agents.some((a) => a.ownSandbox),
        used,
        probed,
    };
}

const SANDBOX_TOOLS = new Set([
    'run_command',
    'run_command_background',
    'read_command_output',
    'stop_command',
]);

/** A project-relative path, or undefined when the reference escapes the root. */
function normalise(root: string, ref: string): string | undefined {
    const path = resolve(root, ref.replace(/^file:\/\/\//, '/').replace(/^file:/, ''));
    const rel = relative(root, path);
    return rel.startsWith('..') || isAbsolute(rel) ? undefined : rel;
}

function display(root: string, path: string): string {
    const rel = relative(root, path);
    return rel.startsWith('..') || isAbsolute(rel) ? path : rel;
}

function empty(path: string): boolean {
    try {
        return statSync(path).size === 0;
    } catch {
        return false;
    }
}

function tally(values: readonly string[]): Map<string, number> {
    const out = new Map<string, number>();
    for (const v of values) {
        out.set(v, (out.get(v) ?? 0) + 1);
    }
    return out;
}

interface Assembly {
    version: number | null;
    entry: string | null;
    files: FileCheck[];
    agents: AgentReport[];
    skills: SkillReport[];
    skillDirs: string[];
    providers: string[];
    models: ModelReport[];
    sandbox: Report['sandbox'];
    findings: Finding[];
}

function finish(
    root: string,
    name: string | null,
    registered: boolean,
    config: string | null,
    shadowed: string[],
    parts: Assembly,
): Report {
    const counts = {
        errors: parts.findings.filter((f) => f.severity === 'error').length,
        warnings: parts.findings.filter((f) => f.severity === 'warning').length,
        notes: parts.findings.filter((f) => f.severity === 'note').length,
    };
    return {
        ok: counts.errors === 0,
        project: {
            name,
            root,
            registered,
            config,
            shadowed,
            version: parts.version,
            entry: parts.entry,
        },
        files: parts.files,
        agents: parts.agents,
        skills: { dirs: parts.skillDirs, entries: parts.skills },
        providers: parts.providers,
        models: parts.models,
        sandbox: parts.sandbox,
        findings: parts.findings,
        counts,
    };
}
