import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GeminiEmbedder } from '../src/embeddings/gemini.ts';
import { OpenAIEmbedder } from '../src/embeddings/openai.ts';
import { OpenRouterEmbedder } from '../src/embeddings/openrouter.ts';
import type { Model } from '../src/model.ts';
import { AnthropicModel } from '../src/models/anthropic.ts';
import { GeminiModel } from '../src/models/gemini.ts';
import { OpenAIModel } from '../src/models/openai-chat.ts';
import { OpenAIResponsesModel } from '../src/models/openai-responses.ts';
import { OpenRouterModel } from '../src/models/openrouter.ts';
import { loadProject, type AgentProject } from '../src/project/index.ts';

// ---------------------------------------------------------------------------
// Model configuration, by example
//
// The fixtures in ./configs are committed rather than written to a temp
// directory — unlike the ones in project.test.ts, which are about the loader
// and are clearest inline. These are about the *configuration language*, so
// they are meant to be read as much as run: each folder is a single annotated
// `agents.yaml` covering one theme, and the assertions below are the proof
// that the annotations are true.
//
// Nothing here touches the network. Building a client constructs an SDK object
// and resolves credentials; it sends nothing until a request is made, and no
// request is made.
// ---------------------------------------------------------------------------

const CONFIGS = fileURLToPath(new URL('./configs/', import.meta.url));

function load(dir: string): Promise<AgentProject> {
    return loadProject(CONFIGS + dir);
}

/**
 * The four SDKs describe a connection with four different shapes, and the
 * GenAI one does not declare its fields publicly at all. Reaching through a
 * cast is the price of asserting on what was actually built rather than on
 * what we asked for.
 */
interface Conn {
    apiKey?: string | null;
    baseURL?: string;
    vertexai?: boolean;
    project?: string;
    location?: string;
    /** OpenAI and Anthropic count retries */
    maxRetries?: number;
    /** GenAI counts attempts, the first one included, and only when asked */
    httpOptions?: { retryOptions?: { attempts?: number } };
    /** OpenRouter takes a strategy rather than a count */
    retryConfig?: { strategy: string };
}

const conn = (client: unknown): Conn => client as Conn;

/**
 * OpenRouter's client is the one that does not expose its connection at all:
 * the resolved options sit behind `_options`, and the base url is called
 * `serverURL` there. Kept separate from `conn` rather than folded into it
 * because the OpenAI client also has an `_options`, holding something else.
 */
const orConn = (client: unknown): Conn => {
    const { _options } = client as { _options: Conn & { serverURL?: string } };
    return { ..._options, baseURL: _options.serverURL };
};

function modelOf(project: AgentProject, agent: string): Model {
    const model = project.registry.get(agent).model;
    if (!model) {
        throw new Error(`agent "${agent}" resolved no model`);
    }
    return model;
}

/**
 * Everything the fixtures reference. Stubbed rather than assumed, so the suite
 * says the same thing on a laptop with real keys in `.env` and on a runner
 * with none.
 */
const ENV: Record<string, string> = {
    OPENAI_API_KEY: 'sk-openai',
    ANTHROPIC_API_KEY: 'sk-anthropic',
    OPENROUTER_API_KEY: 'sk-openrouter',
    GOOGLE_CLOUD_PROJECT: 'zn-default-project',
    ZN_OPENAI_EU_KEY: 'sk-openai-eu',
    ZN_OPENROUTER_KEY: 'sk-openrouter-spare',
    ZN_KEY_ONE: 'sk-one',
    ZN_KEY_TWO: 'sk-two',
    ZN_GATEWAY_KEY: 'sk-gateway',
    ZN_GEMINI_KEY: 'sk-gemini',
    GEMINI_API_KEY: 'sk-gemini-default',
    ZN_ANTHROPIC_KEY: 'sk-claude',
    ZN_GCP_PROJECT: 'zn-eu-project',
    ZN_ENV_KEY: 'sk-env',
    ZN_HOST: 'gateway.example',
    // The fixtures that demonstrate an *absent* variable. An empty value reads
    // as unset, which is what makes the assertion independent of the ambient
    // environment.
    ZN_UNSET_KEY: '',
    ZN_DEFINITELY_UNSET: '',
    ZN_NO_SUCH_KEY: '',
    GOOGLE_CLOUD_LOCATION: '',
    // A gateway in the developer's `.env` would reroute every fixture.
    BIFROST_BASE_URL: '',
};

