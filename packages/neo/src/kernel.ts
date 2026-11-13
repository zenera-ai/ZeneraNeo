import { z } from 'zod';
import { Agent, AgentRegistry, handoffTarget, handoffTool } from './agent.ts';
import type { PendingToolCall } from './events.ts';
import { FORK_DESCRIPTION, forkParameters } from './fork.ts';
import { systemClock, type IdClock } from './ids.ts';
import { renderPreferences } from './memory/render.ts';
import { memoryTools } from './memory/tools.ts';
import type { MemoryOpSpec, MemoryRecallSpec } from './memory/types.ts';
import type { ModelRequest, ModelResponse } from './model.ts';
import { hash, type Payload } from './payload.ts';
import { composePrompt } from './prompt.ts';
import type { Services } from './services.ts';
import {
    allows,
    lockedSkillTools,
    renderSkillIndex,
    renderSkills,
    skillContentHash,
    skillTools,
    type Skill,
    type SkillLoadSpec,
} from './skills.ts';
import type { AgentState, RunPhase, RunSpec } from './state.ts';
import {
    lastOfType,
    projectMessages,
    projected,
    totalUsage,
    type CompactionNode,
    type FinalOutputNode,
    type ForkNode,
    type HandoffNode,
    type JoinNode,
    type LlmCallNode,
    type LoadSkillsNode,
    type MemoryOpNode,
    type MemoryRecallNode,
    type NodeBody,
    type PayloadPart,
    type SystemPromptNode,
    type ToolCallNode,
    type ToolResultNode,
    type TrajectoryNode,
    type UserInputNode,
} from './trajectory.ts';
import {
    FINAL_OUTPUT_TOOL,
    FORK_TOOL,
    addUsage,
    parseArgs,
    toContent,
    zeroUsage,
    type AnyTool,
    type Input,
    type JsonSchema,
    type SuspendSpec,
    type Suspension,
    type TokenUsage,
    type ToolOutcome,
    type ToolSchema,
} from './types.ts';

/**
 * The kernel is a module of plain functions: it holds no state and no
 * configuration, so there is nothing to instantiate and nothing hidden. All
 * nondeterminism (ids, clock) and all I/O (payloads, memory, skills) enter
 * through the explicit `KernelEnv` argument, which is what makes the same code
 * usable inside a replay-based workflow engine.
 *
 * Deviation from the spec worth knowing: several `apply*` and `createState` are
 * async, because offloading a value to the `PayloadStore` is I/O. Nothing else
 * in the kernel touches the outside world.
 */
export interface KernelEnv {
    services: Services;
    /** Zod schema of a typed run; must match `state.spec.outputSchemaHash`. */
    output?: z.ZodType;
    clock?: IdClock;
}

const FINAL_OUTPUT_INSTRUCTIONS =
    `When you have the complete answer, deliver it by calling the \`${FINAL_OUTPUT_TOOL}\` ` +
    `tool with arguments matching its schema. Plain prose is not accepted as the final answer.`;

// ---------------------------------------------------------------------------
// Node drafting
// ---------------------------------------------------------------------------

interface Draft {
    add<T extends TrajectoryNode>(body: NodeBody<T>, agent?: string): T;
    commit(patch: Partial<AgentState>): AgentState;
}

/**
 * Every `apply*` returns a *new* state object; old snapshots stay valid, which
 * is exactly what a checkpointing caller needs. Nodes carry no index: the array
 * *is* the order.
 */
function begin(state: AgentState, env: KernelEnv): Draft {
    const clock = env.clock ?? systemClock;
    const nodes: TrajectoryNode[] = [];
    return {
        add<T extends TrajectoryNode>(body: NodeBody<T>, agent = state.agentName): T {
            const node = {
                id: clock.newId(),
                ts: clock.now(),
                agent,
                ...body,
            } as T;
            nodes.push(node);
            return node;
        },
        commit(patch: Partial<AgentState>): AgentState {
            const trajectory = [...state.trajectory, ...nodes];
            return { ...state, ...patch, trajectory, usage: ownUsage(state, trajectory) };
        },
    };
}

/**
 * What *this* run consumed. A branch starts from a copy of the parent's prefix,
 * whose `llm_call` nodes were paid for by the parent, so they are excluded.
 */
function ownUsage(state: AgentState, trajectory: TrajectoryNode[]): TokenUsage {
    return totalUsage(trajectory.slice(state.spec.prefixLength ?? 0));
}

function put(env: KernelEnv, value: string): Promise<Payload> {
    return env.services.payloads.put(value);
}

function get(env: KernelEnv, payload: Payload): Promise<string> {
    return env.services.payloads.get(payload);
}

async function toPayloadParts(env: KernelEnv, input: Input): Promise<PayloadPart[]> {
    return Promise.all(
        toContent(input).map(async (p): Promise<PayloadPart> =>
            p.type === 'text'
                ? { type: 'text', text: await put(env, p.text) }
                : { type: p.type, url: p.url, mimeType: p.mimeType },
        ),
    );
}

// ---------------------------------------------------------------------------
// State creation
// ---------------------------------------------------------------------------

export interface CreateStateOptions<T = string, TCtx = unknown> {
    /** default: a fresh ulid */
    runId?: string;
    /** starting agent name */
    agent: string;
    input?: Input;
    /** app context — must be JSON-serializable */
    context?: TCtx;
    /** typed-result request: the source of both `T` and validation */
    output?: z.ZodType<T>;
    /** pre-rendered; otherwise rendered on the first step */
    systemPrompt?: string;
    maxForkDepth?: number;
}

