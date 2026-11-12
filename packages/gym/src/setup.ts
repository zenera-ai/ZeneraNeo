// packages/gym/src/setup.ts
//
// What a gym run needs before it starts: the model that writes handlers, the embedding model, and the keyring.
// Main: `open(opts)`, which settles both; also `chooseModel`, `chooseEmbedding`, `readSettings`/`writeSettings`.
// Used by: `command.ts` (`zen gym serve|build|world|model`).

import {
    credentialError,
    CURATED,
    ensureHome,
    envNames,
    home,
    invalidError,
    KeyStore,
    paths,
    PROVIDERS,
    readJson,
    writeJson,
    type Provider,
} from '@zenera/cli/lib';
import { createEmbedder, createModel, type EmbeddingRef, type Model } from '@zenera/neo';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Bindings } from './bindings.ts';
import { Box } from './box.ts';
import { Cache, type CacheOptions } from './cache.ts';
import { Catalog } from './catalog.ts';
import { checkTexts, expandSchemas } from './inputs.ts';
import { openKnowledge, type Knowledge, type KnowledgeOptions } from './knowledge.ts';
import { Router } from './router.ts';
import { loadSpecs, SpecError } from './spec.ts';
import { listWorlds, worldPath, WorldStore } from './store.ts';
import { World, type WorldEvent } from './synth.ts';
import { Checks } from './validate.ts';

// ---------------------------------------------------------------------------
// Assembly
//
// The order here is the whole point and it is the same order `zen run` uses:
// credentials before anything that needs one, then the documents, then the
// story, and the world last because its file is named after the story — so the
// failure a user sees is the first thing that was actually wrong rather than
// whatever happened to be checked first.
// ---------------------------------------------------------------------------

/**
 * The model each provider gets when none is named — the same picks `zen meta`
 * recommends (`RECOMMENDED` in `packages/meta/src/model.ts`). Every ref names its
 * provider: the shorthand reads the first segment as a *provider name*, so a
 * bare `gemini-3.8-flash` would be asked of OpenAI.
 *
 * Gym's agents call tools, and OpenAI's reasoning models take tools only over
 * the Responses API, so that is the one named.
 */
const DEFAULT_MODEL: Record<Provider, string> = {
    openai: 'openai/responses:gpt-5.6-sol',
    anthropic: 'anthropic:claude-opus-5',
    google: 'google:gemini-3.8-flash',
    vertex: 'vertex:gemini-3.8-flash',
    openrouter: 'openrouter:anthropic/claude-opus-5',
};

// ---------------------------------------------------------------------------
// Which model, and why that one
//
// The same chain `zen meta` uses: a flag beats the environment, the environment
// beats what was stored, and with none of them set it is whatever the keys on
// hand can buy. Which model writes handlers is a choice about a tool on this
// machine and not about a document, so it is stored beside the keyring rather
// than anywhere near a specification.
// ---------------------------------------------------------------------------

/** The variable a shell or a CI job names it with — a zen ref. */
export const MODEL_ENV = 'ZENERA_GYM_MODEL';

export type ModelSource = 'flag' | 'env' | 'store' | 'default';

export const SOURCE_LABELS: Record<ModelSource, string> = {
    flag: '--model',
    env: MODEL_ENV,
    store: 'zen gym model',
    default: 'recommended',
};

export interface ModelChoice {
    ref: string;
    from: ModelSource;
}

export interface GymFile {
    version: 1;
    model?: string;
    /** an embedding ref, or `none` */
    embedding?: string;
}

const EMPTY: GymFile = { version: 1 };

const settingsPath = (): string => join(home(), 'gym.json');

export const readSettings = (): Promise<GymFile> => readJson<GymFile>(settingsPath(), EMPTY);

export function writeSettings(file: GymFile): void {
    ensureHome();
    writeJson(settingsPath(), file);
}

/** What `open` would run, and where it came from, so a command can say so too. */
export async function chooseModel(
    flag: string | undefined,
    keys: KeyStore,
): Promise<ModelChoice | undefined> {
    const chain: readonly [ModelSource, string | undefined][] = [
        ['flag', flag],
        ['env', process.env[MODEL_ENV]],
        ['store', (await readSettings()).model],
        ['default', defaultRef(keys)],
    ];
    for (const [from, ref] of chain) {
        const named = ref?.trim();
        if (named) {
            return { ref: named, from };
        }
    }
    return undefined;
}

