// AG-UI for a @zenera/neo run. neo streams bare deltas plus a checkpoint per model call, tool
// call, hand-off and branch; AG-UI wants every text, reasoning and tool-call stream opened and
// closed around them. One translator per run keeps that bookkeeping, per branch.
//   AguiTranslator  - neo AgentEvent -> AG-UI events, in order (await each call before the next)
//   clip            - the cap on tool output sent to a browser
//   interruptsOf    - what a suspended run waits for, as AG-UI interrupts (RUN_FINISHED outcome)
import {
    EventType,
    type AGUIEvent,
    type Interrupt,
    type TokenUsage as AguiUsage,
    type RunAgentInput,
} from '@ag-ui/core';
import type { AgentEvent, AgentState, Payload, RunResult, TokenUsage } from '@zenera/neo';
import { randomUUID } from 'node:crypto';

export const MAX_TOOL_OUTPUT = 8000;

export function clip(text: string, max = MAX_TOOL_OUTPUT): string {
    return text.length > max
        ? `${text.slice(0, max)}\n… ${text.length - max} more characters`
        : text;
}

export type Resolve = (payload: Payload) => Promise<string>;

// What a tool put in suspend({ data }): zenera-app's interrupt id, and what the browser shows.
interface SuspendData {
    interruptId?: unknown;
    [key: string]: unknown;
}

/**
 * The calls a suspended run waits on, as AG-UI interrupts. The id is zenera-app's interrupt id
 * when the tool got one (it resumes the run by it), else the call id; `toolCallId` ties it to the
 * tool card; `metadata` is what the tool said about it (server, icon, ...), for that card.
 */
export function interruptsOf(state: AgentState): Interrupt[] {
    // `suspended` is newer than some @zenera/neo typings this compiles against.
    const suspended = (state as { suspended?: unknown[] }).suspended ?? [];
    return suspended.map((raw) => {
        const s = raw as {
            callId: string;
            reason: string;
            message?: string;
            data?: SuspendData;
            responseSchema?: Record<string, unknown>;
        };
        const data = s.data && typeof s.data === 'object' ? s.data : undefined;
        return {
            id: typeof data?.interruptId === 'string' ? data.interruptId : s.callId,
            reason: s.reason,
            ...(s.message ? { message: s.message } : {}),
            toolCallId: s.callId,
            ...(s.responseSchema ? { responseSchema: s.responseSchema } : {}),
            ...(data ? { metadata: data } : {}),
        };
    });
}

// The trunk, or one fork branch: AG-UI attributes a branch's events by its subagentRunId.
interface Lane {
    subagentRunId?: string;
    text?: string;
    reasoning?: string;
    streamedText: boolean;
    tools: Map<string, { name: string }>;
}

export interface TranslatorOptions {
    threadId: string;
    runId: string;
    resolve: Resolve;
    newId?: () => string;
}

export class AguiTranslator {
    readonly #threadId: string;
    readonly #runId: string;
    readonly #resolve: Resolve;
    readonly #newId: () => string;
    readonly #lanes = new Map<string, Lane>();
    // fork node id -> the tool call that asked for it
    readonly #forks = new Map<string, string>();
    #agent?: string;
    #done = false;

    constructor(opts: TranslatorOptions) {
        this.#threadId = opts.threadId;
        this.#runId = opts.runId;
        this.#resolve = opts.resolve;
        this.#newId = opts.newId ?? randomUUID;
    }

    get done(): boolean {
        return this.#done;
    }

    /** The run's input goes with it: a replayed run then shows what it answered. */
    started(input?: RunAgentInput): AGUIEvent[] {
        return [
            {
                type: EventType.RUN_STARTED,
                threadId: this.#threadId,
                runId: this.#runId,
                ...(input ? { input } : {}),
            },
        ];
    }

