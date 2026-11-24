import stringWidth from 'string-width';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// ---------------------------------------------------------------------------
// Terminal Markdown Formatter
//
// Formats markdown text into styled ANSI terminal lines wrapped to a width.
//
// Consumes the block and span AST from `wrap.ts` and applies terminal styling
// from `term.ts` (bold, italic, green for code, underline for links, dimmed
// borders and markers). Line wrapping measures display columns, so ANSI
// escape codes never cause lines to wrap early or misalign borders.
// ---------------------------------------------------------------------------

import { bold, cut, dim, green, italic, styled, underline } from '../term.ts';
import { type Block, blocksOf, gridOf, inlineOf, type Span } from './wrap.ts';

interface StyledPiece {
    text: string;
    bold?: boolean;
    italic?: boolean;
    code?: boolean;
    href?: string;
}

interface StyledWord {
    pieces: StyledPiece[];
    length: number;
}

function renderPiece(piece: StyledPiece): string {
    if (!styled()) {
        return piece.text;
    }
    let t = piece.text;
    if (piece.code) {
        t = green(t);
    }
    if (piece.italic) {
        t = italic(t);
    }
    if (piece.bold) {
        t = bold(t);
    }
    if (piece.href) {
        t = underline(t);
    }
    return t;
}

function sameStyle(a: StyledPiece, b: StyledPiece): boolean {
    return (
        !!a.bold === !!b.bold &&
        !!a.italic === !!b.italic &&
        !!a.code === !!b.code &&
        a.href === b.href
    );
}

function mergePieces(pieces: readonly StyledPiece[]): StyledPiece[] {
    const out: StyledPiece[] = [];
    for (const p of pieces) {
        if (!p.text) continue;
        const last = out[out.length - 1];
        if (last && sameStyle(last, p)) {
            last.text += p.text;
        } else {
            out.push({ ...p });
        }
    }
    return out;
}

function wordsOf(spans: readonly Span[]): StyledWord[] {
    const words: StyledWord[] = [];
    let currentPieces: StyledPiece[] = [];

    for (const span of spans) {
        const style: Omit<Span, 'text'> = {
            ...(span.bold ? { bold: true } : {}),
            ...(span.italic ? { italic: true } : {}),
            ...(span.code ? { code: true } : {}),
            ...(span.href ? { href: span.href } : {}),
        };
        const parts = span.text.split(/(\s+)/);
        for (const part of parts) {
            if (!part) continue;
            if (/^\s+$/.test(part)) {
                if (currentPieces.length > 0) {
                    words.push(wordOf(currentPieces));
                    currentPieces = [];
                }
            } else {
                currentPieces.push({ text: part, ...style });
            }
        }
    }
    if (currentPieces.length > 0) {
        words.push(wordOf(currentPieces));
    }
    return words;
}

function wordOf(pieces: StyledPiece[]): StyledWord {
    return { pieces, length: stringWidth(pieces.map((p) => p.text).join('')) };
}

function sliceWord(word: StyledWord, columns: number): [StyledWord, StyledWord] {
    const text = word.pieces.map((p) => p.text).join('');
    let at = 0;
    let used = 0;
    let replacement = false;
    for (const { segment } of graphemes.segment(text)) {
        const size = stringWidth(segment);
        if (used + size > columns) {
            // A whole grapheme may be wider than the entire available row.
            // Consume it with a replacement so the caller always progresses.
            if (at === 0) {
                at = segment.length;
                replacement = true;
            }
            break;
        }
        at += segment.length;
        used += size;
    }
    const leftPieces: StyledPiece[] = [];
    const rightPieces: StyledPiece[] = [];
    let taken = 0;
    for (const p of word.pieces) {
        // `at` is a grapheme-safe UTF-16 offset; these slices map that offset
        // back to styles, they do not measure terminal columns.
        const end = Math.min(p.text.length, Math.max(0, at - taken));
        if (end > 0) leftPieces.push({ ...p, text: p.text.slice(0, end) });
        if (end < p.text.length) rightPieces.push({ ...p, text: p.text.slice(end) });
        taken += p.text.length;
    }
    if (replacement) {
        return [wordOf([{ ...leftPieces[0], text: '�' }]), wordOf(rightPieces)];
    }
    return [wordOf(leftPieces), wordOf(rightPieces)];
}

