import { KeyStore, loadProjectEnv } from '@zenera/engine';
import {
    ALL_AGENTS,
    buildMemoryReport,
    createEmbedder,
    diffMemories,
    GREP_FIELDS,
    grepMemory,
    hostPath,
    isMemory,
    LEGACY_GRAPH_FILE,
    MEMORY_DB,
    memoryDir,
    MemoryError,
    MemoryIndex,
    MemoryStore,
    MergeConflicts,
    mergeMemories,
    migrateMemory,
    readProjectConfig,
    renderMemoryHtml,
    renderRecollection,
    type Embedder,
    type EmbeddingRef,
    type GrepField,
    type MemoryFile,
    type MemoryNode,
    type MemoryQuery,
    type MergeReport,
    type ProjectConfig,
    type Recollection,
    type SkippedFile,
} from '@zenera/neo';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { parse } from '../args.ts';
import type { Command } from '../command.ts';
import { project as resolveProject } from '../resolve.ts';
import {
    ago,
    bold,
    bytes,
    CliError,
    confirm,
    count,
    cyan,
    dim,
    EXIT,
    green,
    isInteractive,
    json,
    note,
    plain,
    table,
    usageError,
    write,
    writeAll,
    yellow,
} from '../term.ts';

const USAGE =
    'zen memory [stats|ls|search|grep|show|diff|export|merge|forget|migrate] [args] [options]';

interface Flags {
    project?: string;
    dir?: string;
    kind?: string;
    audience?: string;
    files?: boolean;
    stale?: boolean;
    all?: boolean;
    regex?: boolean;
    'case-sensitive'?: boolean;
    in?: string[];
    'ids-only'?: boolean;
    limit?: string;
    hops?: string;
    nodes?: string;
    'min-score'?: string;
    embedding?: string;
    out?: string;
    open?: boolean;
    yes?: boolean;
    force?: boolean;
    'dry-run'?: boolean;
    'no-dedupe'?: boolean;
}

const SUBCOMMANDS = [
    'stats',
    'ls',
    'search',
    'grep',
    'show',
    'diff',
    'export',
    'merge',
    'forget',
    'migrate',
];

/** Enough to see the shape of it; the rest is a number. */
const LISTED = 30;

// ---------------------------------------------------------------------------
// zen memory
//
// The graph from outside the agents, and the reason it needs a command is that
// there is otherwise no way to answer the question memory always eventually
// raises: *why did it recall that?* Recall is masked, ranked and truncated by
// design, so what an agent sees is never the whole picture — and when the
// picture is what is wrong, you need the part that was hidden.
//
// So everything here reads the graph unmasked. That is safe because it is
// local: this command is a person at a terminal in the project directory, not
// an agent inside a run, and the mask exists to keep agents apart rather than
// to keep secrets from the person who owns the files.
//
// `search` is the one subcommand that contacts a model, and it has to: the
// question it answers is what an agent's recall returns, and a recall ranked
// any other way is a different answer wearing the same shape. Everything else
// is offline, so inspecting a graph whose credentials have gone missing —
// which is exactly when someone is debugging — still works.
// ---------------------------------------------------------------------------

