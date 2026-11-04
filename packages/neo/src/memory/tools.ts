/**
 * The six tools an agent gets. `search` and `load` are split because finding
 * is not reading — search returns stitched context the model never asked for,
 * and counting that as use would poison recency. `grep` is separate from
 * `search` because exactness is not a tuning of nearness: a ranking returns the
 * top of a list, so it can say what is closest but never that nothing is there.
 * `commit` is one transaction because a remembered thing is a subgraph, and
 * building it with three calls leaves the graph half-formed if the model stops
 * early. `forget` is separate because deleting rarely happens in the same
 * breath as creating, and a `forget` buried inside a truncated commit preview
 * would be both irreversible and invisible. `copy_file` is the only way a
 * remembered file reaches the sandbox, which never mounts the memory.
 *
 * `audience` reaches the schema only when the binding grants more than one
 * label, and `sees` never does: an agent that could name its own audience
 * could read another agent's slice just by asking for it.
 */
import { hash } from '../payload.ts';
import {
    type AnyTool,
    MEMORY_COMMIT_TOOL,
    MEMORY_COPY_FILE_TOOL,
    MEMORY_FORGET_TOOL,
    MEMORY_GREP_TOOL,
    MEMORY_LOAD_TOOL,
    MEMORY_SEARCH_TOOL,
    tool,
    type ToolContext,
    withEffects,
} from '../types.ts';
import { fileName, type FileSource } from './files.ts';
import { RevisionMismatch } from './graph.ts';
import { GREP_FIELDS, type GrepField, grepMemory } from './grep.ts';
import type { CommitEdge, CommitNode, MemoryIndex } from './index.ts';
import { renderRecollection } from './render.ts';
import {
    canForget,
    canWrite,
    KIND_HELP,
    MemoryError,
    type MemoryOpSpec,
    RELATION_HELP,
    type ResolvedMemoryBinding,
} from './types.ts';

/** Deterministic, so a replayed call is the same op and not a second one. */
export function memoryOpId(runId: string, callId: string): string {
    return hash(`${runId}\u0000${callId}`);
}

/** Enough nodes to settle a question, few enough not to be a context dump. */
const GREPPED = 20;

export interface MemoryToolsOptions {
    index: MemoryIndex;
    binding: ResolvedMemoryBinding;
}

interface SearchArgs {
    query: string;
    kinds?: string[];
    limit?: number;
    max_hops?: number;
    max_nodes?: number;
    newer_than?: string;
}

interface LoadArgs {
    ids: string[];
}

interface GrepArgs {
    pattern: string;
    regex?: boolean;
    case_sensitive?: boolean;
    kinds?: string[];
    in?: GrepField[];
    include_superseded?: boolean;
    limit?: number;
}

interface CommitArgs {
    nodes: {
        ref?: string;
        id?: string;
        kind?: string;
        text?: string;
        file?: string | { path: string };
        audience?: string[];
        expected_revision?: number;
    }[];
    edges?: { from: string; to: string; relation: string }[];
}

interface CopyFileArgs {
    id: string;
    to?: string;
    overwrite?: boolean;
}

interface ForgetArgs {
    ids: string[];
    reason?: string;
}

