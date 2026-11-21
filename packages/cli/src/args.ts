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
        const e = err as Error & { code?: string };
        if (e.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
            // Node's message holds the bad flag between single quotes: '--jsn'
            const flag = e.message.match(/'([^']*)'/)?.[1] ?? '';
            const guess = closest(flag, options);
            if (guess) {
                throw usageError(`unknown option ${flag}, did you mean ${guess}?`, usage);
            }
            throw usageError(`unknown option ${flag}`, usage);
        }
        throw usageError(e.message, usage);
    }
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

/** Levenshtein, one row at a time, giving up as soon as the lengths rule it out. */
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

/** Flags every command accepts, because the frame owns them. */
const EVERYWHERE = ['--json', '--help', '--directory'];

/** The known flag nearest to what was typed, if it is close enough to be a slip. */
function closest(typed: string, options: Options): string | undefined {
    // Every flag this command knows, written the way a user types it.
    const known = [...Object.keys(options).map((name) => `--${name}`), ...EVERYWHERE];

    let best: string | undefined;
    let bestDistance = 3; // anything 3 or more is too far to suggest
    for (const flag of known) {
        const d = distance(typed, flag); // measure how far `typed` is from `flag`
        if (d < bestDistance) {
            // is this one closer than the best so far?
            bestDistance = d;
            best = flag;
        }
    }
    return best;
}
