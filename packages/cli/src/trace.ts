import {
    contentToText,
    coveredIds,
    totalUsage,
    type AgentState,
    type Message,
    type Payload,
    type PayloadResolver,
    type TrajectoryNode,
} from '@zenera/neo';
import { format } from './narrate.ts';
import { describeCall, summarise } from './tui/wrap.ts';

// ---------------------------------------------------------------------------
// A run, written for a model to read
//
// `report.html` is for a person: every message, every payload, pan and zoom.
// This is the same trajectory as one Mermaid flowchart — one line per node,
// short sequential ids, every edge collected at the bottom. The picture is not
// the point. The point is that a whole run fits in a context window, so a
// reader can see the shape of it (a loop, forty shell commands, a branch that
// failed) and then ask for the two or three nodes that matter, by id.
//
// Node text is built from types and identifiers and then stripped to a
// conservative character set: nothing a model wrote reaches the parser.
// ---------------------------------------------------------------------------

export interface TraceEntry {
    /** diagram id — `n1`, `n2`, …, in the order the run appended nodes */
    key: string;
    node: TrajectoryNode;
    depth: number;
    /** the branch this ran in, or null on the trunk */
    branch: string | null;
    /** hidden from the model's context by a later compaction */
    covered: boolean;
    /** the id of the compaction that hid it, when it is on the same level */
    coveredBy?: string;
    children: TraceBranch[];
    turnStart: number | null;
    startMs: number | null;
    endMs: number | null;
}

export interface TraceBranch {
    name: string;
    agent: string;
    status: string;
    entries: TraceEntry[];
    startMs: number | null;
    endMs: number | null;
    turnStart: number | null;
    /** the one branch the join actually waited for */
    slowest: boolean;
}

export interface Trace {
    root: TraceEntry[];
    /** every entry, branches included, in key order */
    entries: TraceEntry[];
    byKey: Map<string, TraceEntry>;
}

// ---------------------------------------------------------------------------
// Flattening
// ---------------------------------------------------------------------------

/**
 * Number every node in the run, branches included.
 *
 * A join's branches ran between the fork and the join, so they are numbered
 * there — which means recursing into them before the join takes its own
 * number. Nesting is free: a branch's own fork hangs off a join in its nodes.
 */
function flatten(
    nodes: readonly TrajectoryNode[],
    depth: number,
    branch: string | null,
    acc: TraceEntry[],
): TraceEntry[] {
    const hidden = coveredIds(nodes as TrajectoryNode[]);
    const level: TraceEntry[] = [];
    for (const node of nodes) {
        const entry: TraceEntry = {
            key: '',
            node,
            depth,
            branch,
            covered: hidden.has(node.id),
            children: [],
            turnStart: null,
            startMs: null,
            endMs: null,
        };
        if (node.type === 'join') {
            for (const b of node.branches) {
                entry.children.push({
                    name: b.name,
                    agent: b.agent,
                    status: b.status,
                    entries: flatten(b.nodes, depth + 1, b.name, acc),
                    startMs: null,
                    endMs: null,
                    turnStart: null,
                    slowest: false,
                });
            }
        }
        entry.key = `n${acc.length + 1}`;
        acc.push(entry);
        level.push(entry);
    }
    // Which compaction hid what, now that everything on this level has a name.
    // "Compacted" on its own invites the wrong conclusion — that the node did
    // not happen. Naming the summary that replaced it points at the answer.
    const byNodeId = new Map(level.map((e) => [e.node.id, e]));
    for (const e of level) {
        if (e.node.type !== 'compaction') {
            continue;
        }
        for (const id of e.node.covers) {
            const hidden = byNodeId.get(id);
            if (hidden) {
                hidden.coveredBy = e.key;
            }
        }
    }
    return level;
}

export function traceOf(state: AgentState): Trace {
    const entries: TraceEntry[] = [];
    const root = flatten(state.trajectory, 0, null, entries);
    time(root, null, null);
    return { root, entries, byKey: new Map(entries.map((e) => [e.key, e])) };
}

// ---------------------------------------------------------------------------
// Timing
//
// A node is stamped when it is appended, which is when the work behind it
// finished. So the interval between a node and the one before it in the same
// lane *is* that work, and every node has a start and a duration without
// either being stored.
//
// Offsets count from the start of the turn, not of the run: in a follow-up the
// question is how long this answer took, and counting from a conversation that
// began an hour ago answers nothing.
// ---------------------------------------------------------------------------

