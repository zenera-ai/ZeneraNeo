import {
    ambient,
    ambientId,
    assertNotEmpty,
    checkRegion,
    describe,
    ensureHome,
    envNames,
    envOf,
    formOf,
    GATEWAYS,
    isGateway,
    keyId,
    KeyStore,
    mask,
    MODES,
    OWNERS,
    parseRef,
    SHAPES,
    type Ambient,
    type GatewayOwner,
    type KeyCheck,
    type KeyEntry,
    type KeyMode,
    type KeyOwner,
    type Liveness,
} from '@zenera/engine';
import { GATEWAY_URL_ENV } from '@zenera/neo';
import { existsSync } from 'node:fs';
import { parse } from '../args.ts';
import type { Command, Context } from '../command.ts';
import { probe, probeAll } from '../liveness.ts';
import {
    ago,
    ask,
    askSecret,
    badge,
    bold,
    confirm,
    credentialError,
    cyan,
    dim,
    green,
    isInteractive,
    json,
    note,
    progress,
    readStdin,
    red,
    table,
    usageError,
    warn,
    write,
    writeAll,
    yellow,
} from '../term.ts';

const USAGE = 'zen key <ls|add|use|mode|check|rm|show|env> [ref] [options]';

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

const MARK: Record<Liveness, string> = {
    live: green('live'),
    dead: red('dead'),
    blocked: yellow('blocked'),
    unknown: dim('unknown'),
};

function state(entry: KeyEntry): string {
    return entry.check ? MARK[entry.check.state] : dim('unchecked');
}

/** Where a Vertex project id came from, since only one of the three was typed. */
const ORIGIN: Record<'env' | 'stored' | 'file', string> = {
    env: 'from $GOOGLE_CLOUD_PROJECT',
    stored: 'from --gcp-project',
    file: 'from the key file',
};

/**
 * Only a Vertex service account addresses a project and a region. An unset
 * region is shown as the `global` it will actually be, not left blank: it is
 * the slow endpoint, and a blank column is how it goes unnoticed. The project
 * is shown whether or not one was stored, because the file names one too and a
 * blank there reads as "none" rather than "not written down here". Yellow when
 * the environment supplied either, because then the stored one is not in play.
 */
function placed(store: KeyStore, entry: KeyEntry): string {
    if (entry.url) {
        return dim(entry.url);
    }
    if (entry.provider !== 'vertex' || entry.holds !== 'file') {
        return '';
    }
    const fromEnv = process.env.GOOGLE_CLOUD_LOCATION;
    const where = fromEnv ?? entry.location ?? 'global';
    const project = store.projectOf(entry);
    const id = project ? project.id : '';
    return [fromEnv ? yellow(where) : dim(where), project?.from === 'env' ? yellow(id) : dim(id)]
        .join(' ')
        .trimEnd();
}

/**
 * An ambient credential borrowed into the shape the rest of this file works
 * in. It is not in the store and never will be: `store.find` misses it, so
 * `store.record` drops its check and nothing is written to disk. That is the
 * intent — it can be listed and probed, not chosen or forgotten.
 */
function asEntry(cred: Ambient): KeyEntry {
    const url = isGateway(cred.provider) ? envUrl() : undefined;
    return {
        provider: cred.provider,
        name: cred.env ? `$${cred.env}` : 'adc',
        holds: cred.holds,
        value: cred.value,
        env: cred.env,
        ...(url ? { url } : {}),
        addedAt: new Date().toISOString(),
    };
}

const envUrl = (): string | undefined => process.env[GATEWAY_URL_ENV]?.trim() || undefined;

/** Where a gateway mode sends runs, and with which key: the environment beats the keyring. */
function route(store: KeyStore, mode: GatewayOwner): { url?: string; key?: string } {
    const entry = store.active(mode);
    const shell = envNames(mode).find((name) => process.env[name]);
    return {
        url: envUrl() ?? entry?.url,
        key: shell ? `$${shell}` : entry ? keyId(entry) : undefined,
    };
}

const FROM_ENV = `set by $${GATEWAY_URL_ENV} in the environment`;

