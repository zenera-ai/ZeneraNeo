import type { MemoryEdge, MemoryQuery } from './memory/types.ts';
import type { Payload, PayloadResolver } from './payload.ts';
import type { PromptSource } from './prompt.ts';
import {
    addUsage,
    zeroUsage,
    type AssistantMessage,
    type MediaKind,
    type Message,
    type TokenUsage,
    type ToolCall,
} from './types.ts';

// ---------------------------------------------------------------------------
// Trajectory — the append-only source of truth
// ---------------------------------------------------------------------------

export interface NodeBase {
    /** ulid — unique within a trajectory */
    id: string;
    /** ISO timestamp (informational, not used for logic) */
    ts: string;
    /** active agent when the node was created */
    agent: string;
}

/** A content part whose text lives behind a payload reference. */
export type PayloadPart =
    { type: 'text'; text: Payload } | { type: MediaKind; url: string; mimeType?: string };

export interface UserInputNode extends NodeBase {
    type: 'user_input';
    content: PayloadPart[];
    /** produced by the runtime (e.g. a "call final_output" nudge), not the user */
    synthetic?: boolean;
}

export interface SystemPromptNode extends NodeBase {
    type: 'system_prompt';
    /** exactly what the provider received */
    prompt: Payload;
    /**
     * The file-backed contributors, in the order they were rendered — the
     * answer to "which file do I edit to change this?". Inline text, the skill
     * index and runtime notes are inside `prompt` but not listed here: none of
     * them is a document anyone opens.
     */
    sources?: PromptSource[];
}

export interface LoadSkillsNode extends NodeBase {
    type: 'load_skills';
    provider: string;
    skills: { name: string; version?: string; contentHash: string; file?: string }[];
    /** concatenated instructions the model saw */
    content: Payload;
    /** tools this activation unlocked */
    toolNames: string[];
}

export interface MemoryRecallNode extends NodeBase {
    type: 'memory_recall';
    query: MemoryQuery;
    /** the matches; the rest of `nodes` is the subgraph stitched around them */
    seeds: string[];
    /** ids, not bodies — the rendered block is the payload */
    nodes: { id: string; kind: string; score: number }[];
    edges: MemoryEdge[];
    content: Payload;
}

export interface MemoryOpNode extends NodeBase {
    type: 'memory_op';
    op: 'commit' | 'forget' | 'load' | 'grep';
    /** sha256(runId, callId) — deterministic, so a replay is deduplicated */
    opId: string;
    nodes: { id: string; kind: string; revision: number }[];
    edges: MemoryEdge[];
    files: number;
}

export interface LlmCallNode extends NodeBase {
    type: 'llm_call';
    /** exact model id used */
    model: string;
    /**
     * The ref that names the model again, `provider/id` — absent from runs
     * recorded before it was, and for models not built by a registry.
     */
    ref?: string;
    /** sha256 of the projected request, for replay checks */
    requestDigest: string;
    request?: Payload;
    text: Payload;
    thinking?: Payload;
    /** `signature` is opaque provider state — see `ToolCall.signature` */
    toolCalls: { callId: string; name: string; args: Payload; signature?: string }[];
    usage: TokenUsage;
    stopReason: 'stop' | 'tool_calls' | 'length' | 'content_filter';
}

export interface ToolCallNode extends NodeBase {
    type: 'tool_call';
    callId: string;
    name: string;
    args: Payload;
}

export interface ToolResultNode extends NodeBase {
    type: 'tool_result';
    callId: string;
    name: string;
    result: Payload;
    isError: boolean;
    durationMs?: number;
}

export interface HandoffNode extends NodeBase {
    type: 'handoff';
    from: string;
    to: string;
    reason?: string;
}

export interface ForkNode extends NodeBase {
    type: 'fork';
    /** the fork tool call that caused it — also the fork's identity */
    callId: string;
    contextMode: 'inherit' | 'compact' | 'none';
    branches: {
        name: string;
        agent: string;
        instructions: Payload;
        childRunId: string;
    }[];
}

/**
 * The outcome of a fork. Each branch's own history hangs off its row: fork is a
 * scope, and nesting makes that structural rather than conventional — a walk of
 * the parent array simply never encounters a branch node.
 */
