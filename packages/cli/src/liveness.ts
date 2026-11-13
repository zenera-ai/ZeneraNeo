import {
    envOf,
    SHAPES,
    type KeyCheck,
    type KeyEntry,
    type KeyStore,
    type Provider,
    type Service,
} from '@zenera/engine';
import {
    createModel,
    EXA_BASE_URL,
    GATEWAY_KEY_HEADER,
    isUnfunded,
    ModelRegistry,
    text,
    vertexRoute,
    type Embedder,
    type Model,
    type ProviderSpec,
} from '@zenera/neo';
import { splitRef } from './modelref.ts';

// ---------------------------------------------------------------------------
// Liveness
//
// The distinction that matters in the output is *dead* — the provider looked at
// the credential and said no — versus *unknown* — we could not ask. Collapsing
// them into one red mark is the classic way to send someone hunting for the
// wrong bug: rotating a perfectly good key because the office wifi was down.
//
// *blocked* is the third: the credential authenticated and the account then
// refused. A disabled api, an empty balance, a model this key was never granted
// — all arrive as a 403 alongside genuine rejections, and all of them are made
// worse by rotating the key.
// ---------------------------------------------------------------------------

/** Words a provider uses when the credential itself is the problem. */
const REJECTED = [
    'invalid_api_key',
    'invalid api key',
    'incorrect api key',
    'authentication',
    'unauthenticated',
    'unauthorized',
    'permission_denied',
    'permission denied',
    'api key not valid',
    'could not load the default credentials',
];

/** Words that mean the question never arrived. */
const UNREACHED = [
    'enotfound',
    'econnrefused',
    'econnreset',
    'etimedout',
    'eai_again',
    'fetch failed',
    'network',
    'timeout',
    'socket hang up',
];

/** Words for an api the account has switched off, or never switched on. */
const DISABLED = [
    'service_disabled',
    'accessnotconfigured',
    'has not been used in project',
    'is disabled',
    'api is not enabled',
];

/** Words for an account that authenticated and then declined to serve. */
const UNFUNDED = [
    'insufficient_quota',
    'billing',
    'credit balance is too low',
    'exceeded your current quota',
    'quota exceeded',
    'resource_exhausted',
    'payment required',
];

/**
 * Google names both the api and the project in its refusal, and buries them in
 * a console url. Digging them back out turns a paragraph into the one command
 * that fixes it.
 */
function enablement(message: string): string | undefined {
    const service = /apis\/api\/([a-z0-9.-]+\.googleapis\.com)/i.exec(message)?.[1];
    if (!service) {
        return undefined;
    }
    const project = /[?&]project=([a-z0-9-]+)/i.exec(message)?.[1];
    return `gcloud services enable ${service}${project ? ` --project ${project}` : ''}`;
}

