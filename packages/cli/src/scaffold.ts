// packages/cli/src/scaffold.ts
//
// Creating a project from `templates/`: `agents.yaml`, prompts, specification, house rules and the editor brief.
// Main: `scaffold(opts)`; also `TEMPLATES`, `copyTree`, `SHARED_RULES`, `refreshShared`/`staleShared`, `ownVersion`.
// Used by: `commands/init.ts`, `commands/check.ts` (`--fix`), `commands/export.ts`, `commands/completion.ts`,
// `validate.ts`, `editor.ts`, and through `lib.ts` by `@zenera/meta`.

import {
    chmodSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    writeFileSync,
} from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { editorFiles } from './editor.ts';
import { splitRef } from './modelref.ts';

// ---------------------------------------------------------------------------
// Scaffolding
//
// What `zen init` writes and `zen open` refreshes — none of which is in this
// file. `templates/` holds the real thing, laid out the way it lands, so
// changing what a project starts life as is editing a file rather than a string
// literal escaping every backtick and `${...}` it contains:
//
//   templates/project/   the project's own files. Written once and edited from
//                        then on, so anything already there is left alone.
//   templates/editor/    ours: the `.vscode/` and `.github/` trees,
//                        which describe this version of `zen` to the editor and
//                        are replaced every time.
//   templates/parts/     fragments spliced into a template above.
//
// The trees are copied whole and nothing enumerates them, so adding a file to
// a new project is adding a file to `templates/project/` and nothing else.
//
// What is there is deliberately close to empty: a template full of
// commented-out options is a template nobody reads and everybody deletes. The
// one agent works as written, and every other knob is in `docs/`.
//
// `SPECIFICATION.md` is the exception, and is written out in full. It states
// what the project that was just scaffolded is for and what it may do, and it
// is *true as written* — so the first thing anyone sees is a specification
// standing next to the files that implement it, which is the shape every
// change to the project is then made in.
// ---------------------------------------------------------------------------

export const TEMPLATES = fileURLToPath(new URL('../templates', import.meta.url));

/** The suffix on a file with `{{...}}` in it, dropped when the file lands. */
const TEMPLATE = '.tmpl';

/** How to use file tools: a house rules file, landing under `agents/`. */
const FILE_RULES = join('agents', 'files-instructions.md');

/** How to use the memory graph: a house rules file, landing under `agents/`. */
const MEMORY_RULES = join('agents', 'memory-instructions.md');

/** How tools are called: the same, and equally not the project's to maintain. */
const TOOL_RULES = join('agents', 'tools-instructions.md');

/** How forking behaves: the same again, reaching only agents that declare `fork:`. */
const FORK_RULES = join('agents', 'fork-instructions.md');

/**
 * The project files that are ours rather than the project's.
 *
 * Everything else under `templates/project/` describes *this project* and is
 * written once. These describe *this version of `zen`* — how the memory graph
 * works, how its tools are called, what survives a join — and land under
 * `agents/` only because that is where house rules have to be to reach a
 * prompt. A copy that has fallen behind the runtime is worse than none, so
 * `zen check --fix` replaces them, and nothing in them is worth editing in
 * place: project policy on any of those subjects goes in a topic file of its
 * own beside them.
 */
export const SHARED_RULES: readonly string[] = [FILE_RULES, FORK_RULES, MEMORY_RULES, TOOL_RULES];

/**
 * This `zen`'s own version, which the scaffold pins the sandbox's tools to.
 * The publishable packages move in lockstep, so one number covers them all.
 *
 * Exported so the check that reports a drifted pin reads the same number the
 * scaffold wrote, rather than a second definition of "this version".
 */
export function ownVersion(): string {
    const manifest = fileURLToPath(new URL('../package.json', import.meta.url));
    return (JSON.parse(readFileSync(manifest, 'utf8')) as { version: string }).version;
}

type Vars = Record<string, string>;

/**
 * Fills the `{{name}}` in a template, in the two shapes templates use.
 *
 * A placeholder alone on a line takes a whole fragment: its own indentation is
 * applied to every line of the value, and an empty value takes the line with
 * it — which is how an optional block leaves nothing behind. Anywhere else it
 * takes a word. A name nothing supplies throws, so a typo in a template is a
 * failing test rather than a `{{provider}}` sitting in somebody's agents.yaml.
 *
 * Only the value is trimmed at the end, never the start, so a fragment that has
 * to be a paragraph of its own carries its own blank line as its first line.
 * That way the template needs no blank line around the placeholder, and dropping
 * the fragment leaves the surrounding paragraphs exactly as they were.
 */
