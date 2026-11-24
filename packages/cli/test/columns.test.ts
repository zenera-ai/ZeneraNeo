import { renderToString } from 'ink';
import { createElement } from 'react';
import stringWidth from 'string-width';
import { describe, expect, it } from 'vitest';
import { Streaming } from '../src/tui/app.tsx';
import {
    blocksOf,
    boxWidth,
    clip,
    columnsOf,
    gistOf,
    gridOf,
    windowOf,
    wrap,
} from '../src/tui/wrap.ts';

// What the frame is fed when the model does not answer in English. Each of
// these is a different way for `.length` to be wrong about a row.
const CJK =
    '日本語のテキストは幅が二倍になりますので、行の長さを文字数で測ると端末の幅を超えてしまいます。';
const HANGUL = '한국어 텍스트도 마찬가지로 두 칸을 차지합니다';
const FAMILY = '👨‍👩‍👧‍👦';
const EMOJI = `😀 ${FAMILY} 👩‍💻 👍🏽 🇺🇸 1️⃣ ❤️`;
const ACCENTS = 'éàôü '.repeat(12);
const THAI = 'น้ำกำลังทำงานอยู่ที่นี่';
const DEVANAGARI = 'क्षिप्रं नमस्ते दुनिया';
const CORPUS = { CJK, HANGUL, EMOJI, ACCENTS, THAI, DEVANAGARI };