export const memory: Command = {
    summary: 'What the agents remember, and getting rid of it.',
    usage: USAGE,
    banner: { head: 'Zenera', accent: 'Memory', subtitle: 'Knowledge Graph', hue: 'purple' },
    details: [
        '  stats                  Size, vocabulary, and whether it is embedded.',
        '  ls                     Nodes, newest first. Changes nothing.',
        '  search <text>          Recall it, the way an agent does. Ranked.',
        '  grep <pattern>         Every node containing it, with the matching lines.',
        '  show <id>              One node in full, with what it links to.',
        '  diff <base>            What this memory holds that <base> did not.',
        '  export [file]          The whole graph as one HTML page.',
        '  merge <dir...>         Fold other memories into this one.',
        '  forget <id...>         Remove nodes, their vectors and their files.',
        '  migrate                Convert a version 1 memory (graph.json) to memory.db.',
        '',
        '  --project <name|dir>   Which project. Defaults to the one you are in.',
        '  --dir <dir>            Read this memory directory instead of the project’s.',
        '                         Run from inside a memory directory, that one is the default.',
        '  --kind <name>          Only this kind of node.',
        '  --audience <name>      Only nodes committed under this label.',
        '  --files                Only nodes that remember a file.',
        '  --stale                Only nodes something has superseded.',
        '  --all                  For `search` and `grep`: superseded nodes too, marked.',
        '  --regex                Read the pattern as a regular expression, per line.',
        '  --case-sensitive       Match case exactly. Off by default.',
        '  --in <text|metadata|file>  Where to look. Repeatable. All three by default.',
        '  --ids-only             Print bare ids, for piping into `zen memory show`.',
        '  --limit <n>            Rows to list, or seeds to rank. Default 30, search 10.',
        '  --hops <n>             How far `search` follows links from a seed. Default 2.',
        '  --nodes <n>            Cap on the subgraph `search` returns. Default 25.',
        '  --min-score <n>        Drop seeds scoring below this. Default 0.15.',
        '  --embedding <ref>      Rank `search` with this model, not the project’s.',
        '  --out <file>           Where `export` writes. Default memory.html.',
        '  --open                 Open the exported page.',
        '  --dry-run              Say what `merge` would do, and stop.',
        '  --no-dedupe            Keep memories `merge` would otherwise fold together.',
        '  --force                Let `merge` pick a winner where two copies disagree.',
        '  --yes                  Do not ask before removing or merging.',
        '',
        'Everything here reads the graph *unmasked* — every audience, including',
        'what no agent can see. That is the point: when a mask is the thing',
        'that is wrong, the hidden part is what you need to look at.',
        '',
        '`export` is the one to reach for. It writes a single self-contained',
        'page: the node list on the left, the graph in the middle, and whatever',
        'you click on the right, file contents and all.',
        '',
        '`search` is recall itself, run from here. It embeds the query with the',
        'project’s own model and prints the block a model would have been given,',
        'scores and all — so *why did it recall that?* has an answer, and so does',
        '*why did it not?*:',
        '',
        '  zen memory search ‘how do we deploy’ --audience reviewer',
        '',
        'Passing `--audience` recalls as an agent that sees only that label,',
        'which is how a memory that is present but invisible gives itself away.',
        '',
        '`grep` is the counterpart. Recall ranks, so it answers “what is closest”',
        'and can never answer “is this in here at all”; `grep` reads every node',
        'exactly — text, metadata and the bytes of remembered files — and the',
        'count it reports is the true one even when the list was cut:',
        '',
        '  zen memory grep ‘staging.example.com’ --in metadata --in file',
        '',
        'Every subcommand reads one consistent snapshot, so all of them work on',
        'a memory a run is writing to, and runs keep writing while they do.',
        '',
        '`merge` is for warming a memory in parallel. `zen run batch` gives each',
        'item its own copy, so N runs write N memories; this folds them back:',
        '',
        '  zen memory merge <batch-dir>/*/memory',
        '',
        'which is where `zen run batch` leaves them.',
        '',
        '`diff` is the question after a run that started from a copy: what it',
        'added, which of those `merge` would fold onto a node <base> already held',
        '(a re-commit), what it revised, and which nodes `memory_load` read:',
        '',
        '  zen memory diff <candidate> --dir <batch-dir>/<id>/memory',
    ],
    run: async (ctx) => {
        const { values, positionals } = parse<Flags>(
            ctx.args,
            {
                project: { type: 'string' },
                dir: { type: 'string' },
                kind: { type: 'string' },
                audience: { type: 'string' },
                files: { type: 'boolean' },
                stale: { type: 'boolean' },
                all: { type: 'boolean' },
                regex: { type: 'boolean' },
                'case-sensitive': { type: 'boolean' },
                in: { type: 'string', multiple: true },
                'ids-only': { type: 'boolean' },
                limit: { type: 'string' },
                hops: { type: 'string' },
                nodes: { type: 'string' },
                'min-score': { type: 'string' },
                embedding: { type: 'string' },
                out: { type: 'string' },
                open: { type: 'boolean' },
                yes: { type: 'boolean' },
                force: { type: 'boolean' },
                'dry-run': { type: 'boolean' },
                'no-dedupe': { type: 'boolean' },
            },
            USAGE,
        );

        const what = positionals[0] ?? 'stats';
        if (!SUBCOMMANDS.includes(what)) {
            throw usageError(`unknown subcommand: ${what}`, USAGE);
        }
        const rest = positionals.slice(1);
        if (what === 'migrate') {
            return await migrate(await locate(ctx.cwd, values.project, values.dir), ctx.json);
        }
        // `merge` is the one subcommand that may write a memory into existence;
        // every other one is an inspector and a missing database is a mistake.
        // Only the two that write open it for writing.
        const opened = await open(ctx.cwd, values.project, values.dir, {
            create: what === 'merge',
            write: what === 'merge' || what === 'forget',
        });

        try {
            switch (what) {
                case 'stats':
                    return stats(opened, ctx.json);
                case 'ls':
                    return list(opened, values, ctx.json);
                case 'search':
                    return await search(opened, rest, values, ctx.json);
                case 'grep':
                    return await grep(opened, rest, values, ctx.json);
                case 'show':
                    return show(opened, rest, ctx.json);
                case 'diff':
                    return await diff(opened, rest, ctx.cwd, ctx.json);
                case 'export':
                    return await write_(opened, rest, values, ctx.cwd, ctx.json);
                case 'merge':
                    return await merge(opened, rest, values, ctx.cwd, ctx.json);
                default:
                    return await forget(opened, rest, values, ctx.json);
            }
        } finally {
            opened.store.release();
        }
    },
};

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

interface Opened {
    store: MemoryStore;
    dir: string;
    project: string;
    /** the project this memory belongs to; absent when `--dir` named a bare directory */
    at?: { root: string; config: ProjectConfig };
}