/**
 * The only way to obtain a state. Starting a run is explicit; the loop then
 * only ever *advances* an existing state.
 */
export async function createState<T = string, TCtx = unknown>(
    opts: CreateStateOptions<T, TCtx>,
    env: KernelEnv,
): Promise<AgentState> {
    const clock = env.clock ?? systemClock;
    const spec: RunSpec = {
        startAgent: opts.agent,
        forkDepth: 0,
        maxForkDepth: opts.maxForkDepth ?? 2,
    };
    if (opts.output) {
        const { schema, wrapped } = outputJsonSchema(opts.output);
        spec.outputSchema = schema;
        spec.outputSchemaHash = hash(JSON.stringify(schema));
        spec.outputWrapped = wrapped;
    }

    const state: AgentState = {
        version: 1,
        runId: opts.runId ?? clock.newId(),
        spec,
        agentName: opts.agent,
        phase: 'created',
        trajectory: [],
        pendingToolCalls: [],
        usage: zeroUsage(),
        context: opts.context,
    };

    const b = begin(state, env);
    if (opts.systemPrompt !== undefined) {
        b.add<SystemPromptNode>({
            type: 'system_prompt',
            prompt: await put(env, opts.systemPrompt),
        });
    }
    if (opts.input !== undefined) {
        b.add<UserInputNode>({
            type: 'user_input',
            content: await toPayloadParts(env, opts.input),
        });
    }
    return b.commit({ phase: opts.input === undefined ? 'created' : 'awaiting_llm' });
}

/**
 * A Zod schema is a live object with functions, so it cannot live in a
 * JSON-serializable state; its JSON Schema projection can, and must, because it
 * is part of the prompt (the `final_output` tool's parameters).
 */
function outputJsonSchema(schema: z.ZodType): { schema: JsonSchema; wrapped: boolean } {
    let json: unknown;
    try {
        json = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' });
    } catch (e) {
        // Transforms, refinements and z.custom have no JSON Schema equivalent:
        // the model sees the looser shape and safeParse enforces the rest.
        console.warn(`output schema is only partly representable as JSON Schema: ${String(e)}`);
        json = z.toJSONSchema(schema, {
            target: 'draft-2020-12',
            io: 'input',
            unrepresentable: 'any',
        });
    }
    const obj = json as Record<string, unknown>;
    if (obj.type === 'object') {
        return { schema: obj as JsonSchema, wrapped: false };
    }
    // Non-object roots (a bare string, array, union …) cannot be tool
    // parameters, so they travel in a single `value` property.
    return {
        schema: {
            type: 'object',
            properties: { value: obj },
            required: ['value'],
            additionalProperties: false,
        },
        wrapped: true,
    };
}

/** A persisted run must not silently change its contract on resume. */
export function checkOutputSchema(state: AgentState, env: KernelEnv): void {
    if (!env.output) {
        return;
    }
    const { schema } = outputJsonSchema(env.output);
    const given = hash(JSON.stringify(schema));
    if (state.spec.outputSchemaHash && given !== state.spec.outputSchemaHash) {
        throw new Error(
            `output schema mismatch: run ${state.runId} was created with a different schema`,
        );
    }
}

// ---------------------------------------------------------------------------
// What happens next
// ---------------------------------------------------------------------------

export interface BranchPlan {
    name: string;
    agent: string;
    childRunId: string;
}

export type NextAction =
    | { kind: 'llm' }
    | { kind: 'tools'; calls: PendingToolCall[] }
    | { kind: 'fork'; forkId: string; branches: BranchPlan[] }
    | { kind: 'done'; output: FinalOutputNode };

/** Pure inspection: what must happen next. No I/O, no payload resolution. */
export function nextAction(state: AgentState): NextAction {
    if (state.phase === 'failed') {
        throw new Error(`run ${state.runId} failed: ${state.error ?? 'unknown error'}`);
    }
    if (state.phase === 'done') {
        const output = lastOfType(state.trajectory, 'final_output');
        if (!output) {
            throw new Error(`run ${state.runId} is done but has no final output`);
        }
        return { kind: 'done', output };
    }
    // Tool results are what unblock the next model call, so they come first even
    // when a fork is also pending.
    if (state.pendingToolCalls.length) {
        const byId = new Map(
            state.trajectory.flatMap((n) =>
                n.type === 'tool_call' ? [[n.callId, n] as const] : [],
            ),
        );
        const calls = state.pendingToolCalls.flatMap((id): PendingToolCall[] => {
            const n = byId.get(id);
            return n ? [{ callId: n.callId, name: n.name, args: n.args }] : [];
        });
        if (calls.length) {
            return { kind: 'tools', calls };
        }
    }
    const pendingFork = state.pendingFork;
    if (pendingFork?.branches.length) {
        // Looked up by call id, not by "the last fork node": with two forks in
        // one run the most recent one is not necessarily the pending one.
        const fork = state.trajectory.find(
            (n): n is ForkNode => n.type === 'fork' && n.callId === pendingFork.callId,
        );
        if (fork) {
            const branches = fork.branches
                .filter((b) => pendingFork.branches.includes(b.name))
                .map(({ name, agent, childRunId }) => ({ name, agent, childRunId }));
            return { kind: 'fork', forkId: fork.callId, branches };
        }
    }
    return { kind: 'llm' };
}

