import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { IDENTITY_ENV_PREFIX, isHostOnlyEnv } from '../tools/identity.ts';

// ---------------------------------------------------------------------------
// agents.yaml
// ---------------------------------------------------------------------------

// Names reach the model as part of `transfer_to_<name>` and reach the file
// system as skill directory names, so they are restricted to a shape that is
// unambiguous in both.
const NAME = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

const name = z
    .string()
    .regex(NAME, 'must be lower-case words separated by "-" or "_", e.g. "order-triage"');

/**
 * A model reference is either the shorthand `ModelRegistry.parse` understands
 * (`gpt-4o`, `openai/responses:o3`, `openai-eu:o3`) or a key into the
 * project's `models:` map. Which one it is cannot be decided here — the loader
 * resolves aliases first and falls through to the shorthand — so the schema
 * only asks for a non-empty string.
 */
const modelRef = z.string().min(1);

/**
 * Credentials, shared by providers and by the one-off model that overrides
 * them. Values may embed `${VAR}` references; the substitution happens in the
 * registry, not here, so a config that is never used never demands a key.
 */
const credentials = {
    apiKey: z.string().min(1).optional(),
    apiKeyEnv: z.string().min(1).optional(),
    baseURL: z.string().min(1).optional(),
    baseURLEnv: z.string().min(1).optional(),
};

/**
 * A named connection. Splitting this out of the model is what lets one project
 * hold two keys for the same vendor: the key is declared once, under a name,
 * and models point at the name.
 */
const provider = z
    .object({
        ...credentials,
        kind: z
            .enum(['openai', 'google', 'vertex', 'anthropic', 'openrouter', 'openai-compatible'])
            .optional(),
        /** vertex only: the GCP project and region the endpoint is addressed by */
        project: z.string().min(1).optional(),
        location: z.string().min(1).optional(),
        headers: z.record(z.string().min(1), z.string()).optional(),
        timeoutMs: z.number().positive().optional(),
        maxRetries: z.int().nonnegative().optional(),
        /**
         * Ceiling on embedding requests in flight against this connection. The
         * working number is discovered from the provider's own refusals; this
         * only caps how high that may climb, for a key shared with something
         * else that also needs quota.
         */
        concurrency: z.int().positive().optional(),
    })
    .strict();

/**
 * openrouter only: which upstream provider serves a request.
 *
 * Named `routing` because `provider:` in this file already means the
 * connection. `sort` and the provider names are plain strings for the same
 * reason `reasoningEffort` is — OpenRouter adds providers continuously, and a
 * config the API would accept should not fail to load here first.
 */
const routing = z
    .object({
        /** providers to try, in order */
        order: z.array(z.string().min(1)).min(1).optional(),
        /** restricts serving to these, rather than merely preferring them */
        only: z.array(z.string().min(1)).min(1).optional(),
        ignore: z.array(z.string().min(1)).min(1).optional(),
        /** `price`, `throughput`, `latency`, `exacto` */
        sort: z.string().min(1).optional(),
        /** may OpenRouter go beyond `order`; on by default */
        allowFallbacks: z.boolean().optional(),
        /** skip providers that would silently drop parameters they do not support */
        requireParameters: z.boolean().optional(),
        dataCollection: z.enum(['allow', 'deny']).optional(),
        quantizations: z.array(z.string().min(1)).min(1).optional(),
        /** zero-data-retention endpoints only */
        zdr: z.boolean().optional(),
    })
    .strict();

/**
 * `reasoningEffort` is a plain string rather than an enum on purpose: the
 * vendor's accepted set changes faster than this file would, and the request
 * that carries a bad value is the authority on rejecting it. An enum here would
 * mean a config that the API accepts failing to load.
 */
const modelSpec = z
    .object({
        ...credentials,
        /** a name from `providers:`, or a built-in kind */
        provider: z.string().min(1).optional(),
        api: z.enum(['chat', 'responses']).optional(),
        model: z.string().min(1),
        reasoningEffort: z.string().min(1).optional(),
        reasoningSummary: z.enum(['auto', 'concise', 'detailed']).optional(),
        store: z.boolean().optional(),
        /** anthropic only: the output cap its API requires, and the thinking budget */
        maxTokens: z.int().positive().optional(),
        thinkingBudgetTokens: z.int().positive().optional(),
        /** gemini only: 2.5 takes a token budget, 3 takes a level */
        thinkingBudget: z.int().optional(),
        thinkingLevel: z.enum(['minimal', 'low', 'medium', 'high']).optional(),
        includeThoughts: z.boolean().optional(),
        /** openrouter only: who serves the request, what to try when they cannot */
        routing: routing.optional(),
        fallbacks: z.array(z.string().min(1)).min(1).optional(),
        serviceTier: z.enum(['auto', 'default', 'fast', 'flex', 'priority', 'scale']).optional(),
    })
    .strict();