/**
 * The store, opened directly rather than through `loadProject`. Loading the
 * project would resolve models and read every prompt file to inspect a graph
 * that needs none of it — and would fail on a project whose credentials are
 * missing, which is exactly when someone is debugging.
 *
 * A named directory is opened as it stands, project or no project: a graph
 * copied out of a running session is the one most worth looking at, and it
 * should not have to be given an `agents.yaml` first.
 *
 * `create` drops the requirement that anything be there yet, for `merge`,
 * which has somewhere to put what it reads even when the destination is a name
 * nothing has written to.
 */
async function open(
    cwd: string,
    want: string | undefined,
    at: string | undefined,
    opts: { create?: boolean; write?: boolean } = {},
): Promise<Opened> {
    const { create = false, write = false } = opts;
    const found = await locate(cwd, want, at);
    // A version 1 directory gets past this so that opening it says how to convert it.
    if (!create && !isMemory(found.dir) && !existsSync(join(found.dir, LEGACY_GRAPH_FILE))) {
        throw found.at
            ? usageError(
                  `${found.project} has a memory configured but nothing in it yet`,
                  'it is written the first time an agent commits something',
              )
            : usageError(`${found.dir} is not a memory`, `no ${MEMORY_DB} in it`);
    }
    try {
        return { ...found, store: await MemoryStore.open(found.dir, { readOnly: !write }) };
    } catch (err) {
        if (err instanceof MemoryError) {
            throw new CliError(err.message, EXIT.invalid, err.hint);
        }
        throw err;
    }
}

/** Which memory directory a command means, without opening it. */
async function locate(
    cwd: string,
    want: string | undefined,
    at: string | undefined,
): Promise<Omit<Opened, 'store'>> {
    // Standing inside a memory (a merged or batch copy) means that memory, not
    // the project's own one a few directories up.
    if (!at && !want && isMemoryDir(cwd)) {
        at = cwd;
    }
    if (at) {
        const dir = resolve(cwd, at);
        return { dir, project: basename(dir) };
    }
    const project = await resolveProject({ cwd, project: want });
    const { config } = readProjectConfig(project.dir);
    const dir = memoryDir(project.dir, config);
    if (!dir) {
        throw usageError(
            `${project.name} has no memory`,
            'give an agent `memory: true` in agents.yaml, or add a `memory:` block',
        );
    }
    return { dir, project: project.name, at: { root: project.dir, config } };
}

