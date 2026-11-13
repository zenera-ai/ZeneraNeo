import type { PermissionRequest, SessionConfig, SessionEvent } from '@github/copilot-sdk';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { allows, parseRules, permissionPolicy } from '../src/chat/permissions.ts';
import {
    openChat,
    providerConfig,
    runtimeEnv,
    type ChatEvent,
    type ClientLike,
    type SessionLike,
} from '../src/chat/session.ts';
import { EMPTY, fold } from '../src/chat/transcript.ts';
import { command } from '../src/command.ts';
import { RESUME_PROMPT } from '../src/launch.ts';

// ---------------------------------------------------------------------------
// zen meta chat, without a runtime: the SDK is stood in for by a client that
// plays back the events a turn would produce.
// ---------------------------------------------------------------------------

const ev = (type: string, data: Record<string, unknown> = {}): SessionEvent =>
    ({ type, data, id: type, parentId: null, timestamp: new Date().toISOString() }) as SessionEvent;

type Script = (prompt: string, emit: (e: SessionEvent) => void, turn: number) => void;

function fake(script: Script) {
    const calls = {
        created: [] as SessionConfig[],
        resumed: [] as string[],
        sent: [] as string[],
        aborted: 0,
        stopped: 0,
    };
    let emit: (e: SessionEvent) => void = () => undefined;
    const session: SessionLike = {
        sessionId: 'S',
        on: () => () => undefined,
        send: async ({ prompt }) => {
            calls.sent.push(prompt);
            setImmediate(() => script(prompt, emit, calls.sent.length));
            return 'm';
        },
        abort: async () => {
            calls.aborted += 1;
            emit(ev('session.idle', { aborted: true }));
        },
        disconnect: async () => undefined,
    };
    const client: ClientLike = {
        createSession: async (config) => {
            calls.created.push(config);
            emit = config.onEvent!;
            return session;
        },
        resumeSession: async (id, config) => {
            calls.resumed.push(id);
            emit = config.onEvent!;
            return session;
        },
        stop: async () => {
            calls.stopped += 1;
            return [];
        },
    };
    return { connect: () => client, calls };
}

async function chatWith(script: Script, extra: { resume?: boolean; retries?: number } = {}) {
    const { connect, calls } = fake(script);
    const events: ChatEvent[] = [];
    const chat = await openChat({
        dir: '/p',
        model: 'gpt-5',
        provider: { type: 'openai', baseUrl: 'https://x' },
        env: {},
        sessionId: 'S',
        resume: extra.resume ?? false,
        decide: async () => ({ kind: 'approve-once' }),
        onEvent: (e) => events.push(e),
        retries: extra.retries ?? 2,
        delayMs: () => 0,
        connect,
    });
    return { chat, calls, events };
}

