import {
    FinishReason,
    FunctionCallingConfigMode,
    type Content,
    type GenerateContentParameters,
    type GenerateContentResponse,
    type GoogleGenAI,
    type Part,
} from '@google/genai';
import type { OpenRouter } from '@openrouter/sdk';
import type {
    ChatAssistantMessage,
    ChatContentItems,
    ChatRequest,
    ChatResult,
    ChatUsage,
} from '@openrouter/sdk/models';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StreamDelta } from '../src/events.ts';
import type { ModelRequest } from '../src/model.ts';
import { AnthropicModel } from '../src/models/anthropic.ts';
import { expandEnv, ModelRegistry, vertexRoute } from '../src/models/factory.ts';
import { GeminiModel } from '../src/models/gemini.ts';
import { OpenAIModel } from '../src/models/openai-chat.ts';
import { OpenAIResponsesModel } from '../src/models/openai-responses.ts';
import { OpenRouterModel } from '../src/models/openrouter.ts';
import { text, type Message } from '../src/types.ts';

// ---------------------------------------------------------------------------
// Model configuration
//
// A provider is a connection and a model is a request shape; almost everything
// worth asserting here is about that seam holding — that credentials belong to
// a name, that the name owns exactly one client, and that a model naming it
// gets that client rather than one of its own.
// ---------------------------------------------------------------------------

