import { KeyStore, type KeyEntry, type Provider } from '@zenera/engine';
import { formatInline, formatMarkdown, plain, splitRef, TEMPLATES } from '@zenera/cli/lib';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    absorb,
    answerBox,
    chooseModel,
    defaultRef,
    footerCells,
    gatewayDefaultRef,
    listPrompts,
    masked,
    metaCompatible,
    misspelledProvider,
    promptPath,
    readPrompt,
    readSpan,
    resumeDelayMs,
    sameModel,
    sessionModel,
    shutdownModels,
    splitLines,
    startRelay,
    Tally,
    toneAt,
    transient,
    wire,
    wireApi,
    wireGateway,
    type Outcome,
    type Sink,
} from '../src/index.ts';

// ---------------------------------------------------------------------------
// The parts of the meta agent that are pure functions of their input, moved
// here with it from the CLI's own tests.
// ---------------------------------------------------------------------------

describe('the commands the editor brief offers', () => {
    // The `zen-*` skills are the model's; the tuning loop's one is nobody's to type.
    it("lists the shipped ones, and none of the model's own", async () => {
        const listed = await listPrompts(join(TEMPLATES, 'editor'));
        expect(listed).toContain('spec-edit');
        expect(listed.filter((n) => n.startsWith('zen-'))).toEqual([]);
    });
});

describe('the waiting border', () => {
    // A box 40 wide with 6 rows of narration: the ring is the two rules plus
    // the two sides, and it is one ring rather than four runs.
    const span = 2 * 40 + 2 * 6;
    const brightest = 6;

    it('lights the crest where the head is', () => {
        for (const head of [0, 5, 41, span - 1]) {
            expect(toneAt(head, head, span)).toBe(brightest);
        }
    });

    it('drags a tail behind the crest and leaves the rest at rest', () => {
        const head = 60;
        expect(toneAt(head - 2, head, span)).toBe(brightest - 1);
        expect(toneAt(head - 4, head, span)).toBe(brightest - 2);
        expect(toneAt(head - 40, head, span)).toBe(0);
        // Ahead of the crest is border the wave has not reached yet.
        expect(toneAt(head + 1, head, span)).toBe(0);
    });

    it('rounds the corners without a seam, because the ring has no end', () => {
        // A crest two cells past the start has its tail on the last cells of
        // the ring - the left side, which is drawn bottom to top.
        expect(toneAt(span - 1, 1, span)).toBe(brightest - 1);
        expect(toneAt(0, span, span)).toBe(brightest);
    });
});

describe('the waiting label', () => {
    const cells = (label: string, width = 40): string[] => footerCells(label, width);

    it('is a rule of exactly the width, label or no label', () => {
        expect(cells('')).toHaveLength(40);
        expect(cells('Working... 12s')).toHaveLength(40);
        expect(cells('Working... 1200s')).toHaveLength(40);
    });

    it('keeps the corners, so the box is still a box', () => {
        const drawn = cells('Working... 12s');
        expect(drawn[0]).toBe('\u2570');
        expect(drawn.at(-1)).toBe('\u256f');
    });

    it('sets the label near the left corner rather than centred', () => {
        expect(cells('Working... 12s').join('')).toContain('\u2570\u2500 Working... 12s ');
    });

    it('cuts a label too long for the rule instead of widening it', () => {
        const drawn = cells('x'.repeat(80));
        expect(drawn).toHaveLength(40);
        expect(drawn.join('')).toContain(`\u2500 ${'x'.repeat(34)} `);
    });

    it('is a plain rule when there is nothing to wait for', () => {
        expect(cells('').join('')).toBe(`\u2570${'\u2500'.repeat(38)}\u256f`);
    });
});

describe('the gateway fallback', () => {
    const kept = { ...process.env };
    let root: string;
    let server: Server;
    let answer: { status: number; body: unknown };
    let asked = 0;
    let seen: Record<string, string | string[] | undefined> = {};

    beforeEach(async () => {
        root = mkdtempSync(join(tmpdir(), 'zen-gw-catalog-'));
        process.env.ZENERA_HOME = root;
        asked = 0;
        server = createServer((req, res) => {
            asked++;
            seen = { path: req.url, ...req.headers };
            res.writeHead(answer.status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(answer.body));
        });
        await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
        // A fresh port per test is also a fresh listing: the process memo is keyed by url.
        process.env.BIFROST_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        process.env.BIFROST_API_KEY = 'sk-bf-1';
    });
    afterEach(async () => {
        process.env = { ...kept };
        await new Promise<void>((done) => server.close(() => done()));
        rmSync(root, { recursive: true, force: true });
    });

    // The meta agent's last resort: what the gateway serves, not a vendor recommendation it may not.
    it('falls back to the best chat model the gateway serves that can carry the tools', async () => {
        answer = {
            status: 200,
            body: {
                data: [
                    { id: 'openai/gpt-4o' },
                    { id: 'openai/gpt-6-sol' },
                    { id: 'gemini/gemini-4-argon' },
                    { id: 'anthropic/claude-haiku-5' },
                    { id: 'vertex/claude-sonnet-5' },
                    { id: 'openai/text-embedding-3-large' },
                ],
            },
        };
        expect(await gatewayDefaultRef()).toBe('vertex/claude-sonnet-5');
        expect(await gatewayDefaultRef('openai')).toBe('openai/gpt-6-sol');
        expect(await gatewayDefaultRef('anthropic')).toBe('anthropic/claude-haiku-5');
    });

    it('has no gateway fallback when nothing served can run the meta agent', async () => {
        answer = { status: 200, body: { data: [{ id: 'openai/gpt-4o' }] } };
        expect(await gatewayDefaultRef()).toBeUndefined();
    });
});