// ---------------------------------------------------------------------------
// Tool set — derived from the state, not a static agent property
// ---------------------------------------------------------------------------

/** Agents a branch of this fork may run, in registration order. */
function forkAgents<TCtx>(state: AgentState, reg: AgentRegistry<TCtx>): string[] {
    const allowed = reg.find(state.agentName)?.fork?.agents;
    if (!allowed) {
        return reg.names();
    }
    const known = allowed.filter((n) => reg.find(n));
    return known.length ? known : [state.agentName];
}

/**
 * The tool is withdrawn at the depth cap, so a branch cannot spawn branches
 * forever. `agents/fork-instructions.md` is gated on the same two conditions,
 * from the other side: `requires: [fork]` for the binding, and a `when` on the
 * depth, because a rule about a tool the model does not have is a rule it can
 * only be confused by.
 */
function canFork<TCtx>(agent: Agent<TCtx>, state: AgentState): boolean {
    return Boolean(agent.fork) && state.spec.forkDepth < state.spec.maxForkDepth;
}

/**
 * tools(state) = agent tools + handoffs + memory + skills + fork +
 * final_output. Computed from the state so a rehydrated run offers exactly the
 * tools it had before the crash.
 *
 * Skill-owned tools are declared here whether or not their skill is active: the
 * gate `lockedSkillTools` installs reads the trajectory when the tool is called,
 * not when it is declared, so the array the model is sent never mutates
 * mid-conversation and the provider's prompt cache survives a `skill_load`.
 */
export async function resolveTools<TCtx>(
    state: AgentState,
    reg: AgentRegistry<TCtx>,
    env: KernelEnv,
): Promise<AnyTool<TCtx>[]> {
    const agent = reg.get(state.agentName);
    const ctx = state.context as TCtx;
    const tools: AnyTool<TCtx>[] = [...agent.tools];

    for (const name of agent.handoffs) {
        tools.push(handoffTool<TCtx>(name, reg.find(name)?.description));
    }
    const binding = agent.memoryBinding(ctx);
    if (binding && env.services.memory) {
        tools.push(...memoryTools<TCtx>({ index: env.services.memory, binding }));
    }
    if (agent.skills) {
        const binding = agent.skills;
        tools.push(...skillTools<TCtx>(binding));
        const provider = env.services.skillProvider(binding.provider);
        // An agent-level tool of the same name wins, and is never gated.
        const own = new Set(agent.tools.map((t) => t.name));
        tools.push(...(await lockedSkillTools<TCtx>(binding, provider, own)));
    }
    if (canFork(agent, state)) {
        tools.push({
            name: FORK_TOOL,
            description: FORK_DESCRIPTION,
            parameters: forkParameters(
                forkAgents(state, reg),
                state.agentName,
                agent.fork?.maxBranches,
            ),
            // Never executed as a tool: the runner drives branches and the join
            // becomes the tool result.
            execute: () => 'fork scheduled',
        });
    }
    if (state.spec.outputSchema) {
        tools.push({
            name: FINAL_OUTPUT_TOOL,
            description: 'Deliver the final answer. Ends the run.',
            parameters: state.spec.outputSchema,
            execute: () => 'final output accepted',
        });
    }
    return tools;
}

function toSchema(t: ToolSchema): ToolSchema {
    return { name: t.name, description: t.description, parameters: t.parameters };
}

/**
 * Prompt text the runtime owns rather than the author: the user's standing
 * preferences, the skill index and the `final_output` instruction. Most used to
 * be appended inside `buildRequest`, which meant part of the system prompt
 * existed in no node and showed up in no audit. Composed in now, always last,
 * so the volatile tail never invalidates the cacheable prefix.
 *
 * How to *use* memory is not here: it is the project's own house rules, in
 * `agents/memory-instructions.md`, so that one document is the only place it is
 * written. An agent with memory tools and no such file gets the tool schemas
 * and nothing else - `zen check` warns about it, the runtime does not invent a
 * replacement. Forking is the same, in `agents/fork-instructions.md`.
 */
async function derivedPrompt<TCtx>(
    agent: Agent<TCtx>,
    state: AgentState,
    env: KernelEnv,
): Promise<string[]> {
    const out: string[] = [];
    const memory = agent.memoryBinding(state.context as TCtx);
    if (memory && env.services.memory) {
        // The one part of the prompt that reads mutable state. It is allowed
        // because preferences change at most once in a run and
        // `applySystemPrompt` is keyed on the rendered bytes, so a commit
        // re-renders the prefix once rather than every turn.
        out.push(renderPreferences(env.services.memory.preferences(memory.sees)));
    }
    if (agent.skills?.discovery === 'index') {
        const binding = agent.skills;
        const provider = env.services.skillProvider(binding.provider);
        // Preloaded skills are left out: the index is a menu of what can be
        // fetched, and offering something the agent already has invites a
        // wasted `skill_load`. Filtering on the binding rather than on the
        // trajectory keeps the prompt a function of config, so it stays
        // byte-stable across turns.
        const preloaded = new Set(binding.preload ?? []);
        const index = (await provider.list()).filter(
            (s) => allows(binding, s) && !preloaded.has(s.name),
        );
        const rendered = renderSkillIndex(index, binding.maxIndexEntries ?? 50);
        if (rendered) {
            out.push(rendered);
        }
    }
    if (state.spec.outputSchema) {
        out.push(FINAL_OUTPUT_INSTRUCTIONS);
    }
    return out;
}