/**
 * The three SDKs describe a connection with three different shapes, and the
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
}

const conn = (client: unknown): Conn => client as Conn;

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('environment references', () => {
    it('substitutes ${VAR}', () => {
        vi.stubEnv('ZN_HOST', 'gateway.example');
        expect(expandEnv('https://${ZN_HOST}/v1', 'where')).toBe('https://gateway.example/v1');
    });

    it('falls back to ${VAR:-default}', () => {
        vi.stubEnv('ZN_HOST', '');
        expect(expandEnv('${ZN_HOST:-localhost}', 'where')).toBe('localhost');
    });

    it('names the variable and the place when it is unset', () => {
        vi.stubEnv('ZN_MISSING', '');
        expect(() => expandEnv('${ZN_MISSING}', 'provider "eu": apiKey')).toThrow(
            'provider "eu": apiKey: ${ZN_MISSING} is not set',
        );
    });

    it('leaves a literal alone', () => {
        expect(expandEnv('sk-literal-key', 'where')).toBe('sk-literal-key');
    });
});

describe('shorthand', () => {
    const models = new ModelRegistry();

    it('reads [provider[/api]:]model', () => {
        expect(models.parse('gpt-4o')).toEqual({ model: 'gpt-4o' });
        expect(models.parse('openai:gpt-4o')).toEqual({
            provider: 'openai',
            api: undefined,
            model: 'gpt-4o',
        });
        expect(models.parse('openai/responses:o3')).toEqual({
            provider: 'openai',
            api: 'responses',
            model: 'o3',
        });
    });

    it('splits on the first colon only, so a fine-tuned id survives', () => {
        expect(models.parse('openai:ft:gpt-4o:acme::a1b2')).toEqual({
            provider: 'openai',
            api: undefined,
            model: 'ft:gpt-4o:acme::a1b2',
        });
    });

    it('rejects an unknown provider and says how to spell a colon-bearing id', () => {
        expect(() => models.parse('ft:gpt-4o:acme::a1b2')).toThrow(/unknown provider "ft"/);
        expect(() => models.parse('ft:gpt-4o:acme::a1b2')).toThrow(/must name its provider/);
    });

    it('rejects an unknown api', () => {
        expect(() => models.parse('openai/completions:gpt-4o')).toThrow(/unknown api/);
    });

    it('resolves a declared provider name in the prefix', () => {
        const reg = new ModelRegistry().provider('openai-eu', { baseURL: 'https://eu/v1' });
        expect(reg.parse('openai-eu:o3').provider).toBe('openai-eu');
    });

    it('reads provider/id, the id keeping its own slashes and colons', () => {
        expect(models.parse('openai/gpt-5-mini')).toEqual({
            provider: 'openai',
            model: 'gpt-5-mini',
        });
        expect(models.parse('vertex/anthropic/claude-opus-5')).toEqual({
            provider: 'vertex',
            model: 'anthropic/claude-opus-5',
        });
        expect(models.parse('openrouter/inclusionai/ling-3.0-flash-fin:free')).toEqual({
            provider: 'openrouter',
            model: 'inclusionai/ling-3.0-flash-fin:free',
        });
        // not a provider, so the whole thing is an id on the default one
        expect(models.parse('meta-llama/Llama-3-8B')).toEqual({ model: 'meta-llama/Llama-3-8B' });
    });

    it('keeps the old meaning of a slash on a default whose ids have slashes', () => {
        const router = new ModelRegistry().setDefault('openrouter');
        expect(router.parse('anthropic/claude-sonnet-5')).toEqual({
            model: 'anthropic/claude-sonnet-5',
        });
        expect(router.parse('openrouter/anthropic/claude-sonnet-5')).toEqual({
            provider: 'openrouter',
            model: 'anthropic/claude-sonnet-5',
        });
        const proxy = new ModelRegistry()
            .provider('house', { baseURL: 'https://litellm/v1' })
            .setDefault('house');
        expect(proxy.parse('house/gpt-4o')).toEqual({ model: 'house/gpt-4o' });
    });

    it('writes refs as provider/id, and the colon form only when the slash would not read back', () => {
        expect(models.refOf({ model: 'gpt-4o' })).toBe('openai/gpt-4o');
        expect(models.refOf({ provider: 'vertex', model: 'claude-opus-5' })).toBe(
            'vertex/anthropic/claude-opus-5',
        );
        expect(models.refOf({ provider: 'openai', api: 'responses', model: 'o3' })).toBe(
            'openai/responses:o3',
        );
        expect(models.refOf({ provider: 'openai', model: 'ft:gpt-4o:acme::a1b2' })).toBe(
            'openai:ft:gpt-4o:acme::a1b2',
        );
        const router = new ModelRegistry().setDefault('openrouter');
        expect(router.refOf(router.parse('anthropic/claude-sonnet-5'))).toBe(
            'openrouter/anthropic/claude-sonnet-5',
        );
    });

    it('says how an older ref is written today, without changing what it means', () => {
        expect(models.refStyle('openai/gpt-5-mini')).toBeUndefined();
        expect(models.refStyle('openai/responses:o3')).toBeUndefined();
        expect(models.refStyle('openai:gpt-4o')).toEqual({
            issue: 'colon',
            canonical: 'openai/gpt-4o',
        });
        expect(models.refStyle('gpt-4o')).toEqual({ issue: 'bare', canonical: 'openai/gpt-4o' });
        expect(models.refStyle('vertex/claude-opus-5')).toEqual({
            issue: 'publisher',
            canonical: 'vertex/anthropic/claude-opus-5',
        });
        const router = new ModelRegistry().setDefault('openrouter');
        expect(router.refStyle('anthropic/claude-sonnet-5')).toEqual({
            issue: 'ambiguous',
            canonical: 'openrouter/anthropic/claude-sonnet-5',
        });
    });

    it('records the ref on the model it builds', () => {
        const reg = new ModelRegistry().provider('openai', { apiKey: 'sk-test' });
        const model = reg.model('openai:gpt-4o');
        expect(model.id).toBe('gpt-4o');
        expect(model.ref).toBe('openai/gpt-4o');
    });
});

describe('providers', () => {
    it('gives two names for one vendor two keys and two clients', () => {
        const models = new ModelRegistry()
            .provider('primary', { apiKey: 'sk-one' })
            .provider('secondary', { apiKey: 'sk-two', baseURL: 'https://eu.example/v1' });

        expect(conn(models.client('primary')).apiKey).toBe('sk-one');
        expect(conn(models.client('secondary')).apiKey).toBe('sk-two');
        expect(conn(models.client('secondary')).baseURL).toBe('https://eu.example/v1');
    });

    it('builds one client per name and shares it', () => {
        const models = new ModelRegistry().provider('shared', { apiKey: 'sk-one' });
        expect(models.client('shared')).toBe(models.client('shared'));
    });

    it('reads ${VAR} in credentials, but not before the provider is used', () => {
        const models = new ModelRegistry().provider('lazy', { apiKey: '${ZN_UNSET_KEY}' });
        // Declaring it read nothing; only reaching for the client does.
        vi.stubEnv('ZN_UNSET_KEY', '');
        expect(() => models.client('lazy')).toThrow('${ZN_UNSET_KEY} is not set');

        vi.stubEnv('ZN_UNSET_KEY', 'sk-late');
        expect(
            conn(new ModelRegistry().provider('lazy', { apiKey: '${ZN_UNSET_KEY}' }).client('lazy'))
                .apiKey,
        ).toBe('sk-late');
    });

    it('drops the memoized client when a name is re-declared', () => {
        const models = new ModelRegistry().provider('p', { apiKey: 'sk-one' });
        const first = models.client('p');
        models.provider('p', { apiKey: 'sk-two' });
        expect(models.client('p')).not.toBe(first);
        expect(conn(models.client('p')).apiKey).toBe('sk-two');
    });

    it('works with no declaration at all for the built-in kinds', () => {
        vi.stubEnv('OPENAI_API_KEY', 'sk-env');
        expect(conn(new ModelRegistry().client('openai')).apiKey).toBe('sk-env');
    });

    it('names the env var it looked in when there is no key', () => {
        vi.stubEnv('GEMINI_API_KEY', '');
        expect(() => new ModelRegistry().client('google')).toThrow(
            'provider "google": no api key — set `apiKey`, or set GEMINI_API_KEY',
        );
    });

    it('rejects an unknown kind at declaration time', () => {
        expect(() => new ModelRegistry().provider('x', { kind: 'cohere' as never })).toThrow(
            /unknown kind "cohere"/,
        );
    });
});

describe('google', () => {
    it('builds a GenAI client on the Gemini backend', () => {
        vi.stubEnv('GEMINI_API_KEY', 'g-key');
        const client = conn(new ModelRegistry().client('google'));
        expect(client.apiKey).toBe('g-key');
        expect(client.vertexai).toBeFalsy();
    });

    it('returns the native adapter, not an OpenAI one', () => {
        vi.stubEnv('GEMINI_API_KEY', 'g-key');
        const model = new ModelRegistry().model('google:gemini-3-pro-preview');
        expect(model).toBeInstanceOf(GeminiModel);
        expect(model.id).toBe('gemini-3-pro-preview');
    });

    it('has one api, so naming one is a mistake worth reporting', () => {
        vi.stubEnv('GEMINI_API_KEY', 'g-key');
        expect(() => new ModelRegistry().model('google/responses:gemini-2.5-pro')).toThrow(
            /has one api, so "responses" means nothing here/,
        );
    });

    it('takes a name of its own, so two Google keys are two providers', () => {
        const models = new ModelRegistry()
            .provider('gemini-dev', { kind: 'google', apiKey: 'g-dev' })
            .provider('gemini-prod', { kind: 'google', apiKey: 'g-prod' });
        expect(models.model('gemini-dev:gemini-2.5-flash').id).toBe('gemini-2.5-flash');
        expect(conn(models.client('gemini-prod')).apiKey).toBe('g-prod');
        expect(conn(models.client('gemini-dev')).apiKey).toBe('g-dev');
    });
});

describe('vertex', () => {
    it('selects the Vertex backend and addresses it by project', () => {
        const client = conn(
            new ModelRegistry()
                .provider('vx', { kind: 'vertex', project: 'acme-prod' })
                .client('vx'),
        );
        expect(client.vertexai).toBe(true);
        expect(client.project).toBe('acme-prod');
        // No region named, so the multi-region endpoint.
        expect(client.location).toBe('global');
    });

    it('needs no api key, because the SDK resolves ambient credentials', () => {
        vi.stubEnv('VERTEX_API_KEY', '');
        const models = new ModelRegistry().provider('vx', { kind: 'vertex', project: 'p' });
        expect(conn(models.client('vx')).apiKey).toBeFalsy();
    });

    it('reads the project and location from the environment', () => {
        vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'from-env');
        vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'europe-west4');
        const client = conn(new ModelRegistry().client('vertex'));
        expect(client.project).toBe('from-env');
        expect(client.location).toBe('europe-west4');
    });

    it('falls back to the project id inside the service-account key file', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'zenera-adc-'));
        const keyFile = join(dir, 'key.json');
        await writeFile(
            keyFile,
            JSON.stringify({ type: 'service_account', project_id: 'from-key-file' }),
            'utf8',
        );
        vi.stubEnv('GOOGLE_CLOUD_PROJECT', '');
        vi.stubEnv('VERTEX_API_KEY', '');
        vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', keyFile);

        expect(conn(new ModelRegistry().client('vertex')).project).toBe('from-key-file');
    });

    it('says which knob is missing rather than failing at the first request', () => {
        vi.stubEnv('GOOGLE_CLOUD_PROJECT', '');
        vi.stubEnv('VERTEX_API_KEY', '');
        vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', '');
        expect(() => new ModelRegistry().client('vertex')).toThrow(
            'provider "vertex": vertex needs `project`, or GOOGLE_CLOUD_PROJECT',
        );
    });

    it('takes an express-mode key in place of a project', () => {
        vi.stubEnv('GOOGLE_CLOUD_PROJECT', '');
        vi.stubEnv('VERTEX_API_KEY', 'vx-express');
        expect(conn(new ModelRegistry().client('vertex')).apiKey).toBe('vx-express');
    });

    // The bug this pins: with both set, the SDK built a project-scoped url and
    // then authenticated it with the key header — which the service refuses,
    // and refuses with a 403 that mentions neither the project nor the key.
    // A key is an answer on its own, so nothing else is sent with it.
    it('sends no project alongside an express-mode key, whatever the environment says', () => {
        vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'acme-prod');
        vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'europe-west4');
        vi.stubEnv('VERTEX_API_KEY', 'vx-express');
        const client = conn(new ModelRegistry().client('vertex'));
        expect(client.vertexai).toBe(true);
        expect(client.apiKey).toBe('vx-express');
        expect(client.project).toBeFalsy();
        expect(client.location).toBeFalsy();
    });

    it('ignores a project stated in the config when a key is given too', () => {
        const client = conn(
            new ModelRegistry()
                .provider('vx', { kind: 'vertex', project: 'acme-prod', apiKey: 'vx-express' })
                .client('vx'),
        );
        expect(client.apiKey).toBe('vx-express');
        expect(client.project).toBeFalsy();
    });

    it('passes model ids through untouched — no publisher prefix to add', () => {
        const models = new ModelRegistry().provider('vx', { kind: 'vertex', project: 'p' });
        expect(models.model('vx:gemini-2.5-pro').id).toBe('gemini-2.5-pro');
        expect(models.model('vx:gemini-3-pro-preview')).toBeInstanceOf(GeminiModel);
    });
});

describe('vertex partner models', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    const vertex = (location?: string): ModelRegistry =>
        new ModelRegistry().provider('vx', {
            kind: 'vertex',
            project: 'acme',
            location,
            token: () => 'tok',
        });

    /** Every request the clients send, answered with `body`. */
    const capture = (body: object) => {
        const sent: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
        vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
            sent.push({
                url: String(input instanceof Request ? input.url : input),
                headers: new Headers(init?.headers),
                body: JSON.parse(String(init?.body)) as Record<string, unknown>,
            });
            return new Response(JSON.stringify(body), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        });
        return sent;
    };

    const ask = (): ModelRequest => ({
        messages: [{ role: 'user', content: [text('hi')] }],
        tools: [],
    });

    it('routes by id: Gemini, Claude, and publisher/model', () => {
        expect(vertexRoute('gemini-3.8-flash')).toBe('gemini');
        expect(vertexRoute('claude-sonnet-5')).toBe('anthropic');
        expect(vertexRoute('anthropic/claude-sonnet-5')).toBe('anthropic');
        expect(vertexRoute('xai/grok-4.6')).toBe('openai');
        const models = vertex();
        expect(models.model('vx:claude-sonnet-5')).toBeInstanceOf(AnthropicModel);
        expect(models.model('vx:anthropic/claude-sonnet-5').id).toBe('claude-sonnet-5');
        expect(models.model('vx:qwen/qwen3-maas')).toBeInstanceOf(OpenAIModel);
    });

    it('checks knobs and apis against the route, not the kind', () => {
        const models = vertex();
        expect(models.knobs({ provider: 'vx', model: 'claude-sonnet-5', maxTokens: 8 })).toEqual(
            [],
        );
        expect(models.knobs({ provider: 'vx', model: 'xai/grok-4.6', maxTokens: 8 })).toEqual([
            expect.objectContaining({ knob: 'maxTokens', target: 'openai/chat' }),
        ]);
        expect(() => models.model('vx/responses:xai/grok-4.6')).toThrow(
            'does not speak the "responses" api (supported: chat)',
        );
    });

    it("sends Claude to rawPredict, with the model in the path and Vertex's version in the body", async () => {
        const sent = capture({
            id: 'm',
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-5',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 3, output_tokens: 1 },
        });
        await vertex('us-east5').model('vx:claude-sonnet-5').generate(ask());
        expect(sent[0]!.url).toBe(
            'https://us-east5-aiplatform.googleapis.com/v1/projects/acme/locations/us-east5/publishers/anthropic/models/claude-sonnet-5:rawPredict',
        );
        expect(sent[0]!.body.anthropic_version).toBe('vertex-2023-10-16');
        expect(sent[0]!.body.model).toBeUndefined();
        expect(sent[0]!.headers.get('authorization')).toBe('Bearer tok');
        expect(sent[0]!.headers.get('x-api-key')).toBeNull();
    });

    it('sends every other publisher to the OpenAI-compatible endpoint, at global for a multi-region', async () => {
        const sent = capture({
            id: 'c',
            object: 'chat.completion',
            created: 0,
            model: 'xai/grok-4.6',
            choices: [
                { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } },
            ],
            usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        });
        await vertex('us').model('vx:xai/grok-4.6').generate(ask());
        expect(sent[0]!.url).toBe(
            'https://aiplatform.googleapis.com/v1/projects/acme/locations/global/endpoints/openapi/chat/completions',
        );
        expect(sent[0]!.body.model).toBe('xai/grok-4.6');
        expect(sent[0]!.headers.get('authorization')).toBe('Bearer tok');
    });

    it('says an express-mode key reaches Gemini only', () => {
        vi.stubEnv('GOOGLE_CLOUD_PROJECT', '');
        vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', '');
        const models = new ModelRegistry().provider('vx', { kind: 'vertex', apiKey: 'k' });
        expect(() => models.model('vx:claude-sonnet-5')).toThrow(
            'an express-mode key reaches Gemini only',
        );
    });
});

