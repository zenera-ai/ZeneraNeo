// packages/meta/src/chat/tui.tsx
//
// The `zen meta chat` screen: an Ink transcript of the conversation, the answer streaming in as it is written,
// a status row while a turn runs, the prompt (with history and slash commands), and the tool-permission question.
// Main: `chatScreen(screen)`, which draws until the person quits; `ChatApp` is the component.
// Used by: `chat/run.ts`, which loads it with a dynamic import once the session is open.

import { TextInput } from '@inkjs/ui';
import { Box, render, Static, Text, useApp, useInput, useStdout } from 'ink';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { duration, formatMarkdown, type History, type Theme } from '../host.ts';
import { FRAME_MS } from '../sink.ts';
import type { Answer, Described } from './permissions.ts';
import type { Chat, ChatEvent } from './session.ts';
import { EMPTY, fold, said, type Row, type View } from './transcript.ts';

/** How the session, opened before the screen, reaches it: set on mount, cleared on unmount. */
export interface Bridge {
    onEvent?: (event: ChatEvent) => void;
    onAsk?: (request: Described) => Promise<Answer>;
}

export interface Screen {
    chat: Chat;
    bridge: Bridge;
    history: History;
    theme: Theme;
    title: { owner: string; model: string; project: string; resumed: boolean };
    /** said after the clock while a turn runs: the calls and tokens so far */
    status: () => string;
    prompts: {
        list(): Promise<string[]>;
        load(name: string): Promise<{ body: string; description?: string }>;
    };
    /** asked as soon as the screen is up */
    first?: string;
    /** each prompt as it is sent, for the log */
    onSend?: (shown: string, prompt: string) => void;
}

export async function chatScreen(screen: Screen): Promise<void> {
    const app = render(<ChatApp {...screen} />, { exitOnCtrlC: false });
    await app.waitUntilExit();
}

const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const HEADER = { key: -1, kind: 'header' } as const;
type Item = Row | typeof HEADER;

const HELP = [
    '/help             this list',
    '/prompts          the commands this project offers',
    '/<name> [words]   run one of them: .github/skills/<name>/SKILL.md',
    '/exit             leave (Ctrl-D does too)',
    'Esc stops a turn. ↑ and ↓ walk what you asked before.',
].join('\n');

export function ChatApp(props: Screen): React.ReactElement {
    const { chat, bridge, history, theme, title } = props;
    const { exit } = useApp();
    const { stdout } = useStdout();
    const columns = Math.max(40, stdout.columns ?? 80);

    const [view, setView] = useState<View>(EMPTY);
    const [busy, setBusy] = useState(false);
    const [ask, setAsk] = useState<{ request: Described; answer: (a: Answer) => void }>();
    const started = useRef(0);
    const armed = useRef(0);

    const say = useCallback((kind: Row['kind'], text: string): void => {
        setView((v) => said(v, kind, text));
    }, []);

    // The prompt, as `zen chat` has it: `TextInput` is uncontrolled, so a
    // recalled line is a new starting value under a new key.
    const [draft, setDraft] = useState('');
    const [generation, setGeneration] = useState(0);
    const at = useRef(history.entries.length);
    const typed = useRef('');
    const pending = useRef('');

    const remember = useCallback((value: string): void => {
        typed.current = value;
    }, []);

    const reset = useCallback((): void => {
        at.current = history.entries.length;
        pending.current = '';
        typed.current = '';
        setDraft('');
        setGeneration((g) => g + 1);
    }, [history]);

    const recall = useCallback(
        (delta: number): void => {
            const end = history.entries.length;
            if (end === 0 || (at.current === end && delta > 0)) {
                return;
            }
            if (at.current === end) {
                pending.current = typed.current;
            }
            const next = Math.min(end, Math.max(0, at.current + delta));
            if (next === at.current) {
                return;
            }
            at.current = next;
            const value = next === end ? pending.current : (history.entries[next] ?? '');
            typed.current = value;
            setDraft(value);
            setGeneration((g) => g + 1);
        },
        [history],
    );

    const send = useCallback(
        async (shown: string, prompt: string): Promise<void> => {
            say('you', shown);
            props.onSend?.(shown, prompt);
            started.current = Date.now();
            setBusy(true);
            try {
                const result = await chat.send(prompt);
                if (result.failed) {
                    say('error', `the turn failed: ${result.failed}`);
                } else if (result.aborted) {
                    say('note', 'stopped');
                }
            } catch (err) {
                say('error', (err as Error).message);
            } finally {
                setBusy(false);
            }
        },
        [chat, props, say],
    );

    const submit = useCallback(
        async (raw: string): Promise<void> => {
            const text = raw.trim();
            reset();
            if (!text) {
                return;
            }
            history.add(text);
            if (!text.startsWith('/')) {
                return await send(text, text);
            }
            const [name = '', ...words] = text.slice(1).split(/\s+/);
            if (name === 'exit' || name === 'quit') {
                exit();
                return;
            }
            if (name === 'help' || name === '') {
                say('note', HELP);
                return;
            }
            if (name === 'prompts') {
                const names = await props.prompts.list();
                say(
                    'note',
                    names.length ? names.map((n) => `/${n}`).join('  ') : 'no commands here',
                );
                return;
            }
            let found: { body: string };
            try {
                found = await props.prompts.load(name);
            } catch {
                say('error', `no command /${name} - /prompts lists them`);
                return;
            }
            await send(text, words.length ? `${found.body}\n\n${words.join(' ')}` : found.body);
        },
        [exit, history, props.prompts, reset, say, send],
    );

    useEffect(() => {
        bridge.onEvent = (event) => setView((v) => fold(v, event));
        bridge.onAsk = (request) =>
            new Promise<Answer>((resolve) => {
                setAsk({
                    request,
                    answer: (a) => {
                        setAsk(undefined);
                        resolve(a);
                    },
                });
            });
        if (props.first) {
            void submit(props.first);
        }
        return () => {
            bridge.onEvent = undefined;
            bridge.onAsk = undefined;
        };
        // Once, on mount: the first question is asked once.
    }, []);

    // The spinner and the clock move on their own, but only while a turn runs.
    const [frame, setFrame] = useState(0);
    useEffect(() => {
        if (!busy) {
            return;
        }
        const timer = setInterval(() => setFrame((n) => n + 1), FRAME_MS);
        return () => clearInterval(timer);
    }, [busy]);

    useInput((input, keys) => {
        if (ask) {
            const choice = input.toLowerCase();
            if (choice === 'y') {
                ask.answer('yes');
            } else if (choice === 'a') {
                ask.answer('always');
            } else if (choice === 'n' || keys.escape) {
                ask.answer('no');
            }
            return;
        }
        if (keys.ctrl && input === 'c') {
            if (busy) {
                void chat.abort();
                return;
            }
            // Twice, as in copilot: once is too easy to press on the way to a copy.
            if (Date.now() - armed.current < 2_000) {
                exit();
            } else {
                armed.current = Date.now();
                say('note', 'Ctrl-C again to leave');
            }
            return;
        }
        if (busy) {
            if (keys.escape) {
                void chat.abort();
            }
            return;
        }
        if (keys.ctrl && input === 'd') {
            exit();
        } else if (keys.upArrow) {
            recall(-1);
        } else if (keys.downArrow) {
            recall(1);
        }
    });

    const room = Math.max(4, (stdout.rows ?? 24) - 8);
    const live = view.live ? formatMarkdown(view.live, columns - 2).slice(-room) : [];
    const extra = props.status();

    return (
        <Box flexDirection="column">
            <Static items={[HEADER, ...view.rows] as Item[]}>
                {(item) =>
                    item.kind === 'header' ? (
                        <Header key={item.key} theme={theme} title={title} />
                    ) : (
                        <RowView key={item.key} row={item} theme={theme} columns={columns} />
                    )
                }
            </Static>

            {live.length > 0 ? (
                <Box flexDirection="column" marginTop={1}>
                    {live.map((line, i) => (
                        <Text key={i}>{line}</Text>
                    ))}
                </Box>
            ) : null}

            {ask ? <Ask request={ask.request} theme={theme} /> : null}

            {busy ? (
                <Box marginTop={1}>
                    <Text color={theme.accent}>{SPIN[frame % SPIN.length]} </Text>
                    <Text color={theme.chrome.color}>
                        {`working ${duration(Date.now() - started.current)}`}
                        {extra ? ` · ${extra}` : ''}
                        {ask ? '' : ' · Esc stops'}
                    </Text>
                </Box>
            ) : (
                <Box marginTop={1}>
                    <Text color={theme.accent}>› </Text>
                    <TextInput
                        key={generation}
                        defaultValue={draft}
                        placeholder="Ask the meta agent… (/help, ↑ for history, Ctrl-D leaves)"
                        onChange={remember}
                        onSubmit={(value) => void submit(value)}
                    />
                </Box>
            )}
        </Box>
    );
}