/**
 * Projection + tool schemas + system prompt for the active agent. The only
 * place in the kernel that dereferences payloads — everything else works on
 * refs alone.
 *
 * Nothing is appended to the system prompt here: what the model reads is
 * exactly the `system_prompt` node `applySystemPrompt` recorded, which is what
 * makes `requestDigest` a meaningful replay check for the prompt.
 */
export async function buildRequest<TCtx>(
    state: AgentState,
    reg: AgentRegistry<TCtx>,
    env: KernelEnv,
): Promise<ModelRequest> {
    const { system, messages } = await projectMessages(state.trajectory, env.services.payloads);
    const tools = await resolveTools(state, reg, env);

    return {
        system,
        messages,
        tools: tools.map(toSchema),
        toolChoice: 'auto',
    };
}

/** Stable fingerprint of a request, for replay divergence detection. */
export function requestDigest(req: ModelRequest): string {
    return hash(
        JSON.stringify({
            system: req.system ?? '',
            messages: req.messages,
            tools: req.tools.map((t) => t.name),
        }),
    );
}

/**
 * A request as it goes onto an `llm_call` node: everything that shaped the
 * call, minus the `signal`, which is machinery rather than content and is not
 * JSON anyway. Pretty-printed, since the whole point of keeping it is that a
 * human reads it later.
 */
export function serializeRequest(req: ModelRequest): string {
    const { signal: _signal, ...rest } = req;
    return JSON.stringify(rest, null, 2);
}

// ---------------------------------------------------------------------------
// Advancing the state
// ---------------------------------------------------------------------------

export async function applyUserInput(
    state: AgentState,
    input: Input,
    env: KernelEnv,
    synthetic = false,
): Promise<AgentState> {
    const b = begin(state, env);
    b.add<UserInputNode>({
        type: 'user_input',
        content: await toPayloadParts(env, input),
        synthetic: synthetic || undefined,
    });
    return b.commit({ phase: 'awaiting_llm' });
}

/**
 * Renders the active agent's instructions into the trajectory. Idempotent: a
 * matching prompt already in force produces no node, so re-entering the loop
 * (or resuming) does not litter the history.
 *
 * The rendered bytes are the identity. Two compositions that render the same
 * string *are* the same prompt to the model, the provider cache and replay, so
 * there is nothing else to hash and no renderer version to pin: a change that
 * matters changes the bytes, and one that does not, does not.
 */
export async function applySystemPrompt<TCtx>(
    state: AgentState,
    reg: AgentRegistry<TCtx>,
    env: KernelEnv,
): Promise<AgentState> {
    const agent = reg.get(state.agentName);
    const { text, sources } = await composePrompt(
        agent.instructions,
        state.context as TCtx,
        state.spec,
        (value) => put(env, value),
        await derivedPrompt(agent, state, env),
    );
    if (!text) {
        return state;
    }
    const current = lastOfType(projected(state.trajectory), 'system_prompt');
    if (current && current.agent === state.agentName && current.prompt.sha256 === hash(text)) {
        return state;
    }
    const b = begin(state, env);
    b.add<SystemPromptNode>({
        type: 'system_prompt',
        prompt: await put(env, text),
        ...(sources.length ? { sources } : {}),
    });
    return b.commit({});
}

interface ForkArgs {
    branches: { name: string; instructions: string; agent?: string }[];
    context?: 'inherit' | 'compact' | 'none';
}

function parseForkArgs(raw: string): ForkArgs | string {
    const args = parseArgs(raw);
    let branches = args.branches;
    // When a model delegates a single task, it frequently flattens the branch
    // fields directly into the root arguments instead of wrapping them in a
    // 1-element array. Coerce it if name and instructions are present at the root.
    if (
        !Array.isArray(branches) &&
        typeof args.name === 'string' &&
        typeof args.instructions === 'string'
    ) {
        branches = [
            {
                name: args.name,
                instructions: args.instructions,
                agent: typeof args.agent === 'string' ? args.agent : undefined,
            },
        ];
    }
    // Spelled out rather than "invalid arguments": this string is fed back to
    // the model as the tool result, and it is the only chance it gets to work
    // out what to do differently.
    if (!Array.isArray(branches) || branches.length === 0) {
        if (
            args.name !== undefined ||
            args.instructions !== undefined ||
            args.agent !== undefined
        ) {
            return (
                'the "branches" argument is missing; "fork" requires an array of branches: ' +
                '{ "branches": [{ "name": "...", "instructions": "...", "agent": "..." }] }. ' +
                'Do not pass branch fields at the top level.'
            );
        }
        return 'the "branches" argument is missing or empty; it must be an array of at least one branch';
    }
    const parsed: ForkArgs['branches'] = [];
    for (const b of branches as Record<string, unknown>[]) {
        if (typeof b?.name !== 'string' || !b.name.trim()) {
            return 'every branch needs a non-empty "name"';
        }
        if (typeof b?.instructions !== 'string' || !b.instructions.trim()) {
            return `branch "${b.name}" needs non-empty "instructions" saying what it must do`;
        }
        parsed.push({
            name: b.name,
            instructions: b.instructions,
            agent: typeof b.agent === 'string' ? b.agent : undefined,
        });
    }
    if (new Set(parsed.map((b) => b.name)).size !== parsed.length) {
        return 'branch names must be unique';
    }
    const mode = args.context;
    return {
        branches: parsed,
        context: mode === 'inherit' || mode === 'compact' || mode === 'none' ? mode : 'inherit',
    };
}

