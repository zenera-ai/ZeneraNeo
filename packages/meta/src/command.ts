// packages/meta/src/command.ts
//
// `zen meta`: the meta agent's command - a coding agent (GitHub Copilot CLI) run over a zen project on your keys.
// Main: `command: Command`, which routes `run`, `chat`, `prompts`, `resume`, `model`, `dataset` and `finetune`; the
// run itself is `go()` (prepare the model and key, log, launch, resume after transient failures), and `chat()`
// checks the terminal and hands over to `chat/run.ts`.
// Also `completeMeta` (tab completion) and the `subsystems` hook reporting copilot and its SDK to `zen version`.
// Used by: `@zenera/cli`, which loads it by name as `@zenera/meta/command` (`EXTERNAL.meta` in its commands/index.ts).

import * as Projects from '@zenera/engine';
import { ensureHome, isProvider, KeyStore, loadProjectEnv, PROVIDERS } from '@zenera/engine';
import { gatewayOf } from '@zenera/neo';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ParseArgsConfig } from 'node:util';
import {
    appendUsage,
    bold,
    browseModels,
    choose,
    CliError,
    copilotEventLog,
    credentialError,
    cyan,
    dim,
    duration,
    editorFiles,
    EXIT,
    green,
    isInteractive,
    json,
    LEDGER_ENV,
    ledgerPath,
    matching,
    META_PROMPT_ENV,
    META_SESSION_ENV,
    note,
    pad,
    parse,
    probeChat,
    probeModel,
    progress,
    projectNames,
    readStdin,
    resolveProject,
    splitRef,
    table,
    TEMPLATES,
    usageError,
    warn,
    wrap,
    write,
    writeAll,
    type Candidate,
    type Command,
    type Context,
} from './host.ts';
import {
    answerBox,
    chooseModel,
    copilotVersion,
    DATASET_DETAILS,
    DATASET_SUMMARY,
    DATASET_USAGE,
    datasetProjectFlag,
    DEFAULT_RESUMES,
    fallbackRef,
    FINETUNE_DETAILS,
    FINETUNE_SUMMARY,
    FINETUNE_USAGE,
    finetuneProjectFlag,
    lastSession,
    launch,
    listPrompts,
    loadPrompt,
    masked,
    metaCompatible,
    misspelledProvider,
    MODEL_ENV,
    openLog,
    ORDER,
    SKILL_DIR,
    readMeta,
    recordSession,
    RESUME_PROMPT,
    resumeDelayMs,
    runDataset,
    runFinetune,
    sdkVersion,
    sessionTotals,
    SOURCE_LABELS,
    startVertexRelay,
    tailSpans,
    Tally,
    terminalSink,
    transient,
    writeMeta,
    type ModelSources,
} from './index.ts';
import { EFFORTS } from './chat/session.ts';
import { announce, prepare, projectModel } from './prepare.ts';
import { usageReporter } from './reporter.ts';

const USAGE = 'zen meta run [project] [prompt] [options]';

const VERBS = new Set(['model', 'run', 'chat', 'prompts', 'resume', 'dataset', 'finetune']);

/** A copilot session id, or the 7+ hex prefix of one it also accepts. */
const SESSION_ID = /^[0-9a-f]{7,}(?:-[0-9a-f]+)*$/i;

/** Verbs that own their flags and their help page. */
const SUBCOMMANDS = {
    dataset: {
        run: runDataset,
        projectFlag: datasetProjectFlag,
        page: { usage: DATASET_USAGE, summary: DATASET_SUMMARY, details: DATASET_DETAILS },
    },
    finetune: {
        run: runFinetune,
        projectFlag: finetuneProjectFlag,
        page: { usage: FINETUNE_USAGE, summary: FINETUNE_SUMMARY, details: FINETUNE_DETAILS },
    },
} as const;

/** `zen meta dataset ...` or `zen meta acme dataset ...`: which one, and where its own args start. */
function subcommand(
    args: readonly string[],
): { name: keyof typeof SUBCOMMANDS; at: number } | undefined {
    for (const name of Object.keys(SUBCOMMANDS) as (keyof typeof SUBCOMMANDS)[]) {
        if (args[0] === name) {
            return { name, at: 0 };
        }
        if (args[1] === name && !args[0]?.startsWith('-')) {
            return { name, at: 1 };
        }
    }
    return undefined;
}

function page(p: { usage: string; summary: string; details: readonly string[] }): void {
    write(bold(p.usage));
    write(`\n  ${p.summary}`);
    write('');
    for (const line of p.details) {
        write(line ? `  ${line}` : '');
    }
}

interface Flags {
    project?: string;
    provider?: string;
    model?: string;
    prompt?: string;
    'prompt-file'?: string;
    agent?: string;
    effort?: string;
    share?: string;
    events?: string;
    resume?: string;
    continue?: boolean;
    'session-id'?: string;
    retries?: string;
    'allow-all'?: boolean;
    'allow-tool'?: string;
    ask?: boolean;
    'add-dir'?: string[];
    'dry-run'?: boolean;
    local?: boolean;
    pick?: boolean;
    clear?: boolean;
    force?: boolean;
    'no-refresh'?: boolean;
}

/** Kept apart from `run` so that shell completion offers exactly what is parsed. */
const OPTIONS: NonNullable<ParseArgsConfig['options']> = {
    project: { type: 'string' },
    provider: { type: 'string' },
    model: { type: 'string' },
    prompt: { type: 'string', short: 'p' },
    'prompt-file': { type: 'string' },
    agent: { type: 'string' },
    effort: { type: 'string' },
    share: { type: 'string' },
    events: { type: 'string' },
    resume: { type: 'string' },
    continue: { type: 'boolean' },
    'session-id': { type: 'string' },
    retries: { type: 'string' },
    'allow-all': { type: 'boolean' },
    'allow-tool': { type: 'string' },
    ask: { type: 'boolean' },
    'add-dir': { type: 'string', multiple: true },
    'dry-run': { type: 'boolean' },
    local: { type: 'boolean' },
    pick: { type: 'boolean' },
    clear: { type: 'boolean' },
    force: { type: 'boolean' },
    'no-refresh': { type: 'boolean' },
};
const RUN_FORMS = [
    '  zen meta run [project] "<question>"      ask it something',
    '  zen meta run [project] /<name> [words]   run one of its commands',
    '  zen meta run [project]                   pick one of its commands',
];