function rows(store: KeyStore, borrowed: readonly [Ambient, KeyEntry][]): string[] {
    const out: string[][] = [
        [bold(''), bold('KEY'), bold('VALUE'), bold('WHERE'), bold('STATE'), bold('CHECKED')],
    ];
    for (const provider of OWNERS) {
        // Held but not in play under the current mode: drawn grey, so the live set stands out.
        const idle = unused(store, provider);
        for (const entry of store.for(provider)) {
            const shadow = envNames(provider).find((name) => process.env[name]);
            if (idle) {
                out.push([
                    dim('-'),
                    dim(keyId(entry)),
                    dim(describe(store, entry)),
                    dim(entry.url ?? ''),
                    dim(entry.check?.state ?? 'unchecked'),
                    dim(`not used in ${store.mode} mode`),
                ]);
                continue;
            }
            const gateway = isGateway(provider);
            out.push([
                store.isActive(entry) ? green('*') : ' ',
                gateway && store.isActive(entry) ? bold(cyan(keyId(entry))) : keyId(entry),
                dim(describe(store, entry)),
                placed(store, entry),
                state(entry),
                dim(entry.check ? ago(entry.check.at) : '—') +
                    (shadow && store.isActive(entry) ? yellow(`  shadowed by $${shadow}`) : ''),
            ]);
        }
        for (const [cred, entry] of borrowed.filter(([c]) => c.provider === provider)) {
            out.push([
                dim(idle ? '-' : '~'),
                dim(ambientId(cred)),
                dim(describe(store, entry)),
                idle ? '' : placed(store, entry),
                idle ? dim(entry.check?.state ?? 'unchecked') : state(entry),
                dim(
                    idle
                        ? `not used in ${store.mode} mode`
                        : cred.env
                          ? 'from the environment'
                          : 'from gcloud',
                ),
            ]);
        }
    }
    return table(out);
}

/** A vendor key under a gateway mode, or a gateway key under any other. */
function unused(store: KeyStore, provider: KeyOwner): boolean {
    if (isGateway(provider)) {
        return store.mode !== provider;
    }
    return SHAPES[provider].kind === 'model' && store.mode !== 'direct';
}

/**
 * Above the table, because it decides which half of the table matters. Said
 * only once a gateway key exists: before that there is no choice to report.
 */
