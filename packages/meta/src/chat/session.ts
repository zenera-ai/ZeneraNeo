// packages/meta/src/chat/session.ts
//
// One `zen meta chat` conversation over the Copilot SDK, with no drawing in it: open (or resume) a session on
// the wired provider, send a turn and wait for it to settle, and narrate the SDK's events as `ChatEvent`s.
// Main: `openChat(opts)` -> `Chat` (`send`, `abort`, `close`); also `providerConfig` (a `Wiring`'s env as the
// SDK's typed provider), `toCall` (an `assistant.usage` event as a ledger `MetaCall`), `narrate` and `EFFORTS`.
// Used by: `chat/run.ts`, which drives it from the chat screen in `chat/tui.tsx`.

import type {
    BearerTokenProvider,
    CopilotClientOptions,
    PermissionRequest,
    PermissionRequestResult,
    ProviderConfig,
    ResumeSessionConfig,
    SessionConfig,
    SessionEvent,
} from '@github/copilot-sdk';
import { setTimeout as sleep } from 'node:timers/promises';
import { RESUME_PROMPT, resumeDelayMs, transient, type Outcome } from '../launch.ts';
import type { MetaCall } from '../tokens.ts';

// ---------------------------------------------------------------------------
// What the screen is told
// ---------------------------------------------------------------------------

export type ChatEvent =
    /** a piece of the message being written, by its id */
    | { type: 'delta'; id: string; text: string }
    /** a whole message; `tools` > 0 means it was said on the way to a tool call */
    | { type: 'message'; id: string; text: string; tools: number }
    | { type: 'tool'; id: string; name: string; subject: string }
    | { type: 'tool-done'; id: string; ok: boolean; error?: string }
    | { type: 'usage'; call: MetaCall }
    | { type: 'warn'; text: string }
    | { type: 'error'; text: string }
    | { type: 'retry'; reason: string; waitMs: number; attempt: number; of: number };

export interface TurnResult {
    aborted: boolean;
    /** why the turn failed for good, when it did */
    failed?: string;
}

// ---------------------------------------------------------------------------
// The SDK, as little of it as this needs - so the tests can stand in for it
// ---------------------------------------------------------------------------

export interface SessionLike {
    readonly sessionId: string;
    on(handler: (event: SessionEvent) => void): () => void;
    send(options: { prompt: string }): Promise<string>;
    abort(): Promise<void>;
    disconnect(): Promise<void>;
}

export interface ClientLike {
    createSession(config: SessionConfig): Promise<SessionLike>;
    resumeSession(id: string, config: ResumeSessionConfig): Promise<SessionLike>;
    stop(): Promise<Error[]>;
}

export type Connect = (options: CopilotClientOptions) => ClientLike | Promise<ClientLike>;

/** The real one, loaded only when a chat opens: it brings a native runtime with it. */
const connectSdk: Connect = async (options) => {
    const { CopilotClient } = await import('@github/copilot-sdk');
    return new CopilotClient(options);
};

// ---------------------------------------------------------------------------
// The wiring, typed
//
// `zen meta run` hands copilot its provider in `COPILOT_PROVIDER_*`; the SDK
// takes the same settings as a typed object on the session. The rest of the
// environment - a service account's key file, the ledger - still goes to the
// runtime, since the key command and the agent's own `zen` calls read it there.
// ---------------------------------------------------------------------------

const PROVIDER_ENV = /^COPILOT_(PROVIDER_|MODEL$)/;

/**
 * `token`, when given, replaces the key command: the SDK calls back into this
 * process before each request instead of the runtime starting `zen key token`.
 */
export function providerConfig(
    env: Record<string, string>,
    token?: BearerTokenProvider,
): ProviderConfig {
    const type = env.COPILOT_PROVIDER_TYPE;
    const api = env.COPILOT_PROVIDER_WIRE_API;
    return {
        type: type === 'anthropic' ? 'anthropic' : 'openai',
        baseUrl: env.COPILOT_PROVIDER_BASE_URL ?? '',
        ...(env.COPILOT_PROVIDER_API_KEY ? { apiKey: env.COPILOT_PROVIDER_API_KEY } : {}),
        ...(token
            ? { bearerTokenProvider: token }
            : env.COPILOT_PROVIDER_API_KEY_COMMAND
              ? { apiKeyCommand: env.COPILOT_PROVIDER_API_KEY_COMMAND }
              : {}),
        ...(api === 'responses' || api === 'completions' ? { wireApi: api } : {}),
        ...(env.COPILOT_PROVIDER_MODEL_ID ? { modelId: env.COPILOT_PROVIDER_MODEL_ID } : {}),
        ...(env.COPILOT_PROVIDER_WIRE_MODEL ? { wireModel: env.COPILOT_PROVIDER_WIRE_MODEL } : {}),
    };
}

