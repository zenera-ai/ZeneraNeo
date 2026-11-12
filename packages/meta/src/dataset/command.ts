import { anyOf, loose, matcher, type Matcher, PatternError } from '@zenera/neo';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
    bold,
    cyan,
    dim,
    green,
    invalidError,
    json,
    note,
    parse,
    red,
    table,
    usageError,
    write,
    writeAll,
    yellow,
} from '../../host.ts';
import { sessionKept } from '../../tokens.ts';
import { type Plan, planApply, planEdit, planIgnored, planStatus } from './changes.ts';
import { drift } from './drift.ts';
import { batchInput, dump } from './export.ts';
import {
    type Criteria,
    type Draw,
    lastVerdict,
    matches,
    type NotesOf,
    ORDER_KEYS,
    type OrderKey,
    sample,
    STRATA_FIELDS,
    type StratumField,
} from './sample.ts';
import { readAnchor, readProposal } from './schema.ts';
import { DatasetStore, whoIsThis } from './store.ts';
import {
    type Anchor,
    anchorText,
    type Case,
    COMPLEXITIES,
    type Complexity,
    type JournalRow,
    NOTE_KINDS,
    type NoteKind,
    type NoteRow,
    sameAnchor,
    type Verdict,
    VERDICTS,
} from './types.ts';

// ---------------------------------------------------------------------------
// zen meta dataset
//
// The only writer of `dataset/`. An extraction is the model's work and stays
// in the prompt; everything after it — what changed, which revision, who did it,
// what drifted, what to run next — is bookkeeping, and bookkeeping a model half
// does is worse than none. So it is all here, and the prompt calls it.
// ---------------------------------------------------------------------------

export const DATASET_USAGE = 'zen meta dataset <verb> [args] [options]';

export const DATASET_HELP = [
    'Dataset:',
    '  zen meta dataset [status]                 revision, counts, drift',
    '  zen meta dataset ls [filters]             the cases, one row each',
    '  zen meta dataset show <id[@rev]>...       cases in full, now or at a revision',
    '  zen meta dataset log [id...]              changes and notes, with their sessions',
    '  zen meta dataset drift [--all]            which cases their sources moved under',
    '  zen meta dataset apply <file> --why <w>   write a proposal (--partial, --dry-run)',
    '  zen meta dataset update <id> --why <w>    --set k=v, --rubric-add/-edit/-drop, --tag-add/-drop',
    '  zen meta dataset retire|restore <id>...   take a case out of use, or back',
    '  zen meta dataset reanchor <id> --why <w>  --file, --heading or --pointer',
    '  zen meta dataset ignore <file> --why <w>  a section that holds no case (--drop to undo)',
    '  zen meta dataset note <id>... -m <text>   --kind, --run, --verdict, --rubric r1=pass,...',
    '  zen meta dataset sample [filters]         draw cases: -n, --seed, --by, --weight, --order',
    '  zen meta dataset export [id...]           cases out: --format cases|batch, -o <file>',
    '',
    'Filters (ls, sample, export): --class, --complexity, --tag, --status, --rubric yes|no,',
    '  --expected yes|no, --id <glob>, --exclude <glob>, --ids-from <file>, --at <rev>,',
    '  --changed-since <rev>, --restarted, --verdict, --never-graded, --note <kind>,',
    '  --graded-in <run>, --source <glob>, --anchor <glob>, --grep <text> (--regex, --case-sensitive)',
];

export const DATASET_SUMMARY =
    'The cases the project is evaluated on: read from sources, revised, sampled.';

/** The page `zen meta dataset --help` prints. */
export const DATASET_DETAILS = [
    'Verbs:',
    ...DATASET_HELP.slice(1),
    '',
    'Sampling (sample): --by <class,complexity,tag,source,rubric,verdict|none> groups the',
    '  cases (default class), --order <rubric,complexity,verdict,rev,id> ranks inside a',
    '  group (default rubric,complexity), --weight <group>=<w> gives a group more turns,',
    '  -n <count>, --seed <n>. A larger -n keeps every case a smaller one chose.',
    '',
    'Output (sample, export): --format ids|batch|cases|json, -o <file>. batch is',
    '  zen run batch input and never holds a rubric.',
    '',
    'Every write needs --why and is a new revision; only a change to input, rubric',
    'or expected restarts a case. Only this command writes dataset/. Build or refresh',
    'it from its sources with: zen meta run /dataset',
    '',
    'Examples:',
    '  zen meta dataset',
    '  zen meta dataset drift',
    '  zen meta dataset sample --rubric yes -n 12 --format batch -o cases.json',
    '  zen meta dataset log plan-day',
];

interface Flags {
    project?: string;
    why?: string;
    partial?: boolean;
    'dry-run'?: boolean;
    all?: boolean;
    set?: string[];
    'rubric-add'?: string[];
    'rubric-edit'?: string[];
    'rubric-drop'?: string[];
    'tag-add'?: string[];
    'tag-drop'?: string[];
    override?: boolean;
    file?: string;
    heading?: string;
    pointer?: string;
    drop?: boolean;
    message?: string;
    kind?: string;
    run?: string;
    verdict?: string[];
    rubric?: string;
    class?: string[];
    complexity?: string[];
    tag?: string[];
    status?: string;
    expected?: string;
    id?: string[];
    exclude?: string[];
    'ids-from'?: string;
    at?: string;
    'changed-since'?: string;
    restarted?: boolean;
    'never-graded'?: boolean;
    note?: string[];
    'graded-in'?: string[];
    source?: string[];
    anchor?: string[];
    grep?: string;
    regex?: boolean;
    'case-sensitive'?: boolean;
    by?: string;
    weight?: string[];
    order?: string;
    count?: string;
    seed?: string;
    format?: string;
    out?: string;
    quiet?: boolean;
}

