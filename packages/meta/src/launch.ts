import { spawn as nodeSpawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { cut, dim, duration, formatInline, plain } from './host.ts';
import { FRAME_MS, windowSink, type Sink } from './window.ts';

// ---------------------------------------------------------------------------
// The meta agent
//
// `zen meta` drives GitHub Copilot CLI over a zen project: same project, same
// keys, same conventions about what is an answer and what is narration. The
// two vocabularies meet here and nowhere else — a zen model ref and a zen key
// entry go in, copilot's `COPILOT_*` environment comes out — so there is one
// place to correct when either side moves.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The binary
// ---------------------------------------------------------------------------

export interface Binary {
    command: string;
    args: string[];
    from: 'path' | 'npx';
}

/**
 * A `copilot` already installed is used as it is; otherwise `npx` fetches one.
 * Note that finding the name on `PATH` is not the same as finding the CLI —
 * an editor may have put a shim there that installs it on first run — so this
 * only decides how to launch, never whether it will work.
 */
export function locate(has = (cmd: string): boolean => onPath(cmd)): Binary {
    return has('copilot')
        ? { command: 'copilot', args: [], from: 'path' }
        : { command: 'npx', args: ['--yes', '@github/copilot'], from: 'npx' };
}

function onPath(cmd: string): boolean {
    const dirs = (process.env.PATH ?? '').split(':').filter(Boolean);
    return dirs.some((d) => existsSync(`${d}/${cmd}`));
}

// ---------------------------------------------------------------------------
// Output
//
// Copilot's JSONL is a transcript, not an answer: tool calls, reasoning, model
// bookkeeping, and — among them — the message it finished with. Re-rendering
// it is what keeps zen's one rule true, that stdout is the answer and stderr
// is the story of getting there, so `zen meta run … > out.md` holds the answer
// alone the same way `zen run` does.
// ---------------------------------------------------------------------------

interface Event {
    type: string;
    data?: Record<string, unknown>;
    [key: string]: unknown;
}

export interface Outcome {
    /** the last thing the agent said that was not a preamble to a tool call */
    answer: string;
    exitCode: number;
    sessionId?: string;
    usage?: Record<string, unknown>;
    events: Event[];
}

// ---------------------------------------------------------------------------
// The log
//
// The window shows the last few steps and the answer goes to stdout, so the
// middle of a long run is gone by the time anyone wants it. The log is the
// whole of it — prompt, every step, the answer — written as it happens, so a
// second terminal can `tail -f` a run that is still going.
// ---------------------------------------------------------------------------

export interface Log {
    readonly path: string;
    /** Where the answer alone goes, beside the log and openable on its own. */
    readonly answerPath: string;
    line(text: string): void;
    saveAnswer(text: string): void;
    close(): void;
}

/**
 * `<project>/.tmp/logs/meta.<when>[-<session>].log`, opened for append. The
 * session keeps runs started in the same second - a tuning loop's - apart.
 */
export function openLog(dir: string, now = new Date(), session?: string): Log {
    const two = (n: number): string => String(n).padStart(2, '0');
    const stamp =
        `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}` +
        `${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}` +
        (session ? `-${session.slice(0, 8)}` : '');
    const folder = `${dir}/.tmp/logs`;
    mkdirSync(folder, { recursive: true });
    const path = `${folder}/meta.${stamp}.log`;
    const answerPath = `${folder}/meta.${stamp}.md`;
    const file = createWriteStream(path, { flags: 'a' });
    return {
        path,
        answerPath,
        line: (text) => {
            file.write(`${plain(text)}\n`);
        },
        saveAnswer: (text) => {
            writeFileSync(answerPath, text.endsWith('\n') ? text : `${text}\n`);
        },
        close: () => {
            file.end();
        },
    };
}

/** The project's last meta session, so `zen meta resume` needs no id. */
function sessionFile(dir: string): string {
    return `${dir}/.tmp/logs/meta.session`;
}

export function recordSession(dir: string, id: string): void {
    mkdirSync(`${dir}/.tmp/logs`, { recursive: true });
    writeFileSync(sessionFile(dir), `${id}\n`);
}

export function lastSession(dir: string): string | undefined {
    try {
        return readFileSync(sessionFile(dir), 'utf8').trim() || undefined;
    } catch {
        return undefined;
    }
}

/** Everything the sink is told, kept by the log too — and the detail only there. */
function tee(sink: Sink, log: Log): Sink {
    return {
        answer: (text) => sink.answer(text),
        narrate: (line) => {
            log.line(line);
            sink.narrate(line);
        },
        detail: (line) => log.line(line),
        warn: (line) => {
            log.line(line);
            sink.warn(line);
        },
        status: (line) => sink.status?.(line),
        close: () => sink.close?.(),
    };
}

/**
 * Folds one event into the outcome and says what, if anything, to show for it.
 *
 * `assistant.message` carries both the running commentary and the final word;
 * what separates them is `toolRequests`, so the last message that asked for no
 * tool is the answer and the rest are narration.
 */
export function absorb(event: Event, out: Outcome, sink: Sink, width: number): void {
    const data = (event.data ?? {}) as Record<string, unknown>;
    switch (event.type) {
        case 'assistant.message': {
            const content = String(data.content ?? '').trim();
            const requests = Array.isArray(data.toolRequests) ? data.toolRequests : [];
            if (requests.length === 0) {
                out.answer = content;
            } else if (content) {
                sink.narrate(cut(formatInline(content.replace(/\s+/g, ' ')), width));
            }
            break;
        }
        case 'tool.execution_start': {
            const args = (data.arguments ?? {}) as Record<string, unknown>;
            const what = String(args.command ?? args.description ?? data.toolName ?? '').trim();
            // Step-by-step belongs in the log: on screen it is a wall of `$`
            // saying less than the one line of commentary above it.
            sink.detail?.(`$ ${what.replace(/\s+/g, ' ')}`);
            break;
        }
        case 'tool.execution_complete': {
            if (data.success === false) {
                sink.detail?.(`  ${String(data.toolName ?? 'the tool')} failed`);
            }
            break;
        }
        case 'session.tools_updated': {
            if (data.model) {
                sink.detail?.(`model ${String(data.model)}`);
            }
            break;
        }
        case 'session.error': {
            sink.warn(String(data.message ?? 'the session failed'));
            break;
        }
        case 'model.call_failure': {
            const status = data.statusCode ? ` (${String(data.statusCode)})` : '';
            sink.warn(
                `${cut(String(data.errorMessage ?? 'the model call failed'), width)}${status}`,
            );
            break;
        }
        case 'result': {
            out.exitCode = Number(event.exitCode ?? 0);
            out.sessionId = event.sessionId as string | undefined;
            out.usage = event.usage as Record<string, unknown> | undefined;
            break;
        }
        default:
            break;
    }
    out.events.push(event);
}

// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------

export interface Launch {
    binary: Binary;
    args: string[];
    env: Record<string, string>;
    cwd: string;
    sink?: Sink;
    log?: Log;
    width?: number;
    /** said after the elapsed time on the status row, e.g. the tokens so far */
    status?: () => string;
    /** every event copilot prints, before it is folded */
    onEvent?: (event: Event) => void;
    /** injected by the tests, which have no copilot and want none */
    spawn?: typeof nodeSpawn;
}

export async function launch(opts: Launch): Promise<Outcome> {
    const shown = opts.sink ?? windowSink();
    const sink = opts.log ? tee(shown, opts.log) : shown;
    // Without a terminal nothing wraps, and a cut line is lost from the log too.
    const width =
        opts.width ??
        (process.stderr.isTTY ? Math.max(40, (process.stderr.columns ?? 100) - 4) : Infinity);
    const start = opts.spawn ?? nodeSpawn;
    const out: Outcome = { answer: '', exitCode: 0, events: [] };

    const child = start(opts.binary.command, [...opts.binary.args, ...opts.args], {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
    });

    const stop = (signal: NodeJS.Signals) => (): void => {
        child.kill(signal);
    };
    const onInt = stop('SIGINT');
    const onTerm = stop('SIGTERM');
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);

    // The first model call says nothing for as long as it takes, and silence
    // after the model line is indistinguishable from a hang.
    const began = Date.now();
    const beat = setInterval(() => {
        const extra = opts.status?.();
        sink.status?.(`working: ${duration(Date.now() - began)}${extra ? ` · ${extra}` : ''}`);
    }, FRAME_MS);
    beat.unref();

    child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trimEnd();
        if (text) {
            sink.narrate(dim(text));
        }
    });

    try {
        const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
        for await (const line of lines) {
            if (!line.trim()) {
                continue;
            }
            let event: Event;
            try {
                event = JSON.parse(line) as Event;
            } catch {
                // Not ours to interpret, but losing it is worse than showing it.
                sink.narrate(line);
                continue;
            }
            opts.onEvent?.(event);
            absorb(event, out, sink, width);
        }
        const code = await new Promise<number>((resolve) => {
            child.on('close', (value, signal) => resolve(value ?? (signal ? 1 : 0)));
        });
        if (out.exitCode === 0 && code !== 0) {
            out.exitCode = code;
        }
    } finally {
        clearInterval(beat);
        process.off('SIGINT', onInt);
        process.off('SIGTERM', onTerm);
        // The answer is written by the caller, so the window has to be gone first.
        sink.close?.();
    }
    return out;
}

