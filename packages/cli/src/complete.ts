// packages/cli/src/complete.ts
//
// Shell tab completion: turns the words typed so far into candidates, the same way for zsh, bash and fish.
// Main: `complete(words, cwd)` and `render()` (the `value<TAB>description` wire format). A command with its own
// `complete` hook answers for itself; a sibling package (e.g. `@zenera/meta`) is loaded for that only if installed.
// Used by: `main.ts`, for the hidden `zen __complete` the shell scripts from `zen completion` call.

import { resolve } from 'node:path';
import { matching, projectNames, type Candidate } from './candidates.ts';
import { ALIASES, COMMANDS, EXTERNAL } from './commands/index.ts';
import { hasExternal, loadExternal } from './external.ts';

// ---------------------------------------------------------------------------
// Shell completion
//
// The shell's own glue (`zen completion zsh|bash|fish`) is deliberately dumb:
// it hands `zen __complete` the words typed so far, the one being completed
// last, and shows whatever comes back. Everything that needs to know what a
// project is, or which prompts it holds, is answered here, once, for all three
// shells.
//
// One candidate per line, `value<TAB>description`. Nothing at all means "no
// opinion", and the shell falls back to completing file names — which is the
// right answer for `-C <dir>`, for `--events <file>`, and for the files that
// follow a stored command.
// ---------------------------------------------------------------------------

/** Flags the frame owns, offered where a command name would be. */
const GLOBAL_FLAGS: Candidate[] = [
    { value: '--help', description: 'Print help.' },
    { value: '--version', description: 'Print the version.' },
    { value: '--json', description: 'Machine-readable output.' },
    { value: '--directory', description: 'Act as if run in <dir>.' },
];

/** Commands whose first bare word is a project, not a subcommand. */
const TAKES_PROJECT = new Set(['run', 'open', 'check', 'export']);

/** `zen key <ls|add|rm>` → `ls`, `add`, `rm`; a usage line is the only list there is. */
function subcommands(usage: string): string[] {
    const group = /[<[]([a-z][a-z-]*(?:\|[a-z][a-z-]*)+)[>\]]/.exec(usage);
    return group ? group[1].split('|') : [];
}

/**
 * `words` is everything typed after the program's name, the word being
 * completed last — an empty string when the cursor follows a space.
 */
export async function complete(words: readonly string[], cwd: string): Promise<Candidate[]> {
    const cur = words.at(-1) ?? '';
    const before: string[] = [];
    let at = cwd;
    for (let i = 0; i < words.length - 1; i++) {
        const w = words[i];
        if (w === '-C' || w === '--directory') {
            // The directory itself is being typed: that is the shell's to complete.
            if (i + 1 === words.length - 1) {
                return [];
            }
            at = resolve(cwd, words[++i]);
        } else if (w !== '--json' && w !== '--help' && w !== '-h') {
            before.push(w);
        }
    }

    if (before.length === 0) {
        if (cur.startsWith('-')) {
            return matching(GLOBAL_FLAGS, cur);
        }
        return matching(
            [
                ...Object.entries(COMMANDS).map(([value, c]) => ({
                    value,
                    description: c.summary,
                })),
                ...Object.entries(EXTERNAL).map(([value, e]) => ({
                    value,
                    description: e.summary,
                })),
                { value: 'help', description: 'Help for a command.' },
            ],
            cur,
        );
    }

    const name = ALIASES[before[0]] ?? before[0];
    const args = before.slice(1);

    if (name === 'help') {
        return args.length === 0 ? await complete([cur], at) : [];
    }
    // A command whose words the usage line cannot describe answers for itself.
    // One in another package is loaded for it only if it is there to load.
    const ext = COMMANDS[name] ? undefined : EXTERNAL[name];
    const own =
        COMMANDS[name] ?? (ext && hasExternal(ext) ? await loadExternal(name, ext) : undefined);
    if (own?.complete) {
        return await own.complete(args, cur, at);
    }
    if (cur.startsWith('-') || args.some((a) => !a.startsWith('-'))) {
        return [];
    }
    if (TAKES_PROJECT.has(name)) {
        return matching(await projectNames(), cur);
    }
    const usage = COMMANDS[name]?.usage ?? EXTERNAL[name]?.usage;
    return matching(
        subcommands(usage ?? '').map((value) => ({ value })),
        cur,
    );
}

/** The wire format. Whitespace in a description would break a line in two. */
export function render(found: readonly Candidate[]): string {
    return found
        .map((c) =>
            c.description ? `${c.value}\t${c.description.replace(/\s+/g, ' ').trim()}` : c.value,
        )
        .join('\n');
}