function modeLine(store: KeyStore): void {
    const mode = store.mode;
    if (mode === 'direct') {
        if (GATEWAYS.some((g) => store.active(g))) {
            note(
                `${bold('mode')} ${cyan('direct')} ${dim('— each provider with its own key; zen key mode bifrost to send every model through the gateway')}`,
            );
            note('');
        }
        return;
    }
    const { url, key } = route(store, mode);
    note(`${cyan(badge(`⇄ ${mode.toUpperCase()} MODE`))} ${bold(url ?? 'no url stored')}`);
    note(
        dim(
            `every model goes through the gateway with ${key ?? 'no key'}; vendor keys are not used — ` +
                (store.modeFrom === 'env'
                    ? `${FROM_ENV}, unset it to stop`
                    : 'zen key mode direct to stop'),
        ),
    );
    note('');
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

type Sub = (ctx: Context, args: readonly string[]) => Promise<void>;

/**
 * Checking is a network round trip per key, so it says which ones have come
 * back. Silence for ten seconds is indistinguishable from a hang.
 */
async function checkAll(
    ctx: Context,
    store: KeyStore,
    targets: readonly KeyEntry[],
): Promise<[KeyEntry, KeyCheck][]> {
    const bar = ctx.json ? undefined : progress();
    bar?.update(dim(`checking ${targets.length} key${targets.length === 1 ? '' : 's'} …`));
    try {
        return await probeAll(store, targets, (entry, done, total) =>
            bar?.update(dim(`checked ${keyId(entry)} … ${done}/${total}`)),
        );
    } finally {
        bar?.done();
    }
}

const ls: Sub = async (ctx, args) => {
    const { values } = parse<{ check?: boolean }>(args, { check: { type: 'boolean' } }, USAGE);
    const store = await KeyStore.open();
    const borrowed = ambient(store).map((cred) => [cred, asEntry(cred)] as [Ambient, KeyEntry]);

    if (values.check) {
        // Ambient credentials are checked alongside the stored ones and, unlike
        // them, forgotten again: there is nowhere to write the result, and a
        // variable that changes between runs would make a cached one a lie.
        const checks = await checkAll(ctx, store, [
            ...store.entries,
            ...borrowed.map(([, entry]) => entry),
        ]);
        for (const [entry, check] of checks) {
            store.record(entry, check);
            entry.check = check;
        }
        store.save();
    }

    if (ctx.json) {
        json({
            mode: store.mode,
            keys: store.entries.map((e) => ({
                ...e,
                value: e.holds === 'file' ? store.fileOf(e) : mask(e.value),
                active: store.isActive(e),
                env: envOf(e),
            })),
            ambient: borrowed.map(([cred, entry]) => ({
                provider: cred.provider,
                id: ambientId(cred),
                env: cred.env ?? null,
                holds: cred.holds,
                value: cred.holds === 'file' ? cred.value : mask(cred.value),
                check: entry.check,
            })),
        });
        return;
    }

    if (store.entries.length === 0 && borrowed.length === 0 && store.mode === 'direct') {
        note('the keyring is empty');
        note(dim('add one: zen key add openai'));
        return;
    }
    modeLine(store);
    writeAll(rows(store, borrowed));

    const missing = OWNERS.filter(
        (p) =>
            !store.active(p) &&
            !borrowed.some(([c]) => c.provider === p) &&
            (!isGateway(p) || store.mode === p) &&
            (store.mode === 'direct' || SHAPES[p].kind !== 'model'),
    );
    if (missing.length) {
        note('');
        note(dim(`no key for: ${missing.join(', ')}`));
    }
};

/**
 * The secret never comes from argv. A command line is visible in `ps`, lands in
 * shell history and is captured by CI logs — three places a key must not be.
 * Piped stdin or an echo-off prompt are the only two ways in.
 */
const add: Sub = async (ctx, args) => {
    const { values, positionals } = parse<{
        name?: string;
        'no-check'?: boolean;
        'gcp-project'?: string;
        'gcp-location'?: string;
        url?: string;
    }>(
        args,
        {
            name: { type: 'string' },
            'no-check': { type: 'boolean' },
            // Prefixed because every other command's --project is a Zenera one.
            'gcp-project': { type: 'string' },
            'gcp-location': { type: 'string' },
            url: { type: 'string' },
        },
        'zen key add <provider>[/name] [--name <name>] [--gcp-project <id>] ' +
            '[--gcp-location <region>] [--url <gateway url>] [--no-check]',
    );

    const ref = positionals[0];
    if (!ref) {
        throw usageError('which provider?', `one of: ${OWNERS.join(', ')}`);
    }
    const parsed = parseRef(ref);
    const provider = parsed.provider;
    const name = values.name ?? parsed.name ?? 'default';
    const shape = SHAPES[provider];

    if ((values['gcp-project'] || values['gcp-location']) && provider !== 'vertex') {
        throw usageError(
            `--gcp-project and --gcp-location mean nothing to ${shape.label}`,
            'they configure a Vertex service account',
        );
    }
    const url = gatewayUrl(provider, values.url);

    // Checked before the prompt, so a typo does not cost you pasting the key.
    const region = values['gcp-location'];
    if (region !== undefined && !checkRegion(region)) {
        note(yellow(`${region} is not a region this build knows; storing it anyway`));
        note(dim('  if it is new, this is fine; if it is a typo, Vertex answers 404'));
    }

    ensureHome();
    const store = await KeyStore.open();

    if (store.find(provider, name) && isInteractive()) {
        if (!(await confirm(`Replace ${provider}/${name}?`))) {
            throw usageError('cancelled');
        }
    }

    const raw = (await readStdin()) ?? (await promptFor(shape));
    if (!raw) {
        throw usageError('no value given');
    }

    // A provider with one form can say up front that a path is wrong. One with
    // two cannot: a value that is not a path is not a mistake there, it is the
    // other kind of credential, and `add` decides which by looking.
    if (shape.forms.length === 1 && shape.forms[0].holds === 'file' && !existsSync(raw)) {
        throw usageError(`no such file: ${raw}`);
    }

    // Which shape was given is only knowable now, and `add` would drop these
    // two on an express key rather than store a combination Vertex refuses.
    if (formOf(provider, raw).holds !== 'file' && (values['gcp-project'] || region)) {
        throw usageError(
            '--gcp-project and --gcp-location need a service-account file',
            'the value given is an express-mode key, which addresses no project or region',
        );
    }

    const entry = store.add(provider, name, raw, {
        project: values['gcp-project'],
        location: values['gcp-location'],
        url,
    });

    // Verified before it is trusted, but stored either way: a key that cannot
    // be checked right now — offline, behind a proxy — is not a key that is
    // wrong, and refusing to save it would make `zen key add` fail on a plane.
    if (!values['no-check']) {
        const bar = ctx.json ? undefined : progress();
        bar?.update(dim(`checking ${keyId(entry)} …`));
        const check = await probe(store, entry);
        bar?.done();
        store.record(entry, check);
        if (check.state === 'dead') {
            note(`${red('rejected')} ${check.detail ?? 'the provider refused this key'}`);
        } else if (check.state === 'blocked') {
            note(`${yellow('blocked')} ${check.detail ?? 'the account cannot use this key'}`);
            if (check.fix) {
                note(dim(`  ${check.fix}`));
            }
        } else if (check.state === 'unknown' && check.fix) {
            // Most unknowns are a plane or a proxy and say nothing worth a
            // line. One carrying a fix is different: we know what is wrong.
            note(`${yellow('unverified')} ${check.detail}`);
            note(dim(`  ${check.fix}`));
        }
    }
    store.save();

    if (ctx.json) {
        json({
            key: keyId(entry),
            env: envOf(entry),
            active: store.isActive(entry),
            check: entry.check,
        });
        return;
    }
    note(
        `${green('added')} ${bold(keyId(entry))} ${dim(describe(store, entry))} ` +
            `${dim(`→ $${envOf(entry)}`)} ${state(entry)}`,
    );
    if (process.env[envOf(entry)]) {
        note(yellow(`$${envOf(entry)} is set and will win over this`));
    }
    if (isGateway(provider) && store.mode !== provider) {
        note(dim(`not in use yet — send every model through it with: zen key mode ${provider}`));
    }
    if (provider === 'vertex' && entry.holds === 'file' && !entry.project) {
        const found = store.projectOf(entry);
        note(
            dim(
                found
                    ? `no --gcp-project given; project ${found.id}, read from the key file`
                    : 'no --gcp-project given, and the key file names no project_id',
            ),
        );
    }
};

/**
 * A gateway is nothing without its address, and nothing else has one. Only
 * http(s) is taken: the url ends up as an SDK base url, where anything else
 * fails three frames down.
 */
function gatewayUrl(provider: KeyOwner, raw: string | undefined): string | undefined {
    if (!isGateway(provider)) {
        if (raw !== undefined) {
            throw usageError(
                `--url means nothing to ${SHAPES[provider].label}`,
                'it locates a gateway',
            );
        }
        return undefined;
    }
    if (!raw) {
        throw usageError(
            `${SHAPES[provider].label} needs --url`,
            `e.g. zen key add ${provider} --url https://bifrost.example.com`,
        );
    }
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw usageError(`"${raw}" is not a url`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw usageError(`"${raw}" is not an http(s) url`);
    }
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
        note(yellow('plain http: the virtual key will cross the network unencrypted'));
    }
    return url.href.replace(/\/+$/, '');
}

