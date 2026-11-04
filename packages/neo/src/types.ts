import type { Agent } from './agent.ts';
import type { MemoryOpSpec, MemoryRecallSpec } from './memory/types.ts';
import type { Services } from './services.ts';
import type { SkillLoadSpec } from './skills.ts';
import type { AgentState } from './state.ts';

// ---------------------------------------------------------------------------
// Content / Input
// ---------------------------------------------------------------------------

export type MediaKind = 'image' | 'audio' | 'video' | 'file';

export interface TextPart {
    type: 'text';
    text: string;
}

export interface MediaPart {
    type: MediaKind;
    /** http(s) url or data: uri */
    url: string;
    mimeType?: string;
}

export type ContentPart = TextPart | MediaPart;

/**
 * Sugar accepted on input boundaries. A bare string inside an array is text,
 * `{ image: url }` & co. are media shorthands.
 */
export type InputPart =
    | string
    | ContentPart
    | { image: string; mimeType?: string }
    | { audio: string; mimeType?: string }
    | { video: string; mimeType?: string }
    | { file: string; mimeType?: string };

/** Either plain text, or an array of content parts. */
export type Input = string | InputPart[];

const MEDIA_KEYS: MediaKind[] = ['image', 'audio', 'video', 'file'];

export function text(value: string): TextPart {
    return { type: 'text', text: value };
}

export function media(kind: MediaKind, url: string, mimeType?: string): MediaPart {
    return { type: kind, url, mimeType };
}

/** Normalizes any accepted input shape into a flat `ContentPart[]`. */
export function toContent(input: Input): ContentPart[] {
    if (typeof input === 'string') {
        return [text(input)];
    }
    return input.map((part): ContentPart => {
        if (typeof part === 'string') {
            return text(part);
        }
        // `'type' in part` is a TS narrowing guard: it splits the union into the
        // canonical `ContentPart` branch and the `{ image: url }` shorthands.
        if ('type' in part) {
            return part;
        }
        // Shorthand: exactly one of image/audio/video/file carries the url.
        for (const kind of MEDIA_KEYS) {
            const url = (part as Record<string, unknown>)[kind];
            if (typeof url === 'string') {
                return media(kind, url, part.mimeType);
            }
        }
        throw new TypeError(`unsupported input part: ${JSON.stringify(part)}`);
    });
}

export function contentToText(content: ContentPart[]): string {
    return content.map((p) => (p.type === 'text' ? p.text : `[${p.type}: ${p.url}]`)).join('\n');
}

// ---------------------------------------------------------------------------
// Messages — a *projection* of the trajectory, never the source of truth
// ---------------------------------------------------------------------------

export interface ToolCall {
    id: string;
    name: string;
    /** raw JSON string as produced by the model */
    args: string;
    /**
     * Opaque provider state that has to be handed back verbatim when the call
     * is replayed. Gemini 3 puts an encrypted thought signature here and
     * rejects a function call that comes back without one; every other vendor
     * ignores the field.
     *
     * It is vendor-specific and so arguably does not belong in a neutral type
     * — but the alternative is an adapter-side cache, and the identity that
     * would key it does not survive a handoff to an agent on a different model
     * or a run resumed in another process. The call is the only thing that
     * lives exactly as long as the signature is needed.
     */
    signature?: string;
}

export interface SystemMessage {
    role: 'system';
    content: string;
}

export interface UserMessage {
    role: 'user';
    content: ContentPart[];
}

export interface AssistantMessage {
    role: 'assistant';
    content: string;
    toolCalls?: ToolCall[];
    /** which agent produced it — useful after hand-offs */
    agent?: string;
}

export interface ToolMessage {
    role: 'tool';
    callId: string;
    name: string;
    content: string;
    isError?: boolean;
}

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

// ---------------------------------------------------------------------------
// Accounting
// ---------------------------------------------------------------------------

export interface TokenUsage {
    inputTokens: number;
    /** subset of inputTokens served from cache */
    cachedInputTokens: number;
    outputTokens: number;
    /** subset of outputTokens spent on thinking */
    reasoningTokens: number;
}