beforeEach(() => {
    for (const [key, value] of Object.entries(ENV)) {
        vi.stubEnv(key, value);
    }
});

afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------

describe('configs/shorthand', () => {
    it('reads every form of [provider[/api]:]model', async () => {
        const p = await load('shorthand');

        expect(p.entry).toBe('bare');
        expect(p.registry.names()).toEqual([
            'bare',
            'prefixed',
            'with-api',
            'fine-tuned',
            'declared',
        ]);

        // No prefix and an explicit one land on the same built-in provider,
        // and `chat` is the openai default of the two APIs.
        expect(modelOf(p, 'bare')).toBeInstanceOf(OpenAIModel);
        expect(modelOf(p, 'bare').id).toBe('gpt-4o');
        expect(modelOf(p, 'prefixed')).toBeInstanceOf(OpenAIModel);

        expect(modelOf(p, 'with-api')).toBeInstanceOf(OpenAIResponsesModel);
        expect(modelOf(p, 'with-api').id).toBe('o3');
    });

    it('splits on the first colon only, so a fine-tuned id survives', async () => {
        const p = await load('shorthand');
        expect(modelOf(p, 'fine-tuned').id).toBe('ft:gpt-4o:acme::a1b2');
    });

    it('reads the prefix as a provider name, not a vendor', async () => {
        const p = await load('shorthand');

        expect(modelOf(p, 'declared').id).toBe('o3');
        expect(conn(p.models.client('openai-eu')).baseURL).toBe('https://eu.api.openai.com/v1');
        expect(conn(p.models.client('openai-eu')).apiKey).toBe('sk-openai-eu');
    });
});

describe('configs/named-models', () => {
    it('resolves an alias, and the fallback for agents that pin nothing', async () => {
        const p = await load('named-models');

        expect(p.entry).toBe('intake'); // `default: true`, no top-level `default:`
        expect(modelOf(p, 'intake').id).toBe('gpt-4o-mini');
        expect(modelOf(p, 'analyst')).toBeInstanceOf(OpenAIResponsesModel);
        expect(modelOf(p, 'analyst').id).toBe('o3');
    });

    it('gives two agents naming one alias one model', async () => {
        const p = await load('named-models');
        expect(modelOf(p, 'reviewer')).toBe(modelOf(p, 'analyst'));
    });

    it('falls through to the shorthand for a name the map does not hold', async () => {
        const p = await load('named-models');
        expect(modelOf(p, 'scratch').id).toBe('gpt-4o');
        expect(modelOf(p, 'scratch')).not.toBe(modelOf(p, 'intake'));
    });
});

describe('configs/providers', () => {
    it('gives two names for one vendor two keys and two clients', async () => {
        const p = await load('providers');

        expect(conn(p.models.client('primary')).apiKey).toBe('sk-one');
        expect(conn(p.models.client('secondary')).apiKey).toBe('sk-two');
        expect(conn(p.models.client('secondary')).baseURL).toBe('https://eu.example/v1');
        expect(p.models.client('primary')).not.toBe(p.models.client('secondary'));
    });

    it('builds one client per name and shares it', async () => {
        const p = await load('providers');
        expect(p.models.client('primary')).toBe(p.models.client('primary'));
    });

    it('takes a key from a named variable', async () => {
        const p = await load('providers');
        expect(conn(p.models.client('gateway')).apiKey).toBe('sk-gateway');
        expect(conn(p.models.client('gateway')).baseURL).toBe('https://gateway.example/v1');
    });

    it('keeps two models on one connection distinct', async () => {
        const p = await load('providers');
        expect(modelOf(p, 'one').id).toBe('gpt-4o');
        expect(modelOf(p, 'three').id).toBe('gpt-4o-mini');
        expect(modelOf(p, 'one')).not.toBe(modelOf(p, 'three'));
    });
});

