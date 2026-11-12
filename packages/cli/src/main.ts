#!/usr/bin/env node
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { extract, invokedAs, split } from './args.ts';
import { NEO_BANNER, printBanner } from './banner.ts';
import { ALIASES, COMMANDS, EXTERNAL } from './commands/index.ts';
import { cliManifest, versionOf } from './commands/version.ts';
import { hasExternal, loadExternal } from './external.ts';
import {
    CliError,
    EXIT,
    bold,
    cyan,
    deferBanner,
    dim,
    fail,
    note,
    pad,
    title,
    write,
} from './term.ts';

/** What the user typed: `zen`, `zn` or `zenera` all arrive here. */
const NAME = invokedAs('zen');

/** Usage lines are written against `zen`. Say them back in the reader's word. */
const spell = (usage: string): string => (NAME === 'zen' ? usage : usage.replace(/^zen\b/, NAME));

// ---------------------------------------------------------------------------
// zen — the command line over `@zenera/neo`
//
// A shell, deliberately. Argument parsing, help, version and exit codes are
// settled here so that adding a command is a matter of writing one function and
// naming it in `COMMANDS` — nothing about the frame has to be revisited.
//
// Only the drawing surface has a dependency, and it is behind a dynamic import
// inside `run`. Everything on this path is Node's own, which is why `zen --help`
// starts instantly and why the CLI adds no weight to the library.
// ---------------------------------------------------------------------------

/** Commands whose name is not simply its first letter capitalised. */
const TITLES: Record<string, string> = { rag: 'RAG' };

const GLOBAL = {
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
    json: { type: 'boolean' },
    // Uppercase, like make, tar and git: it changes where the command applies,
    // not what it does.
    directory: { type: 'string', short: 'C' },
} as const;

/**
 * The shell's half of tab completion calls this, hidden from help. It answers
 * before anything else, because a banner or a window title on a Tab press would
 * be printed into the line being edited — and it never fails loudly for the
 * same reason: no answer is a valid answer, and the shell completes files.
 */
async function completing(words: readonly string[]): Promise<number> {
    try {
        const { complete, render } = await import('./complete.ts');
        const found = render(await complete(words, process.cwd()));
        if (found) {
            process.stdout.write(`${found}\n`);
        }
    } catch {
        // Nothing to offer.
    }
    return EXIT.ok;
}

