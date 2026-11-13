// ---------------------------------------------------------------------------
// The catalog
//
// What each provider will actually serve this machine, asked of the provider
// itself and remembered on disk.
//
// Note what is *not* here: any judgement about which model is good. The lists
// below are ordered by how likely a call is to succeed and how little it costs
// to find out, not by quality — a recovery path, not a recommender. The one
// judgement the CLI does make lives in `rank.ts`, read off the ids a listing
// returns, so that no table here has to be argued about every quarter.
//
// Nor is there a single hard-coded table of every model. Vendors ship models
// faster than a release cycle, so the shipped table is a *fallback* and the
// answer is whatever the vendor said this morning. Every row carries its own
// `source` for exactly that reason: a curated guess must never be mistaken for
// the vendor's own word.
// ---------------------------------------------------------------------------

import {
    GATEWAY_KEY_HEADER,
    GATEWAY_NAME,
    GATEWAY_UPSTREAMS,
    gatewayOf,
    ModelRegistry,
    vertexEndpoint,
    type Gateway,
} from '@zenera/neo';

import { PROVIDERS, type KeyCheck, type Provider } from '@zenera/engine';
import { Cache, cacheKey } from './cache.ts';
import { classify } from './liveness.ts';
import { catalogRef } from './modelref.ts';
import { compareModels } from './rank.ts';

/**
 * What a model is *for*. A model can hold more than one — Gemini's embedding
 * endpoint and its chat endpoint are the same catalog row on some providers —
 * so this is a set rather than a field.
 */
export type Role = 'chat' | 'embedding' | 'image' | 'audio';

export interface CatalogEntry {
    /** `provider/id` — paste-able straight into `agents.yaml` */
    ref: string;
    /** the id that goes on the wire, with any resource prefix already stripped */
    id: string;
    provider: Provider;
    roles: Role[];
    name?: string;
    description?: string;
    /** total tokens the model will accept in one request */
    contextLength?: number;
    maxOutputTokens?: number;
    /** embeddings only, when the vendor publishes it */
    dimensions?: number;
    modalities?: { input?: string[]; output?: string[] };
    supports?: { tools?: boolean; reasoning?: boolean; vision?: boolean };
    /** USD per token, as the vendor writes it — strings, because they are tiny */
    pricing?: { prompt?: string; completion?: string; free?: boolean };
    /** ISO date the model was published, when known */
    created?: string;
    /** vertex only: who makes it - `google`, or the partner Vertex resells */
    publisher?: string;
    source: 'live' | 'curated';
}

/** A provider's listing, and an honest account of where it came from. */
export interface Catalog {
    provider: Provider;
    entries: CatalogEntry[];
    /** `live` asked just now; `cache` a fresh file; `stale` an expired one; `curated` the fallback */
    origin: 'live' | 'cache' | 'stale' | 'curated';
    /** when the entries were actually fetched, not when they were read */
    fetchedAt: string;
    /** why the live call was not used, when it was tried and failed */
    problem?: KeyCheck;
    /** the gateway it was listed through, when the keyring is in a gateway mode */
    via?: { name: string; url: string };
}

/** A day. Model lists change on the scale of weeks; a stale row costs a retry. */
export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

export const CATALOG_KIND = 'catalog';

/** Bumped when the stored shape changes, which makes every old entry a miss. */
const CATALOG_VERSION = 2;

interface CacheFile {
    provider: Provider;
    fetchedAt: string;
    entries: CatalogEntry[];
}

// ---------------------------------------------------------------------------
// The fallback table
// ---------------------------------------------------------------------------

/**
 * Enough to work with when the provider cannot be asked — offline, no
 * credential, or a listing endpoint that is down. Deliberately short: this is
 * the set worth typing, not the set that exists.
 *
 * Anthropic publishes no embeddings API at all, which is why it has no
 * embedding row here and why the registry throws rather than guessing.
 */
export const CURATED: Record<
    Provider,
    readonly Omit<CatalogEntry, 'ref' | 'provider' | 'source'>[]