export function memoryTools<TCtx>(opts: MemoryToolsOptions): AnyTool<TCtx>[] {
    const { index, binding } = opts;
    const kinds = [...index.kinds];
    const relations = [...index.relations];
    const kindHelp = kinds
        .map((k) => `${k}: ${KIND_HELP[k as keyof typeof KIND_HELP] ?? ''}`)
        .join('; ');
    const relationHelp = relations
        .map((r) => `${r}: ${RELATION_HELP[r as keyof typeof RELATION_HELP] ?? ''}`)
        .join('; ');

    const tools: AnyTool<TCtx>[] = [
        tool<SearchArgs, TCtx>({
            name: MEMORY_SEARCH_TOOL,
            description:
                'Search memory for what was learned on earlier runs. Returns a diagram of ' +
                'the matching subgraph plus a legend of ids; read a node with ' +
                `${MEMORY_LOAD_TOOL}.`,
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'what you are trying to recall' },
                    kinds: {
                        type: 'array',
                        items: { type: 'string', enum: kinds },
                        description: 'restrict to these kinds',
                    },
                    limit: { type: 'integer', description: 'how many matches to seed from' },
                    max_hops: { type: 'integer', description: 'how far to follow links' },
                    max_nodes: { type: 'integer', description: 'cap on the returned subgraph' },
                    newer_than: {
                        type: 'string',
                        description: 'ISO timestamp; ignore anything older',
                    },
                },
                required: ['query'],
                additionalProperties: false,
            },
            execute: async (args, tc) => {
                const query = {
                    text: args.query,
                    kinds: args.kinds,
                    limit: args.limit,
                    maxHops: args.max_hops,
                    maxNodes: args.max_nodes,
                    newerThan: args.newer_than,
                };
                const rec = await index.search(query, binding.sees);
                const content = renderRecollection(rec);
                if (!content) {
                    return 'no memory of this';
                }
                return withEffects(content, {
                    kind: 'memory_op',
                    spec: {
                        kind: 'recall',
                        query,
                        seeds: [...rec.seeds],
                        nodes: rec.nodes.map((n) => ({
                            id: n.node.id,
                            kind: n.node.kind,
                            score: n.score,
                        })),
                        edges: [...rec.edges],
                        content,
                    },
                });
            },
        }),
        tool<LoadArgs, TCtx>({
            name: MEMORY_LOAD_TOOL,
            description:
                'Read memories in full by id, using the ids from a ' +
                `${MEMORY_SEARCH_TOOL} legend. A remembered file comes back inline when it ` +
                `is small; to open or run it, copy it into the workspace with ${MEMORY_COPY_FILE_TOOL}.`,
            parameters: {
                type: 'object',
                properties: {
                    ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
                },
                required: ['ids'],
                additionalProperties: false,
            },
            execute: async (args, tc) => {
                const opId = memoryOpId(tc.state.runId, tc.callId);
                const loaded = await index.load(args.ids, binding.sees, tc.services.clock);
                // Recorded because this is the only path that puts a whole body
                // in the context: a recall block carries a clipped line.
                const spec: MemoryOpSpec = {
                    kind: 'op',
                    op: 'load',
                    opId,
                    nodes: loaded.map((l) => ({
                        id: l.node.id,
                        kind: l.node.kind,
                        revision: l.node.revision,
                    })),
                    edges: [],
                    files: loaded.filter((l) => l.content !== undefined).length,
                };
                return withEffects(
                    loaded.map((l) => ({
                        id: l.node.id,
                        kind: l.node.kind,
                        text: l.node.text,
                        created: l.node.createdAt,
                        revision: l.node.revision,
                        metadata: l.node.metadata,
                        file: l.node.file
                            ? { name: fileName(l.node.file), bytes: l.node.file.bytes }
                            : undefined,
                        content: l.content,
                    })),
                    { kind: 'memory_op', spec },
                );
            },
        }),
        tool<GrepArgs, TCtx>({
            name: MEMORY_GREP_TOOL,
            description:
                'Find an exact string in memory, the way grep does: every node whose text, ' +
                'metadata or remembered file contains it, with the matching lines. Use this ' +
                `instead of ${MEMORY_SEARCH_TOOL} when the answer has to be complete rather ` +
                'than close — whether something was already recorded, or where a name, path, ' +
                'id or command appears. This is the only correct way to search the memory ' +
                'directly. Read a whole node with ' +
                `${MEMORY_LOAD_TOOL}.`,
            parameters: {
                type: 'object',
                properties: {
                    pattern: {
                        type: 'string',
                        description: 'the exact text to look for; matched case-insensitively',
                    },
                    regex: {
                        type: 'boolean',
                        description: 'read the pattern as a regular expression, matched per line',
                    },
                    case_sensitive: { type: 'boolean', description: 'match case exactly' },
                    kinds: {
                        type: 'array',
                        items: { type: 'string', enum: kinds },
                        description: 'restrict to these kinds',
                    },
                    in: {
                        type: 'array',
                        items: { type: 'string', enum: [...GREP_FIELDS] },
                        description: 'which parts to look in; all of them by default',
                    },
                    include_superseded: {
                        type: 'boolean',
                        description:
                            'also search nodes that have been corrected by a newer one; they come back marked stale',
                    },
                    limit: { type: 'integer', description: `nodes to return; default ${GREPPED}` },
                },
                required: ['pattern'],
                additionalProperties: false,
            },
            execute: async (args, tc) => {
                const opId = memoryOpId(tc.state.runId, tc.callId);
                let res;
                try {
                    res = await grepMemory(index.store, args.pattern, {
                        sees: binding.sees,
                        regex: args.regex,
                        caseSensitive: args.case_sensitive,
                        kinds: args.kinds,
                        in: args.in,
                        stale: args.include_superseded ? 'include' : 'exclude',
                        limit: args.limit ?? GREPPED,
                    });
                } catch (err) {
                    return refusal(err);
                }
                // A complete answer, so nothing found is information rather than
                // a failed lookup — that is the whole reason this tool exists.
                if (!res.found && !res.skipped.length) {
                    return `nothing in memory contains ${JSON.stringify(args.pattern)}`;
                }
                const spec: MemoryOpSpec = {
                    kind: 'op',
                    op: 'grep',
                    opId,
                    nodes: res.matches.map((m) => ({
                        id: m.node.id,
                        kind: m.node.kind,
                        revision: m.node.revision,
                    })),
                    edges: [],
                    files: 0,
                };
                return withEffects(
                    {
                        found: res.found,
                        truncated: res.truncated || undefined,
                        matches: res.matches.map((m) => ({
                            id: m.node.id,
                            kind: m.node.kind,
                            stale: m.stale || undefined,
                            file: m.node.file && fileName(m.node.file),
                            hits: m.hits.map((h) => ({ in: h.where, line: h.line, text: h.text })),
                            more: m.more || undefined,
                        })),
                        // Named, because a file that was not read means a hit in
                        // it would not have been reported either.
                        unsearched: res.skipped.length ? res.skipped : undefined,
                    },
                    { kind: 'memory_op', spec },
                );
            },
        }),
        // The one way a remembered file reaches the sandbox. Memory is never
        // mounted, so the box only ever holds the workspace and the project's
        // read-only trees, and the files stay with the graph that explains them.
        // Reading memory is enough to copy from it: the write is the workspace's.
        tool<CopyFileArgs, TCtx>({
            name: MEMORY_COPY_FILE_TOOL,
            description:
                'Copies a remembered file into the workspace so a command can open or run it. ' +
                `Give the id of a node that holds a file, from ${MEMORY_SEARCH_TOOL} or ` +
                `${MEMORY_LOAD_TOOL}. The copy is yours to edit; remembering the edited ` +
                `version is a new ${MEMORY_COMMIT_TOOL}.`,
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: 'the node that holds the file' },
                    to: {
                        type: 'string',
                        description:
                            'where in the workspace to put it; the file’s own name ' +
                            '(<id>.<ext>) at the workspace root when omitted',
                    },
                    overwrite: {
                        type: 'boolean',
                        description: 'replace a file already at that path',
                    },
                },
                required: ['id'],
                additionalProperties: false,
            },
            execute: async (args, tc) => {
                if (!tc.services.writeFile) {
                    return {
                        error: 'this agent has no workspace to copy into',
                        hint: `read the file inline with ${MEMORY_LOAD_TOOL} instead`,
                    };
                }
                try {
                    const { file, bytes } = await index.fileOf(args.id, binding.sees);
                    const path = await tc.services.writeFile(
                        args.to?.trim() || fileName(file),
                        bytes,
                        {
                            overwrite: args.overwrite,
                        },
                    );
                    return { id: args.id, path, bytes: bytes.byteLength, copied: true };
                } catch (err) {
                    if (err instanceof MemoryError) {
                        return refusal(err);
                    }
                    // The workspace's refusals — read-only, outside, already there —
                    // are things the model can fix by choosing another `to`.
                    return { error: err instanceof Error ? err.message : String(err) };
                }
            },
        }),
    ];

    if (!canWrite(binding)) {
        return tools;
    }

    const labels = binding.writes;
    const audience =
        labels.length > 1
            ? {
                  audience: {
                      type: 'array',
                      items: { type: 'string', enum: labels },
                      description: 'who may later see this node; defaults to everyone',
                  },
              }
            : {};

    tools.push(
        tool<CommitArgs, TCtx>({
            name: MEMORY_COMMIT_TOOL,
            description:
                'Remember something as a small graph, in one call: the nodes and the links ' +
                'between them. Link a new node to an existing one by using its id. A node ' +
                'that already exists is folded into it, and its id comes back under your ref.',
            parameters: {
                type: 'object',
                properties: {
                    nodes: {
                        type: 'array',
                        minItems: 1,
                        items: {
                            type: 'object',
                            properties: {
                                ref: {
                                    type: 'string',
                                    description:
                                        'a short local name for a new node (e.g. "task_1", "file_1"), used by edges in this call. Use ref (not id) when creating new nodes.',
                                },
                                id: {
                                    type: 'string',
                                    description:
                                        'the permanent id of an existing node to update in place (from search/load). Do not use for new nodes; use ref instead.',
                                },
                                kind: { type: 'string', enum: kinds, description: kindHelp },
                                text: {
                                    type: 'string',
                                    description: 'what to remember, in your own words',
                                },
                                file: {
                                    oneOf: [
                                        {
                                            type: 'string',
                                            description:
                                                'path of an existing file in the workspace to keep a copy of (e.g. "report.py" or "/workspace/report.py"), for kind "file"',
                                        },
                                        {
                                            type: 'object',
                                            properties: {
                                                path: {
                                                    type: 'string',
                                                    description:
                                                        'path of an existing file in the workspace',
                                                },
                                            },
                                            required: ['path'],
                                            additionalProperties: false,
                                            description: 'file object with path',
                                        },
                                    ],
                                    description:
                                        'path of an existing file in the workspace to keep a copy of (e.g. "report.py" or "/workspace/report.py"), for kind "file"',
                                },
                                ...audience,
                                expected_revision: {
                                    type: 'integer',
                                    description: 'refuse the change if the node moved on',
                                },
                            },
                            additionalProperties: false,
                        },
                    },
                    edges: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                from: {
                                    type: 'string',
                                    description: 'a ref from this call, or an existing node id',
                                },
                                to: {
                                    type: 'string',
                                    description: 'a ref from this call, or an existing node id',
                                },
                                relation: {
                                    type: 'string',
                                    enum: relations,
                                    description: relationHelp,
                                },
                            },
                            required: ['from', 'to', 'relation'],
                            additionalProperties: false,
                        },
                    },
                },
                required: ['nodes'],
                additionalProperties: false,
            },
            execute: async (args, tc) => {
                const opId = memoryOpId(tc.state.runId, tc.callId);
                let nodes: CommitNode[];
                try {
                    nodes = args.nodes.map((n) => {
                        let fileSpec: { source: FileSource; path: string } | undefined;
                        if (n.file !== undefined) {
                            const rawPath = extractFilePath(n.file);
                            if (!rawPath.trim()) {
                                throw new MemoryError(
                                    'file path is required',
                                    'pass the path of the file in the workspace to remember, e.g. "report.py"',
                                );
                            }
                            fileSpec = {
                                source: source(tc, rawPath),
                                path: rawPath,
                            };
                        }
                        return {
                            ref: n.ref,
                            id: n.id,
                            kind: n.kind,
                            text: n.text,
                            audience: n.audience,
                            expectedRevision: n.expected_revision,
                            file: fileSpec,
                        };
                    });
                } catch (err) {
                    return refusal(err);
                }
                const edges: CommitEdge[] = (args.edges ?? []).map((e) => ({
                    from: e.from,
                    to: e.to,
                    relation: e.relation,
                }));

                let res;
                try {
                    res = await index.commit(
                        { nodes, edges },
                        { writes: labels, sees: binding.sees, clock: tc.services.clock },
                    );
                } catch (err) {
                    return refusal(err);
                }

                // The TUI shows a truncated preview, so the counts go first.
                const parts = [`${MEMORY_COMMIT_TOOL} ${res.created + res.updated} nodes`];
                if (res.edges) {
                    parts.push(`${res.edges} edges`);
                }
                if (res.files) {
                    parts.push(`${res.files} files`);
                }
                if (res.merged) {
                    parts.push(`${res.merged} already known`);
                }
                const spec: MemoryOpSpec = {
                    kind: 'op',
                    op: 'commit',
                    opId,
                    nodes: changed(index, res.ids),
                    edges: [],
                    files: res.files,
                };
                return withEffects(
                    { summary: parts.join(' '), ids: res.ids },
                    { kind: 'memory_op', spec },
                );
            },
        }),
    );

    if (!canForget(binding)) {
        return tools;
    }

    tools.push(
        tool<ForgetArgs, TCtx>({
            name: MEMORY_FORGET_TOOL,
            description:
                'Delete memories by id, with the files they hold. Use this only for what is ' +
                'wrong or no longer allowed to be kept; to correct something, prefer a new ' +
                `node linked with SUPERSEDES in ${MEMORY_COMMIT_TOOL}.`,
            parameters: {
                type: 'object',
                properties: {
                    ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
                    reason: { type: 'string', description: 'why this is being removed' },
                },
                required: ['ids'],
                additionalProperties: false,
            },
            execute: async (args, tc) => {
                const opId = memoryOpId(tc.state.runId, tc.callId);
                index.refresh();
                const before = args.ids.flatMap((id) => {
                    const node = index.graph.get(id);
                    return node ? [{ id, kind: node.kind, revision: node.revision }] : [];
                });
                // Taken before the delete: afterwards nothing can say what this
                // node hung from, and a report would draw it floating.
                const links = new Map(
                    args.ids
                        .flatMap((id) => index.graph.neighbors(id, binding.sees))
                        .map((e) => [`${e.source}|${e.relation}|${e.target}`, e]),
                );
                try {
                    await index.forget(args.ids, binding.sees);
                } catch (err) {
                    return refusal(err);
                }
                return withEffects(`${MEMORY_FORGET_TOOL} ${before.length} nodes`, {
                    kind: 'memory_op',
                    spec: {
                        kind: 'op',
                        op: 'forget',
                        opId,
                        nodes: before,
                        edges: [...links.values()],
                        files: 0,
                    },
                });
            },
        }),
    );

    return tools;
}