function render(text: string, vars: Vars): string {
    const value = (name: string): string => {
        const found = vars[name];
        if (found === undefined) {
            throw new Error(`template asks for {{${name}}}, which nothing supplies`);
        }
        return found;
    };
    return text
        .replace(/^([ \t]*)\{\{(\w+)\}\}[ \t]*\r?\n/gm, (_, indent: string, name: string) => {
            const body = value(name).trimEnd();
            if (!body) {
                return '';
            }
            const lines = body.split('\n').map((line) => (line ? indent + line : ''));
            return `${lines.join('\n')}\n`;
        })
        .replace(/\{\{(\w+)\}\}/g, (_, name: string) => value(name));
}

/** Reads one fragment from `templates/parts/`, without its trailing newline. */
function part(name: string, vars: Vars = {}): string {
    const text = readFileSync(join(TEMPLATES, 'parts', `${name}${TEMPLATE}`), 'utf8');
    return render(text, vars).trimEnd();
}

/**
 * The `model:` section, which is one line until it has to say more.
 *
 * A shorthand cannot carry options, and the object form cannot carry a
 * shorthand — its `model:` is the bare id the API is sent — so asking for
 * reasoning means splitting the ref back into the two fields and giving the
 * configuration a name to be referred to by.
 */
function modelSection(ref: string, options?: string): string {
    const { provider, id } = splitRef(ref);
    if (!options || !provider) {
        return part('model.yaml', { ref });
    }
    return part('models.yaml', { provider, id, options });
}

export interface CopyOptions {
    /** values for the `{{...}}` in any template under this tree */
    vars?: Vars;
    /** leave a file that is already there alone rather than replacing it */
    keep?: boolean;
}

/**
 * Template files that land under a name they cannot be stored under.
 *
 * `gitignore` cannot have its dot in the repository: npm strips a `.gitignore`
 * out of a published tarball, and git would read this one as rules about
 * `packages/cli/templates/` rather than as content. The `env` files cannot have
 * their dot for a plainer reason — this repository ignores `.env` and `.env.*`
 * everywhere, so the templates would never be committed at all. In the project
 * `.env` and `.env.test` are ignored, being credentials; `.env.example` holds
 * no values and is meant to be shared.
 */
const DOTFILES: Record<string, string> = {
    gitignore: '.gitignore',
    env: '.env',
    'env.example': '.env.example',
    'env.test': '.env.test',
};

/** The name a template file lands under. */
function target(name: string): string {
    if (name.endsWith(TEMPLATE)) {
        return name.slice(0, -TEMPLATE.length);
    }
    return DOTFILES[name] ?? name;
}

/** Writes `body` to `path` unless those are already its bytes; true if it wrote. */
function writeIfChanged(path: string, body: string | Buffer): boolean {
    const bytes = typeof body === 'string' ? Buffer.from(body) : body;
    if (existsSync(path) && readFileSync(path).equals(bytes)) {
        return false;
    }
    writeFileSync(path, bytes);
    return true;
}

/**
 * Copies one template directory into `dir` at `rel`, depth first, sorted so the
 * list it returns is the same on every machine. Only a `.tmpl` is read as text;
 * everything else is copied byte for byte. A file already holding those bytes
 * is left alone and not listed.
 */
export function copyTree(from: string, dir: string, rel: string, opts: CopyOptions): string[] {
    const written: string[] = [];
    mkdirSync(join(dir, rel), { recursive: true });
    const entries = readdirSync(from, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
        const source = join(from, entry.name);
        if (entry.isDirectory()) {
            written.push(...copyTree(source, dir, join(rel, entry.name), opts));
            continue;
        }
        const child = join(rel, target(entry.name));
        if (opts.keep && existsSync(join(dir, child))) {
            continue;
        }
        const body = entry.name.endsWith(TEMPLATE)
            ? render(readFileSync(source, 'utf8'), opts.vars ?? {})
            : readFileSync(source);
        const changed = writeIfChanged(join(dir, child), body);
        // The bytes are copied, not the file, so a script arrives unrunnable.
        if (child.endsWith('.sh') || child.endsWith('.mjs')) {
            chmodSync(join(dir, child), 0o755);
        }
        if (changed) {
            written.push(child);
        }
    }
    return written;
}

/**
 * Replaces every file in a project that nobody is meant to be maintaining:
 * `SHARED_RULES` in the project tree, and the editor tree whole. Returns the
 * relative paths that actually changed, project files first.
 *
 * This is the other half of `keep: true`. A scaffold never overwrites, which is
 * right for the files a project goes on to make its own and wrong for the ones
 * that only ever restate how this version of `zen` behaves — those a project
 * upgrades into, and before this there was no way to get them except by hand.
 */