const OPTIONS = {
    project: { type: 'string' },
    why: { type: 'string' },
    partial: { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    all: { type: 'boolean' },
    set: { type: 'string', multiple: true },
    'rubric-add': { type: 'string', multiple: true },
    'rubric-edit': { type: 'string', multiple: true },
    'rubric-drop': { type: 'string', multiple: true },
    'tag-add': { type: 'string', multiple: true },
    'tag-drop': { type: 'string', multiple: true },
    override: { type: 'boolean' },
    file: { type: 'string' },
    heading: { type: 'string' },
    pointer: { type: 'string' },
    drop: { type: 'boolean' },
    message: { type: 'string', short: 'm' },
    kind: { type: 'string' },
    run: { type: 'string' },
    verdict: { type: 'string', multiple: true },
    rubric: { type: 'string' },
    class: { type: 'string', multiple: true },
    complexity: { type: 'string', multiple: true },
    tag: { type: 'string', multiple: true },
    status: { type: 'string' },
    expected: { type: 'string' },
    id: { type: 'string', multiple: true },
    exclude: { type: 'string', multiple: true },
    'ids-from': { type: 'string' },
    at: { type: 'string' },
    'changed-since': { type: 'string' },
    restarted: { type: 'boolean' },
    'never-graded': { type: 'boolean' },
    note: { type: 'string', multiple: true },
    'graded-in': { type: 'string', multiple: true },
    source: { type: 'string', multiple: true },
    anchor: { type: 'string', multiple: true },
    grep: { type: 'string' },
    regex: { type: 'boolean' },
    'case-sensitive': { type: 'boolean' },
    by: { type: 'string' },
    weight: { type: 'string', multiple: true },
    order: { type: 'string' },
    count: { type: 'string', short: 'n' },
    seed: { type: 'string' },
    format: { type: 'string' },
    out: { type: 'string', short: 'o' },
    quiet: { type: 'boolean' },
} as const;

const VERBS = [
    'status',
    'ls',
    'show',
    'log',
    'drift',
    'apply',
    'update',
    'retire',
    'restore',
    'reanchor',
    'ignore',
    'note',
    'sample',
    'export',
] as const;

export interface DatasetContext {
    readonly args: readonly string[];
    readonly json: boolean;
    readonly cwd: string;
}

/** Only the project flag, read ahead of resolving the project the rest is about. */
export function datasetProjectFlag(args: readonly string[]): string | undefined {
    return parse<Flags>(args, OPTIONS, DATASET_USAGE).values.project;
}

export async function runDataset(
    ctx: DatasetContext,
    project: { dir: string; name: string },
): Promise<void> {
    const { values, positionals } = parse<Flags>(ctx.args, OPTIONS, DATASET_USAGE);
    const [verb = 'status', ...rest] = positionals;
    if (!(VERBS as readonly string[]).includes(verb)) {
        throw usageError(`unknown dataset verb: ${verb}`, `one of: ${VERBS.join(', ')}`);
    }
    const run: Run = { ctx, values, rest, root: project.dir, project: project.name };
    switch (verb as (typeof VERBS)[number]) {
        case 'status':
            return status(run);
        case 'ls':
            return list(run);
        case 'show':
            return show(run);
        case 'log':
            return log(run);
        case 'drift':
            return driftCommand(run);
        case 'apply':
            return apply(run);
        case 'update':
            return update(run);
        case 'retire':
        case 'restore':
            return setStatus(run, verb === 'retire' ? 'retired' : 'active');
        case 'reanchor':
            return reanchor(run);
        case 'ignore':
            return ignore(run);
        case 'note':
            return addNote(run);
        case 'sample':
            return draw(run, 'sample');
        case 'export':
            return draw(run, 'export');
    }
}

interface Run {
    ctx: DatasetContext;
    values: Flags;
    rest: string[];
    root: string;
    project: string;
}

// ---------------------------------------------------------------------------
// Small readers
// ---------------------------------------------------------------------------

function whole(text: string | undefined, flag: string, min = 0): number | undefined {
    if (text === undefined) {
        return undefined;
    }
    const n = Number(text);
    if (!Number.isInteger(n) || n < min) {
        throw usageError(`${flag} takes a whole number of at least ${min}`, `got "${text}"`);
    }
    return n;
}

function yesNo(text: string | undefined, flag: string): boolean | undefined {
    if (text === undefined) {
        return undefined;
    }
    if (text !== 'yes' && text !== 'no') {
        throw usageError(`${flag} takes yes or no`, `got "${text}"`);
    }
    return text === 'yes';
}

function oneOf<T extends string>(
    values: readonly string[] | undefined,
    known: readonly string[],
    flag: string,
): T[] | undefined {
    if (!values || values.length === 0) {
        return undefined;
    }
    const wrong = values.filter((v) => !known.includes(v));
    if (wrong.length > 0) {
        throw usageError(
            `${flag} ${wrong.map((w) => `"${w}"`).join(', ')} names nothing in this dataset`,
            `known: ${[...known].sort().join(', ') || '(none)'}`,
        );
    }
    return values as T[];
}

function patterns(
    values: readonly string[] | undefined,
    flag: string,
    regex = false,
    caseSensitive = false,
): Matcher | undefined {
    try {
        return anyOf((values ?? []).map((p) => loose(p, { regex, caseSensitive })));
    } catch (err) {
        if (err instanceof PatternError || err instanceof SyntaxError) {
            throw usageError(`${flag}: ${err.message}`);
        }
        throw err;
    }
}

function needWhy(values: Flags): string {
    const why = values.why?.trim();
    if (!why) {
        throw usageError(
            'a write needs --why <reason>',
            'say what changed in the source, or why by hand',
        );
    }
    return why;
}

function readJsonFile(file: string): unknown {
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
        throw invalidError(`${file}: ${(err as Error).message}`);
    }
}

