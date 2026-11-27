import stringWidth from 'string-width';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { styleText } from 'node:util';

// ---------------------------------------------------------------------------
// Terminal I/O
//
// One rule decides where everything goes: **stdout is the answer, stderr is the
// narration.** Prompts, progress, warnings and errors are narration, so a
// pipeline that only wants the answer gets exactly that and nothing else.
//
// `styleText` no-ops when the stream is not a tty and honours NO_COLOR itself,
// so there is no flag to thread through and no piped output to garble.
// ---------------------------------------------------------------------------

// The engine raises these too, so `instanceof CliError` holds for its errors.
import { usageError } from '@zenera/engine';
export {
    EngineError as CliError,
    credentialError,
    EXIT,
    invalidError,
    usageError,
    type ExitCode,
} from '@zenera/engine';

// ---------------------------------------------------------------------------
// Light and dark
//
// Every colour below has to work on somebody else's background, and the two
// sources that can be read without a conversation are read here: what the user
// said, and what the terminal exports. The OSC 11 handshake that `tui/theme.ts`
// runs needs raw mode and a round trip, which is not a price `zen --help`
// should pay — so this is the synchronous half, and the TUI layers the ask on
// top of it.
//
// Apple Terminal is here because it exports nothing, answers nothing, and
// ships a *white* default profile: without it the guess below was wrong for
// every out-of-the-box Terminal.app on a Mac, which is most of them.
// ---------------------------------------------------------------------------

export type Appearance = 'dark' | 'light';

/** One grey per background. The only 256-colour indices in the CLI. */
export const CHROME: Record<Appearance, number> = { dark: 245, light: 242 };

let sniffed: Appearance | undefined;

/** What the terminal looks like, as far as can be known without asking it. */
export function appearance(): Appearance {
    sniffed ??= fromEnv() ?? fromColorFgBg() ?? fromAppleTerminal() ?? 'dark';
    return sniffed;
}

function fromEnv(): Appearance | undefined {
    const v = process.env['ZENERA_THEME']?.trim().toLowerCase();
    return v === 'dark' || v === 'light' ? v : undefined;
}

/**
 * `COLORFGBG` is `fg;bg` or `fg;<something>;bg`; the background is the last
 * field. Anything non-numeric (notably `default`) tells us nothing.
 */
function fromColorFgBg(): Appearance | undefined {
    const parts = process.env['COLORFGBG']?.split(';');
    const bg = parts?.[parts.length - 1];
    if (bg === undefined || !/^\d+$/.test(bg)) {
        return undefined;
    }
    const n = Number(bg);
    return n === 7 || n >= 9 ? 'light' : 'dark';
}

/** The shipped Apple Terminal profiles that are paper rather than ink. */
const APPLE_LIGHT = new Set(['basic', 'man page', 'novel', 'silver aerogel']);

/**
 * Ask `defaults` which profile Terminal.app opens with. A subprocess during
 * startup is a real cost, so it is paid last, once per process, and only on
 * the one terminal that leaves us nothing else to go on. A custom profile is
 * not in the table and falls through to the guess.
 */
function fromAppleTerminal(): Appearance | undefined {
    if (process.env['TERM_PROGRAM'] !== 'Apple_Terminal') {
        return undefined;
    }
    try {
        const name = execFileSync(
            'defaults',
            ['read', 'com.apple.Terminal', 'Default Window Settings'],
            { encoding: 'utf8', timeout: 300, stdio: ['ignore', 'pipe', 'ignore'] },
        )
            .trim()
            .toLowerCase();
        return APPLE_LIGHT.has(name) ? 'light' : undefined;
    } catch {
        return undefined;
    }
}

// ---------------------------------------------------------------------------
// Styling
// ---------------------------------------------------------------------------

export const bold = (s: string): string => styleText('bold', s);
export const italic = (s: string): string => styleText('italic', s);
export const underline = (s: string): string => styleText('underline', s);

/**
 * One step quieter, which is half of everything this tool prints: paths,
 * counts, hints, the second column of every table.
 *
 * A stated grey rather than SGR 2. `dim` is not a colour, it is a request, and
 * how far it is honoured is the terminal's own business — iTerm2 takes a step,
 * Apple Terminal goes most of the way to the background and takes the quiet
 * half of the output with it.
 */
