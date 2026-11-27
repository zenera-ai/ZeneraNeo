import stringWidth from 'string-width';
import { appearance, dim, drivenByAgent, note, styled, type Appearance } from './term.ts';

// ---------------------------------------------------------------------------
// The banner
//
// The one piece of output that exists to be looked at rather than read. It goes
// to **stderr**, like every other piece of narration, and only when stderr is a
// terminal — a pipeline asking for the answer gets the answer, and a CI log is
// not decorated with block letters.
//
// The font is here rather than pulled in as a dependency because it is a couple
// of kilobytes of constant and the whole CLI is otherwise Node's own. It is the
// shadowed block face: a solid stroke lit from the top left with a box-drawing
// bevel down its right side and along its foot, so the letters read as raised
// rather than as a texture. Glyphs are variable width and carry their own
// spacing, so they abut directly — the gap belongs to the letter, not the join.
//
// A terminal too narrow for the art gets the wordmark on one line. A banner
// that wraps is worse than no banner.
// ---------------------------------------------------------------------------

const HEIGHT = 6;

/** Between the two words. Wide enough that they read as two, not as one. */
const GAP = 3;

/** A left margin, so the art does not start against the edge of the screen. */
const INDENT = 2;

const FONT: Record<string, readonly string[]> = {
    A: [' █████╗ ', '██╔══██╗', '███████║', '██╔══██║', '██║  ██║', '╚═╝  ╚═╝'],
    B: ['██████╗ ', '██╔══██╗', '██████╔╝', '██╔══██╗', '██████╔╝', '╚═════╝ '],
    C: [' ██████╗', '██╔════╝', '██║     ', '██║     ', '╚██████╗', ' ╚═════╝'],
    D: ['██████╗ ', '██╔══██╗', '██║  ██║', '██║  ██║', '██████╔╝', '╚═════╝ '],
    E: ['███████╗', '██╔════╝', '█████╗  ', '██╔══╝  ', '███████╗', '╚══════╝'],
    F: ['███████╗', '██╔════╝', '█████╗  ', '██╔══╝  ', '██║     ', '╚═╝     '],
    G: [' ██████╗ ', '██╔════╝ ', '██║  ███╗', '██║   ██║', '╚██████╔╝', ' ╚═════╝ '],
    H: ['██╗  ██╗', '██║  ██║', '███████║', '██╔══██║', '██║  ██║', '╚═╝  ╚═╝'],
    I: ['██╗', '██║', '██║', '██║', '██║', '╚═╝'],
    J: ['     ██╗', '     ██║', '     ██║', '██   ██║', '╚█████╔╝', ' ╚════╝ '],
    K: ['██╗  ██╗', '██║ ██╔╝', '█████╔╝ ', '██╔═██╗ ', '██║  ██╗', '╚═╝  ╚═╝'],
    L: ['██╗     ', '██║     ', '██║     ', '██║     ', '███████╗', '╚══════╝'],
    M: ['███╗   ███╗', '████╗ ████║', '██╔████╔██║', '██║╚██╔╝██║', '██║ ╚═╝ ██║', '╚═╝     ╚═╝'],
    N: ['███╗   ██╗', '████╗  ██║', '██╔██╗ ██║', '██║╚██╗██║', '██║ ╚████║', '╚═╝  ╚═══╝'],
    O: [' ██████╗ ', '██╔═══██╗', '██║   ██║', '██║   ██║', '╚██████╔╝', ' ╚═════╝ '],
    P: ['██████╗ ', '██╔══██╗', '██████╔╝', '██╔═══╝ ', '██║     ', '╚═╝     '],
    Q: [' ██████╗ ', '██╔═══██╗', '██║   ██║', '██║▄▄ ██║', '╚██████╔╝', ' ╚══▀▀═╝ '],
    R: ['██████╗ ', '██╔══██╗', '██████╔╝', '██╔══██╗', '██║  ██║', '╚═╝  ╚═╝'],
    S: ['███████╗', '██╔════╝', '███████╗', '╚════██║', '███████║', '╚══════╝'],
    T: ['████████╗', '╚══██╔══╝', '   ██║   ', '   ██║   ', '   ██║   ', '   ╚═╝   '],
    U: ['██╗   ██╗', '██║   ██║', '██║   ██║', '██║   ██║', '╚██████╔╝', ' ╚═════╝ '],
    V: ['██╗   ██╗', '██║   ██║', '██║   ██║', '╚██╗ ██╔╝', ' ╚████╔╝ ', '  ╚═══╝  '],
    W: ['██╗    ██╗', '██║    ██║', '██║ █╗ ██║', '██║███╗██║', '╚███╔███╔╝', ' ╚══╝╚══╝ '],
    X: ['██╗  ██╗', '╚██╗██╔╝', ' ╚███╔╝ ', ' ██╔██╗ ', '██╔╝ ██╗', '╚═╝  ╚═╝'],
    Y: ['██╗   ██╗', '╚██╗ ██╔╝', ' ╚████╔╝ ', '  ╚██╔╝  ', '   ██║   ', '   ╚═╝   '],
    Z: ['███████╗', '╚══███╔╝', '  ███╔╝ ', ' ███╔╝  ', '███████╗', '╚══════╝'],
};

const BLANK = ['    ', '    ', '    ', '    ', '    ', '    '];

