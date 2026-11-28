import { usageError } from '@zenera/engine';

// ---------------------------------------------------------------------------
// The widths a page is looked at
//
// Named after where the chat shows a page, at the widths the html-page kit's layout changes
// (kit/theme.css): under 520 px it goes compact; from 860 px a Split puts list and detail side
// by side. One width on each side of both covers every layout the kit has.
//
// Main: WIDTH_PRESETS, DEFAULT_WIDTHS, widthOf, widthsOf, widthName.
// Used by: report.ts (the check's widths); @zenera/cli `zen page` (--widths, --width, resize).
// ---------------------------------------------------------------------------

export const WIDTH_PRESETS = {
    /** the chat's side panel, and a phone: compact, everything stacked */
    panel: 400,
    /** a wide panel or a tablet: full size, a Split still one column */
    'wide-panel': 640,
    /** a full browser tab: a Split side by side, grids spread out */
    tab: 1280,
} as const;

export type WidthPreset = keyof typeof WIDTH_PRESETS;

/** What a check looks at: every layout the kit has, the panel first. */
export const DEFAULT_WIDTHS: readonly number[] = Object.values(WIDTH_PRESETS);

const MIN_WIDTH = 200;
const MAX_WIDTH = 3840;

/** A preset's name or a number of px. */
export function widthOf(text: string): number {
    const name = text.trim().toLowerCase();
    if (name in WIDTH_PRESETS) return WIDTH_PRESETS[name as WidthPreset];
    const px = Number(name.replace(/px$/, ''));
    if (!Number.isInteger(px) || px < MIN_WIDTH || px > MAX_WIDTH) {
        throw usageError(
            `not a width: "${text}"`,
            `a preset (${Object.keys(WIDTH_PRESETS).join(', ')}) or px from ${MIN_WIDTH} to ${MAX_WIDTH}`,
        );
    }
    return px;
}

/** A comma-separated list of widths; DEFAULT_WIDTHS when none is given. */
export function widthsOf(text: string | undefined): number[] {
    if (text === undefined) return [...DEFAULT_WIDTHS];
    const out = text
        .split(',')
        .filter((w) => w.trim())
        .map(widthOf);
    if (!out.length) throw usageError('--widths names no width');
    return out;
}

/** The preset a width is, for file names and messages: `panel`, or `900`. */
export function widthName(px: number): string {
    return Object.entries(WIDTH_PRESETS).find(([, w]) => w === px)?.[0] ?? String(px);
}