describe('vendor knobs', () => {
    const vertex = (): ModelRegistry =>
        new ModelRegistry().provider('vx', { kind: 'vertex', project: 'p' });

    // The bug this pins: `reasoningEffort` is type-legal on every model because
    // the option interfaces are unioned, and the Gemini adapter never reads it.
    // Silently dropped, the config claimed a setting that no request carried.
    it('refuses a knob the resolved adapter would never read', () => {
        expect(() =>
            vertex().model({
                provider: 'vx',
                model: 'gemini-3.5-flash-lite',
                reasoningEffort: 'high',
            }),
        ).toThrow(/does not read "reasoningEffort" — a gemini model takes: .*thinkingLevel/);
    });

    it('splits the two OpenAI apis, because only one of them reasons out loud', () => {
        vi.stubEnv('OPENAI_API_KEY', 'sk-test');
        const models = new ModelRegistry();
        expect(() => models.model({ model: 'o3', reasoningSummary: 'auto' })).toThrow(
            /does not read "reasoningSummary"/,
        );
        expect(
            models.model({ api: 'responses', model: 'o3', reasoningSummary: 'auto' }),
        ).toBeInstanceOf(OpenAIResponsesModel);
    });

    it('reports without building, so a model with no credential still answers', () => {
        vi.stubEnv('GOOGLE_CLOUD_PROJECT', '');
        vi.stubEnv('VERTEX_API_KEY', '');
        vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', '');
        expect(new ModelRegistry().knobs({ provider: 'vertex', model: 'g', store: true })).toEqual([
            {
                knob: 'store',
                target: 'gemini',
                supported: expect.arrayContaining(['thinkingLevel']),
            },
        ]);
    });

    it('says nothing about a knob the adapter does read', () => {
        expect(
            vertex().knobs({
                provider: 'vx',
                model: 'gemini-3-pro-preview',
                thinkingLevel: 'high',
            }),
        ).toEqual([]);
    });

    it('leaves connection fields alone — they are not tuning', () => {
        expect(
            vertex().knobs({ provider: 'vx', model: 'g', apiKey: 'k', baseURL: 'https://x' }),
        ).toEqual([]);
    });
});

