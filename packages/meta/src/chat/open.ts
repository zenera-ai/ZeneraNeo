// packages/meta/src/chat/open.ts
//
// A `zen meta chat` session with no screen: what the chat sets up before it draws (editor refresh, model and key,
// log, Vertex relay, ledger) and, on `close`, what it records after (the session's usage, the token line).
// Main: `openMetaChat(opts)` -> `MetaChat` (`send`, `abort`, `close`, `tokens`).
// Used by: `chat/run.ts` (the terminal chat) and, through the `@zenera/meta/chat` export, hosts that draw their
// own chat - the ZeneraLite web editor.

import type { SessionEvent } from '@github/copilot-sdk';
import type * as Projects from '@zenera/engine';
import { randomUUID } from 'node:crypto';
import {
    appendUsage,
    copilotEventLog,
    dim,
    LEDGER_ENV,
    ledgerPath,
    META_SESSION_ENV,
    note,
    resolveProject,
} from '../host.ts';
import {
    absorb,
    DEFAULT_RESUMES,
    lastSession,
    openLog,
    recordSession,
    type Outcome,
} from '../launch.ts';
import { SOURCE_LABELS } from '../model.ts';
import { announce, prepare, refreshEditor, type Selection } from '../prepare.ts';
import { startVertexRelay } from '../relay.ts';
import { usageReporter } from '../reporter.ts';
import type { Sink } from '../sink.ts';
import { sessionTotals, Tally } from '../tokens.ts';
import { permissionPolicy, type Answer, type Described } from './permissions.ts';
import {
    googleToken,
    openChat,
    providerConfig,
    runtimeEnv,
    type Chat,
    type ChatEvent,
    type Connect,
    type TurnResult,
} from './session.ts';

export interface MetaChatOptions extends Selection {
    /** the project, or a directory inside one */
    project: Projects.Project | string;
    /** a `.github/agents/<name>.agent.md` */
    agent?: string;
    effort?: string;
    /** every tool, whatever `allowTool` and `ask` say */
    allowAll?: boolean;
    /** `--allow-tool`'s list: read, shell(git:*), write(README.md) */
    allowTool?: string;
    /** ask `prompt` about any tool `allowTool` leaves out */
    ask?: boolean;
    prompt?: (request: Described) => Promise<Answer>;
    addDirs?: readonly string[];
    /** an absolute path for `--events`' JSONL */
    events?: string;
    /** resumes after a failure time can cure, per turn; default `DEFAULT_RESUMES` */
    retries?: number;
    /** rewrite the editor files first, as `zen open` does; default true */
    refresh?: boolean;
    onEvent: (event: ChatEvent) => void;
    /** every SDK event, before it is narrated */
    onRaw?: (event: SessionEvent) => void;
    /** stands in for the SDK in tests */
    connect?: Connect;
}

export interface MetaChat extends Chat {
    readonly project: Projects.Project;
    /** the model as wired */
    readonly model: string;
    /** the provider whose key it runs on */
    readonly owner: string;
    readonly resumed: boolean;
    readonly logPath: string;
    /** `shown` is what the person typed, when `prompt` is the command it expanded to */
    send(prompt: string, shown?: string): Promise<TurnResult>;
    /** the token line so far; empty before the first model call */
    tokens(): string;
}