/** What the driver knows about a model call that the response itself omits. */
export interface LlmCallOptions<TCtx = unknown> {
    /** stable fingerprint of the request, for replay divergence detection */
    digest?: string;
    /** the request as sent; stored as a payload on the node when given */
    request?: ModelRequest;
    /** needed to validate a `fork` call against the agent's declaration */
    registry?: AgentRegistry<TCtx>;
    /** the model's `ref`, recorded beside its wire id */
    ref?: string;
}

/**
 * Appends the `llm_call` node (plus the nodes its tool calls imply) and moves
 * the phase on. Typed runs are resolved here too: `final_output` never reaches
 * tool execution, it is validated against the run's schema on the spot.
 */
export async function applyLlmResponse<TCtx>(
    state: AgentState,
    res: ModelResponse,
    model: string,
    env: KernelEnv,
    opts: LlmCallOptions<TCtx> = {},
): Promise<AgentState> {
    const reg = opts.registry;
    const b = begin(state, env);
    const toolCalls = await Promise.all(
        res.toolCalls.map(async (c) => ({
            callId: c.id,
            name: c.name,
            args: await put(env, c.args),
            signature: c.signature,
        })),
    );
    b.add<LlmCallNode>({
        type: 'llm_call',
        model,
        ...(opts.ref ? { ref: opts.ref } : {}),
        requestDigest: opts.digest ?? (opts.request ? requestDigest(opts.request) : ''),
        request: opts.request ? await put(env, serializeRequest(opts.request)) : undefined,
        text: await put(env, res.text),
        thinking: res.thinking ? await put(env, res.thinking) : undefined,
        toolCalls,
        usage: res.usage ?? zeroUsage(),
        stopReason: res.stopReason ?? (res.toolCalls.length ? 'tool_calls' : 'stop'),
    });

    // --- no tool calls: either the run is over, or the model owes us a call ---
    if (!res.toolCalls.length) {
        if (!state.spec.outputSchema) {
            b.add<FinalOutputNode>({ type: 'final_output', output: await put(env, res.text) });
            return b.commit({ phase: 'done', pendingToolCalls: [] });
        }
        b.add<UserInputNode>({
            type: 'user_input',
            content: [
                {
                    type: 'text',
                    text: await put(
                        env,
                        `Your answer must be delivered through the \`${FINAL_OUTPUT_TOOL}\` tool.`,
                    ),
                },
            ],
            synthetic: true,
        });
        return b.commit({ phase: 'awaiting_llm', pendingToolCalls: [] });
    }

    const pending: string[] = [];
    let pendingFork = state.pendingFork;
    let done = false;

    for (let i = 0; i < res.toolCalls.length; i++) {
        const call = res.toolCalls[i];
        const ref = toolCalls[i];

        if (call.name === FINAL_OUTPUT_TOOL && state.spec.outputSchema) {
            const parsed = validateOutput(state, env, call.args);
            if (parsed.ok) {
                b.add<FinalOutputNode>({
                    type: 'final_output',
                    output: await put(env, stringifyOutput(parsed.value)),
                    parsed: parsed.value,
                });
                done = true;
            } else {
                // Repairable: the model sees its own mistake and tries again.
                b.add<ToolResultNode>({
                    type: 'tool_result',
                    callId: call.id,
                    name: call.name,
                    result: await put(env, parsed.message),
                    isError: true,
                });
            }
            continue;
        }

        if (call.name === FORK_TOOL) {
            const args = parseForkArgs(call.args);
            const problem = typeof args === 'string' ? args : forkProblem(state, args, reg);
            if (typeof args === 'string' || problem) {
                b.add<ToolResultNode>({
                    type: 'tool_result',
                    callId: call.id,
                    name: call.name,
                    result: await put(env, `error: ${problem ?? (args as string)}`),
                    isError: true,
                });
                continue;
            }
            const clock = env.clock ?? systemClock;
            const branches = await Promise.all(
                args.branches.map(async (br) => ({
                    name: br.name,
                    agent: br.agent ?? state.agentName,
                    instructions: await put(env, br.instructions),
                    childRunId: clock.newId(),
                })),
            );
            b.add<ForkNode>({
                type: 'fork',
                callId: call.id,
                contextMode: args.context ?? 'inherit',
                branches,
            });
            pendingFork = { callId: call.id, branches: branches.map((br) => br.name) };
            continue;
        }

        b.add<ToolCallNode>({
            type: 'tool_call',
            callId: call.id,
            name: call.name,
            args: ref.args,
        });
        pending.push(call.id);
    }

    if (done) {
        return b.commit({ phase: 'done', pendingToolCalls: [], pendingFork: undefined });
    }
    const phase: RunPhase = pending.length
        ? 'awaiting_tools'
        : pendingFork?.branches.length
          ? 'awaiting_branches'
          : 'awaiting_llm';
    return b.commit({ phase, pendingToolCalls: pending, pendingFork });
}

function forkProblem<TCtx>(
    state: AgentState,
    args: ForkArgs,
    reg?: AgentRegistry<TCtx>,
): string | undefined {
    const agent = reg?.find(state.agentName);
    if (agent && !agent.fork) {
        return 'this agent cannot fork';
    }
    const max = agent?.fork?.maxBranches;
    if (max && args.branches.length > max) {
        return `at most ${max} branches are allowed, and this call has ${args.branches.length}`;
    }
    // Hallucinated agent names are the common failure, so the answer always
    // carries the list of real ones — a retry then has nothing left to guess.
    const allowed = reg ? forkAgents(state, reg) : undefined;
    for (const b of args.branches) {
        const name = b.agent ?? state.agentName;
        if (allowed && !allowed.includes(name)) {
            return (
                `branch "${b.name}" names an agent that cannot run it: "${name}". ` +
                `Use one of: ${allowed.join(', ')} — or omit "agent" to use ${state.agentName}.`
            );
        }
    }
    return undefined;
}