describe('anthropic', () => {
    it('builds an Anthropic client, not an OpenAI one', () => {
        const models = new ModelRegistry().provider('claude', {
            kind: 'anthropic',
            apiKey: 'sk-ant-x',
        });
        const client = models.client('claude');
        expect(conn(client).apiKey).toBe('sk-ant-x');
        // The Anthropic SDK exposes `messages`; the OpenAI one does not.
        expect(client).toHaveProperty('messages');
        expect(client).not.toHaveProperty('chat');
    });

    it('works undeclared, off ANTHROPIC_API_KEY', () => {
        vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-env');
        expect(new ModelRegistry().model('anthropic:claude-sonnet-4-5').id).toBe(
            'claude-sonnet-4-5',
        );
    });

    it('has one api, so naming one is a mistake worth reporting', () => {
        vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-env');
        expect(() => new ModelRegistry().model('anthropic/chat:claude-sonnet-4-5')).toThrow(
            /has one api, so "chat" means nothing here/,
        );
    });

    it('names ANTHROPIC_API_KEY when there is no key', () => {
        vi.stubEnv('ANTHROPIC_API_KEY', '');
        expect(() => new ModelRegistry().client('anthropic')).toThrow(
            'provider "anthropic": no api key — set `apiKey`, or set ANTHROPIC_API_KEY',
        );
    });
});

