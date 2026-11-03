import { ENV_FILE, isBusy, Registry, sessionIds, sessionsDir, stamp } from '@zenera/engine';
import { isMemory, MEMORY_DB, memoryDir, readProjectConfig, snapshotMemory } from '@zenera/neo';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import {
    ARCHIVE_FORMAT,
    collect,
    ENV_EXAMPLE,
    envExample,
    MANIFEST_FILE,
    safeName,
    writeArchive,
    type ArchiveManifest,
    type Collected,
} from '../archive.ts';
import { one, parse } from '../args.ts';
import type { Command } from '../command.ts';
import { project as resolveProject } from '../resolve.ts';
import { ownVersion } from '../scaffold.ts';
import {
    bold,
    count,
    cyan,
    dim,
    green,
    bytes as human,
    json,
    note,
    progress,
    table,
    usageError,
    warn,
    writeAll,
} from '../term.ts';
import { validateProject } from '../validate.ts';

const USAGE = 'zen export [project] [--out <file>] [--no-vectors] [--no-memory] [--force]';

interface Flags {
    out?: string;
    'no-vectors'?: boolean;
    'no-memory'?: boolean;
    force?: boolean;
}

// ---------------------------------------------------------------------------
// zen export
//
// A project is a directory, and the reason this is not `zip -r` is that half
// of the directory is this machine rather than the project: the sessions, the
// scratch, the `.env`. What is left is the thing somebody else can run, and
// this writes exactly that — plus a manifest saying what it is, so `zen
// import` can register it under the right name and tell the reader what is
// still missing.
//
// The vectors travel by default, and that is the decision this command is
// built around. Memory has no other source: a graph without its vectors
// recalls by term overlap until every node is written again, and a rag index
// without its `lance/` tree looks built and cannot search. `--no-vectors`
// makes a small archive for someone who will run the restore step; the default
// makes one that works when it is opened.
//
// What never travels, behind no flag: the values in `.env`. The names do, as
// `.env.example`, because "which credentials does this need" is the first
// question on the other end and the answer is not a secret.
// ---------------------------------------------------------------------------

export const pack: Command = {
    summary: 'Write a project to a shareable zip archive.',
    usage: USAGE,
    banner: { head: 'Zenera', accent: 'Export', subtitle: 'Project Archive', hue: 'emerald' },
    details: [
        'Carries agents.yaml, the agents/ tree, the specification and its',
        'feedback, assets, memory, the sandbox and scripts, and the editor',
        'files — everything that is the project.',
        '',
        'Leaves behind what belongs to this machine: sessions/, .tmp/, .git/,',
        'node_modules/, lock files, any *.zip at the top of the project, and',
        `.env and .env.test. Unless the project keeps its own ${ENV_EXAMPLE}, the names in .env`,
        'become one with no values, so the other end knows what to fill in.',
        '',
        'Vectors travel by default — memory has no other source, and a rag',
        'index without its lance/ tree looks built and cannot search.',
        '--no-vectors leaves both out for a much smaller archive that needs',
        '`zen rag <subject> restore` on arrival. --no-memory drops memory/',
        'entirely, for an archive that shares the project and not what the',
        'agents learned.',
        '',
        'The default name is <project>-<stamp>.zip in the current directory, so',
        'two exports never overwrite one another. --out takes any path.',
        '',
        'A project that fails `zen check` is still exported, with a warning:',
        'sending someone a broken project to ask for help is the point.',
        'Memory is copied as of one moment, so a run writing to it meanwhile',
        'cannot tear the archive.',
    ],
    run: async (ctx) => {
        const { values, positionals } = parse<Flags>(
            ctx.args,
            {
                out: { type: 'string' },
                'no-vectors': { type: 'boolean' },
                'no-memory': { type: 'boolean' },
                force: { type: 'boolean' },
            },
            USAGE,
        );

        const found = await resolveProject({
            cwd: ctx.cwd,
            project: one(positionals, 'project', USAGE),
        });
        const dir = found.dir;
        const force = values.force === true;
        const vectors = values['no-vectors'] !== true;
        const memory = values['no-memory'] !== true;

        settled(dir, force);
        const out = destination(ctx.cwd, found.name, values.out, force);

        const collected = collect(dir, { vectors, memory });
        const snapshot = memory ? snapshotOf(dir, collected) : undefined;
        try {
            const extra = new Map<string, string>();
            const env = join(dir, ENV_FILE);
            // A project's own `.env.example` is the curated one and travels as is.
            if (existsSync(env) && !existsSync(join(dir, ENV_EXAMPLE))) {
                extra.set(ENV_EXAMPLE, envExample(readFileSync(env, 'utf8')));
            }

            const healthy = await sound(dir, found.name, ctx.json);

            const manifest: ArchiveManifest = {
                format: ARCHIVE_FORMAT,
                name: found.name,
                root: safeName(found.name) ?? 'project',
                exportedAt: new Date().toISOString(),
                cli: ownVersion(),
                vectors,
                memory,
                files: collected.files.length + extra.size,
                bytes: collected.bytes,
            };

            const bar = ctx.json ? undefined : progress();
            let done = 0;
            const size = await writeArchive({
                out,
                root: manifest.root,
                entries: collected.files,
                extra,
                manifest,
                onFile: (rel) => {
                    done += 1;
                    bar?.update(`packing ${done}/${collected.files.length} ${dim(rel)}`);
                },
            });
            bar?.done();

            if (ctx.json) {
                json({
                    file: out,
                    bytes: size,
                    files: manifest.files,
                    project: found.name,
                    root: manifest.root,
                    vectors,
                    memory,
                    skipped: collected.skipped,
                    ok: healthy,
                });
                return;
            }
            report(out, size, collected, extra.size, vectors, memory);
        } finally {
            if (snapshot) {
                rmSync(snapshot, { recursive: true, force: true });
            }
        }
    },
};