/**
 * A vectoriser. Deliberately much smaller than `modelSpec`: an embedding call
 * has no conversation, no tools and no reasoning, so a connection, an id and a
 * width is all there is to say. `taskType` is absent because it describes the
 * *text*, not the model, and so belongs to the call.
 */
const embeddingSpec = z
    .object({
        ...credentials,
        /** a name from `providers:`, or a built-in kind */
        provider: z.string().min(1).optional(),
        model: z.string().min(1),
        /** truncate to this width, where the model supports it */
        dimensions: z.int().positive().optional(),
        /** gemini only: a document title the retrieval task type takes into account */
        title: z.string().min(1).optional(),
        /**
         * Ceilings on how a batch is split into requests. Both default to what
         * the model is known to accept, so setting them is for a gateway whose
         * caps are not the vendor's.
         */
        maxBatch: z.int().positive().optional(),
        maxBatchTokens: z.int().positive().optional(),
        /** openrouter only: who serves the request */
        routing: routing.optional(),
    })
    .strict();

const skillsBinding = z
    .object({
        /** provider id; defaults to the project's sole provider */
        provider: z.string().min(1).optional(),
        discovery: z.enum(['index', 'search', 'none']).default('index'),
        /** restricts the catalog this agent sees; absent means all of it */
        allow: z.array(name).optional(),
        /** activated before the first call of every turn this agent owns */
        preload: z.array(name).optional(),
        maxIndexEntries: z.int().positive().optional(),
    })
    .strict();

/**
 * Opt-in to parallel sub-agents. The kernel gates the `fork` tool on the
 * binding *existing*, not on what it holds, so `true` and `{}` say the same
 * thing and there is nothing here to default — an agent that does not mention
 * `fork:` is never offered the tool.
 *
 * Both limits are stated as errors rather than as values that get clamped
 * later: `maxBranches: 0` would make every call the model could write fail, and
 * `agents: []` reads as "no agents" while actually meaning "only itself".
 * `maxBranches: 1` is not a contradiction — it says this agent may delegate a
 * job but may not fan out.
 */
const forkBinding = z
    .object({
        /** agents a branch may run; absent means any registered agent */
        agents: z.array(name).min(1).optional(),
        /** a cap of 1 allows delegation only; 0 would refuse every possible call */
        maxBranches: z.int().min(1).optional(),
    })
    .strict();

/**
 * What an agent may do with the project's one memory graph, and which slice of
 * it it can see. Both lists are audience labels; `'*'` is the public slice and
 * is always readable, so `sees` can only ever widen from there.
 *
 * `sees` and `writes` are here and not in any tool schema on purpose: an agent
 * that could name its own audience could read another agent's slice just by
 * asking for it.
 */
const memoryBinding = z
    .object({
        access: z.enum(['read', 'read-write', 'full']).default('read-write'),
        /** audience labels this agent may read, on top of the public slice */
        sees: z.array(name).optional(),
        /** labels it may put on what it writes */
        writes: z.array(name).optional(),
        /**
         * Recall before a turn that follows new user input, rather than before
         * every call: recalling on every turn costs tokens and defeats prompt
         * caching for a marginal gain. `false` leaves the agent the tools and
         * lets it decide when to look.
         */
        autoRecall: z
            .union([z.boolean(), z.object({ limit: z.int().positive().default(10) }).strict()])
            .optional(),
    })
    .strict();

/** Where the project's memory lives, and what vectorises it. */
const memoryConfig = z
    .object({
        /** relative to the project root */
        dir: z.string().min(1).default('memory'),
        /**
         * A name from `embeddings:`. Without one, recall ranks by term overlap
         * — which works, but only finds the words the agent happened to reuse.
         */
        embedding: modelRef.optional(),
        /**
         * Closed vocabularies. Absent means the built-in sets, which is almost
         * always right: a kind nothing else understands is a kind no other
         * agent can search for.
         */
        kinds: z.array(name).min(1).optional(),
        relations: z.array(name).min(1).optional(),
    })
    .strict();

/**
 * The container command-line tools run in.
 *
 * Everything here is a *resource* decision — which image, how much of the
 * machine, whether the network is reachable — because those are the decisions
 * that differ between a laptop and CI and cannot be baked into an image.
 *
 * `env` names host variables to forward, and only names: values never appear
 * in the config, so a repository never carries one. Names that read like a
 * credential are refused outright — not because credentials never belong in
 * the sandbox, but because `env` is the wrong door for them. Model keys go
 * through `keys`, which forwards a known set by name and can be turned off in
 * one place; a hand-written `env: [OPENAI_API_KEY]` would be a second, silent
 * way in that no single switch could close.
 */
