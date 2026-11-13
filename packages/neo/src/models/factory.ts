import type Anthropic from '@anthropic-ai/sdk';
import type { ClientOptions as AnthropicOptions } from '@anthropic-ai/sdk';
import type { GoogleGenAI, GoogleGenAIOptions } from '@google/genai';
import type { HTTPClient, OpenRouter, SDKOptions as OpenRouterOptions } from '@openrouter/sdk';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type OpenAI from 'openai';
import type { ClientOptions as OpenAIOptions } from 'openai';
import type { Embedder } from '../embedding.ts';
import { GeminiEmbedder, type GeminiEmbedderOptions } from '../embeddings/gemini.ts';
import { DEFAULT_START, RateLimiter } from '../embeddings/limiter.ts';
import { OpenAIEmbedder, type OpenAIEmbedderOptions } from '../embeddings/openai.ts';
import { OpenRouterEmbedder, type OpenRouterEmbedderOptions } from '../embeddings/openrouter.ts';
import { unfundedSymbol } from '../embeddings/rate-limit.ts';
import type { Model } from '../model.ts';
import { AnthropicModel, type AnthropicModelOptions } from './anthropic.ts';
import {
    GATEWAY_KEY_ENV,
    GATEWAY_KEY_HEADER,
    GATEWAY_NAME,
    GATEWAY_PATHS,
    GATEWAY_UPSTREAMS,
    gatewayOf,
    upstreamFetch,
    type Gateway,
    type GatewayProtocol,
} from './gateway.ts';
import { GeminiModel, type GeminiModelOptions } from './gemini.ts';
import { OpenAIModel } from './openai-chat.ts';
import { OpenAIResponsesModel, type OpenAIResponsesModelOptions } from './openai-responses.ts';
import { OpenRouterModel, type OpenRouterModelOptions } from './openrouter.ts';
import { MODEL_APIS, splitModelRef } from './ref.ts';

// ---------------------------------------------------------------------------
// The vendor SDKs
//
// All four are *optional peer dependencies*: an application installs the one
// vendor it talks to and pays for nothing else — which matters most for
// `@google/genai`, whose own tree carries google-auth-library and protobufjs.
//
// That only holds if importing this library does not reach for all four, so
// nothing above is a value import: the SDKs are pulled in here, when a client
// of that protocol is first built, and never at module scope.
//
// `createRequire` rather than `await import()` because it is synchronous, and
// so `createModel()` and `ModelRegistry.client()` keep handing back a usable
// object instead of a promise — which is also what keeps a bad credential
// throwing at the call that named it rather than at some later request. Three
// of the four publish a CommonJS build; `@openrouter/sdk` is ESM-only, which
// `require` has loaded since Node 22 for module graphs without a top-level
// await, and this library already requires Node 24.
// ---------------------------------------------------------------------------

const requirePeer = createRequire(import.meta.url);

interface OpenAIModule {
    OpenAI: new (options: OpenAIOptions) => OpenAI;
}
interface AnthropicModule {
    Anthropic: new (options: AnthropicOptions) => Anthropic;
}
interface GenAIModule {
    GoogleGenAI: new (options: GoogleGenAIOptions) => GoogleGenAI;
}
interface OpenRouterModule {
    OpenRouter: new (options: OpenRouterOptions) => OpenRouter;
    HTTPClient: new () => HTTPClient;
}

/**
 * An uninstalled optional peer is a setup mistake, not a bug, so it is reported
 * as the one-line fix rather than as a resolution failure from inside Node.
 */
function sdk<T>(pkg: string, kind: ProviderKind): T {
    try {
        return requirePeer(pkg) as T;
    } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') {
            throw cause;
        }
        throw new Error(
            `provider kind "${kind}" needs ${pkg}, which is not installed — run: npm i ${pkg}`,
            { cause },
        );
    }
}

// ---------------------------------------------------------------------------
// Providers and models
// ---------------------------------------------------------------------------

/**
 * A *provider* is a connection; a *model* is a request shape. They used to be
 * one type, which made "two OpenAI keys" mean repeating credentials on every
 * model that used the second one — and gave every agent its own HTTP client,
 * with its own connection pool and its own retry budget.
 *
 * Separated, credentials are declared once under a name, the client behind that
 * name is built once and shared, and a model spec becomes vendor-neutral: a
 * provider, an id, and knobs.
 */
export type ProviderKind =
    'openai' | 'google' | 'vertex' | 'anthropic' | 'openrouter' | 'openai-compatible';

export type OpenAIApi = 'chat' | 'responses';

/**
 * The request format a kind speaks, which is what picks the adapter — and,
 * incidentally, the SDK. Not the same axis as `ProviderKind`: `openai` and
 * `openai-compatible` are two connections speaking one protocol.
 */
type Protocol = 'openai' | 'anthropic' | 'gemini' | 'openrouter';

/** The vendor client behind a provider name. */
export type ProviderClient = OpenAI | Anthropic | GoogleGenAI | OpenRouter;

/**
 * How to reach a provider. Every field has an env fallback so a spec can stay
 * declarative (and secret-free) in application code.
 */
export interface Credentials {
    /** literal key, or a `${VAR}` reference — wins over any env lookup */
    apiKey?: string;
    /** env var holding the key; defaults to the kind's conventional name */
    apiKeyEnv?: string;
    /** literal base url, or a `${VAR}` reference, for gateways and compatible endpoints */
    baseURL?: string;
    /** env var holding the base url; defaults to the kind's conventional name */
    baseURLEnv?: string;
}

/** A named connection to a vendor. One client is built per registered name. */
export interface ProviderSpec extends Credentials {
    /** which vendor this speaks; defaults to `openai` */
    kind?: ProviderKind;
    /**
     * vertex only: GCP project id. Falls back to `GOOGLE_CLOUD_PROJECT`, then
     * to the `project_id` inside the service-account key file named by
     * `GOOGLE_APPLICATION_CREDENTIALS`. Ignored when an `apiKey` is given —
     * express mode addresses no project.
     */
    project?: string;
    /** vertex only: a region, or `global` (env: `GOOGLE_CLOUD_LOCATION`, default `global`) */
    location?: string;
    /**
     * Returns a bearer token, once per request, so a short-lived credential can
     * be refreshed without rebuilding the client. Azure AD and gateways that
     * mint their own grants are the cases; Vertex is not, because the GenAI SDK
     * already resolves and refreshes Application Default Credentials. Code
     * only: a function is not something yaml can hold.
     */
    token?: () => string | Promise<string>;
    /** sent on every request — gateway routing, attribution, api versions */
    headers?: Record<string, string>;
    timeoutMs?: number;
    maxRetries?: number;
    /**
     * Ceiling on embedding requests in flight against this connection. The
     * floor and the actual number are discovered from the provider's own
     * refusals, so this only says how high the discovery may climb — set it
     * when an account is shared with something else that also needs quota.
     *
     * On the provider rather than on a model because a rate limit belongs to
     * the key: two embedders on one account are one budget, not two.
     */
    concurrency?: number;
    /**
     * Pre-built client — bypasses credential resolution entirely. The seam for
     * auth no configuration can express: Vertex service accounts, Bedrock
     * signing, or a stub in tests.
     */
    client?: ProviderClient;
}

