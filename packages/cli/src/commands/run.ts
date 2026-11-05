import * as Projects from '@zenera/engine';
import { display, PODMAN_PROVIDER } from '@zenera/engine';
import type { AgentEvent, Input, RunIdentity } from '@zenera/neo';
import { identityFromEnv, usageByModel } from '@zenera/neo';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from '../args.ts';
import { concurrency, runBatch } from '../batch.ts';
import type { Command, Context } from '../command.ts';
import * as Engine from '../engine.ts';
import { agentEventLog } from '../eventlog.ts';
import { duration, Narrator, stopMark, summary } from '../narrate.ts';
import { readBatch, readRequest } from '../request.ts';
import { target, type Target } from '../resolve.ts';
import {
    bold,
    cyan,
    dim,
    drivenByAgent,
    json,
    jsonText,
    note,
    readStdin,
    usageError,
    write,
} from '../term.ts';
import { parseChoice } from '../tui/theme.ts';
import { appendUsage } from '../usage.ts';

const USAGE = 'zen run [project] [prompt] [options]';

interface Flags {
    project?: string;
    session?: string;
    new?: boolean;
    input?: string;
    workspace?: string;
    here?: boolean;
    memory?: string;
    'memory-read-only'?: boolean;
    model?: string;
    image?: string;
    'no-keys'?: boolean;
    podman?: boolean;
    as?: string;
    'read-only'?: boolean;
    yes?: boolean;
    plain?: boolean;
    theme?: string;
    out?: string;
    events?: string;
    disposable?: boolean;
    'batch-dir'?: string;
    concurrency?: string;
}