/** The variable that names the embedding model, or `none`. */
export const EMBEDDING_ENV = 'ZENERA_GYM_EMBEDDING';

export interface EmbeddingChoice {
    /** undefined: no embedding, search by wording only */
    ref?: string;
    from: ModelSource | 'none';
}

/** `--embedding` values that ask for whichever model is configured. */
const EMBEDDING_ON = new Set(['on', 'default']);
/** `--embedding` values that keep it off, which is also what no flag means. */
const EMBEDDING_OFF = new Set(['', 'off', 'none']);

/**
 * Which model embeds the docs, if any. Off unless the flag asks: a ref names
 * the model outright; `on` (or `default`) takes the configured one — the
 * variable, then the stored setting, then the first keyed provider that offers
 * one. The variable and the setting only answer that question; on their own
 * they turn nothing on.
 */
export async function chooseEmbedding(
    flag: string | undefined,
    keys: KeyStore,
): Promise<EmbeddingChoice> {
    const asked = flag?.trim().toLowerCase() ?? '';
    if (EMBEDDING_OFF.has(asked)) {
        return { from: 'none' };
    }
    if (!EMBEDDING_ON.has(asked)) {
        return { ref: flag!.trim(), from: 'flag' };
    }
    const configured = await configuredEmbedding(keys);
    if (configured.from === 'none') {
        throw credentialError(
            '--embedding on, but there is no embedding model to use',
            `name one with --embedding <ref>, set ${EMBEDDING_ENV}, ` +
                'or add a key for a provider that offers one: zen key add openai',
        );
    }
    return configured;
}

/** The model `--embedding on` would use; `none` at a link means off. */
export async function configuredEmbedding(keys: KeyStore): Promise<EmbeddingChoice> {
    const chain: readonly [ModelSource, string | undefined][] = [
        ['env', process.env[EMBEDDING_ENV]],
        ['store', (await readSettings()).embedding],
        ['default', defaultEmbedding(keys)],
    ];
    for (const [from, ref] of chain) {
        const named = ref?.trim();
        if (named) {
            return EMBEDDING_OFF.has(named.toLowerCase()) ? { from } : { ref: named, from };
        }
    }
    return { from: 'none' };
}

export interface SetupOptions {
    /** API documents: files, directories or patterns */
    schemas: readonly string[];
    /** the story of the world: files, directories or patterns */
    story?: readonly string[];
    /** reference material: files, directories or patterns */
    docs?: readonly string[];
    cwd: string;
    /** where handlers, worlds, indexes and reports live */
    cache?: string;
    model?: string;
    /** an embedding ref, or `none` */
    embedding?: string;
    /** a world name, or a path to its file; derived from the story when unset */
    world?: string;
    /** start from an empty world */
    reset?: boolean;
    attempts?: number;
    /** how many handlers may be written at once */
    concurrency?: number;
    rebuild?: boolean;
    ephemeral?: boolean;
    timeout?: number;
    events?: Pick<CacheOptions, 'onStart' | 'onAttempt' | 'onReady' | 'onFail'>;
    onWorld?: (event: WorldEvent) => void;
    onWarn?: (message: string) => void;
    onIndexing?: KnowledgeOptions['onProgress'];
}

export interface Setup {
    router: Router;
    checks: Checks;
    cache: Cache;
    box: Box;
    model: Model;
    choice: ModelChoice;
    catalog: Catalog;
    knowledge: Knowledge;
    embedding: EmbeddingChoice;
    /** the API documents served, absolute */
    files: string[];
    world: World;
    /** the world's SQLite file */
    worldFile: string;
    root: string;
    close(): Promise<void>;
}