> = {
    openai: [
        { id: 'gpt-5.6-luna', roles: ['chat'], contextLength: 1_050_000 },
        { id: 'gpt-5.6-terra', roles: ['chat'], contextLength: 1_050_000 },
        { id: 'text-embedding-3-small', roles: ['embedding'], dimensions: 1536 },
        { id: 'text-embedding-3-large', roles: ['embedding'], dimensions: 3072 },
    ],
    anthropic: [
        { id: 'claude-sonnet-5', roles: ['chat'], contextLength: 1_000_000 },
        { id: 'claude-opus-5', roles: ['chat'], contextLength: 1_000_000 },
    ],
    google: [
        { id: 'gemini-3.5-flash-lite', roles: ['chat'], contextLength: 1_048_576 },
        { id: 'gemini-3.8-flash', roles: ['chat'], contextLength: 1_048_576 },
        { id: 'gemini-embedding-2', roles: ['embedding'] },
    ],
    vertex: [
        {
            id: 'gemini-3.5-flash-lite',
            roles: ['chat'],
            contextLength: 1_048_576,
            publisher: 'google',
        },
        { id: 'gemini-3.8-flash', roles: ['chat'], contextLength: 1_048_576, publisher: 'google' },
        { id: 'gemini-embedding-2', roles: ['embedding'], publisher: 'google' },
        // Open-weight models are served but not listed by Model Garden, so these are the only record.
        { id: 'qwen/qwen3-235b-a22b-instruct-2507-maas', roles: ['chat'], publisher: 'qwen' },
        { id: 'openai/gpt-oss-120b-maas', roles: ['chat'], publisher: 'openai' },
    ],
    openrouter: [
        { id: 'openai/gpt-5.6-luna', roles: ['chat'], contextLength: 1_050_000 },
        { id: 'anthropic/claude-sonnet-5', roles: ['chat'], contextLength: 1_000_000 },
        { id: 'openai/text-embedding-3-small', roles: ['embedding'], dimensions: 1536 },
    ],
};

/**
 * The cheap, fast models per provider and role, best first. `zen init` takes
 * its default embedder from here.
 */
export const PREFERRED: Record<
    Provider,
    { chat: readonly string[]; embedding: readonly string[] }
> = {
    openai: {
        chat: ['gpt-5.6-luna', 'gpt-5.6-terra'],
        embedding: ['text-embedding-3-small', 'text-embedding-3-large'],
    },
    anthropic: {
        chat: ['claude-sonnet-5', 'claude-opus-5'],
        embedding: [],
    },
    google: {
        chat: ['gemini-3.5-flash-lite', 'gemini-3.5-flash'],
        embedding: ['gemini-embedding-2'],
    },
    vertex: {
        chat: ['gemini-3.5-flash-lite', 'gemini-3.5-flash'],
        embedding: ['gemini-embedding-2'],
    },
    openrouter: {
        chat: ['openai/gpt-5.6-luna', 'anthropic/claude-sonnet-5'],
        embedding: ['openai/text-embedding-3-small'],
    },
};

function curated(provider: Provider): CatalogEntry[] {
    return CURATED[provider].map((entry) => ({
        ...entry,
        ref: catalogRef(provider, entry.id),
        provider,
        source: 'curated' as const,
    }));
}

// ---------------------------------------------------------------------------
// Vendor adapters
//
// Each takes the client `ModelRegistry` already built — never a direct SDK
// import — so a missing optional dependency surfaces as the library's own
// "run: npm i openai" rather than a stack trace from this file.
//
// The SDK types are described structurally and locally. Four vendors' generated
// types would drag half of `zod` into a module whose whole job is to produce
// one flat row shape, and every field here is one the wire format has carried
// unchanged for years.
// ---------------------------------------------------------------------------

const iso = (value: number | string | undefined | null): string | undefined => {
    if (value === undefined || value === null) {
        return undefined;
    }
    // OpenAI and OpenRouter both say unix seconds; Anthropic says a timestamp.
    const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10);
};

/** Drops empty optionals so a cached row does not carry a dozen `undefined`s. */
function entry(
    provider: Provider,
    row: Omit<CatalogEntry, 'ref' | 'provider' | 'source'>,
): CatalogEntry {
    const clean = Object.fromEntries(
        Object.entries(row).filter(([, v]) => v !== undefined && v !== null),
    ) as Omit<CatalogEntry, 'ref' | 'provider' | 'source'>;
    return { ...clean, ref: catalogRef(provider, row.id), provider, source: 'live' };
}

