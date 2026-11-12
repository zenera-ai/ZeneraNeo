// ---------------------------------------------------------------------------
// The README banner, as SVG.
//
// GitHub strips `style` attributes out of Markdown, so the coloured `<pre>` we
// print in the terminal arrives on the page as flat text on a `<pre>` box that
// does not match the theme. The art is therefore shipped as two images — one
// per colour scheme — drawn from the very same font and tones the CLI uses, so
// the README and `zen` can never drift apart. On GitHub pick between them with
// `#gh-dark-mode-only` / `#gh-light-mode-only`: `<picture>` follows the OS
// theme, not GitHub's, and shows the wrong one whenever the two differ.
//
// The glyphs are drawn as rectangles rather than set as text: an SVG loaded
// through `<img>` has only the reader's fonts to draw with, and a box-drawing
// face that is missing, or a monospace advance a fraction off ours, turns the
// wordmark into rubble.
//
//   FORCE_COLOR=3 node scripts/banner-svg.mjs
// ---------------------------------------------------------------------------

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NEO_BANNER, bannerLines } from '../packages/cli/src/banner.ts';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'imgs');

/** Cell geometry, in the same 6:11 proportion a terminal cell has. */
const W = 12;
const H = 22;

/** Stroke of a box-drawing line, and the space between the pair. */
const T = 3;
const GAP = 3;

const xL = (W - GAP) / 2 - T; // left rule, left edge
const xR = (W + GAP) / 2; // right rule, left edge
const yT = (H - GAP) / 2 - T; // upper rule, top edge
const yB = (H + GAP) / 2; // lower rule, top edge

/**
 * A character as rectangles in its own cell. Each rule runs to the cell edge it
 * continues through, so a row of them joins up without a seam.
 */
const SHAPES = {
    '█': [[0, 0, W, H]],
    '▀': [[0, 0, W, H / 2]],
    '▄': [[0, H / 2, W, H / 2]],
    '═': [
        [0, yT, W, T],
        [0, yB, W, T],
    ],
    '║': [
        [xL, 0, T, H],
        [xR, 0, T, H],
    ],
    // Corners: the outer rule turns early and the inner one late, which is what
    // makes a double corner read as two parallel lines rather than one thick.
    '╔': [
        [xL, yT, W - xL, T],
        [xL, yT, T, H - yT],
        [xR, yB, W - xR, T],
        [xR, yB, T, H - yB],
    ],
    '╗': [
        [0, yT, xR + T, T],
        [xR, yT, T, H - yT],
        [0, yB, xL + T, T],
        [xL, yB, T, H - yB],
    ],
    '╚': [
        [xL, yB, W - xL, T],
        [xL, 0, T, yB + T],
        [xR, yT, W - xR, T],
        [xR, 0, T, yT + T],
    ],
    '╝': [
        [0, yB, xR + T, T],
        [xR, 0, T, yB + T],
        [0, yT, xL + T, T],
        [xL, 0, T, yT + T],
    ],
};

/** The four tones `banner.ts` paints with, by their 256-colour index. */
const ROLE = { 231: 'face', 244: 'shade', 208: 'accent', 130: 'accentShade' };

/** The head word is the same on every mark; only the second word changes hue. */
const HEAD = {
    dark: { face: '#ffffff', shade: '#8b949e' },
    light: { face: '#1f2328', shade: '#8c959f' },
};

/** One accent per package, so the marks are told apart at a glance. */
const ACCENTS = {
    orange: {
        dark: { accent: '#ff8700', accentShade: '#d75f00' },
        light: { accent: '#d95c00', accentShade: '#9a4200' },
    },
    green: {
        dark: { accent: '#00d75f', accentShade: '#00875f' },
        light: { accent: '#00d75f', accentShade: '#00875f' },
    },
    violet: {
        dark: { accent: '#a371f7', accentShade: '#7c4ddb' },
        light: { accent: '#8250df', accentShade: '#5a32a3' },
    },
    pink: {
        dark: { accent: '#ff87d7', accentShade: '#d75faf' },
        light: { accent: '#bf3989', accentShade: '#99286e' },
    },
    crimson: {
        dark: { accent: '#ff005f', accentShade: '#af0000' },
        light: { accent: '#c21846', accentShade: '#8f1234' },
    },
    cyan: {
        dark: { accent: '#00ffff', accentShade: '#00afaf' },
        light: { accent: '#0a8f9a', accentShade: '#066a73' },
    },
};