/**
 * What to ask for, and of whom. Vendor differences live in the *provider*, so
 * there is nothing here to discriminate on: the option interfaces are unioned,
 * which makes every vendor's knobs type-legal on every model. `model()` rejects
 * the ones the resolved adapter would not read — see `KNOBS`.
 *
 * `Credentials` are still accepted inline, for a one-off model that does not
 * warrant a declared provider. Using them opts out of the shared client.
 */
export interface ModelSpec
    extends
        Credentials,
        OpenAIResponsesModelOptions,
        AnthropicModelOptions,
        GeminiModelOptions,
        OpenRouterModelOptions {
    /**
     * Registered provider name. The built-in providers are named after their
     * kind, so `provider: 'google'` works with nothing declared. Defaults to
     * the registry's default provider.
     */
    provider?: string;
    /** which API to speak; defaults to the vendor's usual one */
    api?: OpenAIApi;
    model: string;
    /** pre-built client — bypasses provider resolution entirely */
    client?: ProviderClient;
}

/**
 * Shorthand: `provider/id`, e.g. `openai/gpt-5-mini`,
 * `vertex/anthropic/claude-opus-5`, `openrouter/anthropic/claude-sonnet-5` —
 * see `ref.ts`. The older `[provider[/api]:]id` (`openai:gpt-4o`,
 * `openai/responses:o3`, `openai:ft:gpt-4o:acme::a1b2`) and a bare id on the
 * default provider are still read. Anything the shorthand cannot express
 * (keys, base urls, reasoning knobs) needs the object form.
 */
export type ModelRef = ModelSpec | string;

/**
 * How a ref is written, against how it would be written today.
 *
 * - `bare` — no provider: it goes to the default one
 * - `colon` — the older `provider:id`
 * - `ambiguous` — `anthropic/claude-…` on an OpenRouter-style default, which
 *   still means the default provider's id, as it always has; written out, it
 *   says so
 * - `publisher` — Claude on Vertex without its `anthropic/`
 *
 * `canonical` keeps the meaning. A colon ref naming an api is already as
 * written as it gets: no other shorthand carries one.
 */
export interface ModelRefStyle {
    issue: 'bare' | 'colon' | 'ambiguous' | 'publisher';
    canonical: string;
}

/**
 * The same idea one layer down: which vectoriser, and of whom.
 *
 * A separate type from `ModelSpec` rather than a flag on it, because the two
 * share only their connection. There is no `api` field — `/v1/responses` has no
 * embeddings endpoint, so naming one would be meaningless on every protocol,
 * not just the three that already have a single API.
 */
export interface EmbeddingSpec
    extends Credentials, OpenAIEmbedderOptions, GeminiEmbedderOptions, OpenRouterEmbedderOptions {
    /** registered provider name; defaults to the registry's default provider */
    provider?: string;
    model: string;
    /** pre-built client — bypasses provider resolution entirely */
    client?: ProviderClient;
}

/** Shorthand: `provider/model`, e.g. `google/gemini-embedding-001` — read as `ModelRef` is, minus an api. */
export type EmbeddingRef = EmbeddingSpec | string;

/**
 * What a ref *would* connect with. `model()` answers the same question by
 * building a client — which needs the very credential a caller wanting to
 * report on credentials does not have. This resolves the same precedence rules
 * and stops there, so a CLI can say which model is unreachable before anything
 * throws three frames deeper.
 */
export interface ModelRequirement {
    /** the provider name the ref resolves to, declared or built-in */
    provider: string;
    kind: ProviderKind;
    /** env var consulted when the spec carries no `apiKey` of its own */
    apiKeyEnv: string;
    /** a client could be built as things stand */
    satisfied: boolean;
    /** the SDK authenticates without a key, so `satisfied` says little */
    keyOptional: boolean;
    /** set when the request goes through a gateway, whose key `apiKeyEnv` then names */
    gateway?: string;
}

interface KindDefaults {
    /** the request format, and so the adapter and the client to build */
    protocol: Protocol;
    apiKeyEnv: string;
    baseURLEnv: string;
    /** vendor default, used when neither the spec nor the env names one */
    baseURL?: string;
    /** which OpenAI APIs this vendor speaks; the first is the default. empty = another protocol */
    apis: readonly OpenAIApi[];
    /** the SDK can authenticate without a key — ambient credentials, a metadata server */
    keyOptional?: boolean;
}

/**
 * Only two of these need no adapter of their own.
 *
 * `openai-compatible` is the shim kind — vLLM, a self-hosted gateway — and the
 * OpenAI client is exactly right for it. Everything else gets its vendor's own
 * SDK, because the compatibility endpoints each vendor publishes are porting
 * aids: Google's drops thinking budgets, thought signatures and cached-content
 * accounting, Anthropic's drops cache accounting and extended thinking. Those
 * are the things this runtime is built around, so paying for two more
 * dependencies is the cheaper trade.
 *
 * `openrouter` used to be that shim with the two constants filled in, which
 * cost nothing until the parts of OpenRouter worth having turned out to be the
 * parts chat completions cannot say: which upstream provider serves a request,
 * what to fall back to when it cannot, and what the call actually cost. Its
 * own SDK carries those as first-class fields, so it now gets an adapter like
 * every other vendor. `openai-compatible` against the same base url is still
 * there for anyone who wants the older, laxer client back.
 *
 * `google` and `vertex` differ only in how the client authenticates and which
 * backend it addresses; both speak the same API through the same adapter.
 */
const KINDS: Record<ProviderKind, KindDefaults> = {
    openai: {
        protocol: 'openai',
        apiKeyEnv: 'OPENAI_API_KEY',
        baseURLEnv: 'OPENAI_BASE_URL',
        apis: ['chat', 'responses'],
    },
    google: {
        protocol: 'gemini',
        apiKeyEnv: 'GEMINI_API_KEY',
        baseURLEnv: 'GEMINI_BASE_URL',
        apis: [],
    },
    vertex: {
        // Vertex authenticates with Application Default Credentials, which the
        // GenAI SDK resolves itself — so unlike every other kind this one
        // usually has no key at all. `VERTEX_API_KEY` covers express mode.
        protocol: 'gemini',
        apiKeyEnv: 'VERTEX_API_KEY',
        baseURLEnv: 'VERTEX_BASE_URL',
        apis: [],
        keyOptional: true,
    },
    anthropic: {
        protocol: 'anthropic',
        apiKeyEnv: 'ANTHROPIC_API_KEY',
        baseURLEnv: 'ANTHROPIC_BASE_URL',
        apis: [],
    },
    openrouter: {
        protocol: 'openrouter',
        apiKeyEnv: 'OPENROUTER_API_KEY',
        baseURLEnv: 'OPENROUTER_BASE_URL',
        baseURL: 'https://openrouter.ai/api/v1',
        apis: [],
    },
    'openai-compatible': {
        protocol: 'openai',
        apiKeyEnv: 'OPENAI_API_KEY',
        baseURLEnv: 'OPENAI_BASE_URL',
        apis: ['chat', 'responses'],
    },
};