function stampOf(node: TrajectoryNode): number | null {
    const t = Date.parse(node.ts);
    return Number.isNaN(t) ? null : t;
}

function time(level: TraceEntry[], lanePrev: number | null, turnStart: number | null): void {
    let prev = lanePrev;
    let t0 = turnStart;
    for (const e of level) {
        const ts = stampOf(e.node);
        // A real user turn resets the clock and starts at itself: the gap since
        // the previous run is waiting, not work. Synthetic inputs are not turns.
        const opensTurn = !e.branch && e.node.type === 'user_input' && !e.node.synthetic;
        const start = opensTurn || prev === null ? ts : prev;
        // A lane that never sees a turn opener — a branch, or a trajectory that
        // begins mid-conversation — counts from where it itself began. Anything
        // else puts the origin after the first node and reports it as negative.
        if (opensTurn || t0 === null) {
            t0 = start;
        }
        e.turnStart = t0;
        e.startMs = start;
        e.endMs = ts;
        if (e.node.type === 'join') {
            let slowest: TraceBranch | null = null;
            for (const br of e.children) {
                // Branches run between the fork and the join, so they start
                // where the trunk left off and share the turn that forked them.
                time(br.entries, prev, e.turnStart);
                const last = br.entries.at(-1);
                br.turnStart = e.turnStart;
                br.startMs = prev;
                br.endMs = last ? last.endMs : prev;
                if (br.entries.length && (!slowest || (br.endMs ?? 0) > (slowest.endMs ?? 0))) {
                    slowest = br;
                }
            }
            if (slowest) {
                slowest.slowest = true;
            }
        }
        prev = ts;
    }
}

function secs(ms: number): string {
    const s = ms / 1000;
    if (s < 100) {
        return `${s.toFixed(1)}s`;
    }
    const m = Math.floor(s / 60);
    return `${m}m${String(Math.floor(s - m * 60)).padStart(2, '0')}s`;
}

function span(ms: number): string {
    return ms < 1000 ? `${Math.round(ms)}ms` : secs(ms);
}

/**
 * Offset of a node's start from the beginning of its turn.
 *
 * Clamped at zero. Nothing can begin before the turn that contains it, so a
 * negative number here is a clock that went backwards between two appends —
 * and `t+-69.2s` is worse than useless to a reader trying to follow a sequence.
 */
function startedAt(e: TraceEntry | TraceBranch): string {
    return e.startMs === null || e.turnStart === null
        ? ''
        : secs(Math.max(0, e.startMs - e.turnStart));
}