const RUN_ARGUMENTS = [
    'Arguments:',
    '  [project]   Name of a project. Default: the one you are in.',
    '  [prompt]    Your question, in quotes. Or --prompt, or piped in when neither',
    '              it nor --prompt-file is given.',
    '  /<name>     A command: the skill in .github/skills/<name>/SKILL.md.',
    '  [words]     Given to that command, after its text.',
];

const RUN_OPTIONS = [
    'Options:',
    '  --project <name|dir>   Which project to work in. The agent is rooted there.',
    '  --model <ref>          Model for this run, e.g. vertex/gemini-3.8-flash.',
    '  --provider <name>      Force the key to use. Default: the model ref says.',
    '  -p, --prompt <text>    The question, in place of [prompt].',
    '                         Ignored with /<name>: put words after it instead.',
    '  --prompt-file <file>   Added after the question - or after /<name> and its',
    '                         words - past a blank line. Alone, it is the question.',
    '  --agent <name>         A .github/agents/<name>.agent.md.',
    '  --effort <level>       none, minimal, low, medium, high, xhigh or max.',
    '  --allow-tool <list>    Only these: read, shell(git:*), write(README.md).',
    '  --ask                  Have it ask before each tool. Default: it does not.',
    '  --add-dir <dir>        Another directory it may touch. Repeatable.',
    '  --resume <id>          Continue a copilot session. --continue takes the last.',
    '  --session-id <uuid>    Start a new session under this id. Default: a random one.',
    `  --retries <n>          Resume after a rate limit or outage. Default ${DEFAULT_RESUMES}, 0 = off.`,
    '  --share <file>         Write the transcript to a markdown file.',
    '  --events <file>        Append what the agent does to this file as it does it:',
    '                         one JSON line per model call, tool call and message.',
    '  --dry-run              Print what would run, secrets masked, and stop.',
    '  --no-refresh           Leave the editor files as they are (parallel runs).',
    '  --json                 Print one object: answer, answerFile, sessionId, exitCode, tokens.',
];

export const command: Command = {
    summary: 'Run the meta agent over this project, on your own keys.',
    usage: USAGE,
    banner: { head: 'Zenera', accent: 'Meta', subtitle: 'Meta Agent', hue: 'cyan' },
    details: [
        'Forms:',
        ...RUN_FORMS,
        '  zen meta prompts [project]               list its commands',
        '  zen meta chat [project] [question]       talk it through, turn by turn',
        '  zen meta resume [project] [session]      carry on a run that stopped',
        '  zen meta model [ref]                     show or set the model it uses',
        '  zen meta dataset <verb>                  the cases it tunes against',
        '  zen meta finetune <verb>                 tune the project on those cases',
        '',
        'The project may come before the verb instead: `zen meta acme run`.',
        '`zen meta dataset --help`, `zen meta finetune --help`, `zen meta chat --help`',
        'and `zen meta run --help` have their own pages; the last lists the commands.',
        '',
        ...RUN_ARGUMENTS,
        '',
        ...RUN_OPTIONS,
        '',
        'It always uses your own keys — `zen key add` — and never a coding-agent',
        'subscription. The answer goes to stdout and the progress to stderr, so',
        '`> out.md` keeps the answer alone.',
        '',
        'It may use every tool without asking, because a prompt written for an',
        'editor expects to read, write and run things, and a terminal has nobody',
        'watching to answer. Narrow it with --allow-tool, or restore the asking',
        'with --ask.',
        '',
        '`zen meta resume` picks up the last session the project ran - or the one',
        'named - where it stopped. A run that ends any way but success prints it.',
        '',
        'Its tokens are counted as it runs and summed when it ends. In a project with',
        'a finetune/, every call - and every zen run and inspect ask it makes - is',
        'appended to finetune/usage/ledger.jsonl, and finetune/USAGE.md is rewritten.',
        '',
        'Nothing it needs is put on a command line: every credential reaches it',
        'through the environment, where other processes cannot read it.',
        '',
        'The editor files `zen init` writes (.vscode/ and the .github/',
        'tree) are refreshed in the project first, the way `zen open` refreshes',
        'them: the agent is about to read that brief, and it describes this version',
        'of zen. Edits to them do not survive.',
        '',
        'The model is looked for in this order: --model, ZENERA_META_MODEL in the',
        "shell, ZENERA_META_MODEL in the project's .env, `zen meta model`, then",
        'agents.yaml. With none of them set it uses the best model it knows of for',
        'a provider you hold a key for, and says which on stderr. Through a gateway',
        'it asks what the gateway serves and takes the best of that, as ranked by',
        '`zen models ls --chat --best`.',
        '',
        'Setting one asks the provider a one-word question first, so a model that',
        "will not answer is never stored. A model whose API rejects copilot's tools",
        '(gpt-4o and older) is refused before that. --force skips both.',
        '',
        '`zen meta model --pick` browses every model your keys reach: / filters,',
        't asks one a question, p takes it.',
        '',
        'Examples:',
        '  zen meta run "what does this project do?"',
        '  zen meta run acme "review the last commit"',
        '  zen meta prompts',
        '  zen meta run /project-review',
        '  zen meta run acme /spec-sync-project agents/triage.md',
        '  zen meta run acme /analyze --json',
        '  zen meta resume acme',
        '  git diff | zen meta run "what broke?" --allow-tool read',
        '  zen meta model vertex/gemini-3.8-flash',
        '  zen meta model --pick',
        '  zen meta run --dry-run "hello"',
    ],
    help: async (ctx) => {
        const sub = subcommand(ctx.args);
        if (sub) {
            return page(SUBCOMMANDS[sub.name].page);
        }
        const words = ctx.args.filter((a) => !a.startsWith('-'));
        if (words[0] === 'run' || words[1] === 'run') {
            return await runHelp(ctx, words);
        }
        if (words[0] === 'chat' || words[1] === 'chat') {
            return page(CHAT_PAGE);
        }
        page({ ...command, details: command.details ?? [] });
    },
    complete: (args, cur, cwd) => completeMeta(args, cur, cwd),
    subsystems: async () => [await copilotVersion(), sdkVersion()],
    run: async (ctx) => {
        // These own their flags, so they are routed before the meta agent's are parsed.
        const sub = subcommand(ctx.args);
        if (sub) {
            const { run, projectFlag } = SUBCOMMANDS[sub.name];
            const args = ctx.args.slice(sub.at + 1);
            const found = await resolveProject({
                cwd: ctx.cwd,
                project: projectFlag(args) ?? (sub.at === 1 ? ctx.args[0] : undefined),
            });
            return await run({ args, json: ctx.json, cwd: ctx.cwd }, found);
        }
        const { values, positionals } = parse<Flags>(ctx.args, OPTIONS, USAGE);

        // `zen meta acme run` is typed at least as often as `zen meta run acme`,
        // and read literally it asks the agent the one-word question "run" —
        // a whole model call spent on a typo, with nothing on screen to say so.
        const [first, second] = positionals;
        const named =
            first !== undefined &&
            second !== undefined &&
            !VERBS.has(first) &&
            VERBS.has(second) &&
            (await Projects.find(first))
                ? first
                : undefined;
        const verb = named ? second : first;
        const args = named ? [named, ...positionals.slice(2)] : positionals.slice(1);

        if (verb === 'model') {
            if (named) {
                throw usageError('the model is not per-project', 'try: zen meta model');
            }
            return await model(ctx, values, args);
        }
        if (verb === 'run') {
            return await stored(ctx, values, args);
        }
        if (verb === 'prompts') {
            return await prompts(ctx, values, args);
        }
        if (verb === 'resume') {
            return await resumeRun(ctx, values, args);
        }
        if (verb === 'chat') {
            return await chat(ctx, values, args);
        }
        throw usageError(
            first === undefined ? 'nothing to run' : 'a prompt goes through `run`',
            `try: zen meta run ${positionals.map(requote).join(' ') || '"what does this project do?"'}`,
        );
    },
};

