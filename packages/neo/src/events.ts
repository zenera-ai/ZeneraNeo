import type { AgentState, RunResult } from './state.ts';
import type { ForkNode, JoinNode, LlmCallNode, ToolResultNode } from './trajectory.ts';
import type { Payload } from './payload.ts';

// ---------------------------------------------------------------------------
// Events — two tiers: ephemeral stream deltas and resumable checkpoints
// ---------------------------------------------------------------------------

export interface BranchRef {
    /** the fork that created this branch */
    forkId: string;
    /** declared branch name */
    name: string;
    /** the child run's id */
    runId: string;
    /** spec.forkDepth of the emitting run */
    depth: number;
}

export interface EventBase {
    /** emitting run (the root run id on the trunk) */
    runId: string;
    /** active agent in that run */
    agent: string;
    /** absent on the trunk; set on every event emitted by a branch */
    branch?: BranchRef;
}

/**
 * What a `Model` produces while streaming. It carries no `EventBase`: a model
 * knows nothing about runs or branches, so the runner tags these before they
 * reach consumers.
 */
export type StreamDelta =
    | { type: 'thinking_delta'; delta: string }
    | { type: 'text_delta'; delta: string }
    | { type: 'tool_args_delta'; callId: string; name: string; delta: string; argsSoFar: string }
    | { type: 'tool_call_detected'; callId: string; name: string };

/** Fine-grained progress. Never required for correctness; safe to drop. */
export type StreamEvent = EventBase & StreamDelta;

/**
 * Coarse-grained state transitions. The `state` in every checkpoint is a
 * complete snapshot: persist it, and `runner.resume(state)` continues the run
 * with no loss.
 */
export type CheckpointEvent = EventBase &
    (
        | { type: 'run_created'; state: AgentState }
        | { type: 'before_llm_call'; state: AgentState }
        | { type: 'after_llm_call'; state: AgentState; node: LlmCallNode }
        | { type: 'before_tool_call'; state: AgentState; call: PendingToolCall }
        | { type: 'after_tool_call'; state: AgentState; node: ToolResultNode }
        | { type: 'handoff'; state: AgentState; from: string; to: string }
        | { type: 'before_fork'; state: AgentState; node: ForkNode }
        | { type: 'branch_started'; state: AgentState; child: BranchRef; childState: AgentState }
        | {
              type: 'branch_finished';
              state: AgentState;
              child: BranchRef;
              childState: AgentState;
              status: 'ok' | 'error' | 'aborted';
          }
        | { type: 'after_join'; state: AgentState; node: JoinNode }
        | { type: 'run_finished'; state: AgentState; result: RunResult<unknown> }
    );

/**
 * What the runner says while a provider keeps failing a model call it is
 * about to make again (see `RunnerOptions.modelRetry`). No state, so like a
 * delta it is safe to drop.
 */
export type RetryNotice =
    | {
          type: 'model_retry';
          /** the attempt that failed, from 1 */
          attempt: number;
          error: string;
          status?: number;
          /** when the next attempt goes, ISO */
          retryAt: string;
          model: string;
      }
    | { type: 'model_retry_recovered'; attempts: number };

export type RetryEvent = EventBase & RetryNotice;

export type AgentEvent = StreamEvent | CheckpointEvent | RetryEvent;

export interface PendingToolCall {
    callId: string;
    name: string;
    args: Payload;
}

export function isCheckpoint(e: AgentEvent): e is CheckpointEvent {
    return 'state' in e;
}

// ---------------------------------------------------------------------------
// RunStream
// ---------------------------------------------------------------------------

/**
 * A run has two audiences: observers that want every step, and callers that
 * only want the answer. `RunStream` serves both over a single generator.
 *
 *   await runner.run(a, 'hi')                     // RunResult (thenable)
 *   await runner.run(a, 'hi').text()              // string
 *   for await (const e of runner.run(a, 'hi')) {} // events
 */
export class RunStream<T = string> implements AsyncIterable<AgentEvent>, PromiseLike<RunResult<T>> {
    readonly #gen: AsyncGenerator<AgentEvent, RunResult<T>>;
    #result?: Promise<RunResult<T>>;
    #done?: RunResult<T>;

    constructor(gen: AsyncGenerator<AgentEvent, RunResult<T>>) {
        this.#gen = gen;
    }

    /**
     * `for await` discards the generator's *return* value, so it is latched here
     * on the way past: a loop that runs to completion and a later `final()` then
     * see the same result instead of `undefined`.
     */
    async #next(): Promise<IteratorResult<AgentEvent, RunResult<T>>> {
        if (this.#done) {
            return { done: true, value: this.#done };
        }
        const step = await this.#gen.next();
        if (step.done) {
            this.#done = step.value;
        }
        return step;
    }

    /**
     * Iteration is single-pass and shared with `final()`: a partially consumed
     * stream resumes where the loop stopped instead of re-running the agent.
     */
    [Symbol.asyncIterator](): AsyncIterator<AgentEvent, RunResult<T> | undefined> {
        return {
            next: () => this.#next(),
            // `break` calls this. Closing the underlying generator would abandon
            // the run half-way, so the run is left alive on purpose — `final()`
            // still drives it to the end. Cancellation belongs to the signal.
            return: async () => ({ done: true as const, value: this.#done }),
        };
    }

    /**
     * Drains whatever events are left and yields the run's result. The `??=`
     * memoizes, so calling it twice gives the same result.
     */
    final(): Promise<RunResult<T>> {
        this.#result ??= (async () => {
            for (;;) {
                const step = await this.#next();
                if (step.done) {
                    return step.value;
                }
            }
        })();
        return this.#result;
    }

    async text(): Promise<string> {
        const r = await this.final();
        return typeof r.output === 'string' ? r.output : JSON.stringify(r.output);
    }

    /**
     * Implementing `then` makes the object a thenable, so `await` unwraps it
     * exactly like a promise. Note this also starts draining the stream.
     */
    then<A = RunResult<T>, B = never>(
        onOk?: ((r: RunResult<T>) => A | PromiseLike<A>) | null,
        onErr?: ((e: unknown) => B | PromiseLike<B>) | null,
    ): Promise<A | B> {
        return this.final().then(onOk, onErr);
    }
}

/**
 * Branches run concurrently, so their events cannot be `yield*`-ed one stream
 * at a time. They are pushed here instead and drained by the parent generator
 * while it awaits the branch promises.
 */
export class EventQueue<T> {
    #items: T[] = [];
    #wake?: () => void;
    #closed = false;

    push(v: T): void {
        this.#items.push(v);
        this.#wake?.();
        this.#wake = undefined;
    }

    close(): void {
        this.#closed = true;
        this.#wake?.();
        this.#wake = undefined;
    }

    async *drain(): AsyncGenerator<T> {
        for (;;) {
            while (this.#items.length) {
                yield this.#items.shift() as T;
            }
            if (this.#closed) {
                return;
            }
            await new Promise<void>((resolve) => {
                this.#wake = resolve;
            });
        }
    }
}