/** Opens for writing, runs, and always lets go. */
function writing<T>(root: string, fn: (store: DatasetStore) => T): T {
    const store = DatasetStore.open(root, { write: true });
    try {
        return fn(store);
    } finally {
        store.release();
    }
}

function requireDataset(store: DatasetStore): void {
    if (!store.exists()) {
        throw invalidError(`no dataset in ${store.dir}`, 'build one: zen meta run /dataset');
    }
}

const notesOf = (store: DatasetStore): NotesOf => {
    const cache = new Map<string, NoteRow[]>();
    return (c) => {
        let found = cache.get(c.id);
        if (!found) {
            found = store.journal(c.id).filter((r): r is NoteRow => r.type === 'note');
            cache.set(c.id, found);
        }
        return found;
    };
};

/** The cases as they stand, or as they stood at `--at`. */
function casesAt(store: DatasetStore, at: number | undefined): Case[] {
    if (at === undefined) {
        return store.all();
    }
    if (at > store.manifest.revision) {
        throw usageError(`--at ${at} is past the latest revision, ${store.manifest.revision}`);
    }
    return store.ids().flatMap((id) => store.at(id, at) ?? []);
}

function inputText(c: Case): string {
    if (typeof c.input === 'string') {
        return c.input;
    }
    return c.input
        .map((p) => (typeof p === 'string' ? p : 'text' in p ? p.text : `[${Object.keys(p)[0]}]`))
        .join(' ');
}

// ---------------------------------------------------------------------------
// Criteria, shared by ls / sample / export
// ---------------------------------------------------------------------------

function criteriaOf(
    run: Run,
    store: DatasetStore,
    cases: readonly Case[],
    at: number | undefined,
): Criteria {
    const v = run.values;
    const status = v.status ?? 'active';
    if (!['active', 'retired', 'all'].includes(status)) {
        throw usageError('--status takes active, retired or all', `got "${status}"`);
    }
    const classes = new Set(cases.map((c) => c.class ?? 'unclassified'));
    const tags = new Set(cases.flatMap((c) => c.tags ?? []));
    let idsFrom: Set<string> | undefined;
    if (v['ids-from']) {
        idsFrom = idsIn(readFileIds(resolve(run.ctx.cwd, v['ids-from'])));
    }
    let restarted: Set<string> | undefined;
    if (v.restarted) {
        const rev = at ?? store.manifest.revision;
        restarted = new Set(store.revisions().find((r) => r.rev === rev)?.restarted ?? []);
    }
    const kinds = oneOf<NoteKind>(v.note, NOTE_KINDS, '--note');
    return {
        status: status as Criteria['status'],
        classes: oneOf(v.class, [...classes], '--class'),
        complexities: oneOf(v.complexity, [...COMPLEXITIES, 'unrated'], '--complexity'),
        tags: oneOf(v.tag, [...tags], '--tag'),
        rubric: yesNo(v.rubric, '--rubric'),
        expected: yesNo(v.expected, '--expected'),
        ids: patterns(v.id, '--id'),
        exclude: patterns(v.exclude, '--exclude'),
        ...(idsFrom ? { idsFrom } : {}),
        changedSince: whole(v['changed-since'], '--changed-since'),
        ...(restarted ? { restarted } : {}),
        verdicts: oneOf<Verdict>(v.verdict, VERDICTS, '--verdict'),
        neverGraded: v['never-graded'],
        noteKinds: kinds,
        gradedIn: v['graded-in'],
        source: patterns(v.source, '--source'),
        anchor: patterns(v.anchor, '--anchor'),
        grep: v.grep
            ? (() => {
                  try {
                      return matcher(v.grep!, {
                          regex: v.regex,
                          caseSensitive: v['case-sensitive'],
                      });
                  } catch (err) {
                      throw usageError(`--grep: ${(err as Error).message}`);
                  }
              })()
            : undefined,
    };
}

function readFileIds(file: string): unknown {
    const text = (() => {
        try {
            return readFileSync(file, 'utf8');
        } catch (err) {
            throw usageError(`--ids-from: ${(err as Error).message}`);
        }
    })();
    try {
        return JSON.parse(text);
    } catch {
        return text.split(/\s+/).filter(Boolean);
    }
}