export function classify(err: unknown): KeyCheck {
    const at = new Date().toISOString();
    // OpenAI, Anthropic and the GenAI SDK all say `status`; OpenRouter's says
    // `statusCode`. Reading only the first would classify a revoked key as
    // *unknown*, which is the one confusion this module exists to prevent.
    const e = err as { status?: number; statusCode?: number };
    const status = e?.status ?? e?.statusCode;
    const message = err instanceof Error ? err.message : String(err);
    const haystack = `${status ?? ''} ${message}`.toLowerCase();

    // Ahead of the 401/403 arm, because both of these arrive as a 403 and both
    // are about the account rather than the key.
    if (DISABLED.some((needle) => haystack.includes(needle))) {
        return {
            state: 'blocked',
            at,
            detail: firstLine(message),
            fix: enablement(message) ?? 'enable the api for this project in the vendor console',
        };
    }
    // A 429 is this minute's rate limit, not an empty account, and the two
    // share vocabulary — so a status that says "slow down" wins. Unless the
    // vendor named the refusal itself: `credit_balance_exhausted` is a 429 too,
    // and it is the account.
    if (
        isUnfunded(err) ||
        (status !== 429 && UNFUNDED.some((needle) => haystack.includes(needle)))
    ) {
        return {
            state: 'blocked',
            at,
            detail: firstLine(message),
            fix: 'add credit or raise the quota in the vendor console',
        };
    }
    if (status === 401 || status === 403) {
        return { state: 'dead', at, detail: `${status} ${firstLine(message)}` };
    }
    if (REJECTED.some((needle) => haystack.includes(needle))) {
        return { state: 'dead', at, detail: firstLine(message) };
    }
    if (UNREACHED.some((needle) => haystack.includes(needle))) {
        return { state: 'unknown', at, detail: 'could not reach the provider' };
    }
    // A json api that answers in html was never reached: the hostname was
    // wrong. Vertex builds its hostname out of the location, so a misspelt
    // region lands here — as `<!DOCTYPE html>`, which explains nothing.
    if (haystack.includes('<!doctype html') || haystack.includes('<html')) {
        return {
            state: 'unknown',
            at,
            detail: 'a web page came back, not the api — the endpoint does not exist',
            fix: 'check the location: vertex builds its hostname from it',
        };
    }
    // 429 means the credential authenticated and then got rate limited, which
    // is a live key having a bad day.
    if (status === 429) {
        return { state: 'live', at, detail: 'rate limited, but authenticated' };
    }
    return { state: 'unknown', at, detail: firstLine(message) };
}

/**
 * The one sentence worth showing.
 *
 * Google's SDK throws with the whole JSON error body as the message, and a
 * table cell holding `{"error":{"code":403,"message":"…` is a cell nobody
 * reads. The sentence inside it is the part a person or an agent acts on, so
 * that is what comes out when there is one.
 */
const firstLine = (s: string): string => {
    const start = s.indexOf('{');
    if (start !== -1) {
        try {
            const body = JSON.parse(s.slice(start)) as { error?: { message?: string } };
            if (typeof body.error?.message === 'string') {
                return body.error.message.split('\n')[0]!.slice(0, 200);
            }
        } catch {
            // Not JSON, or truncated JSON. The raw line is still better than nothing.
        }
    }
    return s.split('\n')[0]!.slice(0, 200);
};

// ---------------------------------------------------------------------------
// Deadline
//
// Every SDK here retries, and some of them retry a connection that will never
// be answered — a proxy that swallows packets, a VPN half up. Left alone that
// is a `zen key check` which never returns, and a command that hangs teaches
// nobody anything. The credential question is one round trip; if it has not
// been answered by now, the honest answer is *unknown*.
// ---------------------------------------------------------------------------

const DEADLINE_MS = 15_000;

/**
 * A model is asked to think, not merely to authenticate, so it is given longer
 * — a reasoning model can spend half a minute on one word and still be working.
 */
const MODEL_DEADLINE_MS = 90_000;

class Deadline extends Error {}

async function within<T>(work: Promise<T>, ms = DEADLINE_MS): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            work,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Deadline()), ms);
                // The abandoned request must not keep the process alive.
                timer.unref?.();
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * The cheapest authenticated call each SDK has. Nothing here reads a model or
 * spends a token: the question is only whether the credential is accepted.
 *
 * The client is built through the library's own registry rather than by
 * requiring the SDKs directly, so a missing optional dependency produces the
 * library's "run: npm i openai" message instead of a raw MODULE_NOT_FOUND.
 *
 * A secret is handed to the registry as a value rather than exported first,
 * which is what lets several of these run at once: two probes sharing
 * `process.env` would each read the other's key.
 */
