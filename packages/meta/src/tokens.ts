import type { ModelUsage, TokenUsage } from '@zenera/neo';
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Tokens
//
// Copilot's JSONL carries no token counts at all. Its OpenTelemetry file
// exporter does: one `chat` span per model call, written about a second after
// the call ends, with the usage on it. So the run is pointed at a span file and
// the file is read as it grows. The session's own totals arrive only once, in
// the `session.shutdown` it writes to its state directory on the way out.
// ---------------------------------------------------------------------------

export interface MetaCall {
    model: string;
    usage: TokenUsage;
    cacheWriteTokens?: number;
    startedAt: string;
    durationMs: number;
    session?: string;
    traceId?: string;
    spanId?: string;
}

/** An OTel time: `[seconds, nanoseconds]` in this exporter; epoch ms either way. */
function epochMs(t: unknown): number | undefined {
    if (Array.isArray(t) && typeof t[0] === 'number') {
        return t[0] * 1000 + Number(t[1] ?? 0) / 1e6;
    }
    if (typeof t === 'number') {
        return t;
    }
    return typeof t === 'string' ? Date.parse(t) : undefined;
}

/**
 * One line of the span file, as a model call - anything else is undefined.
 * Only counts are read off it: whatever else a span may carry, none of it
 * reaches the ledger.
 */
export function readSpan(line: string): MetaCall | undefined {
    let span: Record<string, unknown>;
    try {
        span = JSON.parse(line) as Record<string, unknown>;
    } catch {
        return undefined;
    }
    const attrs = (span.attributes ?? {}) as Record<string, unknown>;
    if (span.type !== 'span' || attrs['gen_ai.operation.name'] !== 'chat') {
        return undefined;
    }
    const num = (key: string): number => Number(attrs[key] ?? 0) || 0;
    const start = epochMs(span.startTime) ?? 0;
    const end = epochMs(span.endTime) ?? start;
    // Copilot counts reasoning beside the output; zen counts it inside.
    const reasoning = num('gen_ai.usage.reasoning.output_tokens');
    const cacheWrite =
        num('gen_ai.usage.cache_creation.input_tokens') ||
        num('gen_ai.usage.cache_creation_input_tokens');
    return {
        model: String(attrs['gen_ai.response.model'] ?? attrs['gen_ai.request.model'] ?? '?'),
        usage: {
            inputTokens: num('gen_ai.usage.input_tokens'),
            cachedInputTokens:
                num('gen_ai.usage.cache_read.input_tokens') ||
                num('gen_ai.usage.cache_read_input_tokens'),
            outputTokens: num('gen_ai.usage.output_tokens') + reasoning,
            reasoningTokens: reasoning,
        },
        ...(cacheWrite ? { cacheWriteTokens: cacheWrite } : {}),
        startedAt: new Date(start).toISOString(),
        durationMs: Math.max(0, Math.round(end - start)),
        session:
            typeof attrs['gen_ai.conversation.id'] === 'string'
                ? (attrs['gen_ai.conversation.id'] as string)
                : undefined,
        traceId: typeof span.traceId === 'string' ? span.traceId : undefined,
        spanId: typeof span.spanId === 'string' ? span.spanId : undefined,
    };
}

/** Whole lines out of a stream read in chunks; the unfinished tail is carried. */
export function splitLines(carry: string, chunk: string): { lines: string[]; carry: string } {
    const parts = `${carry}${chunk}`.split('\n');
    const rest = parts.pop() ?? '';
    return { lines: parts.filter((l) => l.trim()), carry: rest };
}

/** Reads a span file as it grows. `stop()` reads what is left, once. */
export function tailSpans(path: string, onCall: (call: MetaCall) => void, everyMs = 1000) {
    let offset = 0;
    let carry = '';
    const poll = (): void => {
        let fd: number | undefined;
        try {
            const size = statSync(path).size;
            if (size <= offset) {
                return;
            }
            fd = openSync(path, 'r');
            const buf = Buffer.alloc(size - offset);
            readSync(fd, buf, 0, buf.length, offset);
            offset = size;
            const split = splitLines(carry, buf.toString('utf8'));
            carry = split.carry;
            for (const line of split.lines) {
                const call = readSpan(line);
                if (call) {
                    onCall(call);
                }
            }
        } catch {
            // Not there yet: copilot creates it at the first span.
        } finally {
            if (fd !== undefined) {
                closeSync(fd);
            }
        }
    };
    const timer = setInterval(poll, everyMs);
    timer.unref();
    return {
        stop: (): void => {
            clearInterval(timer);
            poll();
        },
    };
}