/** A list of ids, or any of the shapes that carry them: a sample, a batch, a dump. */
function idsIn(doc: unknown): Set<string> {
    const list = Array.isArray(doc)
        ? doc
        : doc && typeof doc === 'object'
          ? ((doc as Record<string, unknown>).ids ??
            (doc as Record<string, unknown>).batch ??
            (doc as Record<string, unknown>).cases)
          : undefined;
    if (!Array.isArray(list)) {
        throw usageError(
            '--ids-from names no ids',
            'a list of ids, or json with ids, batch or cases',
        );
    }
    return new Set(
        list.flatMap((x) =>
            typeof x === 'string'
                ? [x]
                : x && typeof x === 'object' && 'id' in x
                  ? [String(x.id)]
                  : [],
        ),
    );
}

// ---------------------------------------------------------------------------
// status / ls / show / log
// ---------------------------------------------------------------------------

function count(rows: readonly Case[], key: (c: Case) => string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const c of rows) {
        out[key(c)] = (out[key(c)] ?? 0) + 1;
    }
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

function status(run: Run): void {
    const store = DatasetStore.open(run.root);
    if (!store.exists()) {
        if (run.ctx.json) {
            return json({ dir: store.dir, exists: false });
        }
        note(`no dataset yet in ${store.dir}`);
        note(dim('build one: zen meta run /dataset'));
        return;
    }
    const all = store.all();
    const active = all.filter((c) => c.status === 'active');
    const report = drift(store);
    const unfinished = store.unfinished();
    const summary = {
        dir: store.dir,
        exists: true,
        revision: store.manifest.revision,
        cases: { active: active.length, retired: all.length - active.length },
        classes: count(active, (c) => c.class ?? 'unclassified'),
        complexity: count(active, (c) => c.complexity ?? 'unrated'),
        rubric: active.filter((c) => c.rubric.length > 0).length,
        sources: new Set([
            ...active.flatMap((c) => (c.source ? [c.source.file] : [])),
            ...store.manifest.ignored.map((i) => i.file),
        ]).size,
        ignored: store.manifest.ignored.length,
        drift: {
            clean: report.clean,
            changed: report.cases.filter((c) => c.state === 'changed').length,
            gone: report.cases.filter((c) => c.state === 'gone').length,
            uncovered: report.uncovered.length,
        },
        unfinished,
    };
    if (run.ctx.json) {
        return json(summary);
    }
    write(`${bold('revision')}  ${summary.revision}`);
    write(
        `${bold('cases')}     ${active.length} active, ${summary.cases.retired} retired, ${summary.rubric} with a rubric`,
    );
    write(
        `${bold('classes')}   ${Object.entries(summary.classes)
            .map(([k, n]) => `${k} ${n}`)
            .join(' · ')}`,
    );
    write(
        `${bold('complex')}   ${Object.entries(summary.complexity)
            .map(([k, n]) => `${k} ${n}`)
            .join(' · ')}`,
    );
    write(`${bold('sources')}   ${summary.sources} file(s), ${summary.ignored} section(s) ignored`);
    write(
        `${bold('drift')}     ${
            report.clean
                ? green('clean')
                : yellow(
                      `${summary.drift.changed} changed, ${summary.drift.gone} gone, ${summary.drift.uncovered} uncovered — zen meta dataset drift`,
                  )
        }`,
    );
    if (unfinished.length > 0) {
        write(
            red(
                `unfinished  ${unfinished.length} case(s) written past the manifest: an apply was interrupted — apply it again`,
            ),
        );
    }
}

function list(run: Run): void {
    const store = DatasetStore.open(run.root);
    requireDataset(store);
    const at = whole(run.values.at, '--at', 1);
    const cases = casesAt(store, at);
    const notes = notesOf(store);
    const criteria = criteriaOf(run, store, cases, at);
    const shown = cases.filter((c) => matches(c, criteria, notes));
    if (run.ctx.json) {
        return json(shown);
    }
    if (shown.length === 0) {
        note('no case matches');
        return;
    }
    writeAll(
        table([
            ['ID', 'REV', 'CLASS', 'COMPLEXITY', 'RUBRIC', 'VERDICT', 'TAGS'].map((h) => bold(h)),
            ...shown.map((c) => [
                c.status === 'retired' ? dim(c.id) : cyan(c.id),
                String(c.rev),
                c.class ?? dim('-'),
                c.complexity ?? dim('-'),
                String(c.rubric.length),
                lastVerdict(c, notes) ?? dim('-'),
                (c.tags ?? []).join(',') || dim('-'),
            ]),
        ]),
    );
    note(dim(`${shown.length} of ${cases.length} case(s)`));
}

function target(text: string): { id: string; rev?: number } {
    const at = text.lastIndexOf('@');
    if (at <= 0) {
        return { id: text };
    }
    const rev = whole(text.slice(at + 1), `${text}: the revision`, 1);
    return { id: text.slice(0, at), rev };
}

