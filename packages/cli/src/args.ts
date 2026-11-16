import { basename } from 'node:path';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { usageError } from './term.ts';

// ---------------------------------------------------------------------------
// Per-command arguments
//
// The frame parses only what is global and hands the rest over untouched, so a
// command owns its own flags. This is the one place that turns `parseArgs`'
// exceptions into a usage error, which is what makes exit code 2 mean exactly
// "the invocation was wrong" everywhere.
// ---------------------------------------------------------------------------

type Options = NonNullable<ParseArgsConfig['options']>;

/**
 * The name the program was launched under. One file is reached by several of
 * them — `zen`, `zn`, `zenera` — and help that names a command the reader did
 * not type is help about a different program.
 *
 * `argv[1]` keeps the symlink `bin` installed rather than its target, which is
 * exactly the name that was typed. Running the file directly, or through a
 * Windows shim, lands on `main.js` instead: there is no name to honour then,
 * so the canonical one stands.
 */
export function invokedAs(fallback: string): string {
    const name = basename(process.argv[1] ?? '').replace(/\.[cm]?js$/, '');
    return name && name !== 'main' && name !== 'index' ? name : fallback;
}

export interface Parsed<T> {
    values: T;
    positionals: string[];
}

export function parse<T>(args: readonly string[], options: Options, usage: string): Parsed<T> {
    try {
        const { values, positionals } = parseArgs({
            args: [...args],
            options,
            strict: true,
            allowPositionals: true,
        });
        return { values: values as T, positionals };
    } catch (err) {
        throw usageError(describeParseError(err as Error & { code?: string }, options), usage);
    }
}

/**
 * `parseArgs` explains an unknown flag as if the reader meant a positional
 * that starts with a dash, which is almost never the case: the usual cause is
 * a typo. Say what was not recognised, offer the nearest flag the command does
 * have, and mention `--` only when nothing is close.
 */
export function describeParseError(err: Error & { code?: string }, options: Options): string {
    if (err.code !== 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
        return err.message;
    }
    const flag = /Unknown option '([^']+)'/.exec(err.message)?.[1];
    if (!flag) {
        return err.message;
    }
    const known = Object.entries(options).flatMap(([long, o]) =>
        o.short ? [`--${long}`, `-${o.short}`] : [`--${long}`],
    );
    const near = closest(flag, known);
    return near
        ? `unknown option ${flag} (did you mean ${near}?)`
        : `unknown option ${flag} (to pass it as text, put it after --)`;
}

/**
 * The candidate a mistyped word most plausibly meant, or nothing when none is
 * close. Distance counts insertions, deletions, substitutions and swaps of two
 * neighbouring letters, so `inti` is one edit from `init`. Short words get
 * less slack than long ones, or every three-letter typo would match something.
 */
export function closest(word: string, candidates: readonly string[]): string | undefined {
    const bare = (s: string): string => s.replace(/^-+/, '').toLowerCase();
    const w = bare(word);
    const limit = w.length <= 4 ? 1 : 2;
    let best: string | undefined;
    let bestDistance = limit + 1;
    for (const candidate of candidates) {
        const d = distance(w, bare(candidate));
        if (d < bestDistance) {
            best = candidate;
            bestDistance = d;
        }
    }
    return best;
}

/** Optimal string alignment distance: Levenshtein plus adjacent transpositions. */
function distance(a: string, b: string): number {
    const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
        Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
    );
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
                d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
            }
        }
    }
    return d[a.length][b.length];
}

/** Exactly one positional, or none. More than one is a mistake worth naming. */
export function one(positionals: string[], what: string, usage: string): string | undefined {
    if (positionals.length > 1) {
        throw usageError(`expected at most one ${what}, got ${positionals.length}`, usage);
    }
    return positionals[0];
}

// ---------------------------------------------------------------------------
// Splitting the command line
//
// Lives here rather than in `main.ts` because it is the part with the sharp
// edge: `parseArgs` in non-strict mode silently turns an unrecognised
// `--no-check` into an *option*, so a frame that parsed the whole line would
// swallow every flag belonging to a command. Nothing after the command name is
// parsed here at all.
// ---------------------------------------------------------------------------

/** Flags the frame owns, wherever they appear. */
const GLOBAL_FLAGS = new Set(['--json', '--help', '-h']);
const GLOBAL_VALUED = new Set(['-C', '--directory']);

export interface Split {
    /** everything before the command name */
    before: string[];
    name?: string;
    /** everything after it, verbatim */
    after: string[];
}

/** The command name is the first bare word. */
export function split(argv: readonly string[]): Split {
    const before: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--') {
            return { before, name: argv[i + 1], after: argv.slice(i + 2) };
        }
        if (!arg.startsWith('-')) {
            return { before, name: arg, after: argv.slice(i + 1) };
        }
        before.push(arg);
        if (GLOBAL_VALUED.has(arg) && i + 1 < argv.length) {
            before.push(argv[++i]);
        }
    }
    return { before, after: [] };
}

/**
 * Pulls the global flags back out of a command's arguments — `zen list --json`
 * reads better than `zen --json list`, and both must work — and returns what is
 * left for the command's own parser. Nothing after `--` is touched.
 */
export function extract(after: readonly string[]): { rest: string[]; global: string[] } {
    const rest: string[] = [];
    const global: string[] = [];
    for (let i = 0; i < after.length; i++) {
        const arg = after[i];
        if (arg === '--') {
            rest.push(...after.slice(i + 1));
            break;
        }
        if (GLOBAL_FLAGS.has(arg)) {
            global.push(arg);
            continue;
        }
        if (GLOBAL_VALUED.has(arg)) {
            global.push(arg, after[++i] ?? '');
            continue;
        }
        if (arg.startsWith('--directory=') || arg.startsWith('--json=')) {
            global.push(arg);
            continue;
        }
        rest.push(arg);
    }
    return { rest, global };
}