/**
 * A provider with two forms cannot ask for one of them. It asks with the echo
 * off, because one of the two answers is a secret and there is no way to know
 * which is coming until it arrives.
 */
async function promptFor(shape: (typeof SHAPES)[KeyOwner]): Promise<string> {
    const [first, ...rest] = shape.forms;
    if (rest.length) {
        note(dim(`${shape.label} — ${first.where},`));
        for (const form of rest) {
            note(dim(`  or ${form.where}`));
        }
        return askSecret('Paste the key, or a path to the file:');
    }
    note(dim(`${shape.label} — ${first.where}`));
    return first.holds === 'file'
        ? ask('Path to the credentials file:')
        : askSecret('Paste the key (it will not be shown):');
}

const use: Sub = async (ctx, args) => {
    const { positionals } = parse(args, {}, 'zen key use <provider>/<name>');
    const ref = positionals[0];
    if (!ref) {
        throw usageError('which key?', 'see: zen key ls');
    }
    const { provider, name } = parseRef(ref);
    if (!name) {
        throw usageError(`"${ref}" names a provider, not a key`, 'use provider/name');
    }
    const store = await KeyStore.open();
    const entry = store.use(provider, name);
    store.save();
    if (ctx.json) {
        json({ key: keyId(entry), env: envOf(entry) });
        return;
    }
    note(`${green('using')} ${bold(keyId(entry))} for ${SHAPES[provider].label}`);
};