export const providerKinds = Object.keys(KINDS) as ProviderKind[];

export function isProviderKind(name: string): name is ProviderKind {
    return Object.hasOwn(KINDS, name);
}

/**
 * Vertex serves three request formats behind one account, and the model id
 * says which: Google's own models through the GenAI API, Claude through
 * Anthropic's Messages format at `rawPredict`, and every other publisher's
 * (`xai/grok-4.1-fast-reasoning`, `qwen/qwen3-…-maas`) through the
 * OpenAI-compatible endpoint, which names its models `publisher/model`.
 */
export type VertexRoute = 'gemini' | 'anthropic' | 'openai';

export function vertexRoute(model: string): VertexRoute {
    if (/^(anthropic\/)?claude-/.test(model)) {
        return 'anthropic';
    }
    return model.includes('/') ? 'openai' : 'gemini';
}

/** The protocol one model on one kind is spoken in. Only Vertex has more than one. */
function protocolOf(kind: ProviderKind, model: string): Protocol {
    return kind === 'vertex' ? vertexRoute(model) : KINDS[kind].protocol;
}

/** The OpenAI-compatible endpoint on Vertex has chat completions and nothing else. */
function apisOf(kind: ProviderKind, protocol: Protocol): readonly OpenAIApi[] {
    return kind === 'vertex' && protocol === 'openai' ? ['chat'] : KINDS[kind].apis;
}

/** Bifrost has no OpenRouter drop-in, so OpenRouter models go through its OpenAI one. */
function gatewayProtocol(kind: ProviderKind, model: string): GatewayProtocol {
    const protocol = protocolOf(kind, model);
    return protocol === 'openrouter' ? 'openai' : protocol;
}

/** How one model is reached: directly, or through the gateway and in which protocol. */
interface Route {
    protocol: Protocol;
    apis: readonly OpenAIApi[];
    gateway?: Gateway;
}

const GATEWAY_APIS: readonly OpenAIApi[] = ['chat', 'responses'];

// ---------------------------------------------------------------------------
// Tuning knobs
// ---------------------------------------------------------------------------

/**
 * Which knobs each adapter actually reads.
 *
 * `ModelSpec` unions every vendor's option interface, so `reasoningEffort` on a
 * Gemini model is type-legal and the yaml schema accepts it too — and until
 * this table it was dropped in silence, which is the worst outcome available:
 * the config claims a setting is in force, the request never carries it, and
 * the run looks healthy. No static type could have caught it either, because
 * `provider` is a free name and its kind is not known until resolution.
 *
 * Translating instead was the alternative, and it is worse. The vendors do not
 * mean the same thing by the same word: effort is a coarse level on OpenAI, a
 * token budget on Anthropic, and *both* on Google depending on the model
 * generation. A silent remap would make one line mean four things and bury the
 * 2.5/3 split that `gemini.ts` deliberately refuses to paper over.
 */
const KNOBS = {
    'openai/chat': ['reasoningEffort'],
    'openai/responses': ['reasoningEffort', 'reasoningSummary', 'store'],
    anthropic: ['maxTokens', 'thinkingBudgetTokens'],
    gemini: ['maxTokens', 'thinkingBudget', 'thinkingLevel', 'includeThoughts'],
    openrouter: [
        'maxTokens',
        'reasoningEffort',
        'reasoningSummary',
        'routing',
        'fallbacks',
        'plugins',
        'serviceTier',
    ],
} as const satisfies Record<string, readonly string[]>;

/** An adapter, in the terms `KNOBS` is keyed by: a protocol, split by api where there are two. */
export type KnobTarget = keyof typeof KNOBS;

/** Every knob some adapter reads. A key outside it is a connection field, not tuning. */
const TUNING = new Set<string>(Object.values(KNOBS).flat());

/** A knob a spec carries that the adapter it resolves to will never read. */
export interface KnobIssue {
    knob: string;
    /** the adapter that would have had to read it */
    target: KnobTarget;
    /** what that adapter does read */
    supported: readonly string[];
}

function unreadKnobs(spec: ModelSpec, target: KnobTarget): KnobIssue[] {
    const supported: readonly string[] = KNOBS[target];
    return Object.entries(spec)
        .filter(([k, v]) => v !== undefined && TUNING.has(k) && !supported.includes(k))
        .map(([knob]) => ({ knob, target, supported }));
}

// ---------------------------------------------------------------------------
// Environment references
// ---------------------------------------------------------------------------

// `${VAR}` and `${VAR:-fallback}`. Chosen over a bare `env.VAR` token because a
// literal secret never contains `${`, so there is no rule to remember about
// which strings are magic — and because it composes inside a longer value,
// which a whole-value token cannot: `https://${GATEWAY}/v1`.
const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * Substitutes `${VAR}` references. An unset variable with no fallback is an
 * error naming both the variable and where it was written, because the
 * alternative is an empty api key and a 401 three layers away.
 */
export function expandEnv(value: string, where: string): string {
    return value.replace(ENV_REF, (_match, name: string, fallback?: string) => {
        const found = fromEnv(name);
        if (found !== undefined) {
            return found;
        }
        if (fallback !== undefined) {
            return fallback;
        }
        throw new Error(`${where}: \${${name}} is not set`);
    });
}

function fromEnv(name: string): string | undefined {
    const value = process.env[name];
    return value?.trim() ? value : undefined;
}

