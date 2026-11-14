import './quiet.ts';
import {
    bold,
    cacheItems,
    clearCache,
    CliError,
    cyan,
    dim,
    EXIT,
    green,
    json,
    KeyStore,
    note,
    parse,
    paths,
    red,
    table,
    usageError,
    write,
    writeAll,
    yellow,
    type Command,
    type Context,
} from '@zenera/cli/lib';
import { createEmbedder, createModel, type EmbeddingRef } from '@zenera/neo';
import { existsSync, rmSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { BINDINGS_KIND } from './bindings.ts';
import { HANDLERS } from './box.ts';
import { GYM_KIND, type HandlerMeta } from './cache.ts';
import { reason } from './generate.ts';
import { formatDumpPath } from './logger.ts';
import { listen } from './server.ts';
import {
    configuredEmbedding,
    chooseModel,
    EMBEDDING_ENV,
    MODEL_ENV,
    open,
    readSettings,
    SOURCE_LABELS,
    writeSettings,
    type Setup,
} from './setup.ts';
import { called, type Operation } from './spec.ts';
import { listWorlds, removeWorld, worldPath, worldsDir } from './store.ts';
import { validateLongPagination, type LongPaginationPolicy } from './long-pagination.ts';
import { randomInt } from 'node:crypto';

// ---------------------------------------------------------------------------
// zen gym — a mock API from a specification
//
// A command in another package rather than a binary of its own: one thing to
// install, one keyring, one name to remember. `zen` loads this module only when
// somebody types `zen gym`, so nothing here is on the path of `zen list`.
//
// That it stays up is not a problem for the frame — `run` simply does not
// resolve until a signal arrives, and the process lives as long as the answer
// takes, which is what every other command already means.
// ---------------------------------------------------------------------------

const USAGE = 'zen gym <serve|build|cache|world|model> [spec...]';
const SERVE_USAGE =
    'zen gym serve [spec...] [--schema <path>]... [--story <path>]... [--docs <path>]... [--world <name|file>]';

interface Flags {
    port?: string;
    host?: string;
    model?: string;
    schema?: string[];
    story?: string[];
    docs?: string[];
    world?: string;
    embedding?: string;
    cache?: string;
    attempts?: string;
    concurrency?: string;
    seed?: string;
    timeout?: string;
    'max-body'?: string;
    'regen-limit'?: string;
    'requests-dir'?: string;
    rebuild?: boolean;
    reset?: boolean;
    'no-cache'?: boolean;
    clear?: boolean;
    quiet?: boolean;
    'long-pagination'?: string[];
}

// `--json` is the frame's, lifted out of the arguments before they arrive; it
// reaches us as `ctx.json` and must not be declared again or `strict` rejects it.
const OPTIONS = {
    port: { type: 'string' },
    host: { type: 'string' },
    model: { type: 'string' },
    schema: { type: 'string', multiple: true },
    story: { type: 'string', multiple: true },
    docs: { type: 'string', multiple: true },
    world: { type: 'string' },
    embedding: { type: 'string' },
    cache: { type: 'string' },
    attempts: { type: 'string' },
    concurrency: { type: 'string' },
    seed: { type: 'string' },
    timeout: { type: 'string' },
    'max-body': { type: 'string' },
    'regen-limit': { type: 'string' },
    'requests-dir': { type: 'string' },
    rebuild: { type: 'boolean' },
    reset: { type: 'boolean' },
    'no-cache': { type: 'boolean' },
    clear: { type: 'boolean' },
    quiet: { type: 'boolean' },
    'long-pagination': { type: 'string', multiple: true },
} as const;

export const command: Command = {
    summary: 'Simulated API environments for agent training and evaluation.',
    usage: USAGE,
    details: [
        'Commands',
        ...table([
            ['  serve [spec...]', dim('Serve the APIs. Handlers are written on first use.')],
            ['  build [spec...]', dim('Index everything and write every handler, then exit.')],
            ['  cache ls|clear', dim('Handlers, bindings and indexes: list them, or clear them.')],
            ['  world ls|rm <name>', dim('Worlds are data: list them, or delete one.')],
            ['  model [ref]', dim('Show or set the models it uses. Remembered between runs.')],
        ]),
        '',
        'Options',
        ...table([
            ['  --port <n>', dim('Default 8787.')],
            ['  --host <h>', dim('Default 127.0.0.1. Anything else is reachable off-machine.')],
            [
                '  --schema <path>',
                dim('API documents: files, directories, quoted globs. Repeatable.'),
            ],
            ['  --story <path>', dim('The state of the world, quoted to every agent. Repeatable.')],
            ['  --docs <path>', dim('Reference material, searched by agents. Repeatable.')],
            [
                '  --world <name|file>',
                dim('Which world. Default: one per story, shared by processes.'),
            ],
            ['  --reset', dim('Start from an empty world.')],
            ['  --model <ref>', dim('Which model writes handlers and content, for this run only.')],
            [
                '  --embedding <on|ref>',
                dim('Search --docs by meaning too: `on` for the configured model, or a ref.'),
            ],
            [
                '  --cache <dir>',
                dim('Handlers, worlds, indexes and reports. Default ~/.zenera/neo/gym.'),
            ],
            ['  --seed <n>', dim('Answer the same request the same way every time.')],
            ['  --attempts <n>', dim('Failed tests per handler before giving up. Default 5.')],
            ['  --concurrency <n>', dim('Handlers written at once. Default 4.')],
            ['  --timeout <s>', dim('Seconds one handler may run, agent time aside. Default 30.')],
            ['  --max-body <n>', dim('Largest request body accepted, in bytes.')],
            ['  --regen-limit <n>', dim('Maximum regenerations per URL on error. Default 3.')],
            ['  --requests-dir <dir>', dim('Where to save request/response .md files.')],
            ['  --rebuild', dim('Ignore what is cached and write it again.')],
            ['  --no-cache', dim('Do not record what is written.')],
            [
                '  --clear',
                dim('With `model`: forget the stored model. `--embedding clear` forgets that one.'),
            ],
            ['  --quiet', dim('No narration.')],
            [
                '  --long-pagination <operationId=pagesxsize>',
                dim('Generate a long paginated list for an operation. Repeatable.'),
            ],
        ]),
        '',
        dim(
            `The model is looked for in this order: ${cyan('--model')}, ${cyan(MODEL_ENV)}, ` +
                `${cyan('zen gym model')}, then the best one your keys can buy.`,
        ),
        dim(
            `Docs are searched by wording unless ${cyan('--embedding')} is given. ` +
                `${cyan('--embedding on')} uses ${cyan(EMBEDDING_ENV)}, then ` +
                `${cyan('zen gym model --embedding')}, then the first model your keys offer.`,
        ),
        dim(`Quote globs (${cyan("--docs 'kb/*.md'")}) so the shell leaves them to gym.`),
        dim(`Credentials come from the ${cyan('zen')} keyring — try ${cyan('zen key ls')}.`),
    ],

    async run(ctx: Context): Promise<void> {
        const [name, ...rest] = ctx.args;
        switch (name) {
            case 'serve':
                return await serve(rest, ctx);
            case 'build':
                return await warm(rest, ctx);
            case 'cache':
                return await cache(rest, ctx);
            case 'world':
                return await worlds(rest, ctx);
            case 'model':
                return await model(rest, ctx);
            default:
                throw usageError(name ? `unknown command "${name}"` : 'no command given', USAGE);
        }
    },
};

// ---------------------------------------------------------------------------
// serve
// ---------------------------------------------------------------------------

async function serve(args: readonly string[], ctx: Context): Promise<void> {
    const { values, positionals } = parse<Flags>(args, OPTIONS, SERVE_USAGE);
    const setup = await start(values, positionals, ctx, 'serve');
    const longPagination = parseLongPagination(values['long-pagination']);
    const pageLimits = new Map(
        setup.router.operations
            .filter((operation) => longPagination?.[operation.operationId] !== undefined)
            .map(
                (operation) =>
                    [operation.key, longPagination![operation.operationId].pages] as const,
            ),
    );

    const host = values.host ?? '127.0.0.1';
    const requestsDir = values['requests-dir']
        ? resolve(ctx.cwd, values['requests-dir'])
        : undefined;
    const listener = await listen(
        {
            router: setup.router,
            cache: setup.cache,
            checks: setup.checks,
            box: setup.box,
            seed: number(values.seed, 'seed'),
            maxBody: number(values['max-body'], 'max-body'),
            requestsDir,
            regenLimit: number(values['regen-limit'], 'regen-limit'),
            onRequest: values.quiet ? undefined : (line) => note(line),
            maxPages: (operationKey) => pageLimits.get(operationKey) ?? randomInt(1, 11),
        },
        host,
        number(values.port, 'port') ?? 8787,
    );

    if (!values.quiet) {
        note(
            `${green('listening')} ${cyan(`http://${host}:${listener.port}`)} ` +
                dim(`${setup.router.operations.length} operations`),
        );
        if (host !== '127.0.0.1' && host !== 'localhost') {
            note(yellow(`bound to ${host} — this mock is reachable from the network`));
        }
        note(dim(`handlers: ${setup.root}/${HANDLERS}`));
        note(dim(`request logs: ${requestsDir ?? `${setup.root}/requests`}`));
        note(dim(`agent runs: ${setup.root}/reports  failed builds: ${setup.root}/builds`));
    }
    // The address is the answer; the rest was narration.
    write(`http://${host}:${listener.port}`);

    await until(['SIGINT', 'SIGTERM']);
    if (!values.quiet) {
        note(dim('stopping'));
    }
    await listener.close();
    await setup.close();
}

/** Resolves when one of the signals arrives, and stops listening for them. */
function until(signals: readonly NodeJS.Signals[]): Promise<void> {
    return new Promise<void>((settle) => {
        const done = (): void => {
            for (const s of signals) {
                process.off(s, done);
            }
            settle();
        };
        for (const s of signals) {
            process.once(s, done);
        }
    });
}

// ---------------------------------------------------------------------------
// build — every handler, up front
// ---------------------------------------------------------------------------

async function warm(args: readonly string[], ctx: Context): Promise<void> {
    const { values, positionals } = parse<Flags>(
        args,
        OPTIONS,
        SERVE_USAGE.replace('serve', 'build'),
    );
    const loud = !values.quiet && !ctx.json;
    const setup = await start(values, positionals, ctx, 'build');

    const results: { operation: string; status: string; detail?: string }[] = [];
    try {
        for (const operation of setup.router.operations) {
            const id = `${operation.method.toUpperCase()} ${called(operation)}`;
            try {
                const handler = await setup.cache.ensure(operation);
                results.push({ operation: id, status: handler.cached ? 'cached' : 'built' });
            } catch (err) {
                results.push({
                    operation: id,
                    status: 'failed',
                    detail: reason(err),
                });
            }
        }
    } finally {
        await setup.close();
    }

    if (ctx.json) {
        json(results);
    } else {
        writeAll(
            table(
                results.map((r) => [
                    `  ${mark(r.status)}`,
                    r.operation,
                    dim(r.detail?.slice(0, 100) ?? ''),
                ]),
            ),
        );
    }

    // Reported first, then failed: the table is the answer either way.
    const failed = results.filter((r) => r.status === 'failed').length;
    if (failed > 0) {
        throw new CliError(
            `${failed} of ${results.length} handlers failed`,
            EXIT.failed,
            'run again to retry, or raise --attempts',
        );
    }
}

const mark = (status: string): string =>
    status === 'failed' ? red('failed') : status === 'skipped' ? dim('skipped') : green(status);

// ---------------------------------------------------------------------------
// cache
// ---------------------------------------------------------------------------

async function cache(args: readonly string[], ctx: Context): Promise<void> {
    const { values, positionals } = parse<Flags>(args, OPTIONS, 'zen gym cache <ls|clear>');
    const root = values.cache ? resolve(ctx.cwd, values.cache) : paths.gym();
    const sub = positionals[0] ?? 'ls';

    if (sub === 'ls') {
        const entries = listHandlers();
        if (ctx.json) {
            json(entries);
            return;
        }
        if (entries.length === 0) {
            note('nothing cached yet');
            return;
        }
        writeAll(
            table([
                [bold('KEY'), bold('OPERATION'), bold('MODEL'), bold('TRIES')],
                ...entries.map((e) => [
                    e.key,
                    `${e.method?.toUpperCase() ?? '?'} ${e.path ?? ''}`,
                    dim(e.model ?? '—'),
                    dim(String(e.attempts ?? '—')),
                ]),
            ]),
        );
        return;
    }

    if (sub === 'clear') {
        clearCache({ kind: GYM_KIND });
        clearCache({ kind: BINDINGS_KIND });
        // The workspace is scratch — whatever a hit was copied into it is
        // written again from the cache, or by the model — and an index is
        // rebuilt from the documents. Worlds are not touched: they are data,
        // and `zen gym world rm` or `serve --reset` is how one goes.
        rmSync(join(root, HANDLERS), { recursive: true, force: true });
        rmSync(join(root, 'indexes'), { recursive: true, force: true });
        note(
            `${green('cleared')} ${dim(`handlers, bindings and indexes; worlds kept in ${worldsDir(root)}`)}`,
        );
        return;
    }

    throw usageError(`unknown cache command "${sub}"`, 'zen gym cache <ls|clear>');
}

type Listed = HandlerMeta & { key: string };

/**
 * The keys are the operation keys, written verbatim — which is why they can be
 * listed at all. Anything the store cannot parse is left out rather than shown
 * as a row with nothing in it.
 */
function listHandlers(): Listed[] {
    const { rows } = cacheItems(GYM_KIND);
    return rows
        .map((row) => ({ key: row.key, ...(row.value as { meta?: HandlerMeta })?.meta }))
        .sort((a, b) => a.key.localeCompare(b.key));
}

// ---------------------------------------------------------------------------
// model
//
// A stored model is remembered the way `zen meta model` remembers one: in the
// home directory, beside the keyring, because it is a choice about this tool on
// this machine. Shown rather than merely set, since the question when a run
// surprises you is not "which model" but "why that one".
// ---------------------------------------------------------------------------

const MODEL_USAGE = 'zen gym model [ref|--clear] [--embedding <ref|none> [--clear]]';

async function model(args: readonly string[], ctx: Context): Promise<void> {
    const { values, positionals } = parse<Flags>(args, OPTIONS, MODEL_USAGE);
    const ref = positionals[0];
    if (ref && values.clear) {
        throw usageError('--clear takes no model', MODEL_USAGE);
    }

    // Before anything builds a model: vertex reads its project out of the
    // environment, and the keyring is what puts it there.
    const keys = await KeyStore.open();
    keys.materialize();

    // `--embedding <ref>` sets that one; `--embedding --clear` is not
    // expressible with a string flag, so `--clear` with no ref and no
    // `--embedding` clears the chat model and `--embedding none` stores none.
    const embedding = values.embedding?.trim();
    if (ref || values.clear || embedding) {
        const file = await readSettings();
        if (ref) {
            // Only that the ref parses: asking the provider costs a call, and
            // the next run makes one anyway.
            createModel(ref);
            file.model = ref;
        } else if (values.clear && !embedding) {
            delete file.model;
        }
        if (embedding === 'clear') {
            delete file.embedding;
        } else if (embedding) {
            if (embedding === 'on' || embedding === 'default') {
                throw usageError(
                    `${embedding} is what \`serve --embedding\` asks for; store a model ref, or none`,
                    MODEL_USAGE,
                );
            }
            if (embedding !== 'none') {
                createEmbedder(embedding as EmbeddingRef);
            }
            file.embedding = embedding;
        }
        writeSettings(file);
        if (!ctx.json) {
            if (ref) {
                note(`${green('set')} ${ref}`);
            } else if (values.clear && !embedding) {
                note(`${green('cleared')} ${dim('the stored model')}`);
            }
            if (embedding) {
                note(
                    embedding === 'clear'
                        ? `${green('cleared')} ${dim('the stored embedding model')}`
                        : `${green('set')} ${dim('embedding')} ${embedding}`,
                );
            }
        }
    }

    const chosen = await chooseModel(ref ? undefined : values.model, keys);
    const embedder = await configuredEmbedding(keys);
    if (ctx.json) {
        const stored = await readSettings();
        json({
            model: chosen?.ref,
            from: chosen?.from,
            stored: stored.model,
            embedding: embedder.ref ?? 'none',
            embeddingFrom: embedder.from,
            storedEmbedding: stored.embedding,
        });
        return;
    }
    if (!chosen) {
        note('no model, and no key to recommend one from');
        note(dim('add a key: zen key add openai'));
        return;
    }
    note(`${dim('model    ')} ${cyan(chosen.ref)} ${dim(`from ${SOURCE_LABELS[chosen.from]}`)}`);
    note(
        `${dim('embedding')} ${embedder.ref ? cyan(embedder.ref) : yellow('none')} ` +
            dim(
                (embedder.from === 'none'
                    ? ''
                    : `from ${embedder.from === 'env' ? EMBEDDING_ENV : SOURCE_LABELS[embedder.from]} · `) +
                    'used only with --embedding on; docs are searched by wording otherwise',
            ),
    );
    if (chosen.from === 'default') {
        note(dim(`set one: zen gym model <provider>:<id>`));
    }
}

// ---------------------------------------------------------------------------
// world
//
// Worlds are data rather than cache — they hold what clients wrote, and
// content an agent made that would come out differently next time — so they
// have a command of their own and `cache clear` leaves them alone.
// ---------------------------------------------------------------------------

const WORLD_USAGE = 'zen gym world <ls|rm <name|file>>';

async function worlds(args: readonly string[], ctx: Context): Promise<void> {
    const { values, positionals } = parse<Flags>(args, OPTIONS, WORLD_USAGE);
    const root = values.cache ? resolve(ctx.cwd, values.cache) : paths.gym();
    const [sub = 'ls', target] = positionals;

    if (sub === 'ls') {
        const found = listWorlds(root);
        if (ctx.json) {
            json(found);
            return;
        }
        if (found.length === 0) {
            note(`no worlds yet in ${worldsDir(root)}`);
            return;
        }
        writeAll(
            table([
                [bold('WORLD'), bold('RECORDS'), bold('COLLECTIONS'), bold('USED'), bold('SIZE')],
                ...found.map((w) => [
                    w.name,
                    String(w.collections.reduce((n, c) => n + c.count, 0)),
                    dim(
                        w.collections
                            .map((c) => `${c.name} ${c.count}`)
                            .join(', ')
                            .slice(0, 60) || '—',
                    ),
                    dim(w.usedAt.toISOString().slice(0, 16).replace('T', ' ')),
                    dim(`${Math.ceil(w.bytes / 1024)} KB`),
                ]),
            ]),
        );
        note(dim(worldsDir(root)));
        return;
    }

    if (sub === 'rm') {
        if (!target) {
            throw usageError('name the world to remove', WORLD_USAGE);
        }
        const path = worldPath({ root, cwd: ctx.cwd, world: target });
        if (!existsSync(path)) {
            throw usageError(`no world at ${path}`, 'see them with: zen gym world ls');
        }
        removeWorld(path);
        note(`${green('removed')} ${dim(path)}`);
        return;
    }

    throw usageError(`unknown world command "${sub}"`, WORLD_USAGE);
}

// ---------------------------------------------------------------------------
// What was loaded
//
// One row per document named on the argv, because that is the unit the user
// typed. `methods` is the operations in it; `functions` is how many of those
// need a handler written for them — an operation answering with no body is
// served without ever asking a model, and the difference between the two
// numbers is the size of the job ahead.
// ---------------------------------------------------------------------------

interface SpecStat {
    source: string;
    paths: Set<string>;
    methods: number;
    functions: number;
}

function summarize(operations: readonly Operation[]): SpecStat[] {
    const by = new Map<string, SpecStat>();
    for (const op of operations) {
        let stat = by.get(op.source);
        if (!stat) {
            stat = { source: op.source, paths: new Set(), methods: 0, functions: 0 };
            by.set(op.source, stat);
        }
        stat.paths.add(op.path);
        stat.methods += 1;
        if (op.success.schema) {
            stat.functions += 1;
        }
    }
    return [...by.values()];
}

const HEADERS = ['PATHS', 'METHODS', 'FUNCTIONS'] as const;

function printSpecs(operations: readonly Operation[], cwd: string): void {
    const stats = summarize(operations);
    const rows = stats.map((s) => ({
        name: relative(cwd, s.source) || s.source,
        cells: [s.paths.size, s.methods, s.functions],
    }));
    if (rows.length > 1) {
        rows.push({
            name: 'total',
            cells: HEADERS.map((_, i) => rows.reduce((n, r) => n + r.cells[i], 0)),
        });
    }

    // Numbers are padded before they are styled: a colour code has no width,
    // and `table` cannot know that.
    const widths = HEADERS.map((h, i) =>
        Math.max(h.length, ...rows.map((r) => String(r.cells[i]).length)),
    );
    const lines = table([
        [bold('SPEC'), ...HEADERS.map((h, i) => bold(h.padStart(widths[i])))],
        ...rows.map((r) => [
            r.name === 'total' ? dim(r.name) : r.name,
            ...r.cells.map((c, i) => String(c).padStart(widths[i])),
        ]),
    ]);
    note('');
    for (const line of lines) {
        note(`  ${line}`);
    }
    note('');
}

/** The rest of what was loaded, and what it will be served with. */
function printInputs(setup: Setup): void {
    const k = setup.knowledge;
    const rows: string[][] = [
        ['model', `${setup.choice.ref} ${dim(`from ${SOURCE_LABELS[setup.choice.from]}`)}`],
        [
            'story',
            k.storyFiles > 0
                ? `${k.storyFiles} file${k.storyFiles === 1 ? '' : 's'}`
                : dim('none — the agents invent a world'),
        ],
    ];
    if (k.docs) {
        rows.push([
            'docs',
            `${k.docs.files} files, ${k.docs.chunks} chunks · ` +
                (k.docs.search === 'hybrid'
                    ? `search by meaning and wording (${k.docs.embedding})`
                    : `search by wording ${dim('(--embedding <ref> adds meaning)')}`) +
                dim(k.docs.reused ? ' · index reused' : ' · indexed'),
        ]);
    }
    rows.push(['world', setup.worldFile]);
    for (const line of table(rows.map(([a, b]) => [`  ${dim(a!)}`, b!]))) {
        note(line);
    }
    note('');
}

/** Narrates indexing at the quarters, so a long first run is not silent. */
function indexing(): (phase: 'reading' | 'embedding', done: number, total: number) => void {
    let last = '';
    return (phase, done, total) => {
        const quarter = total === 0 ? 4 : Math.floor((done / total) * 4);
        const mark = `${phase}:${quarter}`;
        if (mark === last || total === 0) {
            return;
        }
        last = mark;
        note(dim(`  ${phase === 'reading' ? 'reading docs' : 'embedding docs'} ${done}/${total}`));
    };
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

async function start(
    values: Flags,
    positionals: readonly string[],
    ctx: Context,
    what: 'serve' | 'build',
): Promise<Setup> {
    const loud = !values.quiet && !ctx.json;
    const progress = loud ? indexing() : undefined;
    const longPagination = parseLongPagination(values['long-pagination']);
    const setup = await open({
        schemas: [...positionals, ...(values.schema ?? [])],
        story: values.story,
        docs: values.docs,
        cwd: ctx.cwd,
        longPagination,
        cache: values.cache,
        model: values.model,
        embedding: values.embedding,
        world: values.world,
        reset: values.reset,
        attempts: number(values.attempts, 'attempts'),
        concurrency: number(values.concurrency, 'concurrency'),
        timeout: number(values.timeout, 'timeout'),
        rebuild: values.rebuild,
        ephemeral: values['no-cache'],
        onWarn: loud ? (message) => note(yellow(message)) : undefined,
        onIndexing: progress,
        onWorld: loud
            ? (e) =>
                  note(
                      `  ${e.fallback ? yellow('sampled') : green('world')} ${dim(`${e.made} × ${e.collection} in ${e.durationMs}ms`)}` +
                          (e.dependents ? dim(` + ${e.dependents} they refer to`) : '') +
                          (e.fallback ? ` ${dim(e.fallback)}` : '') +
                          (e.dangling?.length
                              ? `\n  ${yellow('dangling')} ${dim(e.dangling.slice(0, 5).join(', '))}`
                              : '') +
                          (e.report ? `\n${formatDumpPath('agent run', e.report)}` : ''),
                  )
            : undefined,
        events: {
            onStart: loud
                ? ({ operation }) =>
                      note(
                          `${dim('writing a handler for')} ${operation.method.toUpperCase()} ${called(operation)}`,
                      )
                : undefined,
            onAttempt: loud
                ? ({ operation, attempt, diagnostics }) =>
                      note(
                          `  ${yellow(`attempt ${attempt} failed`)} ${dim(`${operation.operationId}: ${(diagnostics ?? []).join(' ').slice(0, 160)}`)}`,
                      )
                : undefined,
            onReady:
                loud && what === 'serve'
                    ? ({ operation, cached }) =>
                          cached
                              ? undefined
                              : note(`  ${green('ready')} ${dim(operation.operationId)}`)
                    : undefined,
            onFail: loud
                ? ({ operation, error, dump }) => {
                      note(`  ${red('gave up')} ${dim(operation.operationId)} ${reason(error)}`);
                      if (dump) {
                          note(formatDumpPath('report', dump));
                      }
                  }
                : undefined,
        },
    });
    if (loud) {
        printSpecs(setup.router.operations, ctx.cwd);
        printInputs(setup);
    }
    return setup;
}

function number(raw: string | undefined, what: string): number | undefined {
    if (raw === undefined) {
        return undefined;
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) {
        throw usageError(`--${what} must be a number, got "${raw}"`);
    }
    return value;
}

function parseLongPagination(
    entries: readonly string[] | undefined,
): LongPaginationPolicy | undefined {
    if (!entries?.length) {
        return undefined;
    }

    const policy: Record<string, { pages: number; pageSize: number }> = {};

    for (const entry of entries) {
        const match = /^([^=]+)=(\d+)x(\d+)$/.exec(entry);

        if (!match) {
            throw usageError(
                `invalid --long-pagination value "${entry}". ` + 'Expected operationId=pagesxsize',
            );
        }

        const operationId = match[1];
        const config = {
            pages: Number(match[2]),
            pageSize: Number(match[3]),
        };

        if (Object.hasOwn(policy, operationId)) {
            throw usageError(`duplicate --long-pagination for "${operationId}"`);
        }

        try {
            validateLongPagination(config);
        } catch (error) {
            throw usageError(
                `invalid --long-pagination for "${operationId}". ` +
                    (error instanceof Error ? error.message : String(error)),
            );
        }

        policy[operationId] = config;
    }

    return policy;
}
