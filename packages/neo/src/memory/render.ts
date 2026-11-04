import { fileName } from './files.ts';
import {
    SPINE_RELATIONS,
    type MemoryEdge,
    type MemoryNode,
    type NodeVia,
    type Recollection,
    type ScoredNode,
} from './types.ts';

// ---------------------------------------------------------------------------
// What the model actually reads
//
// An outline, because the block has exactly one audience: `memory_search` and
// auto-recall both hand it straight to a model, and nothing human or machine
// consumes it — the HTML export draws its own diagram from the graph.
//
// It replaced a mermaid graph over a legend, which carried the same subgraph
// twice: topology above, text below, joined only by the id. Answering "what
// does this script call" meant carrying a 26-character id from one half into
// the other, and the halves were sorted differently, so the answer sat as far
// from the question as the sort could put it. An outline states each id once,
// with its text under it and its neighbours around it.
//
// The tree is mostly the walk: `stitch` records the edge that admitted each
// node, so nesting is how recall got there. Seeds are the exception — nothing
// admitted them — and left as roots they turned a well-matched subgraph into a
// flat list, so each adopts its best-connected higher-ranked neighbour instead.
// Whatever edges that leaves over become back-references, always drawn under
// the endpoint that appeared later, so a `+` line never points forward.
//
// No SUPERSEDES arrow can appear on the ordinary path: recall drops the node
// one points at, so the edge loses an endpoint before it reaches here. It shows
// up only under `stale`, which is the audit view, and the house rules in
// `agents/memory-instructions.md` therefore do not teach the model to look for
// one.
//
// The preferences block is here too. It is the other thing the runtime renders
// out of the graph for a model to read, and it exists for the one reason a
// static document cannot cover it: each line carries a live id, without which a
// preference can be read but not superseded.
// ---------------------------------------------------------------------------

export const RECOLLECTION_TAG = 'memory-recollection';

export const PREFERENCES_TAG = 'memory-preferences';

/** Enough to judge relevance; the model calls `memory_load` for the rest. */
const TEXT_CLIP = 160;

/** Two columns per level of nesting, so the tree is the indentation. */
const STEP = 2;

/** Where text sits under its header; a deeper walk pushes it right, never over it. */
const TEXT_COLUMN = 6;

export interface RenderOptions {
    /** wrap in the <memory-recollection> element; off for CLI output */
    tagged?: boolean;
    clip?: number;
    now?: number;
}

interface Placed {
    scored: ScoredNode;
    depth: number;
    /** the branch this one hangs from; absent at the left margin */
    via?: NodeVia;
    /** edges the nesting could not carry, hung here as back-references */
    refs: MemoryEdge[];
}

export function renderRecollection(rec: Recollection, opts: RenderOptions = {}): string {
    if (!rec.nodes.length) {
        return '';
    }
    const lines: string[] = [];
    for (const [i, entry] of layout(rec).entries()) {
        if (i && entry.depth === 0) {
            lines.push('');
        }
        lines.push(...block(entry, opts));
    }
    if (rec.truncated) {
        lines.push('', '(more memory matched than fits; narrow the query or raise max_nodes)');
    }
    const text = lines.join('\n');
    return opts.tagged === false ? text : `<${RECOLLECTION_TAG}>\n${text}\n</${RECOLLECTION_TAG}>`;
}

/**
 * Depth-first along the branches the walk took, roots in seed order. A node
 * whose parent the budget cut is promoted to a root rather than dropped: it
 * survived the ranking, so it belongs in the answer.
 */
function layout(rec: Recollection): Placed[] {
    const at = new Map(rec.nodes.map((s, i) => [s.node.id, i]));
    const parents = branches(rec, at);

    const children = new Map<string, ScoredNode[]>();
    const roots: ScoredNode[] = [];
    for (const scored of rec.nodes) {
        const parent = parents.get(scored.node.id)?.from;
        if (parent !== undefined) {
            children.set(parent, [...(children.get(parent) ?? []), scored]);
        } else {
            roots.push(scored);
        }
    }
    const rank = new Map(rec.seeds.map((id, i) => [id, i]));
    const place = (id: string): number => rank.get(id) ?? Number.MAX_SAFE_INTEGER;
    roots.sort((a, b) => place(a.node.id) - place(b.node.id));

    const order: Placed[] = [];
    const walk = (scored: ScoredNode, depth: number): void => {
        order.push({ scored, depth, via: parents.get(scored.node.id), refs: [] });
        for (const child of children.get(scored.node.id) ?? []) {
            walk(child, depth + 1);
        }
    };
    for (const root of roots) {
        walk(root, 0);
    }

    // Everything the nesting has not already said, hung off whichever endpoint
    // came out later — so resolving one only ever means looking back up.
    const nested = new Set(
        [...parents].map(([id, via]) => {
            const [source, target] = via.outbound ? [via.from, id] : [id, via.from];
            return edgeKey(source, target, via.relation);
        }),
    );
    const position = new Map(order.map((entry, i) => [entry.scored.node.id, i]));
    for (const edge of rec.edges) {
        if (nested.has(edgeKey(edge.source, edge.target, edge.relation))) {
            continue;
        }
        const source = position.get(edge.source);
        const target = position.get(edge.target);
        if (source !== undefined && target !== undefined) {
            order[Math.max(source, target)]?.refs.push(edge);
        }
    }
    return order;
}