    async translate(ev: AgentEvent): Promise<AGUIEvent[]> {
        if (this.#done) return [];
        const out: AGUIEvent[] = [];
        const lane = this.#lane(ev.branch?.runId);
        const sub = lane.subagentRunId ? { subagentRunId: lane.subagentRunId } : {};
        // A continued session sends no run_created, so the first trunk event opens the step.
        if (!ev.branch && !this.#agent) {
            this.#agent = ev.agent;
            out.push({ type: EventType.STEP_STARTED, stepName: ev.agent });
        }

        switch (ev.type) {
            case 'thinking_delta': {
                if (!ev.delta) break;
                this.#endText(lane, out);
                if (!lane.reasoning) {
                    lane.reasoning = this.#newId();
                    out.push(
                        { type: EventType.REASONING_START, messageId: lane.reasoning, ...sub },
                        {
                            type: EventType.REASONING_MESSAGE_START,
                            messageId: lane.reasoning,
                            role: 'reasoning',
                            ...sub,
                        },
                    );
                }
                out.push({
                    type: EventType.REASONING_MESSAGE_CONTENT,
                    messageId: lane.reasoning,
                    delta: ev.delta,
                    ...sub,
                });
                break;
            }
            case 'text_delta':
                if (!ev.delta) break;
                this.#endReasoning(lane, out);
                this.#text(lane, ev.agent, ev.delta, out);
                lane.streamedText = true;
                break;
            case 'tool_call_detected':
                this.#endReasoning(lane, out);
                this.#startTool(lane, ev.callId, ev.name, out);
                break;
            case 'tool_args_delta':
                if (!lane.tools.has(ev.callId)) this.#startTool(lane, ev.callId, ev.name, out);
                if (ev.delta) {
                    out.push({
                        type: EventType.TOOL_CALL_ARGS,
                        toolCallId: ev.callId,
                        delta: ev.delta,
                        ...sub,
                    });
                }
                break;
            case 'before_llm_call':
                lane.streamedText = false;
                lane.tools.clear();
                break;
            case 'after_llm_call': {
                this.#endReasoning(lane, out);
                // A model that does not stream says everything here, at once.
                if (!lane.streamedText) {
                    const text = await this.#resolve(ev.node.text);
                    if (text.trim()) this.#text(lane, ev.agent, text, out);
                }
                this.#endText(lane, out, { model: ev.node.model, usage: ev.node.usage });
                for (const call of ev.node.toolCalls) {
                    if (!lane.tools.has(call.callId)) {
                        this.#startTool(lane, call.callId, call.name, out);
                        const args = await this.#resolve(call.args);
                        if (args) {
                            out.push({
                                type: EventType.TOOL_CALL_ARGS,
                                toolCallId: call.callId,
                                delta: args,
                                ...sub,
                            });
                        }
                    }
                    out.push({ type: EventType.TOOL_CALL_END, toolCallId: call.callId, ...sub });
                }
                lane.tools.clear();
                break;
            }
            case 'after_tool_call': {
                const content = clip(await this.#resolve(ev.node.result));
                out.push({
                    type: EventType.TOOL_CALL_RESULT,
                    messageId: this.#newId(),
                    toolCallId: ev.node.callId,
                    content,
                    role: 'tool',
                    ...sub,
                    ...(ev.node.isError ? { metadata: { isError: true } } : {}),
                });
                break;
            }
            case 'handoff':
                this.#endReasoning(lane, out);
                this.#endText(lane, out);
                out.push(
                    { type: EventType.STEP_FINISHED, stepName: ev.from, ...sub },
                    { type: EventType.STEP_STARTED, stepName: ev.to, ...sub },
                );
                if (!ev.branch) this.#agent = ev.to;
                break;
            case 'before_fork':
                this.#forks.set(ev.node.id, ev.node.callId);
                break;
            case 'branch_started': {
                const parentToolCallId = this.#forks.get(ev.child.forkId);
                out.push({
                    type: EventType.SUBAGENT_STARTED,
                    subagentRunId: ev.child.runId,
                    name: ev.child.name,
                    description: ev.childState.agentName,
                    ...(lane.subagentRunId ? { parentSubagentRunId: lane.subagentRunId } : {}),
                    ...(parentToolCallId ? { parentToolCallId } : {}),
                });
                break;
            }
            case 'branch_finished': {
                const child = this.#lane(ev.child.runId);
                this.#endReasoning(child, out);
                this.#endText(child, out);
                this.#lanes.delete(ev.child.runId);
                if (ev.status === 'ok') {
                    out.push({ type: EventType.SUBAGENT_FINISHED, subagentRunId: ev.child.runId });
                } else {
                    out.push({
                        type: EventType.SUBAGENT_ERROR,
                        subagentRunId: ev.child.runId,
                        message: ev.childState.error ?? `branch ${ev.child.name} ${ev.status}`,
                        code: ev.status,
                    });
                }
                break;
            }
            case 'run_finished':
                // A branch's own end is reported by branch_finished on its parent.
                if (!ev.branch) out.push(...this.#finish(ev.result));
                break;
            default:
                break;
        }
        return out;
    }

    /** The end of a run that stopped without a run_finished: an exception or a cancel. */
    fail(err: unknown, code = 'error'): AGUIEvent[] {
        if (this.#done) return [];
        const out = this.#closeAll();
        this.#done = true;
        if (this.#agent) out.push({ type: EventType.STEP_FINISHED, stepName: this.#agent });
        const message = err instanceof Error ? err.message : String(err);
        out.push({ type: EventType.RUN_ERROR, message, code });
        return out;
    }

    #finish(result: RunResult<unknown>): AGUIEvent[] {
        const out = this.#closeAll();
        this.#done = true;
        if (this.#agent) out.push({ type: EventType.STEP_FINISHED, stepName: this.#agent });
        const usage = [toAguiUsage(result.usage)];
        if (result.stopReason === 'failed') {
            out.push({
                type: EventType.RUN_ERROR,
                message: result.state.error ?? 'the run failed',
                code: 'failed',
                usage,
            });
            return out;
        }
        out.push({
            type: EventType.RUN_FINISHED,
            threadId: this.#threadId,
            runId: this.#runId,
            outcome:
                result.stopReason === 'aborted'
                    ? { type: 'cancelled' }
                    : // 'suspended' is newer than some @zenera/neo typings this compiles against.
                      (result.stopReason as string) === 'suspended'
                      ? { type: 'interrupt', interrupts: interruptsOf(result.state) }
                      : { type: 'success' },
            result: { agent: result.agent },
            usage,
        });
        return out;
    }

    #closeAll(): AGUIEvent[] {
        const out: AGUIEvent[] = [];
        for (const lane of this.#lanes.values()) {
            this.#endReasoning(lane, out);
            this.#endText(lane, out);
            const sub = lane.subagentRunId ? { subagentRunId: lane.subagentRunId } : {};
            for (const callId of lane.tools.keys()) {
                out.push({ type: EventType.TOOL_CALL_END, toolCallId: callId, ...sub });
            }
            lane.tools.clear();
        }
        return out;
    }

    #lane(subagentRunId: string | undefined): Lane {
        const key = subagentRunId ?? '';
        let lane = this.#lanes.get(key);
        if (!lane) {
            lane = { subagentRunId, streamedText: false, tools: new Map() };
            this.#lanes.set(key, lane);
        }
        return lane;
    }

    #text(lane: Lane, agent: string, delta: string, out: AGUIEvent[]): void {
        const sub = lane.subagentRunId ? { subagentRunId: lane.subagentRunId } : {};
        if (!lane.text) {
            lane.text = this.#newId();
            out.push({
                type: EventType.TEXT_MESSAGE_START,
                messageId: lane.text,
                role: 'assistant',
                name: agent,
                ...sub,
            });
        }
        out.push({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: lane.text, delta, ...sub });
    }

    #endText(lane: Lane, out: AGUIEvent[], call?: { model: string; usage: TokenUsage }): void {
        if (!lane.text) return;
        const sub = lane.subagentRunId ? { subagentRunId: lane.subagentRunId } : {};
        out.push({
            type: EventType.TEXT_MESSAGE_END,
            messageId: lane.text,
            ...sub,
            ...(call ? { metadata: { model: call.model, usage: toAguiUsage(call.usage) } } : {}),
        });
        lane.text = undefined;
    }

    #endReasoning(lane: Lane, out: AGUIEvent[]): void {
        if (!lane.reasoning) return;
        const sub = lane.subagentRunId ? { subagentRunId: lane.subagentRunId } : {};
        out.push(
            { type: EventType.REASONING_MESSAGE_END, messageId: lane.reasoning, ...sub },
            { type: EventType.REASONING_END, messageId: lane.reasoning, ...sub },
        );
        lane.reasoning = undefined;
    }

    #startTool(lane: Lane, callId: string, name: string, out: AGUIEvent[]): void {
        lane.tools.set(callId, { name });
        out.push({
            type: EventType.TOOL_CALL_START,
            toolCallId: callId,
            toolCallName: name,
            ...(lane.text ? { parentMessageId: lane.text } : {}),
            ...(lane.subagentRunId ? { subagentRunId: lane.subagentRunId } : {}),
        });
    }
}

export function toAguiUsage(u: TokenUsage): AguiUsage {
    return {
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        totalTokens: u.inputTokens + u.outputTokens,
        reasoningTokens: u.reasoningTokens,
        cachedInputTokens: u.cachedInputTokens,
    };
}