// A rate limit is the provider asking to be called again shortly, so every
// connection is built with a backoff budget whether or not one was declared.
// Two of these SDKs retry nothing by default, which is what makes the
// assertions worth having: they are about what was configured, not about what
// the vendor happens to do.
describe('retries', () => {
    it('gives an undeclared connection the default budget', async () => {
        const p = await load('providers');
        expect(conn(p.models.client('primary')).maxRetries).toBe(2);
    });

    it('honours a declared count', async () => {
        const p = await load('providers');
        expect(conn(p.models.client('gateway')).maxRetries).toBe(5);
    });

    it('asks the genai client to retry, which it otherwise never does', async () => {
        const p = await load('vendors');
        // `attempts` counts the initial call.
        expect(conn(p.models.client('gemini')).httpOptions?.retryOptions?.attempts).toBe(3);
    });

    it('gives openrouter a backoff strategy', async () => {
        const p = await load('openrouter');
        expect(orConn(p.models.client('openrouter')).retryConfig?.strategy).toBe('backoff');
    });

    // The one 429 that is not a rate limit. The SDK retries every one of them,
    // so an exhausted balance spends the whole schedule — a minute of waiting
    // per call — on a refusal no wait can clear. The account is named in the
    // body, which is why the client is handed a fetch that reads it.
    it('refuses to retry a 429 that means an empty account', async () => {
        const refusal = (code: string): Response =>
            new Response(JSON.stringify({ error: { code, message: 'no credits' } }), {
                status: 429,
                headers: { 'content-type': 'application/json' },
            });
        let code = 'credit_balance_exhausted';
        vi.stubGlobal(
            'fetch',
            vi.fn(() => Promise.resolve(refusal(code))),
        );
        const p = await load('providers');
        const { fetch: sent } = p.models.client('primary') as unknown as { fetch: typeof fetch };

        const empty = await sent('https://example.invalid/v1/responses', { method: 'POST' });
        expect(empty.headers.get('x-should-retry')).toBe('false');
        // The body still has to arrive: it is the sentence the error reports.
        expect(await empty.json()).toMatchObject({ error: { message: 'no credits' } });

        code = 'rate_limit_exceeded';
        const busy = await sent('https://example.invalid/v1/responses', { method: 'POST' });
        expect(busy.headers.get('x-should-retry')).toBeNull();
    });
});

describe('configs/vendors', () => {
    it('picks an adapter per protocol', async () => {
        const p = await load('vendors');

        expect(modelOf(p, 'chat')).toBeInstanceOf(OpenAIModel);
        expect(modelOf(p, 'responses')).toBeInstanceOf(OpenAIResponsesModel);
        expect(modelOf(p, 'google-api')).toBeInstanceOf(GeminiModel);
        expect(modelOf(p, 'vertex-regional')).toBeInstanceOf(GeminiModel);
        expect(modelOf(p, 'vertex-default')).toBeInstanceOf(GeminiModel);
        expect(modelOf(p, 'anthropic')).toBeInstanceOf(AnthropicModel);
    });

    it('separates the two google backends', async () => {
        const p = await load('vendors');

        const api = conn(p.models.client('gemini'));
        expect(api.vertexai).toBeFalsy();
        expect(api.apiKey).toBe('sk-gemini');

        const eu = conn(p.models.client('vertex-eu'));
        expect(eu.vertexai).toBe(true);
        expect(eu.project).toBe('zn-eu-project');
        expect(eu.location).toBe('europe-west4');
    });

    it('resolves the built-in vertex name with no key and no declaration', async () => {
        const p = await load('vendors');

        const built = conn(p.models.client('vertex'));
        expect(built.vertexai).toBe(true);
        expect(built.project).toBe('zn-default-project'); // GOOGLE_CLOUD_PROJECT
        expect(built.location).toBe('global');
    });
});