/**
 * Which branch each node hangs from. `stitch` records one for anything it had
 * to walk to, but never for a seed — nothing reached a seed, it was the reason
 * for the walk. Two seeds joined by an edge would then both sit at the left
 * margin with the link between them demoted to a `+`, so the better a query
 * matched the flatter it drew, which is backwards.
 *
 * So a node with no branch of its own adopts one, preferring the spine and then
 * the best-ranked neighbour. Only a neighbour that ranked *higher* may be
 * adopted, which is what makes this a forest: every parent is strictly earlier
 * in one total order, so no chain of them can close into a cycle.
 */
function branches(rec: Recollection, at: ReadonlyMap<string, number>): Map<string, NodeVia> {
    const parents = new Map<string, NodeVia>();
    const touching = new Map<string, MemoryEdge[]>();
    for (const scored of rec.nodes) {
        const via = scored.via;
        const from = via ? at.get(via.from) : undefined;
        // Strictly earlier, on the same total order the adoption below uses:
        // one rule for both is what keeps `walk` from ever meeting a cycle.
        if (via && from !== undefined && from < at.get(scored.node.id)!) {
            parents.set(scored.node.id, via);
        }
    }
    for (const edge of rec.edges) {
        if (!at.has(edge.source) || !at.has(edge.target)) {
            continue;
        }
        touching.set(edge.source, [...(touching.get(edge.source) ?? []), edge]);
        touching.set(edge.target, [...(touching.get(edge.target) ?? []), edge]);
    }

    for (const scored of rec.nodes) {
        const id = scored.node.id;
        if (parents.has(id)) {
            continue;
        }
        const mine = at.get(id)!;
        let best: { spine: boolean; at: number; via: NodeVia } | undefined;
        for (const edge of touching.get(id) ?? []) {
            const from = edge.source === id ? edge.target : edge.source;
            const there = at.get(from)!;
            if (there >= mine) {
                continue;
            }
            const spine = SPINE_RELATIONS.has(edge.relation);
            if (best && !(spine && !best.spine) && !(spine === best.spine && there < best.at)) {
                continue;
            }
            best = {
                spine,
                at: there,
                via: { from, relation: edge.relation, outbound: edge.source === from },
            };
        }
        if (best) {
            parents.set(id, best.via);
        }
    }
    return parents;
}

function edgeKey(source: string, target: string, relation: string): string {
    return `${source}|${relation}|${target}`;
}

function block(entry: Placed, opts: RenderOptions): string[] {
    const { node } = entry.scored;
    const now = opts.now ?? Date.now();
    const indent = ' '.repeat(Math.max(TEXT_COLUMN, (entry.depth + 2) * STEP));

    const lines = [`${' '.repeat(entry.depth * STEP)}${header(entry)}`];
    if (node.file) {
        const facts = [fileName(node.file), bytes(node.file.bytes), used(node, now)];
        lines.push(`${indent}${facts.join(' · ')}`);
    }
    const summary = clipped(node.text, opts.clip ?? TEXT_CLIP);
    if (summary) {
        lines.push(`${indent}${summary}`);
    }
    for (const ref of entry.refs) {
        const outbound = ref.source === node.id;
        const other = outbound ? ref.target : ref.source;
        lines.push(`${indent}+ ${step(outbound, ref.relation)}  ${other}`);
    }
    return lines;
}

/**
 * A root leads with its score, a child with the edge that reached it. A child
 * that the ranker also matched leads with both: the arrow says how the outline
 * got here, the score says it would have been worth reading regardless.
 */
function header(entry: Placed): string {
    const { node, seed, score } = entry.scored;
    const via = entry.via;
    const tail = `${label(node.kind)}  ${node.id}`;
    if (!via || entry.depth === 0) {
        return `${seed ? score.toFixed(2) : '  --'}  ${tail}`;
    }
    const reached = step(via.outbound, via.relation);
    return seed ? `${reached}  ${score.toFixed(2)}  ${tail}` : `${reached}  ${tail}`;
}

/** `→` when the line above is the edge's source, `←` when it is the target. */
function step(outbound: boolean, relation: string): string {
    return `${outbound ? '\u2192' : '\u2190'}${relation.toLowerCase()}`;
}

/** Kinds are a closed vocabulary, but a project may add its own — so still guard. */
function label(kind: string): string {
    return kind.replace(/[^A-Za-z0-9_ -]/g, '') || 'node';
}

function clipped(text: string, clip: number): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > clip ? `${flat.slice(0, clip - 1)}…` : flat;
}

function bytes(n: number): string {
    return n < 1024
        ? `${n} B`
        : n < 1024 * 1024
          ? `${(n / 1024).toFixed(1)} KB`
          : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function used(node: MemoryNode, now: number): string {
    if (!node.useCount) {
        return 'unused';
    }
    const days = Math.floor((now - Date.parse(node.lastUsedAt)) / 86_400_000);
    const ago = days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days}d ago`;
    return `used ${node.useCount}\u00d7, ${ago}`;
}

export function renderPreferences(nodes: readonly MemoryNode[]): string {
    if (!nodes.length) {
        return '';
    }
    const lines = nodes.map((n) => `- ${oneLine(n.text)} [${n.id}]`);
    return [
        `<${PREFERENCES_TAG}>`,
        "Standing instructions from earlier runs. They apply unless this run's",
        'request contradicts them; to change one, commit the replacement and link',
        'it to the id here with SUPERSEDES.',
        ...lines,
        `</${PREFERENCES_TAG}>`,
    ].join('\n');
}

/** Never clipped: half an instruction is a different instruction. */
function oneLine(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}
