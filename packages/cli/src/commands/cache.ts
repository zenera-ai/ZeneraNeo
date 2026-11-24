import { clip } from '../tui/wrap.ts';
import { paths } from '@zenera/engine';
import { parse } from '../args.ts';
import { clear, items, kinds, sweep, type CacheKind, type Swept } from '../cache.ts';
import type { Command } from '../command.ts';
import {
    ago,
    bold,
    bytes,
    confirm,
    count,
    cyan,
    dim,
    green,
    isInteractive,
    json,
    note,
    table,
    usageError,
    writeAll,
} from '../term.ts';

const USAGE = 'zen cache [ls|prune|clear] [options]';

/** Enough to see what is in there; the rest is a number. */
const LISTED = 20;

interface Flags {
    kind?: string;
    'older-than'?: string;
    'max-size'?: string;
    limit?: string;
    yes?: boolean;
}

// ---------------------------------------------------------------------------
// The cache, from outside
//
// Everything expensive and repeatable this machine has done is kept in one
// place, and the reason it needs a command at all is that nothing evicts from
// it on its own. That is deliberate: a store that quietly deletes things is
// only ever noticed when it has deleted the wrong one. So retention is a
// decision someone makes out loud, here.
//
// Nothing in it is precious. Every entry can be recomputed, which is why
// `clear` is safe to reach for and why the only cost of being wrong is time.
// ---------------------------------------------------------------------------

export const cache: Command = {
    summary: 'What work has been kept, and getting rid of it.',
    usage: USAGE,
    banner: { head: 'Zenera', accent: 'Cache', subtitle: 'Stored Work', hue: 'gold' },
    details: [
        '  ls                     What is stored, by kind. Changes nothing.',
        '  prune                  Remove what the filters name.',
        '  clear                  Remove everything, or one kind of everything.',
        '',
        '  --kind <name>          Just this kind. With `ls`, list its entries.',
        '  --older-than <age>     Unused for longer than e.g. 30d, 12h, 2w.',
        '  --max-size <size>      Ceiling on what is left, e.g. 500MB, 2GB.',
        '  --limit <n>            Entries to list. Default 20.',
        '  --yes                  Do not ask before removing.',
        '',
        'Age is when an entry was last *used*, not when it was written, so a',
        'vector a rebuild reads every week is never old.',
        '',
        '`prune` with no filter is a usage error: deleting everything is what',
        '`clear` is for, and it should have to be typed.',
        '',
        'Nothing here is precious. Every entry is work that can be done again,',
        'so the only cost of removing one is paying for it a second time.',
    ],
    run: async (ctx) => {
        const { values, positionals } = parse<Flags>(
            ctx.args,
            {
                kind: { type: 'string' },
                'older-than': { type: 'string' },
                'max-size': { type: 'string' },
                limit: { type: 'string' },
                yes: { type: 'boolean' },
            },
            USAGE,
        );

        const what = positionals[0] ?? 'ls';
        if (!['ls', 'prune', 'clear'].includes(what)) {
            throw usageError(`unknown subcommand: ${what}`, USAGE);
        }
        if (positionals.length > 1) {
            throw usageError('one subcommand at a time', USAGE);
        }

        switch (what) {
            case 'ls':
                return list(values, ctx.json);
            case 'prune':
                return prune(values, ctx.json);
            default:
                return wipe(values, ctx.json);
        }
    },
};

// ---------------------------------------------------------------------------
// ls
// ---------------------------------------------------------------------------

function list(values: Flags, asJson: boolean): void {
    if (values.kind) {
        return listOne(values, asJson);
    }
    const rows = kinds();
    if (asJson) {
        json({ dir: paths.cache(), kinds: rows, ...totals(rows) });
        return;
    }
    if (rows.length === 0) {
        note(`nothing cached yet ${dim(paths.cache())}`);
        return;
    }
    writeAll(
        table([
            [bold('KIND'), bold('ENTRIES'), bold('SIZE'), bold('OLDEST'), bold('NEWEST')],
            ...rows.map((row) => [
                cyan(row.kind),
                String(row.entries),
                bytes(row.bytes),
                dim(since(row.oldest)),
                dim(since(row.newest)),
            ]),
        ]),
    );
    const all = totals(rows);
    note('');
    note(dim(`${count(all.entries, 'entry', 'entries')}, ${bytes(all.bytes)} in ${paths.cache()}`));
}

function listOne(values: Flags, asJson: boolean): void {
    const kind = values.kind!;
    const limit = number(values.limit, '--limit') ?? LISTED;
    const { rows, found } = items(kind, { limit });

    if (asJson) {
        json({ kind, found, entries: rows });
        return;
    }
    if (found === 0) {
        note(`nothing cached under ${cyan(kind)}`);
        return;
    }
    writeAll(
        table([
            [bold('KEY'), bold('SIZE'), bold('USED')],
            ...rows.map((row) => [shorten(row.key), bytes(row.bytes), dim(since(row.usedAt))]),
        ]),
    );
    if (found > rows.length) {
        note('');
        note(dim(`${found - rows.length} more — raise --limit to see them`));
    }
}

