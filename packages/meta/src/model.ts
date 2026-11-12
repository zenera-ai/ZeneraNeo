import {
    loadCatalogs,
    paths,
    PROVIDER_NAMES,
    PROVIDERS,
    rankModels,
    readJson,
    writeJson,
    type KeyStore,
    type Provider,
} from './host.ts';
import { metaCompatible } from './wire.ts';

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/** The variable a project's `.env` names it with — a zen ref, not a wire id. */
export const MODEL_ENV = 'ZENERA_META_MODEL';

export type ModelSource = 'flag' | 'shell' | 'env' | 'store' | 'project' | 'default';

export interface ModelChoice {
    /** a zen ref: `vertex/gemini-3.8-flash`, or a bare id for the default provider */
    ref: string;
    from: ModelSource;
}

export interface ModelSources {
    flag?: string;
    /** `ZENERA_META_MODEL` as it stood before the project's `.env` was folded in */
    shell?: string;
    /** the same variable after it was, which is the `.env` answer when they differ */
    env?: string;
    stored?: string;
    /** the project's `agents.yaml` `model:` */
    project?: string;
    /** what a held key recommends, when nothing above answered */
    fallback?: string;
}

/** Where the answer is looked for, best first. */
export const ORDER: readonly ModelSource[] = [
    'flag',
    'shell',
    'env',
    'store',
    'project',
    'default',
];

/**
 * Decides which model `zen meta` runs copilot on, when it can be named in six
 * places at once. The source comes back too, so a surprising pick can be traced
 * ("from agents.yaml model:") instead of guessed at.
 */
export function chooseModel(sources: ModelSources): ModelChoice | undefined {
    const at: Record<ModelSource, string | undefined> = {
        flag: sources.flag,
        // `.env` only fills gaps, so an answer that survived it came from the shell
        shell: sources.shell,
        env: sources.shell ? undefined : sources.env,
        store: sources.stored,
        project: sources.project,
        default: sources.fallback,
    };
    for (const from of ORDER) {
        const ref = at[from]?.trim();
        if (ref) {
            return { ref, from };
        }
    }
    return undefined;
}

export const SOURCE_LABELS: Record<ModelSource, string> = {
    flag: '--model',
    shell: `${MODEL_ENV} (shell)`,
    env: `${MODEL_ENV} (.env)`,
    store: 'zen meta model',
    project: 'agents.yaml model:',
    default: 'recommended',
};

// ---------------------------------------------------------------------------
// What to run when nobody said
//
// A first `zen meta` should work on a machine that has a key and nothing else,
// so the last resort is the best model the keys on hand can buy rather than an
// error. Deep tier deliberately: this agent is pointed at the project itself,
// and a cheap model reading a specification is a false economy.
// ---------------------------------------------------------------------------

/** First of each row is the default; the rest are the next best. */
export const RECOMMENDED: Partial<Record<Provider, readonly string[]>> = {
    openai: ['gpt-5.6-sol', 'gpt-5.6-terra'],
    anthropic: ['claude-opus-5', 'claude-sonnet-5'],
    vertex: ['gemini-3.8-flash', 'gemini-3.5-flash-lite'],
    google: ['gemini-3.8-flash', 'gemini-3.5-flash-lite'],
    openrouter: ['anthropic/claude-opus-5', 'openai/gpt-5.6-sol'],
};

/** Which provider is tried first when several are held. */
const PREFERENCE: readonly Provider[] = ['anthropic', 'openai', 'vertex', 'google', 'openrouter'];

/**
 * The model `zen meta` falls back to when nothing names one, so a machine with
 * just a key (or just a gateway, which reaches every provider) still runs.
 * `only` is `--provider`: the recommendation for that provider, if it is held.
 */
export function defaultRef(store: KeyStore, only?: Provider, gateway = false): string | undefined {
    for (const provider of only ? [only] : PREFERENCE) {
        const id = RECOMMENDED[provider]?.[0];
        if (id && (gateway || store.active(provider))) {
            return `${provider}/${id}`;
        }
    }
    return undefined;
}

/**
 * The best chat model a gateway actually serves, by `rank.ts`: a vendor
 * recommendation it does not carry would fail on the first call. The store must
 * already be materialized, since that is what puts the gateway in the environment.
 */
export async function gatewayDefaultRef(only?: Provider): Promise<string | undefined> {
    const cats = await loadCatalogs(only ? [only] : PROVIDERS);
    const usable = cats
        .flatMap((c) => c.entries)
        .filter((e) => e.roles.includes('chat') && metaCompatible(e.provider, e.id));
    const best = rankModels(usable)[0];
    return best ? `${best.provider}/${best.id}` : undefined;
}

/** The last resort: through a gateway, what it serves; otherwise what a held key recommends. */
export async function fallbackRef(
    store: KeyStore,
    only?: Provider,
    gateway = false,
): Promise<string | undefined> {
    return (
        (gateway ? await gatewayDefaultRef(only) : undefined) ?? defaultRef(store, only, gateway)
    );
}

// ---------------------------------------------------------------------------
// The store
//
// A model for the meta agent is a personal choice about a tool, like a key and
// unlike an agent's model, which is committed and shared. So it lives beside
// the keyring rather than in `agents.yaml`. One file for the whole meta
// surface: an agent and an effort level can join it without another.
// ---------------------------------------------------------------------------

export interface MetaFile {
    version: 1;
    model?: string;
}

const EMPTY: MetaFile = { version: 1 };

export const readMeta = (): Promise<MetaFile> => readJson<MetaFile>(paths.meta(), EMPTY);

export function writeMeta(file: MetaFile): void {
    writeJson(paths.meta(), file);
}

// ---------------------------------------------------------------------------
// Refs
// ---------------------------------------------------------------------------

/**
 * The provider a misspelt prefix was reaching for, if that is what it is.
 *
 * `vertes/gemini-3.8-flash` is shaped exactly like the OpenRouter id
 * `meta-llama/llama-4`, so an unknown prefix cannot be an error on its own —
 * only one close enough to a real provider name to be a slip of the hand.
 */
export function misspelledProvider(ref: string): Provider | undefined {
    const slash = ref.indexOf('/');
    if (slash <= 0) {
        return undefined;
    }
    const head = ref.slice(0, slash).toLowerCase();
    if (PROVIDER_NAMES.has(head)) {
        return undefined;
    }
    for (const name of PROVIDER_NAMES) {
        // Two, so that a transposition — which Levenshtein counts twice — reads
        // as the typo it is. No provider name is short enough for that to be loose.
        if (distance(head, name) <= 2) {
            return name as Provider;
        }
    }
    return undefined;
}

/** Levenshtein, one row at a time. Both operands are a word long. */
function distance(a: string, b: string): number {
    if (Math.abs(a.length - b.length) > 2) {
        return 3;
    }
    let row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const next = [i];
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + cost);
        }
        row = next;
    }
    return row[b.length];
}