/** A rag index also has a manifest and a graph.json; only a memory's manifest counts nodes and edges. */
function isMemoryDir(dir: string): boolean {
    if (isMemory(dir)) {
        return true;
    }
    if (!existsSync(join(dir, LEGACY_GRAPH_FILE))) {
        return false;
    }
    try {
        const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
        return typeof m?.nodes === 'number' && typeof m?.edges === 'number';
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------

function stats(o: Opened, asJson: boolean): void {
    const nodes = o.store.graph.nodes();
    const edges = o.store.graph.edges();
    const stale = o.store.graph.superseded();
    const vectors = o.store.vectors;
    const files = nodes.filter((n) => n.file);
    const byKind = tally(nodes.map((n) => n.kind));
    const byRelation = tally(edges.map((e) => e.relation));
    const byAudience = tally(nodes.flatMap((n) => n.audience));

    if (asJson) {
        json({
            dir: o.dir,
            nodes: nodes.length,
            edges: edges.length,
            superseded: stale.size,
            files: {
                count: files.length,
                bytes: files.reduce((t, n) => t + (n.file?.bytes ?? 0), 0),
            },
            embedding: o.store.embedding,
            vectors: vectors ? { rows: vectors.rows, dims: vectors.dims } : undefined,
            kinds: byKind,
            relations: byRelation,
            audiences: byAudience,
        });
        return;
    }

    if (!nodes.length) {
        note(`nothing remembered yet ${dim(o.dir)}`);
        return;
    }

    write(bold(o.project) + dim(' · ' + o.dir));
    write();
    writeAll(
        table([
            [dim('nodes'), String(nodes.length)],
            [dim('edges'), String(edges.length)],
            [dim('superseded'), String(stale.size)],
            [
                dim('files'),
                files.length
                    ? `${files.length} · ${bytes(files.reduce((t, n) => t + (n.file?.bytes ?? 0), 0))}`
                    : '0',
            ],
            [
                dim('embedding'),
                o.store.embedding
                    ? `${o.store.embedding.model} ${dim(o.store.embedding.dimensions + 'd')}`
                    : yellow('none — recall falls back to term overlap'),
            ],
            [dim('vectors'), vectors ? `${vectors.rows} rows` : dim('—')],
        ]),
    );

    // A node without a vector cannot be found by meaning, only by luck. It is
    // the one silent failure this store has, so it is called out by name.
    if (vectors && vectors.rows < nodes.length) {
        write();
        note(yellow(`${count(nodes.length - vectors.rows, 'node')} with no vector`));
    }

    section('kinds', byKind);
    section('relations', byRelation);
    section('audiences', byAudience);
}

function section(title: string, counts: Record<string, number>): void {
    const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    if (!rows.length) {
        return;
    }
    write();
    write(dim(title));
    writeAll(table(rows.map(([k, n]) => [`  ${cyan(k)}`, String(n)])));
}

function tally(values: readonly string[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (const v of values) {
        out[v] = (out[v] ?? 0) + 1;
    }
    return out;
}

// ---------------------------------------------------------------------------
// ls
// ---------------------------------------------------------------------------

function list(o: Opened, flags: Flags, asJson: boolean): void {
    const stale = o.store.graph.superseded();
    const limit = Number(flags.limit ?? LISTED);
    if (!Number.isInteger(limit) || limit < 1) {
        throw usageError(`--limit wants a positive whole number, got ${flags.limit}`, USAGE);
    }

    const all = o.store.graph
        .nodes()
        .filter((n) => !flags.kind || n.kind === flags.kind)
        .filter((n) => !flags.audience || n.audience.includes(flags.audience))
        .filter((n) => !flags.files || n.file)
        .filter((n) => !flags.stale || stale.has(n.id))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    if (asJson) {
        json({ total: all.length, nodes: all.slice(0, limit).map((n) => onHost(o, n)) });
        return;
    }
    if (!all.length) {
        note('nothing matches');
        return;
    }

    writeAll(
        textLast(
            all
                .slice(0, limit)
                .map((n) => [
                    cyan(n.id),
                    n.kind + (n.file ? dim(' ⎘ ' + n.file.format) : ''),
                    n.audience.join(','),
                    dim(`r${n.revision}`),
                    dim(ago(n.createdAt)) + (stale.has(n.id) ? ' ' + yellow('superseded') : ''),
                ]),
            all.slice(0, limit).map((n) => n.text),
        ),
    );
    if (all.length > limit) {
        write();
        note(dim(`${all.length - limit} more — raise --limit, or use \`zen memory export\``));
    }
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

/**
 * Recall, run from outside a run. `ls` and `grep` read the graph; this asks it
 * the question an agent asks, through the same ranker, the same traversal and
 * the same renderer — so what it prints is the block a model would have been
 * handed, scores and all.
 *
 * That is the only way to answer *why did it recall that*, and the harder *why
 * did it not*: a memory that is present but ranked sixth looks exactly like a
 * memory that was never written, until the score is on the screen.
 */
async function search(o: Opened, rest: string[], flags: Flags, asJson: boolean): Promise<void> {
    // Joined rather than taken singly. A query is prose, and this is the one
    // subcommand whose whole argument is prose, so quoting it is the step
    // everybody forgets.
    const text = rest.join(' ').trim();
    if (!text) {
        throw usageError('search takes something to recall', 'zen memory search <text>');
    }
    // Recall either includes what has been superseded or does not; there is no
    // "only", because a correction alone is not the subgraph anyone wanted.
    if (flags.stale) {
        throw usageError('search has no --stale', 'use --all to recall superseded nodes too');
    }
    const query: MemoryQuery = {
        text,
        kinds: flags.kind ? [flags.kind] : undefined,
        limit: whole(flags.limit, '--limit'),
        // Zero hops is a real request — the seeds and nothing they dragged in.
        maxHops: whole(flags.hops, '--hops', 0),
        maxNodes: whole(flags.nodes, '--nodes'),
        minScore: threshold(flags['min-score']),
    };

    const ranker = await vectoriser(o, flags.embedding);
    const sees = flags.audience ? [flags.audience] : audiences(o);

    let rec: Recollection;
    try {
        const index = new MemoryIndex({ store: o.store, embedder: ranker.embedder });
        rec = await index.search(query, sees, { stale: flags.all });
    } catch (err) {
        if (err instanceof MemoryError) {
            throw new CliError(err.message, EXIT.usage, err.hint);
        }
        throw err;
    }

    if (asJson) {
        json({
            query,
            sees,
            // Named field by field: the ranker carries the embedder itself,
            // which is a client object and no part of an answer.
            ranking: { by: ranker.by, model: ranker.model, reason: ranker.reason },
            seeds: rec.seeds,
            truncated: rec.truncated,
            nodes: rec.nodes.map((n) => ({
                id: n.node.id,
                kind: n.node.kind,
                score: n.score,
                seed: n.seed,
                via: n.via,
                text: n.node.text,
                file: n.node.file ? hostPath(o.dir, n.node.file) : undefined,
            })),
            edges: rec.edges,
            // Verbatim, because it is the thing that went into a prompt.
            block: renderRecollection(rec, { tagged: false }),
        });
        return;
    }
    if (flags['ids-only']) {
        writeAll(rec.nodes.map((n) => n.node.id));
        return;
    }
    if (!rec.nodes.length) {
        note(`nothing recalled for ${text}`);
        ranking(ranker);
        return;
    }

    write(renderRecollection(rec, { tagged: false }));
    write();
    ranking(ranker);
}

interface Ranker {
    embedder?: Embedder;
    by: 'meaning' | 'term overlap';
    model?: string;
    /** why the ranking is not the one an agent gets */
    reason?: string;
}

/**
 * The embedder the project ranks with. Reproducing a recall means reproducing
 * its vectors, so the ref is resolved through the same alias table a run uses
 * and the keyring is materialised the same way.
 *
 * What cannot be built falls back to term overlap rather than failing, because
 * a graph whose credentials have gone missing is one worth looking at. The
 * fallback is a different ranking, though, so it is reported rather than passed
 * off as recall.
 */
async function vectoriser(o: Opened, override?: string): Promise<Ranker> {
    // A memory with no vectors cannot be ranked by meaning whatever we build:
    // embedding a query against an empty block finds nothing, which would read
    // as "nothing is remembered" rather than "there is nothing to rank with".
    if (!o.store.embedding) {
        return { by: 'term overlap', reason: 'this memory holds no vectors' };
    }
    const config = o.at?.config;
    const declared =
        override ?? config?.memory?.embedding ?? config?.embedding ?? o.store.embedding.model;
    // The project's own file first, then the keyring — the order `zen run`
    // uses, so a query embeds here exactly when it would embed there.
    if (o.at) {
        loadProjectEnv(o.at.root);
    }
    (await KeyStore.open()).materialize();
    try {
        const ref = config?.embeddings?.[declared] ?? declared;
        const embedder = createEmbedder(ref as EmbeddingRef);
        return { embedder, by: 'meaning', model: embedder.id };
    } catch (err) {
        return { by: 'term overlap', reason: err instanceof Error ? err.message : String(err) };
    }
}

/**
 * Which ranking that was. A lexical fallback is not what an agent sees, and a
 * block that looked like recall without being it would send someone chasing a
 * difference that exists only in this command.
 */
function ranking(r: Ranker): void {
    if (r.by === 'meaning') {
        note(dim(`ranked by meaning · ${r.model}`));
        return;
    }
    note(yellow('ranked by term overlap — this is not the order an agent sees'));
    if (r.reason) {
        note(dim(`  ${r.reason}`));
    }
}

/**
 * Every label the graph uses. `recall` masks against a list rather than taking
 * `undefined` for "no mask", so reading unmasked has to be spelled out — and
 * spelling it out from the graph is exact, since a label nothing carries can
 * hide nothing.
 */
function audiences(o: Opened): string[] {
    return [...new Set(o.store.graph.nodes().flatMap((n) => n.audience))];
}

/** Absent stays absent, so the engine's own default is the one on display. */
function whole(value: string | undefined, flag: string, min = 1): number | undefined {
    if (value === undefined) {
        return undefined;
    }
    const n = Number(value);
    if (!Number.isInteger(n) || n < min) {
        throw usageError(`${flag} wants a whole number ${min} or more, got ${value}`, USAGE);
    }
    return n;
}

function threshold(value: string | undefined): number | undefined {
    if (value === undefined) {
        return undefined;
    }
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
        throw usageError(`--min-score wants a number from 0 to 1, got ${value}`, USAGE);
    }
    return n;
}

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

/**
 * The exhaustive read, and the counterpart to recall rather than a variant of
 * it. Recall ranks, and a ranking returns the top of a list, so it cannot tell
 * "there is nothing" from "nothing was close enough" — which is the question
 * anyone actually has when they come to a memory looking for a name, a path or
 * a command they think an agent wrote down.
 */
async function grep(o: Opened, rest: string[], flags: Flags, asJson: boolean): Promise<void> {
    const pattern = rest[0];
    if (!pattern || rest.length > 1) {
        throw usageError('grep takes exactly one pattern', 'zen memory grep <pattern>');
    }
    const limit = Number(flags.limit ?? LISTED);
    if (!Number.isInteger(limit) || limit < 1) {
        throw usageError(`--limit wants a positive whole number, got ${flags.limit}`, USAGE);
    }
    for (const field of flags.in ?? []) {
        if (!(GREP_FIELDS as readonly string[]).includes(field)) {
            throw usageError(`--in wants one of ${GREP_FIELDS.join(', ')}, got ${field}`, USAGE);
        }
    }

    let res;
    try {
        res = await grepMemory(o.store, pattern, {
            // Unmasked, like everything else here: this is the person who owns
            // the files, not an agent inside a run.
            kinds: flags.kind ? [flags.kind] : undefined,
            audience: flags.audience,
            files: flags.files,
            in: flags.in as GrepField[] | undefined,
            stale: flags.stale ? 'only' : flags.all ? 'include' : 'exclude',
            regex: flags.regex,
            caseSensitive: flags['case-sensitive'],
            limit,
        });
    } catch (err) {
        if (err instanceof MemoryError) {
            throw new CliError(err.message, EXIT.usage, err.hint);
        }
        throw err;
    }

    if (asJson) {
        json({
            found: res.found,
            truncated: res.truncated,
            matches: res.matches.map((m) => ({
                id: m.node.id,
                kind: m.node.kind,
                stale: m.stale,
                file: m.node.file ? hostPath(o.dir, m.node.file) : undefined,
                hits: m.hits,
                more: m.more,
            })),
            unsearched: res.skipped.map((s) => ({ ...s, path: hostPath(o.dir, s) })),
        });
        return;
    }
    if (flags['ids-only']) {
        writeAll(res.matches.map((m) => m.node.id));
        return;
    }
    if (!res.found) {
        note(`nothing matches ${pattern}`);
        unsearched(o, res.skipped);
        return;
    }

    for (const m of res.matches) {
        write(
            cyan(m.node.id) +
                ' ' +
                m.node.kind +
                (m.stale ? ' ' + yellow('superseded') : '') +
                (m.node.file ? ' ' + dim(hostPath(o.dir, m.node.file)) : ''),
        );
        writeAll(table(m.hits.map((h) => [`  ${dim(h.where + ':' + h.line)}`, clip(h.text, 120)])));
        if (m.more) {
            write(dim(`  … ${count(m.more, 'more line')} in this node`));
        }
        write();
    }
    if (res.truncated) {
        note(dim(`${res.found - res.matches.length} more nodes — raise --limit`));
    }
    unsearched(o, res.skipped);
}

/**
 * Named rather than counted. A file that was not read is a hole in an answer
 * whose whole value is that it has none, so the ids have to be printable.
 */
function unsearched(o: Opened, skipped: readonly SkippedFile[]): void {
    if (!skipped.length) {
        return;
    }
    write();
    note(yellow(`${count(skipped.length, 'file')} not searched`));
    writeAll(table(skipped.map((s) => [`  ${cyan(s.id)}`, dim(s.reason), hostPath(o.dir, s)])));
}

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

function show(o: Opened, ids: string[], asJson: boolean): void {
    const id = ids[0];
    if (!id || ids.length > 1) {
        throw usageError('show takes exactly one id', 'zen memory show <id>');
    }
    const node = o.store.graph.get(id);
    if (!node) {
        throw usageError(`no node ${id}`, 'list them with `zen memory ls`');
    }
    const links = o.store.graph.neighbors(id);

    if (asJson) {
        json({
            node: onHost(o, node),
            links,
            file: node.file ? hostPath(o.dir, node.file) : undefined,
        });
        return;
    }

    write(bold(node.id) + ' ' + cyan(node.kind));
    write();
    writeAll(
        table([
            [dim('revision'), String(node.revision)],
            [dim('used'), `${node.useCount}× · last ${ago(node.lastUsedAt)}`],
            [dim('created'), `${node.createdAt} ${dim(ago(node.createdAt))}`],
            [dim('updated'), node.updatedAt],
            [dim('audience'), node.audience.join(', ')],
        ]),
    );
    write();
    write(node.text);

    if (node.metadata) {
        write();
        write(dim('metadata'));
        write(JSON.stringify(node.metadata, null, 2));
    }
    if (node.file) {
        write();
        write(dim('file'));
        writeAll(
            table([
                [dim('  path'), hostPath(o.dir, node.file)],
                [dim('  size'), bytes(node.file.bytes)],
                [dim('  sha256'), node.file.sha256],
            ]),
        );
    }
    write();
    write(dim(`links (${links.length})`));
    if (!links.length) {
        note(dim('  nothing points here and it points nowhere'));
        return;
    }
    writeAll(
        table(
            links.map((e) => {
                const out = e.source === id;
                const other = out ? e.target : e.source;
                return [
                    `  ${out ? '→' : '←'} ${yellow(e.relation)}`,
                    cyan(other),
                    clip(o.store.graph.get(other)?.text ?? '', 48),
                ];
            }),
        ),
    );
}

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

async function diff(o: Opened, rest: string[], cwd: string, asJson: boolean): Promise<void> {
    if (rest.length !== 1) {
        throw usageError(
            'diff takes exactly one base memory',
            'zen memory diff <base> [--dir <dir>]',
        );
    }
    const at = resolve(cwd, rest[0]!);
    if (!isMemory(at)) {
        throw usageError(`${at} is not a memory`, `no ${MEMORY_DB} in it`);
    }
    const base = await MemoryStore.open(at, { readOnly: true });
    try {
        const d = diffMemories(base, o.store);
        const mine = (n: MemoryNode): MemoryNode => onHost(o, n);
        const theirs = (n: MemoryNode): MemoryNode =>
            n.file ? { ...n, file: { ...n.file, path: hostPath(at, n.file) } } : n;

        if (asJson) {
            json({
                ...d,
                added: d.added.map((a) => ({ ...a, node: mine(a.node) })),
                revised: d.revised.map((r) => ({ before: theirs(r.before), after: mine(r.after) })),
                used: d.used.map((u) => ({ ...u, node: mine(u.node) })),
                removed: d.removed.map(theirs),
            });
            return;
        }

        const twins = d.added.filter((a) => a.twin).length;
        write(bold(o.dir) + dim(` against ${at} · nearest by ${d.by}`));
        write();
        write(
            `${bold('added')} ${d.added.length}` +
                (twins ? ` · ${yellow(`${twins} already held`)}` : '') +
                ` · ${bold('revised')} ${d.revised.length}` +
                ` · ${bold('used')} ${d.used.length}` +
                ` · ${bold('removed')} ${d.removed.length}` +
                ` · ${bold('edges')} +${d.edges}`,
        );
        if (d.added.length) {
            write();
            write(dim('added'));
            writeAll(
                textLast(
                    d.added.map((a) => [
                        `  ${cyan(a.node.id)}`,
                        a.node.kind,
                        a.node.audience.join(','),
                        a.nearest
                            ? `${a.twin ? yellow('twin of') : dim('near')} ${a.nearest.id} ${dim(a.nearest.score.toFixed(2))}`
                            : dim('nothing near'),
                    ]),
                    d.added.map((a) => a.node.text),
                ),
            );
        }
        if (d.revised.length) {
            write();
            write(dim('revised'));
            writeAll(
                textLast(
                    d.revised.map((r) => [
                        `  ${cyan(r.after.id)}`,
                        r.after.kind,
                        dim(`r${r.before.revision} → r${r.after.revision}`),
                    ]),
                    d.revised.map((r) => r.after.text),
                ),
            );
        }
        if (d.used.length) {
            write();
            write(dim('used — returned by memory_load'));
            writeAll(
                textLast(
                    d.used.map((u) => [`  ${cyan(u.node.id)}`, u.node.kind, `${u.loads}×`]),
                    d.used.map((u) => u.node.text),
                ),
            );
        }
        if (d.removed.length) {
            write();
            write(dim('removed'));
            writeAll(
                textLast(
                    d.removed.map((n) => [`  ${cyan(n.id)}`, n.kind]),
                    d.removed.map((n) => n.text),
                ),
            );
        }
        if (d.supersedes.length) {
            write();
            write(dim('supersedes'));
            writeAll(table(d.supersedes.map((s) => [`  ${cyan(s.source)}`, '→', cyan(s.target)])));
        }
    } finally {
        base.release();
    }
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

async function write_(
    o: Opened,
    rest: string[],
    flags: Flags,
    cwd: string,
    asJson: boolean,
): Promise<void> {
    if (rest.length > 1) {
        throw usageError('export takes at most one file name', 'zen memory export [file]');
    }
    const named = rest[0] ?? flags.out ?? 'memory.html';
    const target = isAbsolute(named) ? named : resolve(cwd, named);

    const built = await buildMemoryReport(o.store, { title: `${o.project} · memory` });
    const report = { ...built, nodes: built.nodes.map((n) => onHost(o, n)) };
    await writeFile(target, renderMemoryHtml(report), 'utf8');

    if (asJson) {
        json({
            path: target,
            from: o.dir,
            nodes: report.nodes.length,
            edges: report.edges.length,
        });
    } else {
        note(
            `${green('wrote')} ${target} ${dim(
                `· ${count(report.nodes.length, 'node')}, ${count(report.edges.length, 'edge')}` +
                    ` · from ${o.dir}`,
            )}`,
        );
    }
    if (flags.open) {
        reveal(target);
    }
}

/**
 * Handing a path to the platform opener. `spawn` without a shell, so the path
 * is an argument rather than something a shell gets to interpret.
 */
function reveal(target: string): void {
    const command =
        process.platform === 'darwin'
            ? 'open'
            : process.platform === 'win32'
              ? 'explorer'
              : 'xdg-open';
    spawn(command, [target], { stdio: 'ignore', detached: true }).unref();
}

// ---------------------------------------------------------------------------
// merge
// ---------------------------------------------------------------------------

/**
 * Warming a memory is parallel work, and a batch gives every item its own
 * copy, so N runs produce N memories rather than one. This is the other half of
 * that: it folds them back together, offline and without a model.
 *
 * Divergence refuses rather than guesses. Two copies of the same memory that
 * disagree are a question about which piece of work was right, and answering
 * it silently is how a merge loses the answer.
 */
async function merge(
    o: Opened,
    dirs: string[],
    flags: Flags,
    cwd: string,
    asJson: boolean,
): Promise<void> {
    if (!dirs.length) {
        throw usageError(
            'merge takes at least one memory directory',
            'zen memory merge <dir...> [--dir <into>]',
        );
    }
    const dryRun = flags['dry-run'] === true;
    const held = o.store.graph.order;

    if (held && !dryRun && !flags.yes) {
        if (!isInteractive()) {
            throw usageError(
                `${o.project} already remembers ${count(held, 'node')}`,
                'pass --yes, or --dry-run to see what would change first',
            );
        }
        note(
            `${count(dirs.length, 'memory', 'memories')} into ${bold(o.dir)} ` +
                dim(`· ${count(held, 'node')} already there`),
        );
        if (!(await confirm('Merge?'))) {
            note('nothing merged');
            return;
        }
    }

    let report: MergeReport;
    try {
        report = await mergeMemories(
            o.store,
            dirs.map((d) => resolve(cwd, d)),
            { dedupe: !flags['no-dedupe'], force: flags.force, dryRun },
        );
    } catch (err) {
        if (err instanceof MergeConflicts) {
            throw diverged(err, asJson);
        }
        throw err;
    }

    if (asJson) {
        json(report);
        return;
    }
    writeAll(
        table([
            [dim('memory'), dim('nodes'), dim('new'), dim('shared'), dim('folded'), dim('files')],
            ...report.sources.map((s) => [
                s.dir,
                String(s.nodes),
                s.added ? green(String(s.added)) : '0',
                String(s.shared),
                s.twins ? yellow(String(s.twins)) : '0',
                String(s.files),
            ]),
        ]),
    );
    write();
    const summary = [
        count(report.added, 'node'),
        `${count(report.edges, 'edge')}`,
        `${report.twins} folded`,
    ].join(', ');
    note(dryRun ? `${yellow('would add')} ${summary}` : `${green('merged')} ${summary}`);
}

/**
 * A refusal with the ids to look at. It is deliberately not a summary: the
 * point of stopping is that a person decides, and they cannot decide from a
 * count.
 */
function diverged(err: MergeConflicts, asJson: boolean): CliError {
    if (asJson) {
        json({ error: err.message, conflicts: err.conflicts });
    } else {
        writeAll(
            table(
                err.conflicts.map((c) => [
                    cyan(c.id),
                    dim(`r${c.mine} ↔ r${c.theirs}`),
                    clip(c.text, 48),
                    dim(c.dir),
                ]),
            ),
        );
        write();
    }
    return new CliError(err.message, EXIT.failed, err.hint);
}

// ---------------------------------------------------------------------------
// forget
// ---------------------------------------------------------------------------

/**
 * The only destructive thing here, and it is deliberately not the way to fix a
 * memory that turned out wrong — that is a new node and a `SUPERSEDES` edge,
 * which keeps the reason it changed. This is for what should never have been
 * written down: it takes the node, its vector and its file bytes together.
 */
async function forget(o: Opened, ids: string[], flags: Flags, asJson: boolean): Promise<void> {
    if (!ids.length) {
        throw usageError('forget takes at least one id', 'zen memory forget <id...>');
    }
    const found: MemoryNode[] = [];
    for (const id of ids) {
        const node = o.store.graph.get(id);
        if (!node) {
            throw usageError(`no node ${id}`, 'list them with `zen memory ls`');
        }
        found.push(node);
    }

    if (!flags.yes) {
        if (!isInteractive()) {
            throw usageError('refusing to remove without confirmation', 'pass --yes');
        }
        writeAll(table(found.map((n) => [cyan(n.id), n.kind, clip(n.text, 56)])));
        write();
        if (!(await confirm(`Forget ${count(found.length, 'node')}?`))) {
            note('nothing removed');
            return;
        }
    }

    // The vector and the bytes go with the node, which `MemoryIndex` already
    // guarantees; `sees` is every audience in the graph, because this command
    // is the person who owns the files rather than an agent inside a run.
    const index = new MemoryIndex({ store: o.store });
    await index.forget(
        found.map((n) => n.id),
        [ALL_AGENTS, ...new Set(o.store.graph.nodes().flatMap((n) => n.audience))],
    );

    if (asJson) {
        json({ forgotten: found.map((n) => n.id) });
    } else {
        note(`${green('forgot')} ${count(found.length, 'node')}`);
    }
}

// ---------------------------------------------------------------------------
// migrate
// ---------------------------------------------------------------------------

/** Once per memory: the version 1 files are kept in `v1/`, not deleted. */
async function migrate(o: Omit<Opened, 'store'>, asJson: boolean): Promise<void> {
    let report;
    try {
        report = await migrateMemory(o.dir);
    } catch (err) {
        if (err instanceof MemoryError) {
            throw new CliError(err.message, EXIT.failed, err.hint);
        }
        throw err;
    }
    if (asJson) {
        json(report);
        return;
    }
    note(
        `${green('migrated')} ${o.dir} ${dim(
            `· ${count(report.nodes, 'node')}, ${count(report.edges, 'edge')}, ` +
                `${count(report.vectors, 'vector')} · the old files are in ${report.legacy}`,
        )}`,
    );
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

function clip(text: string, n: number): string {
    const one = text.replace(/\s+/g, ' ').trim();
    return one.length > n ? one.slice(0, n - 1) + '…' : one;
}

/**
 * A table whose last column is the text: cut to what the terminal has left,
 * and whole when nobody is looking at a terminal — a pipe or an agent wants all of it.
 */
function textLast(rows: string[][], texts: string[]): string[] {
    const widths = rows[0]?.map((_, c) => Math.max(...rows.map((r) => plain(r[c] ?? '').length)));
    const room = process.stdout.isTTY
        ? Math.max(
              24,
              (process.stdout.columns || 120) - (widths ?? []).reduce((t, w) => t + w + 2, 0),
          )
        : Infinity;
    return table(rows.map((r, i) => [...r, clip(texts[i] ?? '', room)]));
}

/** The stored `/memory/<id>.<ext>` names the file, not where it is; a terminal needs the host path. */
function onHost<T extends { file?: MemoryFile }>(o: Opened, n: T): T {
    return n.file ? { ...n, file: { ...n.file, path: hostPath(o.dir, n.file) } } : n;
}