// ---------------------------------------------------------------------------
// zen meta run --help
//
// The prompts are the reason to type `run`, so its page names them. The
// shipped ones come from the templates, which `run` refreshes into the project
// first; a project's own additions are read from the project.
// ---------------------------------------------------------------------------

async function runHelp(ctx: Context, words: string[]): Promise<void> {
    const at = ctx.args.indexOf('--project');
    const flag =
        ctx.args.find((a) => a.startsWith('--project='))?.slice('--project='.length) ??
        (at >= 0 ? ctx.args[at + 1] : undefined);
    const named = flag ?? (words[1] === 'run' ? words[0] : words[1]);
    const project =
        (named && !named.startsWith('/') ? await Projects.find(named) : undefined) ??
        (await Projects.current(ctx.cwd));

    const shipped = join(TEMPLATES, 'editor');
    const ours = new Set(await listPrompts(shipped));
    const theirs = project ? await listPrompts(project.dir) : [];
    const names = [...new Set([...ours, ...theirs])].sort();
    const found = await Promise.all(
        names.map((n) => loadPrompt(ours.has(n) ? shipped : project!.dir, n)),
    );

    const lines = [
        'Forms:',
        ...RUN_FORMS,
        '',
        project ? `Prompts in ${project.name}:` : 'Prompts:',
    ];
    const nameWidth = Math.max(...found.map((p) => p.name.length + 1));
    const room = Math.max(30, Math.min(process.stdout.columns ?? 80, 100) - nameWidth - 6);
    for (const p of found) {
        const [first = '', ...more] = wrap(p.description ?? '', room);
        lines.push(`  ${pad(`/${p.name}`, nameWidth)}  ${first}`.trimEnd());
        lines.push(...more.map((l) => `  ${' '.repeat(nameWidth)}  ${l}`));
    }
    lines.push(
        '',
        ...RUN_ARGUMENTS,
        '',
        ...RUN_OPTIONS,
        '',
        'Examples:',
        '  zen meta run "what does this project do?"',
        '  zen meta run acme /project-review',
        '  zen meta run acme /spec-sync-project agents/triage.md',
        '  zen meta run acme /analyze --json',
    );
    page({
        usage: 'zen meta run [project] [/<name> [words] | "<question>"] [options]',
        summary: 'Ask the meta agent a question, or run one of the commands.',
        details: lines,
    });
}

/** Words the shell would have split are shown back the way they were typed. */
const requote = (s: string): string => (/\s/.test(s) ? JSON.stringify(s) : s);

// ---------------------------------------------------------------------------
// Which project
//
// `zen meta run acme "…"` is what gets typed before anyone finds --project, and
// a project name is a bare word where a prompt is a sentence — the same reading
// `zen run` gives its first positional, for the same reason.
// ---------------------------------------------------------------------------

async function where(
    ctx: Context,
    flag: string | undefined,
    positionals: string[],
): Promise<{ project: Projects.Project; rest: string[] }> {
    const [head, ...tail] = positionals;
    const named = !flag && head ? await Projects.find(head) : undefined;
    const project = await resolveProject({
        cwd: ctx.cwd,
        project: flag ?? (named ? head : undefined),
    });
    return { project, rest: named ? tail : positionals };
}