// ---------------------------------------------------------------------------
// Resuming
//
// Copilot retries a failed model call itself, five times over about a minute,
// and has no setting to change that. A run that outlasts it is still a session
// on disk, so the retry happens one level up: wait, then resume that session.
// ---------------------------------------------------------------------------

/** Resumes after copilot's own retries run out; `--retries` overrides. */
export const DEFAULT_RESUMES = 5;

/** The first wait; it doubles per resume, up to `RESUME_MAX_MS`. */
const RESUME_INITIAL_MS = 30_000;
const RESUME_MAX_MS = 300_000;

/** What the resumed session is told, since `-p` has to say something. */
export const RESUME_PROMPT =
    'The previous model call failed. Continue the task from where you stopped.';

export function resumeDelayMs(attempt: number): number {
    return Math.min(RESUME_INITIAL_MS * 2 ** attempt, RESUME_MAX_MS);
}

/**
 * Why the run is worth resuming, or undefined when waiting cannot help.
 *
 * Only a refusal that time can cure counts: a rate limit, the provider's own
 * failure, a connection that timed out. A 400 or a bad key fails the same way
 * however often it is sent - except the one below.
 */
export function transient(out: Outcome): string | undefined {
    if (out.exitCode === 0 || !out.sessionId) {
        return undefined;
    }
    const at = out.events.findLastIndex((e) => e.type === 'session.error');
    const data = out.events[at]?.data;
    if (!data) {
        return undefined;
    }
    const status = Number(data.statusCode ?? 0);
    if (data.errorType === 'rate_limit' || status === 429) {
        return 'rate-limited (429)';
    }
    if (status === 408 || status >= 500) {
        return `the provider failed (${status})`;
    }
    if (/timed out|ECONNRESET|socket hang up/i.test(String(data.message ?? ''))) {
        return 'the connection failed';
    }
    if (status === 400 && injected(out.events.slice(0, at))) {
        return 'refused a tool call copilot made itself (400)';
    }
    return undefined;
}

/**
 * Whether the turn that failed began with a tool call copilot wrote, not the
 * model. When a background command finishes, copilot adds a `read_bash` of its
 * own; Gemini 3 rejects any tool call in the current turn that lacks its thought
 * signature, so that request is a 400 every time. A new user message - the
 * resume - starts a turn that no longer holds it.
 */
function injected(before: Event[]): boolean {
    for (let i = before.length - 1; i >= 0; i--) {
        const event = before[i];
        if (event.type === 'system.notification') {
            return true;
        }
        if (event.type === 'user.message') {
            return false;
        }
        if (event.type === 'assistant.message') {
            if (event.data?.model) {
                return false;
            }
            const requests = event.data?.toolRequests;
            if (Array.isArray(requests) && requests.length > 0) {
                return true;
            }
        }
    }
    return false;
}