describe('a chat turn', () => {
    it('streams the answer, narrates its tools, counts its tokens and ends at idle', async () => {
        const { chat, calls, events } = await chatWith((_, emit) => {
            emit(ev('assistant.message_delta', { messageId: 'a', deltaContent: 'Look' }));
            emit(
                ev('assistant.message', {
                    messageId: 'a',
                    content: 'Looking.',
                    toolRequests: [{}],
                }),
            );
            emit(
                ev('tool.execution_start', {
                    toolCallId: 't',
                    toolName: 'view',
                    arguments: { path: '/p/x' },
                }),
            );
            emit(
                ev('tool.execution_complete', {
                    toolCallId: 't',
                    success: false,
                    error: { message: 'gone' },
                }),
            );
            emit(
                ev('assistant.usage', {
                    model: 'gpt-5',
                    inputTokens: 10,
                    cacheReadTokens: 4,
                    outputTokens: 3,
                    reasoningTokens: 2,
                    duration: 50,
                }),
            );
            emit(ev('assistant.message_delta', { messageId: 'b', deltaContent: 'It is ' }));
            emit(ev('assistant.message_delta', { messageId: 'b', deltaContent: 'fine.' }));
            emit(ev('assistant.message', { messageId: 'b', content: 'It is fine.' }));
            emit(ev('session.idle'));
        });
        expect(await chat.send('hello')).toEqual({ aborted: false });
        expect(calls.sent).toEqual(['hello']);
        expect(calls.created[0]).toMatchObject({ sessionId: 'S', model: 'gpt-5', streaming: true });

        const usage = events.find((e) => e.type === 'usage');
        expect(usage).toMatchObject({
            call: {
                usage: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 5 },
                durationMs: 50,
                session: 'S',
            },
        });

        const view = events.reduce(fold, EMPTY);
        expect(view.rows.map((r) => [r.kind, r.text])).toEqual([
            ['say', 'Looking.'],
            ['tool', 'view /p/x'],
            ['fail', 'gone'],
            ['answer', 'It is fine.'],
        ]);
        expect(view.live).toBe('');
        await chat.close();
        expect(calls.stopped).toBe(1);
    });

    it('carries on the session it was given', async () => {
        const { calls } = await chatWith(() => undefined, { resume: true });
        expect(calls.resumed).toEqual(['S']);
        expect(calls.created).toEqual([]);
    });

    it('resumes after a rate limit, and gives up on what waiting cannot cure', async () => {
        const { chat, calls, events } = await chatWith((_, emit, turn) => {
            if (turn === 1) {
                emit(
                    ev('session.error', {
                        errorType: 'rate_limit',
                        statusCode: 429,
                        message: 'slow down',
                    }),
                );
            } else if (turn === 2) {
                emit(ev('assistant.message', { messageId: 'c', content: 'Done.' }));
            } else {
                emit(
                    ev('session.error', {
                        errorType: 'authentication',
                        statusCode: 401,
                        message: 'bad key',
                    }),
                );
            }
            emit(ev('session.idle'));
        });
        expect(await chat.send('go')).toEqual({ aborted: false });
        expect(calls.sent).toEqual(['go', RESUME_PROMPT]);
        expect(events.find((e) => e.type === 'retry')).toMatchObject({
            reason: 'rate-limited (429)',
            attempt: 1,
            of: 2,
        });

        expect(await chat.send('again')).toEqual({ aborted: false, failed: 'bad key' });
        expect(calls.sent).toHaveLength(3);
    });

    it('resumes a turn the key command failed once', async () => {
        const { chat, calls } = await chatWith((_, emit, turn) => {
            if (turn === 1) {
                emit(
                    ev('session.error', {
                        errorType: 'query',
                        message: 'COPILOT_PROVIDER_API_KEY_COMMAND exited with status 1',
                    }),
                );
            }
            emit(ev('session.idle'));
        });
        expect(await chat.send('go')).toEqual({ aborted: false });
        expect(calls.sent).toEqual(['go', RESUME_PROMPT]);
    });

    it('stops when it is told to', async () => {
        const { chat, calls } = await chatWith(() => undefined);
        const turn = chat.send('long job');
        await new Promise((r) => setImmediate(r));
        await chat.abort();
        expect(await turn).toEqual({ aborted: true });
        expect(calls.aborted).toBe(1);
    });
});