export function wrapSpans(
    spans: readonly Span[],
    width: number,
    prefix = '',
    subsequentPrefix = '',
): string[] {
    const w = Math.max(1, width);
    const words = wordsOf(spans);
    if (words.length === 0) {
        return prefix ? [prefix] : [''];
    }

    const lines: string[] = [];
    let currentWords: StyledWord[] = [];
    const prefixLen = stringWidth(prefix);
    const subLen = stringWidth(subsequentPrefix);
    let currentLen = prefixLen;

    const flush = (): void => {
        if (currentWords.length === 0) return;
        const linePieces: StyledPiece[] = [];
        for (let i = 0; i < currentWords.length; i++) {
            const word = currentWords[i]!;
            if (i > 0) {
                const prev = currentWords[i - 1]!;
                const prevPiece = prev.pieces[prev.pieces.length - 1];
                const nextPiece = word.pieces[0];
                const sharedStyle =
                    prevPiece && nextPiece && sameStyle(prevPiece, nextPiece)
                        ? { ...prevPiece, text: ' ' }
                        : { text: ' ' };
                linePieces.push(sharedStyle);
            }
            linePieces.push(...word.pieces);
        }
        const p = lines.length === 0 ? prefix : subsequentPrefix;
        lines.push(p + mergePieces(linePieces).map(renderPiece).join(''));
        currentWords = [];
        currentLen = subLen;
    };

    for (let word of words) {
        const available = lines.length === 0 ? w - prefixLen : w - subLen;

        while (word.length > available && available > 0) {
            if (currentWords.length > 0) {
                flush();
            }
            const [head, tail] = sliceWord(word, available);
            const p = lines.length === 0 ? prefix : subsequentPrefix;
            lines.push(p + mergePieces(head.pieces).map(renderPiece).join(''));
            word = tail;
            currentLen = subLen;
        }

        const spaceNeeded = currentWords.length > 0 ? 1 : 0;
        if (currentLen + spaceNeeded + word.length <= w) {
            currentWords.push(word);
            currentLen += spaceNeeded + word.length;
        } else {
            flush();
            currentWords.push(word);
            const p = lines.length === 0 ? prefix : subsequentPrefix;
            currentLen = stringWidth(p) + word.length;
        }
    }

    flush();
    return lines;
}

/**
 * Render a sequence of AST `Block`s into styled terminal lines wrapped to `width`.
 */
export function formatBlocks(blocks: readonly Block[], width = 80): string[] {
    const lines: string[] = [];
    let previous: Block | undefined;
    for (const block of blocks) {
        if (previous && !(block.kind === 'item' && previous.kind === 'item')) {
            lines.push('');
        }
        previous = block;
        if (block.kind === 'code') {
            lines.push(dim(`\u250c\u2500${block.title ? ` ${block.title}` : ''}`));
            lines.push(
                ...(block.lines ?? []).map(
                    (l) => `${dim('\u2502')} ${cut(l, Math.max(0, width - 2))}`,
                ),
            );
            lines.push(dim('\u2514\u2500'));
        } else if (block.kind === 'table') {
            for (const [j, row] of gridOf(block).entries()) {
                let formatted: string;
                if (block.align !== undefined && j === 0) {
                    formatted = row
                        .map((s) =>
                            s.text === '| ' || s.text === ' | ' || s.text === ' |'
                                ? dim(s.text)
                                : renderPiece({ ...s, bold: true }),
                        )
                        .join('');
                } else if (block.align !== undefined && j === 1) {
                    formatted = dim(row.map((s) => s.text).join(''));
                } else {
                    formatted = row
                        .map((s) =>
                            s.text === '| ' || s.text === ' | ' || s.text === ' |'
                                ? dim(s.text)
                                : renderPiece(s),
                        )
                        .join('');
                }
                lines.push(cut(formatted, width));
            }
        } else if (block.kind === 'heading') {
            const headingSpans = (block.spans ?? []).map((s) => ({ ...s, bold: true }));
            lines.push(...wrapSpans(headingSpans, width));
        } else if (block.kind === 'item') {
            const indentLevel = block.level ?? 0;
            const marker = block.marker ?? '\u2022';
            const leadSpaces = '  '.repeat(indentLevel);
            const prefix = `${leadSpaces}${dim(marker)} `;
            const subPrefix = `${leadSpaces}${' '.repeat(stringWidth(marker) + 1)}`;
            lines.push(...wrapSpans(block.spans ?? [], width, prefix, subPrefix));
        } else if (block.kind === 'quote') {
            const quoteSpans = (block.spans ?? []).map((s) => ({ ...s, italic: true }));
            lines.push(...wrapSpans(quoteSpans, width, `${dim('\u2502')} `, `${dim('\u2502')} `));
        } else if (block.kind === 'rule') {
            lines.push(dim('\u2500'.repeat(width)));
        } else if (block.lines) {
            lines.push(...block.lines.map((l) => cut(l, width)));
        } else {
            lines.push(...wrapSpans(block.spans ?? [], width));
        }
    }
    return lines;
}

/**
 * Format markdown text into styled ANSI terminal lines wrapped to `width`.
 */
export function formatMarkdown(text: string, width = 80): string[] {
    return formatBlocks(blocksOf(text), width);
}

/**
 * Format inline markdown text (bold, italic, code, links) into a styled ANSI string.
 * Markers like backticks and asterisks are resolved and removed.
 */
export function formatInline(text: string): string {
    const spans = inlineOf(text);
    return mergePieces(
        spans.map((s) => ({
            text: s.text,
            ...(s.bold ? { bold: true } : {}),
            ...(s.italic ? { italic: true } : {}),
            ...(s.code ? { code: true } : {}),
            ...(s.href ? { href: s.href } : {}),
        })),
    )
        .map(renderPiece)
        .join('');
}