describe('which model the meta agent runs on', () => {
    it('takes the first answer in order', () => {
        expect(chooseModel({ flag: 'a', shell: 'b', stored: 'c' })).toEqual({
            ref: 'a',
            from: 'flag',
        });
        expect(chooseModel({ stored: 'c', project: 'd' })).toEqual({ ref: 'c', from: 'store' });
        expect(chooseModel({ project: 'd' })).toEqual({ ref: 'd', from: 'project' });
        expect(chooseModel({})).toBeUndefined();
    });

    // `.env` only fills gaps, so by the time the variable is read the two
    // sources are indistinguishable - unless the shell's value was kept from
    // before the file was folded in, which is the only reason it is.
    it('tells the shell apart from the project file', () => {
        expect(chooseModel({ shell: 'x', env: 'x' })).toEqual({ ref: 'x', from: 'shell' });
        expect(chooseModel({ env: 'y' })).toEqual({ ref: 'y', from: 'env' });
    });

    it('reads a provider prefix but not a publisher one', () => {
        expect(splitRef('vertex/gemini-2.5-pro')).toEqual({
            provider: 'vertex',
            id: 'gemini-2.5-pro',
        });
        expect(splitRef('gpt-5.4')).toEqual({ id: 'gpt-5.4' });
        // `google/` here is the publisher Vertex expects, not zen's provider.
        expect(splitRef('anthropic/claude-sonnet-4.5').provider).toBe('anthropic');
        expect(splitRef('meta-llama/llama-4').provider).toBeUndefined();
    });

    // The colon form is what arrives from `agents.yaml`, api selector and all.
    it('reads the library ref form too', () => {
        expect(splitRef('openai:gpt-5.6-sol')).toEqual({ provider: 'openai', id: 'gpt-5.6-sol' });
        expect(splitRef('openai/responses:gpt-5.6-sol')).toEqual({
            provider: 'openai',
            id: 'gpt-5.6-sol',
        });
        expect(splitRef('openrouter:anthropic/claude-opus-5')).toEqual({
            provider: 'openrouter',
            id: 'anthropic/claude-opus-5',
        });
        // A colon inside an id is not a prefix: this one is an OpenRouter variant.
        expect(splitRef('inclusionai/ling-3.0-flash-fin:free')).toEqual({
            id: 'inclusionai/ling-3.0-flash-fin:free',
        });
    });

    // The prefix that is nearly right is the dangerous one: it parses as a bare
    // id and gets sent, whole, to whichever provider the default picks.
    it('catches a misspelt provider without accusing a publisher', () => {
        expect(misspelledProvider('vertes/gemini-3.5-flash')).toBe('vertex');
        expect(misspelledProvider('opeani/gpt-5.6-sol')).toBe('openai');
        expect(misspelledProvider('antropic/claude-opus-5')).toBe('anthropic');
        expect(misspelledProvider('vertex/gemini-3.8-flash')).toBeUndefined();
        expect(misspelledProvider('gpt-5.6-sol')).toBeUndefined();
        // Real OpenRouter ids, which are shaped the same way.
        expect(misspelledProvider('meta-llama/llama-4')).toBeUndefined();
        expect(misspelledProvider('inclusionai/ling-3.0-flash-fin:free')).toBeUndefined();
        expect(misspelledProvider('x-ai/grok-5')).toBeUndefined();
        expect(misspelledProvider('deepseek/deepseek-v4')).toBeUndefined();
        expect(misspelledProvider('qwen/qwen4-max')).toBeUndefined();
        expect(misspelledProvider('mistralai/mistral-large')).toBeUndefined();
    });

    // A machine with a key and nothing else should still run, so the last
    // resort is a recommendation rather than an error.
    it('falls back to what a held key recommends, and loses to anything set', () => {
        expect(chooseModel({ fallback: 'vertex/gemini-3.8-flash' })).toEqual({
            ref: 'vertex/gemini-3.8-flash',
            from: 'default',
        });
        expect(chooseModel({ project: 'd', fallback: 'vertex/gemini-3.8-flash' })?.from).toBe(
            'project',
        );
    });

    it('recommends for the first provider holding a key, or for the one named', () => {
        const held = (...list: Provider[]): KeyStore =>
            ({
                active: (p: Provider) => (list.includes(p) ? {} : undefined),
            }) as unknown as KeyStore;

        expect(defaultRef(held('openai', 'vertex'))).toBe('openai/gpt-5.6-sol');
        expect(defaultRef(held('vertex'))).toBe('vertex/gemini-3.8-flash');
        expect(defaultRef(held('openai', 'vertex'), 'vertex')).toBe('vertex/gemini-3.8-flash');
        expect(defaultRef(held('openai'), 'vertex')).toBeUndefined();
        expect(defaultRef(held())).toBeUndefined();
        expect(defaultRef(held(), undefined, true)).toBe('anthropic/claude-opus-5');
        expect(defaultRef(held(), 'vertex', true)).toBe('vertex/gemini-3.8-flash');
    });
});