export const run: Command = {
    summary: 'Run the project — the TUI on a terminal, one shot otherwise.',
    usage: USAGE,
    banner: { head: 'Zenera', accent: 'Neo', subtitle: 'Agentic Runtime', hue: 'orange' },
    // A batch prints the path of its directory, and a banner above a path is a
    // banner inside `$(zen run batch ...)`. True whether or not --json is on.
    quiet: (args) => args[0] === 'batch',
    details: [
        'Arguments:',
        '  [project]   Name of a project. Default: the one you are in.',
        '  [prompt]    Your question, in quotes. Without one, the TUI opens.',
        '  batch       Run a file full of questions at once. See below.',
        '',
        'Options:',
        '  --project <name|dir>   Which project to run. Default: the one you are in.',
        '  --session <id>         Continue this session.',
        '  --new                  Start a new session without asking which one.',
        '  --input <file>         Read the whole request from JSON. `-` is stdin.',
        '  --workspace <dir>      Directory the agent can read and write.',
        '                         Default: a fresh one inside the new session.',
        '  --here                 Same as --workspace with the directory you are in.',
        '  --memory <dir>         Directory the agents remember into.',
        '  --memory-read-only     Recall from it, write nothing back.',
        '  --model <ref>          Use this model instead of the default.',
        '  --image <ref>          Use this container image to run commands in.',
        '  --read-only            Take away every tool that can write.',
        '  --no-keys              Do not pass API keys into the container.',
        '  --podman               Run commands in podman on this machine, even when a',
        '                         plugin in $ZEN_PLUGINS provides the sandbox.',
        '  --as <user>            Act for this user: what `current_user` answers and $ZEN_USER_ID',
        '                         holds. An email also sets $ZEN_USER_EMAIL. For trying',
        '                         a project; the Zenera app passes the signed-in user.',
        '  --plain                Never open the TUI. Needs a prompt.',
        '  --theme <dark|light>   Colours for the TUI. Default: auto.',
        '  --out <file>           Put the answer in this file instead of on screen.',
        '                         With --json, the file gets the whole JSON envelope.',
        '  --events <file>        Append what the agent does to this file as it does it:',
        '                         one JSON line per model call, tool call and message.',
        '  --disposable           Remove its containers when it ends, whatever `persist:`',
        '                         says: for a session that will never be continued.',
        '  --yes                  Answer yes to every question.',
        '  --json                 Print machine-readable JSON (session, run, mounts, output, etc...).',
        '',
        'Batch options:',
        '  --batch-dir <dir>      Where the runs live. Default: <project>/batches/<stamp>.',
        '  --concurrency <n>      How many at a time. Default: 16, most: 32.',
        '',
        'The first word is the project when it names one, otherwise the prompt.',
        'The answer goes to stdout and the progress to stderr, so `> out.md` keeps',
        'the answer alone and `2>/dev/null` hides the progress.',
        '',
        'A prompt always starts a new session, so --new is for the TUI, where the',
        'alternative is being asked which session to continue. Its workspace is a',
        'fresh, empty directory inside that session; to ask about the files where',
        'you are, say --here.',
        '',
        '--input names a file holding the whole request - project, input, workspace,',
        'memory - and what it says wins over the same flag on the line. Its paths are',
        'relative to the file, so a case travels with the images beside it. It is the',
        'way to ask about a picture, and it never opens the TUI:',
        '',
        '  { "input": [{ "text": "what is this?" }, { "image": "./shot.png" }] }',
        '',
        '`zen run batch --input cases.json` asks a whole file of them at once. The',
        'file is the same shape, pluralised, and nothing else is allowed in it:',
        '',
        '  { "batch": [{ "id": "vat", "input": "what is VAT?" }, { "input": "..." }] }',
        '',
        'Every item is its own session, in its own directory under the batch dir:',
        '',
        '  <batch-dir>/<id>/workspace/     what that item could read and write',
        '  <batch-dir>/<id>/memory/        its own copy, in the copying mode',
        '  <batch-dir>/<id>/output.json    exactly what `zen run --json` prints',
        '  <batch-dir>/batch.json          the index: every item, ok, and its file',
        '  <batch-dir>/README.md           a dashboard, rewritten every second',
        '',
        'Memory comes in two modes, because a memory is a locked directory and',
        'sixteen runs cannot hold one lock. With --memory-read-only they all recall',
        'from the one graph and write nothing. Without it, each gets a copy, and the',
        "project's own memory is never touched - fold them back in afterwards with",
        '`zen memory merge <batch-dir>/*/memory`. An item that committed nothing',
        'leaves no memory behind, and a --memory that does not exist yet starts every',
        'item from an empty graph - which is how a cold project is warmed.',
        '',
        'A batch prints the path of its directory and nothing else; --json prints',
        'the index there instead. An item that fails is written down like any other',
        'and the exit code says how many did, so one bad question costs one answer.',
        'For a project or a prompt actually called "batch", say --project batch.',
        '',
        'Examples:',
        '  zen run                               open the TUI in this project',
        '  zen run acme                          open the TUI in the acme project',
        '  zen run "what changed?"               ask that, print the answer, exit',
        '  zen run --here "what changed?"        ... about the files in this directory',
        '  git diff | zen run                    take the prompt from stdin',
        '  zen run "what changed?" > out.md      redirect the answer into a file',
        '  zen run --out out.md "what changed?"  write the answer to out.md only',
        '  zen run --json "what changed?"        output JSON with workspace, run paths, state, etc...',
        '  zen run --input case.json --json      run a request from a file, answer as JSON',
        '  zen run --input case.json --json --out result.json    ... into a file',
        '  zen run --read-only "what changed?"   let it read but not write',
        '  zen run --memory ./mem                remember into ./mem, not the project',
        '  zen run --new                         open the TUI in a new session',
        '  zen run batch --input cases.json      ask them all, 16 at a time',
        '  zen run batch --input cases.json --memory-read-only    ... sharing one memory',
        '  zen run batch --input cases.json --json | jq .batch_results',
    ],
    run: async (ctx) => {
        const { values, positionals } = parse<Flags>(
            ctx.args,
            {
                project: { type: 'string' },
                session: { type: 'string' },
                new: { type: 'boolean' },
                input: { type: 'string' },
                workspace: { type: 'string' },
                here: { type: 'boolean' },
                memory: { type: 'string' },
                'memory-read-only': { type: 'boolean' },
                model: { type: 'string' },
                image: { type: 'string' },
                'no-keys': { type: 'boolean' },
                podman: { type: 'boolean' },
                as: { type: 'string' },
                'read-only': { type: 'boolean' },
                yes: { type: 'boolean' },
                plain: { type: 'boolean' },
                theme: { type: 'string' },
                out: { type: 'string' },
                events: { type: 'string' },
                disposable: { type: 'boolean' },
                'batch-dir': { type: 'string' },
                concurrency: { type: 'string' },
            },
            USAGE,
        );

        const piped = await readStdin();

        // Before the first positional is read as a project name, because in a
        // batch it is not one and `batch` is not a prompt either.
        if (positionals[0] === 'batch') {
            await batch(ctx, values, positionals.slice(1), piped);
            return;
        }

        // `zen run acme` is what everyone types before finding --project, and a
        // project name is a bare word where a prompt is a sentence. So the
        // first positional is read as a project when it names one and as the
        // first word of the prompt when it does not — which also makes
        // `zen run acme "what changed?"` mean what it looks like. --project is
        // there for the day a project is called "why".
        const [head, ...rest] = positionals;
        const named = !values.project && head ? await Projects.find(head) : undefined;
        const typed = (named ? rest : positionals).join(' ').trim();

        if (values.input && typed) {
            throw usageError(
                'a prompt and --input both say what to ask',
                'put the prompt in the file, or drop --input',
            );
        }
        if (values.theme !== undefined && !parseChoice(values.theme)) {
            throw usageError(`unknown theme: ${values.theme}`, 'dark, light or auto');
        }
        if (values.here && values.workspace !== undefined) {
            throw usageError('--here and --workspace both name the workspace', 'keep one');
        }

        // With `--input -` the pipe carries the request, not the prompt, so it
        // is read here and never looked at again below.
        const request = values.input ? await readRequest(values.input, ctx.cwd, piped) : undefined;
        const prompt = typed || (request ? '' : (piped ?? ''));

        // A prompt on the command line is a request for an answer, not a
        // conversation to pick up. So it answers the three questions itself:
        // a fresh session, a fresh directory inside it as the workspace, and
        // no confirmation for any of it. Reading the files where it was typed
        // takes --here: an agent that can write should not land in whatever
        // directory the shell happened to be in. Every flag still wins, and
        // the TUI, where there is someone to ask, still asks.
        const input = request ? request.input : prompt;
        const shot = Boolean(prompt) || Boolean(request);
        if (values.events && !shot) {
            throw usageError('--events records a one-shot run', 'give a prompt or --input');
        }

        const where = await target({
            cwd: ctx.cwd,
            project: request?.project ?? values.project ?? (named ? head : undefined),
            session: values.session,
            fresh: values.new || (shot && !values.session),
            workspace:
                request?.workspace ?? values.workspace ?? (values.here ? ctx.cwd : undefined),
            ask: !shot,
            yes: values.yes || shot,
        });

        const engine = await Engine.open({
            project: where.project,
            session: where.session,
            readOnly: values['read-only'],
            model: values.model,
            image: values.image,
            // Relative to where it was typed, like every other path on the line
            // — the project root is not the cwd. A request's paths are already
            // absolute, resolved against the file rather than against this.
            memoryDir:
                request?.memory ?? (values.memory ? resolve(ctx.cwd, values.memory) : undefined),
            memoryReadOnly: values['memory-read-only'],
            keys: values['no-keys'] ? false : undefined,
            sandboxPlugins: values.podman ? false : undefined,
            user: asUser(values.as),
            yes: values.yes || ctx.json,
            disposable: values.disposable,
        });

        try {
            // The TUI is for the case it is actually good at: a person at a
            // terminal, with nothing to say yet. A prompt on the command line
            // is a request for an answer, and drawing a full-screen interface
            // over it would be worse than not drawing one.
            const drawing =
                !shot &&
                !values.plain &&
                !ctx.json &&
                Boolean(process.stdout.isTTY && process.stdin.isTTY) &&
                !drivenByAgent();

            if (drawing) {
                const { start } = await import('../tui/app.tsx');
                await start(engine, {
                    readOnly: Boolean(values['read-only']),
                    theme: values.theme,
                    started: { created: where.created, freshWorkspace: where.freshWorkspace },
                });
                return;
            }

            if (!shot) {
                throw usageError('nothing to ask', 'give a prompt, or pipe one in');
            }
            await once(engine, input, values, ctx.json, ctx.cwd, where);
        } finally {
            await engine.close();
        }
    },
};

