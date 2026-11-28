#!/usr/bin/env node
// The html-page skill's build: a page folder's app.tsx in, one self-contained index.html out.
//
//   node /skills/html-page/scripts/build.ts /workspace/pages/<page>           build the page
//   node /skills/html-page/scripts/build.ts /workspace/pages/<page> --check   check, write nothing
//
// Every top-level .tsx with a default export is a page: app.tsx -> index.html, report.tsx ->
// report.html. The steps, each stopping the build with a list of what to fix:
//   1. types   TypeScript (strict, but without asking for annotations everywhere), React,
//              and the kit as `@page/kit`
//   2. rules   what a sandboxed page cannot do: storage, dialogs, other hosts, raw html, ...
//   3. bundle  esbuild: React, the kit and the page's modules in one script
//   4. render  App rendered once in Node, so a crash on first render is caught here
//   5. write   the html: shell.html with the css and js inlined, the page's `title`,
//              `description` and `previewAlt` exports in <title>, <meta name="description"> and
//              og:image:alt, and og:image naming the preview `zen page check` writes beside it
//              (the chat's card for the page shows them), stamped with a hash of the sources.
//              Nothing is written unless every step passed.
// --check runs 1, 2 and 4 and says whether each page's html is out of date with its sources.
//
// Runs where esbuild, typescript, react, react-dom and their types are installed: in the zen
// sandbox globally (NODE_PATH, which require() reads), in this repository from node_modules.
// Node runs this file as it is, stripping the types: only erasable TypeScript here.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    existsSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type * as Esbuild from 'esbuild';
import type * as Typescript from 'typescript';

const SKILL = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KIT = join(SKILL, 'kit');
const KIT_INDEX = join(KIT, 'index.ts');
const KIT_MOUNT = join(KIT, 'mount.tsx');
const SHELL = join(KIT, 'shell.html');

const CDNS = ['cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com'];
const ECHARTS = 'https://cdn.jsdelivr.net/npm/echarts@5.6.0/dist/echarts.min.js';
const TABULATOR = 'https://cdn.jsdelivr.net/npm/tabulator-tables@6.3.1/dist/js/tabulator.min.js';
const TABULATOR_CSS =
    'https://cdn.jsdelivr.net/npm/tabulator-tables@6.3.1/dist/css/tabulator_simple.min.css';

const STAMP = /<!-- Built by the html-page skill from (\S+) \(sources ([0-9a-f]+)\)/;
const MAX_PROBLEMS = 20;
const RENDER_TIMEOUT_MS = 20_000;

interface Problem {
    /** relative to the page folder, or absolute outside it; '' when about no file */
    file: string;
    line: number;
    col: number;
    message: string;
}

interface Entry {
    /** the .tsx, absolute */
    source: string;
    /** the html it builds, absolute */
    html: string;
    title: string;
    /** `export const description`, or '' when the page has none */
    description: string;
    /** `export const previewAlt`, or '' when the page has none */
    previewAlt: string;
}

interface Tools {
    ts: typeof Typescript;
    esbuild: typeof Esbuild;
    /** where react and react-dom are, for esbuild */
    nodePaths: string[];
    /** the node_modules holding react, and the @types folder holding its types */
    modules: string;
    types: string;
}

class Failed extends Error {
    readonly problems: Problem[];
    constructor(problems: Problem[]) {
        super('build failed');
        this.problems = problems;
    }
}

function loadTools(): Tools | null {
    const req = createRequire(import.meta.url);
    try {
        const pkg = (name: string) => dirname(req.resolve(`${name}/package.json`));
        const react = pkg('react');
        const reactDom = pkg('react-dom');
        const types = dirname(pkg('@types/react'));
        pkg('@types/react-dom');
        return {
            ts: req('typescript') as typeof Typescript,
            esbuild: req('esbuild') as typeof Esbuild,
            nodePaths: [...new Set([dirname(react), dirname(reactDom)])],
            modules: dirname(react),
            types,
        };
    } catch {
        return null;
    }
}

const rel = (dir: string, file: string) => {
    const r = relative(dir, file);
    return r.startsWith('..') || isAbsolute(r) ? file : r.split(sep).join('/');
};

/** The page's own source files: everything but dot-folders and node_modules. */
function sourcesOf(dir: string): string[] {
    const out: string[] = [];
    const walk = (d: string) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
            if (e.name.startsWith('.') || e.name === 'node_modules') continue;
            const p = join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (/\.(tsx?|css)$/.test(e.name)) out.push(p);
        }
    };
    walk(dir);
    return out.sort();
}

