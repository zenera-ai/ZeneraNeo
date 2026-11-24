import { describe, expect, it } from 'vitest';
import stringWidth from 'string-width';
import { cut, pad, plain, table } from '../src/term.ts';
import { wrapSpans } from '../src/tui/markdown.ts';
import { blocksOf, boxWidth, clip, gridOf, windowOf, wrap } from '../src/tui/wrap.js';

describe('terminal display columns', () => {
    it('wraps CJK words and mixed prose by columns', () => {
        expect(wrap('你好世界你好', 4)).toEqual(['你好', '世界', '你好']);
        expect(wrap('ab 你好 cd', 6)).toEqual(['ab', '你好', 'cd']);
    });

    it('keeps combining sequences and emoji graphemes intact', () => {
        for (const grapheme of ['e\u0301', '👩🏽‍💻', '🇰🇪', '❤️']) {
            const width = stringWidth(grapheme);
            expect(wrap(grapheme.repeat(3), width * 2)).toEqual([grapheme.repeat(2), grapheme]);
        }
    });

    it('clips complete graphemes and reserves a column for the ellipsis', () => {
        expect(clip('你好世界', 5)).toBe('你好…');
        expect(clip('e\u0301'.repeat(4), 3)).toBe('e\u0301e\u0301…');
        expect(clip('👩🏽‍💻abc', 4)).toBe('👩🏽‍💻a…');
        expect(clip('你好', 1)).toBe('…');
    });

    it('uses a replacement when a whole grapheme cannot fit even on an empty row', () => {
        expect(wrap('你a', 1)).toEqual(['�', 'a']);
    });

    it('bounds the streaming frame in displayed rows and preserves its tail', () => {
        for (const unit of ['你好', '👩🏽‍💻', '你好👩🏽‍💻e\u0301']) {
            const rows = windowOf(unit.repeat(200) + ' END', 8, 3);
            expect(rows).toHaveLength(3);
            expect(rows.at(-1)).toContain('END');
            for (const row of rows) {
                expect(stringWidth(row)).toBeLessThanOrEqual(8);
                expect(row).not.toContain('\ufffd');
            }
        }
    });

    it('does not cut a combining sequence at the streaming tail boundary', () => {
        const grapheme = 'e' + '\u0301'.repeat(80);
        expect(windowOf('prefix ' + grapheme, 8, 1)).toEqual([grapheme]);
    });

    it('pads styled table cells by their visible width', () => {
        const block = blocksOf('| Name | Value |\n| --- | ---: |\n| **你好** | e\u0301 |')[0]!;
        const rows = gridOf(block).map((row) => row.map((span) => span.text).join(''));
        expect(rows).toEqual(['| Name | Value |', '|------|-------|', '| 你好 |     e\u0301 |']);
        expect(new Set(rows.map((row) => stringWidth(row))).size).toBe(1);
    });

    it('sizes a code box using columns rather than code units', () => {
        expect(boxWidth('```\n' + '你'.repeat(30) + '\n```', 100)).toBe(96);
        expect(boxWidth('```\n' + '你'.repeat(48) + '\n```', 120)).toBe(102);
    });

    it('keeps ASCII word wrapping and whitespace behavior', () => {
        expect(wrap('one two three', 7)).toEqual(['one two', 'three']);
        expect(wrap('abcdefghij xyz', 4)).toEqual(['abcd', 'efgh', 'ij', 'xyz']);
        expect(wrap(' a  b\n\n', 8)).toEqual(['a  b', '', '']);
        expect(clip('a\n b\t c', 5)).toBe('a b c');
    });
});

describe('other terminal renderers', () => {
    it('aligns the shared ANSI table without counting style codes or UTF-16 units', () => {
        const rows = table([
            ['\u001b[1m你\u001b[22m', 'role'],
            ['e\u0301', 'role'],
            ['👩🏽‍💻', 'role'],
        ]);
        for (const row of rows) {
            expect(stringWidth(row.slice(0, row.indexOf('role')))).toBe(4);
        }
        expect(pad('abc', 5)).toBe('abc  ');
        expect(
            table([
                ['a', 'b'],
                ['abc', 'd'],
            ]),
        ).toEqual(['a    b', 'abc  d']);
    });

    it('clips ANSI text on grapheme boundaries, even when styles split a cluster', () => {
        expect(plain(cut('\u001b[1m你好世界\u001b[22m', 5))).toBe('你好…');
        expect(plain(cut('e\u001b[1m\u0301abc\u001b[22m', 3))).toBe('e\u0301a…');
        expect(plain(cut('👩🏽‍💻abc', 4))).toBe('👩🏽‍💻a…');
        expect(cut('short', 5)).toBe('short');
        expect(cut('abcdefghij', 5)).toBe('abcd…\u001b[0m');
    });

    it('wraps styled spans in columns while preserving clusters across spans', () => {
        expect(wrapSpans([{ text: '你好世界你好', bold: true }], 4).map(plain)).toEqual([
            '你好',
            '世界',
            '你好',
        ]);
        expect(wrapSpans([{ text: '👩🏽‍💻'.repeat(3) }], 4).map(plain)).toEqual(['👩🏽‍💻👩🏽‍💻', '👩🏽‍💻']);
        expect(wrapSpans([{ text: 'e' }, { text: '\u0301abc', bold: true }], 2).map(plain)).toEqual(
            ['e\u0301a', 'bc'],
        );
        expect(wrapSpans([{ text: '你a' }], 1).map(plain)).toEqual(['�', 'a']);
        const rows = wrapSpans([{ text: 'one two three' }], 8, '你 ', '  ').map(plain);
        expect(rows).toEqual(['你 one', '  two', '  three']);
        expect(rows.every((row) => stringWidth(row) <= 8)).toBe(true);
        expect(wrapSpans([{ text: 'one two three' }], 7).map(plain)).toEqual(['one two', 'three']);
    });
});
