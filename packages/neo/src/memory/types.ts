// ---------------------------------------------------------------------------
// Memory — knowledge that outlives a run (the trajectory is one run's record)
//
// A graph, not a list of records. The reason is the shape of what is worth
// remembering: a script an agent wrote is useless without the request that
// asked for it, the plan that shaped it and the endpoint it calls, and those
// four things are one memory even though they are four pieces of text. A store
// that can only return a ranked list of rows leaves the joining to the model,
// every single time.
//
// Every node is timed. `createdAt` is provenance, but `lastUsedAt` is what
// ranking actually leans on: memory that keeps proving useful should surface
// ahead of memory that was written once and never read, and neither an
// embedding nor an edge can tell you that.
//
// Visibility is per node, by label, denied by default. One graph serves every
// agent in a project; `audience` decides which of them may see a node at all.
// A second user is a second graph, not a second label: `audience` is about
// which agent may read a node, never about whose memory it is.
// ---------------------------------------------------------------------------

/**
 * The built-in vocabulary. A kind earns its place only when ranking, rendering
 * or loading branches on it — anything else is free text wearing an enum
 * costume, and it costs the model accuracy when it has to choose one.
 *
 * A project may declare its own set (`memory.kinds` in the config), which
 * *replaces* this one; the tool schema is built from the result, so the
 * provider constrains decoding to labels that actually exist.
 *
 * `preference` is the exception, and `MemoryIndex` re-adds it to whatever a
 * project declares: the engine itself reads that kind to build the system
 * prompt, so a project able to define it away would silently lose the feature
 * rather than opt out of it.
 */
export const MEMORY_KINDS = [
    'task',
    'plan',
    'fact',
    'snippet',
    'file',
    'operation',
    'preference',
] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const KIND_HELP: Readonly<Record<MemoryKind, string>> = {
    task: 'a request that started a piece of work',
    plan: 'an approach that worked, worth reusing on a similar request',
    fact: 'a durable truth about the environment or the domain',
    snippet: 'a short piece of code or configuration, too small to be a file',
    file: 'an artifact kept whole, to copy back into the workspace and run again',
    operation: 'an external call that was made — an endpoint, command or query',
    preference: 'a standing instruction from the user that applies to every run',
};

/**
 * Four relations, and only `SUPERSEDES` changes a traversal: recall follows it
 * forward and drops what it points at, so a corrected artifact hides the one it
 * replaced without deleting the history. The other three shape which tier of
 * the budget a node is pulled in on, and read as prose in the rendered graph.
 *
 * `SUPERSEDES` itself never reaches the renderer on the ordinary path — recall
 * drops the node it points at, so the edge has no second endpoint to draw. It
 * appears only under `stale`, which is the audit view.
 */
export const MEMORY_RELATIONS = ['PRODUCED', 'INFORMED', 'CALLS', 'SUPERSEDES'] as const;

export type Relation = (typeof MEMORY_RELATIONS)[number];

export const RELATION_HELP: Readonly<Record<Relation, string>> = {
    PRODUCED: 'the source led to the target being made (task -> artifact)',
    INFORMED: 'the source was context the target was built from',
    CALLS: 'the source invokes the target',
    SUPERSEDES: 'the source replaces the target; the target is stale',
};

/**
 * The relations that carry the work forward, as opposed to the ones that merely
 * supply context. Recall walks these first when spending its budget, and the
 * renderer prefers them when a node has more than one branch it could hang from.
 */
export const SPINE_RELATIONS: ReadonlySet<string> = new Set(['PRODUCED', 'CALLS', 'SUPERSEDES']);

/** An audience label every agent holds implicitly. */
export const ALL_AGENTS = '*';

/** Read by the engine, not just by the model: it becomes part of the system prompt. */
export const PREFERENCE_KIND = 'preference';

/**
 * `hint` is the recovery step, kept separate from the message because the tool
 * layer returns both to the model as `{error, hint}` rather than throwing.
 */
export class MemoryError extends Error {
    readonly hint?: string;

    constructor(message: string, hint?: string) {
        super(message);
        this.name = 'MemoryError';
        this.hint = hint;
    }
}

export interface MemoryFile {
    /** `<id>.<ext>`; older graphs hold `/memory/<id>.<ext>` — read it through `fileName` */
    path: string;
    bytes: number;
    sha256: string;
    /** extension without the dot, '' when there was none */
    format: string;
}