interface OpenAIClient {
    models: { list(): Promise<AsyncIterable<{ id: string; created?: number }>> };
}

/**
 * OpenAI's listing is three fields — id, created, owner — so the role has to be
 * read off the id. Wrong on an id nobody has seen before, which is why the
 * curated table is merged over the top and why `test` asks the model itself.
 */
function openaiRole(id: string): Role | undefined {
    if (/moderation/.test(id)) {
        return undefined; // not reachable through any interface this CLI has
    }
    if (/embedding/.test(id)) {
        return 'embedding';
    }
    // `dall-e-3`, `gpt-image-1` and `chatgpt-image-latest` share only the word.
    if (/^dall-e|image/.test(id)) {
        return 'image';
    }
    if (/(whisper|tts|transcribe|realtime|audio)/.test(id)) {
        return 'audio';
    }
    return 'chat';
}

async function fromOpenAI(client: unknown, provider: Provider): Promise<CatalogEntry[]> {
    const page = await (client as OpenAIClient).models.list();
    const rows: CatalogEntry[] = [];
    for await (const model of page) {
        const role = openaiRole(model.id);
        if (role) {
            rows.push(
                entry(provider, { id: model.id, roles: [role], created: iso(model.created) }),
            );
        }
    }
    return rows;
}

interface AnthropicClient {
    models: {
        list(params: {
            limit: number;
        }): Promise<AsyncIterable<{ id: string; display_name?: string; created_at?: string }>>;
    };
}

async function fromAnthropic(client: unknown, provider: Provider): Promise<CatalogEntry[]> {
    const page = await (client as AnthropicClient).models.list({ limit: 1000 });
    const rows: CatalogEntry[] = [];
    for await (const model of page) {
        // Every model Anthropic lists is a chat model. Emitting an embedding
        // row would be inventing an endpoint that does not exist.
        rows.push(
            entry(provider, {
                id: model.id,
                roles: ['chat'],
                name: model.display_name,
                created: iso(model.created_at),
            }),
        );
    }
    return rows;
}

interface GenAIClient {
    models: {
        list(params: { config: { queryBase: boolean; pageSize: number } }): Promise<
            AsyncIterable<{
                name?: string;
                displayName?: string;
                description?: string;
                inputTokenLimit?: number;
                outputTokenLimit?: number;
                supportedActions?: string[];
            }>
        >;
    };
}

/**
 * Google returns resource names — `models/gemini-2.5-flash`, or under Vertex
 * `publishers/google/models/…`. The native API takes the bare tail, and the
 * bare tail is what a ref has to hold, so the prefix comes off here.
 */
const bareId = (name: string): string => name.split('/').pop() ?? name;

/**
 * Vertex lists the whole Model Garden — `alphafold3-request`, `bart-large-cnn`,
 * `automl-e2e` — alongside the models the GenAI API will actually serve. The
 * garden rows are deployment recipes, not model ids: they carry no
 * `supportedActions` and no token limits, and asking one of them a question
 * fails in a way no error message explains.
 *
 * So a row with no declared actions has to earn its place on the id. Generous
 * on purpose — a new `gemini-4` must not need a release here — and it only
 * applies where the backend told us nothing.
 */
const GENERATIVE =
    /^(gemini|gemma|imagen|veo|text-embedding|text-multilingual|multimodalembedding|embedding)/;

async function fromGenAI(client: unknown, provider: Provider): Promise<CatalogEntry[]> {
    // `queryBase: true` is not optional: without it the SDK lists *tuned*
    // models, and an account with none looks like an account with no models —
    // which is precisely the confusion this command exists to end.
    const pager = await (client as GenAIClient).models.list({
        config: { queryBase: true, pageSize: 200 },
    });
    const rows: CatalogEntry[] = [];
    for await (const model of pager) {
        if (!model.name) {
            continue;
        }
        const id = bareId(model.name);
        const actions = model.supportedActions ?? [];
        const roles: Role[] = [];
        if (actions.includes('embedContent')) {
            roles.push('embedding');
        }
        if (actions.includes('generateContent') || actions.includes('streamGenerateContent')) {
            roles.push('chat');
        }
        if (actions.includes('predict') && /image|imagen/.test(id)) {
            roles.push('image');
        }
        if (roles.length === 0) {
            if (!GENERATIVE.test(id)) {
                continue;
            }
            roles.push(/embedding/.test(id) ? 'embedding' : 'chat');
        }
        rows.push(
            entry(provider, {
                id,
                roles,
                name: model.displayName,
                description: model.description,
                contextLength: model.inputTokenLimit,
                maxOutputTokens: model.outputTokenLimit,
                publisher: provider === 'vertex' ? 'google' : undefined,
            }),
        );
    }
    return rows;
}