export interface JoinNode extends NodeBase {
    type: 'join';
    /** the fork tool call this answers */
    callId: string;
    /** always in declared branch order, never completion order */
    branches: {
        name: string;
        agent: string;
        status: 'ok' | 'error' | 'aborted';
        output: Payload;
        error?: string;
        /** display only — the branch's own `llm_call` nodes carry the tokens */
        usage: TokenUsage;
        /**
         * What the branch did. Never projected into the parent's prompt; kept
         * for audit, accounting and export. A nested fork's history hangs off
         * a `join` in here, so depth costs nothing but recursion.
         */
        nodes: TrajectoryNode[];
    }[];
    /** display only; `totalUsage` recurses into the branches instead */
    usage: TokenUsage;
}

/**
 * Collapses a set of nodes into one summary. The covered nodes stay in the
 * trajectory — the log is append-only — and only the projection skips them.
 */
export interface CompactionNode extends NodeBase {
    type: 'compaction';
    /** real when the model called `compact`, synthesized when policy-driven */
    callId: string;
    /** ids of the nodes this summary replaces */
    covers: string[];
    summary: Payload;
    reason: 'handoff_noise' | 'token_budget' | 'branch_context' | 'manual' | string;
    /** what the summarizer itself burned */
    usage: TokenUsage;
}

export interface FinalOutputNode extends NodeBase {
    type: 'final_output';
    output: Payload;
    /** present when an output schema was set */
    parsed?: unknown;
}

export type TrajectoryNode =
    | UserInputNode
    | SystemPromptNode
    | LoadSkillsNode
    | MemoryRecallNode
    | MemoryOpNode
    | LlmCallNode
    | ToolCallNode
    | ToolResultNode
    | HandoffNode
    | ForkNode
    | JoinNode
    | CompactionNode
    | FinalOutputNode;

export type NodeBody<T extends TrajectoryNode> = Omit<T, keyof NodeBase>;

// ---------------------------------------------------------------------------
// Derived views
// ---------------------------------------------------------------------------

/**
 * Ids replaced by a compaction. A branch's compactions live inside its own
 * `nodes` array, so they are structurally out of reach here — a branch can
 * never collapse the parent's history, even though it may compact the prefix
 * it inherited and name ids the parent also has.
 *
 * The union is unconditional, so compaction is monotone: once a node has been
 * summarized it stays hidden, even if a later compaction covers the summary.
 */
export function coveredIds(nodes: TrajectoryNode[]): Set<string> {
    const out = new Set<string>();
    for (const n of nodes) {
        if (n.type === 'compaction') {
            for (const id of n.covers) {
                out.add(id);
            }
        }
    }
    return out;
}

/**
 * What the model sees. Compaction hides nodes, it never deletes them: the
 * trajectory is append-only, and audit and replay always see the full history.
 */
export function projected(nodes: TrajectoryNode[]): TrajectoryNode[] {
    const covered = coveredIds(nodes);
    return covered.size ? nodes.filter((n) => !covered.has(n.id)) : nodes;
}

/**
 * Total consumption, including every token spent inside a fork at any depth.
 * This is the one place that deliberately crosses the branch boundary, so the
 * recursion is the explicit opt-in; `JoinNode.usage` is display only and is not
 * added, since counting it too would double every branch.
 */
export function totalUsage(trajectory: TrajectoryNode[]): TokenUsage {
    return trajectory.reduce((acc, n) => {
        if (n.type === 'llm_call' || n.type === 'compaction') {
            return addUsage(acc, n.usage);
        }
        if (n.type === 'join') {
            return n.branches.reduce((sum, b) => addUsage(sum, totalUsage(b.nodes)), acc);
        }
        return acc;
    }, zeroUsage());
}

export interface ModelUsage {
    /** the exact model id the call was served by, as recorded on the node */
    model: string;
    calls: number;
    usage: TokenUsage;
}

/** A summarizer's tokens are real spend, but no node records which model burned them. */
export const COMPACTION_MODEL = '(compaction)';