function sourcesHash(dir: string, sources: string[]): string {
    const hash = createHash('sha256');
    for (const file of sources) {
        hash.update(rel(dir, file)).update('\0').update(readFileSync(file)).update('\0');
    }
    return hash.digest('hex').slice(0, 16);
}

function titleOf(text: string, fallback: string): string {
    const m = /export\s+const\s+title(?:\s*:\s*string)?\s*=\s*(['"`])([^'"`\n]+)\1/.exec(text);
    if (m) return m[2]!;
    const words = fallback.replace(/[-_]+/g, ' ').trim();
    return words ? words[0]!.toUpperCase() + words.slice(1) : 'Page';
}

/** `export const <name> = '...'`: a one-line string the page declares for its html head. */
function stringExport(text: string, name: string): string {
    const m = new RegExp(
        `export\\s+const\\s+${name}(?:\\s*:\\s*string)?\\s*=\\s*(['"\`])((?:(?!\\1)[^\\n\\\\])+)\\1`,
    ).exec(text);
    return m ? m[2]!.trim() : '';
}

/**
 * The picture of a page the chat's card shows (og:image): `zen page check` writes it beside the
 * page - preview.png for index.html, report.preview.png for report.html.
 */
function previewName(html: string): string {
    const base = basename(html).replace(/\.html?$/i, '');
    return base === 'index' ? 'preview.png' : `${base}.preview.png`;
}

function entriesOf(dir: string): { entries: Entry[]; problems: Problem[] } {
    const problems: Problem[] = [];
    const entries: Entry[] = [];
    const tsx = readdirSync(dir)
        .filter((f) => f.endsWith('.tsx') && statSync(join(dir, f)).isFile())
        .sort();
    for (const name of tsx) {
        const source = join(dir, name);
        const text = readFileSync(source, 'utf8');
        if (!/\bexport\s+default\b/.test(text)) {
            problems.push({
                file: name,
                line: 1,
                col: 1,
                message:
                    'a .tsx beside the page is a page of its own and needs `export default function App()`; ' +
                    'move a component it uses into a subfolder (components/...) and import it from there',
            });
            continue;
        }
        const base = basename(name, '.tsx');
        const htmlName = base === 'app' || base === 'index' ? 'index.html' : `${base}.html`;
        const clash = entries.find((e) => basename(e.html) === htmlName);
        if (clash) {
            problems.push({
                file: name,
                line: 1,
                col: 1,
                message: `${basename(clash.source)} already builds ${htmlName}: keep one of them`,
            });
            continue;
        }
        const fallback = htmlName === 'index.html' ? basename(dir) : base;
        entries.push({
            source,
            html: join(dir, htmlName),
            title: titleOf(text, fallback),
            description: stringExport(text, 'description'),
            previewAlt: stringExport(text, 'previewAlt'),
        });
    }
    if (!entries.length && !problems.length) {
        problems.push({
            file: '',
            line: 0,
            col: 0,
            message:
                'no page here: write app.tsx with `export default function App()`, ' +
                'or copy a template from /skills/html-page/assets',
        });
    }
    return { entries, problems };
}

// ---------------------------------------------------------------------------------------------
// 1. Types

function typecheck(tools: Tools, dir: string, entries: Entry[]): Problem[] {
    const { ts } = tools;
    const options: Typescript.CompilerOptions = {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        jsx: ts.JsxEmit.ReactJSX,
        strict: true,
        // Wrong fields and wrong calls are what matter; annotations everywhere are noise.
        noImplicitAny: false,
        noEmit: true,
        skipLibCheck: true,
        allowImportingTsExtensions: true,
        isolatedModules: true,
        esModuleInterop: true,
        resolveJsonModule: true,
        lib: ['lib.es2023.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
        types: [],
        paths: {
            '@page/kit': [KIT_INDEX],
            // Types first: react itself is untyped JavaScript, which would quietly make it `any`.
            '*': [`${tools.types}/*`, `${tools.modules}/*`],
        },
    };
    const program = ts.createProgram(
        [...entries.map((e) => e.source), join(KIT, 'modules.d.ts')],
        options,
    );
    return ts.getPreEmitDiagnostics(program).map((d) => {
        const message = ts.flattenDiagnosticMessageText(d.messageText, ' ');
        if (!d.file || d.start === undefined) return { file: '', line: 0, col: 0, message };
        const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
        return { file: rel(dir, d.file.fileName), line: line + 1, col: character + 1, message };
    });
}

// ---------------------------------------------------------------------------------------------
// 2. Rules

const STORAGE = new Set(['localStorage', 'sessionStorage', 'indexedDB']);
const DIALOGS = new Set(['alert', 'confirm', 'prompt']);
const MOUNTING = new Set(['createRoot', 'hydrateRoot', 'render']);

function hostOf(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return '';
    }
}

// ---- Layout: the chat's side panel is 360 - 600 px wide, and a page must work there ----

/** What the narrowest panel leaves for a page's content, in px. */
const NARROW = 360;
/** Fixed columns adding up to more than this leave too little for the rest at NARROW. */
const FIXED_COLUMNS = 140;

/** A length in px, for px, rem and em; null for anything relative (%, fr, vw, auto, calc). */
function pxOf(value: string): number | null {
    const m = /^\s*(\d+(?:\.\d+)?)(px|rem|em)\s*$/.exec(value);
    if (!m) return null;
    return Number(m[1]) * (m[2] === 'px' ? 1 : 16);
}

/** Where a declaration is: inside which at-rules, under which selector. */
interface CssWhere {
    /** inside @media / @container */
    query: boolean;
    /** inside a query that only applies from some width up: fixed widths are fine there */
    wideOnly: boolean;
    selector: string;
}

/** What is wrong with one declaration for a narrow panel, or null. */
function layoutProblem(prop: string, value: string, where: CssWhere): string | null {
    const v = value.replace(/!important/i, '').trim();
    if (prop === 'display' && /^none$/i.test(v) && where.query) {
        return (
            'display: none in a media or container query hides this at some widths: everything ' +
            'shown on a wide page must be reachable on a narrow one - stack it, or put it in ' +
            "Split's detail (narrow: the list or the detail, with a Back button)"
        );
    }
    if (where.wideOnly) return null;
    if (['width', 'min-width', 'flex-basis'].includes(prop)) {
        const px = pxOf(v);
        if (px !== null && px > NARROW) {
            return (
                `${prop}: ${v} is wider than the chat's side panel (${NARROW} px): use max-width, ` +
                'a percentage, or flex/grid that wraps'
            );
        }
    }
    if (prop === 'grid-template-columns') {
        const floor = /minmax\(\s*(\d+(?:\.\d+)?(?:px|rem|em))\s*,/.exec(v);
        const floorPx = floor ? pxOf(floor[1]!) : null;
        if (floorPx !== null && floorPx > NARROW / 2 && /repeat\(\s*auto-(fit|fill)/.test(v)) {
            return (
                `minmax(${floor![1]}, …) overflows a narrow panel: write ` +
                `minmax(min(100%, ${floor![1]}), 1fr), or use the kit's Grid`
            );
        }
        // Fixed tracks outside min()/max()/minmax()/clamp(), repeat(n, …) counted n times.
        let tracks = v;
        for (;;) {
            const next = tracks.replace(
                /repeat\(\s*(\d+)\s*,\s*([^()]*)\)/g,
                (_, n: string, inner: string) => ` ${inner} `.repeat(Number(n)),
            );
            const stripped = next.replace(/[a-z-]+\([^()]*\)/gi, ' ');
            if (stripped === tracks) break;
            tracks = stripped;
        }
        const fixed = tracks
            .split(/\s+/)
            .map((t) => pxOf(t) ?? 0)
            .reduce((a, b) => a + b, 0);
        if (fixed > FIXED_COLUMNS) {
            return (
                `fixed columns of ${fixed} px leave little of a ${NARROW} px panel for the rest: ` +
                'use minmax(0, 1fr) columns and stack the row when narrow, or give the fixed ' +
                'columns only inside an @container (min-width: …) query'
            );
        }
    }
    if (/(^|,|\s)(html|body|:root|#root)\b/.test(where.selector)) {
        if ((prop === 'height' || prop === 'max-height') && /vh\b/.test(v)) {
            return `${prop}: ${v} on the page itself locks it to the window: let the page scroll`;
        }
        if (/^overflow(-y)?$/.test(prop) && /hidden/.test(v)) {
            return `${prop}: ${v} on the page itself cuts it off: let the page scroll`;
        }
    }
    return null;
}

/** Layout problems of a stylesheet, at their lines. */
function cssProblems(dir: string, file: string): Problem[] {
    const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (c) =>
        c.replace(/[^\n]/g, ' '),
    );
    const problems: Problem[] = [];
    const stack: string[] = [];
    let start = 0;
    const lineAt = (i: number) => text.slice(0, i).split('\n').length;
    const declaration = (end: number) => {
        const raw = text.slice(start, end);
        const m = /^(\s*)([-\w]+)\s*:([\s\S]*)$/.exec(raw);
        if (!m || !stack.length) return;
        const at = start + m[1]!.length;
        const queries = stack.filter((h) => /^@(media|container)\b/i.test(h));
        const where: CssWhere = {
            query: queries.length > 0,
            wideOnly: queries.some((q) => /min-width|width\s*>=?/i.test(q)),
            selector: [...stack].reverse().find((h) => !h.startsWith('@')) ?? '',
        };
        const message = layoutProblem(m[2]!.toLowerCase(), m[3]!.trim(), where);
        if (message) {
            const col = at - text.lastIndexOf('\n', at - 1);
            problems.push({ file: rel(dir, file), line: lineAt(at), col, message });
        }
    };
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '{') {
            stack.push(text.slice(start, i).trim());
            start = i + 1;
        } else if (c === ';') {
            declaration(i);
            start = i + 1;
        } else if (c === '}') {
            declaration(i);
            stack.pop();
            start = i + 1;
        }
    }
    return problems;
}

const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

function rules(tools: Tools, dir: string, sources: string[]): Problem[] {
    const { ts } = tools;
    const problems: Problem[] = [];
    const checkedFiles = new Set<string>();

    const checkFile = (wanted: string, at: () => Problem, api = false) => {
        if (/^(https?:|data:|blob:|#)/.test(wanted) || wanted.includes('${')) return;
        const path = resolve(
            dir,
            api ? `${wanted.replace(/\/+$/, '')}.api.py` : wanted.split(/[?#]/)[0]!,
        );
        if (!existsSync(path)) {
            const p = at();
            p.message = api
                ? `api('${wanted}'): there is no ${rel(dir, path)} beside the page`
                : `'${wanted}': there is no such file beside the page (paths are relative to the page's html)`;
            problems.push(p);
        } else if (!api && path.endsWith('.json') && !checkedFiles.has(path)) {
            checkedFiles.add(path);
            try {
                JSON.parse(readFileSync(path, 'utf8'));
            } catch (err) {
                const p = at();
                p.message = `'${wanted}' is not valid JSON: ${(err as Error).message}`;
                problems.push(p);
            }
        }
    };

    for (const file of sources) {
        if (file.endsWith('.css')) {
            problems.push(...cssProblems(dir, file));
            continue;
        }
        if (!/\.tsx?$/.test(file) || file.endsWith('.d.ts')) continue;
        const text = readFileSync(file, 'utf8');
        const sf = ts.createSourceFile(
            file,
            text,
            ts.ScriptTarget.Latest,
            true,
            file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
        );
        const at = (node: Typescript.Node) => (): Problem => {
            const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
            return { file: rel(dir, file), line: line + 1, col: character + 1, message: '' };
        };
        const report = (node: Typescript.Node, message: string) =>
            problems.push({ ...at(node)(), message });

        const visit = (node: Typescript.Node): void => {
            if (ts.isIdentifier(node) && STORAGE.has(node.text)) {
                report(
                    node,
                    `${node.text} is not available to pages: keep view state in hooks or useHashState, ` +
                        'and what must last in the database through an api function',
                );
            } else if (ts.isCallExpression(node)) {
                const callee = node.expression;
                const name = ts.isIdentifier(callee)
                    ? callee.text
                    : ts.isPropertyAccessExpression(callee)
                      ? callee.name.text
                      : '';
                const target =
                    ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
                        ? callee.expression.text
                        : '';
                const arg = node.arguments[0];
                const literal =
                    arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))
                        ? arg.text
                        : undefined;
                if (
                    DIALOGS.has(name) &&
                    (ts.isIdentifier(callee) || target === 'window' || target === 'globalThis')
                ) {
                    report(
                        node,
                        `${name}() is blocked in pages: use ConfirmButton for a second-click confirm, ` +
                            'or show the message on the page',
                    );
                } else if (name === 'createRoot' || name === 'hydrateRoot') {
                    report(
                        node,
                        'the build mounts the page itself: export App as default and do not call createRoot',
                    );
                } else if (name === 'insertAdjacentHTML') {
                    report(
                        node,
                        'no raw html: use JSX (it escapes), or SafeHtml for html from outside',
                    );
                } else if (
                    literal !== undefined &&
                    (name === 'fetch' || name === 'useData' || name === 'fetchJson')
                ) {
                    if (/^https?:\/\//.test(literal)) {
                        report(
                            node,
                            `${name}('${literal}'): a page reaches only its own folder; fetch other sites ` +
                                'from a Python function in api/ and call it with api()',
                        );
                    } else {
                        checkFile(literal, at(arg!));
                    }
                } else if (literal !== undefined && name === 'api' && ts.isIdentifier(callee)) {
                    checkFile(literal, at(arg!), true);
                }
            } else if (
                ts.isPropertyAccessExpression(node) &&
                node.name.text === 'cookie' &&
                ts.isIdentifier(node.expression) &&
                node.expression.text === 'document'
            ) {
                report(node, 'cookies are not available to pages');
            } else if (
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                ts.isPropertyAccessExpression(node.left) &&
                (node.left.name.text === 'innerHTML' || node.left.name.text === 'outerHTML')
            ) {
                report(
                    node,
                    'no raw html: use JSX (it escapes), or SafeHtml for html from outside',
                );
            } else if (
                ts.isJsxAttribute(node) &&
                node.name.getText(sf) === 'style' &&
                node.initializer &&
                ts.isJsxExpression(node.initializer) &&
                node.initializer.expression &&
                ts.isObjectLiteralExpression(node.initializer.expression)
            ) {
                // style={{ width: 600, gridTemplateColumns: '200px 1fr' }}: the same rules as css.
                for (const prop of node.initializer.expression.properties) {
                    if (!ts.isPropertyAssignment(prop)) continue;
                    const name =
                        ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)
                            ? prop.name.text
                            : '';
                    const init = prop.initializer;
                    const value = ts.isNumericLiteral(init)
                        ? `${init.text}px`
                        : ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)
                          ? init.text
                          : null;
                    if (!name || value === null) continue;
                    const message = layoutProblem(kebab(name), value, {
                        query: false,
                        wideOnly: false,
                        selector: '',
                    });
                    if (message) report(prop, message);
                }
            } else if (
                ts.isJsxAttribute(node) &&
                node.name.getText(sf) === 'dangerouslySetInnerHTML'
            ) {
                report(
                    node,
                    'no raw html: use JSX (it escapes), or SafeHtml for html from outside',
                );
            } else if (
                ts.isImportDeclaration(node) &&
                ts.isStringLiteral(node.moduleSpecifier) &&
                /^react-dom(\/client)?$/.test(node.moduleSpecifier.text)
            ) {
                const named = node.importClause?.namedBindings;
                if (named && ts.isNamedImports(named)) {
                    for (const el of named.elements) {
                        if (MOUNTING.has((el.propertyName ?? el.name).text)) {
                            report(
                                el,
                                'the build mounts the page itself: export App as default and do not import ' +
                                    `${(el.propertyName ?? el.name).text} from ${node.moduleSpecifier.text}`,
                            );
                        }
                    }
                }
            } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
                stringRules(node, node.text);
            } else if (ts.isTemplateExpression(node)) {
                stringRules(node, node.head.text);
            }
            ts.forEachChild(node, visit);
        };

        const stringRules = (node: Typescript.Node, value: string) => {
            if (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)) {
                if (/^https?:\/\//.test(value)) {
                    report(
                        node,
                        'import packages the build knows (react, @page/kit) or files of the page, not urls',
                    );
                }
                return;
            }
            if (/file:\/\//i.test(value)) {
                report(node, 'a page loads its files by a path relative to it, never file://');
            } else if (/^\/(workspace|assets|skills)(\/|$)/.test(value)) {
                report(
                    node,
                    `'${value}': the page cannot see the sandbox's folders; use a path relative to the page`,
                );
            } else if (/\b(localhost|127\.0\.0\.1)\b/.test(value)) {
                report(
                    node,
                    'the page cannot reach localhost; call a Python function in api/ instead',
                );
            } else if (/^https?:\/\//.test(value)) {
                const attr =
                    node.parent && ts.isJsxAttribute(node.parent) ? node.parent : undefined;
                const attrName = attr?.name.getText(sf);
                if (attr && attrName === 'href') {
                    const element = attr.parent.parent;
                    const tag =
                        ts.isJsxOpeningElement(element) || ts.isJsxSelfClosingElement(element)
                            ? element.tagName.getText(sf)
                            : '';
                    const blank = attr.parent.properties.some(
                        (p) =>
                            ts.isJsxAttribute(p) &&
                            p.name.getText(sf) === 'target' &&
                            p.initializer !== undefined &&
                            ts.isStringLiteral(p.initializer) &&
                            p.initializer.text === '_blank',
                    );
                    if (tag === 'a' && !blank) {
                        report(node, 'a link to another site needs target="_blank" rel="noopener"');
                    }
                } else if (attr && attrName === 'src' && !CDNS.includes(hostOf(value))) {
                    report(
                        node,
                        `${hostOf(value)} is blocked: a page loads only its own files and from ${CDNS.join(', ')}`,
                    );
                }
            }
        };

        visit(sf);
    }
    const data = join(dir, 'data.json');
    if (existsSync(data) && !checkedFiles.has(data)) {
        try {
            JSON.parse(readFileSync(data, 'utf8'));
        } catch (err) {
            problems.push({
                file: 'data.json',
                line: 0,
                col: 0,
                message: `not valid JSON: ${(err as Error).message}`,
            });
        }
    }
    return problems;
}