/**
 * A refusal is a result, not a throw: the model can read it and fix the call,
 * whereas an exception ends the turn.
 */
function refusal(err: unknown): { error: string; hint?: string } {
    if (err instanceof MemoryError) {
        return { error: err.message, hint: err.hint };
    }
    if (err instanceof RevisionMismatch) {
        return {
            error: err.message,
            hint: `another run changed it; ${MEMORY_LOAD_TOOL} it again and commit against the new revision`,
        };
    }
    throw err;
}

function extractFilePath(raw: unknown): string {
    if (typeof raw === 'string') {
        return raw;
    }
    if (
        raw &&
        typeof raw === 'object' &&
        'path' in raw &&
        typeof (raw as { path: unknown }).path === 'string'
    ) {
        return (raw as { path: string }).path;
    }
    return '';
}

function source<TCtx>(tc: ToolContext<TCtx>, path: string): FileSource {
    if (!tc.services.resolveFile) {
        throw new MemoryError(
            'this agent cannot remember files',
            'commit the node without `file`, or give the agent a workspace',
        );
    }
    try {
        return tc.services.resolveFile(path);
    } catch (err) {
        if (err instanceof MemoryError) {
            throw err;
        }
        throw new MemoryError(
            err instanceof Error ? err.message : String(err),
            'remember a file the run actually wrote, by the path the file tools use',
        );
    }
}

function changed(
    index: MemoryIndex,
    ids: Record<string, string>,
): { id: string; kind: string; revision: number }[] {
    return Object.values(ids).flatMap((id) => {
        const node = index.graph.get(id);
        return node ? [{ id, kind: node.kind, revision: node.revision }] : [];
    });
}
