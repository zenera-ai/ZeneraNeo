// ---------------------------------------------------------------------------
// zen models
//
// What this machine *can* use, as opposed to whether one particular project
// works. `zen check` answers the second question — it resolves a project,
// audits its credentials and asks every model it declares one real question.
// This command answers the first, and needs no project at all.
//
// The split matters most when something breaks. `zen check` says "this
// embedder was refused"; `zen models ls --embeddings` and `zen models test`
// find one that answers, as a ref that can be pasted straight back into
// agents.yaml.
// ---------------------------------------------------------------------------

import { createEmbedder, GATEWAY_NAME, gatewayOf, ModelRegistry, type Gateway } from '@zenera/neo';

import {
    ensureHome,
    envNames,
    form,
    isProvider,
    KeyStore,
    PROVIDERS,
    type Provider,
} from '@zenera/engine';
import { parse } from '../args.ts';
import {
    byGroup,
    groupOf,
    isPartner,
    loadCatalog,
    loadCatalogs,
    matches,
    routerBalance,
    sampleByProvider,
    type Catalog,
    type CatalogEntry,
    type Filters,
    type Role,
} from '../catalog.ts';
import type { Command, Context } from '../command.ts';
import { probeChat, probeModel, type ModelProbe, type ModelTarget } from '../liveness.ts';
import { catalogRef } from '../modelref.ts';
import { compareModels } from '../rank.ts';
import {
    ago,
    bold,
    CliError,
    credentialError,
    cut,
    cyan,
    dim,
    EXIT,
    green,
    isInteractive,
    json,
    note,
    plain,
    progress,
    red,
    table,
    usageError,
    write,
    writeAll,
    yellow,
} from '../term.ts';

const USAGE = 'zen models <providers|ls|search|show|test|browse> [ref] [options]';

type Sub = (ctx: Context, args: readonly string[]) => Promise<void>;

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

interface Credentialed {
    store: KeyStore;
    /** providers whose variable was already set in the real environment */
    fromEnv: Set<Provider>;
    /** providers this machine can actually reach, environment first */
    usable: Provider[];
    /** set in a gateway mode: every provider is reached, and listed, through it */
    gateway?: Gateway;
}

/**
 * The keyring is materialised here, and only here.
 *
 * The frame does not do it, so every command that needs a credential asks for
 * one itself. Forgetting looks exactly like a missing key, which is the most
 * expensive kind of bug this file could have.
 */
async function credentials(): Promise<Credentialed> {
    ensureHome();
    const store = await KeyStore.open();
    // Asked before materialising, because materialising is what erases the
    // difference between "the environment had it" and "the keyring supplied it".
    const fromEnv = new Set(PROVIDERS.filter((p) => envNames(p).some((n) => process.env[n])));
    store.materialize();
    const gateway = gatewayOf();
    if (gateway) {
        return { store, fromEnv, usable: [...PROVIDERS], gateway };
    }
    const usable = [
        ...PROVIDERS.filter((p) => fromEnv.has(p)),
        ...PROVIDERS.filter((p) => !fromEnv.has(p) && Boolean(store.active(p))),
    ];
    return { store, fromEnv, usable };
}

function source(where: Credentialed, provider: Provider): string {
    if (where.gateway) {
        return GATEWAY_NAME;
    }
    if (where.fromEnv.has(provider)) {
        return 'environment';
    }
    return where.store.active(provider) ? 'keyring' : '';
}

/** The providers a subcommand should touch, given an optional `--provider`. */
function scope(where: Credentialed, only: string | undefined): Provider[] {
    if (!only) {
        if (where.usable.length === 0) {
            throw credentialError(
                'no provider on this machine has a credential',
                'try: zen key add openai',
            );
        }
        return where.usable;
    }
    if (!isProvider(only)) {
        throw usageError(`unknown provider "${only}"`, `known: ${PROVIDERS.join(', ')}`);
    }
    return [only];
}

interface RoleFlags {
    chat?: boolean;
    embedding?: boolean;
    embeddings?: boolean;
    images?: boolean;
    audio?: boolean;
}

const ROLE_OPTIONS = {
    chat: { type: 'boolean' },
    // Both spellings, because half the flags in this CLI read as a filter over
    // a set and half as a choice of one, and nobody should have to remember
    // which this is.
    embedding: { type: 'boolean' },
    embeddings: { type: 'boolean' },
    images: { type: 'boolean' },
    audio: { type: 'boolean' },
} as const;