export interface MemoryNode {
    id: string;
    kind: string;
    /** the searchable, embeddable summary — the only text that is ranked */
    text: string;
    /** who may see this node; `['*']` is everyone */
    audience: string[];
    createdAt: string;
    updatedAt: string;
    /** last time a `memory_load` returned it; the input to recency decay */
    lastUsedAt: string;
    useCount: number;
    /** optimistic-concurrency token */
    revision: number;
    metadata?: Record<string, unknown>;
    file?: MemoryFile;
}

/** Graphology holds source and target itself, so they are not attributes. */
export interface MemoryEdgeAttrs {
    relation: Relation;
    createdAt: string;
    /** narrower than either endpoint when set; usually absent */
    audience?: string[];
}

export interface MemoryEdge {
    source: string;
    target: string;
    relation: Relation;
}

export interface MemoryQuery {
    /** semantic query; omitted means a pure filter listing */
    text?: string;
    kinds?: string[];
    /** how many seed nodes the ranker returns before the graph is stitched */
    limit?: number;
    maxHops?: number;
    maxNodes?: number;
    /** ISO timestamp; nodes created before it are excluded */
    newerThan?: string;
    minScore?: number;
}

/**
 * The edge a stitched node was reached by. A recollection renders as a tree,
 * and this is the branch each node hangs from; the edges left over once every
 * node has used its own are the ones the tree cannot carry.
 */
export interface NodeVia {
    from: string;
    relation: Relation;
    /** the edge runs from `from` to this node rather than back the other way */
    outbound: boolean;
}

export interface ScoredNode {
    node: MemoryNode;
    score: number;
    /** the ranker found this one; everything else is here to connect it */
    seed: boolean;
    /** absent on a seed: nothing reached it, it was the reason for the walk */
    via?: NodeVia;
}

export interface Recollection {
    nodes: ScoredNode[];
    edges: MemoryEdge[];
    /** ids of the seeds, in rank order */
    seeds: string[];
    /** nodes were dropped to stay inside the budget */
    truncated: boolean;
}

export type MemoryAccess = 'read' | 'read-write' | 'full';

/**
 * `sees` and `writes` are the mask, and they are resolved from config before a
 * tool is ever built. Neither is a tool parameter: an agent that could name its
 * own audience could read another agent's slice just by asking.
 */
export interface MemoryBinding<TCtx = unknown> {
    access: MemoryAccess;
    /** audience labels this agent may read; `'*'` is implicit */
    sees?: string[] | ((ctx: TCtx) => string[]);
    /** labels it may write; defaults to `['*']` */
    writes?: string[];
    autoRecall?: AutoRecall;
}

export interface AutoRecall {
    query: 'last_user_input' | 'none';
    limit: number;
}

export interface ResolvedMemoryBinding {
    access: MemoryAccess;
    sees: string[];
    writes: string[];
    autoRecall?: AutoRecall;
}

export const canWrite = (b: ResolvedMemoryBinding): boolean => b.access !== 'read';
export const canForget = (b: ResolvedMemoryBinding): boolean => b.access === 'full';

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

/**
 * What a tool did, in the form the trajectory keeps it. Ids and counts only —
 * the prose lives in a payload, so a replay can be reasoned about without
 * rehydrating every body.
 */
export interface MemoryRecallSpec {
    kind: 'recall';
    query: MemoryQuery;
    /** the matches; the rest of `nodes` is stitched context */
    seeds: string[];
    nodes: { id: string; kind: string; score: number }[];
    edges: MemoryEdge[];
    /** the rendered block the model actually saw */
    content: string;
}

export interface MemoryOpSpec {
    kind: 'op';
    /**
     * `load` is here rather than under recall: it hands the model whole bodies,
     * and it writes. `grep` is here because it is not a recall either — there is
     * no query vector, no subgraph and no ranking to record, only the nodes a
     * pattern happened to hit.
     */
    op: 'commit' | 'forget' | 'load' | 'grep';
    /** sha256(runId, callId) — deterministic, so a replay is deduplicated */
    opId: string;
    /** nodes this op created, changed, removed or read in full */
    nodes: { id: string; kind: string; revision: number }[];
    edges: MemoryEdge[];
    /** remembered files copied in, or bytes dropped */
    files: number;
}

/**
 * Deny by default: a node is visible when it is public, or when the reader
 * holds one of the labels it carries.
 */
export function visible(node: MemoryNode, sees: readonly string[]): boolean {
    return node.audience.some((a) => a === ALL_AGENTS || sees.includes(a));
}

/** An edge needs both endpoints visible before its own labels are consulted. */
export function edgeVisible(attrs: MemoryEdgeAttrs, sees: readonly string[]): boolean {
    return (
        !attrs.audience?.length || attrs.audience.some((a) => a === ALL_AGENTS || sees.includes(a))
    );
}