function expand(value: string | undefined, where: string): string | undefined {
    return value === undefined ? undefined : expandEnv(value, where);
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Named providers, and the clients behind them.
 *
 * The clients are why this is an object rather than a function: one `OpenAI`
 * per provider name, built on first use and shared by every model and every
 * agent that names it. A registry is also the seam a host uses to point a name
 * at different credentials, or at a stub — neither of which should mean
 * touching a `switch`.
 */
export class ModelRegistry {
    readonly #providers = new Map<string, ProviderSpec>();
    readonly #clients = new Map<string, ProviderClient>();
    readonly #limiters = new Map<string, RateLimiter>();
    #default = 'openai';

    /** Declares (or replaces) a provider. Nothing is contacted until it is used. */
    provider(name: string, spec: ProviderSpec = {}): this {
        if (spec.kind !== undefined && !isProviderKind(spec.kind)) {
            throw new TypeError(
                `provider "${name}": unknown kind "${spec.kind}" ` +
                    `(known: ${providerKinds.join(', ')})`,
            );
        }
        this.#providers.set(name, spec);
        // Re-declaring after a client was handed out would otherwise leave the
        // old credentials in service for the rest of the process.
        for (const key of this.#clients.keys()) {
            if (key === name || key.startsWith(`${name}\0`)) {
                this.#clients.delete(key);
            }
        }
        this.#limiters.delete(name);
        return this;
    }

    /** Names the provider a bare model id belongs to. */
    setDefault(name: string): this {
        if (!this.has(name)) {
            throw new Error(
                `default provider "${name}" is not declared (known: ${this.names().join(', ')})`,
            );
        }
        this.#default = name;
        return this;
    }

    get defaultProvider(): string {
        return this.#default;
    }

    /** Declared here, or a built-in kind usable with no declaration at all. */
    has(name: string): boolean {
        return this.#providers.has(name) || isProviderKind(name);
    }

    names(): string[] {
        return [...new Set([...this.#providers.keys(), ...providerKinds])];
    }

    /** The shared client for a provider, built on first use. */
    client(name: string): ProviderClient {
        const existing = this.#clients.get(name);
        if (existing) {
            return existing;
        }
        const spec = this.#spec(name);
        const built = spec.client ?? buildClient(name, this.kindOf(name), spec, spec);
        this.#clients.set(name, built);
        return built;
    }

    /**
     * Gateway mode takes every provider, declared ones included; only a
     * pre-built client stays put, since there is nothing in it to repoint.
     */
    #route(spec: { model: string; client?: ProviderClient }, name: string): Route {
        const kind = this.kindOf(name);
        const gateway = spec.client || this.#spec(name).client ? undefined : gatewayOf();
        if (gateway) {
            const protocol = gatewayProtocol(kind, spec.model);
            return { protocol, apis: protocol === 'openai' ? GATEWAY_APIS : [], gateway };
        }
        const protocol = protocolOf(kind, spec.model);
        return { protocol, apis: apisOf(kind, protocol) };
    }

    /** One client per provider and protocol, keyed by the gateway it points at. */
    #gateway(name: string, protocol: GatewayProtocol, at: Gateway): ProviderClient {
        const key = `${name}\0gateway\0${protocol}\0${at.baseURL}\0${at.apiKey ?? ''}`;
        const existing = this.#clients.get(key);
        if (existing) {
            return existing;
        }
        const built = buildGatewayClient(name, this.kindOf(name), protocol, this.#spec(name), at);
        this.#clients.set(key, built);
        return built;
    }

    /** A Vertex provider's Claude or partner client: built once, beside its GenAI one. */
    #partner(name: string, protocol: 'anthropic' | 'openai', spec: ProviderSpec): ProviderClient {
        const key = `${name}\0${protocol}`;
        const existing = this.#clients.get(key);
        if (existing) {
            return existing;
        }
        const built = buildVertexPartner(name, protocol, spec);
        this.#clients.set(key, built);
        return built;
    }

    /**
     * The pacing shared by every embedder on a provider, so that what one of
     * them learns from a 429 the others do not have to learn again — and so
     * that two of them cannot each ramp up to the full limit against one key.
     */
    #limiter(name: string): RateLimiter {
        const existing = this.#limiters.get(name);
        if (existing) {
            return existing;
        }
        const spec = this.#providers.get(name);
        const built = new RateLimiter({
            max: spec?.concurrency,
            start:
                spec?.concurrency === undefined
                    ? undefined
                    : Math.min(spec.concurrency, DEFAULT_START),
            maxRetries: spec?.maxRetries,
        });
        this.#limiters.set(name, built);
        return built;
    }

    /**
     * Knobs a ref carries that its adapter will never read — the same check
     * `model()` refuses on, minus the client, so a report can name them before
     * a credential is resolved or anything is contacted.
     */
    knobs(ref: ModelRef): KnobIssue[] {
        const spec = typeof ref === 'string' ? this.parse(ref) : ref;
        const { protocol, apis } = this.#route(spec, spec.provider ?? this.#default);
        if (protocol !== 'openai') {
            return unreadKnobs(spec, protocol);
        }
        // An api this vendor does not speak already has an error of its own;
        // answering about its knobs would only bury it.
        const api = spec.api ?? apis[0];
        return api && apis.includes(api) ? unreadKnobs(spec, `openai/${api}`) : [];
    }

    /** Turns a shorthand or a spec into a `Model`. */
    model(ref: ModelRef): Model {
        const spec = typeof ref === 'string' ? this.parse(ref) : ref;
        const built = this.#build(spec);
        // What the trace records beside the wire id: the id alone has lost
        // which provider it went to.
        Object.defineProperty(built, 'ref', { value: this.refOf(spec), enumerable: false });
        return built;
    }

    #build(spec: ModelSpec): Model {
        const name = spec.provider ?? this.#default;
        const provider = this.#spec(name);
        const kind = this.kindOf(name);
        const { protocol, apis, gateway } = this.#route(spec, name);

        // Before the client, so a knob for the wrong vendor is reported as the
        // config mistake it is rather than behind a missing credential.
        const [stray] = this.knobs(spec);
        if (stray) {
            throw new TypeError(
                `provider "${name}" (${kind}) does not read "${stray.knob}" — a ` +
                    `${stray.target} model takes: ${stray.supported.join(', ')}`,
            );
        }

        // Inline credentials opt out of the shared client: they describe a
        // different connection, and handing back the memoized one would
        // silently ignore them.
        const client =
            spec.client ??
            (gateway
                ? this.#gateway(name, protocol as GatewayProtocol, gateway)
                : protocol !== KINDS[kind].protocol
                  ? this.#partner(name, protocol as 'anthropic' | 'openai', provider)
                  : hasCredentials(spec)
                    ? buildClient(name, kind, spec, provider)
                    : this.client(name));

        // The *resolved* name, not `spec.provider`: a bare ref carries none,
        // and a failure that cannot say which connection refused it is the
        // thing this is here to prevent.
        const options = { ...spec, provider: gateway ? `${name} via ${GATEWAY_NAME}` : name };

        // Every protocol but OpenAI's has exactly one API, so naming one is a
        // mistake worth reporting rather than a field to ignore.
        if (protocol !== 'openai') {
            if (spec.api) {
                throw new TypeError(
                    `provider "${name}" (${kind}) has one api, so "${spec.api}" means nothing here`,
                );
            }
            switch (protocol) {
                case 'anthropic':
                    return new AnthropicModel(
                        spec.model.replace(/^anthropic\//, ''),
                        client as Anthropic,
                        options,
                    );
                case 'gemini':
                    return new GeminiModel(spec.model, client as GoogleGenAI, options);
                case 'openrouter':
                    return new OpenRouterModel(spec.model, client as OpenRouter, options);
            }
        }

        const api = spec.api ?? apis[0];
        if (!apis.includes(api)) {
            throw new TypeError(
                `provider "${name}" (${kind}) does not speak the "${api}" api ` +
                    `(supported: ${apis.join(', ')})`,
            );
        }
        return api === 'responses'
            ? new OpenAIResponsesModel(spec.model, client as OpenAI, options)
            : new OpenAIModel(spec.model, client as OpenAI, options);
    }

    /**
     * Turns a shorthand or a spec into an `Embedder`, over the same providers
     * and the same shared clients as `model()` — an `openai` key declared once
     * generates and embeds without being mentioned twice.
     */
    embedder(ref: EmbeddingRef): Embedder {
        const spec = typeof ref === 'string' ? this.parseEmbedding(ref) : ref;
        const name = spec.provider ?? this.#default;
        const provider = this.#spec(name);
        const kind = this.kindOf(name);
        const { protocol, gateway } = this.#route(spec, name);

        const client =
            spec.client ??
            (gateway
                ? this.#gateway(name, protocol as GatewayProtocol, gateway)
                : hasCredentials(spec)
                  ? buildClient(name, kind, spec, provider)
                  : this.client(name));

        // Inline credentials are a different connection, and so a different
        // budget: they get pacing of their own rather than the provider's.
        const own = hasCredentials(spec) && !gateway;
        const options = {
            ...spec,
            provider: gateway ? `${name} via ${GATEWAY_NAME}` : name,
            limiter: spec.limiter ?? (own ? undefined : this.#limiter(name)),
        };

        switch (gateway ? protocol : KINDS[kind].protocol) {
            case 'openai':
                return new OpenAIEmbedder(spec.model, client as OpenAI, options);
            case 'gemini':
                return new GeminiEmbedder(spec.model, client as GoogleGenAI, options);
            case 'openrouter':
                return new OpenRouterEmbedder(spec.model, client as OpenRouter, options);
            case 'anthropic':
                // Not an omission to be filled in later: Anthropic publishes no
                // embeddings API at all, and points at third parties instead.
                throw new TypeError(
                    `provider "${name}" (${kind}) has no embeddings api — ` +
                        `declare a provider of another kind for \`embeddings:\``,
                );
        }
    }

    /**
     * What a ref needs to reach its vendor, resolved but not contacted. An
     * unknown provider still throws: that is a broken config, not a missing
     * credential, and the two want different words.
     */
    requirement(ref: ModelRef | EmbeddingRef): ModelRequirement {
        const spec = typeof ref === 'string' ? this.parse(ref) : ref;
        const name = spec.provider ?? this.#default;
        const provider = this.#spec(name);
        const kind = this.kindOf(name);
        const gateway = this.#route(spec, name).gateway;
        if (gateway) {
            return {
                provider: name,
                kind,
                apiKeyEnv: GATEWAY_KEY_ENV,
                satisfied: Boolean(gateway.apiKey),
                keyOptional: false,
                gateway: GATEWAY_NAME,
            };
        }
        const defaults = KINDS[kind];
        const creds: Credentials = hasCredentials(spec) ? spec : provider;
        const apiKeyEnv = creds.apiKeyEnv ?? defaults.apiKeyEnv;

        // An unset `${VAR}` is precisely the absent credential being asked
        // about, so it answers the question rather than interrupting it.
        let apiKey: string | undefined;
        try {
            apiKey = expand(creds.apiKey, `provider "${name}": apiKey`) ?? fromEnv(apiKeyEnv);
        } catch {
            apiKey = undefined;
        }

        return {
            provider: name,
            kind,
            apiKeyEnv,
            satisfied: Boolean(
                apiKey ??
                provider.token ??
                (spec.client || provider.client) ??
                defaults.keyOptional,
            ),
            keyOptional: Boolean(defaults.keyOptional),
        };
    }

    /** A shorthand → spec; see `ModelRef`. Exposed so a caller can validate a ref. */
    parse(ref: string): ModelSpec {
        return this.#read(ref).spec;
    }

    /**
     * The ref a spec is written as: `provider/id`, with Claude on Vertex under
     * its publisher. The colon form when that is the only one that reads back
     * the same — an api to carry, or an id the slash would split differently.
     */
    refOf(spec: { provider?: string; api?: string; model: string }): string {
        const name = spec.provider ?? this.#default;
        if (spec.api) {
            return `${name}/${spec.api}:${spec.model}`;
        }
        const model =
            this.kindOf(name) === 'vertex' && /^claude-/.test(spec.model)
                ? `anthropic/${spec.model}`
                : spec.model;
        const slash = `${name}/${model}`;
        try {
            const back = this.parse(slash);
            if ((back.provider ?? this.#default) === name && back.model === model && !back.api) {
                return slash;
            }
        } catch {
            // falls through to the form that always reads back
        }
        return `${name}:${model}`;
    }

    /** How `ref` is written, when that is not the way it would be written today. */
    refStyle(ref: string): ModelRefStyle | undefined {
        const { spec, form } = this.#read(ref);
        const canonical = this.refOf(spec);
        if (canonical === ref) {
            return undefined;
        }
        return { issue: form === 'slash' ? 'publisher' : form, canonical };
    }

    #read(ref: string): { spec: ModelSpec; form: 'slash' | 'colon' | 'bare' | 'ambiguous' } {
        const parts = splitModelRef(ref, (name) => this.has(name));
        if (parts.form === 'bare') {
            return { spec: { model: ref }, form: 'bare' };
        }
        const { provider, api, model } = parts;
        if (!model) {
            throw new TypeError(`missing model id in "${ref}"`);
        }
        if (parts.form === 'colon') {
            if (!provider || !this.has(provider)) {
                throw new TypeError(
                    `unknown provider "${provider}" in "${ref}" ` +
                        `(known: ${this.names().join(', ')}; a model id that itself contains a ` +
                        `colon must name its provider, e.g. "openai:${ref}")`,
                );
            }
            if (api !== undefined && !(MODEL_APIS as readonly string[]).includes(api)) {
                throw new TypeError(
                    `unknown api "${api}" in "${ref}" (expected chat or responses; an id ` +
                        'with a colon in it goes in the object form)',
                );
            }
            return { spec: { provider, api: api as OpenAIApi | undefined, model }, form: 'colon' };
        }
        // Before a slash named a provider, it was part of an id on the default
        // one — and on a default whose own ids have slashes (OpenRouter's
        // `anthropic/claude-…`, an endpoint of somebody's) that reading may be
        // the one that was meant. It is kept; `refStyle` asks for it written out.
        const fallback = this.#default;
        if (this.#slashIds(fallback) && (provider !== fallback || this.#repointed(fallback))) {
            return { spec: { model: ref }, form: 'ambiguous' };
        }
        return { spec: { provider, model }, form: 'slash' };
    }

    /** A provider whose own model ids may contain a slash. */
    #slashIds(name: string): boolean {
        const kind = this.kindOf(name);
        return (
            kind === 'openrouter' ||
            kind === 'vertex' ||
            kind === 'openai-compatible' ||
            this.#repointed(name)
        );
    }

    /** Declared at a base url of its own: a proxy may name its models any way it likes. */
    #repointed(name: string): boolean {
        const spec = this.#providers.get(name);
        return Boolean(spec?.baseURL || spec?.baseURLEnv);
    }

    /**
     * Splits a shorthand into the spec it stands for, so a caller holding
     * a shorthand can still set the knobs a shorthand has no room for.
     */
    parseEmbedding(ref: string): EmbeddingSpec {
        const { provider, api, model } = this.parse(ref);
        if (api) {
            throw new TypeError(
                `"${ref}": embeddings have one api, so "${api}" means nothing here`,
            );
        }
        return { provider, model };
    }

    #spec(name: string): ProviderSpec {
        const declared = this.#providers.get(name);
        if (declared) {
            return declared;
        }
        if (isProviderKind(name)) {
            return { kind: name };
        }
        throw new Error(
            `unknown provider "${name}" (known: ${this.names().join(', ')}; ` +
                `declare it under \`providers:\` or in ProjectOptions.providers)`,
        );
    }

    /** A declared kind wins; otherwise a built-in name is its own kind. */
    kindOf(name: string): ProviderKind {
        const declared = this.#providers.get(name)?.kind;
        return declared ?? (isProviderKind(name) ? name : 'openai');
    }
}