/**
 * The editor's files, rewritten before the agent reads them — the same refresh
 * `zen open` does, for the same reason. `.github/` is the brief this agent works
 * from and the prompts it is offered, and it describes the version of `zen` in
 * hand; a project scaffolded by an older one would otherwise be briefed on a
 * runtime that has moved. A failure is narrated, not raised: a read-only
 * checkout is no reason to refuse to answer a question.
 */
function refresh(project: Projects.Project): void {
    try {
        const written = editorFiles(project.dir);
        if (written.length) {
            note(dim(`refreshed ${written.length} editor files in ${project.name}`));
        }
    } catch (err) {
        warn(`could not refresh the editor files — ${(err as Error).message}`);
    }
}

// ---------------------------------------------------------------------------
// zen meta run [project] [/<name>|<question>] [words...]
//
// The leading slash is a marker, not decoration: with it there is nothing to
// guess, because the project is whatever came before and the extra words are
// whatever came after, even when a project and a prompt share a name. Without
// one the words are the question itself.
// ---------------------------------------------------------------------------

async function stored(ctx: Context, values: Flags, args: string[]): Promise<void> {
    const slash = args.findIndex((a) => a.startsWith('/'));
    let head: string[];
    let name: string | undefined;
    let rest: string[];
    if (slash >= 0) {
        head = args.slice(0, slash);
        name = args[slash];
        rest = args.slice(slash + 1);
    } else if (args[0] !== undefined && (await Projects.find(args[0]))) {
        head = [args[0]];
        rest = args.slice(1);
    } else {
        head = [];
        rest = args;
    }

    const { project } = await where(ctx, values.project, head);
    if (!values['no-refresh']) {
        refresh(project);
    }
    if (name) {
        return await runPrompt(ctx, values, project, name, rest);
    }
    const question =
        withFile(values, (values.prompt ?? rest.join(' ')).trim()) || (await readStdin());
    if (question) {
        return await go(ctx, values, project, question);
    }
    // Nothing said and nothing piped: the commands are what is left to offer.
    return await runPrompt(ctx, values, project, await pickPrompt(ctx, project), []);
}