export async function openMetaChat(opts: MetaChatOptions): Promise<MetaChat> {
    const project =
        typeof opts.project === 'string'
            ? await resolveProject({ cwd: opts.project })
            : opts.project;
    if (opts.refresh !== false) {
        refreshEditor(project);
    }
    let resume = opts.resume;
    if (opts.continue && !resume) {
        resume = lastSession(project.dir);
        if (!resume) {
            note(dim(`no meta session recorded in ${project.name} - starting a new one`));
        }
    }
    if (resume) {
        note(dim(`resuming session ${resume}`));
    }

    const prepared = await prepare(
        {
            provider: opts.provider,
            model: opts.model,
            resume,
            'session-id': opts['session-id'],
        },
        project,
    );
    const { values, wiring, chosen } = prepared;
    const resumed = Boolean(values.resume);
    const session = prepared.session ?? randomUUID();
    announce(prepared, project);

    recordSession(project.dir, session);
    const log = openLog(project.dir, new Date(), session);
    note(`log  ${log.path}`);
    log.line(`zen meta chat ${new Date().toISOString()}`);
    log.line(`project ${project.name} ${project.dir}`);
    log.line(`model   ${chosen.ref} from ${SOURCE_LABELS[chosen.from]}`);
    log.line(`session ${session}${resumed ? ' (resumed)' : ''}`);

    const relay = wiring.relay ? await startVertexRelay(wiring.relay) : undefined;
    if (relay) {
        wiring.env.COPILOT_PROVIDER_BASE_URL = relay.url;
        log.line(`relay   ${relay.url} -> vertex rawPredict`);
    }

    // As with `run`: every zen command the agent runs lands in the same ledger, tagged with this session.
    const ledger = ledgerPath(project.dir);
    const env: Record<string, string> = {
        ...runtimeEnv(wiring.env),
        ...(ledger ? { [LEDGER_ENV]: ledger } : {}),
        [META_SESSION_ENV]: session,
    };
    const tally = new Tally();
    const record = opts.events ? copilotEventLog(opts.events) : undefined;
    const reporter = usageReporter(project.dir);

    // The log keeps what `run`'s log keeps, through the same folding.
    const logSink: Sink = {
        answer: () => undefined,
        narrate: (line) => log.line(line),
        detail: (line) => log.line(line),
        warn: (line) => log.line(`! ${line}`),
    };
    const folded: Outcome = { answer: '', exitCode: 0, events: [] };

    // Paths inside the project read better from where the agent stands.
    const relative = (text: string): string => text.replaceAll(`${project.dir}/`, '');
    const decide = permissionPolicy({
        allowAll: opts.allowAll,
        ask: opts.ask,
        allowTool: opts.allowTool,
        prompt: (request) =>
            opts.prompt?.({ ...request, subject: relative(request.subject) }) ??
            Promise.resolve('no'),
    });

    const startedAt = new Date();
    const release = async (): Promise<void> => {
        reporter.stop();
        await relay?.close();
        await log.close();
    };

    let chat: Chat;
    try {
        chat = await openChat({
            dir: project.dir,
            model: wiring.env.COPILOT_MODEL ?? wiring.model,
            provider: providerConfig(
                wiring.env,
                wiring.keyFile ? googleToken(wiring.keyFile) : undefined,
            ),
            env,
            sessionId: session,
            resume: resumed,
            agent: opts.agent,
            effort: opts.effort,
            addDirs: opts.addDirs,
            decide,
            retries: opts.retries ?? DEFAULT_RESUMES,
            connect: opts.connect,
            onRaw: (event) => {
                opts.onRaw?.(event);
                // The log helpers take copilot's JSONL shape, which an SDK event already is.
                const line = event as unknown as Outcome['events'][number];
                record?.event(line);
                folded.events.length = 0;
                absorb(line, folded, logSink, Infinity);
            },
            onEvent: (event) => {
                if (event.type === 'usage') {
                    tally.add(event.call);
                    record?.call(event.call);
                    appendUsage(project.dir, {
                        kind: 'meta.call',
                        ts: new Date(
                            Date.parse(event.call.startedAt) + event.call.durationMs,
                        ).toISOString(),
                        ...event.call,
                    });
                } else if (event.type === 'message' && event.tools === 0 && event.text.trim()) {
                    log.line('');
                    log.line('--- answer ---');
                    log.line(event.text.trim());
                    log.saveAnswer(event.text.trim());
                } else if (event.type === 'retry') {
                    log.line(`--- resume ${event.attempt}: ${event.reason} ---`);
                } else if (event.type === 'tool') {
                    event = { ...event, subject: relative(event.subject) };
                }
                opts.onEvent(event);
            },
        });
    } catch (err) {
        await release();
        throw err;
    }

    let closing: Promise<void> | undefined;
    return {
        sessionId: chat.sessionId,
        project,
        model: wiring.model,
        owner: prepared.owner,
        resumed,
        logPath: log.path,
        tokens: () => (tally.calls > 0 ? tally.toString() : ''),
        send: (prompt, shown = prompt) => {
            log.line('');
            log.line(`--- you: ${shown.split('\n')[0]} ---`);
            if (prompt !== shown) {
                log.line(prompt);
            }
            return chat.send(prompt);
        },
        abort: () => chat.abort(),
        close: () =>
            (closing ??= (async () => {
                await chat.close();
                const models = sessionTotals(session);
                if (models) {
                    appendUsage(project.dir, {
                        kind: 'meta.session',
                        ts: new Date().toISOString(),
                        session,
                        models,
                        exitCode: 0,
                        resumes: 0,
                        startedAt: startedAt.toISOString(),
                        durationMs: Date.now() - startedAt.getTime(),
                    });
                }
                if (tally.calls > 0) {
                    log.line('');
                    log.line(`tokens  ${tally.toString()}`);
                }
                await release();
            })()),
    };
}