/**
 * `totalUsage`, split by the model that spent it. The same walk and the same
 * recursion into branches, so the rows always add back up to the total — which
 * is the point: a run that used three models must not report one number that
 * belongs to none of them. Heaviest first, since that is the one being asked
 * about.
 */
export function usageByModel(trajectory: TrajectoryNode[]): ModelUsage[] {
    const into = new Map<string, ModelUsage>();
    collect(trajectory, into);
    return sorted(into);
}

/** Folds splits together: many turns of one run, or many items of a batch. */
export function mergeModelUsage(...lists: readonly (readonly ModelUsage[])[]): ModelUsage[] {
    const into = new Map<string, ModelUsage>();
    for (const list of lists) {
        for (const one of list) {
            fold(into, one);
        }
    }
    return sorted(into);
}

function collect(trajectory: TrajectoryNode[], into: Map<string, ModelUsage>): void {
    for (const n of trajectory) {
        if (n.type === 'llm_call') {
            fold(into, { model: n.model, calls: 1, usage: n.usage });
        } else if (n.type === 'compaction') {
            fold(into, { model: COMPACTION_MODEL, calls: 1, usage: n.usage });
        } else if (n.type === 'join') {
            for (const branch of n.branches) {
                collect(branch.nodes, into);
            }
        }
    }
}

function fold(into: Map<string, ModelUsage>, one: ModelUsage): void {
    const had = into.get(one.model);
    into.set(
        one.model,
        had
            ? {
                  model: had.model,
                  calls: had.calls + one.calls,
                  usage: addUsage(had.usage, one.usage),
              }
            : { model: one.model, calls: one.calls, usage: one.usage },
    );
}

function sorted(into: Map<string, ModelUsage>): ModelUsage[] {
    const spent = (m: ModelUsage) => m.usage.inputTokens + m.usage.outputTokens;
    return [...into.values()].sort((a, b) => spent(b) - spent(a) || a.model.localeCompare(b.model));
}

export function lastOfType<T extends TrajectoryNode['type']>(
    trajectory: TrajectoryNode[],
    type: T,
): Extract<TrajectoryNode, { type: T }> | undefined {
    for (let i = trajectory.length - 1; i >= 0; i--) {
        if (trajectory[i].type === type) {
            return trajectory[i] as Extract<TrajectoryNode, { type: T }>;
        }
    }
    return undefined;
}

/** What a node contributes to the *projection* — not everything it references. */
export function nodePayloads(n: TrajectoryNode): Payload[] {
    switch (n.type) {
        case 'user_input':
            return n.content.flatMap((p) => (p.type === 'text' ? [p.text] : []));
        case 'system_prompt':
            return [n.prompt];
        case 'load_skills':
            return [n.content];
        case 'memory_recall':
            return [n.content];
        case 'llm_call':
            return [n.text, ...n.toolCalls.map((c) => c.args)];
        case 'tool_call':
            return [n.args];
        case 'tool_result':
            return [n.result];
        case 'join':
            // Branch histories are not projected; only their outputs are.
            return n.branches.map((b) => b.output);
        case 'compaction':
            return [n.summary];
        case 'final_output':
            return [n.output];
        default:
            // memory_op / handoff / fork carry only provenance in the projection
            return [];
    }
}

// ---------------------------------------------------------------------------
// Projection: trajectory → messages
// ---------------------------------------------------------------------------

export interface Projection {
    system?: string;
    messages: Message[];
}