async function runPrompt(
    ctx: Context,
    values: Flags,
    project: Projects.Project,
    name: string,
    extra: string[],
): Promise<void> {
    const found = await loadPrompt(project.dir, name);
    if (found.description) {
        note(dim(found.description));
    }
    const prompt = withFile(
        values,
        extra.length > 0 ? `${found.body}\n\n${extra.join(' ')}` : found.body,
    );
    await go(ctx, values, project, prompt, name.replace(/^\//, ''));
}

/** The prompt with `--prompt-file` after it: text too long, or too awkward to quote, for a word. */
function withFile(values: Flags, prompt: string): string {
    const file = values['prompt-file'];
    if (!file) {
        return prompt;
    }
    let text: string;
    try {
        text = readFileSync(resolve(file), 'utf8').trim();
    } catch {
        throw usageError(`no prompt file at ${file}`, 'name a file that exists');
    }
    return [prompt, text].filter(Boolean).join('\n\n');
}

async function pickPrompt(ctx: Context, project: Projects.Project): Promise<string> {
    const names = await listPrompts(project.dir);
    if (names.length === 0) {
        throw usageError(
            'nothing to run',
            `try: zen meta run ${project.name} "what does this project do?"`,
        );
    }
    if (!isInteractive() || ctx.json) {
        throw usageError('which prompt?', `try: ${names.map((n) => `/${n}`).join(', ')}`);
    }
    return await choose(
        'Which prompt?',
        names.map((n) => ({ label: `/${n}`, value: n })),
    );
}

// ---------------------------------------------------------------------------
// Completing it
//
// `zen meta run acme /<Tab>` is where a terminal can show what an editor's menu
// shows. It reads the line the way `stored` does — a leading slash is a prompt,
// a bare word that names a project is the project — and it only ever reads:
// the editor files are not refreshed for the sake of a Tab.
// ---------------------------------------------------------------------------

async function findProject(name: string): Promise<Projects.Project | undefined> {
    try {
        return await Projects.find(name);
    } catch {
        return undefined;
    }
}

async function promptsOf(project: Projects.Project | undefined): Promise<Candidate[]> {
    if (!project) {
        return [];
    }
    const names = await listPrompts(project.dir);
    return await Promise.all(
        names.map(async (name) => ({
            value: `/${name}`,
            description: (await loadPrompt(project.dir, name).catch(() => undefined))?.description,
        })),
    );
}

/** `args` is what came after `meta`, without the word being completed. */
export async function completeMeta(
    args: readonly string[],
    cur: string,
    cwd: string,
): Promise<Candidate[]> {
    const words: string[] = [];
    let flagged: string | undefined;
    let waiting: string | undefined;
    for (const arg of args) {
        if (waiting) {
            if (waiting === 'project') {
                flagged = arg;
            }
            waiting = undefined;
        } else if (arg.startsWith('--')) {
            const [flag, value] = arg.slice(2).split(/=(.*)/s);
            if (value !== undefined) {
                flagged = flag === 'project' ? value : flagged;
            } else if (OPTIONS[flag]?.type === 'string') {
                waiting = flag;
            }
        } else if (arg === '-p') {
            waiting = 'prompt';
        } else if (!arg.startsWith('-')) {
            words.push(arg);
        }
    }

    // A flag's value is the flag's to name, and most of them are free text or a
    // path — which is the shell's.
    if (waiting === 'provider') {
        return matching(
            PROVIDERS.map((value) => ({ value })),
            cur,
        );
    }
    if (waiting === 'project') {
        return matching(await projectNames(), cur);
    }
    if (waiting) {
        return [];
    }

    const at = words.findIndex((w) => VERBS.has(w));
    const named = at === 1 ? words[0] : undefined;
    const verb = at === 0 || (named && (await findProject(named))) ? words[at] : undefined;

    if (cur.startsWith('-')) {
        return verb === 'dataset' || verb === 'finetune'
            ? []
            : matching(
                  Object.keys(OPTIONS).map((flag) => ({ value: `--${flag}` })),
                  cur,
              );
    }
    if (!verb) {
        const verbs = [...VERBS].map((value) => ({ value }));
        if (words.length === 0) {
            return matching([...verbs, ...(await projectNames())], cur);
        }
        return words.length === 1 && (await findProject(words[0])) ? matching(verbs, cur) : [];
    }

    const rest = words.slice(at + 1);
    if (verb === 'prompts' || verb === 'resume' || verb === 'chat') {
        return flagged || named || rest.length > 0 ? [] : matching(await projectNames(), cur);
    }
    if (verb !== 'run' || rest.some((w) => w.startsWith('/'))) {
        // Past the prompt's name, what follows is files and words.
        return [];
    }

    const given = flagged ?? named ?? rest[0];
    if (given === undefined) {
        const here = await Projects.current(cwd).catch(() => undefined);
        return matching([...(await promptsOf(here)), ...(await projectNames())], cur);
    }
    const project = await findProject(given);
    const fromRest = !flagged && !named;
    const free = rest.length - (fromRest && project ? 1 : 0);
    return free > 0 ? [] : matching(await promptsOf(project), cur);
}

// ---------------------------------------------------------------------------
// zen meta prompts [project]
//
// A slash command is only discoverable inside an editor, where a menu drops
// down as you type it. On a terminal the same files have to be asked for.
// ---------------------------------------------------------------------------

async function prompts(ctx: Context, values: Flags, args: string[]): Promise<void> {
    const { project } = await where(ctx, values.project, args);
    refresh(project);
    const names = await listPrompts(project.dir);
    const found = await Promise.all(names.map((name) => loadPrompt(project.dir, name)));

    if (ctx.json) {
        return json(found.map(({ name, description, path }) => ({ name, description, path })));
    }
    if (found.length === 0) {
        note(dim(`no commands in ${project.name}/${SKILL_DIR}`));
        return;
    }
    writeAll(table(found.map((p) => [`/${p.name}`, p.description ? dim(p.description) : ''])));
    note();
    note(dim(`run one: zen meta run /${found[0].name}`));
}

// ---------------------------------------------------------------------------
// zen meta chat [project] [question]
//
// `run` is one question and one answer, for a terminal nobody is watching or a
// script. A conversation is the other half: the same agent on the same keys,
// asked again with what it said still in hand. It goes through the Copilot SDK
// rather than copilot's `-p`, since a turn has to stream in and a tool call can
// stop to ask - and both of those need someone at the terminal.
// ---------------------------------------------------------------------------

const CHAT_PAGE = {
    usage: 'zen meta chat [project] [question] [options]',
    summary: 'Talk to the meta agent: a conversation over this project, on your own keys.',
    details: [
        'Arguments:',
        '  [project]    Name of a project. Default: the one you are in.',
        '  [question]   Asked as soon as the chat opens. Or --prompt.',
        '',
        'Options:',
        '  --project <name|dir>   Which project to work in. The agent is rooted there.',
        '  --model <ref>          Model for this chat, e.g. vertex/gemini-3.8-flash.',
        '  --provider <name>      Force the key to use. Default: the model ref says.',
        '  --agent <name>         A .github/agents/<name>.agent.md.',
        `  --effort <level>       ${EFFORTS.join(', ')}.`,
        '  --allow-tool <list>    Only these: read, shell(git:*), write(README.md).',
        '  --ask                  Ask before each tool: y, n, or a for always. Default: it does not.',
        '  --add-dir <dir>        Another directory it may touch. Repeatable.',
        '  --resume <id>          Carry on a session - a chat or a run. --continue takes the last.',
        '  --session-id <uuid>    Start a new session under this id. Default: a random one.',
        `  --retries <n>          Resume a turn after a rate limit or outage. Default ${DEFAULT_RESUMES}.`,
        '  --events <file>        Append what the agent does to this file as it does it.',
        '  --no-refresh           Leave the editor files as they are.',
        '',
        'In the chat:',
        '  /help              the commands',
        '  /prompts           the commands this project offers',
        '  /<name> [words]    run one: .github/skills/<name>/SKILL.md',
        '  /exit              leave; Ctrl-D, or Ctrl-C twice, does too',
        '  Esc                stop the turn in flight',
        '  ↑ ↓                what you asked before, kept per project',
        '',
        'The model, the key and the editor files are chosen and refreshed as for',
        '`zen meta run`, and every call is counted and logged the same way. The',
        "session is copilot's, so `zen meta resume` and `--resume` take a chat as",
        'readily as a run. It needs a terminal: for one answer in a script, or as',
        'JSON, use `zen meta run`.',
        '',
        'Examples:',
        '  zen meta chat',
        '  zen meta chat acme "what does this project do?"',
        '  zen meta chat --continue',
        '  zen meta chat --ask --allow-tool read',
    ],
};

async function chat(ctx: Context, values: Flags, args: string[]): Promise<void> {
    if (ctx.json) {
        throw usageError(
            'zen meta chat is a conversation, with no one answer to print as JSON',
            'for that: zen meta run "<question>" --json',
        );
    }
    for (const flag of ['dry-run', 'share', 'prompt-file'] as const) {
        if (values[flag]) {
            throw usageError(`zen meta chat takes no --${flag}`, `zen meta run takes it`);
        }
    }
    if (values.effort && !EFFORTS.includes(values.effort)) {
        throw usageError(`--effort takes ${EFFORTS.join(', ')}`, `got "${values.effort}"`);
    }
    const retries = count(values.retries, '--retries') ?? DEFAULT_RESUMES;
    if (!isInteractive() || !process.stdout.isTTY) {
        throw usageError(
            'zen meta chat needs a terminal to talk in',
            'for one answer: zen meta run "<question>"',
        );
    }
    const { project, rest } = await where(ctx, values.project, args);
    if (!values['no-refresh']) {
        refresh(project);
    }
    let resume = values.resume;
    if (values.continue && !resume) {
        resume = lastSession(project.dir);
        if (!resume) {
            note(dim(`no meta session recorded in ${project.name} - starting a new one`));
        }
    }
    if (resume) {
        note(dim(`resuming session ${resume}`));
    }
    const { runChat } = await import('./chat/run.ts');
    await runChat({
        values: { ...values, resume, continue: false },
        project,
        cwd: ctx.cwd,
        first: (values.prompt ?? rest.join(' ')).trim() || undefined,
        retries,
    });
}

// ---------------------------------------------------------------------------
// zen meta resume [project] [session id] [words...]
//
// A long run stops for reasons nobody chose - a refused request, a closed
// laptop, Ctrl-C. Copilot keeps the session; this hands it back, by default the
// last one the project ran, with the words (or a plain "continue") as the turn.
// ---------------------------------------------------------------------------

async function resumeRun(ctx: Context, values: Flags, args: string[]): Promise<void> {
    const { project, rest } = await where(ctx, values.project, args);
    const named = rest[0] !== undefined && SESSION_ID.test(rest[0]) ? rest[0] : undefined;
    const words = named ? rest.slice(1) : rest;
    const session = named ?? values.resume ?? lastSession(project.dir);
    if (!session) {
        throw usageError(
            `no meta session recorded in ${project.name}`,
            `name one: zen meta resume ${project.name} <session id>`,
        );
    }
    note(dim(`resuming session ${session}`));
    if (!values['no-refresh']) {
        refresh(project);
    }
    const message = withFile(values, (values.prompt ?? words.join(' ')).trim()) || RESUME_PROMPT;
    await go(ctx, { ...values, resume: session, continue: false }, project, message);
}

// ---------------------------------------------------------------------------
// The run itself
// ---------------------------------------------------------------------------

async function go(
    ctx: Context,
    values: Flags,
    project: Projects.Project,
    prompt: string,
    promptName?: string,
): Promise<void> {
    const prepared = await prepare(values, project, prompt);
    const { owner, chosen, wiring, binary } = prepared;
    values = prepared.values;
    let session = prepared.session;
    const args = argv(values, project.dir, prompt, wiring.secret, session);
    const retries = count(values.retries, '--retries') ?? DEFAULT_RESUMES;

    if (values['dry-run']) {
        const lines = masked(wiring.env, wiring.secret);
        if (ctx.json) {
            return json({
                project: project.dir,
                provider: owner,
                model: chosen.ref,
                from: SOURCE_LABELS[chosen.from],
                command: [binary.command, ...binary.args, ...args],
                env: Object.fromEntries(lines.map((l) => l.split('=', 2) as [string, string])),
            });
        }
        write(`${binary.command} ${[...binary.args, ...args].join(' ')}`);
        writeAll(lines.map((l) => dim(l)));
        note(dim(`model ${chosen.ref} from ${SOURCE_LABELS[chosen.from]}`));
        return;
    }

    announce(prepared, project);

    const log = openLog(project.dir, new Date(), session);
    note(`log  ${log.path}`);
    const elided = args.map((a, i) => (args[i - 1] === '-p' ? '<prompt>' : a));
    log.line(`zen meta ${new Date().toISOString()}`);
    log.line(`project ${project.name} ${project.dir}`);
    log.line(`model   ${chosen.ref} from ${SOURCE_LABELS[chosen.from]}`);
    log.line(`command ${[binary.command, ...binary.args, ...elided].join(' ')}`);
    if (session) {
        recordSession(project.dir, session);
        log.line(`session ${session}`);
    }
    const relay = wiring.relay ? await startVertexRelay(wiring.relay) : undefined;
    if (relay) {
        wiring.env.COPILOT_PROVIDER_BASE_URL = relay.url;
        log.line(`relay   ${relay.url} -> vertex rawPredict`);
    }
    log.line('');
    log.line('--- prompt ---');
    log.line(prompt);
    log.line('');
    log.line('--- run ---');

    const resumeHint = (): string | undefined =>
        session ? `resume it: zen meta resume ${project.name} ${session}` : undefined;

    // Every zen command the agent runs inherits these, so a batch it starts or
    // an ask it makes lands in the same ledger, tagged with this session.
    const spans = log.path.replace(/\.log$/, '.otel.jsonl');
    const ledger = ledgerPath(project.dir);
    const env: Record<string, string> = {
        ...wiring.env,
        COPILOT_OTEL_FILE_EXPORTER_PATH: spans,
        ...(ledger ? { [LEDGER_ENV]: ledger } : {}),
        ...(session ? { [META_SESSION_ENV]: session } : {}),
        ...(promptName ? { [META_PROMPT_ENV]: promptName } : {}),
    };
    const tally = new Tally();
    const record = values.events ? copilotEventLog(resolve(ctx.cwd, values.events)) : undefined;
    const tail = tailSpans(spans, (call) => {
        tally.add(call);
        record?.call(call);
        appendUsage(project.dir, {
            kind: 'meta.call',
            ts: new Date(Date.parse(call.startedAt) + call.durationMs).toISOString(),
            ...call,
            session: call.session ?? session,
        });
    });
    const reporter = usageReporter(project.dir);
    const tokens = (): string => {
        tail.stop();
        return tally.toString();
    };

    // A run that dies still has to leave a readable file behind.
    try {
        let resumes = 0;
        const run = async (argList: string[]) => {
            const launchedAt = new Date();
            const outcome = await launch({
                binary,
                args: argList,
                env,
                cwd: project.dir,
                log,
                sink: ctx.json ? terminalSink : undefined,
                onEvent: record?.event,
                status: () => (tally.calls > 0 ? tally.toString() : ''),
            });
            if (outcome.sessionId && outcome.sessionId !== session) {
                session = outcome.sessionId;
                recordSession(project.dir, session);
            }
            const models = session ? sessionTotals(session) : undefined;
            if (session && models) {
                appendUsage(project.dir, {
                    kind: 'meta.session',
                    ts: new Date().toISOString(),
                    session,
                    models,
                    exitCode: outcome.exitCode,
                    resumes,
                    startedAt: launchedAt.toISOString(),
                    durationMs: Date.now() - launchedAt.getTime(),
                });
            }
            return outcome;
        };
        let outcome = await run(args);
        for (let reason = transient(outcome); reason && resumes < retries;) {
            const wait = resumeDelayMs(resumes);
            resumes += 1;
            const said = `${reason}: resuming in ${duration(wait)} (${resumes}/${retries})`;
            warn(said);
            log.line('');
            log.line(`--- resume ${resumes}: ${said} ---`);
            await pause(wait, resumeHint());
            const again = { ...values, resume: session, continue: false };
            outcome = await run(argv(again, project.dir, RESUME_PROMPT, wiring.secret));
            reason = transient(outcome);
        }

        log.line('');
        log.line('--- answer ---');
        log.line(outcome.answer);
        if (outcome.answer) {
            log.saveAnswer(outcome.answer);
        }
        const spent = tokens();
        log.line('');
        log.line(`tokens  ${spent}`);

        if (ctx.json) {
            json({
                project: project.dir,
                provider: owner,
                model: chosen.ref,
                sessionId: outcome.sessionId,
                exitCode: outcome.exitCode,
                resumes,
                usage: outcome.usage,
                tokens: { calls: tally.calls, ...tally.usage },
                answer: outcome.answer,
                answerFile: outcome.answer ? log.answerPath : undefined,
            });
        } else if (outcome.answer) {
            writeAll(answerBox(outcome.answer));
            // After the answer, not before: it is the thing you click once you
            // have read enough to want it in an editor.
            note(cyan(log.answerPath));
        }
        if (!ctx.json && tally.calls > 0) {
            note(dim(`tokens  ${spent}`));
        }

        if (outcome.exitCode !== 0) {
            throw new CliError(
                `the meta agent exited ${outcome.exitCode}`,
                EXIT.failed,
                resumeHint() ??
                    (binary.from === 'npx' ? 'install it: npm i -g @github/copilot' : undefined),
            );
        }
    } catch (err) {
        const hint = resumeHint();
        if (hint && !(err instanceof CliError)) {
            note(dim(hint));
        }
        throw err;
    } finally {
        tail.stop();
        reporter.stop();
        await relay?.close();
        log.close();
    }
}

/** The wait before a resume, cut short by Ctrl-C - which still says how to resume. */
async function pause(ms: number, hint: string | undefined): Promise<void> {
    const stop = new AbortController();
    const onInt = (): void => stop.abort();
    process.once('SIGINT', onInt);
    try {
        await sleep(ms, undefined, { signal: stop.signal });
    } catch {
        throw new CliError('interrupted', EXIT.failed, hint);
    } finally {
        process.off('SIGINT', onInt);
    }
}

/** Copilot's own flags, assembled once. Nothing secret goes on this line. */
function argv(
    values: Flags,
    dir: string,
    prompt: string,
    secret: string[],
    fresh?: string,
): string[] {
    const args = ['-C', dir, '-p', prompt, '--output-format', 'json', '--no-color'];
    // A prompt written for an editor expects to read, write and run things, and
    // there is nobody at a `-p` run to answer the question. Naming tools is the
    // narrower answer and wins; --ask is the way back to being asked.
    if (values['allow-all'] || (!values.ask && !values['allow-tool'])) {
        args.push('--allow-all-tools');
    }
    if (values['allow-tool']) {
        args.push('--allow-tool', values['allow-tool']);
    }
    for (const extra of values['add-dir'] ?? []) {
        args.push('--add-dir', extra);
    }
    if (values.agent) {
        args.push('--agent', values.agent);
    }
    if (values.effort) {
        args.push('--reasoning-effort', values.effort);
    }
    if (values.share) {
        args.push('--share', values.share);
    }
    if (values.resume) {
        args.push('--resume', values.resume);
    } else if (values.continue) {
        args.push('--continue');
    } else if (fresh) {
        args.push('--session-id', fresh);
    }
    if (secret.length > 0) {
        args.push('--secret-env-vars', secret.join(','));
    }
    return args;
}

function count(text: string | undefined, flag: string): number | undefined {
    if (text === undefined) {
        return undefined;
    }
    const value = Number(text);
    if (!Number.isInteger(value) || value < 0) {
        throw usageError(`${flag} takes a whole number, 0 or more`, `got "${text}"`);
    }
    return value;
}

// ---------------------------------------------------------------------------
// zen meta model
//
// Bare, it answers the question that actually gets asked, which is not "what
// model" but "why that one" — so the chain is printed with the winner marked,
// the same way `zen key ls` marks the key a run would use.
// ---------------------------------------------------------------------------

async function model(ctx: Context, values: Flags, args: string[]): Promise<void> {
    const project = await Projects.current(ctx.cwd);
    const shell = process.env[MODEL_ENV];
    if (project) {
        loadProjectEnv(project.dir);
    }
    ensureHome();

    if (values.clear) {
        return clear(values, project);
    }
    const ref = values.pick ? await pickModel(ctx) : args[0];
    if (ref) {
        return set(ctx, values, project, ref);
    }

    const store = await KeyStore.open();
    store.materialize();
    const sources: ModelSources = {
        flag: undefined,
        shell,
        env: process.env[MODEL_ENV],
        stored: (await readMeta()).model,
        project: project ? projectModel(project.dir) : undefined,
        fallback: await fallbackRef(store, undefined, gatewayOf() !== undefined),
    };
    const chosen = chooseModel(sources);
    const at: Record<string, string | undefined> = {
        flag: sources.flag,
        shell: sources.shell,
        env: sources.shell ? undefined : sources.env,
        store: sources.stored,
        project: sources.project,
        default: sources.fallback,
    };

    if (ctx.json) {
        return json({
            model: chosen?.ref,
            from: chosen ? SOURCE_LABELS[chosen.from] : undefined,
            sources: Object.fromEntries(ORDER.map((s) => [SOURCE_LABELS[s], at[s] ?? null])),
        });
    }
    if (chosen) {
        write(chosen.ref);
    }
    note();
    for (const source of ORDER) {
        const value = at[source];
        const mark = chosen?.from === source ? green('*') : ' ';
        note(`  ${mark} ${SOURCE_LABELS[source].padEnd(26)} ${value ?? dim('not set')}`);
    }
    if (!chosen) {
        note();
        note(dim('set one: zen meta model <provider>/<id>'));
    }
}

async function set(
    ctx: Context,
    values: Flags,
    project: Projects.Project | undefined,
    ref: string,
): Promise<void> {
    if (!values.force) {
        await vet(ctx, ref);
    }
    if (values.local) {
        if (!project) {
            throw usageError('--local needs a project', 'run it inside one, or drop --local');
        }
        await writeLocal(project.dir, ref);
        if (!ctx.json) {
            note(dim(`${MODEL_ENV}=${ref} in ${project.name}/.env`));
        }
    } else {
        const file = await readMeta();
        writeMeta({ ...file, model: ref });
    }
    if (ctx.json) {
        json({ model: ref, where: values.local ? '.env' : 'meta.json' });
    } else {
        write(ref);
    }
}

// ---------------------------------------------------------------------------
// Vetting a ref
//
// Naming a model is a deliberate act and the run that follows is not free, so
// the provider is asked one cheap question now. Without it a slip of the hand
// is stored happily and surfaces much later as a 404 from a vendor nobody
// named — `vertes/…` has no known prefix, so it would be sent whole to OpenAI.
// ---------------------------------------------------------------------------

async function vet(ctx: Context, ref: string): Promise<void> {
    const meant = misspelledProvider(ref);
    if (meant) {
        const [head, ...rest] = ref.split('/');
        throw usageError(
            `no provider called "${head}"`,
            `did you mean ${meant}/${rest.join('/')}?`,
        );
    }
    const { provider, id } = splitRef(ref);
    const owner = provider ?? 'openai';
    if (!metaCompatible(owner, id)) {
        throw usageError(
            `${owner}/${id} cannot run the meta agent: its API rejects copilot's tools`,
            'pick a reasoning model, e.g. from: zen models ls --chat --best',
        );
    }
    const store = await KeyStore.open();
    store.materialize();
    if (!gatewayOf() && !store.active(owner)) {
        throw credentialError(`no ${owner} key to try ${id} with`, `add one: zen key add ${owner}`);
    }

    const bar = ctx.json ? undefined : progress();
    bar?.update(dim(`asking ${owner} about ${id} …`));
    const probe = await probeModel({
        // The colon form, so a refusal suggests `zen models ls <provider>`.
        ref: `${owner}:${id}`,
        kind: 'model',
        model: probeChat(owner, id),
    });
    bar?.done();

    if (probe.check.state !== 'live') {
        const why = probe.check.detail ? ` — ${probe.check.detail}` : '';
        const fix = probe.check.fix ?? `see what it serves: zen models ls ${owner}`;
        throw credentialError(`${owner} did not answer to ${id}${why}`, `${fix}, or --force`);
    }
    if (!ctx.json) {
        note(dim(`${owner} answered in ${(probe.ms / 1000).toFixed(1)}s`));
    }
}

async function clear(values: Flags, project: Projects.Project | undefined): Promise<void> {
    if (values.local) {
        if (!project) {
            throw usageError('--local needs a project');
        }
        await writeLocal(project.dir, undefined);
    } else {
        const file = await readMeta();
        delete file.model;
        writeMeta(file);
    }
    note(dim('cleared'));
}

async function writeLocal(dir: string, ref: string | undefined): Promise<void> {
    const { readFile, writeFile } = await import('node:fs/promises');
    const path = `${dir}/.env`;
    let text = '';
    try {
        text = await readFile(path, 'utf8');
    } catch {
        text = '';
    }
    const line = new RegExp(`^${MODEL_ENV}=.*$`, 'm');
    const next = line.test(text)
        ? text.replace(line, ref ? `${MODEL_ENV}=${ref}` : '')
        : ref
          ? `${text}${text.endsWith('\n') || text === '' ? '' : '\n'}${MODEL_ENV}=${ref}\n`
          : text;
    await writeFile(path, next, { mode: 0o600 });
}

async function pickModel(ctx: Context): Promise<string> {
    if (!isInteractive() || ctx.json) {
        throw usageError('--pick needs a terminal', 'name the model instead');
    }
    const store = await KeyStore.open();
    store.materialize();
    const known = store.entries.map((e) => e.provider).filter(isProvider);
    if (known.length === 0 && !gatewayOf()) {
        throw credentialError('no keys to choose from', 'add one: zen key add openai');
    }
    const held = gatewayOf() ? [] : [...new Set(known)];
    const chosen = await browseModels({
        initial: held.length === 1 ? held[0] : undefined,
        role: 'chat',
    });
    if (!chosen) {
        throw usageError(
            'nothing picked',
            'name the model instead: zen meta model <provider>/<id>',
        );
    }
    return `${chosen.provider}/${chosen.id}`;
}