// ---------------------------------------------------------------------------------------------
// 3. Bundle

const kitPlugin: Esbuild.Plugin = {
    name: 'page-kit',
    setup(build) {
        build.onResolve({ filter: /^@page\/kit$/ }, () => ({ path: KIT_INDEX }));
    },
};

const ASSET_LOADERS: Record<string, Esbuild.Loader> = {
    '.png': 'dataurl',
    '.jpg': 'dataurl',
    '.jpeg': 'dataurl',
    '.gif': 'dataurl',
    '.webp': 'dataurl',
    '.svg': 'dataurl',
    '.woff2': 'dataurl',
    '.txt': 'text',
    '.md': 'text',
};

function esbuildProblems(dir: string, err: unknown): Problem[] {
    const errors = (err as { errors?: Esbuild.Message[] }).errors;
    if (!errors?.length) return [{ file: '', line: 0, col: 0, message: String(err) }];
    return errors.map((m) => ({
        file: m.location ? rel(dir, resolve(dir, m.location.file)) : '',
        line: m.location?.line ?? 0,
        col: (m.location?.column ?? 0) + 1,
        message: m.text,
    }));
}

interface Bundle {
    js: string;
    css: string;
    echarts: boolean;
    tabulator: boolean;
}

async function bundle(tools: Tools, dir: string, entry: Entry): Promise<Bundle> {
    const source = `./${basename(entry.source)}`;
    let result: Esbuild.BuildResult<{ write: false }>;
    try {
        result = await tools.esbuild.build({
            stdin: {
                contents: `import { mount } from ${JSON.stringify(KIT_MOUNT)};\nimport App from ${JSON.stringify(source)};\nmount(App);\n`,
                resolveDir: dir,
                sourcefile: 'page-entry.tsx',
                loader: 'tsx',
            },
            absWorkingDir: dir,
            bundle: true,
            write: false,
            outdir: join(dir, '.build'),
            format: 'esm',
            platform: 'browser',
            target: 'es2022',
            jsx: 'automatic',
            minify: true,
            legalComments: 'none',
            define: { 'process.env.NODE_ENV': '"production"' },
            nodePaths: tools.nodePaths,
            plugins: [kitPlugin],
            loader: ASSET_LOADERS,
            logLevel: 'silent',
        });
    } catch (err) {
        throw new Failed(esbuildProblems(dir, err));
    }
    const js = result.outputFiles.find((f) => f.path.endsWith('.js'))?.text ?? '';
    const css = result.outputFiles.find((f) => f.path.endsWith('.css'))?.text ?? '';
    // Globals keep their names through minifying: what is left of them is what the page uses.
    return {
        js,
        css,
        echarts: /\becharts\s*\.\s*init\b/.test(js),
        tabulator: /\bnew\s+Tabulator\b/.test(js),
    };
}