/** Bare, it says which mode a run would use; with a word, it switches. */
const mode: Sub = async (ctx, args) => {
    const { positionals } = parse(args, {}, `zen key mode [${MODES.join('|')}]`);
    const wanted = positionals[0];
    const store = await KeyStore.open();
    if (wanted !== undefined) {
        if (!(MODES as readonly string[]).includes(wanted)) {
            throw usageError(`unknown mode "${wanted}"`, `one of: ${MODES.join(', ')}`);
        }
        // Already on through the environment: storing it as well needs a gateway key of its own.
        const viaEnv = store.modeFrom === 'env' && wanted === store.mode;
        if (!viaEnv || store.active(store.mode as GatewayOwner)?.url) {
            store.setMode(wanted as KeyMode);
            store.save();
        }
        if (store.modeFrom === 'env' && wanted !== store.mode) {
            warn(`saved, but ${FROM_ENV} wins: unset it to call vendors directly`);
        }
    }
    const now = store.mode;
    const from = store.modeFrom;
    const { url, key } = now === 'direct' ? {} : route(store, now);
    if (ctx.json) {
        json({ mode: now, from, ...(key ? { key } : {}), ...(url ? { url } : {}) });
        return;
    }
    if (now === 'direct') {
        note(`${cyan('direct')} ${dim('— each provider is called with its own key')}`);
        return;
    }
    note(
        `${cyan(now)} ${dim('— every model goes through')} ${url ?? 'no url stored'} ` +
            dim(`with ${key ?? 'no key'}`),
    );
    if (from === 'env') {
        note(dim(FROM_ENV));
    }
};

const check: Sub = async (ctx, args) => {
    const { positionals } = parse(args, {}, 'zen key check [provider[/name]]');
    const store = await KeyStore.open();
    // Checked like stored keys, never recorded: `store.record` finds no entry for them.
    const borrowed = ambient(store).map(asEntry);
    const targets = positionals[0]
        ? select(store, positionals[0], borrowed)
        : [...store.entries, ...borrowed];
    if (targets.length === 0) {
        assertNotEmpty(store);
    }
    const checks = await checkAll(ctx, store, targets);
    for (const [entry, result] of checks) {
        store.record(entry, result);
    }
    store.save();

    if (ctx.json) {
        json(checks.map(([entry, result]) => ({ key: keyId(entry), ...result })));
        return;
    }
    writeAll(
        table(
            checks.map(([entry, result]) => [
                keyId(entry),
                MARK[result.state],
                dim(result.detail ?? ''),
            ]),
        ),
    );
    for (const [entry, result] of checks) {
        if (result.fix) {
            note(dim(`${keyId(entry)}: ${result.fix}`));
        }
    }
    if (checks.some(([, r]) => r.state === 'dead')) {
        throw credentialError('at least one key was refused');
    }
    // Separately, because the action is not the same one: these authenticated,
    // and a replacement key would be refused for exactly the same reason.
    if (checks.some(([, r]) => r.state === 'blocked')) {
        throw credentialError('at least one key authenticated but cannot be used');
    }
};

function select(store: KeyStore, ref: string, borrowed: readonly KeyEntry[] = []): KeyEntry[] {
    const { provider, name } = parseRef(ref);
    if (!name) {
        return [...store.for(provider), ...borrowed.filter((e) => e.provider === provider)];
    }
    const entry =
        store.find(provider, name) ??
        borrowed.find((e) => e.provider === provider && e.name === name);
    if (!entry) {
        throw usageError(`no key ${ref}`, 'see: zen key ls');
    }
    return [entry];
}