// ---------------------------------------------------------------------------
// Retries
// ---------------------------------------------------------------------------

/**
 * One backoff policy for every vendor, because a 429 is not a failure of the
 * run — it is the provider asking to be called again later, and an agent that
 * gives up on the first one loses the whole trajectory to a wait of a few
 * seconds. Every SDK here can retry, but none of them agree on what happens
 * when nothing is configured: the OpenAI and Anthropic clients retry twice,
 * `@google/genai` does not retry *at all* unless `retryOptions` is present, and
 * OpenRouter's generated client retries `5XX` only — so a Vertex or OpenRouter
 * 429 was fatal by default. These constants are what make the four behave the
 * same; `ProviderSpec.maxRetries` (0 disables) is the per-provider override.
 *
 * Retries live at the transport, not around `Model.generate`, so a retried call
 * is one that never started: no partial stream is replayed, and a `Retry-After`
 * header is honoured by the SDK that read it.
 */
const DEFAULT_MAX_RETRIES = 4;

/** wait after the first failure; doubles per attempt up to `RETRY_MAX_MS` */
const RETRY_INITIAL_MS = 1_000;
const RETRY_MAX_MS = 60_000;
const RETRY_EXPONENT = 2;

function retriesOf(opts: ProviderSpec): number {
    return Math.max(0, opts.maxRetries ?? DEFAULT_MAX_RETRIES);
}