/** One word as six rows of equal length — so two words line up when joined. */
function big(word: string): string[] {
    const rows = new Array<string>(HEIGHT).fill('');
    for (const ch of word.toUpperCase()) {
        const glyph = FONT[ch] ?? BLANK;
        for (let r = 0; r < HEIGHT; r++) {
            rows[r] += glyph[r];
        }
    }
    return rows;
}

/** A wordmark rather than a sentence, so the letters are set apart. */
const spaced = (s: string): string => [...s.toUpperCase()].join(' ');

const RESET = '\u001b[0m';

/**
 * A stroke and the bevel that shades it, one step darker in the same hue.
 *
 * The head word is the terminal's own ink, so it has one per background: near
 * white raised off grey, or near black embossed into it. The accent does not
 * — it is the brand, it is the same orange on both, and it is the only word
 * here that is allowed not to care what it is printed on.
 */
interface Tone {
    face: string;
    shade: string;
}

const HEADS: Record<Appearance, Tone> = {
    dark: { face: '\u001b[1;38;5;231m', shade: '\u001b[0;38;5;244m' },
    light: { face: '\u001b[1;38;5;235m', shade: '\u001b[0;38;5;245m' },
};

const tone = (face: number, shade: number): Tone => ({
    face: `\u001b[1;38;5;${face}m`,
    shade: `\u001b[0;38;5;${shade}m`,
});

/** One per sub-brand, so two of them are told apart before the word is read. */
const ACCENTS = {
    orange: tone(208, 130),
    amber: tone(214, 172),
    gold: tone(220, 178),
    lime: tone(154, 106),
    green: tone(41, 29),
    emerald: tone(48, 29),
    mint: tone(121, 78),
    teal: tone(44, 30),
    cyan: tone(51, 37),
    sky: tone(39, 26),
    azure: tone(33, 25),
    steel: tone(110, 67),
    indigo: tone(105, 61),
    violet: tone(141, 97),
    purple: tone(171, 90),
    magenta: tone(201, 127),
    pink: tone(212, 169),
    rose: tone(204, 125),
    crimson: tone(197, 124),
    red: tone(196, 88),
    dusk: tone(141, 97),
} as const satisfies Record<string, Tone>;

export type Hue = keyof typeof ACCENTS;

/** Runs of stroke and runs of bevel, alternating; spaces stay unstyled. */
const RUNS = /[█▀▄]+|[^█▀▄ ]+/g;
const isStroke = (run: string): boolean => /[█▀▄]/.test(run);

/**
 * Two tones per word — without the darker bevel the letter is a flat outline
 * and the shadow reads as part of the stroke.
 */
const paint = (text: string, tone: Tone): string =>
    styled()
        ? text.replace(RUNS, (run) => `${isStroke(run) ? tone.face : tone.shade}${run}${RESET}`)
        : text;

/** The wordmark has no bevel to shade, so it is all face. */
const flat = (text: string, tone: Tone): string =>
    styled() ? `${tone.face}${text}${RESET}` : text;

export interface BannerText {
    /** drawn white */
    head: string;
    /** drawn in the neon accent */
    accent: string;
    /** the line underneath, dim */
    subtitle: string;
    /** which neon to use. Default: orange, the `zen` mark. */
    hue?: Hue;
}

export interface PrintBannerOptions {
    /** Render the block face even when the terminal is narrower than it. */
    readonly full?: boolean;
}

export const NEO_BANNER: BannerText = {
    head: 'Zenera',
    accent: 'Neo',
    subtitle: 'Agentic Runtime',
};

export function bannerLines(text: BannerText, columns = process.stderr.columns || 80): string[] {
    const head = big(text.head);
    // Trimmed: the widest accent row is the banner's right edge, and a pad left
    // inside a styled string cannot be trimmed away later.
    const accent = big(text.accent).map((row) => row.trimEnd());
    const tone = ACCENTS[text.hue ?? 'orange'];
    const ink = HEADS[appearance()];
    const margin = ' '.repeat(INDENT);
    const width =
        INDENT + stringWidth(head[0]) + GAP + Math.max(...accent.map((row) => stringWidth(row)));

    if (width > columns) {
        return [
            `${margin}${flat(text.head.toUpperCase(), ink)} ${flat(text.accent.toUpperCase(), tone)}`,
            `${margin}${dim(spaced(text.subtitle))}`,
        ];
    }

    const lines: string[] = [];
    for (let r = 0; r < HEIGHT; r++) {
        lines.push(`${margin}${paint(head[r], ink)}${' '.repeat(GAP)}${paint(accent[r], tone)}`);
    }
    // Rules on both sides, centred under the art: the subtitle is a caption,
    // and without them a short line of spaced capitals floats.
    const caption = `───  ${spaced(text.subtitle)}  ───`;
    lines.push('');
    lines.push(
        `${' '.repeat(Math.max(INDENT, Math.round((width - stringWidth(caption)) / 2)))}${dim(caption)}`,
    );
    return lines;
}

/**
 * The same letters, unpainted and still split by word, for a renderer that is
 * not a terminal and colours the two halves its own way.
 */
export function bannerArt(text: BannerText): { head: string[]; accent: string[] } {
    return { head: big(text.head), accent: big(text.accent).map((row) => row.trimEnd()) };
}

/** Narration, and only for someone watching. */
export function printBanner(text: BannerText, options: PrintBannerOptions = {}): void {
    if (!process.stderr.isTTY || drivenByAgent()) {
        return;
    }
    note('');
    for (const line of bannerLines(text, options.full ? Infinity : undefined)) {
        note(line);
    }
    note('');
}