function stringifyOutput(v: unknown): string {
    return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
}

/**
 * Validation uses the Zod schema when the caller supplied one — transforms,
 * defaults and refinements included. A run resumed by generic tooling without
 * the original schema degrades to a structural JSON Schema check.
 */
function validateOutput(
    state: AgentState,
    env: KernelEnv,
    raw: string,
): { ok: true; value: unknown } | { ok: false; message: string } {
    let args: unknown;
    try {
        args = JSON.parse(raw || '{}');
    } catch (e) {
        return { ok: false, message: `error: arguments are not valid JSON: ${String(e)}` };
    }
    const payload = state.spec.outputWrapped ? (args as Record<string, unknown>)?.value : args;

    if (env.output) {
        const parsed = env.output.safeParse(payload);
        return parsed.success
            ? { ok: true, value: parsed.data }
            : {
                  ok: false,
                  message: `error: output does not match the schema:\n${z.prettifyError(parsed.error)}`,
              };
    }
    const schema = state.spec.outputSchema;
    if (!state.spec.outputWrapped && schema?.required?.length) {
        const obj = (payload ?? {}) as Record<string, unknown>;
        const missing = schema.required.filter((k) => obj[k] === undefined);
        if (missing.length) {
            return { ok: false, message: `error: missing required fields: ${missing.join(', ')}` };
        }
    }
    return { ok: true, value: payload };
}

/**
 * Appends the tool result, folds in whatever the tool did to memory or skills,
 * and performs a hand-off when the call was a `transfer_to_*`.
 */
export async function applyToolResult(
    state: AgentState,
    callId: string,
    outcome: ToolOutcome,
    env: KernelEnv,
): Promise<AgentState> {
    const call = state.trajectory.find(
        (n): n is ToolCallNode => n.type === 'tool_call' && n.callId === callId,
    );
    if (!call) {
        throw new Error(`no pending tool call ${callId} in run ${state.runId}`);
    }
    const b = begin(state, env);
    b.add<ToolResultNode>({
        type: 'tool_result',
        callId,
        name: call.name,
        result: await put(env, outcome.output),
        isError: outcome.isError,
        durationMs: outcome.durationMs,
    });

    for (const effect of outcome.effects ?? []) {
        if (effect.kind === 'skill_load') {
            await addSkillLoad(b, env, effect.spec);
        } else if (effect.spec.kind === 'op') {
            await addMemoryOp(b, env, effect.spec);
        } else {
            await addMemoryRecall(b, env, effect.spec);
        }
    }

    const target = outcome.isError ? undefined : handoffTarget(call.name);
    let agentName = state.agentName;
    if (target) {
        b.add<HandoffNode>({
            type: 'handoff',
            from: state.agentName,
            to: target,
            reason: asReason(call),
        });
        agentName = target;
    }

    const pendingToolCalls = state.pendingToolCalls.filter((id) => id !== callId);
    const phase: RunPhase = pendingToolCalls.length
        ? 'awaiting_tools'
        : state.pendingFork?.branches.length
          ? 'awaiting_branches'
          : 'awaiting_llm';
    const suspended = state.suspended?.filter((s) => s.callId !== callId);
    return b.commit({
        phase,
        pendingToolCalls,
        agentName,
        suspended: suspended?.length ? suspended : undefined,
    });
}

/**
 * Records that a pending call suspended the run. The call stays pending - no
 * result is written - so the model still sees it unanswered until it is.
 */
export function applySuspension(
    state: AgentState,
    call: { callId: string; name: string },
    spec: SuspendSpec,
    at: string,
): AgentState {
    if (!state.pendingToolCalls.includes(call.callId)) {
        throw new Error(`no pending tool call ${call.callId} in run ${state.runId}`);
    }
    const others = (state.suspended ?? []).filter((s) => s.callId !== call.callId);
    const entry: Suspension = { callId: call.callId, name: call.name, at, ...spec };
    return { ...state, suspended: [...others, entry] };
}

/** Lets a suspended call run again: what it waited for is done. */
export function releaseSuspension(state: AgentState, callId: string): AgentState {
    const suspended = (state.suspended ?? []).filter((s) => s.callId !== callId);
    return { ...state, suspended: suspended.length ? suspended : undefined };
}

function asReason(call: ToolCallNode): string | undefined {
    // The reason travels in the call arguments, which are behind a payload; the
    // preview is enough for a human-readable trace and costs no I/O.
    const preview = call.args.preview;
    if (!preview) {
        return undefined;
    }
    const reason = parseArgs(preview).reason;
    return typeof reason === 'string' ? reason : undefined;
}

async function addMemoryOp(b: Draft, env: KernelEnv, spec: MemoryOpSpec): Promise<void> {
    b.add<MemoryOpNode>({
        type: 'memory_op',
        op: spec.op,
        opId: spec.opId,
        nodes: spec.nodes,
        edges: spec.edges,
        files: spec.files,
    });
}

