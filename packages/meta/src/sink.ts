import { boxWidth, cut, cyan, dim, formatMarkdown, note, pad, red, styled, write } from './host.ts';

// ---------------------------------------------------------------------------
// The window
//
// Where a run's narration is shown while it goes, and the box its answer lands
// in. stdout is the answer and stderr the story of getting there, so
// `zen meta run … > out.md` holds the answer alone.
// ---------------------------------------------------------------------------

export interface Sink {
    answer(text: string): void;
    narrate(line: string): void;
    warn(line: string): void;
    /** Kept by the log, never shown: the step-by-step nobody reads while it runs. */
    detail?(line: string): void;
    /** A transient last row, replaced each time and never kept. '' removes it. */
    status?(line: string): void;
    /** Called once when the run ends, so a repainting sink can clear itself. */
    close?(): void;
}

export const terminalSink: Sink = {
    answer: (text) => write(text),
    narrate: (line) => note(line),
    warn: (line) => note(red(line)),
};

/** Rows of narration the window keeps on screen. */
export const WINDOW_ROWS = 8;

const BOX = { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' };

/** How often the border is redrawn — the wave's frame, not the clock's. */
export const FRAME_MS = 80;

// Dimmest first, crest last. Written as escapes rather than `styleText` because
// a named colour has no ramp, which is also why `styled()` has to be asked.
const WAVE = [
    '\u001b[0;38;5;24m',
    '\u001b[0;38;5;31m',
    '\u001b[0;38;5;38m',
    '\u001b[0;38;5;45m',
    '\u001b[0;38;5;51m',
    '\u001b[1;38;5;159m',
    '\u001b[1;38;5;231m',
];
const RESET = '\u001b[0m';

/** Cells each tone of the tail covers, so the crest reads as a band, not a dot. */
const WAVE_TAIL = 2;

/** Cells the crest travels per frame — a lap of a wide window in a few seconds. */
export const WAVE_STEP = 3;

/**
 * How brightly one cell of the border is lit, given where the crest has got to.
 *
 * `position` counts clockwise from the top left corner, so one index walks the
 * whole ring and the wave rounds the corners without a seam. Everything the
 * tail has passed sits at the dimmest tone, which is the border's resting
 * colour: the ring is always drawn, only the crest moves.
 */
export function toneAt(position: number, head: number, span: number): number {
    const behind = (((head - position) % span) + span) % span;
    const step = Math.floor(behind / WAVE_TAIL);
    return step < WAVE.length ? WAVE.length - 1 - step : 0;
}

/**
 * A run of border cells, coloured by the wave and emitting an escape only where
 * the tone changes — a frame of the whole ring is a handful of them.
 *
 * `from` is the ring position of the first cell and `step` which way round the
 * ring the cells run, because the bottom rule is printed left to right while
 * the ring travels it right to left.
 */
function lit(cells: string[], from: number, step: number, head: number, span: number): string {
    let out = '';
    let tone = -1;
    for (let i = 0; i < cells.length; i++) {
        const next = toneAt(from + i * step, head, span);
        if (next !== tone) {
            out += WAVE[next];
            tone = next;
        }
        out += cells[i];
    }
    return `${out}${RESET}`;
}

/**
 * The bottom rule as cells, with the status label set into it near the left.
 *
 * Waiting belongs to the frame rather than to the narration: a row of its own
 * costs a step of what the agent is doing every time, and it settles just
 * under the last line, which is where the eye already is. Near the left, where
 * reading starts, and not so near that it displaces the corner.
 */
export function footerCells(label: string, width: number): string[] {
    const room = width - 6;
    const text = label && room > 0 ? [...label].slice(0, room) : [];
    const cells = text.length > 0 ? [BOX.bl, BOX.h, ' ', ...text, ' '] : [BOX.bl];
    while (cells.length < width - 1) {
        cells.push(BOX.h);
    }
    return [...cells, BOX.br];
}

/**
 * Narration held to a fixed number of rows that rewrite themselves in place.
 *
 * A long run is hundreds of tool calls, and printing each as its own line
 * scrolls the question, the model line and every warning off the top of the
 * screen — by the end the terminal holds a transcript nobody asked for and the
 * answer is somewhere in the middle of it. Only the last few steps say what it
 * is doing now, which is the only thing narration is for; the rest is in the
 * session copilot recorded.
 *
 * Warnings are not narration: they leave the window and stay on the screen.
 *
 * Without a terminal there is nothing to rewrite over, so every line is its
 * own — which is what a CI log wants anyway.
 */
export function windowSink(rows = WINDOW_ROWS): Sink {
    if (!process.stderr.isTTY) {
        return terminalSink;
    }
    const kept: string[] = [];
    const colour = styled();
    let label = '';
    let head = 0;
    let painted = 0;

    // The frame must stay under the viewport: a block taller than the screen
    // scrolls its own top away, and then the cursor-up erase falls short and
    // strands a copy of every repaint. The two border rows count towards it.
    const height = (): number => Math.max(1, Math.min(rows, (process.stderr.rows ?? 24) - 4));
    const columns = (): number => Math.max(20, (process.stderr.columns ?? 80) - 1);
    const innerOf = (): number => columns() - 4;

    const erase = (): void => {
        if (painted > 0) {
            process.stderr.write(`\u001b[${painted}A\u001b[0J`);
            painted = 0;
        }
    };

    /** The whole frame, border lit by the wave, every row exactly one row. */
    const frameOf = (show: string[], inner: number): string[] => {
        const width = inner + 4;
        // Clockwise from the top left: across the top, down the right, back
        // along the bottom, up the left. One ring, so one index addresses it.
        const span = 2 * width + 2 * show.length;
        const top = [BOX.tl, ...Array<string>(width - 2).fill(BOX.h), BOX.tr];
        const bottom = footerCells(label, width);
        const edge = (position: number): string =>
            colour ? lit([BOX.v], position, 1, head, span) : cyan(BOX.v);
        return [
            colour ? lit(top, 0, 1, head, span) : cyan(top.join('')),
            ...show.map(
                (line, r) =>
                    `${edge(span - 1 - r)} ${pad(cut(line, inner), inner)} ${edge(width + r)}`,
            ),
            colour
                ? lit(bottom, 2 * width + show.length - 1, -1, head, span)
                : cyan(bottom.join('')),
        ];
    };

    const paint = (): void => {
        const show = kept.slice(-height());
        if (show.length === 0 && label === '') {
            erase();
            return;
        }
        // The wave wants a frame to run round before there is anything to say.
        const lines = frameOf(show.length > 0 ? show : [''], innerOf());
        if (painted === lines.length) {
            // Erasing before a repaint is what flickers; overwriting in place
            // does not, and at frame rate the whole border has to be redrawn.
            process.stderr.write(
                `\u001b[${painted}A${lines.map((l) => `\r${l}\u001b[0K\n`).join('')}`,
            );
            return;
        }
        erase();
        process.stderr.write(lines.map((l) => `${l}\n`).join(''));
        painted = lines.length;
    };

    return {
        answer: (text) => {
            erase();
            write(text);
        },
        narrate: (line) => {
            kept.push(...line.split('\n'));
            if (kept.length > height() * 4) {
                kept.splice(0, kept.length - height());
            }
            paint();
        },
        warn: (line) => {
            erase();
            note(red(line));
            paint();
        },
        status: (line) => {
            label = line;
            head += WAVE_STEP;
            paint();
        },
        close: erase,
    };
}

/**
 * The answer in the same box `zen run` draws it in: bounded width, rounded
 * rule, formatted with full markdown styling (bold, italics, code, lists, quotes, tables).
 *
 * Redirected output gets the text and nothing else — `zen meta run ... > out.md`
 * is meant to produce a file you can read, not one with a border down its side.
 */
export function answerBox(text: string, columns = process.stdout.columns ?? 80): string[] {
    if (!process.stdout.isTTY) {
        return text.split('\n');
    }
    const outer = boxWidth(text, columns);
    const inner = outer - 4;
    const body = formatMarkdown(text, inner);
    const rule = BOX.h.repeat(outer - 2);
    return [
        '',
        dim(`${BOX.tl}${rule}${BOX.tr}`),
        ...body.map((l) => `${dim(BOX.v)} ${pad(l, inner)} ${dim(BOX.v)}`),
        dim(`${BOX.bl}${rule}${BOX.br}`),
        '',
    ];
}