// ---------------------------------------------------------------------------
// Many shots
// ---------------------------------------------------------------------------

/**
 * `--as`, as the identity a run acts for. Always `local` — saying who you are
 * on your own machine is a test, not a login. The other fields still come from
 * `ZEN_USER_*` when exported, so `ZEN_USER_ROLE=viewer zen run --as ann` tries
 * a role too. Unset, the engine reads the environment by itself.
 */
function asUser(as: string | undefined): RunIdentity | undefined {
    if (as === undefined) {
        return undefined;
    }
    const id = as.trim();
    if (!id) {
        throw usageError('--as needs a user', 'an id or an email, e.g. --as ann@example.com');
    }
    const env = identityFromEnv({ ...process.env, ZEN_USER_ID: id });
    return {
        ...env,
        id,
        email: env?.email ?? (id.includes('@') ? id : undefined),
        source: 'local',
    };
}

// ---------------------------------------------------------------------------
// Many shots
// ---------------------------------------------------------------------------

/**
 * Flags that mean something to one run and nothing to a hundred. Refused by
 * name rather than ignored: a `--workspace` that was quietly dropped is a batch
 * whose answers came from somewhere else.
 */
const NOT_IN_A_BATCH: [keyof Flags, string][] = [
    ['session', 'every item is a new session of its own'],
    ['new', 'every item is new already'],
    ['workspace', 'they cannot share one; each item gets its own, or names one in the file'],
    ['here', 'they cannot share one; each item gets its own, or names one in the file'],
    ['plain', 'a batch never draws the TUI'],
    ['theme', 'a batch never draws the TUI'],
    ['events', 'each item already has its own output.json'],
    ['disposable', 'a batch removes its containers already'],
];