/** The banner and the model line are already above it, printed before the screen opened. */
function Header({ theme, title }: Pick<Screen, 'theme' | 'title'>): React.ReactElement {
    return (
        <Text color={theme.chrome.color}>
            {title.resumed ? 'resumed · ' : ''}/help for commands · Esc stops a turn · Ctrl-D leaves
        </Text>
    );
}

function RowView({
    row,
    theme,
    columns,
}: {
    row: Row;
    theme: Theme;
    columns: number;
}): React.ReactElement {
    const quiet = theme.chrome.color;
    switch (row.kind) {
        case 'you':
            return (
                <Box marginTop={1}>
                    <Text color={theme.accent} bold>
                        ›{' '}
                    </Text>
                    <Text bold>{row.text}</Text>
                </Box>
            );
        case 'answer':
            return (
                <Box flexDirection="column" marginTop={1}>
                    {formatMarkdown(row.text, columns - 2).map((line, i) => (
                        <Text key={i}>{line}</Text>
                    ))}
                </Box>
            );
        case 'say':
            return (
                <Box marginTop={1}>
                    <Text color={quiet}>{row.text.replace(/\s+/g, ' ')}</Text>
                </Box>
            );
        case 'tool':
            return (
                <Text color={quiet} wrap="truncate-end">
                    {'  ⏺ '}
                    {row.text}
                </Text>
            );
        case 'fail':
            return (
                <Text color="red" wrap="truncate-end">
                    {'    ✗ '}
                    {row.text}
                </Text>
            );
        case 'warn':
            return <Text color={theme.warn}>! {row.text}</Text>;
        case 'error':
            return <Text color="red">✗ {row.text}</Text>;
        case 'note':
            return <Text color={quiet}>{row.text}</Text>;
    }
}

function Ask({ request, theme }: { request: Described; theme: Theme }): React.ReactElement {
    return (
        <Box
            flexDirection="column"
            borderStyle="round"
            borderColor={theme.warn}
            paddingX={1}
            marginTop={1}
        >
            <Text>
                {'Allow '}
                <Text bold>{request.kind}</Text>
                {request.subject ? `: ${request.subject}` : '?'}
            </Text>
            {request.intention ? <Text color={theme.chrome.color}>{request.intention}</Text> : null}
            <Text color={theme.chrome.color}>
                {`y yes · n no · a always allow ${request.kind} in this chat`}
            </Text>
        </Box>
    );
}