async function main(argv: readonly string[]): Promise<number> {
    if (argv[0] === '__complete') {
        return await completing(argv.slice(1));
    }
    const parts = split(argv);
    const { rest, global } = extract(parts.after);

    let values;
    try {
        values = parseArgs({
            args: [...parts.before, ...global],
            options: GLOBAL,
            strict: true,
            allowPositionals: false,
        }).values;
    } catch (e) {
        fail((e as Error).message, `run ${bold(`${NAME} --help`)} for the options`);
        return EXIT.usage;
    }

    const json = Boolean(values.json);

    if (values.version && !parts.name) {
        write(await versionOf(cliManifest));
        return EXIT.ok;
    }

    const name = parts.name ? (ALIASES[parts.name] ?? parts.name) : undefined;
    const command = name ? COMMANDS[name] : undefined;
    const external = name && !command ? EXTERNAL[name] : undefined;

    // Named before anything is printed, so a run that takes an hour is
    // identifiable in `ps` and on its own tab for the whole of it.
    if (name && (command || external)) {
        title(`Zen ${TITLES[name] ?? name.replace(/^./, (c) => c.toUpperCase())}`);
    }

    // Narration, so `--json` and every pipe are untouched by it. A command
    // living in another package brings its own brand, but only once it is
    // actually there — a banner over "not installed" is a claim about nothing.
    const ragSearch =
        name === 'rag' && ['docs', 'schema'].includes(rest[0]) && rest[1] === 'search';
    const interactive = rest.includes('--interactive');
    const answers = command?.quiet?.(rest) === true;
    if (!json && (!ragSearch || interactive)) {
        const brand = external && hasExternal(external) ? external.banner : command?.banner;
        const show = (): void =>
            printBanner(brand ?? NEO_BANNER, { full: ragSearch && interactive });
        // A command that answers holds its banner back until it has to ask.
        answers ? deferBanner(show) : show();
    }

    if (parts.name === 'help') {
        await usage(rest[0]);
        return EXIT.ok;
    }
    if (!name) {
        await usage();
        return values.help ? EXIT.ok : EXIT.usage;
    }

    if (!command && !external) {
        fail(`unknown command "${parts.name}"`, `run ${bold(`${NAME} --help`)} for the list`);
        return EXIT.usage;
    }
    // `-C` is consumed here so no command ever reads `process.cwd()` itself,
    // and every relative path in every command means the same thing.
    const cwd = resolve(values.directory ?? process.cwd());

    try {
        const one = command ?? (await loadExternal(name, external!));
        if (values.help) {
            // A command that nests its own pages answers for them; the frame
            // only knows the one page it printed the command's name on.
            await (one.help ? one.help({ args: rest, json, cwd }) : usage(name));
            return EXIT.ok;
        }
        await one.run({ args: rest, json, cwd });
        return EXIT.ok;
    } catch (e) {
        if (e instanceof CliError) {
            fail(e.message, e.hint ? spell(e.hint) : undefined);
            return e.code;
        }
        fail(e instanceof Error ? e.message : String(e));
        if (process.env.ZENERA_DEBUG && e instanceof Error && e.stack) {
            note(dim(e.stack));
        }
        return EXIT.failed;
    }
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

async function usage(name?: string): Promise<void> {
    const resolved = name ? (ALIASES[name] ?? name) : undefined;
    const ext = resolved ? EXTERNAL[resolved] : undefined;
    // Asking for one command's help is already asking for that package, so
    // loading it here costs nothing the reader did not request.
    const one = resolved
        ? (COMMANDS[resolved] ??
          (ext && hasExternal(ext)
              ? await loadExternal(resolved, ext).catch(() => undefined)
              : undefined))
        : undefined;
    if (one) {
        write(bold(spell(one.usage)));
        write(`\n  ${one.summary}`);
        if (ext) {
            write(`\n  ${dim(`Provided by ${cyan(ext.package)}.`)}`);
        }
        if (one.details?.length) {
            write('');
            for (const line of one.details) {
                write(line ? `  ${line}` : '');
            }
        }
        return;
    }

    // Not installed: the table is all there is to say, and it is enough.
    if (ext) {
        write(bold(spell(ext.usage)));
        write(`\n  ${ext.summary}`);
        write(`\n  ${dim(`Provided by ${cyan(ext.package)} — run ${cyan(ext.install)}.`)}`);
        return;
    }

    write(`${bold(NAME)} ${dim('— run agent projects from the command line')}`);
    write(`\n${bold('Usage')}\n  ${NAME} <command> [options]`);
    write(`\n${bold('Commands')}`);
    const names = [...Object.keys(COMMANDS), ...Object.keys(EXTERNAL)];
    const width = Math.max(...names.map((k) => k.length));
    for (const [key, cmd] of Object.entries(COMMANDS)) {
        write(`  ${pad(key, width)}  ${dim(cmd.summary)}`);
    }
    for (const [key, ext] of Object.entries(EXTERNAL)) {
        const tail = hasExternal(ext) ? '' : dim(` (${ext.install})`);
        write(`  ${pad(key, width)}  ${dim(ext.summary)}${tail}`);
    }
    write(`\n${bold('Options')}`);
    write(`  -h, --help          ${dim('This, or a command’s own.')}`);
    write(`  -v, --version       ${dim('Print the version.')}`);
    write(`      --json          ${dim('Machine-readable output.')}`);
    write(`  -C, --directory <d> ${dim('Act as if run in <d>.')}`);
    write(`\n${dim(`Start with ${cyan(`${NAME} init`)}, then ${cyan(`${NAME} run`)}.`)}`);
}

// `zen memory ls | head` closes the pipe while we are still writing to it, and
// an unhandled EPIPE turns that ordinary shell idiom into a stack trace. The
// reader having left is not our error, so we stop quietly.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EPIPE') {
        throw err;
    }
    process.exit(0);
});

process.exitCode = await main(process.argv.slice(2));