export const dim = (s: string): string => {
    if (!styled()) {
        return s;
    }
    const open = `\u001b[38;5;${CHROME[appearance()]}m`;
    // A colour nested inside closes with `39m`, which would drop the grey for
    // whatever follows it.
    return `${open}${s.replaceAll('\u001b[39m', `\u001b[39m${open}`)}\u001b[39m`;
};

export const red = (s: string): string => styleText('red', s);
export const green = (s: string): string => styleText('green', s);
export const yellow = (s: string): string => styleText('yellow', s);
export const cyan = (s: string): string => styleText('cyan', s);

/** A label meant to be seen first: reverse video, padded so it reads as a tag. */
export const badge = (s: string): string => styleText(['inverse', 'bold'], ` ${s} `);

/**
 * Whether anything should be coloured at all — `styleText`'s own answer, asked
 * by the places that write escape codes directly and so cannot inherit it.
 */
export const styled = (): boolean => styleText('dim', '.') !== '.';

/** Visible width — style codes must not count towards column alignment. */
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

/** The text as it reads without styling, which is what a file wants. */
export const plain = (s: string): string => s.replace(ANSI, '');

const width = stringWidth;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function pad(s: string, to: number): string {
    return s + ' '.repeat(Math.max(0, to - width(s)));
}

/** Column-aligned rows. Trailing whitespace is trimmed so `diff` stays quiet. */
export function table(rows: readonly (readonly string[])[], gap = 2): string[] {
    if (rows.length === 0) {
        return [];
    }
    const columns = Math.max(...rows.map((r) => r.length));
    const widths: number[] = [];
    for (let c = 0; c < columns; c++) {
        widths[c] = Math.max(...rows.map((r) => width(r[c] ?? '')));
    }
    return rows.map((r) =>
        r
            .map((cell, c) => (c === r.length - 1 ? cell : pad(cell, widths[c])))
            .join(' '.repeat(gap))
            .trimEnd(),
    );
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export function write(line = ''): void {
    process.stdout.write(`${line}\n`);
}

export function writeAll(lines: readonly string[]): void {
    for (const l of lines) {
        write(l);
    }
}

/** Machine-readable output. Pretty-printed: it is read by people too. */
export function json(value: unknown): void {
    process.stdout.write(jsonText(value));
}

/** The same bytes, for a caller sending them somewhere other than stdout. */
export function jsonText(value: unknown): string {
    return `${JSON.stringify(value, null, 2)}\n`;
}

export function note(line = ''): void {
    process.stderr.write(`${line}\n`);
}

/**
 * One line of narration that rewrites itself while work is in flight, so a
 * command that waits on the network says what it is waiting for. Without a
 * terminal there is nothing to rewrite over, so each update is its own line —
 * which is what a CI log wants anyway.
 */
export function progress(): { update: (line: string) => void; done: () => void } {
    const tty = Boolean(process.stderr.isTTY);
    let painted = false;
    return {
        update(line: string): void {
            if (!tty) {
                note(line);
                return;
            }
            process.stderr.write(`\r\u001b[2K${line}`);
            painted = true;
        },
        done(): void {
            if (painted) {
                process.stderr.write('\r\u001b[2K');
            }
            painted = false;
        },
    };
}

export function warn(message: string): void {
    note(`${yellow('warning')} ${message}`);
}

// ---------------------------------------------------------------------------
// Naming the run
//
// Two different things answer to the word "title", and a long run wants both.
// `process.title` is what the process table says, which is how `ps` and
// Activity Monitor tell one `zen` from another. The tab is the terminal's own,
// and nothing a process does to itself reaches it — macOS reads the tab name
// from the executable — so it takes an OSC sequence, written to stderr with the
// rest of the narration and only when there is a terminal to read it.
// ---------------------------------------------------------------------------

let restores = false;

/** What this run calls itself, in the process table and on the terminal's tab. */
export function title(text: string): void {
    process.title = text;
    if (!process.stderr.isTTY) {
        return;
    }
    // Push what the shell had there first, so leaving puts it back.
    if (!restores) {
        restores = true;
        process.stderr.write('\u001b[22;0t');
        process.on('exit', () => process.stderr.write('\u001b[23;0t'));
    }
    process.stderr.write(`\u001b]0;${text}\u0007`);
}

export function fail(message: string, hint?: string): void {
    note(`${red('error')} ${message}`);
    if (hint) {
        note(`        ${dim(hint)}`);
    }
}

// ---------------------------------------------------------------------------
// Asking
//
// Every prompt below refuses to run without a terminal rather than blocking on
// a stdin that will never answer. A CLI that hangs in CI is worse than one that
// fails in CI, because only one of the two tells you which flag you forgot.
// ---------------------------------------------------------------------------

/** An agent's terminal can be a real pty (VS Code Copilot's is), so TTY checks alone miss it. */
export function drivenByAgent(): boolean {
    const own = process.env['ZENERA_AGENT'];
    if (own !== undefined) {
        return own !== '' && own !== '0';
    }
    return Boolean(process.env['AI_AGENT'] || process.env['COPILOT_AGENT']);
}

export function isInteractive(): boolean {
    return Boolean(process.stdin.isTTY && process.stderr.isTTY) && !drivenByAgent();
}

// A banner is for whoever is sitting there, and the only proof that anyone is
// sitting there is that we are about to ask them something. Commands whose
// stdout is the answer hand theirs over here instead of printing it, and it
// appears if — and only if — the run turns out to need a person. Held as a
// thunk so this module stays below the banner, which is drawn with its colours.
let pending: (() => void) | undefined;

export function deferBanner(print: () => void): void {
    pending = print;
}

function requireTty(what: string, flag: string): void {
    if (!isInteractive()) {
        const why = drivenByAgent() ? 'when an agent is running zen' : 'without a terminal';
        throw usageError(`cannot ask for ${what} ${why}`, `pass ${flag} instead`);
    }
    const banner = pending;
    pending = undefined;
    banner?.();
}

export async function ask(question: string, fallback?: string): Promise<string> {
    requireTty(question, '--yes or the matching flag');
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
        const suffix = fallback ? dim(` [${fallback}]`) : '';
        const answer = (await rl.question(`${question}${suffix} `)).trim();
        return answer || fallback || '';
    } finally {
        rl.close();
    }
}

/**
 * Reads without echoing. `readline` writes what you type through its `output`
 * stream, so the interface is built without one — there is then nothing for it
 * to echo to, and no window in which the secret is on screen.
 */
export async function askSecret(question: string): Promise<string> {
    requireTty('a secret', 'a piped value on stdin');
    process.stderr.write(`${question} `);
    const rl = createInterface({ input: process.stdin, terminal: true });
    try {
        const answer = await rl.question('');
        return answer.trim();
    } finally {
        rl.close();
        process.stderr.write('\n');
    }
}

export async function confirm(question: string, fallback = false): Promise<boolean> {
    requireTty(question, '--yes');
    const answer = await ask(`${question} ${dim(fallback ? '(Y/n)' : '(y/N)')}`, '');
    if (!answer) {
        return fallback;
    }
    return /^y(es)?$/i.test(answer);
}

export interface Choice<T> {
    label: string;
    detail?: string;
    value: T;
    /** Listed and picked by this instead of its position, e.g. `0` for an escape hatch. */
    key?: string;
}

export interface ChooseOptions {
    /**
     * The choice Enter takes, as an index. It is marked `*`, because a default
     * nobody can see is a default nobody uses.
     */
    initial?: number;
    /** How many rows stay on screen at once; anything beyond them scrolls. */
    window?: number;
}

/** Rows kept on screen when the caller does not say. */
const WINDOW = 10;

/**
 * A list, arrow-driven where the terminal allows it and numbered where it does
 * not. Both forms agree on the two things that matter: every row has a stable
 * number you can type, and one of them is the default Enter takes.
 */
export async function choose<T>(
    title: string,
    choices: readonly Choice<T>[],
    options: ChooseOptions = {},
): Promise<T> {
    if (choices.length === 0) {
        throw usageError(`nothing to choose from: ${title}`);
    }
    if (choices.length === 1) {
        return choices[0].value;
    }
    requireTty(title, 'the matching flag');
    const initial = Math.min(Math.max(options.initial ?? 0, 0), choices.length - 1);
    // A keyed choice is out of the sequence, so it does not consume a number.
    let seq = 0;
    const keys = choices.map((c) => c.key ?? String(++seq));
    // A terminal that cannot move its own cursor gets the list printed once and
    // answers with a number; anything else gets the arrows.
    const dumb =
        typeof process.stdin.setRawMode !== 'function' ||
        (process.env['TERM'] ?? 'dumb') === 'dumb';
    if (dumb) {
        return await numbered(title, choices, keys, initial);
    }
    return await pick(title, choices, keys, initial, options.window ?? WINDOW);
}

/** The rows themselves, column-aligned once and then reused every frame. */
function listOf<T>(choices: readonly Choice<T>[], keys: string[], initial: number): string[] {
    // A key that is not where counting would have put it is the one thing on
    // the row you have to be told, so it is the one that takes a colour.
    return table(
        choices.map((c, i) => [
            `${i === initial ? cyan('*') : ' '} ` +
                (c.key === undefined ? dim(`${keys[i]}.`) : cyan(`${keys[i]}.`)),
            c.label,
            dim(c.detail ?? ''),
        ]),
    );
}

/** The fallback: print everything, read a number. No raw mode, no repainting. */
async function numbered<T>(
    title: string,
    choices: readonly Choice<T>[],
    keys: string[],
    initial: number,
): Promise<T> {
    note(bold(title));
    for (const line of listOf(choices, keys, initial)) {
        note(`  ${line}`);
    }
    const extra = keys.filter((_, i) => choices[i].key !== undefined);
    const counted = keys.length - extra.length;
    const hint =
        `Enter a number between 1 and ${counted}` +
        (extra.length ? `, or ${extra.join(' / ')}` : '') +
        '.';
    for (;;) {
        const answer = await ask('Choose', keys[initial]);
        const at = keys.indexOf(answer);
        if (at >= 0) {
            return choices[at].value;
        }
        note(dim(hint));
    }
}

/**
 * The arrow-driven form. A long list is shown through a window rather than all
 * at once: twenty-five sessions printed in full push the question itself off
 * the screen, and the question is the part being answered.
 *
 * The frame is a fixed number of lines so it can be erased by counting them
 * back, which is also why every line is cut to the terminal's width — a row
 * that wraps is two rows the erase does not know about. When it is over the
 * whole frame is replaced by the one line saying what was chosen.
 */
async function pick<T>(
    title: string,
    choices: readonly Choice<T>[],
    keys: string[],
    initial: number,
    window: number,
): Promise<T> {
    const out = process.stderr;
    const stdin = process.stdin;
    const rows = listOf(choices, keys, initial);
    const shown = Math.max(1, Math.min(window, choices.length, (out.rows ?? 24) - 3));
    const height = shown + 2;

    let at = initial;
    let top = Math.min(Math.max(0, at - shown + 1), Math.max(0, choices.length - shown));
    let typed = '';
    let painted = false;
    let done = false;

    const columns = Math.max(20, (out.columns ?? 80) - 1);

    const paint = (): void => {
        if (painted) {
            out.write(`\u001b[${height}A`);
        }
        const lines = [bold(title)];
        for (let i = top; i < top + shown; i++) {
            lines.push(`${i === at ? cyan('\u276f') : ' '} ${rows[i]}`);
        }
        lines.push(
            dim(
                '  \u2191\u2193 move \u00b7 enter choose \u00b7 esc cancel' +
                    (typed ? ` \u00b7 ${typed}` : '') +
                    (choices.length > shown ? `   ${at + 1}/${choices.length}` : ''),
            ),
        );
        for (const line of lines) {
            out.write(`\u001b[2K${cut(line, columns)}\n`);
        }
        painted = true;
    };

    const goto = (i: number): void => {
        at = Math.min(Math.max(i, 0), choices.length - 1);
        top = Math.min(Math.max(top, at - shown + 1), at);
        paint();
    };

    const move = (delta: number): void => {
        typed = '';
        goto(at + delta);
    };

    return await new Promise<T>((settle, reject) => {
        const wasRaw = stdin.isRaw;
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf8');
        out.write('\u001b[?25l');

        const close = (summary: string): void => {
            stdin.off('data', onData);
            stdin.setRawMode(Boolean(wasRaw));
            if (!wasRaw) {
                stdin.pause();
            }
            // The list has served its purpose; the answer has not.
            out.write(`\u001b[${height}A\u001b[0J\u001b[?25h`);
            out.write(`${cut(`${bold(title)} ${cyan('\u276f')} ${summary}`, columns)}\n`);
        };

        const jump = (digit: string): void => {
            const next = typed + digit;
            const to = keys.indexOf(next);
            typed = to >= 0 ? next : digit;
            const found = to >= 0 ? to : keys.indexOf(digit);
            goto(found >= 0 ? found : at);
        };

        const onData = (data: string): void => {
            // One read can carry several keystrokes — held keys, a paste, or a
            // fast typist — so it is split into keys before any of it is acted
            // on. Reading the chunk as one key loses everything after the first.
            for (const key of keysIn(data)) {
                if (done) {
                    return;
                }
                act(key);
            }
        };

        const act = (key: string): void => {
            switch (key) {
                case '\r':
                case '\n': {
                    const picked = choices[at];
                    done = true;
                    close(picked.detail ? `${picked.label} ${dim(picked.detail)}` : picked.label);
                    settle(picked.value);
                    return;
                }
                case '\u0003':
                case '\u001b':
                case 'q':
                    done = true;
                    close(dim('cancelled'));
                    reject(usageError('cancelled'));
                    return;
                case '\u001b[A':
                case '\u001bOA':
                case 'k':
                    return move(-1);
                case '\u001b[B':
                case '\u001bOB':
                case 'j':
                    return move(1);
                case '\u001b[5~':
                    return move(-shown);
                case '\u001b[6~':
                    return move(shown);
                case '\u001b[H':
                case '\u001b[1~':
                    return move(-choices.length);
                case '\u001b[F':
                case '\u001b[4~':
                    return move(choices.length);
                case '\u007f':
                case '\u0008':
                    typed = '';
                    return paint();
                default:
                    // Typing digits is how a two-digit row is reached without
                    // twelve keystrokes, so they accumulate until one matches.
                    if (key >= '0' && key <= '9') {
                        jump(key);
                    }
            }
        };

        stdin.on('data', onData);
        paint();
    });
}

/** Escape sequences a keyboard sends: CSI (`ESC [ … final`) and SS3 (`ESC O x`). */
const SEQUENCE = /^\u001b(?:\[[0-9;]*[A-Za-z~]|O[A-Za-z])/;

/** A chunk of raw input, split into one string per keystroke. */
export function* keysIn(data: string): Generator<string> {
    let i = 0;
    while (i < data.length) {
        if (data[i] === '\u001b') {
            const found = SEQUENCE.exec(data.slice(i));
            if (found) {
                yield found[0];
                i += found[0].length;
                continue;
            }
        }
        yield data[i++];
    }
}

/**
 * Cut to a visible width, carrying the style codes over. Styling is invisible
 * to the terminal's column count but not to `String.length`, so a naive slice
 * either cuts too early or leaves a colour turned on.
 */
export function cut(s: string, max: number): string {
    if (width(s) <= max) {
        return s;
    }
    let end = 0;
    let columns = 0;
    for (const { segment } of graphemes.segment(plain(s))) {
        const size = stringWidth(segment);
        if (columns + size > max - 1) break;
        columns += size;
        end += segment.length;
    }
    let out = '';
    let seen = 0;
    for (let i = 0; i < s.length;) {
        if (s[i] === '\u001b') {
            const sgr = /^\u001b\[[0-9;]*m/.exec(s.slice(i));
            if (!sgr) break;
            out += sgr[0];
            i += sgr[0].length;
            continue;
        }
        if (seen >= end) break;
        out += s[i++];
        seen++;
    }
    return `${out}\u2026\u001b[0m`;
}

// ---------------------------------------------------------------------------
// stdin
// ---------------------------------------------------------------------------

/** Piped input, or undefined when stdin is a terminal (i.e. nobody piped). */
export async function readStdin(): Promise<string | undefined> {
    if (process.stdin.isTTY) {
        return undefined;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(chunk as Buffer);
    }
    const text = Buffer.concat(chunks).toString('utf8').trim();
    return text || undefined;
}

// ---------------------------------------------------------------------------
// Formatting helpers shared by several commands
// ---------------------------------------------------------------------------

export function ago(iso: string | undefined): string {
    if (!iso) {
        return 'never';
    }
    const then = Date.parse(iso);
    if (Number.isNaN(then)) {
        return 'unknown';
    }
    const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
    const scale: [number, string][] = [
        [31536000, 'y'],
        [86400, 'd'],
        [3600, 'h'],
        [60, 'm'],
    ];
    for (const [size, unit] of scale) {
        if (seconds >= size) {
            return `${Math.floor(seconds / size)}${unit} ago`;
        }
    }
    return seconds < 5 ? 'just now' : `${seconds}s ago`;
}

export function count(n: number, singular: string, plural = `${singular}s`): string {
    return `${n} ${n === 1 ? singular : plural}`;
}

/** Powers of 1000, as the container engine prints them, so the two agree. */
export function bytes(n: number): string {
    if (!Number.isFinite(n) || n <= 0) {
        return '0 B';
    }
    const units = ['B', 'kB', 'MB', 'GB', 'TB'];
    let value = n;
    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) {
        value /= 1000;
        unit++;
    }
    return `${unit > 0 && value < 100 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