// ---------------------------------------------------------------------------------------------
// 4. Render

// What a page may touch while it first renders, standing in for the browser's. `require` is for
// react-dom's CommonJS, which loads Node's own modules.
const RENDER_GLOBALS = `
import { createRequire as __pageRequire } from 'node:module';
const require = __pageRequire(import.meta.url);
globalThis.window ??= globalThis;
globalThis.location ??= { hash: '', href: 'http://page.local/', pathname: '/', search: '', origin: 'null', assign() {}, replace() {}, reload() {} };
globalThis.history ??= { pushState() {}, replaceState() {}, back() {}, forward() {} };
globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.addEventListener ??= () => {};
globalThis.removeEventListener ??= () => {};
`;

async function renderCheck(tools: Tools, dir: string, entry: Entry): Promise<Problem[]> {
    // Real paths: the source map's paths are relative, and a symlinked tmp would skew them.
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'html-page-')));
    const outfile = join(tmp, 'render.mjs');
    const source = `./${basename(entry.source)}`;
    try {
        try {
            await tools.esbuild.build({
                stdin: {
                    contents: [
                        `import { renderToString } from 'react-dom/server';`,
                        `import { createElement } from 'react';`,
                        `try {`,
                        `    const { default: App } = await import(${JSON.stringify(source)});`,
                        `    renderToString(createElement(App));`,
                        `} catch (e) {`,
                        `    console.error('PAGE_RENDER_ERROR ' + JSON.stringify({ message: String(e?.message ?? e), stack: String(e?.stack ?? '') }));`,
                        `    process.exit(1);`,
                        `}`,
                    ].join('\n'),
                    resolveDir: dir,
                    sourcefile: 'page-render.tsx',
                    loader: 'tsx',
                },
                absWorkingDir: dir,
                bundle: true,
                write: true,
                outfile,
                format: 'esm',
                platform: 'node',
                target: 'node22',
                jsx: 'automatic',
                sourcemap: 'inline',
                define: { 'process.env.NODE_ENV': '"production"' },
                banner: { js: RENDER_GLOBALS },
                nodePaths: tools.nodePaths,
                plugins: [kitPlugin],
                loader: { ...ASSET_LOADERS, '.css': 'empty' },
                logLevel: 'silent',
            });
        } catch (err) {
            return esbuildProblems(dir, err);
        }
        const run = spawnSync(process.execPath, ['--enable-source-maps', outfile], {
            cwd: tmp,
            encoding: 'utf8',
            timeout: RENDER_TIMEOUT_MS,
        });
        if (run.error || run.signal) {
            return [
                {
                    file: rel(dir, entry.source),
                    line: 0,
                    col: 0,
                    message: `the first render did not finish in ${RENDER_TIMEOUT_MS / 1000} s: is there an endless loop?`,
                },
            ];
        }
        if (run.status === 0) return [];
        const marker = /PAGE_RENDER_ERROR (.*)/.exec(run.stderr);
        let message = run.stderr.trim().split('\n').slice(0, 3).join(' ');
        let stack = '';
        if (marker) {
            try {
                const parsed = JSON.parse(marker[1]!) as { message: string; stack: string };
                message = parsed.message;
                stack = parsed.stack;
            } catch {
                // keep the raw stderr
            }
        }
        // The first frame in the page's own files, not React's or the kit's.
        let where: Problem = { file: rel(dir, entry.source), line: 0, col: 0, message: '' };
        for (const m of stack.matchAll(/\(?((?:file:\/\/)?[^\s()]+):(\d+):(\d+)\)?/g)) {
            const path = m[1]!.startsWith('file://') ? fileURLToPath(m[1]!) : m[1]!;
            if (resolve(path).startsWith(dir + sep) && !path.includes(`${sep}node_modules${sep}`)) {
                where = {
                    file: rel(dir, resolve(path)),
                    line: Number(m[2]),
                    col: Number(m[3]),
                    message: '',
                };
                break;
            }
        }
        return [
            {
                ...where,
                message:
                    `the page crashed on its first render: ${message}` +
                    (/\b(document|navigator|ResizeObserver|IntersectionObserver)\b/.test(message)
                        ? ' (this check renders without a browser: touch the DOM in useEffect or in handlers, not while rendering)'
                        : ''),
            },
        ];
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
}

