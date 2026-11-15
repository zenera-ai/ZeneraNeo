import stringWidth from 'string-width';
import { describe, expect, it } from 'vitest';

import { blocksOf, boxWidth, clip, gridOf, textOf, windowOf, wrap } from '../src/tui/wrap.ts';

// The rows from the streaming window have to be narrow enough that the terminal
// does not wrap them again. That is counted in columns, and Ink counts columns
// with string-width, so these tests use it as the reference.

const columns = (row: string): number => stringWidth(row);

const graphemes = (text: string): string[] =>
    [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(
        (s) => s.segment,
    );

/** Text where `.length` gives the wrong width. */
const SAMPLES: Record<string, string> = {
    // Two columns per character, one unit each. No spaces, so it is one long word.
    cjk: '日本語のテキストは単語の間に空白を置かずに書かれるので、折り返しは文字の幅で数えなければならない。',
    fullwidth: 'ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺ０１２３４５６７８９',
    // Two columns and two units each, so slicing by units can cut one in half.
    emoji: '🚀🔥✨🎉🧪🛰️🌍🌱🔬🧬🚦📦🧭🔒🔑🧠⚙️🛠️📈📉',
    // A family is one character, seven code points, two columns.
    zwj: '👨‍👩‍👧‍👦👩🏽‍🚀🏳️‍🌈👨‍💻🧑‍🤝‍🧑👩‍❤️‍👨',
    flags: '🇯🇵🇺🇸🇮🇳🇩🇪🇧🇷🇬🇧🇫🇷🇰🇷🇨🇦🇦🇺',
    // No columns each, but `.length` counts them as one.
    combining: 'éééééééééééé',
    mixed: 'deploy 日本語 to 🚀 production, then verify ✅ every service in 東京 and 서울 before the 🎉 announcement',
};

describe('wrapping wide characters', () => {
    for (const [name, text] of Object.entries(SAMPLES)) {
        for (const width of [8, 11, 20]) {
            it(`${name}: no row is wider than ${width} columns`, () => {
                for (const row of wrap(text, width)) {
                    expect(columns(row)).toBeLessThanOrEqual(width);
                }
            });
        }

        it(`${name}: keeps every character in order and cuts none in half`, () => {
            const rows = wrap(text, 11);
            // Rows are joined with a space, since a break at a space drops it.
            expect(rows.join(' ').replace(/ /g, '')).toBe(text.replace(/ /g, ''));
            for (const row of rows) {
                expect(row.isWellFormed()).toBe(true);
                // Splitting a row into characters again gives back the same row.
                expect(graphemes(row).join('')).toBe(row);
            }
            // No character was split across two rows.
            expect(
                rows
                    .flatMap(graphemes)
                    .filter((g) => g !== ' ')
                    .join(''),
            ).toBe(
                graphemes(text)
                    .filter((g) => g !== ' ')
                    .join(''),
            );
        });
    }

    it('fits a wide character into the next row rather than past the edge', () => {
        // Ten columns hold five wide characters, the sixth starts a new row.
        expect(wrap('日本語です。', 10)).toEqual(['日本語です', '。']);
        // With an odd width, one column is left empty instead of overflowing.
        expect(wrap('日本語です。', 9)).toEqual(['日本語で', 'す。']);
    });

    it('still makes progress when one character is wider than the row', () => {
        // It can't fit in one column, so the row overflows by one instead of
        // looping forever.
        expect(wrap('日本', 1)).toEqual(['日', '本']);
    });

    it('leaves narrow text exactly as it was', () => {
        expect(wrap('the quick brown fox', 10)).toEqual(['the quick', 'brown fox']);
        expect(wrap('x'.repeat(25), 10)).toEqual(['xxxxxxxxxx', 'xxxxxxxxxx', 'xxxxx']);
    });
});

describe('clipping wide characters', () => {
    for (const [name, text] of Object.entries(SAMPLES)) {
        it(`${name}: the clipped row fits its width and is well formed`, () => {
            for (const width of [5, 10, 15]) {
                const out = clip(text, width);
                expect(columns(out)).toBeLessThanOrEqual(width);
                expect(out.isWellFormed()).toBe(true);
            }
        });
    }

    it('marks a cut with an ellipsis and keeps as much as fits', () => {
        expect(clip('日本語のテキスト', 7)).toBe('日本語…');
    });

    it('does not clip a wide row that fits', () => {
        expect(clip('日本語', 6)).toBe('日本語');
    });
});

describe('the streaming window with wide characters', () => {
    for (const [name, text] of Object.entries(SAMPLES)) {
        it(`${name}: every row of a long stream fits`, () => {
            const stream = text.repeat(40);
            // Different widths cut the tail at different places, including the
            // middle of a surrogate pair or a combining mark.
            for (let width = 8; width < 30; width++) {
                for (const row of windowOf(stream, width, 5)) {
                    expect(columns(row)).toBeLessThanOrEqual(width);
                    expect(row.isWellFormed()).toBe(true);
                }
            }
        });
    }

    it('returns the requested number of rows when the stream is wide enough to fill them', () => {
        expect(windowOf(SAMPLES.cjk!.repeat(20), 20, 6)).toHaveLength(6);
    });
});

describe('tables of wide characters', () => {
    const table = [
        '| name | note |',
        '| --- | --- |',
        '| 東京 | tokyo |',
        '| ab | 🚀 launch |',
        '| 서울 | seoul |',
    ].join('\n');

    it('draws every row of the table the same number of columns wide', () => {
        const block = blocksOf(table).find((b) => b.kind === 'table')!;
        const rows = textOf(block).split('\n');
        const widths = new Set(rows.map(columns));
        expect([...widths]).toHaveLength(1);
        expect(gridOf(block).length).toBe(rows.length);
    });

    it('grows the box to hold the table as the terminal draws it', () => {
        const block = blocksOf(table).find((b) => b.kind === 'table')!;
        const widest = Math.max(...textOf(block).split('\n').map(columns));
        expect(boxWidth(table, 200)).toBeGreaterThanOrEqual(widest + 4);
    });
});