describe('models', () => {
    it('uses the provider client, not one of its own', () => {
        const models = new ModelRegistry().provider('p', { apiKey: 'sk-one' });
        models.model('p:gpt-4o');
        // Nothing was built behind the registry's back: the memoized client is
        // still the one a later caller gets.
        expect(conn(models.client('p')).apiKey).toBe('sk-one');
    });

    it('lets inline credentials override without poisoning the shared client', () => {
        const models = new ModelRegistry().provider('p', { apiKey: 'sk-one' });
        expect(models.model({ provider: 'p', model: 'gpt-4o', apiKey: 'sk-other' }).id).toBe(
            'gpt-4o',
        );
        expect(conn(models.client('p')).apiKey).toBe('sk-one');
    });

    it('honours the default provider for a bare id', () => {
        const models = new ModelRegistry().provider('house', { apiKey: 'sk-house' });
        models.setDefault('house');
        expect(models.defaultProvider).toBe('house');
        expect(models.model('gpt-4o').id).toBe('gpt-4o');
        expect(conn(models.client('house')).apiKey).toBe('sk-house');
    });

    it('refuses a default that is not declared', () => {
        expect(() => new ModelRegistry().setDefault('nope')).toThrow(/is not declared/);
    });

    it('takes a pre-built client, which is the seam for exotic auth', () => {
        const stub = { chat: {} } as never;
        const models = new ModelRegistry().provider('vertex', { kind: 'google', client: stub });
        expect(models.client('vertex')).toBe(stub);
    });
});