export async function projectMessages(
    trajectory: TrajectoryNode[],
    payloads: PayloadResolver,
): Promise<Projection> {
    const visible = projected(trajectory);
    const blobs = await payloads.getMany(visible.flatMap(nodePayloads));
    const get = (p: Payload): string => blobs.get(p.sha256) ?? '';

    let system: string | undefined;
    const messages: Message[] = [];

    for (const n of visible) {
        switch (n.type) {
            case 'system_prompt':
                // Last one wins; earlier prompts are superseded, not emitted.
                system = get(n.prompt);
                break;
            case 'user_input':
                messages.push({
                    role: 'user',
                    content: n.content.map((p) =>
                        p.type === 'text'
                            ? { type: 'text' as const, text: get(p.text) }
                            : { type: p.type, url: p.url, mimeType: p.mimeType },
                    ),
                });
                break;
            case 'load_skills':
            case 'memory_recall': {
                const content = get(n.content);
                if (content) {
                    messages.push({ role: 'user', content: [{ type: 'text', text: content }] });
                }
                break;
            }
            case 'llm_call': {
                const toolCalls: ToolCall[] = n.toolCalls.map((c) => ({
                    id: c.callId,
                    name: c.name,
                    args: get(c.args),
                    signature: c.signature,
                }));
                messages.push({
                    role: 'assistant',
                    content: get(n.text),
                    toolCalls: toolCalls.length ? toolCalls : undefined,
                    agent: n.agent,
                });
                break;
            }
            case 'tool_call':
                // Already folded into the owning llm_call; the standalone node
                // exists only so a checkpoint can be cut before execution.
                break;
            case 'tool_result':
                messages.push({
                    role: 'tool',
                    callId: n.callId,
                    name: n.name,
                    content: get(n.result),
                    isError: n.isError || undefined,
                });
                break;
            case 'join': {
                const rendered = n.branches
                    .map(
                        (b) =>
                            `### ${b.name} (${b.status})\n` +
                            (b.status === 'ok' ? get(b.output) : (b.error ?? get(b.output))),
                    )
                    .join('\n\n');
                messages.push({
                    role: 'tool',
                    callId: n.callId,
                    name: 'fork',
                    content: rendered,
                    isError: n.branches.some((b) => b.status !== 'ok') || undefined,
                });
                break;
            }
            case 'compaction': {
                // A tool-call pair, not a user message: the summary is the
                // runtime's, and putting it in the user's mouth misattributes
                // it. Both halves come from this one node, so a later
                // compaction removes them together and cannot orphan either.
                messages.push({
                    role: 'assistant',
                    content: '',
                    agent: n.agent,
                    toolCalls: [
                        {
                            id: n.callId,
                            name: 'compact',
                            args: JSON.stringify({ reason: n.reason, nodes: n.covers.length }),
                        },
                    ],
                });
                messages.push({
                    role: 'tool',
                    callId: n.callId,
                    name: 'compact',
                    content: get(n.summary),
                });
                break;
            }
            case 'final_output':
                {
                    const text = get(n.output);
                    const prev = messages.at(-1);
                    // An untyped run ends by simply answering, and the kernel
                    // records that answer as a node of its own — so the text is
                    // already in the projection as the assistant's last turn.
                    // Emitting it again would duplicate a whole turn in every
                    // later request of a multi-turn conversation, and in every
                    // branch that inherits one. A typed run has no such twin:
                    // its answer travelled as tool-call arguments, and the
                    // assistant message that carried them is gone.
                    if (prev?.role !== 'assistant' || prev.content !== text) {
                        messages.push({ role: 'assistant', content: text, agent: n.agent });
                    }
                }
                break;
            default:
                // handoff / memory_op / fork project through other nodes
                break;
        }
    }

    return { system, messages: repairToolCalls(messages) };
}

/**
 * Providers reject a thread whose assistant tool call has no matching tool
 * message — and vice versa. Compaction can cover either side of a pair, so the
 * projection drops the orphaned half instead of producing an invalid request.
 * This is also what makes non-contiguous compaction safe, and what keeps an
 * unanswered `fork` call out of an inheriting branch's prompt.
 */
function repairToolCalls(messages: Message[]): Message[] {
    const called = new Set(
        messages.flatMap((m) =>
            m.role === 'assistant' ? (m.toolCalls ?? []).map((c) => c.id) : [],
        ),
    );
    const kept = messages.filter((m) => m.role !== 'tool' || called.has(m.callId));
    const answered = new Set(kept.flatMap((m) => (m.role === 'tool' ? [m.callId] : [])));
    const out: Message[] = [];
    for (const m of kept) {
        if (m.role !== 'assistant' || !m.toolCalls?.length) {
            out.push(m);
            continue;
        }
        const calls = m.toolCalls.filter((c) => answered.has(c.id));
        if (!calls.length && !m.content) {
            continue;
        }
        const fixed: AssistantMessage = { ...m, toolCalls: calls.length ? calls : undefined };
        out.push(fixed);
    }
    return out;
}
