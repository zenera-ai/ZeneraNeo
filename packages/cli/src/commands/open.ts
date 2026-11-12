// packages/cli/src/commands/open.ts
//
// `zen open [project]`: refreshes a project's editor files, then opens it in VS Code or `$EDITOR`.
// Main: `open: Command`. It calls `editorFiles()` from `editor.ts` before opening.
// Used by: `commands/index.ts`, which registers it as `zen open` (aliases `edit`, `code`).

import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve, sep } from 'node:path';
import { one, parse } from '../args.ts';
import type { Command } from '../command.ts';
import { editorFiles } from '../editor.ts';
import { project as resolveProject } from '../resolve.ts';
import { CliError, cyan, dim, EXIT, isInteractive, json, note, usageError } from '../term.ts';

const USAGE = 'zen open [project] [--editor <cmd>] [--wait]';

interface Flags {
    editor?: string;
    wait?: boolean;
}

/**
 * A project is resolved by name or from the cwd, and the path is handed to an
 * editor. It exists because opening the project is the thing everybody does
 * second, and because getting the editor right — which one, with which
 * arguments, attached or detached — is fiddly enough to be worth settling once.
 */
export const open: Command = {
    summary: 'Open a project in your editor.',
    usage: USAGE,
    banner: { head: 'Zenera', accent: 'Open', subtitle: 'Workspace Studio', hue: 'teal' },
    details: [
        'Editor: --editor, then $ZENERA_EDITOR, then the editor this terminal',
        'belongs to, then $VISUAL or $EDITOR, then a known editor on PATH or',
        'installed, then the platform opener.',
        'The editor files `zen init` writes (.vscode/ and the',
        '.github/ tree) are refreshed in the directory being opened; edits to',
        'them do not survive.',
        'VS Code and its forks are launched with --disable-workspace-trust so',
        'the settings written there apply to the window straight away.',
    ],
    run: async (ctx) => {
        const { values, positionals } = parse<Flags>(
            ctx.args,
            {
                editor: { type: 'string' },
                wait: { type: 'boolean' },
            },
            USAGE,
        );

        const found = await resolveProject({
            cwd: ctx.cwd,
            project: one(positionals, 'project', USAGE),
        });
        const dir = found.dir;
        const editor = choose(values.editor, values.wait === true);
        verify(editor);

        // The editor reads the settings and instructions of the folder it was
        // opened on, and a project may predate either of them — or the version
        // this `zen` writes. They are ours, so they are written fresh before
        // the window is there to read them.
        const written = editorFiles(dir);

        if (ctx.json) {
            json({
                name: found.name,
                path: dir,
                editor: [editor.command, ...editor.args].join(' '),
                from: editor.from,
                files: written,
            });
        } else {
            note(`opening ${cyan(dir)} with ${editor.label} ${dim(`(${editor.from})`)}`);
            for (const file of written) {
                note(`  ${dim(`wrote ${file}`)}`);
            }
        }
        await launch(editor, dir);
    },
};

// ---------------------------------------------------------------------------
// Choosing one
// ---------------------------------------------------------------------------

/**
 * The window would otherwise open untrusted, and the settings `zen init`
 * writes into the project are restricted ones: they are ignored until someone
 * clicks through the trust dialog. This is a directory the user just asked to
 * open by name, so answering that question for them is the point.
 */
const TRUST = '--disable-workspace-trust';

/** Guessed only when nothing was asked for, in the order they are tried. */
const KNOWN: readonly Known[] = [
    { command: 'code', label: 'VS Code', app: 'Visual Studio Code', trusts: true },
    { command: 'cursor', label: 'Cursor', app: 'Cursor', trusts: true },
    {
        command: 'code-insiders',
        label: 'VS Code Insiders',
        app: 'Visual Studio Code - Insiders',
        trusts: true,
    },
    { command: 'windsurf', label: 'Windsurf', app: 'Windsurf', trusts: true },
    { command: 'zed', label: 'Zed', app: 'Zed', waits: '-w' },
    { command: 'subl', label: 'Sublime Text', app: 'Sublime Text', waits: '-w' },
    { command: 'idea', label: 'IntelliJ IDEA', app: 'IntelliJ IDEA' },
];

interface Known {
    /** the shell command, which only exists if it was installed on purpose */
    command: string;
    label: string;
    /** the macOS bundle, which exists whether or not the command does */
    app?: string;
    /** its flag for "do not return until the window closes" */
    waits?: string;
    /** whether it is VS Code or a fork of it, and so understands TRUST */
    trusts?: boolean;
}

interface Editor {
    command: string;
    args: string[];
    label: string;
    /** where the choice came from, so the narration can say */
    from: string;
    /**
     * Whether it takes over this terminal. A terminal editor must inherit
     * stdio and be waited for; a windowed one must be detached or `zen` would
     * sit there until the window closed.
     */
    attached: boolean;
}

