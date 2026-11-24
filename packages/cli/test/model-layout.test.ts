import { Box, renderToString } from 'ink';
import { createElement } from 'react';
import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';
import stringWidth from 'string-width';
import type { CatalogEntry } from '../src/catalog.ts';
import { ModelTableRow } from '../src/tui/models.tsx';
import { THEMES } from '../src/tui/theme.ts';
import { padEndCols, padStartCols } from '../src/tui/wrap.ts';

function table(names: string[], withMaker = true): string[] {
    return stripVTControlCharacters(
        renderToString(
            createElement(
                Box,
                { flexDirection: 'column' },
                ...names.map((name, i) => {
                    const entry: CatalogEntry = {
                        ref: `openai:${i}`,
                        id: name,
                        publisher: name,
                        provider: 'openai',
                        source: 'live',
                        roles: ['chat'],
                        contextLength: 128000,
                    };
                    return createElement(ModelTableRow, {
                        key: entry.ref,
                        entry,
                        here: false,
                        verdict: { state: 'live', ms: 1 },
                        theme: THEMES.dark,
                        idW: 10,
                        roleWidth: 6,
                        withMaker,
                        priced: false,
                    });
                }),
            ),
            { columns: 100 },
        ),
    ).split('\n');
}

describe('the rendered model table', () => {
    it('aligns role and context columns for CJK, emoji, combining marks and ASCII', () => {
        const rows = table([
            '你',
            '你好世界你好世界你好',
            '👩🏽‍💻'.repeat(8),
            'e\u0301'.repeat(15),
            'model',
        ]);
        expect(rows).toHaveLength(5);
        expect(new Set(rows.map((row) => stringWidth(row))).size).toBe(1);
        for (const row of rows) {
            expect(row).toContain('chat');
            expect(row).toContain('128k');
            expect(stringWidth(row.slice(0, row.indexOf('chat')))).toBe(24);
            expect(stringWidth(row.slice(0, row.indexOf('128k')))).toBe(33);
        }
    });

    it('keeps the original ASCII spacing with and without a publisher column', () => {
        expect(table(['model'])[0]).toBe('  model     model       chat     128k  ✓ answers 1ms');
        expect(table(['model'], false)[0]).toBe('  model     chat     128k  ✓ answers 1ms');
    });

    it('pads a clipped field by columns without truncating wider text', () => {
        expect(padEndCols('你好…', 6)).toBe('你好… ');
        expect(padEndCols('e\u0301', 3)).toBe('e\u0301  ');
        expect(padEndCols('', 3)).toBe('   ');
        expect(padEndCols('你好', 2)).toBe('你好');
        expect(padStartCols('你', 4)).toBe('  你');
        expect(padStartCols('123', 5)).toBe('  123');
    });
});