// ---------------------------------------------------------------------------------------------
// 5. Write

const escapeHtml = (s: string) =>
    s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function pageHtml(dir: string, entry: Entry, built: Bundle, hash: string): string {
    const head: string[] = [];
    if (built.tabulator) head.push(`<link rel="stylesheet" href="${TABULATOR_CSS}" />`);
    if (built.echarts) head.push(`<script src="${ECHARTS}"></script>`);
    if (built.tabulator) head.push(`<script src="${TABULATOR}"></script>`);
    const source = rel(dir, entry.source);
    const stamp =
        `<!-- Built by the html-page skill from ${source} (sources ${hash}). ` +
        `Do not edit this file: edit ${source} and run the build again. -->`;
    // Inlined, a script or style ends at the first `</script` or `</style` anywhere in it, and
    // `<!--` changes how the browser looks for that end.
    const js = built.js.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
    const css = built.css.replace(/<\/(style)/gi, '<\\/$1');
    const parts: Record<string, string> = {
        STAMP: stamp,
        TITLE: escapeHtml(entry.title),
        DESCRIPTION: escapeHtml(entry.description),
        PREVIEW: escapeHtml(previewName(entry.html)),
        PREVIEW_ALT: escapeHtml(entry.previewAlt || `Preview of ${entry.title}`),
        HEAD: head.join('\n        '),
        CSS: css,
        JS: js,
    };
    return readFileSync(SHELL, 'utf8').replace(
        /<!--(STAMP|TITLE|DESCRIPTION|PREVIEW_ALT|PREVIEW|HEAD|CSS|JS)-->/g,
        (_, key: string) => parts[key]!,
    );
}