function show(run: Run): void {
    if (run.rest.length === 0) {
        throw usageError('show which case?', 'zen meta dataset show <id>[@rev]');
    }
    const store = DatasetStore.open(run.root);
    requireDataset(store);
    const found: Case[] = [];
    const missing: string[] = [];
    for (const text of run.rest) {
        const { id, rev } = target(text);
        const c = rev === undefined ? store.get(id) : store.at(id, rev);
        if (c) {
            found.push(c);
        } else {
            missing.push(text);
        }
    }
    if (missing.length > 0) {
        throw invalidError(
            `no such case: ${missing.join(', ')}`,
            'see: zen meta dataset ls --status all',
        );
    }
    if (run.ctx.json) {
        return json(found);
    }
    found.forEach((c, i) => {
        if (i > 0) {
            write('');
        }
        const facets = [c.class, c.complexity, ...(c.tags ?? [])].filter(Boolean).join(' · ');
        write(
            `${bold(cyan(c.id))}  rev ${c.rev}  ${c.status === 'active' ? c.status : yellow(c.status)}  ${dim(facets)}`,
        );
        if (c.source) {
            write(`${dim('source')}    ${c.source.file}  ${dim(anchorText(c.source.anchor))}`);
        }
        write(`${dim('input')}     ${inputText(c)}`);
        if (c.rubric.length > 0) {
            write(dim('rubric'));
            for (const r of c.rubric) {
                write(`  ${dim(r.id)}  ${r.text}`);
            }
        }
        if (c.expected) {
            write(`${dim('expected')}  ${c.expected}`);
        }
        if (c.notes) {
            write(`${dim('notes')}     ${c.notes}`);
        }
        if (c.overrides?.length) {
            write(`${dim('overrides')} ${c.overrides.join(', ')}`);
        }
    });
}

function who(by: { session?: string; prompt?: string }): string {
    return [by.prompt ? `/${by.prompt}` : '', by.session ? by.session.slice(0, 8) : '']
        .filter(Boolean)
        .join(' ');
}

function log(run: Run): void {
    const store = DatasetStore.open(run.root);
    requireDataset(store);
    const ids = run.rest.length > 0 ? run.rest : store.ids();
    const unknown = ids.filter((id) => !store.get(id));
    if (unknown.length > 0) {
        throw invalidError(`no such case: ${unknown.join(', ')}`);
    }
    const rows = ids
        .flatMap((id) =>
            store.journal(id).map((row) => {
                const { case: _case, ...rest } = row as JournalRow & { case?: Case };
                return { id, ...rest };
            }),
        )
        .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
    if (run.ctx.json) {
        return json(rows);
    }
    for (const row of rows) {
        const when = dim(row.at.slice(0, 16).replace('T', ' '));
        const by = dim(who(row.by));
        if (row.type === 'change') {
            const fields = row.changes.map((c) => c.path).join(', ');
            write(
                `${when}  ${cyan(row.id)}  rev ${row.rev} ${bold(row.op)}${fields ? ` ${fields}` : ''}  ${dim(`"${row.why}"`)}  ${by}`,
            );
        } else {
            const verdict = row.verdict
                ? row.verdict === 'right'
                    ? green(row.verdict)
                    : row.verdict === 'wrong'
                      ? red(row.verdict)
                      : yellow(row.verdict)
                : '';
            const where = row.run ? dim(`run ${row.run}`) : '';
            write(
                `${when}  ${cyan(row.id)}  rev ${row.caseRev} ${bold(row.kind)} ${[verdict, where].filter(Boolean).join(' ')}  ${row.text}  ${by}`,
            );
        }
    }
    const sessions = [
        ...new Set(rows.flatMap((r) => (r.by.session ? [r.by.session] : [])).reverse()),
    ];
    const kept = sessions.filter(sessionKept).slice(0, 5);
    if (kept.length > 0) {
        note('');
        for (const id of kept) {
            note(dim(`resume: zen meta resume ${run.project} ${id}`));
        }
    }
}

// ---------------------------------------------------------------------------
// drift
// ---------------------------------------------------------------------------

function driftCommand(run: Run): void {
    const store = DatasetStore.open(run.root);
    requireDataset(store);
    const report = drift(store, { all: run.values.all });
    if (run.ctx.json) {
        return json(report);
    }
    write(
        `revision ${report.revision} · ${report.unchanged} unchanged · ${report.untracked} with no source`,
    );
    for (const f of report.files) {
        const state = {
            missing: red('missing'),
            changed: yellow('changed'),
            unsettled: dim('unsettled'),
        }[f.state];
        write(`${state}  ${f.file}`);
    }
    for (const c of report.cases) {
        const tag = c.state === 'gone' ? red('gone   ') : yellow('changed');
        write(
            `  ${tag}  ${cyan(c.id)}  ${c.file} ${dim(anchorText(c.anchor))}${c.why ? dim(` — ${c.why}`) : ''}`,
        );
    }
    for (const u of report.uncovered) {
        write(`  ${dim('uncovered')}  ${u.file} ${anchorText(u.anchor)}`);
    }
    if (report.clean) {
        note(green('clean: every case matches its source'));
        return;
    }
    note('');
    note(
        dim('re-read those sections, then: zen meta dataset apply <proposal> --partial --why "…"'),
    );
    if (report.cases.some((c) => c.state === 'gone')) {
        note(dim('gone: retire the case, or reanchor it if the section was only renamed'));
    }
    if (report.uncovered.length > 0) {
        note(
            dim('uncovered: new cases, or zen meta dataset ignore <file> --heading "…" --why "…"'),
        );
    }
}

// ---------------------------------------------------------------------------
// The writes
// ---------------------------------------------------------------------------