// ---------------------------------------------------------------------------
// The Gemini wire
//
// Google's shape differs from OpenAI's in ways that are easy to get subtly
// wrong and expensive to discover live: there is no system role in the
// transcript, tool results come back as *user* turns, thinking arrives as
// ordinary text parts wearing a flag, and reasoning tokens are billed on top
// of the output count rather than inside it.
// ---------------------------------------------------------------------------

describe('gemini wire', () => {
    /** A client that records what it was asked and replies with what it is told. */
    function stubGenAI(...replies: Partial<GenerateContentResponse>[]) {
        const sent: GenerateContentParameters[] = [];
        const client = {
            models: {
                generateContent: async (params: GenerateContentParameters) => {
                    sent.push(params);
                    return (replies[sent.length - 1] ?? {}) as GenerateContentResponse;
                },
            },
        };
        return { client: client as unknown as GoogleGenAI, sent };
    }

    const said = (...parts: Part[]): Partial<GenerateContentResponse> => ({
        candidates: [{ content: { role: 'model', parts } }],
    });

    const turns = (sent: GenerateContentParameters) => sent.contents as Content[];

    const ask = (messages: Message[], rest: Partial<ModelRequest> = {}): ModelRequest => ({
        messages,
        tools: [],
        ...rest,
    });

    it('lifts the system prompt out of the transcript', async () => {
        const { client, sent } = stubGenAI();
        await new GeminiModel('gemini-2.5-flash', client).generate(
            ask([{ role: 'user', content: [text('hi')] }], { system: 'be brief' }),
        );
        expect(sent[0].config?.systemInstruction).toBe('be brief');
        expect(turns(sent[0])).toHaveLength(1);
    });

    it('keeps a mid-conversation system note where it was said', async () => {
        const { client, sent } = stubGenAI();
        await new GeminiModel('gemini-2.5-flash', client).generate(
            ask([
                { role: 'user', content: [text('hi')] },
                { role: 'assistant', content: 'hello' },
                { role: 'system', content: 'the user prefers metric' },
                { role: 'user', content: [text('how far?')] },
            ]),
        );
        // There is no system role on this wire, so the note becomes a user part
        // — and, being adjacent to a user turn, merges into it rather than
        // splitting the conversation in two.
        const [first, second, third] = turns(sent[0]);
        expect([first.role, second.role, third.role]).toEqual(['user', 'model', 'user']);
        expect(third.parts).toHaveLength(2);
        expect(third.parts?.[0].text).toBe('the user prefers metric');
    });

    it('sends tool results back as a user turn, addressed by name', async () => {
        const { client, sent } = stubGenAI();
        await new GeminiModel('gemini-2.5-flash', client).generate(
            ask([
                { role: 'user', content: [text('weather?')] },
                {
                    role: 'assistant',
                    content: '',
                    toolCalls: [{ id: 'c1', name: 'forecast', args: '{"city":"Oslo"}' }],
                },
                { role: 'tool', callId: 'c1', name: 'forecast', content: 'rain' },
            ]),
        );
        const [, model, result] = turns(sent[0]);
        expect(model.parts?.[0].functionCall).toMatchObject({
            name: 'forecast',
            args: { city: 'Oslo' },
        });
        expect(result.role).toBe('user');
        expect(result.parts?.[0].functionResponse).toMatchObject({
            name: 'forecast',
            response: { output: 'rain' },
        });
    });

    it('separates thinking from the answer', async () => {
        const { client } = stubGenAI(
            said({ text: 'the user means nautical miles', thought: true }, { text: '3 nm' }),
        );
        const res = await new GeminiModel('gemini-2.5-flash', client).generate(
            ask([{ role: 'user', content: [text('how far?')] }]),
        );
        expect(res.text).toBe('3 nm');
        expect(res.thinking).toBe('the user means nautical miles');
    });

    it('bills reasoning on top of the output count, and cache inside the input', async () => {
        const { client } = stubGenAI({
            ...said({ text: 'ok' }),
            usageMetadata: {
                promptTokenCount: 100,
                cachedContentTokenCount: 40,
                candidatesTokenCount: 10,
                thoughtsTokenCount: 5,
            },
        });
        const res = await new GeminiModel('gemini-2.5-flash', client).generate(
            ask([{ role: 'user', content: [text('hi')] }]),
        );
        // promptTokenCount already contains the cached tokens; thoughts are
        // charged as output but reported separately.
        expect(res.usage).toMatchObject({
            inputTokens: 100,
            cachedInputTokens: 40,
            outputTokens: 15,
            reasoningTokens: 5,
        });
    });

    it('reports a truncated answer as a length stop', async () => {
        const { client } = stubGenAI({
            candidates: [
                { content: { parts: [{ text: 'ok' }] }, finishReason: FinishReason.MAX_TOKENS },
            ],
        });
        const res = await new GeminiModel('gemini-2.5-flash', client).generate(
            ask([{ role: 'user', content: [text('hi')] }]),
        );
        expect(res.stopReason).toBe('length');
    });

    it('gives an unidentified call an id, and takes it off again on the way back', async () => {
        const { client, sent } = stubGenAI(
            said({ functionCall: { name: 'forecast', args: { city: 'Oslo' } } }),
        );
        const model = new GeminiModel('gemini-2.5-flash', client);
        const res = await model.generate(ask([{ role: 'user', content: [text('?')] }]));

        // The runner pairs results to calls by id, so one is minted.
        const [call] = res.toolCalls;
        expect(call.id).toMatch(/^gemini-call-/);

        await model.generate(
            ask([
                { role: 'user', content: [text('?')] },
                { role: 'assistant', content: '', toolCalls: [call] },
                { role: 'tool', callId: call.id, name: 'forecast', content: 'rain' },
            ]),
        );
        // It was ours, not theirs: sending it back would pair against nothing.
        const [, , result] = turns(sent[1]);
        expect(result.parts?.[0].functionResponse?.id).toBeUndefined();
    });

    it('returns the thought signature it was given with the call it belongs to', async () => {
        const { client, sent } = stubGenAI(
            said({
                functionCall: { id: 'c1', name: 'forecast', args: {} },
                thoughtSignature: 'sig-abc',
            }),
        );
        const model = new GeminiModel('gemini-3-pro-preview', client);
        const res = await model.generate(ask([{ role: 'user', content: [text('?')] }]));

        await model.generate(
            ask([
                { role: 'user', content: [text('?')] },
                { role: 'assistant', content: '', toolCalls: res.toolCalls },
                { role: 'tool', callId: 'c1', name: 'forecast', content: 'rain' },
            ]),
        );
        // Gemini 3 answers worse without it, and it means nothing to any other
        // vendor — so the adapter carries it rather than the trajectory.
        expect(turns(sent[1])[1].parts?.[0].thoughtSignature).toBe('sig-abc');
    });

    it('streams the same reading it would have made in one piece', async () => {
        const chunks: Partial<GenerateContentResponse>[] = [
            said({ text: 'weigh', thought: true }),
            said({ text: '3 ' }),
            said({ text: 'nm' }),
        ];
        const client = {
            models: {
                generateContentStream: async () =>
                    (async function* () {
                        yield* chunks as GenerateContentResponse[];
                    })(),
            },
        } as unknown as GoogleGenAI;

        const seen: StreamDelta[] = [];
        const res = await new GeminiModel('gemini-2.5-flash', client).stream(
            ask([{ role: 'user', content: [text('how far?')] }]),
            (d) => seen.push(d),
        );
        expect(res.text).toBe('3 nm');
        expect(res.thinking).toBe('weigh');
        expect(seen.map((d) => d.type)).toEqual(['thinking_delta', 'text_delta', 'text_delta']);
    });

    it('declares tools with plain JSON Schema and honours a forced choice', async () => {
        const { client, sent } = stubGenAI();
        await new GeminiModel('gemini-2.5-flash', client).generate(
            ask([{ role: 'user', content: [text('?')] }], {
                tools: [
                    {
                        name: 'forecast',
                        description: 'look up the weather',
                        parameters: { type: 'object', properties: { city: { type: 'string' } } },
                    },
                ],
                toolChoice: 'required',
            }),
        );
        expect(sent[0].config?.tools?.[0]).toMatchObject({
            functionDeclarations: [{ name: 'forecast', parametersJsonSchema: { type: 'object' } }],
        });
        expect(sent[0].config?.toolConfig?.functionCallingConfig?.mode).toBe(
            FunctionCallingConfigMode.ANY,
        );
    });
});

