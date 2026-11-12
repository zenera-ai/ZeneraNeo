import { liveHolder } from '@zenera/neo';
import { type ChildProcess, spawnSync } from 'node:child_process';
import {
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { editorFiles } from '../editor.ts';
import {
    bold,
    CliError,
    cyan,
    dim,
    EXIT,
    green,
    invalidError,
    json,
    note,
    parse,
    red,
    usageError,
    write,
    yellow,
} from '../host.ts';
import { costChanges, type Gate, measure, overLimits } from './cost.ts';
import { drift } from './dataset/drift.ts';
import { DatasetStore } from './dataset/store.ts';
import { runLoop } from './loop.ts';
import { analyzeSession, attemptsOf } from './report.ts';
import { retry } from './retry.ts';
import { resultOf, selection } from './sampler.ts';
import {
    type Config,
    DEFAULTS,
    FAILURES_IN_A_ROW,
    FINETUNE_DIR,
    LEGACY_FINETUNE_DIR,
    readJson,
    spawnZen,
    Tuning,
    type Zen,
} from './tuning.ts';
import { liveView, startView, type Viewing } from './view.ts';

// ---------------------------------------------------------------------------
// zen meta finetune
// ---------------------------------------------------------------------------

export const FINETUNE_USAGE =
    'zen meta finetune <start|status|stop|serve|retry|session|gate> [options]';

export const FINETUNE_HELP = [
    'Tuning:',
    '  zen meta finetune start [options]         train every case: run, analyze, apply, run again',
    '  zen meta finetune [status]                where it stands; the detail is finetune/STATUS.md',
    '  zen meta finetune stop                    finish the steps in flight, then stop',
    '  zen meta finetune serve                   the tuning live in a browser, while it is not running',
    '  zen meta finetune retry --difficult       give difficult cases another round, then start',
    "  zen meta finetune session <case>          resume the analyze session of that case's latest try",
    '  zen meta finetune gate <apply dir>        would this apply pass? - for the apply agent',
    '',
    '  start: -N <workers> (4), -M <apply at> (4), --tries <n> (4), --mem-tries <n> (3),',
    '  --class <c>, --id <glob>, --rubric yes|no, --limit <n> and --more <n> (this start only);',
    '  what an apply may do: --budget <bytes> (1500), --max-growth <pct> (50),',
    '  --skill-cap <bytes> (12000), --max-skills <n> (10); after it, --recheck <n> (3).',
    '  More - --merge-every, --seed, --force: zen meta finetune --help.',
    '  In a terminal start draws what runs now, the tokens and the log; --plain does not.',
    '  Settings are kept in finetune/loop.json; start again to resume where it stopped.',
];

export const FINETUNE_SUMMARY =
    "Tune the project's prose on its dataset, a case at a time, N cases at once.";

/** The page `zen meta finetune --help` prints. */
export const FINETUNE_DETAILS = [
    'Verbs:',
    '  start                  Train every case: run, analyze, apply, run again. Resumes.',
    '  status                 Where it stands (the default). The detail: finetune/STATUS.md',
    '  stop                   Let the steps in flight finish, then stop the running tuning.',
    '  serve                  Show the tuning live in a browser until Ctrl-C. start does this',
    '                         itself, and prints the address; serve is for when it is not running.',
    '  retry [ids...]         Another round for difficult cases: --difficult takes them all,',
    '                         ids and globs add to it, --class narrows. Run them with start.',
    "  session <case>         Print the command that resumes the analyze session of that case's",
    '                         latest try.',
    '  gate <apply dir>       Judge an apply in progress as the loop will: bytes moved per',
    '                         agent, skill and file, any limit broken, and zen check.',
    '                         Exits 1 when it would be undone. Read-only.',
    '',
    'Which cases (start):',
    '  --class <c>            Only this class. Repeatable.',
    '  --id <glob>            Only cases whose id matches. Repeatable.',
    '  --rubric yes|no        Only cases with, or without, a rubric.',
    '  --limit <n>            Only the first n cases of the order. Not kept.',
    '  --more <n>             Take at most n cases - new, part-way or failed - then stop.',
    '                         Parked cases it took still finish. Not kept.',
    '',
    'How it runs (start):',
    '  -N, --workers <n>      Cases trained at once. Default 4.',
    '  -M, --apply-at <n>     Apply once this many cases wait for a fix. Default 4, min 2.',
    '  --tries <n>            Tries without memory before a case is difficult. Default 4.',
    '  --mem-tries <n>        Tries with memory. Default 3.',
    '  --merge-every <k>      Merge the kept memories after k more arrive. Default 3.',
    '  --seed <n>             Order of cases inside a class. Default 1.',
    '',
    'What an apply may do (start):',
    '  --budget <bytes>       Most one apply may add to what every call reads. Default 1500.',
    '  --max-growth <pct>     Once that is this much over its size when the tuning began,',
    '                         an apply may add nothing. Default 50.',
    '  --skill-cap <bytes>    Most one skill may hold. Default 12000.',
    '  --max-skills <n>       Most skills one agent may see. Default 10.',
    '  --recheck <n>          After each apply, run this many completed cases again on it;',
    '                         one that fails both tries sends its fixes to the next apply.',
    '                         Default 3, 0 none.',
    '',
    'Other (start):',
    '  --force                Start past dataset drift, and allow -M 1.',
    '  --plain                No live view: print a line per start and stop, as in a pipe.',
    '  --project <name|dir>   Which project. Default: the one you are in.',
    '',
    'One case: without memory, run it and /analyze it until the analysis says done -',
    'parking it until the next apply after each try that is not - then the same with',
    'the memory the passing run wrote. Tries used up: the case is difficult. Each try',
    'has its own private memory; passing memories are merged into finetune/memories/.',
    '',
    'A parked case gives its worker back; woken cases take a worker before new ones.',
    '/zen-finetune-apply fixes the parked cases together: when -M wait, or once nothing',
    'else can run. No run starts during an apply. What it may do:',
    '  - Every call reads the house rules, the prompt, preloaded skills and one line per',
    '    skill, so that is what --budget counts. A skill body is paid only once loaded:',
    '    moving a procedure from a prompt into a skill is a saving.',
    '  - One case is an anecdote. A new rule needs two cases asking for it; one is',
    '    deferred and offered to every later apply until a second asks.',
    '  - A skill made for a case must be loaded by its next run, or the next apply',
    '    fixes the description.',
    '  - It tidies up after itself: the files it touched lose their duplicates and',
    '    contradictions in the same edit.',
    '  - zen check must pass and the budget hold, or the edit is undone and tried once',
    '    more. A second zen check failure stops the tuning; a second budget failure only',
    '    undoes the apply.',
    'Every apply is a new version of agents.yaml + agents/. Then --recheck completed',
    'cases run again on it, as ordinary work - nothing waits. One that fails both tries',
    'has regressed: its fixes join the queue, and the next apply repairs what broke.',
    '',
    'A case is difficult when its tries run out and the analysis still says no, or at',
    'once when all an apply could say of it is structural - a tool, a skill binding,',
    'the dataset. That is final for its revision until `retry` gives it another round.',
    'A case fails instead when something outside the prose broke - the sandbox, a',
    'provider, a key: it keeps its tries and carries on from that step at the next start.',
    `After ${FAILURES_IN_A_ROW} failures in a row the tuning stops, and says what broke;`,
    'a container engine that fails stops it at once. A run its analysis finds void -',
    'the network or a service under it down - is set aside and runs again.',
    '',
    'Ctrl-C (or stop) finishes the steps in flight; Ctrl-C again kills them. Start',
    'again to carry on: every step is kept on disk, and nothing finished is repeated.',
    'Settings given to start are kept in finetune/loop.json.',
    '',
    'Examples:',
    '  zen meta finetune start -N 4',
    '  zen meta finetune start --class search --limit 6 -N 2 -M 2',
    '  zen meta finetune start --limit 4 --recheck 0    # quick, cheap',
    '  zen meta finetune start --more 4',
    '  zen meta finetune',
    '  zen meta finetune retry --difficult --class merge',
    '  zen meta finetune session plan-day',
];

interface Flags {
    project?: string;
    workers?: string;
    'apply-at'?: string;
    tries?: string;
    'mem-tries'?: string;
    'merge-every'?: string;
    seed?: string;
    recheck?: string;
    budget?: string;
    'max-growth'?: string;
    'skill-cap'?: string;
    'max-skills'?: string;
    class?: string[];
    id?: string[];
    rubric?: string;
    limit?: string;
    more?: string;
    force?: boolean;
    plain?: boolean;
    difficult?: boolean;
    yes?: boolean;
}

const OPTIONS = {
    project: { type: 'string' },
    workers: { type: 'string', short: 'N' },
    'apply-at': { type: 'string', short: 'M' },
    tries: { type: 'string' },
    'mem-tries': { type: 'string' },
    'merge-every': { type: 'string' },
    seed: { type: 'string' },
    recheck: { type: 'string' },
    budget: { type: 'string' },
    'max-growth': { type: 'string' },
    'skill-cap': { type: 'string' },
    'max-skills': { type: 'string' },
    class: { type: 'string', multiple: true },
    id: { type: 'string', multiple: true },
    rubric: { type: 'string' },
    limit: { type: 'string' },
    more: { type: 'string' },
    force: { type: 'boolean' },
    plain: { type: 'boolean' },
    difficult: { type: 'boolean' },
    yes: { type: 'boolean' },
} as const;

export interface FinetuneContext {
    readonly args: readonly string[];
    readonly json: boolean;
    readonly cwd: string;
}

export function finetuneProjectFlag(args: readonly string[]): string | undefined {
    return parse<Flags>(args, OPTIONS, FINETUNE_USAGE).values.project;
}

export interface FinetuneOptions {
    /** stands in for the `zen` binary - tests */
    zen?: Zen;
    tickMs?: number;
}

export async function runFinetune(
    ctx: FinetuneContext,
    project: { dir: string; name: string },
    options: FinetuneOptions = {},
): Promise<void> {
    const { values, positionals } = parse<Flags>(ctx.args, OPTIONS, FINETUNE_USAGE);
    const [verb = 'status', ...rest] = positionals;
    moveLegacyDir(project.dir);
    switch (verb) {
        case 'start':
            return start(ctx, project, values, options);
        case 'status':
            return status(ctx, project);
        case 'stop':
            return stop(project);
        case 'serve':
            return serve(ctx, project);
        case 'retry':
            return retryCases(ctx, project, values, rest);
        case 'session':
            return session(project, rest);
        case 'gate':
            return gate(ctx, project, rest, options);
        default:
            throw usageError(
                `unknown finetune verb: ${verb}`,
                'one of: start, status, stop, serve, retry, session, gate',
            );
    }
}

/**
 * A tuning used to live in `.finetune/`. Moves it to `finetune/` once, so a
 * project tuned before the rename resumes where it stopped. Refuses while a
 * loop of the old version still holds its lock there: renaming its folder out
 * from under it would split one tuning across two directories.
 */
export function moveLegacyDir(projectDir: string): void {
    const legacy = join(projectDir, LEGACY_FINETUNE_DIR);
    const current = join(projectDir, FINETUNE_DIR);
    if (!existsSync(legacy)) {
        return;
    }
    if (existsSync(current)) {
        note(
            yellow(
                `both ${LEGACY_FINETUNE_DIR}/ and ${FINETUNE_DIR}/ exist; using ${FINETUNE_DIR}/ - remove ${LEGACY_FINETUNE_DIR}/ once nothing in it is wanted`,
            ),
        );
        return;
    }
    const holder = liveHolder(join(legacy, 'loop.lock'));
    if (holder) {
        throw invalidError(
            `a tuning is still running in ${LEGACY_FINETUNE_DIR}/ (pid ${holder.pid})`,
            `let it finish or stop that process, then run this again to move it to ${FINETUNE_DIR}/`,
        );
    }
    renameSync(legacy, current);
    note(dim(`moved ${LEGACY_FINETUNE_DIR}/ to ${FINETUNE_DIR}/`));
}

function whole(text: string | undefined, flag: string, min = 1): number | undefined {
    if (text === undefined) {
        return undefined;
    }
    const n = Number(text);
    if (!Number.isInteger(n) || n < min) {
        throw usageError(`${flag} takes a whole number of at least ${min}`, `got "${text}"`);
    }
    return n;
}

const configFile = (dir: string): string => join(dir, FINETUNE_DIR, 'loop.json');

export function readConfig(dir: string): Config {
    try {
        // A limit is for one start; older versions kept it, and had a guard and consolidations.
        const {
            limit: _,
            guard,
            consolidateEvery: __,
            ...saved
        } = JSON.parse(readFileSync(configFile(dir), 'utf8')) as Partial<Config> & {
            guard?: number;
            consolidateEvery?: number;
        };
        return { ...DEFAULTS, ...(guard !== undefined ? { recheck: guard } : {}), ...saved };
    } catch {
        return { ...DEFAULTS };
    }
}

function configFrom(dir: string, v: Flags): Config {
    const saved = readConfig(dir);
    const workers = whole(v.workers, '-N') ?? saved.workers;
    if (v.rubric !== undefined && v.rubric !== 'yes' && v.rubric !== 'no') {
        throw usageError('--rubric takes yes or no');
    }
    const applyAt = whole(v['apply-at'], '-M');
    if (applyAt === 1 && !v.force) {
        throw usageError(
            '-M 1 applies what one case asked for, alone',
            'one case is an anecdote: use -M 2 or more, or pass --force',
        );
    }
    const config: Config = {
        ...saved,
        workers,
        // An older version saved -N as -M, so a tuning on one worker kept applying one case at a time.
        applyAt: applyAt ?? (saved.applyAt < 2 && !v.force ? 2 : saved.applyAt),
        tries: whole(v.tries, '--tries') ?? saved.tries,
        memTries: whole(v['mem-tries'], '--mem-tries') ?? saved.memTries,
        mergeEvery: whole(v['merge-every'], '--merge-every') ?? saved.mergeEvery,
        seed: whole(v.seed, '--seed', 0) ?? saved.seed,
        recheck: whole(v.recheck, '--recheck', 0) ?? saved.recheck,
        budget: whole(v.budget, '--budget', 0) ?? saved.budget,
        maxGrowth: whole(v['max-growth'], '--max-growth', 0) ?? saved.maxGrowth,
        skillCap: whole(v['skill-cap'], '--skill-cap') ?? saved.skillCap,
        maxSkills: whole(v['max-skills'], '--max-skills') ?? saved.maxSkills,
        ...(v.class ? { classes: v.class } : {}),
        ...(v.id ? { ids: v.id } : {}),
        ...(v.rubric ? { rubric: v.rubric === 'yes' } : {}),
    };
    const limit = whole(v.limit, '--limit');
    mkdirSync(join(dir, FINETUNE_DIR), { recursive: true });
    writeFileSync(configFile(dir), `${JSON.stringify(config, null, 2)}\n`);
    return limit ? { ...config, limit } : config;
}

async function start(
    ctx: FinetuneContext,
    project: { dir: string; name: string },
    values: Flags,
    options: FinetuneOptions,
): Promise<void> {
    const store = DatasetStore.open(project.dir);
    if (!store.exists()) {
        throw invalidError('there is no dataset to tune on', 'build one: zen meta run /dataset');
    }
    const report = drift(store);
    if (!report.clean && !values.force) {
        throw invalidError(
            `the dataset has drifted from its sources (${report.cases.length} case(s), ${report.uncovered.length} section(s))`,
            'refresh it: zen meta run /dataset - or start with --force',
        );
    }
    const more = whole(values.more, '--more');
    const config = configFrom(project.dir, values);
    const children = new Set<ChildProcess>();
    const t = new Tuning(
        project.dir,
        config,
        options.zen ?? spawnZen(project.dir, children),
        options.tickMs,
    );
    t.more = more;
    if (!options.zen) {
        editorFiles(project.dir);
    }

    let interrupts = 0;
    let drawing = false;
    const onInterrupt = (): void => {
        interrupts++;
        if (interrupts === 1) {
            if (!drawing) {
                note(
                    yellow(
                        'stopping: the steps in flight finish first - Ctrl-C again to kill them',
                    ),
                );
            }
            t.stop('interrupted');
            return;
        }
        for (const child of children) {
            try {
                process.kill(-child.pid!, 'SIGTERM');
            } catch {
                // Already gone.
            }
        }
        process.exit(130);
    };
    process.on('SIGINT', onInterrupt);
    note(
        `${bold('tuning')} ${project.name} · ${config.workers} workers · apply at ${config.applyAt}`,
    );
    const viewing = options.zen ? undefined : await viewOf(project.dir);
    const url = viewing?.url ?? liveView(project.dir);
    if (url) {
        note(dim(`follow it: ${url}`));
    }
    let close: (() => void) | undefined;
    if (!ctx.json && !values.plain && !options.zen && process.stderr.isTTY && process.stdin.isTTY) {
        const { watch } = await import('./tui.tsx');
        close = await watch(t, onInterrupt, url);
        drawing = true;
    }
    try {
        await runLoop(t);
    } finally {
        close?.();
        process.off('SIGINT', onInterrupt);
        await viewing?.close();
    }
    if (!ctx.json) {
        await status(ctx, project);
    }
}

function counts(dir: string): Record<string, number> & { total: number } {
    const t = new Tuning(dir, readConfig(dir), async () => ({ code: 1, stdout: '' }));
    const out = { total: 0, queued: 0, stopped: 0, completed: 0, difficult: 0, failed: 0 };
    for (const c of selection(t)) {
        out.total++;
        const r = resultOf(t, c);
        if (r) {
            out[r.state]++;
        } else if (attemptsOf(t, c).length > 0) {
            out.stopped++;
        } else {
            out.queued++;
        }
    }
    return out;
}

function status(ctx: FinetuneContext, project: { dir: string; name: string }): void {
    const dir = join(project.dir, FINETUNE_DIR);
    if (!DatasetStore.open(project.dir).exists()) {
        throw invalidError('there is no dataset to tune on', 'build one: zen meta run /dataset');
    }
    const holder = liveHolder(join(dir, 'loop.lock'));
    const c = counts(project.dir);
    const url = liveView(project.dir);
    if (ctx.json) {
        return json({
            running: Boolean(holder),
            ...c,
            status: join(dir, 'STATUS.md'),
            ...(url ? { url } : {}),
        });
    }
    write(
        `${bold(project.name)}  ${holder ? green(`running (pid ${holder.pid})`) : dim('not running')}`,
    );
    write(
        `${c.total} cases: ${green(`${c.completed} completed`)}, ${yellow(`${c.difficult} difficult`)}, ${c.failed ? `${red(`${c.failed} failed`)}, ` : ''}${c.stopped} part-way, ${c.queued} not started`,
    );
    if (!holder && c.queued + c.stopped + c.failed > 0) {
        note(
            dim(
                `${c.stopped + c.failed > 0 ? 'resume it' : 'start it'}: ${cyan(`zen meta ${project.name} finetune start`)} [-N <workers>] - see zen meta finetune --help`,
            ),
        );
    }
    if (!holder && c.difficult > 0) {
        note(
            dim(
                `another round for the difficult ones: ${cyan(`zen meta ${project.name} finetune retry --difficult`)}`,
            ),
        );
    }
    if (existsSync(join(dir, 'STATUS.md'))) {
        note(
            dim(
                `the detail: ${cyan(join(dir, 'STATUS.md'))} · ${url ? cyan(url) : `live in a browser: ${cyan(`zen meta ${project.name} finetune serve`)}`}`,
            ),
        );
    }
}

/** The live view for a tuning, or a note saying why there is none - it never stops one. */
async function viewOf(projectDir: string): Promise<Viewing | undefined> {
    if (liveView(projectDir)) {
        return undefined;
    }
    try {
        return await startView(projectDir);
    } catch (err) {
        note(yellow(`no live view: ${err instanceof Error ? err.message : String(err)}`));
        return undefined;
    }
}

async function serve(ctx: FinetuneContext, project: { dir: string; name: string }): Promise<void> {
    const live = liveView(project.dir);
    if (live) {
        if (ctx.json) {
            return json({ url: live, served: false });
        }
        write(live);
        note(dim('already served by another zen process'));
        return;
    }
    const viewing = await startView(project.dir);
    if (ctx.json) {
        json({ url: viewing.url, served: true });
    } else {
        write(viewing.url);
        note(dim('serving the tuning · Ctrl-C stops it'));
    }
    await new Promise<void>((settle) => {
        const done = (): void => {
            process.off('SIGINT', done);
            process.off('SIGTERM', done);
            settle();
        };
        process.once('SIGINT', done);
        process.once('SIGTERM', done);
    });
    await viewing.close();
}

function stop(project: { dir: string }): void {
    const dir = join(project.dir, FINETUNE_DIR);
    if (!liveHolder(join(dir, 'loop.lock'))) {
        note('no tuning is running here');
        return;
    }
    writeFileSync(join(dir, 'stop'), `${new Date().toISOString()}\n`);
    note('asked it to stop: the steps in flight finish first');
}

async function retryCases(
    ctx: FinetuneContext,
    project: { dir: string; name: string },
    values: Flags,
    ids: string[],
): Promise<void> {
    const t = new Tuning(project.dir, readConfig(project.dir), async () => ({
        code: 1,
        stdout: '',
    }));
    const plan = await retry(t, {
        difficult: values.difficult,
        classes: values.class,
        ids: [...ids, ...(values.id ?? [])],
        yes: values.yes,
    });
    if (ctx.json) {
        json({ retried: plan.take.map((c) => c.id), skipped: plan.skip, tokens: plan.tokens });
    }
}

function session(project: { dir: string; name: string }, rest: string[]): void {
    const [id] = rest;
    if (!id) {
        throw usageError('session of which case?', 'zen meta finetune session <case>');
    }
    const c = DatasetStore.open(project.dir).get(id);
    if (!c) {
        throw invalidError(`no case ${id}`);
    }
    const t = new Tuning(project.dir, readConfig(project.dir), async () => ({
        code: 1,
        stdout: '',
    }));
    const latest = attemptsOf(t, c)
        .reverse()
        .map((a) => analyzeSession(a.dir))
        .find(Boolean);
    if (!latest) {
        throw invalidError(`${id} has not been analyzed yet at revision ${c.rev}`);
    }
    write(`zen meta resume ${project.name} ${latest}`);
}

/** The gates `#edit` runs after the apply agent exits, run now against the same `before` and limits. */
async function gate(
    ctx: FinetuneContext,
    project: { dir: string },
    rest: string[],
    options: FinetuneOptions,
): Promise<void> {
    const [at] = rest;
    if (!at) {
        throw usageError('gate of which apply?', 'zen meta finetune gate <apply dir>');
    }
    const dir = resolve(ctx.cwd, at);
    const g = readJson<Gate>(join(dir, 'gate.json'));
    if (!g || existsSync(join(dir, 'applied.json'))) {
        throw invalidError(
            `${at} is not an apply in progress`,
            'pass the apply directory named after /zen-finetune-apply',
        );
    }
    const after = await measure(project.dir);
    const over = overLimits(g.before, after, g.limits);
    const log = join(dir, 'gate.log');
    const check = await (options.zen ?? checkOnce(project.dir))(
        ['check', '--no-models', '--no-sandbox'],
        log,
    );
    const pass = over.length === 0 && check.code === 0;
    const grew = after.total - g.before.total;
    if (ctx.json) {
        json({
            pass,
            alwaysRead: { before: g.before.total, after: after.total },
            limits: g.limits,
            over,
            check: { code: check.code, log },
        });
    } else {
        const moved = costChanges(g.before, after);
        write(
            [
                `always read, summed over the agents: ${g.before.total} -> ${after.total} bytes (${grew > 0 ? '+' : ''}${grew}); budget +${g.limits.budget}, ceiling ${g.limits.ceiling}`,
                '',
                ...(moved.length > 0 ? moved : ['nothing the agents read changed size']),
                '',
                ...(over.length > 0 ? ['over the limits:', ...over.map((o) => `- ${o}`), ''] : []),
                check.code === 0
                    ? 'zen check: passed'
                    : `zen check: failed (exit ${check.code})\n${tail(log)}`,
                pass ? 'gate: pass' : 'gate: fail - this apply would be undone',
            ].join('\n'),
        );
    }
    if (!pass) {
        throw new CliError(
            over.length > 0 ? 'over the limits' : 'zen check failed',
            EXIT.failed,
            over.length > 0 ? 'cut, move or extract, then run gate again' : undefined,
        );
    }
}

const tail = (log: string): string =>
    existsSync(log) ? readFileSync(log, 'utf8').trimEnd().split('\n').slice(-30).join('\n') : '';

/** `zen check` once, its output to `log` - not the loop's spawn, which records its children. */
function checkOnce(root: string): Zen {
    return async (args, log) => {
        const fd = openSync(log, 'w');
        try {
            const res = spawnSync(process.execPath, [process.argv[1], ...args], {
                cwd: root,
                stdio: ['ignore', fd, fd],
            });
            return { code: res.status ?? 1, stdout: '' };
        } finally {
            closeSync(fd);
        }
    };
}