async function addMemoryRecall(b: Draft, env: KernelEnv, spec: MemoryRecallSpec): Promise<void> {
    b.add<MemoryRecallNode>({
        type: 'memory_recall',
        query: spec.query,
        seeds: spec.seeds,
        nodes: spec.nodes,
        edges: spec.edges,
        content: await put(env, spec.content),
    });
}

async function addSkillLoad(b: Draft, env: KernelEnv, spec: SkillLoadSpec): Promise<void> {
    b.add<LoadSkillsNode>({
        type: 'load_skills',
        provider: spec.provider,
        skills: spec.skills.map((s) => ({
            name: s.name,
            version: s.version,
            contentHash: skillContentHash(s),
            file: s.file,
        })),
        content: await put(env, renderSkills(spec.skills)),
        toolNames: [...new Set(spec.skills.flatMap((s) => (s.tools ?? []).map((t) => t.name)))],
    });
}

/** Records a memory recall or mutation performed by the driver. */
export async function applyMemoryEffect(
    state: AgentState,
    effect: MemoryRecallSpec | MemoryOpSpec,
    env: KernelEnv,
): Promise<AgentState> {
    const b = begin(state, env);
    if (effect.kind === 'op') {
        await addMemoryOp(b, env, effect);
    } else {
        await addMemoryRecall(b, env, effect);
    }
    return b.commit({});
}

/** Records a skill activation and the tools it unlocked. */
export async function applySkillLoad(
    state: AgentState,
    provider: string,
    skills: Skill[],
    env: KernelEnv,
): Promise<AgentState> {
    const b = begin(state, env);
    await addSkillLoad(b, env, { kind: 'skill_load', provider, skills });
    return b.commit({});
}

export interface CompactionSpec {
    /** ids of the nodes this summary replaces; need not be contiguous */
    covers: string[];
    summary: string;
    reason: CompactionNode['reason'];
    /** the model's call id when it compacted itself; synthesized otherwise */
    callId?: string;
    /** tokens the summarizer burned */
    usage?: TokenUsage;
}

/**
 * Containment, not deletion: the covered nodes stay in the trajectory for audit
 * and replay, and only the projection skips them. The log stays append-only.
 */
export async function applyCompaction(
    state: AgentState,
    spec: CompactionSpec,
    env: KernelEnv,
): Promise<AgentState> {
    const clock = env.clock ?? systemClock;
    const b = begin(state, env);
    b.add<CompactionNode>({
        type: 'compaction',
        callId: spec.callId ?? `compact_${clock.newId()}`,
        covers: spec.covers,
        summary: await put(env, spec.summary),
        reason: spec.reason,
        usage: spec.usage ?? zeroUsage(),
    });
    return b.commit({});
}

export function applyFailure(state: AgentState, error: string): AgentState {
    return { ...state, phase: 'failed', error };
}

// ---------------------------------------------------------------------------
// Fork / join
// ---------------------------------------------------------------------------

/**
 * Derives a child state seeded with *real nodes* copied from the parent, not a
 * frozen `Message[]` blob: the branch can compact its own inherited context,
 * and at join those nodes splice back into one trajectory. The copy is a
 * snapshot, so the branch can execute in another process.
 */
export async function createChildState(
    state: AgentState,
    forkId: string,
    branch: string,
    env: KernelEnv,
): Promise<AgentState> {
    const fork = state.trajectory.find(
        (n): n is ForkNode => n.type === 'fork' && n.callId === forkId,
    );
    const plan = fork?.branches.find((b) => b.name === branch);
    if (!fork || !plan) {
        throw new Error(`unknown branch ${branch} of fork ${forkId}`);
    }

    const prefix = branchPrefix(state, fork, plan.agent);
    const child: AgentState = {
        version: 1,
        runId: plan.childRunId,
        spec: {
            startAgent: plan.agent,
            parent: { runId: state.runId, forkId, branch },
            forkDepth: state.spec.forkDepth + 1,
            maxForkDepth: state.spec.maxForkDepth,
            // Where the branch's own history begins: the parent already holds
            // the prefix, so only what follows is spliced back at join.
            prefixLength: prefix.length,
        },
        agentName: plan.agent,
        phase: 'created',
        trajectory: prefix,
        pendingToolCalls: [],
        usage: zeroUsage(),
        context: state.context,
    };

    const b = begin(child, env);
    if (prefix.length) {
        // Gemini signs only a parallel turn's first call: answer the siblings so none is dropped.
        const turn = prefix.findLast(
            (n): n is LlmCallNode =>
                n.type === 'llm_call' && n.toolCalls.some((c) => c.callId === fork.callId),
        );
        const answered = new Set(
            prefix.flatMap((n) => (n.type === 'tool_result' ? [n.callId] : [])),
        );
        for (const c of turn?.toolCalls ?? []) {
            if (c.callId === fork.callId || answered.has(c.callId)) {
                continue;
            }
            b.add<ToolResultNode>({
                type: 'tool_result',
                callId: c.callId,
                name: c.name,
                result: await put(
                    env,
                    'Not run in this branch: the parent runs this call, and its result is not visible here.',
                ),
                isError: false,
            });
        }
        // The branch inherited the turn that called `fork`, so the honest way to
        // hand it its assignment is to answer that call: the model sees a tool
        // result for a tool it just called, instead of a second user message
        // appearing after its own. It also keeps the fork call itself in the
        // prompt — otherwise `repairToolCalls` strips it as unanswered and the
        // branch never learns that it fanned out at all.
        b.add<ToolResultNode>({
            type: 'tool_result',
            callId: fork.callId,
            name: FORK_TOOL,
            result: await put(env, branchBrief(fork, plan, await get(env, plan.instructions))),
            isError: false,
        });
    } else {
        // Nothing to answer: a `context: 'none'` branch has no history, so its
        // assignment arrives the only way it can, as the opening message.
        b.add<UserInputNode>({
            type: 'user_input',
            // Reuses the instructions payload already written by the fork node.
            content: [{ type: 'text', text: plan.instructions }],
        });
    }
    return b.commit({ phase: 'awaiting_llm' });
}