function choose(asked: string | undefined, wait: boolean): Editor {
    const explicit = asked ?? process.env.ZENERA_EDITOR;
    if (explicit !== undefined && explicit.trim() !== '') {
        return {
            ...split(explicit),
            from: asked !== undefined ? '--editor' : '$ZENERA_EDITOR',
            attached: wait,
        };
    }

    // Before $EDITOR, deliberately. $EDITOR conventionally names something to
    // edit *a file* with — it is very often `vim`, set once years ago — and
    // this command opens a directory as a project. The editor you are already
    // sitting in is the better answer to that, and $ZENERA_EDITOR above is the
    // way to say otherwise.
    const host = hosting(wait);
    if (host !== undefined) return host;

    // $VISUAL and $EDITOR are, by convention, editors that run *in* the
    // terminal, so they are attached and waited for unless proven otherwise.
    for (const name of ['VISUAL', 'EDITOR'] as const) {
        const value = process.env[name];
        if (value !== undefined && value.trim() !== '') {
            return { ...split(value), from: `$${name}`, attached: true };
        }
    }

    for (const known of KNOWN) {
        if (lookup(known.command) !== undefined) {
            return {
                command: known.command,
                args: [
                    ...(known.trusts === true ? [TRUST] : []),
                    ...(wait ? [known.waits ?? '--wait'] : []),
                ],
                label: known.label,
                from: 'PATH',
                attached: wait,
            };
        }
    }

    // Installed but never asked to add itself to PATH — which is the default
    // for VS Code on macOS, and so the case this whole branch exists for.
    // LaunchServices can open it without any of that.
    for (const known of KNOWN) {
        const bundle = known.app === undefined ? undefined : installed(known.app);
        if (bundle !== undefined) {
            return {
                command: 'open',
                args: wait ? ['-W', '-a', bundle] : ['-a', bundle],
                label: known.label,
                from: 'Applications',
                attached: wait,
            };
        }
    }

    // Nothing named an editor, so hand the directory to the desktop and let it
    // decide. On macOS that is Finder unless a folder handler is registered.
    const command =
        process.platform === 'darwin'
            ? 'open'
            : process.platform === 'win32'
              ? 'explorer'
              : 'xdg-open';
    return { command, args: [], label: command, from: 'system', attached: false };
}

/**
 * The editor whose integrated terminal this is. VS Code and every fork of it
 * export `VSCODE_GIT_ASKPASS_MAIN`, which points inside the running
 * installation, so the app root is four directories up from it and
 * `product.json` there names both the CLI and the product. That is exact where
 * guessing is not: it picks Cursor when you are in Cursor, and it works when
 * the shell command was never installed, which on macOS is the default.
 */
function hosting(wait: boolean): Editor | undefined {
    const askpass = process.env.VSCODE_GIT_ASKPASS_MAIN;
    if (process.env.TERM_PROGRAM !== 'vscode' || askpass === undefined) return undefined;

    // <appRoot>/extensions/git/dist/askpass-main.js
    const appRoot = resolve(askpass, '..', '..', '..', '..');
    let product: { applicationName?: string; nameLong?: string };
    try {
        product = JSON.parse(readFileSync(join(appRoot, 'product.json'), 'utf8'));
    } catch {
        return undefined; // not a layout we recognise; fall through to the guesses
    }
    if (product.applicationName === undefined) return undefined;

    const cli = join(appRoot, 'bin', product.applicationName);
    for (const candidate of [cli, `${cli}.cmd`]) {
        if (!existsSync(candidate)) continue;
        return {
            command: candidate,
            args: wait ? [TRUST, '--wait'] : [TRUST],
            label: product.nameLong ?? product.applicationName,
            from: 'this terminal',
            attached: wait,
        };
    }
    return undefined;
}

/** The macOS bundle for an application name, in either place they live. */
function installed(app: string): string | undefined {
    if (process.platform !== 'darwin') return undefined;
    for (const dir of ['/Applications', join(homedir(), 'Applications')]) {
        const bundle = join(dir, `${app}.app`);
        if (existsSync(bundle)) return bundle;
    }
    return undefined;
}

/**
 * `$EDITOR` may carry arguments — `code -n`, `emacsclient -c`. Splitting on
 * whitespace rather than handing the string to a shell: the path is always an
 * argument, so nothing in it is ever interpreted.
 */
function split(value: string): { command: string; args: string[]; label: string } {
    const parts = value.trim().split(/\s+/);
    return { command: parts[0], args: parts.slice(1), label: parts[0] };
}

/**
 * PATH lookup without shelling out to `which`, so the resolution failure can
 * be reported before anything is spawned rather than as an ENOENT nobody sees
 * on a detached child.
 */
function lookup(command: string): string | undefined {
    if (command.includes(sep) || command.includes('/')) {
        return existsSync(command) ? command : undefined;
    }
    const extensions =
        process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
        if (dir === '') continue;
        for (const extension of extensions) {
            const candidate = join(dir, command + extension);
            try {
                accessSync(candidate, constants.X_OK);
                return candidate;
            } catch {
                // not here, keep walking
            }
        }
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------

/**
 * Both ways this can be wrong, settled before anything is spawned and before
 * anything is said: an ENOENT on a detached child is a failure nobody would
 * ever see, and a terminal editor with no terminal to take over would hang.
 */
function verify(editor: Editor): void {
    if (editor.from !== 'system' && lookup(editor.command) === undefined) {
        throw usageError(
            `no such editor: ${editor.command}`,
            editor.from === 'PATH'
                ? 'name one with --editor, or set $ZENERA_EDITOR'
                : `${editor.from} names a command that is not on PATH`,
        );
    }
    if ((editor.from === '$VISUAL' || editor.from === '$EDITOR') && !isInteractive()) {
        throw usageError(
            `${editor.from} names a terminal editor and there is no one at a terminal here`,
            'name a windowed one with --editor, or set $ZENERA_EDITOR',
        );
    }
}

async function launch(editor: Editor, dir: string): Promise<void> {
    const args = [...editor.args, dir];
    if (!editor.attached) {
        // Detached and unreferenced: the window outlives this process, which is
        // the whole point of a GUI editor.
        spawn(editor.command, args, { stdio: 'ignore', detached: true }).unref();
        return;
    }

    const code = await new Promise<number>((settle, reject) => {
        const child = spawn(editor.command, args, { stdio: 'inherit' });
        child.once('error', reject);
        child.once('close', (status) => settle(status ?? 0));
    });
    if (code !== 0) {
        throw new CliError(`${editor.label} exited with ${code}`, EXIT.failed);
    }
}