/**
 * The same schedule expressed as a wall-clock budget, which is the only shape
 * OpenRouter's client accepts. It is the sum of the waits a count of `retries`
 * would spend, so the two agree on how long a hopeless call may take — not on
 * exactly how many times it is made, since this budget also has to cover the
 * requests themselves.
 */
function retryWindowMs(retries: number): number {
    let wait = RETRY_INITIAL_MS;
    let total = 0;
    for (let i = 0; i < retries; i++) {
        total += Math.min(wait, RETRY_MAX_MS);
        wait *= RETRY_EXPONENT;
    }
    return total;
}

/**
 * Credential resolution, in one place so a `${VAR}` reference behaves the same
 * whether it came from yaml or from application code. `creds` may be a model
 * spec overriding the connection; `opts` always carries the provider's
 * transport settings, which an override does not get to reinvent.
 */
function buildClient(
    name: string,
    kind: ProviderKind,
    creds: Credentials,
    opts: ProviderSpec,
): ProviderClient {
    const where = `provider "${name}"`;
    const defaults = KINDS[kind];

    // A token callback replaces the key rather than supplementing it: the
    // header is rewritten per request, so whatever the SDK was constructed with
    // never reaches the wire.
    const apiKeyEnv = creds.apiKeyEnv ?? defaults.apiKeyEnv;
    const apiKey = expand(creds.apiKey, `${where}: apiKey`) ?? fromEnv(apiKeyEnv);
    if (!apiKey && !opts.token && !defaults.keyOptional) {
        throw new Error(`${where}: no api key — set \`apiKey\`, or set ${apiKeyEnv}`);
    }
    // An absent base url means "vendor default", so it may stay undefined.
    const baseURL =
        expand(creds.baseURL, `${where}: baseURL`) ??
        fromEnv(creds.baseURLEnv ?? defaults.baseURLEnv) ??
        defaults.baseURL;
    const headers = expandHeaders(opts.headers, where);

    if (defaults.protocol === 'gemini') {
        return buildGenAI(kind, apiKey, baseURL, headers, opts, where);
    }
    if (defaults.protocol === 'openrouter') {
        return buildOpenRouter(kind, apiKey, baseURL, headers, opts);
    }

    const common = {
        apiKey: apiKey ?? OAUTH_PLACEHOLDER,
        baseURL,
        defaultHeaders: headers,
        timeout: opts.timeoutMs,
        maxRetries: retriesOf(opts),
        fetch: funded(opts.token ? bearerFetch(opts.token) : fetch),
    };
    if (defaults.protocol === 'anthropic') {
        const { Anthropic } = sdk<AnthropicModule>('@anthropic-ai/sdk', kind);
        return new Anthropic(common);
    }
    const { OpenAI } = sdk<OpenAIModule>('openai', kind);
    return new OpenAI(common);
}

/**
 * OpenRouter's client takes its base url as `serverURL` and its retry policy as
 * a strategy object rather than a count, so the shared `common` shape does not
 * fit — but the two things that usually need a custom `fetch` are cheaper here.
 *
 * A `token` callback goes straight in as `apiKey`, which this SDK accepts in
 * callable form and re-invokes per request; there is nothing to intercept.
 * Default headers have no constructor slot at all, so they are added by a
 * `beforeRequest` hook — the same seam the SDK uses for tracing headers.
 */
function buildOpenRouter(
    kind: ProviderKind,
    apiKey: string | undefined,
    baseURL: string | undefined,
    headers: Record<string, string> | undefined,
    opts: ProviderSpec,
): OpenRouter {
    const { OpenRouter, HTTPClient } = sdk<OpenRouterModule>('@openrouter/sdk', kind);
    let httpClient: HTTPClient | undefined;
    if (headers) {
        httpClient = new HTTPClient();
        httpClient.addHook('beforeRequest', (req) => {
            for (const [key, value] of Object.entries(headers)) {
                req.headers.set(key, value);
            }
            return req;
        });
    }
    const { token } = opts;
    const retries = retriesOf(opts);
    return new OpenRouter({
        apiKey: token ? async () => token() : apiKey,
        serverURL: baseURL,
        timeoutMs: opts.timeoutMs,
        // A count of zero is the one value that has to change shape: this SDK
        // says "do not retry" with a strategy, not with a number.
        retryConfig:
            retries === 0
                ? { strategy: 'none' }
                : {
                      strategy: 'backoff',
                      backoff: {
                          initialInterval: RETRY_INITIAL_MS,
                          maxInterval: RETRY_MAX_MS,
                          exponent: RETRY_EXPONENT,
                          maxElapsedTime: retryWindowMs(retries),
                      },
                      retryConnectionErrors: true,
                  },
        httpClient,
    });
}