/** An ANSI line as `{ char, role }` cells — the escape codes carry the tone. */
function cells(line) {
    const out = [];
    const escape = /\u001b\[([0-9;]*)m/g;
    let role = null;
    let at = 0;
    const take = (text) => {
        for (const char of text) {
            out.push({ char, role });
        }
    };
    for (let m = escape.exec(line); m; m = escape.exec(line)) {
        take(line.slice(at, m.index));
        role = ROLE[m[1].split(';').pop()] ?? null;
        at = escape.lastIndex;
    }
    take(line.slice(at));
    return out;
}

/** Drop the margin the terminal wants and the ragged edge it leaves. */
function trim(rows) {
    const ink = (row) => row.map((c, i) => (c.char === ' ' ? -1 : i)).filter((i) => i >= 0);
    const marks = rows.flatMap(ink);
    const from = Math.min(...marks);
    const to = Math.max(...marks) + 1;
    return rows.map((row) => row.slice(from, to));
}

function svg(rows, theme, label, darkTheme) {
    const paths = new Map();
    rows.forEach((row, r) => {
        row.forEach((cell, c) => {
            const shapes = SHAPES[cell.char];
            if (!shapes || !cell.role) {
                return;
            }
            const d = paths.get(cell.role) ?? [];
            for (const [x, y, w, h] of shapes) {
                d.push(`M${c * W + x} ${r * H + y}h${w}v${h}h${-w}z`);
            }
            paths.set(cell.role, d);
        });
    });

    const width = Math.max(...rows.map((row) => row.length)) * W;
    const height = rows.length * H;
    const body = [...paths]
        .map(
            ([role, d]) =>
                `  <path${darkTheme ? ` class="${role}"` : ''} fill="${theme[role]}" d="${d.join('')}"/>`,
        )
        .join('\n');

    const style = darkTheme
        ? `<style>@media (prefers-color-scheme: dark) { ${Object.entries(darkTheme)
              .map(([role, color]) => `.${role} { fill: ${color}; }`)
              .join(' ')} }</style>\n`
        : '';
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${label}">
${style}${body}
</svg>
`;
}

/** One per README that carries the mark. The head word never changes. */
const WORDMARKS = [
    { file: 'banner-neo', accent: 'orange', text: NEO_BANNER },
    { file: 'banner-cli', accent: 'orange', text: { ...NEO_BANNER, accent: 'CLI' } },
    { file: 'banner-rag', accent: 'green', text: { ...NEO_BANNER, accent: 'Rag' } },
    { file: 'banner-gym', accent: 'violet', text: { ...NEO_BANNER, accent: 'Gym' } },
    { file: 'banner-view', accent: 'pink', text: { ...NEO_BANNER, accent: 'View' } },
    { file: 'banner-server', accent: 'crimson', text: { ...NEO_BANNER, accent: 'Server' } },
    { file: 'banner-meta', accent: 'cyan', text: { ...NEO_BANNER, accent: 'Meta' } },
];

const selected = process.argv.slice(2);
for (const { file, accent, text } of WORDMARKS.filter(
    ({ file }) => !selected.length || selected.includes(file),
)) {
    const rows = trim(bannerLines(text, 999).slice(0, 6).map(cells));
    if (!rows.some((row) => row.some((cell) => cell.role))) {
        throw new Error('banner came back uncoloured — run with FORCE_COLOR=3');
    }

    const label = `${text.head} ${text.accent}`.toUpperCase();
    for (const [name, head] of Object.entries(HEAD)) {
        const theme = { ...head, ...ACCENTS[accent][name] };
        writeFileSync(join(OUT, `${file}-${name}.svg`), svg(rows, theme, label));
    }
    writeFileSync(
        join(OUT, `${file}-with-media-queries.svg`),
        svg(rows, { ...HEAD.light, ...ACCENTS[accent].light }, label, {
            ...HEAD.dark,
            ...ACCENTS[accent].dark,
        }),
    );
    // Three quarters of the drawing, which is where the strokes stay crisp.
    const cols = Math.max(...rows.map((row) => row.length));
    console.log(`${file}: width="${Math.round((cols * W * 3) / 4)}"`);
}