const SECRETISH = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;

/**
 * A Dockerfile to build instead of an image to pull, for the ordinary case the
 * `image:` key cannot serve: a project that needs two runtimes, or a pinned
 * toolchain, and would otherwise have its agents reinstall it on every run.
 *
 * Building is a host concern, so nothing in this library does it — the front
 * end resolves this to an image reference before a container is ever named.
 */
const build = z
    .object({
        /** path to the Dockerfile, relative to the project root */
        dockerfile: z.string().min(1),
        /** what the build may COPY from; the Dockerfile's own directory by default */
        context: z.string().min(1).optional(),
    })
    .strict();

const sandbox = z
    .object({
        /** the base image, e.g. `docker.io/library/python:3.13-slim` */
        image: z.string().min(1).optional(),
        /** a Dockerfile to build, instead of an image to pull */
        build: build.optional(),
        /** fractional cores the container may use */
        cpus: z.number().positive().optional(),
        /** MiB the container may use */
        memory: z.int().positive().optional(),
        network: z.enum(['bridge', 'none', 'host']).optional(),
        /** where the workspace is mounted, and the default working directory */
        workdir: z.string().min(1).optional(),
        /** seconds one command may take before it is killed */
        timeout: z.int().positive().optional(),
        /**
         * How much of the host the container is allowed to be.
         *
         * `standard` (the default) keeps the kernel capabilities and a
         * writable root filesystem, so `apt` and `pip` work — which is what a
         * project whose agents install their own dependencies needs.
         *
         * `strict` drops every capability, mounts the root filesystem
         * read-only with an in-memory `noexec` `/tmp`, runs as an
         * unprivileged uid and turns the network off unless this block asks
         * for one. Nothing can be installed at run time, so the image has to
         * carry everything the agent will need. It requires rootless podman.
         */
        hardening: z.enum(['standard', 'strict']).optional(),
        /** uid, name or `uid:gid`; unset means the image's own user */
        user: z.string().min(1).optional(),
        /** keep the container between sessions instead of removing it */
        persist: z.boolean().optional(),
        /** host variables to forward, by name */
        env: z.array(z.string().min(1)).optional(),
        /**
         * Whether the model credentials reach the sandbox. On by default,
         * because the scaffolded image installs `zen` itself and an agent that
         * cannot run `zen check` inside its own sandbox is a surprise.
         *
         * Turning it off is the honest answer for a project whose agents write
         * code they then execute: the container runs whatever the model wrote,
         * so a forwarded key is a key that code can read and, on a `bridge`
         * network, send somewhere.
         */
        keys: z.boolean().optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
        if (value.image !== undefined && value.build !== undefined) {
            ctx.addIssue({
                code: 'custom',
                path: ['build'],
                message:
                    'image and build cannot both be set — a Dockerfile names its own base ' +
                    'in its FROM line, so one of the two would be silently ignored',
            });
        }
        // Disable key blacklisting for now.
        // for (const [i, name] of (value.env ?? []).entries()) {
        //     if (SECRETISH.test(name)) {
        //         ctx.addIssue({
        //             code: 'custom',
        //             path: ['env', i],
        //             message:
        //                 `refusing to forward ${name} into the sandbox — it reads like a ` +
        //                 'credential, and the sandbox runs whatever the model writes',
        //         });
        //     }
        // }
        for (const [i, name] of (value.env ?? []).entries()) {
            if (name.startsWith(IDENTITY_ENV_PREFIX)) {
                ctx.addIssue({
                    code: 'custom',
                    path: ['env', i],
                    message:
                        `${name} is set by the host for the user a run acts for — ` +
                        `a project cannot forward its own ${IDENTITY_ENV_PREFIX}* variables`,
                });
            } else if (isHostOnlyEnv(name)) {
                ctx.addIssue({
                    code: 'custom',
                    path: ['env', i],
                    message:
                        `${name} configures the host — which plugins it loads and which ` +
                        'sandbox service it uses — and is never forwarded into a sandbox',
                });
            }
        }
    });