function report(run: Run, plan: Plan, dryRun: boolean): void {
    const r = plan.revision;
    if (run.ctx.json) {
        return json({
            dryRun,
            revision: plan.rows.length > 0 ? plan.rev : plan.manifest.revision,
            added: r.added,
            updated: r.updated,
            retired: r.retired,
            restored: r.restored,
            restarted: r.restarted,
            refreshed: plan.refreshed.map((c) => c.id),
            unchanged: plan.unchanged.length,
            ...(dryRun
                ? {
                      changes: plan.rows.map((row) => ({
                          id: row.case.id,
                          op: row.op,
                          changes: row.changes,
                      })),
                  }
                : {}),
        });
    }
    const say = (label: string, ids: readonly string[], paint: (s: string) => string): void => {
        if (ids.length > 0) {
            write(`${paint(label)} ${ids.length}  ${ids.join(', ')}`);
        }
    };
    say('added    ', r.added, green);
    say('updated  ', r.updated, yellow);
    say('retired  ', r.retired, red);
    say('restored ', r.restored, green);
    say('restarted', r.restarted, bold);
    say(
        'refreshed',
        plan.refreshed.map((c) => c.id),
        dim,
    );
    if (dryRun) {
        for (const row of plan.rows.filter((x) => x.op !== 'add')) {
            write(dim(`  ${row.case.id}: ${row.changes.map((c) => c.path).join(', ')}`));
        }
        note(dim('dry run: nothing written'));
        return;
    }
    note(
        plan.rows.length > 0
            ? `revision ${plan.rev}${plan.unchanged.length ? dim(` · ${plan.unchanged.length} unchanged`) : ''}`
            : 'nothing changed',
    );
}

function apply(run: Run): void {
    const [file, ...extra] = run.rest;
    if (!file || extra.length > 0) {
        throw usageError(
            'apply takes one proposal file',
            'zen meta dataset apply <file> --why "…"',
        );
    }
    const at = resolve(run.ctx.cwd, file);
    const proposed = readProposal(readJsonFile(at), at, run.root);
    const dryRun = Boolean(run.values['dry-run']);
    const why = dryRun ? (run.values.why ?? '') : needWhy(run.values);
    const options = { partial: Boolean(run.values.partial), why, by: whoIsThis() };
    if (dryRun) {
        return report(run, planApply(DatasetStore.open(run.root), proposed, options), true);
    }
    writing(run.root, (store) => {
        const plan = planApply(store, proposed, options);
        store.commit(plan);
        report(run, plan, false);
    });
}

function keyValue(text: string, flag: string): [string, string] {
    const eq = text.indexOf('=');
    if (eq <= 0) {
        throw usageError(`${flag} takes key=value`, `got "${text}"`);
    }
    return [text.slice(0, eq).trim(), text.slice(eq + 1)];
}

const SETTABLE = ['class', 'complexity', 'expected', 'notes', 'input'] as const;

function update(run: Run): void {
    const [id, ...extra] = run.rest;
    if (!id || extra.length > 0) {
        throw usageError(
            'update takes one case id',
            'zen meta dataset update <id> --set class=x --why "…"',
        );
    }
    const v = run.values;
    const why = needWhy(v);
    const touched = new Set<string>();
    const sets = (v.set ?? []).map((s) => keyValue(s, '--set'));
    for (const [key, value] of sets) {
        if (!(SETTABLE as readonly string[]).includes(key)) {
            throw usageError(
                `--set ${key}: not a field --set can write`,
                `one of: ${SETTABLE.join(', ')}`,
            );
        }
        if (key === 'complexity' && value && !COMPLEXITIES.includes(value as Complexity)) {
            throw usageError(`complexity must be one of ${COMPLEXITIES.join(', ')}`);
        }
        if (key === 'input' && !value.trim()) {
            throw usageError('input cannot be empty');
        }
        touched.add(key);
    }
    const edits = (v['rubric-edit'] ?? []).map((s) => keyValue(s, '--rubric-edit'));
    if (v['rubric-add'] || v['rubric-edit'] || v['rubric-drop']) {
        touched.add('rubric');
    }
    if (v['tag-add'] || v['tag-drop']) {
        touched.add('tags');
    }
    if (touched.size === 0) {
        throw usageError(
            'nothing to update',
            'use --set, --rubric-add/-edit/-drop or --tag-add/-drop',
        );
    }
    writing(run.root, (store) => {
        const plan = planEdit(
            store,
            id,
            (c) => {
                const fields = c as unknown as Record<string, unknown>;
                for (const [key, value] of sets) {
                    if (value === '' && key !== 'input') {
                        delete fields[key];
                    } else {
                        fields[key] = value;
                    }
                }
                for (const [rid, text] of edits) {
                    const item = c.rubric.find((r) => r.id === rid);
                    if (!item) {
                        throw usageError(
                            `${id} has no rubric item ${rid}`,
                            `it has: ${c.rubric.map((r) => r.id).join(', ')}`,
                        );
                    }
                    item.text = text;
                }
                for (const rid of v['rubric-drop'] ?? []) {
                    if (!c.rubric.some((r) => r.id === rid)) {
                        throw usageError(`${id} has no rubric item ${rid}`);
                    }
                    c.rubric = c.rubric.filter((r) => r.id !== rid);
                }
                let next = c.rubric.reduce(
                    (max, r) => Math.max(max, Number(/^r(\d+)$/.exec(r.id)?.[1] ?? 0)),
                    0,
                );
                for (const text of v['rubric-add'] ?? []) {
                    c.rubric.push({ id: `r${++next}`, text });
                }
                const tags = new Set(c.tags ?? []);
                for (const t of v['tag-add'] ?? []) {
                    tags.add(t.trim());
                }
                for (const t of v['tag-drop'] ?? []) {
                    tags.delete(t.trim());
                }
                if (tags.size > 0) {
                    c.tags = [...tags].sort();
                } else {
                    delete c.tags;
                }
                return c;
            },
            { why, by: whoIsThis(), override: v.override ? [...touched] : undefined },
        );
        store.commit(plan);
        report(run, plan, false);
    });
}