// ---------------------------------------------------------------------------
// Refusing at the right moment
// ---------------------------------------------------------------------------

/**
 * A run holding a session is the one thing worth a word: the session is not
 * in the archive at all, and the only thing it can disturb is an asset the
 * agent is editing.
 */
function settled(dir: string, force: boolean): void {
    const busy = sessionIds(dir).filter((id) => isBusy(join(sessionsDir(dir), id)));
    if (busy.length > 0 && !force) {
        warn(`${count(busy.length, 'session')} still running — the archive is a snapshot`);
    }
}

/**
 * Points the memory's database entry at a copy taken as of one moment, so a
 * run committing while the archive is written cannot tear it. Returns the
 * scratch directory holding the copy.
 */
function snapshotOf(dir: string, collected: Collected): string | undefined {
    const at = memoryAt(dir);
    const entry = at && collected.files.find((f) => f.abs === join(at, MEMORY_DB));
    if (!at || !entry || !isMemory(at)) {
        return undefined;
    }
    const scratch = mkdtempSync(join(tmpdir(), 'zen-export-'));
    const file = join(scratch, MEMORY_DB);
    snapshotMemory(at, file);
    const bytes = statSync(file).size;
    collected.bytes += bytes - entry.bytes;
    entry.abs = file;
    entry.bytes = bytes;
    return scratch;
}

/**
 * The configured memory directory, or nothing when the project will not load —
 * which is a project this command exports anyway, so it cannot be an error here.
 */
function memoryAt(dir: string): string | undefined {
    try {
        return memoryDir(dir, readProjectConfig(dir).config);
    } catch {
        return undefined;
    }
}

/**
 * Whether the project is sound — asked, reported, and never obeyed.
 *
 * Exporting a project that does not load is a legitimate thing to want: it is
 * how you send it to somebody who can tell you why. So this warns and returns,
 * and the archive is written either way. Nothing is built and no model is
 * asked; this is a reading of files and costs nothing.
 */
async function sound(dir: string, name: string, quiet: boolean): Promise<boolean> {
    const registered = (await Registry.open()).findPath(dir) !== undefined;
    const report = await validateProject({
        dir,
        name,
        registered,
        sandbox: { enabled: false },
        models: { enabled: false },
    });
    if (!report.ok && !quiet) {
        warn(
            `this project has ${count(report.counts.errors, 'error')} — ` +
                `exporting it anyway (see: zen check)`,
        );
    }
    return report.ok;
}

/**
 * Where the archive goes. The stamp is in the default name because an export
 * is a point in time, and because two of them in one afternoon should be two
 * files rather than one silently replaced.
 */
function destination(cwd: string, name: string, out: string | undefined, force: boolean): string {
    const at = out
        ? resolve(isAbsolute(out) ? out : join(cwd, out))
        : join(cwd, `${slug(name)}-${stamp()}.zip`);
    if (existsSync(at) && !force) {
        throw usageError(
            `${at} already exists`,
            'overwrite it with --force, or name another --out',
        );
    }
    return at;
}

/** A project name as a file name: what a shell and a browser both accept. */
function slug(name: string): string {
    const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '');
    return cleaned.length > 0 ? cleaned : 'project';
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/** What the skip reasons are called when somebody reads them. */
const SKIPPED: Record<string, string> = {
    sessions: 'session directories',
    scratch: '.tmp/',
    git: 'git history',
    modules: 'node_modules/',
    env: `${ENV_FILE} (replaced by ${ENV_EXAMPLE})`,
    locks: 'lock files',
    noise: 'editor noise',
    archives: 'zip archives beside the project',
    vectors: 'vector stores (--no-vectors)',
    memory: 'memory/ (--no-memory)',
    links: 'symbolic links',
};

function report(
    out: string,
    size: number,
    collected: Collected,
    extra: number,
    vectors: boolean,
    memory: boolean,
): void {
    const groups = new Map<string, { files: number; bytes: number }>();
    for (const file of collected.files) {
        const at = file.rel.indexOf('/');
        const key = at < 0 ? '(root)' : `${file.rel.slice(0, at)}/`;
        const group = groups.get(key) ?? { files: 0, bytes: 0 };
        group.files += 1;
        group.bytes += file.bytes;
        groups.set(key, group);
    }
    const rows = [...groups.entries()]
        .sort((a, b) => b[1].bytes - a[1].bytes)
        .map(([key, g]) => [cyan(key), count(g.files, 'file'), dim(human(g.bytes))]);
    writeAll(table(rows));

    note();
    note(`${green('wrote')} ${bold(out)} ${dim(human(size))}`);
    note(
        dim(
            `${count(collected.files.length + extra, 'file')} inside, ` +
                `described by ${MANIFEST_FILE}`,
        ),
    );
    for (const [reason, n] of Object.entries(collected.skipped)) {
        note(dim(`  left out ${count(n, 'path')}: ${SKIPPED[reason] ?? reason}`));
    }
    if (!vectors) {
        note(
            dim(
                '  no vectors: the other end needs `zen rag <subject> restore`, ' +
                    'and memory will recall by term overlap',
            ),
        );
    }
    if (!memory) {
        note(dim('  no memory: the project travels, what the agents learned does not'));
    }
    note();
    note(`open it with ${bold('zen import')} ${dim(out)}`);
}