// ---------------------------------------------------------------------------
// prune and clear
// ---------------------------------------------------------------------------

function prune(values: Flags, asJson: boolean): void {
    const olderThanMs = duration(values['older-than']);
    const maxBytes = size(values['max-size']);

    if (olderThanMs === undefined && maxBytes === undefined) {
        throw usageError(
            'prune needs something to go on',
            'pass --older-than <age> or --max-size <size>, or run: zen cache clear',
        );
    }
    report(sweep({ kind: values.kind, olderThanMs, maxBytes }), asJson);
}

async function wipe(values: Flags, asJson: boolean): Promise<void> {
    const before = kinds().filter((row) => !values.kind || row.kind === values.kind);
    const all = totals(before);

    if (all.entries === 0) {
        if (asJson) {
            json({ removed: [], entries: 0, bytes: 0 });
            return;
        }
        note(values.kind ? `nothing cached under ${cyan(values.kind)}` : 'nothing cached yet');
        return;
    }
    if (!values.yes && !asJson && isInteractive()) {
        const what = values.kind
            ? `${count(all.entries, 'entry', 'entries')} under ${values.kind}`
            : count(all.entries, 'entry', 'entries');
        if (!(await confirm(`Remove ${what} (${bytes(all.bytes)})?`))) {
            note('left alone');
            return;
        }
    }
    clear({ kind: values.kind });
    report(
        before.map((row) => ({ kind: row.kind, removed: row.entries, bytes: row.bytes })),
        asJson,
    );
}

function report(swept: readonly Swept[], asJson: boolean): void {
    const entries = swept.reduce((n, row) => n + row.removed, 0);
    const freed = swept.reduce((n, row) => n + row.bytes, 0);

    if (asJson) {
        json({ removed: swept, entries, bytes: freed });
        return;
    }
    if (entries === 0) {
        note('nothing to remove');
        return;
    }
    for (const row of swept) {
        note(
            `${green('removed')} ${count(row.removed, 'entry', 'entries')} ${dim(`${row.kind} · ${bytes(row.bytes)}`)}`,
        );
    }
    if (swept.length > 1) {
        note('');
        note(dim(`${count(entries, 'entry', 'entries')}, ${bytes(freed)} freed`));
    }
}

// ---------------------------------------------------------------------------
// Reading the filters
// ---------------------------------------------------------------------------

const DURATIONS: Record<string, number> = {
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
};

/** `30d`, `12h`, `2w`. A bare number is days: nobody means milliseconds. */
export function duration(text: string | undefined): number | undefined {
    if (text === undefined) {
        return undefined;
    }
    const match = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/i.exec(text.trim());
    const unit = match ? (match[2] || 'd').toLowerCase() : '';
    const scale = DURATIONS[unit];
    if (!match || scale === undefined) {
        throw usageError(`"${text}" is not an age`, 'try: 30d, 12h, 2w');
    }
    return Number(match[1]) * scale;
}

const SIZES: Record<string, number> = {
    b: 1,
    kb: 1000,
    mb: 1000 ** 2,
    gb: 1000 ** 3,
    tb: 1000 ** 4,
};

/** `500MB`, `2GB`. Powers of 1000, the way `bytes()` prints them back. */
export function size(text: string | undefined): number | undefined {
    if (text === undefined) {
        return undefined;
    }
    const match = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/i.exec(text.trim());
    const unit = match ? (match[2] || 'mb').toLowerCase() : '';
    const scale = SIZES[unit];
    if (!match || scale === undefined) {
        throw usageError(`"${text}" is not a size`, 'try: 500MB, 2GB');
    }
    return Number(match[1]) * scale;
}

function number(text: string | undefined, flag: string): number | undefined {
    if (text === undefined) {
        return undefined;
    }
    const value = Number(text);
    if (!Number.isInteger(value) || value < 1) {
        throw usageError(`${flag} takes a whole number of at least 1`, `got "${text}"`);
    }
    return value;
}

// ---------------------------------------------------------------------------
// Small formatting
// ---------------------------------------------------------------------------

const totals = (rows: readonly CacheKind[]) => ({
    entries: rows.reduce((n, row) => n + row.entries, 0),
    bytes: rows.reduce((n, row) => n + row.bytes, 0),
});

const since = (at: number | undefined): string =>
    at === undefined ? 'never' : ago(new Date(at).toISOString());

/**
 * A key holds every input that produced the value, so an embedding's key is a
 * whole paragraph. One line of it says which entry this is; the rest is noise
 * in a table.
 */
function shorten(key: string): string {
    const flat = key
        .replace(/\u0000/g, ' · ')
        .replace(/\s+/g, ' ')
        .trim();
    return clip(flat, 72) || dim('(unreadable)');
}