const clusters = (text: string): string[] =>
    [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(
        (s) => s.segment,
    );

/** What a terminal that joins nothing draws: every code point on its own. */
const apart = (text: string): number => [...text].reduce((n, point) => n + stringWidth(point), 0);

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** Deterministic, so a failure can be run again: mulberry32. */
function seeded(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

describe('the columns a string takes', () => {
    it('is the length of plain ASCII, as it always was', () => {
        expect(columnsOf('')).toBe(0);
        expect(columnsOf('word399')).toBe(7);
        expect(columnsOf('a\tb')).toBe(3);
    });

    it('counts a CJK character as the two cells it fills', () => {
        expect(columnsOf('日本語')).toBe(6);
        expect(columnsOf('한국어')).toBe(6);
        expect(columnsOf('Ａ')).toBe(2);
        expect(columnsOf('ｱ')).toBe(1);
    });

    it('counts an accent with the letter it sits on', () => {
        expect(columnsOf('é')).toBe(1);
        expect(columnsOf('é̂̃')).toBe(1);
    });

    it('counts an emoji as two cells, not two code units', () => {
        expect(columnsOf('😀')).toBe(2);
        expect(columnsOf('😀😀😀')).toBe(6);
    });

    // The two rulers of the note in wrap.ts. `string-width` calls a family one
    // glyph of two cells; a terminal that does not join it draws four people.
    it('charges a joined sequence what it costs when the terminal does not join it', () => {
        expect(stringWidth(FAMILY)).toBe(2);
        expect(columnsOf(FAMILY)).toBe(8);
        expect(columnsOf('👍🏽')).toBe(4);
    });

    // SARA AM is a spacing vowel: one cluster, two cells, and `string-width`
    // says one. Trusting it here is how a row ends up wider than the window.
    it('charges a cluster its spacing marks', () => {
        expect(stringWidth('กำ')).toBe(1);
        expect(columnsOf('กำ')).toBe(2);
    });

    it('is never less than Ink counts, nor less than an unjoined terminal draws', () => {
        for (const text of Object.values(CORPUS)) {
            expect(columnsOf(text)).toBeGreaterThanOrEqual(stringWidth(text));
            expect(columnsOf(text)).toBeGreaterThanOrEqual(apart(text));
        }
    });
});

describe('wrapping text that is not one column a character', () => {
    it('never returns a row the terminal would wrap again', () => {
        for (const [name, text] of Object.entries(CORPUS)) {
            for (const width of [8, 13, 20, 40]) {
                for (const row of wrap(text.repeat(4), width)) {
                    expect(columnsOf(row), `${name} at ${width}: ${row}`).toBeLessThanOrEqual(
                        width,
                    );
                    expect(stringWidth(row)).toBeLessThanOrEqual(width);
                    expect(apart(row)).toBeLessThanOrEqual(width);
                }
            }
        }
    });

    it('fills a row with CJK rather than stopping at half of it', () => {
        expect(wrap('日'.repeat(25), 20)).toEqual([
            '日'.repeat(10),
            '日'.repeat(10),
            '日'.repeat(5),
        ]);
    });

    it('moves a wide character down whole when one cell is left', () => {
        expect(wrap('日本語の', 5)).toEqual(['日本', '語の']);
        expect(wrap('a日本語', 4)).toEqual(['a日', '本語']);
    });

    it('never cuts inside a cluster', () => {
        for (const [name, text] of Object.entries(CORPUS)) {
            const word = text.replace(/\s+/g, '').repeat(3);
            for (const width of [8, 9, 16]) {
                const rows = wrap(word, width);
                expect(rows.join(''), name).toBe(word);
                expect(rows.flatMap(clusters), name).toEqual(clusters(word));
                expect(
                    rows.some((row) => LONE_SURROGATE.test(row)),
                    name,
                ).toBe(false);
            }
        }
    });

    it('gets past a character wider than the row it was given', () => {
        expect(wrap('日本', 1)).toEqual(['日', '本']);
        expect(wrap(FAMILY + FAMILY, 4)).toEqual([FAMILY, FAMILY]);
    });

    it('still wraps between words when the words are wide', () => {
        expect(wrap('日本 語の テキ', 9)).toEqual(['日本 語の', 'テキ']);
    });
});

// The earlier `wrap`, `clip` and `windowOf`, verbatim. ASCII is what nearly
// every frame is made of, and nothing about it was wrong: for it the rewrite
// has to be the same function.
function wrapBefore(text: string, width: number): string[] {
    const w = Math.max(1, width);
    const out: string[] = [];
    for (const paragraph of text.split('\n')) {
        let line = '';
        for (const word of paragraph.split(' ')) {
            let rest = word;
            while (rest.length > w) {
                if (line) {
                    out.push(line);
                    line = '';
                }
                out.push(rest.slice(0, w));
                rest = rest.slice(w);
            }
            if (!line) {
                line = rest;
            } else if (line.length + 1 + rest.length <= w) {
                line += ` ${rest}`;
            } else {
                out.push(line);
                line = rest;
            }
        }
        out.push(line);
    }
    return out;
}

function clipBefore(text: string, width: number): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    const w = Math.max(1, width);
    return flat.length <= w ? flat : `${flat.slice(0, w - 1)}…`;
}

function windowBefore(text: string, width: number, rows: number): string[] {
    const w = Math.max(8, width);
    const n = Math.max(1, rows);
    const tail = text
        .slice(-w * n * 2)
        .replace(/\n{2,}/g, '\n')
        .trimEnd();
    return wrapBefore(tail, w).slice(-n);
}

describe('text that is one column a character', () => {
    const SEED = 20260817;
    const ALPHABET = 'abcdefghij  \n\t.,-XYZ0123456789';

    it(`is wrapped, clipped and windowed exactly as before (seed ${SEED})`, () => {
        const random = seeded(SEED);
        const pick = (n: number): number => Math.floor(random() * n);
        for (let round = 0; round < 500; round += 1) {
            const text = Array.from({ length: pick(700) }, () => {
                // Mostly letters, and now and then a word longer than any row.
                return pick(40) === 0 ? 'w'.repeat(pick(90)) : ALPHABET[pick(ALPHABET.length)];
            }).join('');
            const width = pick(60);
            const rows = pick(12);
            expect(wrap(text, width)).toEqual(wrapBefore(text, width));
            expect(clip(text, width)).toBe(clipBefore(text, width));
            expect(windowOf(text, width, rows)).toEqual(windowBefore(text, width, rows));
        }
    });
});

describe('the streaming window over text that is not one column a character', () => {
    it('shows the tail whole, where it used to show half of every row', () => {
        const rows = windowOf(CJK.repeat(10), 40, 6);
        expect(rows).toHaveLength(6);
        expect(CJK.repeat(10).endsWith(rows.join(''))).toBe(true);
        for (const row of rows) {
            expect(stringWidth(row)).toBeLessThanOrEqual(40);
        }
    });

    // Several code units a column: a tail taken by code units alone comes up
    // short of the window while there is more to show.
    it('fills the window when a column costs several code units', () => {
        const stacked = 'é̂̃̄'.repeat(2000);
        const rows = windowOf(stacked, 20, 6);
        expect(rows).toHaveLength(6);
        for (const row of rows.slice(0, -1)) {
            expect(columnsOf(row)).toBe(20);
        }
    });

    it('does not open on half a surrogate pair', () => {
        for (let extra = 0; extra < 4; extra += 1) {
            const rows = windowOf('x'.repeat(extra) + '😀'.repeat(500), 20, 3);
            expect(rows.some((row) => LONE_SURROGATE.test(row))).toBe(false);
        }
    });

    // The tail is cut by code units, and a cut can land anywhere: after the
    // first person of a family, or among the accents of a letter. What is left
    // in front is then a joiner or a mark with nothing to sit on. With text
    // to spare the row it opens is thrown away with the rest of the surplus,
    // so it only shows when the window comes up short — which heavy accents
    // do, by running past how far back the window will look.
    it('opens on a whole cluster even when it cannot fill the window', () => {
        const letter = `e${'\u0301'.repeat(40)}`;
        for (let extra = 0; extra < letter.length; extra += 7) {
            const said = 'x'.repeat(extra) + letter.repeat(5000);
            const rows = windowOf(said, 20, 6);
            expect(rows.length).toBeLessThan(6);
            expect(rows[0]?.startsWith('e'), `cut ${extra}`).toBe(true);
            expect(rows.join('').length % letter.length, `cut ${extra}`).toBe(0);
            expect(said.endsWith(rows.join(''))).toBe(true);
        }
    });

    // The other way to come up short: everything after the cut is blank rows,
    // which are collapsed once the tail has been taken.
    it('opens on a whole cluster when the rest of the tail is blank', () => {
        for (let into = 1; into < FAMILY.length; into += 1) {
            const wanted = 20 * 3 * 2;
            const kept = `${FAMILY.slice(-into)}日`;
            const said = `${'x'.repeat(500)}${FAMILY}日${'\n'.repeat(wanted - kept.length)}`;
            // Whatever the window holds, it is whole clusters of what was said:
            // the family entire, or none of it.
            const shown = windowOf(said, 20, 3).flatMap(clusters);
            const whole = clusters(said.trimEnd());
            expect(shown.at(-1)).toBe('日');
            expect(shown, `cut ${into} from the end`).toEqual(whole.slice(-shown.length));
        }
    });

    it('cuts ASCII where it always did, a line ending included', () => {
        const said = `${'a'.repeat(47)}\r\n${'b'.repeat(15)}`;
        expect(windowOf(said, 8, 1)).toEqual(windowBefore(said, 8, 1));
        expect(windowOf(`a${said}`, 8, 1)).toEqual(windowBefore(`a${said}`, 8, 1));
    });

    it('gives up on text that is nothing but stacked accents rather than read it all', () => {
        const zalgo = `a${'́'.repeat(200000)}`;
        const started = performance.now();
        expect(windowOf(zalgo, 40, 6).length).toBeLessThanOrEqual(6);
        expect(performance.now() - started).toBeLessThan(1000);
    });
});

describe('clipping a row that is not one column a character', () => {
    it('cuts at the columns it was given', () => {
        expect(clip('日本語のテキスト', 10)).toBe('日本語の…');
        expect(columnsOf(clip(CJK, 10))).toBeLessThanOrEqual(10);
    });

    it('leaves a row that fits alone', () => {
        expect(clip('日本語', 6)).toBe('日本語');
    });

    it('never leaves half an emoji behind', () => {
        expect(clip('ab😀😀😀', 4)).toBe('ab…');
        expect(clip('ab😀😀😀', 5)).toBe('ab😀…');
        for (let width = 1; width < 30; width += 1) {
            expect(LONE_SURROGATE.test(clip(EMOJI, width))).toBe(false);
            expect(columnsOf(clip(EMOJI, width))).toBeLessThanOrEqual(Math.max(8, width));
        }
    });

    it('clips the gist of a reasoning stream the same way', () => {
        expect(columnsOf(gistOf(`**${CJK}**`, 30))).toBeLessThanOrEqual(30);
    });
});

describe('a table whose cells are not one column a character', () => {
    const table = '| 名前 | value |\n|---|---:|\n| 東京都 | 1 |\n| Zürich | 22 |\n| 😀 | 3 |';

    it('draws every row the same width', () => {
        const block = blocksOf(table)[0];
        expect(block?.kind).toBe('table');
        const rows = gridOf(block!).map((row) => row.map((s) => s.text).join(''));
        expect(new Set(rows.map((row) => stringWidth(row))).size).toBe(1);
    });

    it('makes the box wide enough to hold it', () => {
        const block = blocksOf(table)[0];
        const widest = Math.max(
            ...gridOf(block!).map((row) => stringWidth(row.map((s) => s.text).join(''))),
        );
        expect(boxWidth(`${'| 列 '.repeat(30)}|`, 200)).toBeGreaterThanOrEqual(30 * 5 + 1 + 4);
        expect(boxWidth(table, 200)).toBeGreaterThanOrEqual(Math.min(196, widest + 4));
    });
});

describe('a fence whose lines are not one column a character', () => {
    it('makes the box wide enough that Ink does not cut the line', () => {
        const line = '日'.repeat(60);
        expect(boxWidth(`\`\`\`\n${line}\n\`\`\``, 200)).toBe(60 * 2 + 6);
    });
});

// The frame itself, through Ink. `Streaming` gives each row a `truncate-end`
// box and the block a fixed height, so a row counted too narrow does not grow
// the frame: Ink cuts it, and what was cut is text nobody sees.
describe('the streaming block as Ink draws it', () => {
    const drawn = (text: string, columns: number, rows: number): string[] =>
        renderToString(createElement(Streaming, { text, columns, rows }), { columns })
            .split('\n')
            .slice(1);

    it('is as tall as it was told to be, whatever the text', () => {
        for (const text of Object.values(CORPUS)) {
            expect(drawn(text.repeat(30), 40, 6)).toHaveLength(6);
        }
    });

    it('draws no row wider than the terminal', () => {
        for (const text of Object.values(CORPUS)) {
            for (const row of drawn(text.repeat(30), 40, 6)) {
                expect(stringWidth(row)).toBeLessThanOrEqual(40);
                expect(apart(row)).toBeLessThanOrEqual(40);
            }
        }
    });

    it('loses none of the tail to truncation', () => {
        for (const [name, text] of Object.entries(CORPUS)) {
            const said = text.repeat(30);
            const rows = drawn(said, 40, 6);
            expect(
                rows.some((row) => row.endsWith('…')),
                name,
            ).toBe(false);
            const shown = rows
                .map((row) => row.trim())
                .join('')
                .replace(/\s+/g, '');
            expect(said.replace(/\s+/g, '').endsWith(shown), name).toBe(true);
        }
    });
});