/**
 * A service account's access token, minted in this process. The key command
 * starts a `zen` and asks Google for a new token before every model call, so
 * one network blip in a long session failed the turn. Here the library keeps
 * the token until shortly before it expires, and a failed exchange is tried
 * again before the call is given up on.
 */
export function googleToken(
    keyFile: string,
    opts: { attempts?: number; delayMs?: number } = {},
): BearerTokenProvider {
    const attempts = opts.attempts ?? 4;
    const delayMs = opts.delayMs ?? 1_000;
    let auth: Promise<{ getAccessToken(): Promise<string | null | undefined> }> | undefined;
    return async () => {
        auth ??= import('google-auth-library').then(
            ({ GoogleAuth }) =>
                new GoogleAuth({
                    keyFile,
                    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
                }),
        );
        let last: unknown;
        for (let i = 0; i < attempts; i++) {
            try {
                const token = await (await auth).getAccessToken();
                if (token) {
                    return token;
                }
                last = new Error(`${keyFile} minted no token`);
            } catch (err) {
                last = err;
            }
            if (i + 1 < attempts) {
                await sleep(delayMs * 2 ** i);
            }
        }
        throw last;
    };
}

/** Everything else in the wiring's environment: what the provider object does not carry. */
export function runtimeEnv(env: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.entries(env).filter(([name]) => !PROVIDER_ENV.test(name)));
}

/** One model call, in the shape the ledger and the tally already take from the span file. */
export function toCall(event: SessionEvent, session: string): MetaCall | undefined {
    if (event.type !== 'assistant.usage') {
        return undefined;
    }
    const d = event.data;
    const reasoning = d.reasoningTokens ?? 0;
    const durationMs = Math.max(0, Math.round(d.duration ?? 0));
    const ended = Date.parse(event.timestamp);
    return {
        model: d.model,
        usage: {
            inputTokens: d.inputTokens ?? 0,
            cachedInputTokens: d.cacheReadTokens ?? 0,
            // Copilot counts reasoning beside the output; zen counts it inside.
            outputTokens: (d.outputTokens ?? 0) + reasoning,
            reasoningTokens: reasoning,
        },
        ...(d.cacheWriteTokens ? { cacheWriteTokens: d.cacheWriteTokens } : {}),
        startedAt: new Date(
            (Number.isFinite(ended) ? ended : Date.now()) - durationMs,
        ).toISOString(),
        durationMs,
        session,
    };
}

function subject(args: unknown): string {
    const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
    const what = a.command ?? a.description ?? a.path ?? a.url ?? a.pattern ?? a.skill ?? '';
    return String(what).replace(/\s+/g, ' ').trim();
}

/** The SDK's event as the screen's, or nothing. A sub-agent's own steps stay in the log. */
export function narrate(event: SessionEvent): ChatEvent | undefined {
    if ('agentId' in event && event.agentId) {
        return undefined;
    }
    switch (event.type) {
        case 'assistant.message_delta':
            return { type: 'delta', id: event.data.messageId, text: event.data.deltaContent };
        case 'assistant.message':
            if (event.data.parentToolCallId) {
                return undefined;
            }
            return {
                type: 'message',
                id: event.data.messageId,
                text: event.data.content,
                tools: event.data.toolRequests?.length ?? 0,
            };
        case 'tool.execution_start':
            if (event.data.parentToolCallId) {
                return undefined;
            }
            return {
                type: 'tool',
                id: event.data.toolCallId,
                name: event.data.toolTitle ?? event.data.toolName,
                subject: subject(event.data.arguments),
            };
        case 'tool.execution_complete':
            if (event.data.parentToolCallId) {
                return undefined;
            }
            return {
                type: 'tool-done',
                id: event.data.toolCallId,
                ok: event.data.success,
                error: event.data.error?.message,
            };
        case 'session.error':
            return { type: 'error', text: event.data.message };
        case 'session.warning':
            return { type: 'warn', text: event.data.message };
        default:
            return undefined;
    }
}

// ---------------------------------------------------------------------------
// The conversation
// ---------------------------------------------------------------------------

export interface ChatOptions {
    dir: string;
    /** the model's id, as `SessionConfig.model` */
    model: string;
    provider: ProviderConfig;
    /** the runtime's whole environment */
    env: Record<string, string>;
    sessionId: string;
    /** carry on `sessionId` rather than start it */
    resume: boolean;
    agent?: string;
    effort?: string;
    addDirs?: readonly string[];
    decide: (request: PermissionRequest) => Promise<PermissionRequestResult>;
    onEvent: (event: ChatEvent) => void;
    /** every SDK event, before it is narrated: the log and `--events` file */
    onRaw?: (event: SessionEvent) => void;
    /** resumes after a failure time can cure, per turn */
    retries: number;
    delayMs?: (attempt: number) => number;
    connect?: Connect;
}

