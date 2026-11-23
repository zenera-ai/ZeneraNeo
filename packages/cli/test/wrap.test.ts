/**
 * The TUI measures text in the columns a terminal draws, not in the code units
 * a string is stored as. A CJK ideograph is one code unit and two columns; an
 * emoji joined by zero-width joiners is eleven code units and two columns; a
 * combining mark is one code unit and no columns at all. Measuring the wrong
 * one makes a row the layout believes is four columns wide arrive as eight,
 * wrap again inside the terminal, and push the frame past the viewport — the
 * one thing Ink cannot repaint away.
 *
 * These tests are written against the drawing model rather than the current
 * implementation: every row is checked in columns with the same library Ink
 * uses, so an ASCII-only fix that happens to pass for Latin text cannot pass
 * here.
 */
import stringWidth from 'string-width';
import { describe, expect, it } from 'vitest';
import { blocksOf, boxWidth, clip, gridOf, windowOf, wrap } from '../src/tui/wrap.ts';

/** The columns a terminal draws `text` in. */
const columns = (text: string): number => stringWidth(text);

/** The grapheme clusters of `text`, which are the units a terminal draws. */
const graphemes = (text: string): string[] =>
    Array.from(new Intl.Segmenter().segment(text), (s) => s.segment);

const FAMILY = '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}';

describe('wrapping in terminal columns', () => {
    it('leaves plain ASCII exactly as it was', () => {
        expect(wrap('the quick brown fox jumps', 12)).toEqual(['the quick', 'brown fox', 'jumps']);
        expect(wrap('x'.repeat(25), 10)).toEqual(['xxxxxxxxxx', 'xxxxxxxxxx', 'xxxxx']);
    });

    it('counts a wide character as two columns', () => {
        expect(columns('你好世界')).toBe(8);
        expect(wrap('你好世界', 4)).toEqual(['你好', '世界']);
    });

    it('never splits a base character from its combining mark', () => {
        // One code unit each, no columns of their own: the pair is the unit.
        const a = 'á';
        const b = 'b́';
        expect(columns(`${a}${b}`)).toBe(2);
        expect(wrap(`${a}${b}`, 1)).toEqual([a, b]);
    });

    it('keeps a zero-width-joiner emoji in one piece', () => {
        expect(columns(FAMILY)).toBe(2);
        expect(wrap(`${FAMILY}${FAMILY}`, 2)).toEqual([FAMILY, FAMILY]);
    });

    it('breaks a wide word at a grapheme, not at a code unit', () => {
        const row = '你好世界';
        expect(wrap(row, 3)).toEqual(['你', '好', '世', '界']);
    });

    it('never returns a row the terminal would wrap again', () => {
        const samples = [
            'the quick brown fox',
            '你好世界',
            'áb́ć',
            FAMILY,
            '你好 hello 世界',
            '❤️❤️',
        ];
        for (const sample of samples) {
            for (const width of [1, 2, 3, 4, 5, 8, 10]) {
                for (const row of wrap(sample, width)) {
                    const measured = columns(row);
                    if (measured <= width) {
                        continue;
                    }
                    // The only row allowed to be too wide is one grapheme that
                    // is itself wider than the whole row: there is nothing
                    // smaller to break it into.
                    const parts = graphemes(row);
                    expect(parts).toHaveLength(1);
                    expect(columns(parts[0] as string)).toBeGreaterThan(width);
                }
            }
        }
    });
});

describe('clipping in terminal columns', () => {
    it('leaves text that fits alone', () => {
        expect(clip('short', 10)).toBe('short');
    });

    it('counts wide characters as two columns', () => {
        expect(columns('你好世界')).toBe(8);
        expect(clip('你好世界', 5)).toBe('你好…');
    });

    it('does not split a grapheme when it truncates', () => {
        expect(clip(FAMILY, 3)).toBe(FAMILY);
        expect(clip('😀😀', 3)).toBe('😀…');
    });

    it('never returns more columns than it was given', () => {
        for (const sample of ['你好世界', FAMILY, '😀😀', 'áb́ć']) {
            for (const width of [1, 2, 3, 4, 5, 8]) {
                expect(columns(clip(sample, width))).toBeLessThanOrEqual(width);
            }
        }
    });
});

describe('the streaming window in columns', () => {
    // `windowOf` never draws narrower than eight columns, so the width here is
    // the one it will actually use.
    it('returns rows the terminal will not wrap again', () => {
        const text = '你好世界'.repeat(20);
        const rows = windowOf(text, 8, 3);
        expect(rows).toHaveLength(3);
        for (const row of rows) {
            expect(columns(row)).toBeLessThanOrEqual(8);
        }
    });

    it('shows the tail of a wide stream, which is where it is', () => {
        const rows = windowOf('你好世界'.repeat(20), 8, 3);
        expect(rows.at(-1)).toContain('界');
    });

    it('leaves plain ASCII exactly as it was', () => {
        expect(windowOf('one\ntwo', 40, 6)).toEqual(['one', 'two']);
    });
});

describe('a box wide enough for wide characters', () => {
    it('measures a code fence in columns', () => {
        const line = '你'.repeat(60);
        expect(columns(line)).toBe(120);
        // The fence costs six columns of chrome; the box must hold the line.
        expect(boxWidth(`\`\`\`\n${line}\n\`\`\``, 300)).toBe(126);
    });

    it('measures a table row in columns', () => {
        const row = `| ${'你'.repeat(50)} |`;
        expect(columns(row)).toBe(104);
        expect(boxWidth(`look:\n${row}`, 300)).toBe(108);
    });

    it('leaves an ASCII table exactly as it was', () => {
        const row = `| ${'x'.repeat(116)} |`;
        expect(boxWidth(`look:\n${row}`, 200)).toBe(124);
        expect(boxWidth(`look:\n${row}`, 100)).toBe(96);
    });

    it('lays every row of a table out to the same column', () => {
        const table = ['| name | city |', '| --- | --- |', '| 你 | 北京 |'].join('\n');
        const block = blocksOf(table)[0];
        expect(block?.kind).toBe('table');
        const rows = gridOf(block!).map((row) => row.map((span) => span.text).join(''));
        expect(rows).toHaveLength(3);
        expect(new Set(rows.map(columns)).size).toBe(1);
    });
});