describe('configs/tuning', () => {
    it('accepts the knobs of each vendor on the vendor they belong to', async () => {
        const p = await load('tuning');

        expect(p.config.models?.['openai-reasoning']).toMatchObject({
            reasoningEffort: 'high',
            reasoningSummary: 'detailed',
            store: false,
        });
        expect(p.config.models?.['gemini-budgeted']).toMatchObject({
            thinkingBudget: 4096,
            includeThoughts: false,
        });
        expect(p.config.models?.['gemini-thinking-off']).toMatchObject({ thinkingBudget: 0 });
        expect(p.config.models?.['gemini-levelled']).toMatchObject({
            thinkingLevel: 'high',
            maxTokens: 8192,
        });
        expect(p.config.models?.['claude-thinking']).toMatchObject({
            maxTokens: 16000,
            thinkingBudgetTokens: 8000,
        });
        expect(p.config.models?.['router-picky']).toMatchObject({
            routing: {
                only: ['azure', 'together'],
                ignore: ['deepinfra'],
                allowFallbacks: false,
                dataCollection: 'deny',
                quantizations: ['fp8', 'bf16'],
                zdr: true,
            },
            serviceTier: 'priority',
        });
        expect(p.config.models?.['router-shared']).toMatchObject({
            reasoningEffort: 'low',
            reasoningSummary: 'concise',
            maxTokens: 2048,
            fallbacks: ['google/gemini-3.5-flash'],
        });
    });

    it('builds each of them', async () => {
        const p = await load('tuning');

        expect(modelOf(p, 'a')).toBeInstanceOf(OpenAIResponsesModel);
        expect(modelOf(p, 'b')).toBeInstanceOf(GeminiModel);
        expect(modelOf(p, 'e').id).toBe('gemini-3.5-flash-lite');
        expect(modelOf(p, 'g')).toBeInstanceOf(AnthropicModel);
        expect(modelOf(p, 'h')).toBeInstanceOf(OpenRouterModel);
    });
});

describe('configs/openrouter', () => {
    it('needs nothing but the kind: the base url and key env are its defaults', async () => {
        const p = await load('openrouter');

        // `openrouter` is never declared in that fixture.
        const built = orConn(p.models.client('openrouter'));
        expect(built.baseURL).toBe('https://openrouter.ai/api/v1');
        expect(built.apiKey).toBe('sk-openrouter');
    });

    it('speaks its own protocol, and refuses to be asked for an api', async () => {
        const p = await load('openrouter');

        expect(modelOf(p, 'careful')).toBeInstanceOf(OpenRouterModel);
        expect(modelOf(p, 'cheap')).toBeInstanceOf(OpenRouterModel);
        expect(modelOf(p, 'bare')).toBeInstanceOf(OpenRouterModel);
    });

    it('carries routing and fallbacks through to the spec', async () => {
        const p = await load('openrouter');

        // The two knobs that are the reason this kind has an adapter at all:
        // neither has anywhere to go in a chat-completions request.
        expect(p.config.models?.routed).toMatchObject({
            routing: { order: ['azure', 'openai'], requireParameters: true, sort: 'throughput' },
            fallbacks: ['anthropic/claude-sonnet-4.5', 'google/gemini-3.5-flash'],
        });
        expect(modelOf(p, 'routed')).toBeInstanceOf(OpenRouterModel);
    });

    it('keeps the vendor prefix and the variant suffix inside the model id', async () => {
        const p = await load('openrouter');

        // The slash belongs to the id; only the first colon separates, so a
        // `:free` or `:nitro` variant survives the shorthand intact.
        expect(modelOf(p, 'bare').id).toBe('google/gemini-3.5-flash');
        expect(modelOf(p, 'free').id).toBe('z-ai/glm-5.2:free');
        expect(modelOf(p, 'spare-key').id).toBe('x-ai/grok-4:nitro');
    });

    it('gives a second key against one gateway a second client', async () => {
        const p = await load('openrouter');

        expect(orConn(p.models.client('spare')).apiKey).toBe('sk-openrouter-spare');
        expect(orConn(p.models.client('spare')).baseURL).toBe('https://openrouter.ai/api/v1');
        expect(p.models.client('spare')).not.toBe(p.models.client('openrouter'));
    });

    it('carries attribution as ordinary headers on the connection', async () => {
        const p = await load('openrouter');

        expect(p.config.providers?.attributed?.headers).toMatchObject({
            'HTTP-Referer': 'https://zenera.example',
            'X-Title': 'Zenera Neo',
        });
    });
});

describe('configs/env', () => {
    it('substitutes ${VAR}, and falls back to ${VAR:-default}', async () => {
        const p = await load('env');

        expect(conn(p.models.client('from-env')).apiKey).toBe('sk-env');
        expect(conn(p.models.client('with-default')).apiKey).toBe('sk-fallback');
    });

    it('composes a reference inside a longer value', async () => {
        const p = await load('env');
        expect(conn(p.models.client('composed')).baseURL).toBe('https://gateway.example/v1');
    });

    it('loads a project holding a provider whose variable is unset', async () => {
        const p = await load('env');

        // Loading succeeded, which is the assertion. Reaching for the client is
        // what reads the environment — and it names the variable.
        expect(() => p.models.client('never-used')).toThrow('${ZN_DEFINITELY_UNSET} is not set');
    });
});