interface RouterModel {
    id: string;
    name?: string;
    description?: string;
    contextLength?: number | null;
    created?: number;
    architecture?: {
        inputModalities?: string[];
        outputModalities?: string[];
    };
    pricing?: { prompt?: string; completion?: string };
    supportedParameters?: string[];
    topProvider?: { maxCompletionTokens?: number | null };
}

interface RouterPage {
    result?: { data?: RouterModel[] };
}

interface RouterClient {
    models: { list(): Promise<AsyncIterable<RouterPage>> };
    embeddings: { listModels(): Promise<AsyncIterable<RouterPage>> };
}

function routerRow(provider: Provider, model: RouterModel, roles: Role[]): CatalogEntry {
    const input = model.architecture?.inputModalities ?? [];
    const params = model.supportedParameters ?? [];
    const prompt = model.pricing?.prompt;
    return entry(provider, {
        id: model.id,
        roles,
        name: model.name,
        description: model.description,
        contextLength: model.contextLength ?? undefined,
        maxOutputTokens: model.topProvider?.maxCompletionTokens ?? undefined,
        modalities: {
            input,
            output: model.architecture?.outputModalities ?? [],
        },
        supports: {
            tools: params.includes('tools'),
            reasoning: params.includes('reasoning') || params.includes('include_reasoning'),
            vision: input.includes('image'),
        },
        pricing: {
            prompt,
            completion: model.pricing?.completion,
            // OpenRouter writes a free model's price as the string "0".
            free: prompt !== undefined && Number(prompt) === 0,
        },
        created: iso(model.created),
    });
}

async function walk(pages: AsyncIterable<RouterPage>): Promise<RouterModel[]> {
    const all: RouterModel[] = [];
    for await (const page of pages) {
        all.push(...(page.result?.data ?? []));
    }
    return all;
}

async function fromRouter(client: unknown, provider: Provider): Promise<CatalogEntry[]> {
    const router = client as RouterClient;
    // Two endpoints, because OpenRouter routes embeddings separately and the
    // chat listing does not mention them. Asked together: one slow provider
    // should not cost twice the wall clock.
    //
    // Only the chat listing is allowed to fail the whole call. The embeddings
    // endpoint is the newer of the two and the one a gateway is most likely not
    // to proxy, and losing every chat model over it would be a poor trade.
    const [chat, embedding] = await Promise.all([
        walk(await router.models.list()),
        (async () => {
            try {
                return await walk(await router.embeddings.listModels());
            } catch {
                return [] as RouterModel[];
            }
        })(),
    ]);
    const rows = chat.map((m) => routerRow(provider, m, ['chat']));
    const seen = new Set(rows.map((r) => r.id));
    for (const m of embedding) {
        if (!seen.has(m.id)) {
            rows.push(routerRow(provider, m, ['embedding']));
        }
    }
    return rows;
}

/**
 * Partner models on Vertex. The GenAI listing holds Google's alone, so each
 * partner's Model Garden listing is asked as well - only for publishers whose
 * models the runtime can call: Claude at `rawPredict`, the rest at the
 * OpenAI-compatible endpoint as `publisher/model`.
 */
const VERTEX_PARTNERS = ['anthropic', 'xai'] as const;

export async function fromVertexPartners(): Promise<CatalogEntry[]> {
    const at = vertexEndpoint();
    const token = await at.token();
    const lists = await Promise.all(
        VERTEX_PARTNERS.map(async (publisher) => {
            const res = await fetch(
                `https://aiplatform.googleapis.com/v1beta1/publishers/${publisher}/models?pageSize=200`,
                {
                    headers: {
                        Authorization: `Bearer ${token}`,
                        'x-goog-user-project': at.project,
                    },
                },
            );
            if (!res.ok) {
                return [];
            }
            const body = (await res.json()) as { publisherModels?: { name?: string }[] };
            return (body.publisherModels ?? [])
                .map((m) => bareId(m.name ?? ''))
                .filter((id) => id && !/embed|ocr/.test(id))
                .map((id) =>
                    entry('vertex', {
                        id: publisher === 'anthropic' ? id : `${publisher}/${id}`,
                        roles: ['chat'],
                        publisher,
                    }),
                );
        }),
    );
    return lists.flat();
}

