import { describe, expect, it } from 'vitest';

import { blocksOf, boxWidth, clip, textOf, windowOf, wrap } from '../src/tui/wrap.ts';

// A terminal draws in columns and a string counts in UTF-16 units. A row
// measured in units is too wide when it holds double-width characters, so the
// terminal wraps it and the frame is taller than it was counted.

const HAN = '\u{6F22}'; // 漢, two columns
const E_ACUTE = 'e\u{301}'; // é as a letter and a combining mark, one column
const FAMILY = '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}'; // one emoji, two columns

/** Columns of a string made only of `漢` and ASCII, counted independently. */
const han = (s: string): number => [...s].reduce((n, ch) => n + (ch === HAN ? 2 : 1), 0);

describe('wide characters in a row', () => {
    it('breaks double-width text at the column, not the unit', () => {
        expect(wrap(HAN.repeat(12), 10)).toEqual([HAN.repeat(5), HAN.repeat(5), HAN.repeat(2)]);
        // An odd width leaves a column unused rather than splitting a character.
        expect(wrap(HAN.repeat(4), 5)).toEqual([HAN.repeat(2), HAN.repeat(2)]);
    });

    it('does not join words whose columns do not fit', () => {
        const word = HAN.repeat(3);
        expect(wrap(`${word} ${word} ab`, 10)).toEqual([word, `${word} ab`]);
    });

    it('keeps a combining mark on its letter and an emoji whole', () => {
        expect(wrap(E_ACUTE.repeat(10), 10)).toEqual([E_ACUTE.repeat(10)]);
        expect(wrap(E_ACUTE.repeat(7), 5)).toEqual([E_ACUTE.repeat(5), E_ACUTE.repeat(2)]);
        expect(wrap(FAMILY.repeat(3), 4)).toEqual([FAMILY.repeat(2), FAMILY]);
    });

    it('still ends when one character is wider than the row', () => {
        expect(wrap(HAN.repeat(2), 1)).toEqual([HAN.repeat(2)]);
    });

    it('fills the streaming window with rows the terminal will not wrap again', () => {
        const rows = windowOf(HAN.repeat(2000), 40, 6);
        expect(rows).toHaveLength(6);
        for (const row of rows) {
            expect(han(row)).toBe(40);
        }
    });

    it('clips by columns', () => {
        expect(clip(HAN.repeat(6), 5)).toBe(`${HAN.repeat(2)}…`);
        expect(clip(HAN.repeat(2), 4)).toBe(HAN.repeat(2));
        expect(clip(E_ACUTE.repeat(5), 5)).toBe(E_ACUTE.repeat(5));
        expect(clip(FAMILY.repeat(3), 5)).toBe(`${FAMILY.repeat(2)}…`);
    });

    it('sizes the answer box to the columns of a fence', () => {
        expect(boxWidth(`\`\`\`\n${HAN.repeat(60)}\n\`\`\``, 200)).toBe(126);
    });

    it('lines a table up on columns', () => {
        const table = blocksOf(`| ${HAN}${HAN} | n |\n|---|---|\n| ab | 1 |`)[0];
        expect(textOf(table!).split('\n')).toEqual([
            `| ${HAN}${HAN} | n   |`,
            '|------|-----|',
            '| ab   | 1   |',
        ]);
    });
});