function rolesFrom(values: RoleFlags): Role[] {
    const roles: Role[] = [];
    if (values.chat) {
        roles.push('chat');
    }
    if (values.embedding || values.embeddings) {
        roles.push('embedding');
    }
    if (values.images) {
        roles.push('image');
    }
    if (values.audio) {
        roles.push('audio');
    }
    return roles;
}

const num = (value: string | undefined, what: string): number | undefined => {
    if (value === undefined) {
        return undefined;
    }
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) {
        throw usageError(`${what} must be a number, got "${value}"`);
    }
    return n;
};

const ms = (n: number): string => (n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(1)}s`);

const tokens = (n: number | undefined): string => {
    if (n === undefined) {
        return '';
    }
    return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
};

/**
 * Said before any listing in a gateway mode, on stderr: the same command lists
 * something else entirely there, and nothing in a row of model ids shows it.
 */
function announce(ctx: Context, where: Credentialed): void {
    if (!where.gateway || ctx.json) {
        return;
    }
    note(
        `${cyan(`⇄ ${GATEWAY_NAME} mode`)} ${dim('only what')} ${where.gateway.baseURL} ` +
            dim('serves; zen key mode direct to list the vendors'),
    );
    note('');
}

/** Freshness of a listing, said the way a person would ask about it. */
function freshness(cat: Catalog): string {
    if (cat.origin === 'curated') {
        return cat.via ? yellow('not listed yet') : yellow('built-in list');
    }
    if (cat.origin === 'stale') {
        return yellow(`stale, ${ago(cat.fetchedAt)}`);
    }
    return cat.origin === 'live' ? green('fetched now') : dim(`cached ${ago(cat.fetchedAt)}`);
}

const roleMark = (row: CatalogEntry): string => row.roles.join('+');

const maker = (row: CatalogEntry): string =>
    !row.publisher ? '' : isPartner(row) ? yellow(row.publisher) : green(row.publisher);

function row(entry: CatalogEntry): string[] {
    return [
        cyan(entry.ref),
        maker(entry),
        dim(roleMark(entry)),
        dim(tokens(entry.contextLength)),
        dim(entry.pricing?.free ? 'free' : ''),
        dim(entry.name ?? ''),
    ];
}

/** Drops every column no row has anything in, so a blank one costs no gap. */
function filled(rows: readonly string[][]): string[][] {
    const keep = (rows[0] ?? []).map((_, c) => rows.some((r) => plain(r[c] ?? '') !== ''));
    return rows.map((r) => r.filter((_, c) => keep[c]));
}

/**
 * One section per provider (and per maker, where a provider resells), each
 * headed by how much of it is on screen and how fresh it is. The maker is in
 * the heading, so it is not repeated as a column. Columns line up across
 * sections, so the eye can run down them past a heading.
 */
function sections(
    shown: readonly CatalogEntry[],
    all: readonly CatalogEntry[],
    cats: readonly Catalog[],
): string[] {
    const totals = new Map<string, number>();
    for (const e of all) {
        totals.set(groupOf(e), (totals.get(groupOf(e)) ?? 0) + 1);
    }
    const counts = new Map<string, number>();
    for (const e of shown) {
        counts.set(groupOf(e), (counts.get(groupOf(e)) ?? 0) + 1);
    }
    const fresh = new Map(cats.map((c) => [c.provider, c]));
    // An empty cell stays unstyled: style codes around nothing defeat the table's trimEnd.
    const faint = (s: string): string => (s ? dim(s) : '');
    const lines = table(
        filled(
            shown.map((e) => [
                cyan(e.ref),
                faint(roleMark(e)),
                faint(tokens(e.contextLength)),
                faint(e.pricing?.free ? 'free' : ''),
                // A gateway names a model by its id, which the ref already says.
                faint(e.name && e.name !== e.id ? e.name : ''),
            ]),
        ),
    );
    const out: string[] = [];
    const headed = new Set<Provider>();
    // A wrapped row reads as two models; a piped listing keeps every character.
    const fit = (line: string): string =>
        process.stdout.isTTY && process.stdout.columns ? cut(line, process.stdout.columns) : line;
    let last: string | undefined;
    shown.forEach((e, i) => {
        const group = groupOf(e);
        if (group !== last) {
            const total = totals.get(group)!;
            const on = counts.get(group)!;
            const size = on < total ? `${on} of ${total}` : String(total);
            const cat = headed.has(e.provider) ? undefined : fresh.get(e.provider);
            headed.add(e.provider);
            out.push(
                ...(out.length > 0 ? [''] : []),
                `${bold(group)}  ${dim(size)}${cat ? `  ${freshness(cat)}` : ''}`,
            );
        }
        last = group;
        out.push(fit(`  ${lines[i]!}`));
    });
    return out;
}

/**
 * Says how a listing was obtained whenever it was not the vendor's own word —
 * on stderr, because it is narration about the answer rather than the answer.
 */
function explain(cats: readonly Catalog[]): void {
    // Through a gateway every provider shares one request, so one failure is said once.
    const said = new Set<string>();
    for (const cat of cats) {
        if (cat.problem) {
            const who = cat.via ? cat.via.name : cat.provider;
            const detail = cat.problem.detail ?? 'no reason given';
            if (said.has(`${who}\0${detail}`)) {
                continue;
            }
            said.add(`${who}\0${detail}`);
            // A gateway has no built-in list to fall back on.
            const shown = cat.via ? 'nothing listed' : `showing the ${cat.origin} list`;
            note(`${yellow(who)} could not be listed: ${detail} ` + dim(`(${shown})`));
            if (cat.problem.fix) {
                note(dim(`  ${cat.problem.fix}`));
            }
        }
    }
}

// ---------------------------------------------------------------------------
// providers
// ---------------------------------------------------------------------------

/**
 * The overview, and deliberately an offline one: five listing round trips is
 * the wrong price for the question "what have I got set up". `ls` fetches.
 */
const providers: Sub = async (ctx, args) => {
    const { values } = parse<{ refresh?: boolean }>(
        args,
        { refresh: { type: 'boolean' } },
        'zen models providers [--refresh]',
    );
    const where = await credentials();
    // A gateway lists every provider in one request, so its overview can afford to ask.
    const cats = await loadCatalogs(PROVIDERS, {
        offline: !values.refresh && !where.gateway,
        refresh: values.refresh,
    });
    const by = new Map(cats.map((c) => [c.provider, c]));

    if (ctx.json) {
        json(
            PROVIDERS.map((p) => ({
                provider: p,
                credential: source(where, p) || null,
                env: form(p).env,
                models: by.get(p)?.entries.length ?? 0,
                origin: by.get(p)?.origin,
                fetchedAt: by.get(p)?.fetchedAt,
                ...(where.gateway ? { gateway: where.gateway.baseURL } : {}),
            })),
        );
        return;
    }

    announce(ctx, where);
    writeAll(
        table(
            PROVIDERS.map((p) => {
                const cat = by.get(p)!;
                const cred = source(where, p);
                const counted = `${cat.entries.length} model${cat.entries.length === 1 ? '' : 's'}`;
                return [
                    cred ? cyan(p) : dim(p),
                    cred ? green(cred) : red('no credential'),
                    cred ? dim(counted) : dim(''),
                    cred ? freshness(cat) : dim(`zen key add ${p}`),
                ];
            }),
        ),
    );
    note('');
    note(dim('zen models ls <provider>   what one of them serves'));
    note(dim('zen models browse          walk them with the arrow keys'));
};

// ---------------------------------------------------------------------------
// ls
// ---------------------------------------------------------------------------

const ls: Sub = async (ctx, args) => {
    const { values, positionals } = parse<
        RoleFlags & { refresh?: boolean; limit?: string; all?: boolean; best?: boolean }
    >(
        args,
        {
            ...ROLE_OPTIONS,
            refresh: { type: 'boolean' },
            limit: { type: 'string' },
            all: { type: 'boolean' },
            best: { type: 'boolean' },
        },
        'zen models ls [provider] [--chat] [--embeddings] [--best] [--refresh] [--limit N] [--all]',
    );
    const where = await credentials();
    const targets = scope(where, positionals[0]);
    const roles = rolesFrom(values);
    const limit = values.all ? Infinity : (num(values.limit, '--limit') ?? 40);

    const bar = ctx.json ? undefined : progress();
    bar?.update(dim(`listing ${targets.join(', ')} …`));
    const cats = await loadCatalogs(targets, { refresh: values.refresh });
    bar?.done();

    const all = cats
        .flatMap((c) => c.entries)
        .filter((e) => matches(e, '', { roles }))
        .sort(values.best ? compareModels : byGroup);

    if (ctx.json) {
        json({
            models: all,
            sources: cats.map(({ provider, origin, fetchedAt }) => ({
                provider,
                origin,
                fetchedAt,
            })),
            ...(where.gateway ? { gateway: where.gateway.baseURL } : {}),
        });
        return;
    }
    announce(ctx, where);
    explain(cats);
    if (all.length === 0) {
        if (!cats.every((c) => c.problem)) {
            note(dim('nothing matched — try: zen models ls --refresh'));
        }
        return;
    }
    // A ranking keeps its top; a grouped listing shows some of every provider.
    const shown = values.best ? all.slice(0, limit) : sampleByProvider(all, limit);
    writeAll(values.best ? table(shown.map(row)) : sections(shown, all, cats));
    if (all.length > shown.length) {
        const one = targets.length === 1 ? targets[0] : '<provider>';
        note('');
        note(
            dim(
                `showing ${shown.length} of ${all.length} — zen models ls ${one} --all, or zen models search <words>`,
            ),
        );
    }
    if (!where.gateway && shown.some(isPartner)) {
        note(
            dim(
                'partner models are billed through Vertex and must be enabled in Model Garden first: https://console.cloud.google.com/vertex-ai/model-garden',
            ),
        );
    }
};

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

const search: Sub = async (ctx, args) => {
    type Values = RoleFlags & {
        provider?: string;
        tools?: boolean;
        vision?: boolean;
        free?: boolean;
        'min-context'?: string;
        limit?: string;
        refresh?: boolean;
        best?: boolean;
    };
    const { values, positionals } = parse<Values>(
        args,
        {
            ...ROLE_OPTIONS,
            provider: { type: 'string' },
            tools: { type: 'boolean' },
            vision: { type: 'boolean' },
            free: { type: 'boolean' },
            'min-context': { type: 'string' },
            limit: { type: 'string' },
            refresh: { type: 'boolean' },
            best: { type: 'boolean' },
        },
        'zen models search <query> [--provider p] [--embeddings] [--tools] [--vision] [--free] [--min-context N] [--best] [--limit N]',
    );
    const query = positionals.join(' ').trim();
    const where = await credentials();
    const targets = scope(where, values.provider);
    const limit = num(values.limit, '--limit') ?? 20;

    const filters: Filters = {
        roles: rolesFrom(values),
        tools: values.tools,
        vision: values.vision,
        free: values.free,
        minContext: num(values['min-context'], '--min-context'),
    };

    const bar = ctx.json ? undefined : progress();
    bar?.update(dim(`searching ${targets.join(', ')} …`));
    const cats = await loadCatalogs(targets, { refresh: values.refresh });
    bar?.done();

    const hits = cats
        .flatMap((c) => c.entries)
        .filter((e) => matches(e, query, filters))
        // Cheapest first when price is known: search is usually the step before
        // picking one, and the free ones are what most people are looking for.
        .sort(
            values.best
                ? compareModels
                : (a, b) =>
                      Number(b.pricing?.free ?? false) - Number(a.pricing?.free ?? false) ||
                      byGroup(a, b),
        );

    if (ctx.json) {
        json({ query, matched: hits.length, models: hits.slice(0, limit) });
        return;
    }
    announce(ctx, where);
    explain(cats);
    if (hits.length === 0) {
        note(dim(`nothing matched "${query}" — try fewer words, or --refresh`));
        return;
    }
    writeAll(table(hits.slice(0, limit).map(row)));
    if (hits.length > limit) {
        note(dim(`${hits.length - limit} more — raise --limit, or add a word`));
    }
    note(dim('zen models test <ref>   ask one of them whether it answers'));
};

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

/**
 * Splits a ref without building anything. `ModelRegistry.parse` is the same
 * splitter the runtime uses, so a ref that reads here reads there — and a typo
 * is a usage error rather than a credential one.
 */
function split(ref: string): { provider: Provider; id: string } {
    const registry = new ModelRegistry();
    let spec: { provider?: string; model: string };
    try {
        spec = registry.parse(ref);
    } catch (err) {
        throw usageError(
            err instanceof Error ? err.message.split('\n')[0]! : `bad reference "${ref}"`,
            'expected provider/model — see: zen models ls',
        );
    }
    const provider = spec.provider ?? registry.defaultProvider;
    if (!isProvider(provider)) {
        throw usageError(
            `"${provider}" is not a provider this command knows`,
            `known: ${PROVIDERS.join(', ')}`,
        );
    }
    // The catalog keeps Claude on Vertex under its wire id, without the publisher.
    const id =
        provider === 'vertex' ? spec.model.replace(/^anthropic\/(?=claude-)/, '') : spec.model;
    return { provider, id };
}

const show: Sub = async (ctx, args) => {
    const { values, positionals } = parse<{ refresh?: boolean }>(
        args,
        { refresh: { type: 'boolean' } },
        'zen models show <provider/model> [--refresh]',
    );
    const ref = positionals[0];
    if (!ref) {
        throw usageError('which model?', 'see: zen models ls');
    }
    const { provider, id } = split(ref);
    const where = await credentials();
    const cat = await loadCatalog(provider, { refresh: values.refresh });
    const found = cat.entries.find((e) => e.id === id);

    if (ctx.json) {
        json(found ?? { ref: catalogRef(provider, id), provider, id, known: false });
        return;
    }
    announce(ctx, where);
    explain([cat]);
    if (!found) {
        note(
            `${yellow('not listed')} ${where.gateway ? GATEWAY_NAME : provider} does not advertise ${bold(id)}`,
        );
        note(dim(`it may still work — try: zen models test ${catalogRef(provider, id)}`));
        note(dim(`or look: zen models search ${id} --provider ${provider}`));
        return;
    }
    const rows: string[][] = [
        [dim('ref'), cyan(found.ref)],
        [dim('roles'), found.roles.join(', ')],
    ];
    const add = (label: string, value: string | undefined): void => {
        if (value) {
            rows.push([dim(label), value]);
        }
    };
    add('name', found.name);
    add(
        'context',
        found.contextLength ? `${found.contextLength.toLocaleString()} tokens` : undefined,
    );
    add(
        'max output',
        found.maxOutputTokens ? `${found.maxOutputTokens.toLocaleString()} tokens` : undefined,
    );
    add('dimensions', found.dimensions ? String(found.dimensions) : undefined);
    add('input', found.modalities?.input?.join(', '));
    add('output', found.modalities?.output?.join(', '));
    add(
        'supports',
        Object.entries(found.supports ?? {})
            .filter(([, on]) => on)
            .map(([k]) => k)
            .join(', '),
    );
    add(
        'pricing',
        found.pricing?.free
            ? 'free'
            : found.pricing?.prompt
              ? `$${found.pricing.prompt}/token in, $${found.pricing.completion ?? '?'}/token out`
              : undefined,
    );
    add('released', found.created);
    add(
        'source',
        found.source !== 'live'
            ? 'built-in list'
            : cat.via
              ? `${cat.via.name} (${provider}), ${freshness(cat)}`
              : `${provider}, ${freshness(cat)}`,
    );
    writeAll(table(rows));
    if (found.description) {
        note('');
        note(dim(found.description));
    }
};

// ---------------------------------------------------------------------------
// test
// ---------------------------------------------------------------------------

/**
 * Which role to ask in. An explicit flag wins; then what the provider says the
 * model is for; then the id, which is the last resort and the only one that can
 * be wrong.
 */
async function roleOf(provider: Provider, id: string, forced: Role | undefined): Promise<Role> {
    if (forced) {
        return forced;
    }
    // Offline: this is one lookup on the way to a real call, and it must not
    // add a listing round trip to every `test`.
    const cat = await loadCatalog(provider, { offline: true });
    const known = cat.entries.find((e) => e.id === id);
    if (known?.roles.includes('embedding') && !known.roles.includes('chat')) {
        return 'embedding';
    }
    if (known?.roles.includes('chat')) {
        return 'chat';
    }
    return /embed/.test(id) ? 'embedding' : 'chat';
}

function target(ref: string, provider: Provider, id: string, role: Role): ModelTarget {
    if (role === 'embedding') {
        return { ref, kind: 'embedding', embedder: createEmbedder({ provider, model: id }) };
    }
    if (role !== 'chat') {
        throw usageError(
            `${ref} is ${role}-only, and there is no way to ask it a question from here`,
            'zen models test only exercises chat and embedding models',
        );
    }
    return { ref, kind: 'model', model: probeChat(provider, id) };
}

function verdict(probe: ModelProbe): string {
    switch (probe.check.state) {
        case 'live':
            return `${green('answers')} ${dim(ms(probe.ms))}`;
        case 'blocked':
            return yellow('blocked');
        case 'dead':
            return red('refused');
        default:
            return dim('no answer');
    }
}

/**
 * What the provider said, in the verdict's own colour. Grey is for the half of
 * the output nobody needs to read, and the one line explaining a refusal is not
 * in that half.
 */
function reason(probe: ModelProbe): string {
    const detail = probe.check.detail ?? '';
    if (detail === '' || probe.check.state === 'live') {
        return dim(detail);
    }
    return probe.check.state === 'dead' ? red(detail) : yellow(detail);
}

/**
 * Which project and region a Vertex call was actually made in. A publisher
 * model is only missing *somewhere*, and the somewhere is the part nobody
 * typed: it comes off the key, or out of the service-account file itself.
 */
function vertexAt(where: Credentialed): string {
    const entry = where.fromEnv.has('vertex') ? undefined : where.store.active('vertex');
    const id = entry ? where.store.projectOf(entry)?.id : process.env.GOOGLE_CLOUD_PROJECT;
    const location = process.env.GOOGLE_CLOUD_LOCATION ?? entry?.location ?? 'global';
    return `vertex: project ${id ?? 'unset'} · location ${location}`;
}

const test: Sub = async (ctx, args) => {
    const { values, positionals } = parse<RoleFlags>(
        args,
        ROLE_OPTIONS,
        'zen models test <provider/model> … [--chat|--embedding]',
    );
    if (positionals.length === 0) {
        throw usageError('which model?', 'see: zen models ls');
    }
    const forced = rolesFrom(values)[0];

    // Every ref is split before anything is built, so a typo in the third one
    // does not arrive after two billable calls.
    const parsed = positionals.map((ref) => ({ ref, ...split(ref) }));
    const where = await credentials();

    const probes: ModelProbe[] = [];
    const bar = ctx.json ? undefined : progress();
    for (const { ref, provider, id } of parsed) {
        bar?.update(dim(`asking ${ref} …`));
        probes.push(
            await probeModel(target(ref, provider, id, await roleOf(provider, id, forced))),
        );
    }
    bar?.done();

    if (ctx.json) {
        json(probes);
    } else {
        announce(ctx, where);
        writeAll(
            table(
                probes.map((p) => [
                    cyan(p.ref),
                    verdict(p),
                    dim(p.dimensions ? `${p.dimensions} dims` : ''),
                    reason(p),
                ]),
            ),
        );
        for (const p of probes) {
            if (p.check.fix) {
                note(`${yellow('fix')} ${bold(p.ref)} ${p.check.fix}`);
            }
        }
        // A Vertex refusal is about a model *in a project*, and the project is
        // the half of that nobody typed.
        if (!where.gateway && parsed.some((p) => p.provider === 'vertex')) {
            note(dim(vertexAt(where)));
        }
    }
    const failed = probes.filter((p) => p.check.state !== 'live');
    if (failed.length > 0) {
        // The suggestion follows what was actually asked, not what was flagged.
        const role = failed.every((p) => p.kind === 'embedding') ? '--embeddings' : '--chat';
        throw credentialError(
            `${failed.length} of ${probes.length} did not answer`,
            `see what else there is: zen models ls ${role}`,
        );
    }
};

// ---------------------------------------------------------------------------
// browse
// ---------------------------------------------------------------------------

/**
 * The same catalog, walked with the arrow keys: providers, what one serves,
 * one model in full, with a key to ask it a question and a key to take it.
 *
 * The interface is drawn on stderr, so a pick reaches stdout alone and
 * `$(zen models browse)` is the ref.
 */
const browse: Sub = async (ctx, args) => {
    const { values, positionals } = parse<{ refresh?: boolean; theme?: string }>(
        args,
        { refresh: { type: 'boolean' }, theme: { type: 'string' } },
        'zen models browse [provider] [--refresh] [--theme dark|light|auto]',
    );
    const initial = positionals[0];
    if (initial !== undefined && !isProvider(initial)) {
        throw usageError(`unknown provider "${initial}"`, `known: ${PROVIDERS.join(', ')}`);
    }
    if (ctx.json || !isInteractive()) {
        throw usageError(
            'browsing needs a person at a terminal',
            'from a script: zen models ls --json',
        );
    }

    const chosen = await browseModels({
        initial,
        theme: values.theme,
        refresh: values.refresh,
    });

    if (!chosen) {
        // Leaving is a fine way to end a browse, but not an answer to a
        // substitution that was waiting for one.
        if (!process.stdout.isTTY) {
            throw new CliError('nothing picked', EXIT.failed);
        }
        return;
    }
    write(chosen.ref);
};

export interface BrowseRequest {
    /** opens straight into this provider's listing */
    initial?: Provider;
    /** the role filter each listing opens on; tab still cycles */
    role?: Role;
    refresh?: boolean;
    theme?: string;
}

/** The browser, for any command that wants a person to pick a model. */
export async function browseModels(request: BrowseRequest = {}): Promise<CatalogEntry | undefined> {
    const where = await credentials();
    // Offline, like `providers`: the overview should not cost five listings.
    // A provider is fetched when it is opened.
    const cats = await loadCatalogs(PROVIDERS, { offline: !where.gateway });
    const { browse: draw } = await import('../tui/models.tsx');
    return await draw({
        providers: cats.map((c) => ({
            provider: c.provider,
            credential: source(where, c.provider),
            models: c.entries.length,
            origin: c.origin,
            fetchedAt: c.fetchedAt,
        })),
        initial: request.initial,
        role: request.role,
        theme: request.theme,
        ...(where.gateway ? { gateway: { name: GATEWAY_NAME, url: where.gateway.baseURL } } : {}),
        load: (provider, refresh) => loadCatalog(provider, { refresh: refresh || request.refresh }),
        balance: async (provider) =>
            provider === 'openrouter' && !where.gateway && source(where, provider)
                ? routerBalance()
                : undefined,
        test: async (entry) => {
            const role: Role = entry.roles.includes('chat')
                ? 'chat'
                : entry.roles.includes('embedding')
                  ? 'embedding'
                  : (entry.roles[0] ?? 'chat');
            const probe = await probeModel(target(entry.ref, entry.provider, entry.id, role));
            return {
                state: probe.check.state,
                ms: probe.ms,
                detail: probe.check.detail,
                fix: probe.check.fix,
                dimensions: probe.dimensions,
            };
        },
    });
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const SUBS: Record<string, Sub> = {
    providers,
    ls,
    list: ls,
    search: search,
    find: search,
    show: show,
    test,
    check: test,
    browse,
    ui: browse,
};

export const models: Command = {
    summary: 'What this machine can use: list, search, test and browse models.',
    usage: USAGE,
    banner: { head: 'Zenera', accent: 'Models', subtitle: 'Model Catalog', hue: 'dusk' },
    details: [
        'Answers "what can I use", using the credentials already on this',
        'machine. `zen check` answers the other question — whether one',
        'particular project works — and needs a project to do it.',
        '',
        'Listings come from the providers themselves and are cached for a day',
        'in ~/.zenera/neo/catalog. When a provider cannot be asked, the last',
        'listing is used and said to be stale; only if there was never one does',
        'a short built-in list stand in.',
        '',
        '  zen models                       Providers, credentials and counts.',
        '  zen models <provider>            Short for `ls <provider>`.',
        '  zen models ls [provider]         Everything it serves.',
        '  zen models search <query>        Narrow it — --tools, --vision, --free.',
        '  zen models show <ref>            One model, in full.',
        '  zen models test <ref> …          Ask it one real question.',
        '  zen models browse [provider]     Walk providers and models with the',
        '                                   arrow keys; t asks one, p prints its ref.',
        '',
        'Listings are grouped by provider, best model first in each. `ls --best`',
        'and `search --best` drop the groups for one list, best first: Anthropic,',
        'OpenAI, Google, then the rest; newer generations and higher tiers ahead;',
        'mini, nano, lite and haiku last. A heuristic read off the ids, not a benchmark.',
    ],
    run: async (ctx) => {
        const [name, ...rest] = ctx.args;
        if (!name) {
            await providers(ctx, []);
            return;
        }
        const sub = SUBS[name];
        if (sub) {
            await sub(ctx, rest);
            return;
        }
        // `zen models openai` is the thing people type, and it means `ls`.
        // Safe because no provider is named after a subcommand.
        if (isProvider(name)) {
            await ls(ctx, ctx.args);
            return;
        }
        throw usageError(
            `unknown: zen models ${name}`,
            `try: ${cyan('providers, ls, search, show, test, browse')} — or a provider: ${dim(PROVIDERS.join(', '))}`,
        );
    },
};