describe('openrouter wire', () => {
    /** The same recorder as above, against the gateway's own client. */
    function stubOpenRouter(...replies: Partial<ChatResult>[]) {
        const sent: ChatRequest[] = [];
        const client = {
            chat: {
                send: async ({ chatRequest }: { chatRequest: ChatRequest }) => {
                    sent.push(chatRequest);
                    return { choices: [], ...(replies[sent.length - 1] ?? {}) } as ChatResult;
                },
            },
        };
        return { client: client as unknown as OpenRouter, sent };
    }

    const said = (message: Partial<ChatAssistantMessage>): Partial<ChatResult> => ({
        choices: [{ index: 0, finishReason: 'stop', message }] as ChatResult['choices'],
    });

    const ask = (rest: Partial<ModelRequest> = {}): ModelRequest => ({
        messages: [{ role: 'user', content: [text('hi')] }],
        tools: [],
        ...rest,
    });

    it('renames the routing knobs to the fields the gateway reads', async () => {
        const { client, sent } = stubOpenRouter();
        await new OpenRouterModel('openai/gpt-5.4-nano', client, {
            routing: { order: ['azure'], requireParameters: true },
            fallbacks: ['anthropic/claude-sonnet-4.5'],
            serviceTier: 'priority',
            maxTokens: 2048,
        }).generate(ask());

        // `routing` and `fallbacks` are this runtime's names; on the wire they
        // are `provider` and `models`, and the output cap is spelled in full.
        expect(sent[0]).toMatchObject({
            provider: { order: ['azure'], requireParameters: true },
            models: ['anthropic/claude-sonnet-4.5'],
            serviceTier: 'priority',
            maxCompletionTokens: 2048,
        });
    });

    it('asks for reasoning only when a knob says to', async () => {
        const { client, sent } = stubOpenRouter({}, {});
        await new OpenRouterModel('openai/gpt-5.4-nano', client).generate(ask());
        await new OpenRouterModel('openai/gpt-5.4-nano', client, {
            reasoningEffort: 'low',
            reasoningSummary: 'concise',
        }).generate(ask());

        // Sending `reasoning: {}` would ask a model that reasons by default to
        // stop, so the field is absent rather than empty.
        expect(sent[0].reasoning).toBeUndefined();
        expect(sent[1].reasoning).toEqual({ effort: 'low', summary: 'concise' });
    });

    it('leaves tool choice unsaid when there are no tools', async () => {
        const { client, sent } = stubOpenRouter({}, {});
        const model = new OpenRouterModel('openai/gpt-5.4-nano', client);
        await model.generate(ask());
        await model.generate(
            ask({ tools: [{ name: 'forecast', parameters: { type: 'object' } }] }),
        );

        expect(sent[0].tools).toBeUndefined();
        expect(sent[0].toolChoice).toBeUndefined();
        expect(sent[1].toolChoice).toBe('auto');
    });

    it('reads an answer returned as content parts, not only as a string', async () => {
        const { client } = stubOpenRouter(
            said({
                content: [
                    { type: 'text', text: '3 ' },
                    { type: 'text', text: 'nm' },
                ] as ChatContentItems[],
                reasoning: 'weigh',
            }),
        );
        const res = await new OpenRouterModel('openai/gpt-5.4-nano', client).generate(ask());

        // Unlike chat completions, this field may be an array — reading it as a
        // string would silently produce an empty answer.
        expect(res.text).toBe('3 nm');
        expect(res.thinking).toBe('weigh');
    });

    it('counts cache and reasoning as the subsets they are', async () => {
        const { client } = stubOpenRouter({
            ...said({ content: 'ok' }),
            usage: {
                promptTokens: 100,
                completionTokens: 10,
                totalTokens: 110,
                promptTokensDetails: { cachedTokens: 40 },
                completionTokensDetails: { reasoningTokens: 5 },
            } as ChatUsage,
        });
        const res = await new OpenRouterModel('openai/gpt-5.4-nano', client).generate(ask());

        expect(res.usage).toMatchObject({
            inputTokens: 100,
            cachedInputTokens: 40,
            outputTokens: 10,
            reasoningTokens: 5,
        });
    });
});