function setStatus(run: Run, to: Case['status']): void {
    if (run.rest.length === 0) {
        throw usageError(`${to === 'retired' ? 'retire' : 'restore'} which cases?`);
    }
    const why = needWhy(run.values);
    writing(run.root, (store) => {
        const plan = planStatus(store, run.rest, to, { why, by: whoIsThis() });
        store.commit(plan);
        report(run, plan, false);
    });
}

function anchorFlags(v: Flags): Anchor | undefined {
    if (v.heading !== undefined && v.pointer !== undefined) {
        throw usageError('--heading or --pointer, not both');
    }
    const issues: string[] = [];
    const anchor = readAnchor(
        v.heading !== undefined
            ? { heading: v.heading }
            : v.pointer !== undefined
              ? { pointer: v.pointer }
              : undefined,
        'anchor',
        issues,
    );
    if (issues.length > 0) {
        throw usageError(issues.join('; '));
    }
    return anchor;
}

function reanchor(run: Run): void {
    const [id, ...extra] = run.rest;
    if (!id || extra.length > 0) {
        throw usageError(
            'reanchor takes one case id',
            'zen meta dataset reanchor <id> --heading "A > B" --why "…"',
        );
    }
    const why = needWhy(run.values);
    const anchor = anchorFlags(run.values);
    writing(run.root, (store) => {
        const plan = planEdit(
            store,
            id,
            (c) => {
                const file = run.values.file ?? c.source?.file;
                if (!file) {
                    throw usageError(`${id} has no source yet`, 'name one with --file');
                }
                c.source = { file, ...(anchor ? { anchor } : {}) };
                return c;
            },
            { why, by: whoIsThis() },
        );
        store.commit(plan);
        report(run, plan, false);
    });
}

function ignore(run: Run): void {
    const [file, ...extra] = run.rest;
    if (!file || extra.length > 0) {
        throw usageError(
            'ignore takes one source file',
            'zen meta dataset ignore <file> --heading "A > B" --why "…"',
        );
    }
    const anchor = anchorFlags(run.values);
    if (!anchor) {
        throw usageError('ignore which section?', 'name it with --heading or --pointer');
    }
    const why = run.values.drop ? (run.values.why ?? '') : needWhy(run.values);
    writing(run.root, (store) => {
        requireDataset(store);
        const others = store.manifest.ignored.filter(
            (i) => !(i.file === file && sameAnchor(i.anchor, anchor)),
        );
        if (run.values.drop && others.length === store.manifest.ignored.length) {
            throw usageError(`${file} ${anchorText(anchor)} is not ignored`);
        }
        const ignored = run.values.drop
            ? others
            : [...others, { file, anchor, why, rev: store.manifest.revision }];
        store.commit(planIgnored(store, ignored));
        if (run.ctx.json) {
            return json({ ignored: store.manifest.ignored });
        }
        note(`${run.values.drop ? 'no longer ignored' : 'ignored'}: ${file} ${anchorText(anchor)}`);
    });
}

function addNote(run: Run): void {
    const v = run.values;
    if (run.rest.length === 0) {
        throw usageError('note which cases?', 'zen meta dataset note <id>... -m "…"');
    }
    const text = v.message?.trim();
    if (!text) {
        throw usageError('a note needs -m <text>');
    }
    const verdicts = oneOf<Verdict>(v.verdict, VERDICTS, '--verdict');
    if (verdicts && verdicts.length > 1) {
        throw usageError('one --verdict per note');
    }
    const kind = (v.kind ?? (verdicts ? 'graded' : 'observation')) as NoteKind;
    oneOf([kind], NOTE_KINDS, '--kind');
    const store = DatasetStore.open(run.root);
    requireDataset(store);
    const cases = run.rest.map((id) => {
        const c = store.get(id);
        if (!c) {
            throw invalidError(`no case ${id}`);
        }
        return c;
    });
    let rubric: Record<string, 'pass' | 'fail'> | undefined;
    if (v.rubric !== undefined) {
        rubric = {};
        for (const pair of v.rubric
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)) {
            const [rid, result] = keyValue(pair, '--rubric');
            if (result !== 'pass' && result !== 'fail') {
                throw usageError(`--rubric ${rid}: pass or fail`, `got "${result}"`);
            }
            for (const c of cases) {
                if (!c.rubric.some((r) => r.id === rid)) {
                    throw usageError(`${c.id} has no rubric item ${rid}`);
                }
            }
            rubric[rid] = result;
        }
    }
    const by = whoIsThis();
    const at = new Date().toISOString();
    for (const c of cases) {
        store.note(c.id, {
            type: 'note',
            at,
            kind,
            caseRev: c.rev,
            ...(v.run ? { run: v.run } : {}),
            ...(verdicts ? { verdict: verdicts[0] } : {}),
            ...(rubric ? { rubric } : {}),
            text,
            by,
        });
    }
    if (run.ctx.json) {
        return json({ noted: cases.map((c) => c.id), kind });
    }
    note(`noted ${cases.length} case(s) ${dim(kind)}`);
}