/**
 * The GenAI client is configured by *backend* rather than by url: `vertexai`
 * selects the Gemini Enterprise endpoint and the SDK derives the address from
 * the project and region, so there is no base url to assemble here.
 *
 * Authentication differs the same way. The Gemini API takes a key; Vertex
 * normally takes none, because the SDK resolves Application Default
 * Credentials — a service account, a workload identity, `gcloud auth
 * application-default login` — and refreshes them itself. That is why `vertex`
 * is `keyOptional`, and why it needs none of the bearer-token machinery the
 * OpenAI protocol uses for the same job.
 *
 * A key and a project are alternatives, not a pair. An express-mode key
 * authenticates against `aiplatform.googleapis.com` with no project in the
 * path; naming a project as well makes the SDK build a project-scoped url and
 * then authenticate it with the key header — a combination the service refuses,
 * and one nothing in the resulting 403 attributes to having set both.
 */
function buildGenAI(
    kind: ProviderKind,
    apiKey: string | undefined,
    baseURL: string | undefined,
    headers: Record<string, string> | undefined,
    opts: ProviderSpec,
    where: string,
): GoogleGenAI {
    const { GoogleGenAI } = sdk<GenAIModule>('@google/genai', kind);
    const httpOptions = {
        baseUrl: baseURL,
        headers,
        timeout: opts.timeoutMs,
        retryOptions: genaiRetries(opts),
    };
    if (kind !== 'vertex') {
        return new GoogleGenAI({ apiKey, httpOptions });
    }
    if (apiKey) {
        return new GoogleGenAI({ vertexai: true, apiKey, httpOptions });
    }
    const project =
        expand(opts.project, `${where}: project`) ??
        fromEnv('GOOGLE_CLOUD_PROJECT') ??
        projectFromKeyFile();
    if (!project) {
        throw new Error(
            `${where}: vertex needs \`project\`, or GOOGLE_CLOUD_PROJECT ` +
                `(or \`apiKey\` for express mode)`,
        );
    }
    return new GoogleGenAI({
        vertexai: true,
        project,
        location:
            expand(opts.location, `${where}: location`) ??
            fromEnv('GOOGLE_CLOUD_LOCATION') ??
            'global',
        httpOptions,
    });
}

/**
 * `attempts` counts the initial call, so a retry budget of zero is one attempt.
 * Delays are fractions of a second here, unlike everywhere else.
 */
function genaiRetries(opts: ProviderSpec) {
    return {
        attempts: retriesOf(opts) + 1,
        initialDelay: RETRY_INITIAL_MS / 1000,
        maxDelay: RETRY_MAX_MS / 1000,
        expBase: RETRY_EXPONENT,
    };
}

/**
 * A client aimed at the gateway's drop-in endpoint for `protocol`, with the
 * virtual key in place of the vendor's. The provider keeps its transport
 * settings and headers; its own key and base url are what the gateway replaces.
 */
function buildGatewayClient(
    name: string,
    kind: ProviderKind,
    protocol: GatewayProtocol,
    opts: ProviderSpec,
    at: Gateway,
): ProviderClient {
    const baseURL = `${at.baseURL}${GATEWAY_PATHS[protocol]}`;
    // Every SDK refuses to construct without a key, even for a gateway that wants none.
    const apiKey = at.apiKey ?? GATEWAY_NAME;
    const headers = {
        ...expandHeaders(opts.headers, `provider "${name}"`),
        ...(at.apiKey ? { [GATEWAY_KEY_HEADER]: at.apiKey } : {}),
    };
    const routed = upstreamFetch(GATEWAY_UPSTREAMS[kind], protocol);
    if (protocol === 'gemini') {
        const { GoogleGenAI } = sdk<GenAIModule>('@google/genai', kind);
        return new GoogleGenAI({
            apiKey,
            httpOptions: {
                baseUrl: baseURL,
                headers,
                timeout: opts.timeoutMs,
                retryOptions: genaiRetries(opts),
                fetch: routed,
            },
        });
    }
    const common = {
        apiKey,
        baseURL,
        defaultHeaders: headers,
        timeout: opts.timeoutMs,
        maxRetries: retriesOf(opts),
        fetch: funded(routed),
    };
    if (protocol === 'anthropic') {
        const { Anthropic } = sdk<AnthropicModule>('@anthropic-ai/sdk', kind);
        return new Anthropic(common);
    }
    const { OpenAI } = sdk<OpenAIModule>('openai', kind);
    return new OpenAI(common);
}

/**
 * `project_id` out of a service-account key file, when one is named.
 *
 * The GenAI SDK resolves Application Default Credentials itself but takes the
 * project only from its constructor or `GOOGLE_CLOUD_PROJECT` — so a key file
 * that already states which project it belongs to still has to have that
 * repeated in the environment. Reading it here removes the second variable for
 * the common case.
 *
 * Only that one route carries a project id: credentials from `gcloud auth
 * application-default login` do not, and a metadata server answers a different
 * endpoint entirely. Both still need the project named, which is why a
 * failure to read anything here is not an error — the caller's own check is.
 */
function projectFromKeyFile(): string | undefined {
    const path = fromEnv('GOOGLE_APPLICATION_CREDENTIALS');
    if (!path) {
        return undefined;
    }
    try {
        const key: unknown = JSON.parse(readFileSync(path, 'utf8'));
        const id = (key as { project_id?: unknown }).project_id;
        return typeof id === 'string' && id.trim() ? id : undefined;
    } catch {
        // An unreadable or malformed file is the SDK's to report, at the point
        // where it tries to authenticate with it and can say so precisely.
        return undefined;
    }
}

// ---------------------------------------------------------------------------
// Vertex partner models
// ---------------------------------------------------------------------------

/** Gemini has these; the partner endpoints do not, and answer them with a bare 404. */
const MULTI_REGIONS = new Set(['us', 'eu']);

export interface VertexEndpoint {
    project: string;
    location: string;
    /** `https://…/v1/projects/<project>/locations/<location>` */
    base: string;
    /** a fresh access token from Application Default Credentials, or `spec.token` */
    token: () => Promise<string>;
}

/**
 * Where a Vertex provider's partner models are served, and how to authenticate
 * there. The GenAI SDK does both for Gemini; nothing does them for Claude or
 * the OpenAI-compatible endpoint, so they are resolved here the same way:
 * `project`, then GOOGLE_CLOUD_PROJECT, then the service-account file.
 */
export function vertexEndpoint(spec: ProviderSpec = {}, name = 'vertex'): VertexEndpoint {
    const where = `provider "${name}"`;
    const project =
        expand(spec.project, `${where}: project`) ??
        fromEnv('GOOGLE_CLOUD_PROJECT') ??
        projectFromKeyFile();
    if (!project) {
        throw new Error(
            `${where}: Claude and partner models on vertex need \`project\`, or ` +
                `GOOGLE_CLOUD_PROJECT, and a service account — an express-mode key reaches Gemini only`,
        );
    }
    const named =
        expand(spec.location, `${where}: location`) ?? fromEnv('GOOGLE_CLOUD_LOCATION') ?? 'global';
    const location = MULTI_REGIONS.has(named) ? 'global' : named;
    const host =
        location === 'global'
            ? 'https://aiplatform.googleapis.com'
            : `https://${location}-aiplatform.googleapis.com`;
    const token = spec.token;
    return {
        project,
        location,
        base: `${host}/v1/projects/${project}/locations/${location}`,
        token: token ? async () => token() : adcToken(),
    };
}

