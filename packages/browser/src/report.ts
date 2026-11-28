import { accessSync, constants } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import type { PageSession, Problem } from './session.ts';
import { PREVIEW, SHOT_HEIGHT, short } from './session.ts';
import { widthName } from './widths.ts';

// ---------------------------------------------------------------------------
// The check of one page: load, look, report
//
// Opens the page at the chat panel's width and waits for it to settle, then: what went wrong
// while it loaded (exceptions, console errors, failed requests and function calls, blocked
// hosts), whether it drew anything, whether it scrolls sideways; a screenshot at each width
// asked for (DEFAULT_WIDTHS: panel, wide-panel, tab), and the panel in dark. One load: a page's
// functions run once, so the widths are taken one after another, not side by side. Screenshots
// show the top SHOT_HEIGHT px, so a model can read them. A page of a workspace also gets its
// preview beside it (previewFile): the picture the chat's card for it shows, named by the
// og:image the html-page build writes.
//
// Main: checkPage, CheckOptions, PageReport, reportLines.
// Used by: @zenera/cli `zen page check` (commands/page.ts) and `zen page check` on a running
// session (page/daemon.ts).
// ---------------------------------------------------------------------------

export interface CheckOptions {
    /** widths, the first the panel's (sideways scrolling there is an error) */
    widths: number[];
    dark: boolean;
    outDir: string;
    /** ms to wait for the page to settle */
    timeoutMs: number;
    /** write the card's preview beside a local page (previewFile); not for a URL */
    preview?: boolean;
}

export interface PageScreenshot {
    file: string;
    width: number;
    dark: boolean;
}

export interface PageReport {
    page: string;
    ms: number;
    pending: string[];
    problems: Problem[];
    screenshots: PageScreenshot[];
    /** the page's height at the panel's width, px: taller than SHOT_HEIGHT, the shots are its top */
    height: number;
    /** the card's preview written beside the page */
    preview?: string;
}

/**
 * Where a page's card picture goes: beside it, preview.png for index.html, report.preview.png
 * for report.html - the og:image the html-page build names. Null for a URL.
 */
export function previewFile(page: string): string | null {
    if (/^https?:\/\//i.test(page)) return null;
    const base = basename(page).replace(/\.html?$/i, '');
    return join(dirname(page), base === 'index' ? 'preview.png' : `${base}.preview.png`);
}

export async function checkPage(
    session: PageSession,
    page: string,
    opts: CheckOptions,
    /** the page is open already (a running session): check it as it is */
    loaded = false,
): Promise<PageReport> {
    const problems: Problem[] = [];
    const screenshots: PageScreenshot[] = [];
    let height = 0;
    const [panel, ...wider] = opts.widths;
    await session.setView({ width: panel, dark: false });
    const settled = loaded
        ? await session.settle(opts.timeoutMs)
        : await session.goto(page, opts.timeoutMs);
    if (settled.pending.length) {
        problems.push({
            level: 'warning',
            text: `still loading after ${(opts.timeoutMs / 1000).toFixed(0)} s - waiting on ${settled.pending.join(', ')}`,
        });
    }
    if (await session.empty()) {
        problems.push({ level: 'error', text: 'the page shows nothing: no text, no picture' });
    }
    const base = basename(short(page), extname(short(page))) || 'page';
    const shot = async (width: number, dark: boolean) => {
        const file = join(opts.outDir, `${base}-${widthName(width)}${dark ? '-dark' : ''}.png`);
        const taken = await session.screenshot(file, { width, dark });
        if (width === panel && !dark) height = taken.height;
        screenshots.push({ file, width, dark });
    };
    const sideways = async (width: number) => {
        const o = await session.overflow();
        if (!o) return;
        problems.push({
            level: width === panel ? 'error' : 'warning',
            text: `${widthName(width)} (${width} px): the page is ${o.width} px wide and scrolls sideways${o.elements.length ? ` - ${o.elements.join('; ')}` : ''}`,
        });
    };
    await sideways(panel);
    await shot(panel, false);
    for (const width of wider) {
        await session.setView({ width });
        await session.settle(2000);
        await sideways(width);
        await shot(width, false);
    }
    if (opts.dark) await shot(panel, true);
    let preview: string | undefined;
    const card = opts.preview ? previewFile(page) : null;
    if (card) {
        try {
            accessSync(dirname(card), constants.W_OK);
            await session.preview(card);
            preview = card;
        } catch {
            problems.push({
                level: 'warning',
                text: `could not write ${card}: the chat's card for the page shows no picture`,
            });
        }
    }
    await session.setView({ width: panel, dark: false });
    problems.unshift(...session.takeProblems());
    return {
        page,
        ms: settled.ms,
        pending: settled.pending,
        problems,
        screenshots,
        height,
        preview,
    };
}

export const errorsIn = (r: PageReport) => r.problems.filter((p) => p.level === 'error').length;

/** The report as the agent reads it: a line per problem, then the screenshots. */
export function reportLines(r: PageReport, shown: (path: string) => string): string[] {
    const lines: string[] = [];
    const name = short(r.page);
    lines.push(
        errorsIn(r)
            ? `✗ ${name}: ${errorsIn(r)} error${errorsIn(r) > 1 ? 's' : ''} (loaded in ${(r.ms / 1000).toFixed(1)} s)`
            : `✓ ${name} loaded in ${(r.ms / 1000).toFixed(1)} s`,
    );
    for (const p of r.problems) lines.push(`${p.level === 'error' ? '✗' : '⚠'} ${p.text}`);
    if (r.screenshots.length) {
        lines.push('screenshots - open them all at once, one view_image each in the same reply:');
        for (const s of r.screenshots) {
            const at = `${widthName(s.width)}, ${s.width} px${s.dark ? ', dark' : ''}`;
            lines.push(`  ${shown(s.file)}  (${at})`);
        }
        if (r.preview) {
            lines.push(
                `  ${shown(r.preview)}  (the chat's card for the page, ${PREVIEW.width}×${PREVIEW.height}, light)`,
            );
        }
        if (r.height > SHOT_HEIGHT) {
            lines.push(
                `  the page is ${r.height} px tall: these show its top ${SHOT_HEIGHT} px; ` +
                    '`zen page screenshot --full` (in a session) takes the rest in parts',
            );
        }
    }
    return lines;
}