describe('configs/inline-credentials', () => {
    it('leaves the shared connection alone when a model brings its own', async () => {
        const p = await load('inline-credentials');

        expect(modelOf(p, 'one').id).toBe('gpt-4o');
        expect(modelOf(p, 'two').id).toBe('gpt-4o');
        expect(modelOf(p, 'three').id).toBe('gpt-4o');
        expect(conn(p.models.client('shared')).apiKey).toBe('sk-one');
    });
});

describe('configs/default-provider', () => {
    it('repoints where a bare model id belongs', async () => {
        const p = await load('default-provider');

        expect(p.models.defaultProvider).toBe('house');
        expect(modelOf(p, 'one').id).toBe('llama-3.3-70b');
        expect(conn(p.models.client('house')).baseURL).toBe('https://house.example/v1');
    });

    it('still lets an explicit prefix win, and applies to the fallback', async () => {
        const p = await load('default-provider');

        expect(modelOf(p, 'two').id).toBe('gpt-4o');
        expect(modelOf(p, 'three').id).toBe('llama-3.1-8b');
    });
});

describe('configs/embeddings', () => {
    it('resolves an alias, and the default for a caller that names none', async () => {
        const p = await load('embeddings');

        expect(p.embedder()?.id).toBe('text-embedding-3-large');
        expect(p.embedder('small')).toBeInstanceOf(OpenAIEmbedder);
        expect(p.embedder('small')?.id).toBe('text-embedding-3-small');
    });

    it('picks the adapter from the provider, as `models:` does', async () => {
        const p = await load('embeddings');

        expect(p.embedder('gemini')).toBeInstanceOf(GeminiEmbedder);
        expect(p.embedder('gemini')?.id).toBe('gemini-embedding-001');
        expect(p.embedder('routed')).toBeInstanceOf(OpenRouterEmbedder);
    });

    it('memoizes, and shares one client with the models on that provider', async () => {
        const p = await load('embeddings');

        expect(p.embedder('large')).toBe(p.embedder('large'));
        // `model: house:gpt-4o` and the `large` embedding name one provider,
        // so they are one connection rather than two.
        expect(conn(p.models.client('house')).apiKey).toBe('sk-one');
    });

    it('falls through to the shorthand for a name the map does not hold', async () => {
        const p = await load('embeddings');
        expect(p.embedder('openai:text-embedding-3-small')?.id).toBe('text-embedding-3-small');
    });
});

// ---------------------------------------------------------------------------
// The ones that must not load//
// Every failure below is a load-time failure: a broken configuration is caught
// at startup, with the offending key named, rather than three turns into a
// production run as a model error nobody can act on.
// ---------------------------------------------------------------------------

describe('configs/invalid', () => {
    const cases: [dir: string, message: RegExp][] = [
        ['unknown-provider', /agents\.solo\.model: unknown provider "openai-eu"/],
        ['unused-alias-typo', /models\.careful\.provider: unknown provider "openai-ue"/],
        ['api-on-single-api-vendor', /has one api, so "chat" means nothing here/],
        ['unknown-api', /unknown api "completions"/],
        // Well formed, and still refused: the word parses, the kind has no apis.
        ['openrouter-responses', /has one api, so "responses" means nothing here/],
        ['missing-model', /models\.broken/],
        ['unknown-kind', /providers\.mistral\.kind/],
        ['unknown-key', /providers\.house[\s\S]*retries/],
        // A model entry is a union, so a strict failure in the object branch
        // reports the entry rather than the offending key.
        ['unknown-model-key', /models\.hot/],
        ['missing-key', /no api key[\s\S]*ZN_NO_SUCH_KEY/],
        ['bad-name', /agents\[0\]\.name[\s\S]*lower-case/],
        // Not an omission in this library: Anthropic publishes no such endpoint.
        ['embedding-without-vendor', /has no embeddings api/],
    ];

    it.each(cases)('rejects %s', async (dir, message) => {
        await expect(load(`invalid/${dir}`)).rejects.toThrow(message);
    });
});