export interface Chat {
    readonly sessionId: string;
    /** resolves when the turn has settled: answered, failed for good, or stopped */
    send(prompt: string): Promise<TurnResult>;
    /** stops the turn in flight, or the wait before a resume */
    abort(): Promise<void>;
    close(): Promise<void>;
}

/** The reasoning levels `--effort` takes. */
export const EFFORTS: readonly string[] = [
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
];

export async function openChat(opts: ChatOptions): Promise<Chat> {
    const client = await (opts.connect ?? connectSdk)({
        env: { ...process.env, ...opts.env },
        workingDirectory: opts.dir,
        // Your keys, never a Copilot subscription: no GitHub sign-in is looked for.
        useLoggedInUser: false,
        logLevel: 'error',
    });

    // Each turn's events, kept so `transient` can read a failure the way it reads a run's.
    let turn: SessionEvent[] = [];
    let settle: ((aborted: boolean) => void) | undefined;
    let failTimer: NodeJS.Timeout | undefined;

    const onEvent = (event: SessionEvent): void => {
        opts.onRaw?.(event);
        turn.push(event);
        const said = narrate(event);
        if (said) {
            opts.onEvent(said);
        }
        const call = toCall(event, opts.sessionId);
        if (call) {
            opts.onEvent({ type: 'usage', call });
        }
        if (event.type === 'session.idle') {
            clearTimeout(failTimer);
            settle?.(event.data.aborted === true);
        } else if (event.type === 'session.error') {
            // An error is followed by idle; if it is not, the turn still has to end.
            clearTimeout(failTimer);
            failTimer = setTimeout(() => settle?.(false), 5_000);
            failTimer.unref();
        }
    };

    const config = {
        model: opts.model,
        provider: opts.provider,
        streaming: true,
        workingDirectory: opts.dir,
        ...(opts.addDirs?.length ? { additionalDirectories: [...opts.addDirs] } : {}),
        ...(opts.agent ? { agent: opts.agent } : {}),
        ...(opts.effort && EFFORTS.includes(opts.effort)
            ? { reasoningEffort: opts.effort as SessionConfig['reasoningEffort'] }
            : {}),
        onPermissionRequest: opts.decide,
        onEvent,
    } satisfies Partial<SessionConfig>;

    let session: SessionLike;
    try {
        session = opts.resume
            ? await client.resumeSession(opts.sessionId, config)
            : await client.createSession({ ...config, sessionId: opts.sessionId });
    } catch (err) {
        await client.stop().catch(() => undefined);
        throw err;
    }

    let waiting: AbortController | undefined;
    let stopped = false;

    const once = async (prompt: string): Promise<{ aborted: boolean; events: SessionEvent[] }> => {
        turn = [];
        const done = new Promise<boolean>((resolve) => (settle = resolve));
        try {
            await session.send({ prompt });
        } catch (err) {
            settle = undefined;
            const text = (err as Error).message;
            opts.onEvent({ type: 'error', text });
            return {
                aborted: false,
                events: [{ type: 'session.error', data: { message: text } } as SessionEvent],
            };
        }
        const aborted = await done;
        settle = undefined;
        return { aborted, events: turn };
    };

    return {
        sessionId: session.sessionId,
        send: async (prompt) => {
            stopped = false;
            let attempt = 0;
            let result = await once(prompt);
            for (;;) {
                if (result.aborted || stopped) {
                    return { aborted: true };
                }
                const failed = result.events.findLast((e) => e.type === 'session.error');
                if (!failed) {
                    return { aborted: false };
                }
                const outcome: Outcome = {
                    answer: '',
                    exitCode: 1,
                    sessionId: session.sessionId,
                    events: result.events as unknown as Outcome['events'],
                };
                const reason = transient(outcome);
                const message = String((failed.data as { message?: unknown }).message ?? '');
                if (!reason || attempt >= opts.retries) {
                    return { aborted: false, failed: reason ?? message };
                }
                const waitMs = (opts.delayMs ?? resumeDelayMs)(attempt);
                attempt += 1;
                opts.onEvent({ type: 'retry', reason, waitMs, attempt, of: opts.retries });
                waiting = new AbortController();
                try {
                    await sleep(waitMs, undefined, { signal: waiting.signal });
                } catch {
                    return { aborted: true };
                } finally {
                    waiting = undefined;
                }
                result = await once(RESUME_PROMPT);
            }
        },
        abort: async () => {
            stopped = true;
            if (waiting) {
                waiting.abort();
                return;
            }
            await session.abort().catch(() => undefined);
        },
        close: async () => {
            clearTimeout(failTimer);
            await session.disconnect().catch(() => undefined);
            await client.stop().catch(() => undefined);
        },
    };
}