describe('wiring a zen key into copilot', () => {
    const store = {
        reveal: () => 'sk-secret-value',
        fileOf: () => '/keys/vertex.json',
        projectOf: () => ({ id: 'acme-ai', from: 'stored' as const }),
    } as unknown as KeyStore;

    const entry = (over: Partial<KeyEntry>): KeyEntry =>
        ({
            provider: 'openai',
            name: 'default',
            holds: 'secret',
            value: 'k',
            addedAt: '2026-01-01T00:00:00.000Z',
            ...over,
        }) as KeyEntry;

    // Nothing else turns BYOK on, so a provider whose url copilot already
    // knows still needs one, or the run quietly goes to a GitHub account.
    it('always sets a base url, because that is what activates BYOK', () => {
        for (const provider of ['openai', 'anthropic', 'google', 'openrouter'] as const) {
            const out = wire(store, entry({ provider }), 'some-model');
            expect(out.env.COPILOT_PROVIDER_BASE_URL).toMatch(/^https:\/\//);
        }
    });

    it('builds the vertex endpoint from the project and location on the key', () => {
        const out = wire(
            store,
            entry({ provider: 'vertex', holds: 'file', location: 'europe-west4' }),
            'gemini-2.5-pro',
        );
        expect(out.env.COPILOT_PROVIDER_BASE_URL).toBe(
            'https://aiplatform.googleapis.com/v1/projects/acme-ai/locations/europe-west4/endpoints/openapi',
        );
        // Vertex speaks publisher names; the bare id stays as the catalogue key.
        expect(out.env.COPILOT_PROVIDER_WIRE_MODEL).toBe('google/gemini-2.5-pro');
        expect(out.env.COPILOT_PROVIDER_MODEL_ID).toBe('gemini-2.5-pro');
        expect(out.warnings).toEqual([]);
    });

    // Vertex's completions endpoint takes `function` tools only, and a bare
    // `gpt-oss-…` id gets copilot's GPT tool set with a custom `apply_patch`.
    it('keeps a partner publisher on the model id so copilot falls back to function tools', () => {
        const out = wire(
            store,
            entry({ provider: 'vertex', holds: 'file', location: 'us' }),
            'openai/gpt-oss-120b-maas',
        );
        expect(out.env.COPILOT_PROVIDER_BASE_URL).toContain('/locations/global/');
        expect(out.env.COPILOT_PROVIDER_WIRE_MODEL).toBe('openai/gpt-oss-120b-maas');
        expect(out.env.COPILOT_PROVIDER_MODEL_ID).toBe('openai/gpt-oss-120b-maas');
        expect(
            wire(store, entry({ provider: 'vertex', holds: 'file' }), 'google/gemini-2.5-pro').env
                .COPILOT_PROVIDER_MODEL_ID,
        ).toBe('gemini-2.5-pro');
    });

    it('says so when the location will be the slow one', () => {
        const out = wire(store, entry({ provider: 'vertex', holds: 'file' }), 'gemini-2.5-pro');
        expect(out.env.COPILOT_PROVIDER_BASE_URL).toContain('/locations/global/');
        expect(out.warnings.join(' ')).toMatch(/cold start/);
    });

    // An access token lives an hour and a session does not, so the file form
    // hands over a command rather than a credential.
    it('mints a token per request for a file-shaped key, and holds no secret', () => {
        const out = wire(store, entry({ provider: 'vertex', holds: 'file' }), 'gemini-2.5-pro');
        expect(out.env.COPILOT_PROVIDER_API_KEY_COMMAND).toMatch(/key token vertex$/);
        expect(out.env.COPILOT_PROVIDER_API_KEY).toBeUndefined();
        expect(out.env.GOOGLE_APPLICATION_CREDENTIALS).toBe('/keys/vertex.json');
        expect(out.secret).toEqual([]);
    });

    // Copilot offers its tools as OpenAI custom tools, which only the responses
    // API accepts - a completions model refuses the very first call.
    it('picks the wire api the model can actually serve', () => {
        expect(wireApi('openai', 'gpt-5-mini')).toBe('responses');
        expect(wireApi('openai', 'o4-mini')).toBe('responses');
        expect(wireApi('openai', 'gpt-6-sol')).toBe('responses');
        expect(wireApi('openai', 'gpt-4o')).toBeUndefined();
        expect(wireApi('anthropic', 'claude-sonnet-4.5')).toBeUndefined();
    });

    it('knows which models cannot carry its tools', () => {
        expect(metaCompatible('openai', 'gpt-5-mini')).toBe(true);
        expect(metaCompatible('openai', 'gpt-4o')).toBe(false);
        expect(metaCompatible('openai', 'chatgpt-4o-latest')).toBe(false);
        expect(metaCompatible('anthropic', 'claude-opus-5')).toBe(true);
        expect(metaCompatible('vertex', 'gemini-3.8-flash')).toBe(true);
    });

    it('never lets a secret into something printable', () => {
        const out = wire(store, entry({ provider: 'openai' }), 'gpt-5.4');
        expect(out.secret).toEqual(['COPILOT_PROVIDER_API_KEY']);
        const shown = masked(out.env, out.secret).join('\n');
        expect(shown).not.toContain('sk-secret-value');
        expect(shown).toContain('COPILOT_PROVIDER_API_KEY=');
    });

    // The openapi endpoint answers a Claude id with a bare 404.
    it('sends Claude on vertex through the relay as an anthropic provider', () => {
        const out = wire(
            store,
            entry({ provider: 'vertex', holds: 'file', location: 'us' }),
            'anthropic/claude-sonnet-5-5',
        );
        expect(out.env.COPILOT_PROVIDER_TYPE).toBe('anthropic');
        expect(out.env.COPILOT_MODEL).toBe('claude-sonnet-5-5');
        expect(out.env.COPILOT_PROVIDER_WIRE_MODEL).toBeUndefined();
        expect(out.env.COPILOT_PROVIDER_API_KEY_COMMAND).toBeUndefined();
        expect(out.relay).toMatchObject({
            project: 'acme-ai',
            location: 'us',
            keyFile: '/keys/vertex.json',
            key: out.env.COPILOT_PROVIDER_API_KEY,
        });
        expect(out.secret).toEqual(['COPILOT_PROVIDER_API_KEY']);
    });

    it('refuses Claude on vertex with an express-mode key', () => {
        expect(() =>
            wire(store, entry({ provider: 'vertex', holds: 'secret' }), 'claude-sonnet-5-5'),
        ).toThrow(/service account/);
    });

    describe('through a gateway', () => {
        const at = { baseURL: 'http://bifrost:8080', apiKey: 'sk-bf-secret' };

        it('sends OpenAI models to the openai drop-in, qualified, on the responses api', () => {
            const out = wireGateway(at, 'openai', 'gpt-6-sol');
            expect(out.env).toMatchObject({
                COPILOT_PROVIDER_TYPE: 'openai',
                COPILOT_PROVIDER_BASE_URL: 'http://bifrost:8080/openai/v1',
                COPILOT_PROVIDER_MODEL_ID: 'gpt-6-sol',
                COPILOT_PROVIDER_WIRE_MODEL: 'openai/gpt-6-sol',
                COPILOT_PROVIDER_WIRE_API: 'responses',
            });
            expect(masked(out.env, out.secret).join('\n')).not.toContain('sk-bf-secret');
        });

        it('sends Claude to the anthropic drop-in, wherever it is hosted', () => {
            for (const [provider, id] of [
                ['anthropic', 'claude-opus-5'],
                ['vertex', 'anthropic/claude-opus-5'],
            ] as const) {
                const out = wireGateway(at, provider, id);
                expect(out.env.COPILOT_PROVIDER_TYPE).toBe('anthropic');
                expect(out.env.COPILOT_PROVIDER_BASE_URL).toBe('http://bifrost:8080/anthropic');
                expect(out.env.COPILOT_PROVIDER_MODEL_ID).toBe('claude-opus-5');
                expect(out.env.COPILOT_PROVIDER_WIRE_MODEL).toBe(`${provider}/claude-opus-5`);
                expect(out.relay).toBeUndefined();
            }
        });

        it('names the upstream for everything else, and holds no key it was not given', () => {
            const out = wireGateway(
                { baseURL: 'http://bifrost:8080' },
                'google',
                'gemini-3.8-flash',
            );
            expect(out.env.COPILOT_PROVIDER_WIRE_MODEL).toBe('gemini/gemini-3.8-flash');
            expect(out.env.COPILOT_PROVIDER_API_KEY).toBeUndefined();
            expect(out.secret).toEqual([]);
        });
    });
});

describe('the vertex Claude relay', () => {
    const seen: { url: string; auth?: string; apiKey?: string; body: Record<string, unknown> }[] =
        [];
    let upstream: Server;
    let base = '';

    beforeEach(async () => {
        seen.length = 0;
        upstream = createServer((req, res) => {
            let text = '';
            req.on('data', (c: Buffer) => (text += c.toString()));
            req.on('end', () => {
                seen.push({
                    url: req.url ?? '',
                    auth: req.headers.authorization,
                    apiKey: req.headers['x-api-key'] as string | undefined,
                    body: JSON.parse(text) as Record<string, unknown>,
                });
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end('{"ok":true}');
            });
        });
        await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
        base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1/projects/p/locations/global`;
    });
    afterEach(() => {
        upstream.closeAllConnections();
        upstream.close();
    });

    const post = (url: string, key: string, body: object): Promise<Response> =>
        fetch(`${url}/v1/messages`, {
            method: 'POST',
            headers: { 'x-api-key': key, 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });

    it('moves the model into the path and adds the vertex version', async () => {
        const relay = await startRelay({ key: 'k', base, token: async () => 'tok' });
        try {
            const res = await post(relay.url, 'k', { model: 'claude-x', max_tokens: 5 });
            expect(res.status).toBe(200);
            expect(await res.json()).toEqual({ ok: true });
            await post(relay.url, 'k', { model: 'claude-x', stream: true });
        } finally {
            await relay.close();
        }
        expect(seen.map((s) => s.url)).toEqual([
            '/v1/projects/p/locations/global/publishers/anthropic/models/claude-x:rawPredict',
            '/v1/projects/p/locations/global/publishers/anthropic/models/claude-x:streamRawPredict',
        ]);
        expect(seen[0]).toMatchObject({
            auth: 'Bearer tok',
            apiKey: undefined,
            body: { max_tokens: 5, anthropic_version: 'vertex-2023-10-16' },
        });
        expect(seen[0].body.model).toBeUndefined();
    });

    // Loopback is open to every process on the machine, and the relay mints GCP tokens.
    it('refuses anyone without the session key', async () => {
        const relay = await startRelay({ key: 'k', base, token: async () => 'tok' });
        try {
            expect((await post(relay.url, 'nope', { model: 'claude-x' })).status).toBe(401);
        } finally {
            await relay.close();
        }
        expect(seen).toEqual([]);
    });
});

describe('a stored command', () => {
    it('accepts the four ways one gets named', () => {
        expect(promptPath('/p', '/review')).toBe('/p/.github/skills/review/SKILL.md');
        expect(promptPath('/p', 'review')).toBe('/p/.github/skills/review/SKILL.md');
        expect(promptPath('/p', 'notes.md')).toBe('/p/notes.md');
        expect(promptPath('/p', 'agents/prompts/x.md')).toBe('/p/agents/prompts/x.md');
    });

    // A project's own prompt file still runs, unless a skill has taken its name.
    it('falls back to a legacy prompt file', () => {
        const dir = mkdtempSync(join(tmpdir(), 'zen-prompt-'));
        try {
            mkdirSync(join(dir, '.github', 'prompts'), { recursive: true });
            writeFileSync(join(dir, '.github', 'prompts', 'mine.prompt.md'), 'x\n');
            expect(promptPath(dir, '/mine')).toBe(`${dir}/.github/prompts/mine.prompt.md`);

            mkdirSync(join(dir, '.github', 'skills', 'mine'), { recursive: true });
            writeFileSync(join(dir, '.github', 'skills', 'mine', 'SKILL.md'), 'y\n');
            expect(promptPath(dir, '/mine')).toBe(`${dir}/.github/skills/mine/SKILL.md`);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('reads user-invocable: false as the model’s, not a command', () => {
        const hidden = readPrompt(
            '/p/s/SKILL.md',
            's',
            '---\nname: s\nuser-invocable: false\n---\nx\n',
        );
        expect(hidden.invocable).toBe(false);
        expect(readPrompt('/p/s/SKILL.md', 's', 'x\n').invocable).toBe(true);
    });

    // Frontmatter is the editor's business; copilot is handed the body alone.
    it('sends the body and keeps the description for the narration', () => {
        const found = readPrompt(
            '/p/x.prompt.md',
            'x',
            '---\nmode: agent\ndescription: Review it.\n---\n\nDo the thing.\n',
        );
        expect(found.body).toBe('Do the thing.');
        expect(found.description).toBe('Review it.');
    });

    it('leaves a file without frontmatter alone', () => {
        const found = readPrompt('/p/x.prompt.md', 'x', 'Just this.\n');
        expect(found.body).toBe('Just this.');
        expect(found.description).toBeUndefined();
    });
});

// The spans below are trimmed from a real `COPILOT_OTEL_FILE_EXPORTER_PATH` file.
describe('counting the meta agent’s tokens', () => {
    const chat = (attrs: Record<string, unknown>) =>
        JSON.stringify({
            type: 'span',
            traceId: 't1',
            spanId: 's1',
            parentSpanId: 'p1',
            name: 'chat google/gemini-3.8-flash',
            startTime: [1790939995, 154000000],
            endTime: [1790939998, 922000000],
            attributes: {
                'gen_ai.operation.name': 'chat',
                'gen_ai.request.model': 'google/gemini-3.8-flash',
                'gen_ai.response.model': 'google/gemini-3.8-flash',
                'gen_ai.conversation.id': 'sess-1',
                'gen_ai.usage.input_tokens': 43828,
                'gen_ai.usage.output_tokens': 49,
                ...attrs,
            },
        });

    it('reads a chat span, folding reasoning into output as zen counts it', () => {
        const span = readSpan(
            chat({
                'gen_ai.usage.reasoning.output_tokens': 415,
                'gen_ai.usage.cache_read.input_tokens': 40000,
            }),
        );
        expect(span).toMatchObject({
            model: 'google/gemini-3.8-flash',
            session: 'sess-1',
            durationMs: 3768,
            usage: {
                inputTokens: 43828,
                cachedInputTokens: 40000,
                outputTokens: 464,
                reasoningTokens: 415,
            },
        });
    });

    it('ignores tools, metrics, agent spans and broken lines', () => {
        expect(readSpan(chat({ 'gen_ai.operation.name': 'execute_tool' }))).toBeUndefined();
        expect(readSpan(JSON.stringify({ type: 'metric', name: 'x' }))).toBeUndefined();
        expect(
            readSpan(
                JSON.stringify({
                    type: 'span',
                    attributes: {
                        'gen_ai.operation.name': 'invoke_agent',
                        'gen_ai.agent.name': 'explore',
                    },
                }),
            ),
        ).toBeUndefined();
        expect(readSpan('{"type":"span",')).toBeUndefined();
    });

    it('carries a line that has not finished arriving', () => {
        const first = splitLines('', '{"a":1}\n{"b":');
        expect(first).toEqual({ lines: ['{"a":1}'], carry: '{"b":' });
        expect(splitLines(first.carry, '2}\n')).toEqual({ lines: ['{"b":2}'], carry: '' });
    });

    it('sums calls into one line', () => {
        const tally = new Tally();
        const call = readSpan(chat({ 'gen_ai.usage.cache_read.input_tokens': 1_500_000 }));
        if (call) {
            tally.add({ ...call, usage: { ...call.usage, inputTokens: 1_800_000 } });
            tally.add(call);
        }
        expect(tally.toString()).toBe('2 calls · 1.84M in (3.00M cached) · 98 out');
    });

    it("takes copilot's own totals from the last shutdown, reasoning folded in", () => {
        const shutdown = (input: number) =>
            JSON.stringify({
                type: 'session.shutdown',
                data: {
                    modelMetrics: {
                        'google/gemini-3.8-flash': {
                            requests: { count: 2 },
                            usage: {
                                inputTokens: input,
                                outputTokens: 3,
                                cacheReadTokens: 39364,
                                cacheWriteTokens: 0,
                                reasoningTokens: 27,
                            },
                        },
                    },
                },
            });
        const events = [shutdown(43824), '{"type":"user.message"}', shutdown(87695)].join('\n');
        expect(shutdownModels(events)).toEqual([
            {
                model: 'google/gemini-3.8-flash',
                calls: 2,
                usage: {
                    inputTokens: 87695,
                    cachedInputTokens: 39364,
                    outputTokens: 30,
                    reasoningTokens: 27,
                },
            },
        ]);
        expect(shutdownModels('{"type":"user.message"}')).toBeUndefined();
    });

    it('knows the model a session was written by, so a resume on another starts afresh', () => {
        const home = mkdtempSync(join(tmpdir(), 'zen-copilot-'));
        const kept = process.env.COPILOT_HOME;
        process.env.COPILOT_HOME = home;
        try {
            const write = (id: string, ...events: object[]) => {
                mkdirSync(join(home, 'session-state', id), { recursive: true });
                writeFileSync(
                    join(home, 'session-state', id, 'events.jsonl'),
                    events.map((e) => JSON.stringify(e)).join('\n'),
                );
            };
            write(
                'answered',
                { type: 'session.start', data: { selectedModel: 'gemini-3.8-flash' } },
                { type: 'assistant.message', data: { model: 'google/gemini-3.8-flash' } },
                // A resume on another model that failed before answering.
                { type: 'session.start', data: { selectedModel: 'claude-sonnet-5-5' } },
            );
            write('silent', { type: 'session.start', data: { selectedModel: 'gpt-5' } });
            expect(sessionModel('answered')).toBe('google/gemini-3.8-flash');
            expect(sessionModel('silent')).toBe('gpt-5');
            expect(sessionModel('missing')).toBeUndefined();
            expect(sameModel('google/gemini-3.8-flash', 'gemini-3.8-flash')).toBe(true);
            expect(sameModel('gemini-3.8-flash', 'claude-sonnet-5-5')).toBe(false);
        } finally {
            if (kept === undefined) {
                delete process.env.COPILOT_HOME;
            } else {
                process.env.COPILOT_HOME = kept;
            }
            rmSync(home, { recursive: true, force: true });
        }
    });
});

describe('re-rendering copilot output', () => {
    const run = (
        events: object[],
    ): { out: Outcome; said: string[]; kept: string[]; shown: string[] } => {
        const said: string[] = [];
        const kept: string[] = [];
        const shown: string[] = [];
        const sink: Sink = {
            answer: (t) => shown.push(t),
            narrate: (l) => said.push(l),
            detail: (l) => kept.push(l),
            warn: (l) => said.push(l),
        };
        const out: Outcome = { answer: '', exitCode: 0, events: [] };
        for (const event of events) {
            absorb(event as never, out, sink, 80);
        }
        return { out, said, kept, shown };
    };

    // `assistant.message` carries both the running commentary and the last
    // word. What separates them is whether it asked for a tool.
    it('keeps the message that asked for no tool as the answer', () => {
        const { out, said, kept } = run([
            { type: 'assistant.message', data: { content: 'Looking.', toolRequests: [{ a: 1 }] } },
            {
                type: 'tool.execution_start',
                data: { toolName: 'bash', arguments: { command: 'ls' } },
            },
            { type: 'assistant.message', data: { content: 'Three files.', toolRequests: [] } },
            { type: 'result', exitCode: 0, sessionId: 's1' },
        ]);
        expect(out.answer).toBe('Three files.');
        expect(out.sessionId).toBe('s1');
        expect(said.join('\n')).toContain('Looking.');
        // A step is for the log, not the screen, where it is a wall of `$`.
        expect(kept.join('\n')).toContain('ls');
        expect(said.join('\n')).not.toContain('ls');
        // The answer is never narrated; it is the thing stdout is for.
        expect(said.join('\n')).not.toContain('Three files.');
    });

    it('takes the exit code from the result event', () => {
        const { out } = run([
            { type: 'session.error', data: { message: 'no' } },
            { type: 'result', exitCode: 1 },
        ]);
        expect(out.exitCode).toBe(1);
    });

    it('ignores an event it does not know rather than inventing a line', () => {
        const { out, said } = run([{ type: 'session.something_new', data: { x: 1 } }]);
        expect(said).toEqual([]);
        expect(out.events).toHaveLength(1);
    });

    // Copilot's own retries are fixed; zen resumes the session only when
    // waiting could change the answer.
    describe('which failures are worth resuming', () => {
        const failed = (data: object, sessionId: string | null = 's1') =>
            transient(
                run([
                    { type: 'session.error', data },
                    { type: 'result', exitCode: 1, sessionId: sessionId ?? undefined },
                ]).out,
            );

        it('resumes a rate limit, a provider outage and a timeout', () => {
            expect(
                failed({
                    errorType: 'rate_limit',
                    message: 'Failed to get response from the AI model; retried 5 times',
                    statusCode: 429,
                }),
            ).toContain('429');
            expect(failed({ errorType: 'query', message: '503', statusCode: 503 })).toContain(
                '503',
            );
            expect(
                failed({ errorType: 'query', message: 'Connection timed out to provider at x' }),
            ).toBeDefined();
        });

        it('does not resume what fails the same way every time', () => {
            expect(
                failed({ errorType: 'query', message: '400 Bad Request', statusCode: 400 }),
            ).toBeUndefined();
            expect(failed({ errorType: 'authentication', statusCode: 403 })).toBeUndefined();
        });

        // The sequence recorded when a background `zen run batch` finished under
        // Gemini 3: copilot's own read_bash carries no thought signature.
        it('resumes a 400 on a tool call copilot injected, not one the model made', () => {
            const error = {
                type: 'session.error',
                data: { errorType: 'query', message: '400 Bad Request', statusCode: 400 },
            };
            const tail = [
                { type: 'assistant.turn_end', data: {} },
                error,
                { type: 'result', exitCode: 1, sessionId: 's1' },
            ];
            const modelCall = {
                type: 'assistant.message',
                data: { model: 'google/gemini-3.8-flash', toolRequests: [{ name: 'bash' }] },
            };
            const injectedCall = {
                type: 'assistant.message',
                data: { content: '', toolRequests: [{ name: 'read_bash' }] },
            };
            const notified = { type: 'system.notification', data: { content: 'done' } };

            expect(transient(run([modelCall, notified, injectedCall, ...tail]).out)).toContain(
                '400',
            );
            expect(transient(run([modelCall, ...tail]).out)).toBeUndefined();
            // A resume that fails again sees only its own turn, so it is not retried twice.
            const user = { type: 'user.message', data: { content: 'Continue' } };
            expect(transient(run([notified, user, ...tail]).out)).toBeUndefined();
        });

        it('cannot resume without a session, nor a run that succeeded', () => {
            expect(failed({ errorType: 'rate_limit', statusCode: 429 }, null)).toBeUndefined();
            const ok = run([{ type: 'result', exitCode: 0, sessionId: 's1' }]).out;
            expect(transient(ok)).toBeUndefined();
        });

        it('waits longer each time, up to a ceiling', () => {
            expect(resumeDelayMs(0)).toBe(30_000);
            expect(resumeDelayMs(1)).toBe(60_000);
            expect(resumeDelayMs(10)).toBe(300_000);
        });
    });

    it('processes progress commentary lines as inline markdown', () => {
        const { said } = run([
            {
                type: 'assistant.message',
                data: {
                    content: 'I am running `snapshot.sh status` and checking **status**.',
                    toolRequests: [{ a: 1 }],
                },
            },
        ]);
        expect(said).toHaveLength(1);
        const line = said[0]!;
        expect(line).not.toContain('`snapshot.sh status`');
        expect(line).toContain('snapshot.sh status');
        expect(plain(line)).toBe('I am running snapshot.sh status and checking status.');
    });
});

describe('formatting the answer box', () => {
    let originalIsTTY: boolean | undefined;

    beforeEach(() => {
        originalIsTTY = process.stdout.isTTY;
        process.stdout.isTTY = true;
    });

    afterEach(() => {
        if (originalIsTTY !== undefined) {
            process.stdout.isTTY = originalIsTTY;
        } else {
            delete (process.stdout as { isTTY?: boolean }).isTTY;
        }
    });

    it('returns raw lines when not on a TTY', () => {
        process.stdout.isTTY = false;
        const text = 'line 1\nline 2';
        expect(answerBox(text)).toEqual(['line 1', 'line 2']);
    });

    it('wraps and styles markdown paragraphs with bold, italic, code, and links', () => {
        const text = 'Here is **bold**, *italic*, `code`, and [link](https://example.com).';
        const lines = answerBox(text, 60);
        expect(lines[0]).toBe('');
        // Top and bottom rules have box-drawing characters
        expect(plain(lines[1]!)).toMatch(/^╭─+╮$/);
        expect(plain(lines[lines.length - 2]!)).toMatch(/^╰─+╯$/);
        // Interior lines contain styled text within borders
        const body = lines.slice(2, -2).join('\n');
        expect(body).toContain('bold');
        expect(body).toContain('italic');
        expect(body).toContain('code');
        expect(body).toContain('link');
    });

    it('formats headings with bold weight', () => {
        const text = '## Section Title\n\nSome body text.';
        const lines = answerBox(text, 60);
        const body = lines.slice(2, -2).join('\n');
        expect(body).toContain('Section Title');
    });

    it('formats list items with hanging indentation', () => {
        const text = '- first point with enough text to wrap onto another line\n- second point';
        const lines = answerBox(text, 40);
        const body = lines.slice(2, -2).join('\n');
        expect(body).toContain('•');
        expect(body).toContain('first point');
    });

    it('formats quotes with a left bar', () => {
        const text = '> Important notice quoted here';
        const lines = answerBox(text, 50);
        const body = lines.slice(2, -2).join('\n');
        expect(body).toContain('│');
        expect(body).toContain('Important notice');
    });

    it('formats fenced code blocks within inner chrome', () => {
        const text = '```ts\nconst x = 42;\n```';
        const lines = answerBox(text, 50);
        const body = lines.slice(2, -2).join('\n');
        expect(body).toContain('┌─ ts');
        expect(body).toContain('const x = 42;');
        expect(body).toContain('└─');
    });

    it('formats tables with headers and aligned columns', () => {
        const text = '| Name | Status |\n| - | - |\n| web | ok |';
        const lines = answerBox(text, 50);
        const body = lines.slice(2, -2).join('\n');
        expect(body).toContain('Name');
        expect(body).toContain('Status');
        expect(body).toContain('web');
        expect(body).toContain('ok');
    });

    it('ensures every row of the box matches the same outer width', () => {
        const text =
            '# Heading\n\nA paragraph with **bold** and `code`.\n\n- item 1\n- item 2\n\n```sh\necho hi\n```';
        const lines = answerBox(text, 50);
        const outer = plain(lines[1]!).length;
        expect(outer).toBeGreaterThan(20);
        for (const line of lines.slice(1, -1)) {
            // plain visible length of every border row must be identical
            expect(plain(line).length).toBe(outer);
        }
    });

    it('formats markdown directly via formatMarkdown', () => {
        const text = 'A paragraph with **bold** and `code`.';
        const lines = formatMarkdown(text, 50);
        expect(lines).toHaveLength(1);
        expect(plain(lines[0]!)).toBe('A paragraph with bold and code.');
        expect(lines[0]!).toContain('\u001b[1mbold\u001b[22m');
        expect(lines[0]!).toContain('\u001b[32mcode\u001b[39m');
    });

    it('formats inline markdown via formatInline', () => {
        const text = 'Running `zen check` on **acme** with [link](https://acme.dev).';
        const formatted = formatInline(text);
        expect(formatted).not.toContain('`zen check`');
        expect(formatted).not.toContain('**acme**');
        expect(plain(formatted)).toBe('Running zen check on acme with link.');
    });
});
