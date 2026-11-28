import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { RUNTIME_PYTHON, RUNTIME_SOURCE, usageError, type FileTrees } from '@zenera/engine';

// ---------------------------------------------------------------------------
// What `zen page` was pointed at, and where its files go
//
// A page folder (`/workspace/pages/todo`: its index.html, then every other built *.html), one
// html file, or a URL. A local page is served from its workspace: `/workspace` inside a zen
// sandbox (with `/assets`), else the current folder (or --root) on a person's machine, its
// paths then being the machine's own. Screenshots go under the workspace's `.tmp/page-check/`.
//
// Main: resolveTarget, inSandbox, pythonPath, shown.
// Used by: @zenera/cli `zen page` (commands/page.ts, page/daemon.ts).
// ---------------------------------------------------------------------------

export const SANDBOX_WORKDIR = '/workspace';
const ASSETS = '/assets';

export interface Target {
    /** what was asked for, for messages */
    asked: string;
    /** the pages: agent paths of local html files, or one URL */
    pages: string[];
    /** null for a URL */
    trees: FileTrees | null;
    /** the page folder's name: screenshots' folder */
    name: string;
    /** where screenshots go */
    outDir: string;
}

const under = (at: string, base: string) => at === base || at.startsWith(base + sep);

/** Whether `cwd` is in a zen sandbox's workspace (each command there has its own /tmp). */
export const inSandbox = (cwd: string): boolean =>
    existsSync(SANDBOX_WORKDIR) && under(cwd, SANDBOX_WORKDIR);

/** The workspace a local page is served from. */
function rootOf(abs: string, cwd: string, root?: string): string {
    if (root) return resolve(cwd, root);
    if (existsSync(SANDBOX_WORKDIR) && (under(abs, SANDBOX_WORKDIR) || under(abs, ASSETS))) {
        return SANDBOX_WORKDIR;
    }
    if (under(abs, cwd)) return cwd;
    return statSync(abs).isDirectory() ? abs : dirname(abs);
}

function pagesIn(dir: string): string[] {
    const html = readdirSync(dir)
        .filter((f) => /\.html?$/i.test(f))
        .sort((a, b) => (a === 'index.html' ? -1 : b === 'index.html' ? 1 : a.localeCompare(b)));
    return html.map((f) => join(dir, f));
}

export function resolveTarget(asked: string, cwd: string, root?: string): Target {
    if (/^https?:\/\//i.test(asked)) {
        const base = inSandbox(cwd) ? SANDBOX_WORKDIR : cwd;
        const name = new URL(asked).pathname.split('/').filter(Boolean).slice(-2, -1)[0] ?? 'page';
        return {
            asked,
            pages: [asked],
            trees: null,
            name,
            outDir: join(base, '.tmp', 'page-check', name),
        };
    }
    const abs = resolve(cwd, asked);
    if (!existsSync(abs)) throw usageError(`no such file or folder: ${abs}`);
    const top = rootOf(abs, cwd, root);
    let pages: string[];
    let folder: string;
    if (statSync(abs).isDirectory()) {
        folder = abs;
        pages = pagesIn(abs);
        if (!pages.length) {
            throw usageError(
                `no built page in ${abs}`,
                'build it first: node /skills/html-page/scripts/build.ts <folder>',
            );
        }
    } else {
        if (!/^\.html?$/i.test(extname(abs))) throw usageError(`not an html page: ${abs}`);
        folder = dirname(abs);
        pages = [abs];
    }
    const sandboxed = top === SANDBOX_WORKDIR;
    if (!under(abs, top) && !(sandboxed && under(abs, ASSETS))) {
        throw usageError(`${abs} is outside ${top}`, 'name its workspace with --root');
    }
    const name = basename(folder) || 'page';
    return {
        asked,
        pages,
        trees: {
            workspace: top,
            workdir: top,
            ...(sandboxed && existsSync(ASSETS) ? { assets: ASSETS } : {}),
            // As a chat shows them: the agent's scratch folder is readable.
            dotted: [join(top, '.tmp')],
        },
        name,
        outDir: join(top, '.tmp', 'page-check', name),
    };
}

/** zen's runtime library for a page's functions, when this is not a sandbox that has it. */
export function pythonPath(): string[] {
    return existsSync(RUNTIME_PYTHON) ? [] : [join(RUNTIME_SOURCE, 'python')];
}

/** A path as worth printing: relative to the cwd when under it. */
export function shown(path: string, cwd: string): string {
    const rel = relative(cwd, path);
    return rel && !rel.startsWith('..') ? rel : path;
}