const rm: Sub = async (ctx, args) => {
    const { values, positionals } = parse<{ yes?: boolean }>(
        args,
        { yes: { type: 'boolean' } },
        'zen key rm <provider>/<name> [--yes]',
    );
    const ref = positionals[0];
    if (!ref) {
        throw usageError('which key?', 'see: zen key ls');
    }
    const { provider, name } = parseRef(ref);
    if (!name) {
        throw usageError(`"${ref}" names a provider, not a key`, 'use provider/name');
    }
    const store = await KeyStore.open();
    if (!store.find(provider, name)) {
        throw usageError(`no key ${ref}`, 'see: zen key ls');
    }
    if (!values.yes && isInteractive() && !(await confirm(`Forget ${ref}?`))) {
        throw usageError('cancelled');
    }
    store.remove(provider, name);
    store.save();
    // The stored file is left behind on purpose: it was copied from somewhere,
    // and deleting a service-account key nobody asked us to delete is not the
    // CLI's call to make.
    if (ctx.json) {
        json({ removed: ref });
        return;
    }
    note(`${green('forgot')} ${ref}`);
};

/** The one deliberate way a secret leaves the store, and it has to be asked for. */
const show: Sub = async (ctx, args) => {
    const { values, positionals } = parse<{ reveal?: boolean }>(
        args,
        { reveal: { type: 'boolean' } },
        'zen key show <provider>[/name] [--reveal]',
    );
    const ref = positionals[0];
    if (!ref) {
        throw usageError('which key?', 'see: zen key ls');
    }
    const store = await KeyStore.open();
    const entry = select(store, ref)[0];
    if (!entry) {
        throw usageError(`no key ${ref}`, 'see: zen key ls');
    }

    const value = values.reveal ? store.reveal(entry) : describe(store, entry);
    const project = store.projectOf(entry);
    if (ctx.json) {
        json({
            key: keyId(entry),
            env: envOf(entry),
            value,
            revealed: Boolean(values.reveal),
            ...(project ? { project: project.id, projectFrom: project.from } : {}),
        });
        return;
    }
    if (values.reveal) {
        // stdout, alone, unstyled — so `zen key show openai --reveal | pbcopy`
        // copies the key and nothing else.
        write(value);
        return;
    }
    writeAll(
        table([
            [dim('key'), keyId(entry)],
            [dim('env'), envOf(entry)],
            [dim('value'), value],
            ...(project
                ? [[dim('gcp project'), `${project.id} ${dim(ORIGIN[project.from])}`]]
                : []),
            ...(entry.location ? [[dim('gcp location'), entry.location]] : []),
            ...(entry.url ? [[dim('url'), entry.url]] : []),
            [dim('state'), state(entry)],
            ...(entry.check?.fix ? [[dim('fix'), entry.check.fix]] : []),
            [dim('added'), ago(entry.addedAt)],
        ]),
    );
    note(dim('--reveal prints the secret itself'));
};

/**
 * `eval "$(zen key env)"` puts the active keys into a shell — for the tools that
 * are not `zen`. Real environment variables still win inside `zen` itself, so
 * this changes nothing about how a run resolves credentials.
 */
const env: Sub = async (ctx, args) => {
    const { positionals } = parse(args, {}, 'zen key env [provider …]');
    const store = await KeyStore.open();
    const only = positionals.length
        ? positionals.map((p) => parseRef(p).provider as KeyOwner)
        : undefined;
    // Ignore what is already exported: the point is to produce the exports.
    const vars: Record<string, string> = {};
    for (const provider of only ?? OWNERS) {
        // Unasked-for, a gateway is exported only in its own mode, where it is the switch.
        if (!only && isGateway(provider) && store.mode !== provider) {
            continue;
        }
        const entry = store.active(provider);
        if (!entry) {
            continue;
        }
        vars[envOf(entry)] = store.reveal(entry);
        if (entry.url) {
            vars[GATEWAY_URL_ENV] = entry.url;
        }
        // A service account says which project it belongs to but not which
        // region to call, and a shell that has the file and not the region is
        // still a shell that cannot reach a model.
        if (entry.project) {
            vars.GOOGLE_CLOUD_PROJECT = entry.project;
        }
        if (entry.location) {
            vars.GOOGLE_CLOUD_LOCATION = entry.location;
        }
    }
    if (ctx.json) {
        json(vars);
        return;
    }
    for (const [name, value] of Object.entries(vars)) {
        write(`export ${name}=${shellQuote(value)}`);
    }
    if (Object.keys(vars).length === 0) {
        note(dim('nothing to export'));
    }
};