export function zeroUsage(): TokenUsage {
    return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
    return {
        inputTokens: a.inputTokens + b.inputTokens,
        cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
        outputTokens: a.outputTokens + b.outputTokens,
        reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface JsonSchema {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
    [key: string]: unknown;
}

export interface ToolContext<TCtx = unknown> {
    ctx: TCtx;
    state: AgentState;
    agent: Agent<TCtx>;
    /** id of the call being executed — memory ops derive their opId from it */
    callId: string;
    services: Services;
    signal?: AbortSignal;
}

/** What the model needs to know about a tool — no execution details. */
export interface ToolSchema {
    name: string;
    description?: string;
    parameters: JsonSchema;
}

/**
 * What a tool produced. `effects` are structured side-effect records the kernel
 * must fold into the trajectory (memory writes, skill activations); the tool
 * itself performed the I/O, because the kernel stays free of it.
 */
export interface ToolOutcome {
    output: string;
    isError: boolean;
    durationMs?: number;
    effects?: ToolEffect[];
}

export type ToolEffect =
    | { kind: 'memory_op'; spec: MemoryOpSpec | MemoryRecallSpec }
    | { kind: 'skill_load'; spec: SkillLoadSpec };

const TOOL_RETURN = Symbol('agent.toolReturn');

/**
 * What a tool returns when it needs the kernel to record something beyond the
 * tool message itself. Tagged with a symbol so an ordinary object result can
 * never be mistaken for one.
 */
export interface ToolReturn {
    [TOOL_RETURN]: true;
    output: unknown;
    effects: ToolEffect[];
}

export function withEffects(output: unknown, ...effects: ToolEffect[]): ToolReturn {
    return { [TOOL_RETURN]: true, output, effects };
}

export function isToolReturn(v: unknown): v is ToolReturn {
    return v !== null && typeof v === 'object' && TOOL_RETURN in v;
}

// ---------------------------------------------------------------------------
// Suspending a run
//
// Some tools cannot finish without a person: an account to connect, a value
// only someone knows, an approval. Such a tool returns `suspend(...)` instead
// of a result. The run then stops with the call still pending - nothing is
// held while it waits - and a later `runner.resume(state, { answers })` either
// runs the call again (the person did what was needed) or hands the call an
// answer as its result. What the pause is about is the host's business: the
// runner only carries `reason`, `message` and `data` through to whoever shows
// it, and `responseSchema` to whoever collects the answer.
// ---------------------------------------------------------------------------

// Registered (`Symbol.for`) so a plugin with no dependencies can suspend too:
// `{ [Symbol.for('zenera.neo.toolSuspend')]: true, spec }` is what `suspend` makes.
const TOOL_SUSPEND = Symbol.for('zenera.neo.toolSuspend');

export interface SuspendSpec {
    /** what the run waits for, in the host's own words (e.g. "mcp_auth", "input") */
    reason: string;
    /** a human-readable prompt for whoever answers */
    message?: string;
    /** anything the host needs to resolve it; must be JSON */
    data?: unknown;
    /** the shape of the answer expected, when the answer becomes the result */
    responseSchema?: Record<string, unknown>;
}

export interface ToolSuspend {
    [TOOL_SUSPEND]: true;
    spec: SuspendSpec;
}

export function suspend(spec: SuspendSpec): ToolSuspend {
    return { [TOOL_SUSPEND]: true, spec };
}

export function isToolSuspend(v: unknown): v is ToolSuspend {
    return v !== null && typeof v === 'object' && TOOL_SUSPEND in v;
}

/** A pending tool call a run is suspended on. Lives in `AgentState.suspended`. */
export interface Suspension extends SuspendSpec {
    callId: string;
    /** the tool that suspended */
    name: string;
    /** when it suspended, as the run's clock writes times */
    at: string;
}

/**
 * The answer to one suspension, given to `runner.resume`.
 *   resolved + rerun   - what was needed is done; run the call again
 *   resolved + payload - the payload is the call's result
 *   cancelled          - nobody will answer; the call gets `message` as an error
 */
export type ResumeAnswer =
    | { status: 'resolved'; rerun: true }
    | { status: 'resolved'; payload: unknown }
    | { status: 'cancelled'; message?: string };

export interface Tool<TArgs = unknown, TCtx = unknown> extends ToolSchema {
    /**
     * The family this tool belongs to, so config can name the whole set at
     * once as `<group>:*`. Purely an authoring convenience — it is never sent
     * to the model, which sees one flat list of names either way.
     */
    group?: string;
    execute(args: TArgs, tc: ToolContext<TCtx>): unknown | Promise<unknown>;
}

/**
 * Heterogeneous tool lists: every tool has a different `TArgs`, so there is no
 * single type parameter that fits an array of them. `any` here is deliberate --
 * `unknown` would make `execute` contravariant and reject concrete tools, and
 * `never` propagates into `ToolContext<TCtx>` and breaks assignability. Arg
 * safety is preserved at the definition site by `tool()` below.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool<TCtx = unknown> = Tool<any, TCtx>;

/**
 * Identity helper. Its only job is inference: written inline, `execute`'s
 * `args` would be `unknown`; going through `tool<{city: string}>()` types it.
 */
export function tool<TArgs, TCtx = unknown>(def: Tool<TArgs, TCtx>): Tool<TArgs, TCtx> {
    return def;
}

// ---------------------------------------------------------------------------
// Choosing tools by name
//
// Config names tools; it cannot contain them. That seam is fine until a set
// grows: eight filesystem tools written out under every agent is eight chances
// to leave one behind on a rename, and the list says nothing about intent —
// nobody reads it and thinks "the files", they read it and count.
//
// So a selector may also name a *group*, and subtract:
//
//     tools: [files:*, -delete_file, policy_lookup]
//
// Subtraction is what makes the wildcard usable rather than a trap. Without it
// the only way to withhold one tool from a family is to stop using the family,
// and an author who wants seven of eight is back to listing names.
//
// A single tool may be written either way — `read_file` or
// `files:read_file` (with `workspace:read_file` supported as an alias) —
// because having seen the group in one line, everyone tries the qualified form
// in the next.
//
// Everything is resolved at load, and an unknown name or an empty group is a
// startup failure: a typo that silently grants nothing is the same bug as a
// typo that silently grants everything, and both surface as a confused model.
// ---------------------------------------------------------------------------

export interface ToolSelection {
    /** the config key to name in an error, e.g. `agents.triage.tools` */
    where: string;
    /** how the caller should register a tool that is missing */
    hint?: string;
}

/**
 * Aliases for tool groups, so renaming a group breaks no existing configuration.
 * `workspace` is the legacy name for the file tools (`files`).
 */
const GROUP_ALIASES: Record<string, string> = {
    workspace: 'files',
};

function canonicalGroup(group: string | undefined): string | undefined {
    return group ? (GROUP_ALIASES[group] ?? group) : undefined;
}

/**
 * Resolves selectors against the tools a host provided, in the order written
 * and without duplicates. A selector is a tool name, `<group>:<name>` for the
 * same tool written out in full, `<group>:*` for every tool in a group, or `*`
 * for everything; any of them prefixed with `-` removes what it matches from
 * the selection so far.
 */
export function selectTools<TCtx>(
    available: AnyTool<TCtx>[],
    selectors: string[],
    opts: ToolSelection,
): AnyTool<TCtx>[] {
    const chosen = new Map<string, AnyTool<TCtx>>();
    for (const raw of selectors) {
        const drop = raw.startsWith('-');
        const selector = (drop ? raw.slice(1) : raw).trim();
        if (!selector) {
            throw new Error(`${opts.where}: empty tool selector`);
        }
        for (const t of matchTools(available, selector, opts)) {
            if (drop) {
                chosen.delete(t.name);
            } else {
                chosen.set(t.name, t);
            }
        }
    }
    return [...chosen.values()];
}

function matchTools<TCtx>(
    available: AnyTool<TCtx>[],
    selector: string,
    opts: ToolSelection,
): AnyTool<TCtx>[] {
    if (selector === '*') {
        return available;
    }
    if (selector.endsWith(':*')) {
        const rawGroup = selector.slice(0, -2);
        const group = canonicalGroup(rawGroup) ?? rawGroup;
        const hits = available.filter((t) => (canonicalGroup(t.group) ?? t.group) === group);
        if (hits.length === 0) {
            const groups = [
                ...new Set(
                    available.map((t) => canonicalGroup(t.group) ?? t.group).filter(Boolean),
                ),
            ];
            throw new Error(
                `${opts.where}: no tools in group "${rawGroup}" ` +
                    `(known groups: ${groups.join(', ') || 'none'})`,
            );
        }
        return hits;
    }
    const exact = available.find((t) => t.name === selector);
    if (exact) {
        return [exact];
    }
    // `workspace:read_file` or `files:read_file` is the same thing as `read_file`:
    // an author who writes `files:*` on one line should not be told the qualified
    // form is a typo on the next.
    const colon = selector.lastIndexOf(':');
    if (colon > 0) {
        const rawGroup = selector.slice(0, colon);
        const group = canonicalGroup(rawGroup) ?? rawGroup;
        const name = selector.slice(colon + 1);
        const qualified = available.find(
            (t) => (canonicalGroup(t.group) ?? t.group) === group && t.name === name,
        );
        if (qualified) {
            return [qualified];
        }
        const elsewhere = available.find((t) => t.name === name);
        if (elsewhere) {
            const elsewhereGroup = canonicalGroup(elsewhere.group) ?? elsewhere.group ?? 'none';
            throw new Error(
                `${opts.where}: unknown tool "${selector}" ` +
                    `("${name}" is in group "${elsewhereGroup}", not "${rawGroup}")`,
            );
        }
    }
    const known = available.map((t) => t.name).join(', ') || 'none';
    throw new Error(
        `${opts.where}: unknown tool "${selector}" ` +
            (opts.hint ? `(${opts.hint}; known: ${known})` : `(known: ${known})`),
    );
}

// Built-in tool names. Hand-offs, memory, skills and forks are all ordinary
// tools, so the model drives everything with one mechanism; the kernel
// recognises them by these names alone.
export const HANDOFF_PREFIX = 'transfer_to_';
export const FORK_TOOL = 'fork';
export const FINAL_OUTPUT_TOOL = 'final_output';
export const MEMORY_SEARCH_TOOL = 'memory_search';
export const MEMORY_GREP_TOOL = 'memory_grep';
export const MEMORY_LOAD_TOOL = 'memory_load';
export const MEMORY_COMMIT_TOOL = 'memory_commit';
export const MEMORY_FORGET_TOOL = 'memory_forget';
export const MEMORY_COPY_FILE_TOOL = 'memory_copy_file';
export const SKILL_SEARCH_TOOL = 'skill_search';
export const SKILL_LOAD_TOOL = 'skill_load';

export function parseArgs(raw: string): Record<string, unknown> {
    try {
        const v: unknown = JSON.parse(raw || '{}');
        return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

export function asString(v: unknown): string | undefined {
    return typeof v === 'string' ? v : undefined;
}

export function stringify(v: unknown): string {
    return typeof v === 'string' ? v : JSON.stringify(v ?? null);
}