/** How long the work behind a node took. Blank when it is not worth a number. */
function took(e: TraceEntry | TraceBranch): string {
    if (e.startMs === null || e.endMs === null) {
        return '';
    }
    const ms = e.endMs - e.startMs;
    return ms < 10 ? '' : span(ms);
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/**
 * Everything a model wrote passes through here before it reaches the diagram.
 *
 * This is a boundary, not a tidy-up: tool arguments and results are attacker
 * input as far as the Mermaid parser is concerned. The character class is
 * deliberately narrower than anything that could be a delimiter — no quotes,
 * no brackets, no `#`, no `<`, no `>`, no `%`, no newlines. What survives
 * cannot open a label, close one, start a comment or draw an edge. Widen the
 * budget when a name needs room; never widen the class.
 */
const UNSAFE = /[^\w .:\-/+=()]/g;
const LABEL_MAX = 110;

export function safe(text: string, max = LABEL_MAX): string {
    return String(text).replace(UNSAFE, ' ').replace(/\s+/g, ' ').slice(0, max).trim();
}

function base(path: string): string {
    return path.split('/').pop() || path;
}

function preview(p: Payload | undefined): string {
    return p?.preview ?? '';
}

/** One short line saying what a node is, in the fewest identifiers that say it. */
function labelOf(n: TrajectoryNode, opts: TraceOptions): string {
    switch (n.type) {
        case 'user_input':
            return n.synthetic ? 'user input (synthetic)' : 'user input';
        case 'system_prompt': {
            const src = (n.sources ?? []).map((s) => base(s.path)).join(', ');
            return safe(src ? `system prompt ${src}` : 'system prompt');
        }
        case 'load_skills':
            return safe(`skills ${n.skills.map((s) => s.name).join(', ')}`);
        case 'memory_recall':
            return `recall ${n.nodes.length} nodes`;
        case 'memory_op':
            return `memory ${safe(n.op, 20)} ${n.nodes.length} nodes`;
        case 'llm_call': {
            const parts = [safe(`llm ${n.model}`, 60)];
            if (opts.usage !== false) {
                parts.push(`${format(n.usage.inputTokens)} in ${format(n.usage.outputTokens)} out`);
                // Only when there was any: on a model that does not think, or
                // one whose knobs were left off, the absence is the answer.
                if (n.usage.reasoningTokens > 0) {
                    parts.push(`${format(n.usage.reasoningTokens)} thinking`);
                }
            }
            if (n.toolCalls.length) {
                parts.push(safe(`calls ${n.toolCalls.map((c) => c.name).join(', ')}`, 60));
            }
            return parts.join(' · ');
        }
        case 'tool_call': {
            const { subject } = describeCall(n.name, preview(n.args));
            return safe(subject ? `${n.name} ${subject}` : n.name);
        }
        case 'tool_result': {
            const said = safe(summarise(n.name, preview(n.result)), 70);
            const head = n.isError ? `ERROR ${n.name}` : n.name;
            return `${safe(head, 40)} = ${said}`;
        }
        case 'handoff':
            return safe(`handoff ${n.from} to ${n.to}`);
        case 'fork':
            // The context mode is what the branches started from; without it a
            // reader cannot tell an informed branch from a cold one.
            return safe(
                `fork (${n.contextMode} context) ${n.branches.map((b) => b.name).join(', ')}`,
            );
        case 'join':
            return safe(`join ${n.branches.map((b) => `${b.name}=${b.status}`).join(', ')}`);
        case 'compaction':
            return safe(`compaction ${n.reason} (${n.covers.length} nodes hidden)`);
        case 'final_output':
            return 'final output';
        default:
            return safe((n as TrajectoryNode).type);
    }
}

/** The whole node text: id, what it is, whose turn it was, and when. */
function textOf(e: TraceEntry, previous: TraceEntry | undefined, opts: TraceOptions): string {
    const parts = [`${e.key} ${labelOf(e.node, opts)}`];
    // The agent is only worth a column when it is news — on a run that never
    // hands off it would be the same word on every line.
    if (e.node.agent && e.node.agent !== previous?.node.agent) {
        parts.push(`@${safe(e.node.agent, 40)}`);
    }
    if (opts.timing !== false) {
        const at = startedAt(e);
        const d = took(e);
        if (at) {
            parts.push(`t+${at}`);
        }
        if (d) {
            parts.push(`took ${d}`);
        }
    }
    if (e.covered) {
        parts.push(e.coveredBy ? `hidden by ${e.coveredBy}` : 'hidden by a compaction');
    }
    return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Emitting
// ---------------------------------------------------------------------------

const CLASSES: Partial<Record<TrajectoryNode['type'], string>> = {
    llm_call: 'llm',
    tool_call: 'tool',
    tool_result: 'tool',
    compaction: 'comp',
    fork: 'fork',
    join: 'fork',
    final_output: 'final',
    handoff: 'hand',
};

function classOf(n: TrajectoryNode): string | undefined {
    // A failed call is the one thing anyone looks for in a trace, so it is
    // coloured by outcome rather than by type.
    return n.type === 'tool_result' && n.isError ? 'err' : CLASSES[n.type];
}

function shape(key: string, n: TrajectoryNode, text: string): string {
    const body = `"${text}"`;
    if (n.type === 'fork' || n.type === 'join') {
        return `${key}{{${body}}}`;
    }
    if (n.type === 'final_output') {
        return `${key}([${body}])`;
    }
    if (n.type === 'user_input' || n.type === 'system_prompt') {
        return `${key}[/${body}/]`;
    }
    return `${key}[${body}]`;
}

interface Edges {
    flow: string[];
    branches: string[];
    calls: string[];
    /** class list -> the nodes wearing it, so one statement covers them all */
    classes: Map<string, string[]>;
}

function declare(level: TraceEntry[], lines: string[], opts: TraceOptions): void {
    let previous: TraceEntry | undefined;
    for (const e of level) {
        lines.push(`    ${shape(e.key, e.node, textOf(e, previous, opts))}`);
        if (e.node.type === 'join') {
            for (const [i, br] of e.children.entries()) {
                if (!br.entries.length) {
                    continue;
                }
                const title = [
                    safe(`${br.name} ${br.agent} ${br.status}`, 60),
                    ...(startedAt(br) ? [`t+${startedAt(br)}`] : []),
                    ...(took(br) ? [`took ${took(br)}`] : []),
                    ...(br.slowest ? ['slowest'] : []),
                ].join(' · ');
                lines.push(`    subgraph sg_${e.key}_${i}["${title}"]`);
                lines.push('    direction TB');
                declare(br.entries, lines, opts);
                lines.push('    end');
            }
        }
        previous = e;
    }
}

function collect(level: TraceEntry[], edges: Edges): void {
    const at = new Map<TraceEntry, number>(level.map((e, i) => [e, i]));
    const calls = new Map<string, TraceEntry>();
    const results = new Map<string, TraceEntry>();
    for (const e of level) {
        if (e.node.type === 'tool_call') {
            calls.set(e.node.callId, e);
        }
        if (e.node.type === 'tool_result') {
            results.set(e.node.callId, e);
        }
    }
    // A pairing edge earns its place only when the two ends are apart: when
    // they are neighbours the flow already draws it, and doubling every arrow
    // would bury the batch of parallel calls that is the reason to look.
    const apart = (a: TraceEntry, b: TraceEntry): boolean =>
        Math.abs((at.get(a) ?? 0) - (at.get(b) ?? 0)) > 1;

    let previous: TraceEntry | undefined;
    for (const e of level) {
        if (previous) {
            edges.flow.push(`    ${previous.key} --> ${e.key}`);
        }
        const cls = classOf(e.node);
        const applied = [...(cls ? [cls] : []), ...(e.covered ? ['covered'] : [])];
        if (applied.length) {
            const list = applied.join(',');
            edges.classes.set(list, [...(edges.classes.get(list) ?? []), e.key]);
        }
        if (e.node.type === 'llm_call') {
            for (const c of e.node.toolCalls) {
                const target = calls.get(c.callId) ?? results.get(c.callId);
                if (target && apart(e, target)) {
                    edges.calls.push(`    ${e.key} -.-> ${target.key}`);
                }
            }
        }
        if (e.node.type === 'tool_call') {
            const answer = results.get(e.node.callId);
            if (answer && apart(e, answer)) {
                edges.calls.push(`    ${e.key} -.-> ${answer.key}`);
            }
        }
        if (e.node.type === 'join') {
            const callId = e.node.callId;
            const fork = level.find((x) => x.node.type === 'fork' && x.node.callId === callId);
            for (const br of e.children) {
                collect(br.entries, edges);
                if (!br.entries.length) {
                    continue;
                }
                if (fork) {
                    edges.branches.push(`    ${fork.key} -.-> ${br.entries[0].key}`);
                }
                edges.branches.push(`    ${br.entries.at(-1)?.key} -.-> ${e.key}`);
            }
        }
        previous = e;
    }
}

// ---------------------------------------------------------------------------
// The header
//
// `%%` lines are comments: Mermaid drops them, a reader does not. They are
// where the run explains itself — what it was, who ran it, which branches
// existed and how often each tool was reached for. A count is what turns
// "this looks repetitive" into something a reader can act on.
// ---------------------------------------------------------------------------

function tally(entries: readonly TraceEntry[]): string[] {
    const counts = new Map<string, number>();
    for (const e of entries) {
        if (e.node.type === 'tool_call') {
            counts.set(e.node.name, (counts.get(e.node.name) ?? 0) + 1);
        }
    }
    return [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([name, n]) => `${safe(name, 40)} x${n}`);
}

const WRITES = new Set(['write_file', 'apply_patch', 'copy_file', 'move_file']);

/**
 * What the run did with memory, zeros included. The `tools` row only lists
 * calls that happened, and a commit that never happened is the commonest
 * memory finding there is: absent from a list, a reader does not see it.
 */
function memoryRows(entries: readonly TraceEntry[], bound: boolean): string[] {
    let recalls = 0;
    let recalled = 0;
    let commits = 0;
    let committed = 0;
    let files = 0;
    let written = 0;
    const calls = new Map<string, number>();
    for (const { node: n } of entries) {
        if (n.type === 'memory_recall') {
            recalls++;
            recalled += n.nodes.length;
        } else if (n.type === 'memory_op' && n.op === 'commit') {
            commits++;
            committed += n.nodes.length;
            files += n.files;
        } else if (n.type === 'tool_call') {
            calls.set(n.name, (calls.get(n.name) ?? 0) + 1);
            if (WRITES.has(n.name)) {
                written++;
            }
        }
    }
    const used = (name: string): number => calls.get(name) ?? 0;
    const reads = used('memory_search') + used('memory_grep') + used('memory_load');
    if (!bound && !recalls && !reads && !commits) {
        return [];
    }
    const label = bound ? '' : 'memory';
    const lines = [
        row(
            label,
            `recall ${recalls} (${recalled} nodes) · search ${used('memory_search')} · ` +
                `grep ${used('memory_grep')} · load ${used('memory_load')} · ` +
                `commit ${commits} (${committed} nodes, ${files} files)`,
        ),
    ];
    if (!commits && written) {
        lines.push(row('', `nothing committed after ${written} workspace file writes`));
    }
    return lines;
}

function elapsed(entries: readonly TraceEntry[]): string {
    const stamps = entries.map((e) => e.endMs).filter((t): t is number => t !== null);
    return stamps.length < 2 ? '' : span(Math.max(...stamps) - Math.min(...stamps));
}

/**
 * How much of the run was thinking, or nothing at all when none of it was.
 *
 * "Did this run reason?" is the commonest configuration question there is, and
 * a reasoning knob that never reached the provider looks exactly like a healthy
 * run. The trajectory has always known: an omitted row is the answer, and does
 * not cost a token on a model that cannot think in the first place.
 */
function thinking(state: AgentState, entries: readonly TraceEntry[]): string {
    const calls = entries.filter((e) => e.node.type === 'llm_call');
    const thought = calls.filter((e) => e.node.type === 'llm_call' && e.node.thinking).length;
    const tokens = totalUsage(state.trajectory).reasoningTokens;
    if (!thought && !tokens) {
        return '';
    }
    return `${thought} of ${calls.length} llm calls · ${format(tokens)} thinking tokens`;
}

function branchRoster(entries: readonly TraceEntry[]): string[] {
    const out: string[] = [];
    for (const e of entries) {
        if (e.node.type !== 'join') {
            continue;
        }
        const of = e.node.branches
            .map((b) => `${safe(b.name, 40)} (${safe(b.agent, 40)}, ${safe(b.status, 20)})`)
            .join(', ');
        out.push(`%%   ${e.key} joins ${of}`);
    }
    return out;
}

function row(label: string, value: string): string {
    return `%% ${label.padEnd(9)} ${value}`;
}

function header(state: AgentState, trace: Trace, opts: TraceOptions): string[] {
    const { entries } = trace;
    const kinds = new Map<string, number>();
    for (const e of entries) {
        kinds.set(e.node.type, (kinds.get(e.node.type) ?? 0) + 1);
    }
    const usage = totalUsage(state.trajectory);
    const agents = [...new Set(entries.map((e) => e.node.agent).filter(Boolean))];
    const where = opts.dir ? ` --dir ${opts.dir}` : '';

    const lines = [
        '%% Zenera Neo run trajectory — every node of one run, in order.',
        row('run', safe(opts.runId ?? state.runId, 80)),
        // The three directories a reader needs to go further, spelt out rather
        // than left to be reconstructed from the run id.
        ...(opts.dir ? [row('dir', safe(opts.dir, 200))] : []),
        ...(opts.workspace ? [row('workspace', safe(opts.workspace, 200))] : []),
        ...(opts.memory ? [row('memory', safe(opts.memory, 200))] : []),
        ...memoryRows(entries, Boolean(opts.memory)),
        row(
            'agent',
            `${safe(state.agentName, 40)} · started as ${safe(state.spec.startAgent, 40)}`,
        ),
        row('phase', state.error ? `${state.phase} — ${safe(state.error, 200)}` : state.phase),
        row(
            'nodes',
            `${entries.length} · ${kinds.get('llm_call') ?? 0} llm · ` +
                `${kinds.get('tool_call') ?? 0} tool calls · ${kinds.get('fork') ?? 0} forks`,
        ),
        row('tokens', `${format(usage.inputTokens)} in · ${format(usage.outputTokens)} out`),
    ];
    const thought = thinking(state, entries);
    if (thought) {
        lines.push(row('thinking', thought));
    }
    const took = elapsed(entries);
    if (took) {
        lines.push(row('elapsed', took));
    }
    if (agents.length > 1) {
        lines.push(row('agents', agents.map((a) => safe(a, 40)).join(', ')));
    }
    const tools = tally(entries);
    if (tools.length) {
        lines.push(row('tools', tools.join(', ')));
    }
    const roster = branchRoster(entries);
    if (roster.length) {
        lines.push(row('branches', 'each subgraph below is one branch of a fork'), ...roster);
    }
    // Compacted nodes are numbered like any other, because they happened. What
    // changed is only what the model could still see afterwards, and a reader
    // comparing the diagram to the transcript needs to be told which it is.
    const hidden = entries.filter((e) => e.covered).length;
    if (hidden) {
        lines.push(
            row('compacted', `${hidden} nodes are marked "hidden by" a later summary`),
            row('', 'they still ran; the model simply stopped seeing them'),
        );
    }
    lines.push(
        // Never a bare `%%`: Mermaid only strips a comment line with something
        // after the marker, and leaves the rest to the parser, which rejects it.
        '%% ---',
        row('reading', 'nN is a node id · t+ counts from the start of the turn'),
        row('', 'dotted edges are fork/join and calls answered out of order'),
        row('', 'nodes are declared in run order; every edge is in one block below'),
        row('detail', `zen inspect node n1 n2 n5..n9${where}`),
        // Named here because this is where the question forms. A reader who has
        // just found the node they distrust will not go looking for a verb.
        row('why', `zen inspect ask n5 "why did you do that?"${where}`),
        '%% ---',
    );
    return lines;
}

// ---------------------------------------------------------------------------

export interface TraceOptions {
    /** the run id to name in the header, when it differs from `state.runId` */
    runId?: string;
    /** the run directory, so the header can spell the command that opens a node */
    dir?: string;
    /** the files the run worked on */
    workspace?: string;
    /** the memory graph the run read, when it had one */
    memory?: string;
    timing?: boolean;
    usage?: boolean;
    /** false drops the palette: a model reads the labels, not the colours */
    style?: boolean;
}

export function traceMermaid(state: AgentState, opts: TraceOptions = {}): string {
    const trace = traceOf(state);
    const styled = opts.style !== false;
    const lines = header(state, trace, opts);
    lines.push('flowchart TD');
    if (styled) {
        // Pale fills on a saturated stroke: this diagram is pasted into
        // mermaid.live, a README or a PR, all of which are white.
        lines.push('    classDef llm fill:#e7effc,stroke:#4a72b8,color:#16305c;');
        lines.push('    classDef tool fill:#e4f4ed,stroke:#3f8c70,color:#124434;');
        lines.push('    classDef comp fill:#fbf1da,stroke:#a8842f,color:#5c4410;');
        lines.push('    classDef fork fill:#f2eafb,stroke:#8256b5,color:#3f2360;');
        lines.push('    classDef final fill:#d6efe2,stroke:#2f8a63,color:#0d3d2a;');
        lines.push('    classDef hand fill:#fbe9dc,stroke:#b06e3a,color:#5c3312;');
        lines.push('    classDef err fill:#fde7e4,stroke:#c24a3e,color:#7a1f16;');
        lines.push('    classDef covered opacity:0.55,stroke-dasharray:4 3;');
        lines.push('');
    }
    declare(trace.root, lines, opts);

    const edges: Edges = { flow: [], branches: [], calls: [], classes: new Map() };
    collect(trace.root, edges);
    const classes = styled
        ? [...edges.classes].map(([cls, keys]) => `    class ${keys.join(',')} ${cls};`)
        : [];
    const groups: [string, string[]][] = [
        ['flow — the order things happened', edges.flow],
        ['branches — fork out, join back', edges.branches],
        ['calls — a call and the answer it waited for, when they are apart', edges.calls],
        ['classes', classes],
    ];
    for (const [title, group] of groups) {
        if (group.length) {
            lines.push('', `%% ${title}`, ...group);
        }
    }
    return `${lines.join('\n')}\n`;
}

/** The node list on its own, for `--json`. */
export function traceIndex(trace: Trace): {
    id: string;
    nodeId: string;
    kind: string;
    agent: string;
    branch: string | null;
    ts: string;
    label: string;
}[] {
    return trace.entries.map((e) => ({
        id: e.key,
        nodeId: e.node.id,
        kind: e.node.type,
        agent: e.node.agent,
        branch: e.branch,
        ts: e.node.ts,
        label: labelOf(e.node, {}),
    }));
}

// ---------------------------------------------------------------------------
// Opening a node
// ---------------------------------------------------------------------------

export interface NodePart {
    name: string;
    text: string;
}

export interface NodeDetail {
    id: string;
    nodeId: string;
    kind: string;
    agent: string;
    branch: string | null;
    ts: string;
    label: string;
    parts: NodePart[];
    /** fields worth reading that are not payloads */
    facts: Record<string, string>;
}

interface NamedPayload {
    name: string;
    payload?: Payload;
    /** for a part that was never a blob, like the url of an image */
    literal?: string;
}

/**
 * The payloads a node carries, each under the name the trajectory gives it.
 *
 * `nodePayloads` already answers "what does this contribute to the context",
 * but it answers it as an unnamed list. A reader asking for one node wants to
 * know which blob is the request and which is the answer.
 */
function namedPayloads(n: TrajectoryNode): NamedPayload[] {
    const of = (name: string, payload: Payload | undefined): NamedPayload[] =>
        payload ? [{ name, payload }] : [];
    switch (n.type) {
        case 'user_input':
            return n.content.flatMap((part, i) =>
                part.type === 'text'
                    ? of(`content[${i}]`, part.text)
                    : [{ name: `${part.type}[${i}]`, literal: part.url }],
            );
        case 'system_prompt':
            return of('prompt', n.prompt);
        case 'load_skills':
            return of('content', n.content);
        case 'memory_recall':
            return of('recalled', n.content);
        case 'llm_call':
            return [
                ...of('request', n.request),
                ...of('thinking', n.thinking),
                ...of('text', n.text),
                ...n.toolCalls.flatMap((c) => of(`call ${c.name} (${c.callId})`, c.args)),
            ];
        case 'tool_call':
            return of('args', n.args);
        case 'tool_result':
            return of('result', n.result);
        case 'fork':
            return n.branches.flatMap((b) => of(`instructions ${b.name}`, b.instructions));
        case 'join':
            return n.branches.flatMap((b) => of(`output ${b.name}`, b.output));
        case 'compaction':
            return of('summary', n.summary);
        case 'final_output':
            return of('output', n.output);
        default:
            return [];
    }
}

function factsOf(n: TrajectoryNode): Record<string, string> {
    switch (n.type) {
        case 'llm_call':
            return {
                model: n.model,
                ...(n.ref && n.ref !== n.model ? { ref: n.ref } : {}),
                stopReason: n.stopReason,
                tokens:
                    `${n.usage.inputTokens} in, ${n.usage.outputTokens} out` +
                    (n.usage.reasoningTokens ? `, ${n.usage.reasoningTokens} thinking` : ''),
                ...(n.request ? {} : { request: 'not recorded — rerun with request recording on' }),
            };
        case 'tool_call':
            return { tool: n.name, callId: n.callId };
        case 'tool_result':
            return {
                tool: n.name,
                callId: n.callId,
                outcome: n.isError ? 'error' : 'ok',
                ...(n.durationMs === undefined ? {} : { took: span(n.durationMs) }),
            };
        case 'handoff':
            return { from: n.from, to: n.to, ...(n.reason ? { reason: n.reason } : {}) };
        case 'compaction':
            return { reason: n.reason, hidden: String(n.covers.length) };
        case 'memory_op':
            return { op: n.op, nodes: String(n.nodes.length), files: String(n.files) };
        case 'memory_recall':
            return { seeds: String(n.seeds.length), nodes: String(n.nodes.length) };
        case 'join':
            return Object.fromEntries(n.branches.map((b) => [b.name, b.error ?? b.status]));
        default:
            return {};
    }
}

/**
 * `n5`, or `n5..n9`. A range is how a reader asks about a stretch, which is
 * the shape of the question the diagram provokes ("what are n14 to n38 doing").
 */
export function parseNodeIds(words: readonly string[], known: Map<string, unknown>): string[] {
    const out: string[] = [];
    const number = (word: string): number => {
        const m = /^n(\d+)$/.exec(word);
        if (!m) {
            throw new Error(`"${word}" is not a node id — they look like n7`);
        }
        return Number(m[1]);
    };
    for (const word of words) {
        const range = word.split('..');
        const ids =
            range.length === 2
                ? sequence(number(range[0] as string), number(range[1] as string))
                : [`n${number(word)}`];
        for (const id of ids) {
            if (!known.has(id)) {
                throw new Error(`${id} is not in this run — it has ${known.size} nodes`);
            }
            if (!out.includes(id)) {
                out.push(id);
            }
        }
    }
    return out;
}

const MAX_RANGE = 200;

function sequence(from: number, to: number): string[] {
    if (to < from) {
        throw new Error(`n${from}..n${to} runs backwards`);
    }
    if (to - from + 1 > MAX_RANGE) {
        throw new Error(`n${from}..n${to} is over ${MAX_RANGE} nodes — ask for fewer`);
    }
    return Array.from({ length: to - from + 1 }, (_, i) => `n${from + i}`);
}

export async function nodeDetail(
    trace: Trace,
    ids: readonly string[],
    payloads: PayloadResolver,
): Promise<NodeDetail[]> {
    const entries = ids.map((id) => trace.byKey.get(id)).filter((e): e is TraceEntry => !!e);
    const named = new Map(entries.map((e) => [e, namedPayloads(e.node)]));
    const wanted = new Map(
        [...named.values()]
            .flatMap((parts) => parts.map((p) => p.payload))
            .filter((p): p is Payload => !!p)
            .map((p) => [p.sha256, p]),
    );
    // Resolved one at a time so that one missing blob costs one part rather
    // than the whole answer. A store can be pruned, copied without its blobs,
    // or simply older than the run — and a preview is still worth reading.
    const blobs = new Map(
        await Promise.all(
            [...wanted.values()].map(async (p): Promise<[string, string]> => [
                p.sha256,
                await resolve(payloads, p),
            ]),
        ),
    );
    // Deliberately whole and unsanitized: this is the reason the diagram can be
    // short. Having found the node, a reader needs what was actually said.
    return entries.map((e) => ({
        id: e.key,
        nodeId: e.node.id,
        kind: e.node.type,
        agent: e.node.agent,
        branch: e.branch,
        ts: e.node.ts,
        label: labelOf(e.node, {}),
        facts: factsOf(e.node),
        parts: (named.get(e) ?? []).flatMap((part) => {
            const text = part.literal ?? blobs.get(part.payload?.sha256 ?? '') ?? '(unresolved)';
            return part.name === 'request'
                ? [{ name: part.name, text }, ...requestParts(text)]
                : [{ name: part.name, text }];
        }),
    }));
}

/** Longest a message or a tool result runs in `messages` before it is clipped. */
const MESSAGE_CLIP = 400;

const clip = (s: string, n = MESSAGE_CLIP): string => {
    const flat = s.replace(/\s+/g, ' ').trim();
    return flat.length <= n ? flat : `${flat.slice(0, n)} … (+${flat.length - n} chars)`;
};

/**
 * The two questions a recorded request is usually opened for, answered without
 * printing it: which tools the call was offered, and what conversation it saw.
 */
export function requestParts(json: string): NodePart[] {
    let req: { messages?: unknown; tools?: unknown };
    try {
        req = JSON.parse(json) as typeof req;
    } catch {
        return [];
    }
    const out: NodePart[] = [];
    if (Array.isArray(req.messages)) {
        const lines = (req.messages as Message[]).map((m) => {
            switch (m.role) {
                case 'system':
                    return `[system] ${clip(m.content, 200)}`;
                case 'user':
                    return `[user] ${clip(contentToText(m.content))}`;
                case 'assistant':
                    return [
                        `[assistant${m.agent ? ` @${m.agent}` : ''}] ${clip(m.content) || '(no text)'}`,
                        ...(m.toolCalls ?? []).map(
                            (c) => `    -> ${c.name} ${clip(c.args, 300)} #${c.id}`,
                        ),
                    ].join('\n');
                case 'tool':
                    return `[tool ${m.name} #${m.callId}${m.isError ? ' ERROR' : ''}] ${clip(m.content)}`;
                default:
                    return `[${(m as { role?: string }).role ?? '?'}]`;
            }
        });
        out.push({ name: 'messages', text: lines.join('\n') });
    }
    if (Array.isArray(req.tools)) {
        const names = (req.tools as { name?: unknown }[])
            .map((t) => t?.name)
            .filter((n): n is string => typeof n === 'string');
        out.push({ name: 'tools', text: names.join('\n') });
    }
    return out;
}

const GONE = '(the blob is not in this session’s store; only the preview survives)';

async function resolve(payloads: PayloadResolver, p: Payload): Promise<string> {
    try {
        return await payloads.get(p);
    } catch {
        return p.preview ? `${p.preview}\n\n${GONE}` : GONE;
    }
}