// ---------------------------------------------------------------------------
// sample / export
// ---------------------------------------------------------------------------

const FORMATS = ['ids', 'batch', 'cases', 'json'] as const;

function drawOf(run: Run, verb: 'sample' | 'export'): Draw {
    const v = run.values;
    const by = (v.by ?? (verb === 'sample' ? 'class' : 'none'))
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    const fields: StratumField[] =
        by.length === 1 && by[0] === 'none'
            ? []
            : (oneOf<StratumField>(by, STRATA_FIELDS, '--by') ?? []);
    const order =
        oneOf<OrderKey>(
            (v.order ?? (verb === 'sample' ? 'rubric,complexity' : 'id'))
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
            ORDER_KEYS,
            '--order',
        ) ?? [];
    const weights = new Map<string, number>();
    for (const w of v.weight ?? []) {
        const at = w.lastIndexOf('=');
        const weight = Number(w.slice(at + 1));
        if (at <= 0 || !Number.isFinite(weight) || weight < 0) {
            throw usageError('--weight takes <stratum>=<number>', `got "${w}"`);
        }
        weights.set(w.slice(0, at), weight);
    }
    return {
        by: fields,
        weights,
        order: verb === 'export' ? ['id'] : order,
        count: whole(v.count, '-n', 1),
        seed: whole(v.seed, '--seed') ?? 1,
    };
}

function draw(run: Run, verb: 'sample' | 'export'): void {
    const v = run.values;
    const store = DatasetStore.open(run.root);
    requireDataset(store);
    const at = whole(v.at, '--at', 1);
    const cases = casesAt(store, at);
    const notes = notesOf(store);
    const criteria = criteriaOf(run, store, cases, at);
    if (verb === 'export' && run.rest.length > 0) {
        const known = new Set(cases.map((c) => c.id));
        const missing = run.rest.filter((id) => !known.has(id));
        if (missing.length > 0) {
            throw invalidError(`no such case: ${missing.join(', ')}`);
        }
        const from = criteria.idsFrom;
        criteria.idsFrom = new Set(run.rest.filter((id) => !from || from.has(id)));
    } else if (run.rest.length > 0) {
        throw usageError('sample takes no ids', 'narrow it with --id <glob> or --ids-from <file>');
    }
    const plan = drawOf(run, verb);
    const format = v.format ?? (run.ctx.json ? 'json' : verb === 'sample' ? 'ids' : 'cases');
    if (!(FORMATS as readonly string[]).includes(format)) {
        throw usageError(`--format takes ${FORMATS.join(', ')}`, `got "${format}"`);
    }

    const drawn = sample(cases, criteria, plan, notes);
    const byId = new Map(cases.map((c) => [c.id, c]));
    const chosen = drawn.ids.map((id) => byId.get(id)!);
    const revision = at ?? store.manifest.revision;
    const out = v.out ? resolve(run.ctx.cwd, v.out) : undefined;

    let text: string;
    switch (format) {
        case 'ids':
            text = drawn.ids.map((id) => `${id}\n`).join('');
            break;
        case 'batch':
            text = `${JSON.stringify(batchInput(chosen, run.root, out), null, 2)}\n`;
            break;
        case 'cases':
            text = `${JSON.stringify(dump(chosen, run.root, revision, out), null, 2)}\n`;
            break;
        default:
            text = `${JSON.stringify(
                {
                    datasetRev: revision,
                    criteria: Object.fromEntries(
                        Object.entries(v).filter(
                            ([k]) => !['format', 'out', 'quiet', 'project'].includes(k),
                        ),
                    ),
                    seed: plan.seed,
                    by: plan.by,
                    order: plan.order,
                    strata: drawn.strata,
                    matched: drawn.matched,
                    ids: drawn.ids,
                },
                null,
                2,
            )}\n`;
    }
    if (out) {
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, text);
    } else {
        process.stdout.write(text);
    }

    if (v.quiet) {
        return;
    }
    if (verb === 'sample' && drawn.strata.length > 0) {
        note(
            table([
                ['STRATUM', 'CHOSEN', 'AVAILABLE', 'WEIGHT'].map((h) => bold(h)),
                ...drawn.strata.map((s) => [
                    s.key,
                    String(s.chosen),
                    String(s.available),
                    String(s.weight),
                ]),
            ]).join('\n'),
        );
    }
    if (drawn.ids.length === 0) {
        note(
            yellow(
                `no case matches${run.ctx.args.length > 1 ? `: ${run.ctx.args.slice(1).join(' ')}` : ''}`,
            ),
        );
    } else {
        note(
            dim(
                `${drawn.ids.length} of ${drawn.matched} matching case(s), revision ${revision}${out ? ` → ${out}` : ''}`,
            ),
        );
    }
}