/**
 * Asks one provider what it serves. Throws whatever the SDK throws.
 *
 * `client` is a seam, not a feature: the four adapters are the part most likely
 * to break when a vendor reshapes a payload, and they are untestable if the
 * only way to reach them is a credential and a network. It mirrors
 * `ProviderSpec.client`, which exists in the library for the same reason.
 * `partners` is the same seam for Vertex's second listing.
 */
export async function fetchCatalog(
    provider: Provider,
    client: unknown = new ModelRegistry().client(provider),
    partners: () => Promise<CatalogEntry[]> = fromVertexPartners,
): Promise<CatalogEntry[]> {
    switch (provider) {
        case 'openai':
            return enrich(provider, await fromOpenAI(client, provider));
        case 'anthropic':
            return enrich(provider, await fromAnthropic(client, provider));
        case 'google':
            return enrich(provider, await fromGenAI(client, provider));
        case 'vertex': {
            // A partner listing that fails must not cost the Gemini one.
            const [google, others] = await Promise.all([
                fromGenAI(client, provider),
                partners().catch(() => [] as CatalogEntry[]),
            ]);
            const live = [...google, ...others];
            const seen = new Set(live.map((r) => r.id));
            const unlisted = curated(provider).filter(
                (r) => r.publisher !== 'google' && !seen.has(r.id),
            );
            return enrich(provider, [...live, ...unlisted]);
        }
        case 'openrouter':
            return enrich(provider, await fromRouter(client, provider));
    }
}

// ---------------------------------------------------------------------------
// Through a gateway
//
// In a gateway mode a run can reach only what the gateway serves, so that is
// the whole listing: the vendor's own catalog would offer models the virtual
// key may not touch. Bifrost lists every upstream at once as `<upstream>/<id>`,
// which is split back into the provider an `agents.yaml` ref names. Upstreams
// with no zen provider (bedrock, groq, …) cannot be named by a ref, so they are
// left out.
// ---------------------------------------------------------------------------

interface GatewayModel {
    id?: unknown;
    name?: unknown;
    created?: unknown;
    context_length?: unknown;
}

const UPSTREAM_OF = new Map<string, Provider>(
    PROVIDERS.map((p) => [GATEWAY_UPSTREAMS[p], p] as [string, Provider]),
);

/** One request per gateway per process, however many providers ask. */
const listings = new Map<string, Promise<Map<Provider, CatalogEntry[]>>>();

function gatewayListing(at: Gateway): Promise<Map<Provider, CatalogEntry[]>> {
    const key = `${at.baseURL}\0${at.apiKey ?? ''}`;
    let listing = listings.get(key);
    if (!listing) {
        listing = fetchGatewayListing(at);
        listings.set(key, listing);
        listing.catch(() => listings.delete(key));
    }
    return listing;
}