/**
 * What an inheriting branch is told when its own `fork` call comes back. The
 * parent's fork arguments are already in the prompt above it, so the siblings'
 * assignments need no repeating — but which of the branches this run *is*, and
 * what happens to what it produces, exist nowhere else. Without them a branch
 * re-derives work a sibling already owns and writes an answer shaped for a user
 * rather than for a merge.
 *
 * A lone branch has no siblings to be told about, and the thing it does need to
 * know is the opposite one: nobody else is working on any of this.
 */
function branchBrief(
    fork: ForkNode,
    plan: ForkNode['branches'][number],
    instructions: string,
): string {
    const siblings = fork.branches.filter((b) => b.name !== plan.name).map((b) => `"${b.name}"`);
    return [
        `You are branch "${plan.name}" of the fork above. Your assignment, and your only one:`,
        '',
        instructions,
        '',
        siblings.length
            ? `Running in parallel, on the assignments the call above gave them: ${siblings.join(', ')}. ` +
              'You cannot see their work and they cannot see yours, so anything you do on their ' +
              'part is duplicated effort, and anything you leave to them will be there. This branch ' +
              'ends with your final answer; that answer alone rejoins the conversation above, ' +
              'merged with theirs.'
            : 'No other branch was opened, so the whole assignment is yours and nothing you ' +
              'leave undone will be picked up elsewhere. This branch ends with your final ' +
              'answer; that answer alone rejoins the conversation above, and none of the steps ' +
              'you take to reach it go with it.',
    ].join('\n');
}

/** The parent history a branch starts from, as decided by `contextMode`. */
function branchPrefix(state: AgentState, fork: ForkNode, agent: string): TrajectoryNode[] {
    if (fork.contextMode === 'none') {
        return [];
    }
    const visible = projected(state.trajectory);
    const at = visible.findIndex((n) => n.id === fork.id);
    const before = at === -1 ? visible : visible.slice(0, at);
    return before.filter((n) => {
        // Skills are agent-scoped. Carrying the instructions text across an
        // agent change would leave the branch reading about tools it cannot
        // call, so text and tools have to disappear together.
        if (n.type === 'load_skills') {
            return n.agent === agent;
        }
        // 'compact': start from the conversation, not the parent's tool chatter.
        // The now-unanswered tool calls are dropped by `repairToolCalls`.
        if (fork.contextMode === 'compact') {
            return n.type !== 'tool_call' && n.type !== 'tool_result' && n.type !== 'memory_recall';
        }
        return true;
    });
}

export interface BranchResult {
    name: string;
    status: 'ok' | 'error' | 'aborted';
    /** what the parent sees for this branch — already summarized by the policy */
    output: string;
    error?: string;
    usage: TokenUsage;
    childRunId: string;
    childState: AgentState;
}

/**
 * Folds branches back into the parent. Each branch's history is nested inside
 * its row of the join, in *declared* branch order — so the result is identical
 * regardless of completion order, and a walk of the parent array never trips
 * over someone else's nodes.
 */
export async function applyJoin(
    state: AgentState,
    forkId: string,
    results: BranchResult[],
    env: KernelEnv,
): Promise<AgentState> {
    const fork = state.trajectory.find(
        (n): n is ForkNode => n.type === 'fork' && n.callId === forkId,
    );
    if (!fork) {
        throw new Error(`unknown fork ${forkId} in run ${state.runId}`);
    }
    const byName = new Map(results.map((r) => [r.name, r]));

    const b = begin(state, env);
    const rows: JoinNode['branches'] = [];
    let usage = zeroUsage();
    for (const plan of fork.branches) {
        const r = byName.get(plan.name);
        if (!r) {
            continue;
        }
        rows.push({
            name: plan.name,
            agent: plan.agent,
            status: r.status,
            output: await put(env, r.output),
            error: r.error,
            usage: r.usage,
            // Only what the branch itself did: the inherited prefix is the
            // parent's own history and is already right there in the array.
            nodes: r.childState.trajectory.slice(r.childState.spec.prefixLength ?? 0),
        });
        usage = addUsage(usage, r.usage);
    }

    b.add<JoinNode>({ type: 'join', callId: forkId, branches: rows, usage });
    const remaining = (state.pendingFork?.branches ?? []).filter((n) => !byName.has(n));
    return b.commit({
        pendingFork: remaining.length ? { callId: forkId, branches: remaining } : undefined,
        phase: remaining.length
            ? 'awaiting_branches'
            : state.pendingToolCalls.length
              ? 'awaiting_tools'
              : 'awaiting_llm',
    });
}

// ---------------------------------------------------------------------------
// Small read helpers used by drivers
// ---------------------------------------------------------------------------

export function lastUserInput(state: AgentState): UserInputNode | undefined {
    const nodes = state.trajectory;
    for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        if (n.type === 'user_input' && !n.synthetic) {
            return n;
        }
    }
    return undefined;
}

export { Agent, AgentRegistry };
