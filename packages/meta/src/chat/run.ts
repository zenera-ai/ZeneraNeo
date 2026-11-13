// packages/meta/src/chat/run.ts
//
// `zen meta chat` from flags to the last line: open the session (`openMetaChat` does the model, key, log, relay
// and ledger), hand it to the chat screen, and on the way out close it and say how to carry on.
// Main: `runChat(opts)`.
// Used by: `command.ts`, whose `chat()` checks the terminal and the project and then calls this.

import type * as Projects from '@zenera/engine';
import { join, resolve } from 'node:path';
import { cyan, dim, History, note, resolveTheme } from '../host.ts';
import type { Selection } from '../prepare.ts';
import { listPrompts, loadPrompt } from '../prompts.ts';
import { openMetaChat, type MetaChat } from './open.ts';
import type { Chat, Connect } from './session.ts';
import type { Bridge, Screen } from './tui.tsx';

export interface ChatFlags extends Selection {
    agent?: string;
    effort?: string;
    events?: string;
    'allow-all'?: boolean;
    'allow-tool'?: string;
    ask?: boolean;
    'add-dir'?: string[];
    'no-refresh'?: boolean;
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
    const { values, project } = opts;
    const bridge: Bridge = {};
    let chat: MetaChat | undefined;
    try {
        chat = await openMetaChat({
            project,
            provider: values.provider,
            model: values.model,
            resume: values.resume,
            continue: values.continue,
            'session-id': values['session-id'],
            agent: values.agent,
            effort: values.effort,
            allowAll: values['allow-all'],
            allowTool: values['allow-tool'],
            ask: values.ask,
            prompt: (request) => bridge.onAsk?.(request) ?? Promise.resolve('no'),
            addDirs: values['add-dir']?.map((d) => resolve(opts.cwd, d)),
            events: values.events ? resolve(opts.cwd, values.events) : undefined,
            retries: opts.retries,
            refresh: !values['no-refresh'],
            connect: opts.connect,
            onEvent: (event) => bridge.onEvent?.(event),
        });
        const meta = chat;
        // The screen reports what was typed just before it sends what that expanded to.
        let shown: string | undefined;
        const screenChat: Chat = {
            sessionId: meta.sessionId,
            send: (prompt) => meta.send(prompt, shown ?? prompt),
            abort: () => meta.abort(),
            close: () => meta.close(),
        };
        const screen = opts.screen ?? (await import('./tui.tsx')).chatScreen;
        await screen({
            chat: screenChat,
            bridge,
            history: new History(join(project.dir, '.tmp', 'logs', 'meta.history')),
            theme: await resolveTheme(),
            title: {
                owner: meta.owner,
                model: meta.model,
                project: project.name,
                resumed: meta.resumed,
            },
            status: () => meta.tokens(),
            prompts: {
                list: () => listPrompts(project.dir),
                load: (name) => loadPrompt(project.dir, name),
            },
            first: opts.first,
            onSend: (typed) => {
                shown = typed;
            },
        });
    } finally {
        await chat?.close();
    }
    const tokens = chat.tokens();
    if (tokens) {
        note(dim(`tokens  ${tokens}`));
    }
    note(dim(`carry on: zen meta chat ${project.name} --resume ${chat.sessionId}`));
    note(cyan(chat.logPath));
}