interface GoogleAuthModule {
    GoogleAuth: new (options: { scopes: string[] }) => {
        getAccessToken(): Promise<string | null | undefined>;
    };
}

/** Mints and refreshes tokens the way the GenAI SDK does for Gemini. */
function adcToken(): () => Promise<string> {
    let auth: InstanceType<GoogleAuthModule['GoogleAuth']> | undefined;
    return async () => {
        if (!auth) {
            // `@google/genai`'s own dependency, so it is resolved from there rather than declared twice.
            const genai = sdkPath('@google/genai', 'vertex');
            const { GoogleAuth } = createRequire(genai)('google-auth-library') as GoogleAuthModule;
            auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
        }
        const token = await auth.getAccessToken();
        if (!token) {
            throw new Error('vertex: Application Default Credentials gave no access token');
        }
        return token;
    };
}

function sdkPath(pkg: string, kind: ProviderKind): string {
    try {
        return requirePeer.resolve(pkg);
    } catch (cause) {
        throw new Error(
            `provider kind "${kind}" needs ${pkg}, which is not installed — run: npm i ${pkg}`,
            { cause },
        );
    }
}

function buildVertexPartner(
    name: string,
    protocol: 'anthropic' | 'openai',
    opts: ProviderSpec,
): Anthropic | OpenAI {
    const at = vertexEndpoint(opts, name);
    const common = {
        apiKey: OAUTH_PLACEHOLDER,
        defaultHeaders: expandHeaders(opts.headers, `provider "${name}"`),
        timeout: opts.timeoutMs,
        maxRetries: retriesOf(opts),
    };
    if (protocol === 'anthropic') {
        const { Anthropic } = sdk<AnthropicModule>('@anthropic-ai/sdk', 'vertex');
        return new Anthropic({
            ...common,
            baseURL: at.base,
            fetch: funded(rawPredictFetch(at.base, at.token)),
        });
    }
    const { OpenAI } = sdk<OpenAIModule>('openai', 'vertex');
    return new OpenAI({
        ...common,
        baseURL: `${at.base}/endpoints/openapi`,
        fetch: funded(bearerFetch(at.token)),
    });
}

/**
 * Anthropic's client posts to `/v1/messages`; Vertex wants the model in the
 * path and its own `anthropic_version` in the body instead.
 */
function rawPredictFetch(base: string, token: () => Promise<string>): typeof fetch {
    const authed = bearerFetch(token);
    return async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (!new URL(url).pathname.endsWith('/v1/messages') || typeof init?.body !== 'string') {
            return authed(input, init);
        }
        const { model, ...body } = JSON.parse(init.body) as { model: string; stream?: boolean };
        const headers = new Headers(init.headers);
        headers.delete('x-api-key');
        const verb = body.stream ? 'streamRawPredict' : 'rawPredict';
        return authed(`${base}/publishers/anthropic/models/${model}:${verb}`, {
            ...init,
            headers,
            body: JSON.stringify({ ...body, anthropic_version: 'vertex-2023-10-16' }),
        });
    };
}

// Both SDKs refuse to construct without a key. When a token callback owns the
// Authorization header this value is never sent, so it only has to be non-empty.
const OAUTH_PLACEHOLDER = 'oauth';

/**
 * Rewrites `Authorization` on every request from a callback, so a credential
 * that expires — an Azure AD token, a gateway's short-lived grant — is
 * refreshed without the client, and its connection pool, being rebuilt. Vertex
 * has no need of it: its SDK does the same job from ambient credentials.
 */
function bearerFetch(token: () => string | Promise<string>): typeof fetch {
    return async (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set('Authorization', `Bearer ${await token()}`);
        return fetch(input, { ...init, headers });
    };
}

/**
 * Tells the client not to wait out a 429 that no wait will clear.
 *
 * Both SDKs retry every 429, because a 429 is normally this minute's rate
 * limit — but an exhausted balance answers with the same status, and the whole
 * backoff schedule is then spent on a call that cannot succeed. The account is
 * named in the body rather than the status, so the body is what decides, and
 * `x-should-retry` is the SDKs' own override for exactly this.
 */
function funded(inner: typeof fetch): typeof fetch {
    return async (input, init) => {
        const res = await inner(input, init);
        if (res.status !== 429) {
            return res;
        }
        // A 429 body is a sentence long, and the client is about to read it
        // anyway to build the error it throws.
        const body = await res.text();
        const headers = new Headers(res.headers);
        // The transfer is already undone by the time a body is text.
        headers.delete('content-encoding');
        headers.delete('content-length');
        if (unfunded(body)) {
            headers.set('x-should-retry', 'false');
        }
        return new Response(body, { status: res.status, statusText: res.statusText, headers });
    };
}

/** Whether a refusal body names the account rather than the rate. */
function unfunded(body: string): boolean {
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        return false;
    }
    const root = parsed as { error?: unknown };
    const said = (root?.error ?? root) as { code?: unknown; type?: unknown } | null;
    return Boolean(said) && (unfundedSymbol(said?.code) || unfundedSymbol(said?.type));
}

function expandHeaders(
    headers: Record<string, string> | undefined,
    where: string,
): Record<string, string> | undefined {
    if (!headers) {
        return undefined;
    }
    return Object.fromEntries(
        Object.entries(headers).map(([k, v]) => [k, expandEnv(v, `${where}: headers.${k}`)]),
    );
}

function hasCredentials(spec: Credentials): boolean {
    return Boolean(spec.apiKey || spec.apiKeyEnv || spec.baseURL || spec.baseURLEnv);
}

// ---------------------------------------------------------------------------
// Default registry
// ---------------------------------------------------------------------------

/**
 * The registry behind the bare `createModel`. An application that never
 * declares a provider still gets shared clients through it, because the
 * built-in names (`openai`, `google`, …) resolve without declaration.
 */
export const defaultModels = new ModelRegistry();

/**
 * One entry point for every provider. Accepts a shorthand string or a full
 * spec, so `createModel('openai/responses:o3')` and
 * `createModel({ model: 'o3', api: 'responses', apiKeyEnv: 'MY_KEY' })` are
 * both valid.
 */
export function createModel(ref: ModelRef, registry: ModelRegistry = defaultModels): Model {
    return registry.model(ref);
}

/** `createModel`'s counterpart for vectors, over the same registry and clients. */
export function createEmbedder(
    ref: EmbeddingRef,
    registry: ModelRegistry = defaultModels,
): Embedder {
    return registry.embedder(ref);
}