export async function open(opts: SetupOptions): Promise<Setup> {
    const story = opts.story ?? [];
    const docsArgs = opts.docs ?? [];
    if (opts.schemas.length === 0) {
        throw invalidError(
            'no API document given',
            'name OpenAPI/Swagger files, directories or patterns, e.g. zen gym serve api/',
        );
    }

    // Real environment variables win, exactly as they do for `zen`.
    ensureHome();
    const keys = await KeyStore.open();
    keys.materialize();
    const choice = await chooseModel(opts.model, keys);
    if (!choice) {
        throw credentialError(
            'no credentials for any provider',
            'add one with: zen key add openai',
        );
    }
    const model = createModel(choice.ref);

    const root = resolve(opts.cwd, opts.cache ?? paths.gym());
    mkdirSync(root, { recursive: true, mode: 0o700 });

    const files = await expandSchemas(opts.schemas, opts.cwd);
    await checkTexts(story, opts.cwd, '--story');
    await checkTexts(docsArgs, opts.cwd, '--docs');

    const operations = await loadSpecs(files);
    if (operations.length === 0) {
        throw invalidError('the API documents declare no operations');
    }
    const router = new Router(operations);
    const checks = new Checks();
    const catalog = await Catalog.open(files);

    // Everything is indexed before anything is served: no request ever waits
    // on, or works around, an index that is still being built.
    const embedding =
        docsArgs.length > 0
            ? await chooseEmbedding(opts.embedding, keys)
            : { from: 'none' as const };
    const knowledge = await openKnowledge({
        story,
        docs: docsArgs,
        cwd: opts.cwd,
        root,
        embedding: embedding.ref
            ? { ref: embedding.ref, embedder: createEmbedder(embedding.ref as EmbeddingRef) }
            : undefined,
        onWarn: opts.onWarn,
        onProgress: opts.onIndexing,
    });

    const worldFile = worldPath({
        root,
        cwd: opts.cwd,
        world: opts.world,
        storyDigest: knowledge.storyDigest || undefined,
    });
    if (!opts.world && knowledge.storyDigest && !existsSync(worldFile)) {
        const earlier = listWorlds(root).find((w) => w.name.startsWith('story-'));
        if (earlier) {
            opts.onWarn?.(
                `a new story, so a new world: ${worldFile}. The last one used is ${earlier.path}; ` +
                    'name a world with --world to keep one across story edits',
            );
        }
    }
    const store = new WorldStore(worldFile);
    if (opts.reset) {
        store.reset();
    }
    const bindings = new Bindings(Object.keys(catalog.types), { ephemeral: opts.ephemeral });
    const world = new World({
        model,
        knowledge,
        catalog,
        bindings,
        store,
        reportDir: join(root, 'reports'),
        onMade: opts.onWorld,
    });
    const box = new Box({
        root,
        db: store.path,
        timeout: opts.timeout,
        synthesize: world.synthesize,
        bindings: () => bindings.all(),
    });
    const cache = new Cache({
        box,
        checks,
        model,
        catalog,
        world,
        bindings,
        operations,
        attempts: opts.attempts,
        concurrency: opts.concurrency,
        rebuild: opts.rebuild,
        ephemeral: opts.ephemeral,
        ...opts.events,
    });

    return {
        router,
        checks,
        cache,
        box,
        model,
        choice,
        catalog,
        knowledge,
        embedding,
        files,
        world,
        worldFile,
        root,
        close: async () => {
            await box.dispose();
            world.close();
            store.close();
            knowledge.close();
        },
    };
}

/**
 * Presence, not liveness. `zen init` probes because it is writing a project
 * that has to work later; this is about to make a call anyway, and the call
 * itself is a better test than a round trip that costs the same.
 */
function defaultRef(keys: KeyStore): string | undefined {
    const provider =
        PROVIDERS.find((p) => envNames(p).some((name) => process.env[name])) ??
        PROVIDERS.find((p) => keys.active(p) !== undefined);
    return provider ? DEFAULT_MODEL[provider] : undefined;
}

/** The first keyed provider, in preference order, with a curated embedding model. */
function defaultEmbedding(keys: KeyStore): string | undefined {
    const keyed = PROVIDERS.filter(
        (p) => envNames(p).some((name) => process.env[name]) || keys.active(p) !== undefined,
    );
    for (const provider of keyed) {
        const model = CURATED[provider].find((m) => m.roles.includes('embedding'));
        if (model) {
            return `${provider}:${model.id}`;
        }
    }
    return undefined;
}

export { SpecError };