const agent = z
    .object({
        name,
        /** what a sibling agent's `transfer_to_` tool tells the model */
        description: z.string().optional(),
        /** path to a markdown file, relative to the project root */
        system: z.string().min(1).optional(),
        model: modelRef.optional(),
        /** names resolved against `ProjectOptions.tools`; code cannot live in yaml */
        tools: z.array(z.string().min(1)).optional(),
        /**
         * Plain agent names. Deliberately not objects: a hand-off carries no
         * configuration in this version, so there is nothing for an object form
         * to hold, and accepting one would mean accepting keys nothing honours.
         */
        handoffs: z.array(name).optional(),
        skills: skillsBinding.optional(),
        /** parallel sub-agents; `true` is the unrestricted form */
        fork: z.union([z.boolean(), forkBinding]).optional(),
        /**
         * The shared memory graph. `true` is the whole feature working the
         * obvious way — read and write, with auto-recall on.
         *
         * Normalised before validation rather than unioned with a boolean, so
         * that a misspelled key inside the block is reported as
         * `agents[0].memory.scope` instead of collapsing to "invalid input".
         */
        memory: z
            .preprocess(
                (v) => (typeof v === 'boolean' ? (v ? {} : undefined) : v),
                memoryBinding.optional(),
            )
            .optional(),
        /**
         * Gone: a session has one sandbox, the project's, shared by every
         * agent. Refused rather than ignored, so a project that relied on it
         * hears where its settings have to go instead.
         */
        sandbox: z
            .never({
                error:
                    'per-agent sandboxes were removed — a session has one sandbox, shared by ' +
                    "every agent; move these settings to the project's top-level `sandbox:`",
            })
            .optional(),
        /** entrypoint, when no top-level `default` is given */
        default: z.boolean().optional(),
    })
    .strict();

export const projectSchema = z
    .object({
        version: z.literal(1).default(1),
        /** entrypoint agent name; wins over any `default: true` */
        default: name.optional(),
        /** named connections; the built-in kinds work without being declared */
        providers: z.record(name, provider).optional(),
        /** the provider a bare model id belongs to */
        provider: name.optional(),
        /** named model configurations, referenced by `model:` anywhere below */
        models: z.record(name, z.union([modelRef, modelSpec])).optional(),
        /** fallback for agents that do not pin their own */
        model: modelRef.optional(),
        /**
         * Named vectorisers. Not a per-agent key: nothing in the runtime
         * consumes an embedder yet, and a key nothing honours is worse than a
         * key that is not there.
         */
        embeddings: z.record(name, z.union([modelRef, embeddingSpec])).optional(),
        /** the vectoriser `AgentProject.embedder()` hands back when asked for none */
        embedding: modelRef.optional(),
        /** one directory, or several merged into one catalog */
        skills: z.union([z.string().min(1), z.array(z.string().min(1))]).optional(),
        /**
         * Reference material every agent can read and none can write, mounted
         * at /assets. One directory, project-wide: an agent that may only see
         * some of it is a different project, not a different key.
         */
        assets: z.string().min(1).optional(),
        /** the container `run_command` and friends execute in */
        sandbox: sandbox.optional(),
        /**
         * The one graph every agent's `memory:` binding is a view onto. Declare
         * it to choose where it lives or what embeds it; an agent that opts in
         * without this block gets the defaults.
         */
        memory: memoryConfig.optional(),
        agents: z.array(agent).min(1),
    })
    .strict();

export type ProjectConfig = z.infer<typeof projectSchema>;
export type AgentConfig = ProjectConfig['agents'][number];
export type ProviderConfig = z.infer<typeof provider>;
export type ModelConfig = z.infer<typeof modelSpec>;
export type EmbeddingConfig = z.infer<typeof embeddingSpec>;
export type SandboxConfig = z.infer<typeof sandbox>;
export type SandboxBuildConfig = z.infer<typeof build>;
export type MemoryConfig = z.infer<typeof memoryConfig>;
export type MemoryBindingConfig = z.infer<typeof memoryBinding>;

/**
 * Re-renders a zod failure as `agents.yaml: agents[1].skills.discovery — …`.
 *
 * The default message is a JSON blob with the path in a nested array, which
 * tells an author everything except the one thing they need: which line to fix.
 */
export function parseConfig(text: string, source: string): ProjectConfig {
    let raw: unknown;
    try {
        raw = parseYaml(text);
    } catch (e) {
        throw new Error(`${source}: ${(e as Error).message}`);
    }
    const result = projectSchema.safeParse(raw);
    if (!result.success) {
        const lines = result.error.issues.map((i) => {
            const path = i.path.length ? i.path.map(segment).join('').replace(/^\./, '') : '(root)';
            return `  ${path} — ${i.message}`;
        });
        throw new Error(`${source}: invalid project configuration\n${lines.join('\n')}`);
    }
    return result.data;
}

function segment(p: PropertyKey): string {
    return typeof p === 'number' ? `[${p}]` : `.${String(p)}`;
}