export async function probe(store: KeyStore, entry: KeyEntry): Promise<KeyCheck> {
    const shape = SHAPES[entry.provider];
    if (shape.kind === 'service') {
        return probeService(entry.provider as Service, store.reveal(entry));
    }
    if (shape.kind === 'gateway') {
        return probeGateway(entry.url, store.reveal(entry));
    }
    const provider = entry.provider as Provider;
    const credential = store.reveal(entry);
    // What the entry holds, not what its provider usually holds: a Vertex
    // express key is a secret like any other, and passing it as a value is what
    // lets it be asked at the same time as the rest.
    if (entry.holds !== 'file') {
        return ask(provider, { kind: provider, apiKey: credential });
    }

    // A service-account file is the exception, and `probeAll` knows it:
    // Application Default Credentials are found through the environment or not
    // at all. So this one is exported, asked, and put back — alone.
    const name = envOf(entry);
    const restore = exportTemporarily({
        [name]: credential,
        ...(entry.project ? { GOOGLE_CLOUD_PROJECT: entry.project } : {}),
        ...(entry.location ? { GOOGLE_CLOUD_LOCATION: entry.location } : {}),
    });
    try {
        return await ask(provider, { kind: provider });
    } finally {
        restore();
    }
}

/** Sets variables, and hands back the undo. */
function exportTemporarily(vars: Record<string, string>): () => void {
    const previous = new Map(Object.keys(vars).map((name) => [name, process.env[name]]));
    Object.assign(process.env, vars);
    return () => {
        for (const [name, value] of previous) {
            if (value === undefined) {
                delete process.env[name];
            } else {
                process.env[name] = value;
            }
        }
    };
}

/** One authenticated round trip, and what its silence or refusal means. */
async function ask(provider: Provider, spec: ProviderSpec): Promise<KeyCheck> {
    try {
        const registry = new ModelRegistry();
        registry.provider('probe', spec);
        await within(authenticate(provider, registry.client('probe')));
        return { state: 'live', at: new Date().toISOString() };
    } catch (err) {
        if (err instanceof Deadline) {
            return {
                state: 'unknown',
                at: new Date().toISOString(),
                detail: `no answer in ${DEADLINE_MS / 1000}s`,
            };
        }
        return classify(err);
    }
}

/**
 * A service has no model catalog to list, and its cheapest endpoint is one that
 * bills. So the question is asked with a request that cannot succeed: an empty
 * body. Authentication is checked before the body is, which makes the two
 * refusals say different things — a rejected key never gets far enough to be
 * told its body is wrong, and a good key is told nothing else.
 *
 *   401 INVALID_API_KEY     → dead
 *   400 INVALID_REQUEST_BODY → live, and free
 *
 * Anything else is left to `classify`, which already knows how to tell a
 * refusal from an unreachable host.
 */
async function probeService(service: Service, key: string): Promise<KeyCheck> {
    const at = new Date().toISOString();
    // One service so far, and a switch rather than an `if`, so the next one is
    // added where it belongs instead of alongside.
    const url = { exa: `${EXA_BASE_URL}/contents` }[service];
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-api-key': key },
            body: '{}',
            signal: AbortSignal.timeout(DEADLINE_MS),
        });
        if (res.status === 401 || res.status === 403) {
            return { state: 'dead', at, detail: `${res.status} ${await said(res)}` };
        }
        // 402 is a key the vendor recognised and then declined to serve. It
        // authenticated; the account behind it is out of money, which is a
        // different problem and one no amount of rotating the key will fix.
        if (res.status === 402) {
            return { state: 'live', at, detail: await said(res) };
        }
        if (res.status === 400 || res.ok) {
            return { state: 'live', at };
        }
        return { state: 'unknown', at, detail: `${res.status} ${await said(res)}` };
    } catch (err) {
        return classify(err);
    }
}

/**
 * Bifrost's model listing is scoped to the virtual key that asks, so it is the
 * cheap call that looks at the key. Its refusals carry their reason as a
 * top-level `type` beside `error.message`, and two of them are about the
 * key's allowance rather than the key.
 */