async function batch(
    ctx: Context,
    values: Flags,
    rest: readonly string[],
    piped?: string,
): Promise<void> {
    if (rest.length > 0) {
        throw usageError(
            `zen run batch: nothing goes after "batch" (got "${rest[0]}")`,
            'the questions live in the file named by --input',
        );
    }
    for (const [flag, why] of NOT_IN_A_BATCH) {
        if (values[flag] !== undefined && values[flag] !== false) {
            throw usageError(`--${flag} means nothing in a batch`, why);
        }
    }
    if (!values.input) {
        throw usageError('zen run batch needs --input <file>', 'a JSON file holding the batch');
    }

    await runBatch({
        request: await readBatch(values.input, ctx.cwd, piped),
        input: values.input === '-' ? '<stdin>' : resolve(ctx.cwd, values.input),
        dir: values['batch-dir'],
        cwd: ctx.cwd,
        project: values.project,
        memory: values.memory ? resolve(ctx.cwd, values.memory) : undefined,
        memoryReadOnly: values['memory-read-only'],
        concurrency: concurrency(values.concurrency),
        model: values.model,
        image: values.image,
        readOnly: values['read-only'],
        keys: values['no-keys'] ? false : undefined,
        sandboxPlugins: values.podman ? false : undefined,
        user: asUser(values.as),
        yes: values.yes,
        out: values.out,
        json: ctx.json,
    });
}

// ---------------------------------------------------------------------------
// One shot
// ---------------------------------------------------------------------------

async function once(
    engine: Engine.Engine,
    input: Input,
    values: Flags,
    asJson: boolean,
    cwd: string,
    where: Target,
): Promise<void> {
    const narrator = new Narrator({
        quiet: asJson,
        live: Boolean(process.stderr.isTTY),
    });
    const record = values.events ? agentEventLog(resolve(cwd, values.events)) : undefined;
    const onEvent = (event: AgentEvent): void => {
        narrator.handle(event);
        record?.(event);
    };

    // Ctrl-C asks the run to stop rather than killing the process, so the turn
    // still lands on disk and the session stays resumable. SIGTERM too: it is
    // how a tuning stops a run it left behind, and its containers go with it.
    const stopping = new AbortController();
    const onInterrupt = (): void => stopping.abort();
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onInterrupt);

    if (!asJson) {
        // Two questions were just answered, possibly without being asked. Say
        // which way they went: a run that quietly resumed the wrong session, or
        // wrote into the directory you were standing in, is only explainable
        // afterwards, and this is the one line where it is cheap to say.
        note(
            `${bold(engine.name)} ${dim(where.created ? 'new session' : 'continuing')} ` +
                `${dim(engine.session.id)}`,
        );
        note(
            dim(
                `${where.freshWorkspace ? 'new directory' : 'workspace'} ` +
                    `${display(engine.workspace, cwd)}`,
            ),
        );
        // Only when it is not the default, which is the one case worth a line:
        // a plugin moved the commands, and the files with them, elsewhere.
        if (engine.sandbox.provider !== PODMAN_PROVIDER) {
            note(dim(`sandbox ${engine.sandbox.provider}`));
        }
    }

    let outcome: Engine.RunOutcome;
    try {
        outcome = await Engine.run(engine, input, onEvent, stopping.signal);
    } finally {
        narrator.done();
        process.off('SIGINT', onInterrupt);
        process.off('SIGTERM', onInterrupt);
    }
    appendUsage(where.project.dir, {
        kind: 'run',
        ts: new Date().toISOString(),
        runDir: outcome.run.dir,
        session: engine.session.id,
        ok: true,
        stopReason: outcome.result.stopReason,
        durationMs: outcome.durationMs,
        models: usageByModel(outcome.result.state.trajectory),
    });

    if (asJson) {
        // --out is a destination, not a copy, and with --json the answer *is*
        // the envelope — so that is what lands in the file, not the prose.
        const body = Engine.envelope(engine, outcome);
        if (values.out) {
            await writeFile(values.out, jsonText(body), 'utf8');
        } else {
            json(body);
        }
        return;
    }

    // The same rule for prose: the answer goes to the file instead of to
    // stdout, so a redirect and a file cannot both end up holding it.
    if (values.out) {
        await writeFile(values.out, `${outcome.text}\n`, 'utf8');
        note(dim(`answer: ${cyan(values.out)}`));
    } else {
        write(outcome.text);
    }

    note('');
    note(
        `${stopMark(outcome.result.stopReason)} ${dim(duration(outcome.durationMs))}  ` +
            dim(summary(outcome.result.usage)),
    );
    if (outcome.report) {
        note(dim(`report: ${cyan(display(outcome.report, cwd))}`));
    }
}
