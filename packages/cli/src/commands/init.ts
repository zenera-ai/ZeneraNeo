import {
    ensureHome,
    envNames,
    isProjectDir,
    isProvider,
    keyId,
    KeyStore,
    PROVIDERS,
    Registry,
    resolveBuild,
    type Provider,
} from '@zenera/engine';
import { readProjectConfig } from '@zenera/neo';
import { existsSync, readdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { one, parse } from '../args.ts';
import { PREFERRED } from '../catalog.ts';
import type { Command } from '../command.ts';
import { probeAll } from '../liveness.ts';
import { ensurePodmanReady } from '../podman.ts';
import { scaffold } from '../scaffold.ts';
import {
    bold,
    cyan,
    dim,
    green,
    json,
    note,
    progress,
    usageError,
    write,
    yellow,
} from '../term.ts';

const USAGE = 'zen init [dir] [--name <name>] [--model <ref>] [--force]';

interface Flags {
    name?: string;
    model?: string;
    force?: boolean;
}

interface ModelChoice {
    ref: string;
    /** extra lines for the scaffolded model configuration */
    options?: string;
}

/**
 * The model each provider gets scaffolded with, when it is the one chosen.
 *
 * Every ref names its provider. A bare id is not a vendor hint — the shorthand
 * reads the first segment as a *provider name*, so an unprefixed
 * `gemini-3.5-flash` resolves to the default provider and the project asks
 * OpenAI for a Google model.
 *
 * Only OpenAI carries options, because it is the only vendor whose reasoning is
 * silent unless asked for: Gemini's `includeThoughts` is on by default and
 * Anthropic streams nothing to summarise. Without them a gpt-5 project sits
 * there showing no progress while the model thinks, which reads as a hang.
 */
const DEFAULT_MODEL: Record<Provider, ModelChoice> = {
    openai: {
        ref: 'openai:gpt-5.4-mini',
        options: [
            '# Reasoning and tools only meet on the responses API — chat',
            '# completions, which is the default, rejects the two together.',
            'api: responses',
            '# gpt-5 models reason whether or not you ask. `reasoningSummary` is',
            '# what makes that visible while it happens; drop it for silence, or',
            '# lower the effort for shorter, cheaper turns.',
            'reasoningEffort: medium',
            'reasoningSummary: auto',
        ].join('\n'),
    },
    anthropic: { ref: 'anthropic:claude-sonnet-4-5' },
    google: { ref: 'google:gemini-3.5-flash' },
    vertex: { ref: 'vertex:gemini-3.5-flash' },
    openrouter: { ref: 'openrouter:inclusionai/ling-3.0-flash-fin:free' },
};

/**
 * What vectorises the project's memory, given the provider it ends up on.
 *
 * Taken from the catalogue's `PREFERRED` table rather than written out
 * again here, so the scaffold cannot drift from what the catalogue calls
 * current. Anthropic publishes no embeddings API, and a `--model` naming a
 * provider we do not ship gives nothing to guess from; both scaffold without
 * one, and memory still works by ranking recall on term overlap. An
 * `embeddings:` entry pointing at a provider that has none is not a degraded
 * project, it is one that fails to load.
 */
function defaultEmbedding(provider: Provider | undefined): string | undefined {
    if (provider === undefined) {
        return undefined;
    }
    const id = PREFERRED[provider].embedding[0];
    return id === undefined ? undefined : `${provider}:${id}`;
}

/**
 * The provider a model ref names, when it names one we know.
 *
 * Every ref the scaffold writes carries its provider, so this is how the
 * memory store ends up on the same credential as the chat model — including
 * for an explicit `--model`, where nothing else says which vendor was meant.
 */
function providerOf(ref: string): Provider | undefined {
    const colon = ref.indexOf(':');
    const head = colon < 0 ? '' : ref.slice(0, colon);
    return isProvider(head) ? head : undefined;
}

/**
 * The provider this machine can actually reach.
 *
 * Holding a key is not the same as holding a working one, so stored
 * credentials are asked rather than counted: guessing OpenAI when only a
 * revoked OpenAI key exists produces a project that scaffolds cleanly and
 * fails on its first run, which is the worst possible moment to find out. A
 * key that came from the environment is taken at its word — the user set it
 * deliberately, and there is no entry to record a verdict against.
 *
 * `dead` is a verdict; `unknown` only means the provider could not be asked, so
 * it is still worth scaffolding around rather than refusing to choose because
 * the wifi is down.
 */
async function reachableProvider(store: KeyStore): Promise<Provider | undefined> {
    const fromEnv = PROVIDERS.find((p) => envNames(p).some((name) => process.env[name]));
    if (fromEnv) {
        return fromEnv;
    }

    const active = PROVIDERS.map((p) => store.active(p)).filter((e) => e !== undefined);
    if (active.length === 0) {
        return undefined;
    }

    const bar = progress();
    bar.update(dim(`checking ${active.length} key${active.length === 1 ? '' : 's'} …`));
    const checks = await probeAll(store, active, (entry, done, total) =>
        bar.update(dim(`checked ${keyId(entry)} … ${done}/${total}`)),
    );
    bar.done();
    for (const [entry, check] of checks) {
        store.record(entry, check);
    }
    store.save();

    const chosen =
        checks.find(([, c]) => c.state === 'live') ?? checks.find(([, c]) => c.state === 'unknown');
    // `active` was built from PROVIDERS, so this only ever holds a model
    // provider; the guard says so to the type system rather than a cast
    // asserting it, which would survive `SERVICES` growing into this list.
    const provider = chosen?.[0].provider;
    return provider !== undefined && isProvider(provider) ? provider : undefined;
}

/**
 * Whether this machine can reach the web tools.
 *
 * Presence, not liveness: unlike the model, nothing about the project depends
 * on the key working — an agent with a dead Exa key is an agent one tool call
 * poorer, not one that cannot run — so it is not worth a round trip during
 * `init`.
 */
function hasExa(store: KeyStore): boolean {
    return envNames('exa').some((name) => process.env[name]) || store.active('exa') !== undefined;
}

export const init: Command = {
    summary: 'Create a project here, or in <dir>, and register it.',
    usage: USAGE,
    banner: { head: 'Zenera', accent: 'Init', subtitle: 'Project Scaffolding', hue: 'rose' },
    details: [
        'Writes SPECIFICATION.md, agents.yaml, agents/ (house rules, the memory',
        'rules and one role prompt) and scripts/, then records the directory so',
        '`zen list` and `zen open` can find it by name. Editor files',
        '(.vscode/ and the .github/ tree) are written alongside,',
        'replacing any already there.',
        '',
        'A directory that is already a project is adopted rather than rebuilt:',
        'it is registered under its own name, and nothing in it is touched.',
        'That is how a project someone else wrote becomes a name on this',
        'machine after a clone.',
        '',
        'SPECIFICATION.md states what the project is for and what it may do,',
        'and describes the one that was just written. Say what you are building',
        'there, then run /spec-sync-project in your editor to make the rest match.',
        '',
        'The default agent gets the file tools and a sandboxed shell, plus',
        '`exa:*` when the keyring holds an Exa key. It keeps a memory of its',
        'own work in memory/, vectorised by the same provider as the model',
        'when that provider publishes embeddings. Without --model, the',
        'keyring is checked and the model is picked from a credential the',
        'provider accepts.',
        '',
        'The sandbox image is built here too, so the first run does not have',
        'to. A machine without a container engine is told, and carries on.',
    ],
    run: async (ctx) => {
        const { values, positionals } = parse<Flags>(
            ctx.args,
            {
                name: { type: 'string' },
                model: { type: 'string' },
                force: { type: 'boolean' },
            },
            USAGE,
        );

        const dir = resolve(ctx.cwd, one(positionals, 'directory', USAGE) ?? '.');
        const name = values.name ?? basename(dir);

        if (isProjectDir(dir)) {
            await adopt(dir, values, ctx.json);
            return;
        }
        if (existsSync(dir) && readdirSync(dir).length > 0 && !values.force) {
            throw usageError(`${dir} is not empty`, 'pass --force to write into it anyway');
        }

        ensureHome();
        const store = await KeyStore.open();
        const provider = values.model ? undefined : await reachableProvider(store);
        // An explicit --model is taken as written, options and all: guessing at
        // knobs for a model nobody here has heard of is how a scaffold breaks.
        const choice: ModelChoice = values.model
            ? { ref: values.model }
            : DEFAULT_MODEL[provider ?? 'openai'];
        const model = choice.ref;
        const web = hasExa(store);
        const embedding = defaultEmbedding(providerOf(model));
        const written = scaffold({ dir, model, modelOptions: choice.options, web, embedding });

        const registry = await Registry.open();
        registry.add(name, dir);
        registry.save();

        if (!ctx.json) {
            note(`${green('created')} ${bold(name)} ${dim(dir)}`);
            for (const file of written.files.filter((f) => !f.startsWith('.'))) {
                note(`  ${dim(file)}`);
            }
            note();
        }

        const sandbox = await prepareSandbox(dir, ctx.json);

        if (ctx.json) {
            json({
                name,
                path: dir,
                model,
                files: written.files,
                editor: written.editor,
                credential: provider ?? null,
                web,
                sandbox,
            });
            return;
        }

        if (web) {
            note(`${green('exa key found')} ${dim('— the default agent gets web search')}`);
            note();
        }
        // Said once, here, rather than left for the first run to discover: the
        // project names a model, and nothing on this machine can pay for it.
        if (!values.model && !provider) {
            note(`${yellow('no working key')} ${dim(`— ${model} will not run yet`)}`);
            note(`  ${cyan('zen key add openai')} ${dim('(or anthropic, google, vertex)')}`);
            note();
        }
        note(`Next: ${cyan(`cd ${dir}`)} then ${cyan('zen run')}`);
        write(dir);
    },
};

/**
 * Takes a directory that is already a project into the registry.
 *
 * The registry lives in `$HOME`, so a project that arrives by clone, copy or
 * `mv` is a working project that no name resolves to — and the only thing
 * missing is the entry. Scaffolding over it would be the wrong repair: the
 * files are somebody's work, and this writes none of them.
 *
 * Idempotent, because the honest answer to `zen init` in a project that is
 * already listed is "it is", not an error.
 */
async function adopt(dir: string, values: Flags, quiet: boolean): Promise<void> {
    ensureHome();
    const registry = await Registry.open();
    const listed = registry.findPath(dir);
    const name = values.name ?? listed?.name ?? basename(dir);
    const renamed = listed !== undefined && listed.name !== name;
    registry.add(name, dir);
    registry.save();

    const sandbox = await prepareSandbox(dir, quiet);

    if (quiet) {
        json({ name, path: dir, adopted: true, listed: listed !== undefined, sandbox });
        return;
    }
    const what =
        listed === undefined
            ? green('registered')
            : renamed
              ? green('renamed')
              : dim('already registered');
    note(`${what} ${bold(name)} ${dim(dir)}`);
    // Nothing here was scaffolded, so the flags that shape a scaffold did not apply.
    if (values.model) {
        note(
            `${yellow('--model ignored')} ${dim('— the model this project uses is in agents.yaml')}`,
        );
    }
    note();
    note(`Next: ${cyan(`cd ${dir}`)} then ${cyan('zen check')}`);
    write(dir);
}

/**
 * Builds the sandbox image the project was just given, here rather than on the
 * first run.
 *
 * It has to happen once either way, and the two moments are not equally good:
 * a build during `init` is a command that is visibly setting a project up,
 * while the same minutes during `zen run` land in the middle of a question
 * somebody asked and read as a hung model.
 *
 * Never fatal. A machine with no container engine has a perfectly good project
 * on it — one whose agent cannot start a shell yet — and refusing to finish
 * `init` over that would throw away everything already written.
 */
async function prepareSandbox(dir: string, quiet: boolean): Promise<boolean> {
    let image: string | undefined;
    try {
        const { root, config } = readProjectConfig(dir);
        const build = resolveBuild(root, config.sandbox);
        image = build?.tag ?? config.sandbox?.image;
        if (!build && !image) {
            return false;
        }
        // Nothing to answer: `init` is not the place to be asked whether to
        // install a package manager's worth of software.
        await ensurePodmanReady({ image, build, yes: true });
        if (!quiet) {
            note(`${green('sandbox ready')} ${dim(image ?? '')}`);
            note();
        }
        return true;
    } catch (err) {
        if (!quiet) {
            const why = err instanceof Error ? err.message : String(err);
            note(`${yellow('sandbox not ready')} ${dim(`— ${why}`)}`);
            note(`  ${cyan('zen sandbox up')} ${dim('— or the first run will try again')}`);
            note();
        }
        return false;
    }
}