/** Single quotes, with the one escape single quotes cannot express. */
function shellQuote(value: string): string {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * One credential on stdout, alone, for a tool that wants a fresh one before
 * every request rather than an export that goes stale — `zen meta` hands this
 * to copilot as `COPILOT_PROVIDER_API_KEY_COMMAND`.
 *
 * A stored secret is simply printed. A service-account file is exchanged for
 * an OAuth access token, which is the part worth having a command for: those
 * last an hour, and a session does not.
 */
const token: Sub = async (ctx, args) => {
    const { positionals } = parse(args, {}, 'zen key token <provider>[/name]');
    const { provider, name } = parseRef(positionals[0] ?? 'vertex');
    const store = await KeyStore.open();
    const entry = name ? store.find(provider, name) : store.active(provider);
    if (!entry) {
        throw credentialError(`no ${provider} key`, `add one: zen key add ${provider}`);
    }
    if (entry.holds === 'secret') {
        write(store.reveal(entry));
        return;
    }
    const { GoogleAuth } = await import('google-auth-library');
    const auth = new GoogleAuth({
        keyFile: store.fileOf(entry),
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    const client = await auth.getClient();
    // Called before every request of a long session, so one network blip must not fail it.
    let access: Awaited<ReturnType<typeof client.getAccessToken>> = {};
    for (let attempt = 0; ; attempt++) {
        try {
            access = await client.getAccessToken();
            break;
        } catch (err) {
            if (attempt >= 2) {
                throw err;
            }
            await new Promise((done) => setTimeout(done, 500 * 2 ** attempt));
        }
    }
    if (!access.token) {
        throw credentialError(
            `${keyId(entry)} minted no token`,
            'check the service account is still enabled',
        );
    }
    if (ctx.json) {
        json({ key: keyId(entry), token: access.token });
        return;
    }
    write(access.token);
};

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const SUBS: Record<string, Sub> = {
    ls,
    list: ls,
    add,
    use,
    mode,
    check,
    rm,
    remove: rm,
    show,
    env,
    token,
};

export const key: Command = {
    summary: 'The credential store: add, choose, verify and export API keys.',
    usage: USAGE,
    banner: { head: 'Zenera', accent: 'Keys', subtitle: 'Credential Keyring', hue: 'amber' },
    details: [
        'Keys live in ~/.zenera/neo/keys.json (0600) and are materialised into',
        'the environment before a run. A real environment variable always wins,',
        'and is listed as ~ so it is clear where a working provider comes from.',
        '',
        'Model providers: openai, anthropic, google, vertex, openrouter.',
        'Services the tools call: exa.',
        `Gateways every model can go through: ${GATEWAYS.join(', ')}.`,
        '',
        'Vertex takes either shape: a service-account JSON file, which wants',
        '--gcp-project and --gcp-location too, or an express-mode API key, which',
        'wants neither. Which one you gave is read off the value.',
        '',
        'A gateway holds one virtual key and its --url. In its mode every model',
        'goes through it, each in its own vendor protocol, and agents.yaml does',
        'not change: vertex:gemini-3.5-flash reaches <url>/genai as',
        'vertex/gemini-3.5-flash. Vendor keys are withheld from runs meanwhile.',
        '',
        '  zen key ls [--check]              Everything stored, and its state.',
        '  zen key add <provider>[/name]     Read a key from stdin, or ask for it.',
        '  zen key add bifrost --url <url>   A gateway key, and where the gateway is.',
        '  zen key use <provider>/<name>     Choose which one a run uses.',
        '  zen key mode [direct|bifrost]     Call vendors directly, or via the gateway.',
        '  zen key check [provider[/name]]   Ask the provider whether it still works.',
        '  zen key rm <provider>/<name>      Forget one.',
        '  zen key show <ref> [--reveal]     Masked by default.',
        '  zen key env [provider …]          Shell exports, for other tools.',
        '  zen key token [ref]               One credential on stdout, minted now.',
    ],
    run: async (ctx) => {
        const [name, ...rest] = ctx.args;
        if (!name) {
            await ls(ctx, []);
            return;
        }
        const sub = SUBS[name];
        if (!sub) {
            throw usageError(
                `unknown: zen key ${name}`,
                `try: ${cyan(Object.keys(SUBS).slice(0, 7).join(', '))}`,
            );
        }
        await sub(ctx, rest);
    },
};