async function probeGateway(url: string | undefined, key: string): Promise<KeyCheck> {
    const at = new Date().toISOString();
    if (!url) {
        return { state: 'unknown', at, detail: 'no gateway url stored with this key' };
    }
    try {
        const res = await fetch(`${url.replace(/\/+$/, '')}/v1/models`, {
            headers: { authorization: `Bearer ${key}`, [GATEWAY_KEY_HEADER]: key },
            signal: AbortSignal.timeout(DEADLINE_MS),
        });
        if (res.ok) {
            return { state: 'live', at };
        }
        const { type, message } = await refusal(res);
        const detail = `${res.status} ${message}`;
        if (res.status === 402 || type === 'budget_exceeded') {
            return {
                state: 'blocked',
                at,
                detail,
                fix: "raise the virtual key's budget in Bifrost",
            };
        }
        if (res.status === 401 || res.status === 403) {
            return { state: 'dead', at, detail };
        }
        if (res.status === 404 || /<html/i.test(message)) {
            return { state: 'unknown', at, detail, fix: 'check the url: is it the gateway root?' };
        }
        return { state: 'unknown', at, detail };
    } catch (err) {
        return classify(err);
    }
}

async function refusal(res: Response): Promise<{ type?: string; message: string }> {
    const raw = await res.text().catch(() => '');
    try {
        const body = JSON.parse(raw) as { type?: string; error?: { message?: string } };
        return { type: body.type, message: firstLine(body.error?.message ?? res.statusText) };
    } catch {
        return { message: firstLine(raw || res.statusText) };
    }
}

/** The vendor's own sentence about a refusal, when the body carries one. */
async function said(res: Response): Promise<string> {
    try {
        const body = (await res.json()) as { error?: string };
        return firstLine(body.error ?? res.statusText);
    } catch {
        return res.statusText;
    }
}

/**
 * Every vendor SDK here exposes `models.list`, but they disagree about the
 * argument and about what comes back, so the shapes are described structurally
 * rather than by importing sets of types the CLI otherwise has no use for.
 */
interface ListsModels {
    models: { list(args?: unknown): unknown };
}

/** The one `apiKeys` call OpenRouter scopes to the key presenting it. */
interface DescribesKey {
    apiKeys: { getCurrentKeyMetadata(): Promise<unknown> };
}

async function authenticate(provider: Provider, client: unknown): Promise<void> {
    // OpenRouter's model catalog is *public*: it answers 200 to a request
    // carrying no key at all, so listing it would report every credential live,
    // including a revoked one. `/key` describes the key that asked and is the
    // only cheap call that actually looks at it.
    if (provider === 'openrouter') {
        await (client as DescribesKey).apiKeys.getCurrentKeyMetadata();
        return;
    }

    const args =
        provider === 'anthropic'
            ? { limit: 1 }
            : provider === 'google' || provider === 'vertex'
              ? { config: { pageSize: 1 } }
              : undefined;
    const result = await (client as ListsModels).models.list(args);
    // OpenAI and Anthropic resolve to a page; the GenAI SDK resolves to a lazy
    // pager whose first fetch has already happened by the time we get here.
    void result;
}

/**
 * Probes many entries together, because they are independent questions asked
 * of different vendors and the answer is a round trip apiece: in sequence,
 * five keys is five deadlines end to end, and `zen init` spends them all
 * before it writes a file.
 *
 * The exception is a credential the SDK can only be given through the
 * environment — the vertex service-account file — since two of those in flight
 * would each read the other's path. Those go one at a time, after the rest.
 *
 * `onProbe` therefore reports what has *finished* rather than what is being
 * waited on; with several in the air there is no single one to name.
 *
 * Pairs rather than a map, because the caller needs the entry itself to record
 * the result against, and a map keyed by a string would only have to be
 * un-joined again.
 */