async function fetchGatewayListing(at: Gateway): Promise<Map<Provider, CatalogEntry[]>> {
    const res = await fetch(`${at.baseURL}/v1/models`, {
        headers: at.apiKey
            ? { authorization: `Bearer ${at.apiKey}`, [GATEWAY_KEY_HEADER]: at.apiKey }
            : {},
        signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw Object.assign(new Error(`${GATEWAY_NAME} answered ${res.status}: ${body}`), {
            status: res.status,
        });
    }
    const { data } = (await res.json()) as { data?: GatewayModel[] };
    const by = new Map<Provider, CatalogEntry[]>();
    for (const model of data ?? []) {
        if (typeof model.id !== 'string') {
            continue;
        }
        const slash = model.id.indexOf('/');
        const provider = slash > 0 ? UPSTREAM_OF.get(model.id.slice(0, slash)) : undefined;
        const id = model.id.slice(slash + 1);
        const role = openaiRole(id);
        if (!provider || !id || !role) {
            continue;
        }
        const rows = by.get(provider) ?? [];
        rows.push(
            entry(provider, {
                id,
                roles: [role],
                name: typeof model.name === 'string' ? model.name : undefined,
                contextLength:
                    typeof model.context_length === 'number' ? model.context_length : undefined,
                created: iso(typeof model.created === 'number' ? model.created : undefined),
                publisher: provider === 'vertex' ? publisherOf(id) : undefined,
            }),
        );
        by.set(provider, rows);
    }
    return by;
}

function publisherOf(id: string): string {
    if (/^claude-/.test(id)) {
        return 'anthropic';
    }
    if (/^(mistral|codestral)-/.test(id)) {
        return 'mistral';
    }
    return id.includes('/') ? id.split('/')[0]! : 'google';
}

/** What the gateway serves under one provider's name, enriched like a vendor listing. */
export async function fetchGatewayCatalog(
    provider: Provider,
    at: Gateway,
): Promise<CatalogEntry[]> {
    return enrich(provider, (await gatewayListing(at)).get(provider) ?? []);
}

// ---------------------------------------------------------------------------
// Enrichment and cache
// ---------------------------------------------------------------------------

/**
 * A live row wins on every field it filled in, and the curated table supplies
 * the rest. That is how `text-embedding-3-small` gets its width from here while
 * still being reported as the vendor's own row: OpenAI's listing carries no
 * dimensions field at all, and a blank there would send someone to the docs.
 */
function enrich(provider: Provider, live: CatalogEntry[]): CatalogEntry[] {
    const known = new Map(CURATED[provider].map((c) => [c.id, c]));
    return live.map((row) => {
        const extra = known.get(row.id);
        if (!extra) {
            return row;
        }
        return {
            ...row,
            roles: row.roles.length > 0 ? row.roles : [...extra.roles],
            contextLength: row.contextLength ?? extra.contextLength,
            dimensions: row.dimensions ?? extra.dimensions,
        };
    });
}

/**
 * Listings are public data, so the file is left readable — someone wondering
 * where a model row came from can go and look at it. Opened per call rather
 * than once, because the home directory is an environment variable and a test
 * is allowed to move it.
 */
const store = (): Cache => new Cache(CATALOG_KIND, { mode: 0o644 });

/**
 * What else decides a listing's contents. Vertex answers per project and per
 * location — one account was offered eight models at `us` and forty at
 * `us-central1` — so a key naming only the provider serves one of those lists
 * to both. A project left to the service-account file is not seen here.
 */
function scope(provider: Provider): string | undefined {
    if (provider !== 'vertex') {
        return undefined;
    }
    return cacheKey(
        process.env.GOOGLE_CLOUD_PROJECT,
        process.env.GOOGLE_CLOUD_LOCATION ?? 'global',
    );
}

/** The key one provider's listing is filed under, version and all. */
export const catalogKey = (provider: Provider): string => {
    const extra = scope(provider);
    return extra ? cacheKey(CATALOG_VERSION, provider, extra) : cacheKey(CATALOG_VERSION, provider);
};

function readCache(provider: Provider): CacheFile | undefined {
    const file = store().get<CacheFile>(catalogKey(provider));
    if (!file || !Array.isArray(file.entries) || typeof file.fetchedAt !== 'string') {
        return undefined;
    }
    // Rows cached before refs were written `provider/id` say `provider:id`.
    return {
        ...file,
        entries: file.entries.map((e) => ({ ...e, ref: catalogRef(e.provider, e.id) })),
    };
}

export interface CatalogOptions {
    /** ignore a fresh cache and ask the provider again */
    refresh?: boolean;
    /** do not make a network call at all — cache, however old, then curated */
    offline?: boolean;
}

/**
 * Through a gateway nothing is cached on disk: the gateway caches its own
 * listing, one request serves every provider, and a stale copy outlives the
 * gateway's providers or the virtual key that was allowed to see them.
 */
async function loadGatewayCatalog(provider: Provider, at: Gateway): Promise<Catalog> {
    const via = { via: { name: GATEWAY_NAME, url: at.baseURL } };
    try {
        const entries = await fetchGatewayCatalog(provider, at);
        return { provider, entries, origin: 'live', fetchedAt: new Date().toISOString(), ...via };
    } catch (err) {
        // No built-in list: it names vendor models the gateway may not serve at all.
        return {
            provider,
            entries: [],
            origin: 'curated',
            fetchedAt: new Date(0).toISOString(),
            problem: classify(err),
            ...via,
        };
    }
}

/**
 * The listing for one provider, from the cheapest source that can answer.
 *
 * Fresh cache, else the provider, else a *stale* cache, else the curated table.
 * Stale-before-curated is the important ordering: yesterday's real answer from
 * this account beats today's guess about accounts in general, and a listing
 * that failed because the wifi dropped should not silently shrink someone's
 * model list to four rows.
 */
export async function loadCatalog(provider: Provider, opts: CatalogOptions = {}): Promise<Catalog> {
    const at = gatewayOf();
    if (at) {
        return loadGatewayCatalog(provider, at);
    }
    const cached = readCache(provider);
    const fresh =
        cached && Date.now() - new Date(cached.fetchedAt).getTime() < CATALOG_TTL_MS
            ? cached
            : undefined;

    if (fresh && !opts.refresh) {
        return {
            provider,
            entries: fresh.entries,
            origin: 'cache',
            fetchedAt: fresh.fetchedAt,
        };
    }
    if (!opts.offline) {
        try {
            const entries = await fetchCatalog(provider);
            const fetchedAt = new Date().toISOString();
            store().put(catalogKey(provider), { provider, fetchedAt, entries } satisfies CacheFile);
            return { provider, entries, origin: 'live', fetchedAt };
        } catch (err) {
            const problem = classify(err);
            if (cached) {
                return {
                    provider,
                    entries: cached.entries,
                    origin: 'stale',
                    fetchedAt: cached.fetchedAt,
                    problem,
                };
            }
            return {
                provider,
                entries: curated(provider),
                origin: 'curated',
                fetchedAt: new Date(0).toISOString(),
                problem,
            };
        }
    }
    if (cached) {
        return {
            provider,
            entries: cached.entries,
            origin: 'stale',
            fetchedAt: cached.fetchedAt,
        };
    }
    return {
        provider,
        entries: curated(provider),
        origin: 'curated',
        fetchedAt: new Date(0).toISOString(),
    };
}

// ---------------------------------------------------------------------------
// Prices and balance
// ---------------------------------------------------------------------------

/** A per-token USD price as dollars per million tokens, the unit price lists use. */
export function perMillion(price: string | undefined): string {
    if (price === undefined || price === '') {
        return '';
    }
    const n = Number(price) * 1_000_000;
    if (!Number.isFinite(n)) {
        return '';
    }
    // OpenRouter prices its routers (`openrouter/auto`) as "-1": it depends on the pick.
    if (n < 0) {
        return 'varies';
    }
    if (n === 0) {
        return 'free';
    }
    if (n >= 1) {
        return `$${n.toFixed(2)}`;
    }
    // Two significant digits for fractions of a dollar, but never fewer than cents.
    const short = String(Number(n.toPrecision(2)));
    return `$${(short.split('.')[1]?.length ?? 0) < 2 ? n.toFixed(2) : short}`;
}

/** What an OpenRouter account has left to spend, as far as its key may see. */
export interface Balance {
    /** credits bought minus credits used; absent when the key may not read the account */
    credits?: number;
    /** the key's own spending cap, when one is set */
    cap?: { limit: number; remaining: number; reset?: string };
    /** requests to `:free` models left today */
    free?: { used: number; limit: number; remaining: number };
}

interface RouterKey {
    limit: number | null;
    limit_remaining: number | null;
    limit_reset: string | null;
    free_model_daily_requests?: { used: number; limit: number; remaining: number };
}

export async function routerBalance(): Promise<Balance> {
    const base = (process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1').replace(
        /\/+$/,
        '',
    );
    const get = async <T>(path: string): Promise<T> => {
        const res = await fetch(`${base}${path}`, {
            headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY ?? ''}` },
            signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
            throw Object.assign(new Error(`${path} answered ${res.status}`), {
                status: res.status,
            });
        }
        return ((await res.json()) as { data: T }).data;
    };
    // Raw rather than the SDK: its schema drops `free_model_daily_requests`.
    const [key, credits] = await Promise.all([
        get<RouterKey>('/key'),
        // Documented as management-key only, though ordinary keys are answered too.
        get<{ total_credits: number; total_usage: number }>('/credits').catch(() => undefined),
    ]);
    return {
        ...(credits ? { credits: credits.total_credits - credits.total_usage } : {}),
        ...(key.limit !== null && key.limit_remaining !== null
            ? {
                  cap: {
                      limit: key.limit,
                      remaining: key.limit_remaining,
                      ...(key.limit_reset ? { reset: key.limit_reset } : {}),
                  },
              }
            : {}),
        ...(key.free_model_daily_requests ? { free: key.free_model_daily_requests } : {}),
    };
}

/** Every provider asked at once — they are independent and mostly latency. */
export async function loadCatalogs(
    providers: readonly Provider[],
    opts: CatalogOptions = {},
): Promise<Catalog[]> {
    return Promise.all(providers.map((p) => loadCatalog(p, opts)));
}

// ---------------------------------------------------------------------------
// Searching
// ---------------------------------------------------------------------------

export interface Filters {
    roles?: readonly Role[];
    tools?: boolean;
    vision?: boolean;
    free?: boolean;
    minContext?: number;
}

export function matches(row: CatalogEntry, query: string, filters: Filters = {}): boolean {
    if (filters.roles?.length && !filters.roles.some((r) => row.roles.includes(r))) {
        return false;
    }
    if (filters.tools && !row.supports?.tools) {
        return false;
    }
    if (filters.vision && !row.supports?.vision) {
        return false;
    }
    if (filters.free && !row.pricing?.free) {
        return false;
    }
    if (filters.minContext !== undefined && (row.contextLength ?? 0) < filters.minContext) {
        return false;
    }
    if (!query) {
        return true;
    }
    // Every whitespace-separated word must appear somewhere, so `claude haiku`
    // narrows rather than widening the way an OR would.
    const haystack = `${row.ref} ${row.name ?? ''} ${row.description ?? ''}`.toLowerCase();
    return query
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
        .every((word) => haystack.includes(word));
}

/** The providers a search covers when none was named. */
export const catalogProviders = (): readonly Provider[] => PROVIDERS;

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

/** Resold on Vertex rather than made by Google. */
export const isPartner = (e: CatalogEntry): boolean =>
    e.publisher !== undefined && e.publisher !== 'google';

/** The order listings are shown in: the vendors in rank order, then the resellers. */
const GROUP_ORDER: readonly Provider[] = ['anthropic', 'openai', 'google', 'vertex', 'openrouter'];

/** Provider, then Google's own models, then each partner's together; best first within each. */
export function byGroup(a: CatalogEntry, b: CatalogEntry): number {
    return (
        GROUP_ORDER.indexOf(a.provider) - GROUP_ORDER.indexOf(b.provider) ||
        Number(isPartner(a)) - Number(isPartner(b)) ||
        (a.publisher ?? '').localeCompare(b.publisher ?? '') ||
        compareModels(a, b)
    );
}

/** The heading a row is listed under: its provider, split by maker where the provider resells. */
export function groupOf(e: CatalogEntry): string {
    if (!e.publisher) {
        return e.provider;
    }
    return isPartner(e)
        ? `${e.provider} · partner · ${e.publisher}`
        : `${e.provider} · Google (Gemini, Gemma, Imagen, Veo)`;
}

/**
 * At most `limit` rows, shared evenly between providers and kept in order, so a
 * long first listing does not push the others off a truncated screen.
 */
export function sampleByProvider(rows: readonly CatalogEntry[], limit: number): CatalogEntry[] {
    if (rows.length <= limit) {
        return [...rows];
    }
    const counts = new Map<Provider, { total: number; take: number }>();
    for (const row of rows) {
        const c = counts.get(row.provider) ?? { total: 0, take: 0 };
        c.total++;
        counts.set(row.provider, c);
    }
    for (let left = limit, gave = true; left > 0 && gave;) {
        gave = false;
        for (const c of counts.values()) {
            if (left > 0 && c.take < c.total) {
                c.take++;
                left--;
                gave = true;
            }
        }
    }
    const seen = new Map<Provider, number>();
    return rows.filter((row) => {
        const n = (seen.get(row.provider) ?? 0) + 1;
        seen.set(row.provider, n);
        return n <= counts.get(row.provider)!.take;
    });
}