/** The stamp of a built html: its source and the hash of the sources it was built from. */
function stampOf(file: string): { source: string; hash: string } | null {
    if (!existsSync(file)) return null;
    const head = readFileSync(file, 'utf8').slice(0, 2000);
    const m = STAMP.exec(head);
    return m ? { source: m[1]!, hash: m[2]! } : null;
}

// ---------------------------------------------------------------------------------------------

function print(dir: string, problems: Problem[]) {
    const shown = problems.slice(0, MAX_PROBLEMS);
    console.error(`✗ ${problems.length} problem${problems.length === 1 ? '' : 's'} in ${dir}:`);
    for (const p of shown) {
        const where = p.file ? (p.line ? `${p.file}:${p.line}:${p.col}` : p.file) : '';
        console.error(where ? `  ${where}  ${p.message}` : `  ${p.message}`);
    }
    if (problems.length > shown.length) {
        console.error(`  … and ${problems.length - shown.length} more`);
    }
    console.error('Nothing was written. Fix these and run the build again.');
}

async function main(argv: string[]): Promise<number> {
    const check = argv.includes('--check');
    const args = argv.filter((a) => !a.startsWith('--'));
    const given = resolve(args[0] ?? '.');
    if (!existsSync(given) || !statSync(given).isDirectory()) {
        console.error(`✗ ${given} is not a folder. Usage: node build.ts <page folder> [--check]`);
        return 2;
    }
    const dir = realpathSync(given);
    const tools = loadTools();
    if (!tools) {
        console.error(
            '✗ The page build needs esbuild, typescript, react and react-dom, which the zen sandbox ' +
                'image has. Run it with the sandbox enabled (sandbox: in agents.yaml).',
        );
        return 2;
    }
    try {
        const { entries, problems } = entriesOf(dir);
        const sources = sourcesOf(dir);
        const found = [
            ...problems,
            ...(entries.length ? typecheck(tools, dir, entries) : []),
            ...rules(tools, dir, sources),
        ];
        if (found.length) throw new Failed(found);

        const hash = sourcesHash(dir, sources);
        const pages: { entry: Entry; html?: string }[] = [];
        for (const entry of entries) {
            const target = stampOf(entry.html);
            if (!check && existsSync(entry.html) && !target) {
                throw new Failed([
                    {
                        file: rel(dir, entry.html),
                        line: 0,
                        col: 0,
                        message:
                            `is not a page this build wrote (it has no html-page stamp), so it is not ` +
                            `overwritten: move or delete it, then build again to write it from ${basename(entry.source)}`,
                    },
                ]);
            }
            const rendered = await renderCheck(tools, dir, entry);
            if (rendered.length) throw new Failed(rendered);
            if (!check) {
                pages.push({
                    entry,
                    html: pageHtml(dir, entry, await bundle(tools, dir, entry), hash),
                });
            } else {
                pages.push({ entry });
            }
        }

        if (check) {
            const stale: Problem[] = [];
            for (const { entry } of pages) {
                const stamp = stampOf(entry.html);
                const html = rel(dir, entry.html);
                if (!stamp) {
                    stale.push({
                        file: html,
                        line: 0,
                        col: 0,
                        message: `not built yet: run the build`,
                    });
                } else if (stamp.hash !== hash) {
                    stale.push({
                        file: html,
                        line: 0,
                        col: 0,
                        message: `out of date with ${basename(entry.source)} and the files it uses: run the build`,
                    });
                }
            }
            if (stale.length) throw new Failed(stale);
            console.log(`✓ ${dir}: checked, and every page is up to date`);
            return 0;
        }

        for (const { entry, html } of pages) {
            writeFileSync(entry.html, html!);
            const kb = Math.round(Buffer.byteLength(html!) / 1024);
            console.log(
                `✓ wrote ${rel(dir, entry.html)} (${kb} KB) from ${rel(dir, entry.source)}`,
            );
            if (!entry.description) {
                console.log(
                    `  ${rel(dir, entry.source)} has no description: add export const description = '...' ` +
                        `(one sentence on what the page shows or lets the user do; the chat shows it on the page's card) and build again`,
                );
            }
            if (!entry.previewAlt) {
                console.log(
                    `  ${rel(dir, entry.source)} has no previewAlt: add export const previewAlt = '...' ` +
                        `(what its first screen shows, e.g. 'Bar chart of pipeline by stage, table of regions'; ` +
                        `the alt text of the card's picture) and build again`,
                );
            }
        }
        const link = pages.find((p) => basename(p.entry.html) === 'index.html') ?? pages[0]!;
        console.log(
            `Now check it in a browser: zen page check ${given} - it also writes ` +
                `${pages.map((p) => previewName(p.entry.html)).join(', ')}, the picture on the chat's card`,
        );
        console.log(
            `Link it as [${link.entry.title}](${pathToFileURL(join(given, basename(link.entry.html))).href})`,
        );
        return 0;
    } catch (err) {
        if (err instanceof Failed) {
            print(dir, err.problems);
            return 1;
        }
        throw err;
    }
}

process.exitCode = await main(process.argv.slice(2));