export async function probeAll(
    store: KeyStore,
    entries: readonly KeyEntry[],
    onProbe?: (entry: KeyEntry, done: number, total: number) => void,
): Promise<[KeyEntry, KeyCheck][]> {
    const exclusive = (entry: KeyEntry): boolean => entry.holds === 'file';
    const results = new Map<KeyEntry, KeyCheck>();
    let done = 0;
    const record = (entry: KeyEntry, check: KeyCheck): void => {
        results.set(entry, check);
        onProbe?.(entry, ++done, entries.length);
    };

    await Promise.all(
        entries
            .filter((entry) => !exclusive(entry))
            .map(async (entry) => record(entry, await probe(store, entry))),
    );
    for (const entry of entries.filter(exclusive)) {
        record(entry, await probe(store, entry));
    }

    // Back into the caller's order: which one answered first is an accident of
    // the network, and a list that reshuffles itself between runs is unreadable.
    return entries.map((entry) => [entry, results.get(entry) as KeyCheck]);
}

// ---------------------------------------------------------------------------
// Models
//
// A credential that authenticates says nothing about the model id it is spent
// on: `gemini-3.5-flash` with an OpenAI key, a deprecated snapshot, a model the
// account was never granted — all of them pass every check this file otherwise
// performs and then fail on the first turn of a real run. The only thing that
// answers the question is asking the model itself, so this asks it: one word
// in, one word out, per distinct model the project would use.
// ---------------------------------------------------------------------------

/** Words a vendor uses when the credential was fine and the model id was not. */
const UNSERVED = [
    'model_not_found',
    'does not exist',
    'not found',
    'unknown model',
    'invalid model',
    'no endpoints found',
    'is not supported',
    'not supported',
    'no access',
];

/** What the project calls a model, and the thing that call resolved to. */
export type ModelTarget =
    | { ref: string; kind: 'model'; model: Model }
    | { ref: string; kind: 'embedding'; embedder: Embedder };

export interface ModelProbe {
    /** the reference as the config writes it — an alias, or a full ref */
    ref: string;
    /** the id that goes on the wire */
    id: string;
    kind: 'model' | 'embedding';
    check: KeyCheck;
    /** how long the round trip took, for the one that is merely slow */
    ms: number;
    /** embeddings only: the width the model actually returned */
    dimensions?: number;
}

const targetId = (target: ModelTarget): string =>
    target.kind === 'model' ? target.model.id : target.embedder.id;

const PROBE_TOOL = {
    name: 'noop',
    description: 'Does nothing. Do not call it.',
    parameters: { type: 'object' as const, properties: {} },
};

/**
 * A chat model sized for a probe: 16 output tokens is enough for "ok", and
 * Anthropic requires a cap at all. Only the adapters that read `maxTokens` are
 * given one — the registry refuses a knob its adapter would never send, and the
 * OpenAI adapters have no such knob.
 */
export function probeChat(provider: string, id: string): Model {
    const capped = { provider, model: id, maxTokens: 16 };
    const unread = new ModelRegistry().knobs(capped).some((k) => k.knob === 'maxTokens');
    return createModel(unread ? { provider, model: id } : capped);
}

/**
 * Refused by the provider, unreachable, or served.
 *
 * A model this account cannot use is `blocked`, not `dead`: the credential was
 * accepted and the id was the thing refused, so the fix is another model rather
 * than another key. `dead` is left to mean the credential itself was rejected.
 */
function classifyModel(err: unknown, target: ModelTarget, ms: number): KeyCheck {
    const at = new Date().toISOString();
    const message = err instanceof Error ? err.message : String(err);
    const e = err as { status?: number; statusCode?: number; name?: string };
    const haystack = `${e?.status ?? e?.statusCode ?? ''} ${message}`.toLowerCase();
    if (err instanceof Deadline || e?.name === 'AbortError' || e?.name === 'TimeoutError') {
        return { state: 'unknown', at, detail: `no answer in ${MODEL_DEADLINE_MS / 1000}s` };
    }
    // OpenAI refuses tools alongside reasoning on chat completions, and says so.
    if (target.kind === 'model' && haystack.includes('/v1/responses')) {
        return { state: 'blocked', at, detail: firstLine(message), fix: responsesApi(target) };
    }
    if (UNSERVED.some((needle) => haystack.includes(needle))) {
        return { state: 'blocked', at, detail: firstLine(message), fix: instead(target) };
    }
    const check = classify(err);
    // classify() calls a 429 a live key; for a model it means nothing answered.
    if (check.state === 'live') {
        const said = (err as { detail?: unknown }).detail;
        return {
            state: 'unknown',
            at,
            detail: `rate limited after ${(ms / 1000).toFixed(1)}s of retries: ${typeof said === 'string' ? said : firstLine(message)}`,
            fix: limited(target),
        };
    }
    return check.state === 'blocked' && !check.fix ? { ...check, fix: instead(target) } : check;
}

