// packages/meta/src/chat/run.ts
//
// `zen meta chat` from flags to the last line: prepare the model and key, open the log, start the Vertex relay
// when Claude needs it, open the SDK session, hand it to the chat screen, and on the way out record the
// session's usage and say how to carry on.
// Main: `runChat(opts)`.
// Used by: `command.ts`, whose `chat()` checks the terminal and the project and then calls this.

import type * as Projects from '@zenera/engine';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import {
    appendUsage,
    copilotEventLog,
    cyan,
    dim,
    History,
    LEDGER_ENV,
    ledgerPath,
    META_SESSION_ENV,
    note,
    resolveTheme,
} from '../host.ts';
import { absorb, openLog, recordSession, type Outcome } from '../launch.ts';
import { announce, prepare, type Selection } from '../prepare.ts';
import { listPrompts, loadPrompt } from '../prompts.ts';
import { startVertexRelay } from '../relay.ts';
import { usageReporter } from '../reporter.ts';
import { SOURCE_LABELS } from '../model.ts';
import type { Sink } from '../sink.ts';
import { sessionTotals, Tally } from '../tokens.ts';
import { permissionPolicy } from './permissions.ts';
import {
    googleToken,
    openChat,
    providerConfig,
    runtimeEnv,
    type Chat,
    type Connect,
} from './session.ts';
import type { Bridge, Screen } from './tui.tsx';

export interface ChatFlags extends Selection {
    agent?: string;
    effort?: string;
    events?: string;
    'allow-all'?: boolean;
    'allow-tool'?: string;
    ask?: boolean;
    'add-dir'?: string[];
}

export interface RunChat {
    values: ChatFlags;
    project: Projects.Project;
    cwd: string;
    /** the first question, from the command line */
    first?: string;
    retries: number;
    /** injected by the tests, which want no runtime */
    connect?: Connect;
    /** likewise: the tests have no terminal to draw on */
    screen?: (screen: Screen) => Promise<void>;
}

export async function runChat(opts: RunChat): Promise<void> {
    const { project } = opts;
    const prepared = await prepare(opts.values, project);
    const { values, wiring, chosen } = prepared;
    const resumed = values.resume;
    // `prepare` names a fresh session unless --continue, which the caller has already resolved.
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
    const record = values.events ? copilotEventLog(resolve(opts.cwd, values.events)) : undefined;
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
    const bridge: Bridge = {};
    const decide = permissionPolicy({
        allowAll: values['allow-all'],
        ask: values.ask,
        allowTool: values['allow-tool'],
        prompt: (request) =>
            bridge.onAsk?.({ ...request, subject: relative(request.subject) }) ??
            Promise.resolve('no'),
    });

    let chat: Chat | undefined;
    const startedAt = new Date();
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
            resume: Boolean(resumed),
            agent: values.agent,
            effort: values.effort,
            addDirs: values['add-dir']?.map((d) => resolve(opts.cwd, d)),
            decide,
            retries: opts.retries,
            connect: opts.connect,
            onRaw: (event) => {
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
                bridge.onEvent?.(event);
            },
        });
        const screen = opts.screen ?? (await import('./tui.tsx')).chatScreen;
        await screen({
            chat,
            bridge,
            history: new History(join(project.dir, '.tmp', 'logs', 'meta.history')),
            theme: await resolveTheme(),
            title: {
                owner: prepared.owner,
                model: wiring.model,
                project: project.name,
                resumed: Boolean(resumed),
            },
            status: () => (tally.calls > 0 ? tally.toString() : ''),
            prompts: {
                list: () => listPrompts(project.dir),
                load: (name) => loadPrompt(project.dir, name),
            },
            first: opts.first,
            onSend: (shown, prompt) => {
                log.line('');
                log.line(`--- you: ${shown.split('\n')[0]} ---`);
                if (prompt !== shown) {
                    log.line(prompt);
                }
            },
        });
    } finally {
        await chat?.close();
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
        reporter.stop();
        await relay?.close();
        log.close();
    }
    if (tally.calls > 0) {
        note(dim(`tokens  ${tally.toString()}`));
    }
    note(dim(`carry on: zen meta chat ${project.name} --resume ${session}`));
    note(cyan(log.path));
}