/** Calls and tokens so far, in the one line the status row and the summary share. */
export class Tally {
    calls = 0;
    usage: TokenUsage = {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
    };

    add(call: MetaCall): void {
        this.calls += 1;
        this.usage = {
            inputTokens: this.usage.inputTokens + call.usage.inputTokens,
            cachedInputTokens: this.usage.cachedInputTokens + call.usage.cachedInputTokens,
            outputTokens: this.usage.outputTokens + call.usage.outputTokens,
            reasoningTokens: this.usage.reasoningTokens + call.usage.reasoningTokens,
        };
    }

    toString(): string {
        const u = this.usage;
        const cached = u.cachedInputTokens ? ` (${compact(u.cachedInputTokens)} cached)` : '';
        return (
            `${this.calls} call${this.calls === 1 ? '' : 's'} · ${compact(u.inputTokens)} in${cached}` +
            ` · ${compact(u.outputTokens)} out`
        );
    }
}

/** 950, 12.3k, 1.8M. */
export function compact(n: number): string {
    if (n < 1000) {
        return String(n);
    }
    if (n < 1e6) {
        return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`;
    }
    return `${(n / 1e6).toFixed(n < 1e7 ? 2 : 1)}M`;
}

/**
 * Copilot's own per-model totals from the last `session.shutdown` in a session's
 * events - cumulative over every resume of it. Reasoning folded into output,
 * as everywhere in zen.
 */
export function shutdownModels(events: string): ModelUsage[] | undefined {
    const line = events
        .split('\n')
        .reverse()
        .find((l) => l.includes('"session.shutdown"'));
    if (!line) {
        return undefined;
    }
    let metrics: Record<string, { requests?: { count?: number }; usage?: Record<string, number> }>;
    try {
        metrics = JSON.parse(line).data?.modelMetrics ?? {};
    } catch {
        return undefined;
    }
    return Object.entries(metrics).map(([model, m]) => {
        const u = m.usage ?? {};
        const reasoning = Number(u.reasoningTokens ?? 0);
        return {
            model,
            calls: Number(m.requests?.count ?? 0),
            usage: {
                inputTokens: Number(u.inputTokens ?? 0),
                cachedInputTokens: Number(u.cacheReadTokens ?? 0),
                outputTokens: Number(u.outputTokens ?? 0) + reasoning,
                reasoningTokens: reasoning,
            },
        };
    });
}

export function sessionTotals(sessionId: string): ModelUsage[] | undefined {
    const home = process.env.COPILOT_HOME ?? join(homedir(), '.copilot');
    try {
        return shutdownModels(
            readFileSync(join(home, 'session-state', sessionId, 'events.jsonl'), 'utf8'),
        );
    } catch {
        return undefined;
    }
}

/** Whether this machine holds the session, which is what `--resume` needs. */
export function sessionKept(sessionId: string): boolean {
    const home = process.env.COPILOT_HOME ?? join(homedir(), '.copilot');
    return existsSync(join(home, 'session-state', sessionId));
}

/**
 * The model a session's history was written by: its last answer's, else the one it started on.
 * A failed resume on another model writes no answer, so it never becomes the session's model.
 */
export function sessionModel(sessionId: string): string | undefined {
    const home = process.env.COPILOT_HOME ?? join(homedir(), '.copilot');
    let text: string;
    try {
        text = readFileSync(join(home, 'session-state', sessionId, 'events.jsonl'), 'utf8');
    } catch {
        return undefined;
    }
    let started: string | undefined;
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line.includes('"assistant.message"') && !line.includes('"session.start"')) {
            continue;
        }
        try {
            const event = JSON.parse(line) as { type?: string; data?: Record<string, unknown> };
            if (event.type === 'assistant.message' && typeof event.data?.model === 'string') {
                return event.data.model;
            }
            if (event.type === 'session.start' && typeof event.data?.selectedModel === 'string') {
                started = event.data.selectedModel;
            }
        } catch {
            // A line cut by a crash says nothing.
        }
    }
    return started;
}

/** `google/gemini-3.8-flash` and `gemini-3.8-flash` are one model to copilot. */
export const sameModel = (a: string, b: string): boolean =>
    a.replace(/^.*\//, '').toLowerCase() === b.replace(/^.*\//, '').toLowerCase();