function limited(target: ModelTarget): string {
    const blame = "the key and the model id are fine, the provider's rate limit is not";
    if (target.ref.endsWith(':free')) {
        return `${blame} — free models share a small upstream quota; retry later, or test the paid id: zen models test ${target.ref.slice(0, -':free'.length)}`;
    }
    return `${blame} — retry later`;
}

function responsesApi(target: ModelTarget): string {
    const provider = splitRef(target.ref).provider ?? 'openai';
    return `use the responses API: \`api: responses\` on the model, or the ref ${provider}/responses:${targetId(target)}`;
}

/** The command that finds something this account can actually use. */
function instead(target: ModelTarget): string {
    const provider = splitRef(target.ref).provider;
    if (provider === 'vertex' && vertexRoute(targetId(target)) !== 'gemini') {
        return 'enable it for this project in Model Garden: https://console.cloud.google.com/vertex-ai/model-garden';
    }
    return provider
        ? `zen models ls ${provider}`
        : `zen models ls --${target.kind === 'embedding' ? 'embeddings' : 'chat'}`;
}

/**
 * The smallest real call the model can be asked for. It costs a handful of
 * tokens, which is the point: anything cheaper than a completion does not
 * exercise the thing that breaks.
 *
 * An embedding answers with its width, which is worth carrying back: a model
 * that serves the wrong number of dimensions is not interchangeable with the
 * one an index was built on.
 *
 * A chat model is offered one tool, because every agent run offers tools and
 * some refusals (reasoning plus tools on chat completions) only happen then.
 */
async function askModel(target: ModelTarget, signal: AbortSignal): Promise<number | undefined> {
    if (target.kind === 'embedding') {
        const res = await target.embedder.embed({ input: ['ping'], signal });
        return res.dimensions;
    }
    await target.model.generate({
        system: 'Reply with the single word: ok',
        messages: [{ role: 'user', content: [text('ping')] }],
        tools: [PROBE_TOOL],
        signal,
    });
    return undefined;
}

export async function probeModel(target: ModelTarget): Promise<ModelProbe> {
    const started = Date.now();
    const common = { ref: target.ref, id: targetId(target), kind: target.kind };
    try {
        // The signal cancels the request; the deadline a little behind it is
        // the answer for an SDK that decides to ignore the signal.
        const work = askModel(target, AbortSignal.timeout(MODEL_DEADLINE_MS));
        const dimensions = await within(work, MODEL_DEADLINE_MS + 5_000);
        return {
            ...common,
            check: { state: 'live', at: new Date().toISOString() },
            ms: Date.now() - started,
            ...(dimensions === undefined ? {} : { dimensions }),
        };
    } catch (err) {
        const ms = Date.now() - started;
        return { ...common, check: classifyModel(err, target, ms), ms };
    }
}

/**
 * One round trip per model, run together — they are independent questions, and
 * a project with four models should not take four deadlines to answer. Nothing
 * here touches `process.env`, so unlike the credential probes there is no case
 * that has to go alone.
 */
export async function probeModels(
    targets: readonly ModelTarget[],
    onProbe?: (target: ModelTarget, done: number, total: number) => void,
): Promise<ModelProbe[]> {
    let done = 0;
    return await Promise.all(
        targets.map(async (target) => {
            const result = await probeModel(target);
            onProbe?.(target, ++done, targets.length);
            return result;
        }),
    );
}