describe('the wiring, typed for the SDK', () => {
    const env = {
        COPILOT_PROVIDER_TYPE: 'openai',
        COPILOT_MODEL: 'gemini-3.8-flash',
        COPILOT_PROVIDER_BASE_URL:
            'https://aiplatform.googleapis.com/v1/projects/p/locations/us/endpoints/openapi',
        COPILOT_PROVIDER_API_KEY_COMMAND: 'zen key token vertex',
        COPILOT_PROVIDER_MODEL_ID: 'gemini-3.8-flash',
        COPILOT_PROVIDER_WIRE_MODEL: 'google/gemini-3.8-flash',
        GOOGLE_APPLICATION_CREDENTIALS: '/keys/vertex.json',
    };

    it('moves the provider settings onto the session and leaves the rest to the runtime', () => {
        expect(providerConfig(env)).toEqual({
            type: 'openai',
            baseUrl: env.COPILOT_PROVIDER_BASE_URL,
            apiKeyCommand: 'zen key token vertex',
            modelId: 'gemini-3.8-flash',
            wireModel: 'google/gemini-3.8-flash',
        });
        expect(runtimeEnv(env)).toEqual({ GOOGLE_APPLICATION_CREDENTIALS: '/keys/vertex.json' });
    });

    // The key command reached Google once per model call, and one blip ended the turn.
    it('takes a token from this process in place of the key command', () => {
        const token = async (): Promise<string> => 'ya29.x';
        const provider = providerConfig(env, token);
        expect(provider.bearerTokenProvider).toBe(token);
        expect(provider.apiKeyCommand).toBeUndefined();
    });
});

describe('which tools a chat may use', () => {
    const shell = (text: string): PermissionRequest =>
        ({
            kind: 'shell',
            fullCommandText: text,
            commandSegments: [{ fullCommandText: text, identifier: text.split(' ')[0] }],
        }) as unknown as PermissionRequest;
    const write = (fileName: string): PermissionRequest =>
        ({ kind: 'write', fileName, intention: 'Create file' }) as unknown as PermissionRequest;

    it("reads copilot's --allow-tool list, parentheses and all", () => {
        expect(parseRules('read, shell(git:*), write(README.md)')).toEqual([
            { kind: 'read' },
            { kind: 'shell', pattern: 'git:*' },
            { kind: 'write', pattern: 'README.md' },
        ]);
        const rules = parseRules('shell(git:*),write(README.md)');
        expect(allows(rules, shell('git status'))).toBe(true);
        expect(allows(rules, shell('gitk'))).toBe(false);
        expect(allows(rules, write('/p/README.md'))).toBe(true);
        expect(allows(rules, write('/p/other.md'))).toBe(false);
    });

    it('allows everything by default, as `zen meta run` does', async () => {
        expect(await permissionPolicy({})(shell('rm -rf build'))).toEqual({ kind: 'approve-once' });
    });

    it('refuses what --allow-tool leaves out, unless --ask', async () => {
        const decide = permissionPolicy({ allowTool: 'read' });
        expect(await decide(shell('ls'))).toMatchObject({ kind: 'reject' });
    });

    it('asks with --ask, and remembers an always for that kind of tool', async () => {
        const asked: string[] = [];
        const answers = ['no', 'always'] as const;
        const decide = permissionPolicy({
            ask: true,
            prompt: async (r) => {
                asked.push(`${r.kind} ${r.subject}`);
                return answers[asked.length - 1];
            },
        });
        expect(await decide(write('a.md'))).toEqual({ kind: 'reject' });
        expect(await decide(write('b.md'))).toEqual({ kind: 'approve-once' });
        expect(await decide(write('c.md'))).toEqual({ kind: 'approve-once' });
        expect(asked).toEqual(['write a.md', 'write b.md']);
    });

    it('leaves a managed approval to its owner', async () => {
        const managed = { ...write('x'), managedApprovalRequired: true } as PermissionRequest;
        expect(await permissionPolicy({})(managed)).toEqual({ kind: 'no-result' });
    });
});

describe('zen meta chat', () => {
    let dir: string;
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    // Both are refused before a project, a key or a runtime is looked for.
    it('refuses --json, and a terminal that is not one', async () => {
        dir = mkdtempSync(join(tmpdir(), 'meta-chat-'));
        await expect(command.run({ args: ['chat'], json: true, cwd: dir })).rejects.toThrow(
            /no one answer to print as JSON/,
        );
        await expect(
            command.run({ args: ['chat', '--dry-run'], json: false, cwd: dir }),
        ).rejects.toThrow(/takes no --dry-run/);
        await expect(command.run({ args: ['chat'], json: false, cwd: dir })).rejects.toThrow(
            /needs a terminal/,
        );
    });
});