export function refreshShared(dir: string): string[] {
    const written: string[] = [];
    for (const rel of SHARED_RULES) {
        const path = join(dir, rel);
        mkdirSync(dirname(path), { recursive: true });
        if (writeIfChanged(path, readFileSync(join(TEMPLATES, 'project', rel)))) {
            written.push(rel);
        }
    }
    written.push(...editorFiles(dir));
    return written;
}

/**
 * Which of a project's `SHARED_RULES` are not the bytes this `zen` ships.
 *
 * The comparison is the whole file rather than anything read out of it,
 * because there is no reading that would have caught the copies that went
 * stale in practice: prose describing a tool that was renamed, a section about
 * behaviour that changed, frontmatter added after the copy was written. All of
 * it parses, all of it loads, and all of it is wrong. A file that is not there
 * is not stale — what must exist is checked where it is required, not here.
 *
 * Paths come back with forward slashes, the way a report names a file.
 */
export function staleShared(dir: string): string[] {
    const stale: string[] = [];
    for (const rel of SHARED_RULES) {
        const path = join(dir, rel);
        if (!existsSync(path)) {
            continue;
        }
        const ours = readFileSync(join(TEMPLATES, 'project', rel), 'utf8');
        if (readFileSync(path, 'utf8') !== ours) {
            stale.push(rel.split(sep).join('/'));
        }
    }
    return stale;
}

export interface ScaffoldOptions {
    /** the project directory */
    dir: string;
    model: string;
    /** extra lines for the model's configuration; their presence picks the object form */
    modelOptions?: string;
    /** give the default agent `exa:*` — set when a key for it is on hand */
    web?: boolean;
    /**
     * What vectorises the memory graph, as a provider-prefixed ref. Left out
     * when the project's provider publishes no embeddings API — memory still
     * works, ranking recall by term overlap instead of by meaning.
     */
    embedding?: string;
}

export interface Scaffolded {
    /** the project's own files, in the order they were written */
    files: string[];
    /** `.vscode/` and `.github/` — written alongside, and nobody's to edit */
    editor: string[];
}

/**
 * Writes a project. Never overwrites the project's own files — a second `init`
 * over a directory fills in what is missing and leaves the rest alone — but the
 * editor files are ours, and are replaced.
 *
 * The two are returned apart because they are read differently: the project's
 * files are the thing that was just made, and worth listing; the editor's are
 * plumbing for a tool that may not even be installed, and listing them buries
 * the first set under twice as many lines about the second.
 */
export function scaffold(opts: ScaffoldOptions): Scaffolded {
    const files = copyTree(join(TEMPLATES, 'project'), opts.dir, '', {
        keep: true,
        vars: {
            model: modelSection(opts.model, opts.modelOptions),
            modelRef: opts.model,
            exa: opts.web ? part('exa.yaml') : '',
            // The same capability stated three times, because the grant, the
            // specification of it and the instruction to use it are read by
            // different readers — and a tool nothing says to use is not one.
            web: opts.web ? part('exa.spec.md') : '',
            webPrompt: opts.web ? part('exa.prompt.md') : '',
            memory: opts.embedding
                ? part('memory.yaml', { embedding: opts.embedding })
                : part('memory-terms.yaml'),
            version: ownVersion(),
        },
    });

    // The directories with no file to put in them: a skill is a folder someone
    // adds, sessions is written into on the first run, and `.tmp` is scratch —
    // there so an agent has somewhere inside the workspace to put a working
    // file, which is somewhere the sandbox can still reach after the container
    // it was written from is gone.
    mkdirSync(join(opts.dir, 'agents', 'skills'), { recursive: true });
    mkdirSync(join(opts.dir, 'sessions'), { recursive: true });
    mkdirSync(join(opts.dir, '.tmp'), { recursive: true });

    // Where `/spec-sync-project` records what it applied, so the next pass works
    // the difference rather than the whole specification again. Empty here, and
    // git does not carry an empty directory: what says a pass has completed is
    // `baseline/manifest.txt`, never the directory itself.
    mkdirSync(join(opts.dir, '.spec-sync', 'baseline'), { recursive: true });
    mkdirSync(join(opts.dir, '.spec-sync', 'history'), { recursive: true });

    // The project directory is what `zen open` opens, so this is where the
    // editor actually reads them.
    return { files, editor: editorFiles(opts.dir) };
}
