// A recorded run, step by step: the trajectory saved with each engine run, flattened (fork branches
// nested under their join) and listed without payloads; one step's payloads are read on request.
//   GET /:tid/runs/:runId/trace               - the steps of this turn (scope=turn) or the session
//   GET /:tid/runs/:runId/trace/:step         - one step in full; the recorded model request, which
//                                                can be the whole conversation, only with ?part=request
// Steps are addressed by their index in the whole session, flattened: node ids are not unique
// across fork branches, and an index from one scope stays valid in the other. Each step also
// carries its `zen inspect` id (n1, n2, ...), which `zen inspect node|ask --dir <run>` take.
//   traceRouter(store)  - the routes, for a ChatStore (sessions.ts)
//   openTrace           - a request's recorded run: its record, run directory, steps and payloads
import {
    assertState,
    FilePayloadStore,
    PayloadResolver,
    type AgentState,
    type Payload,
    type TokenUsage,
    type TrajectoryNode,
} from '@zenera/neo';
import { runPaths } from '@zenera/engine';
import { Router, type Request } from 'express';
import { readFile } from 'node:fs/promises';
import { HttpError } from './http.ts';
import { recordedRun } from './runRecords.ts';
import type { ChatStore } from './store.ts';

export const MAX_PART_CHARS = 256 * 1024;
export const MAX_REQUEST_CHARS = 1024 * 1024;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
const STEP_TYPES = new Set<TrajectoryNode['type']>([
    'user_input',
    'system_prompt',
    'load_skills',
    'memory_recall',
    'memory_op',
    'llm_call',
    'tool_call',
    'tool_result',
    'handoff',
    'fork',
    'join',
    'compaction',
    'final_output',
]);

export interface TraceStep {
    /** position in the whole session, flattened; the address of the step */
    index: number;
    id: string;
    type: TrajectoryNode['type'];
    agent: string;
    ts: string;
    /** 0 on the trunk, one more per fork */
    depth: number;
    /** fork branch path, e.g. `research › web` */
    branch?: string;
    /** the step's id in `zen inspect graph|node|ask` */
    node: string;
    title: string;
    model?: string;
    tools?: string[];
    usage?: TokenUsage;
    stopReason?: string;
    isError?: boolean;
    durationMs?: number;
    synthetic?: boolean;
}

export interface TracePage {
    runId: string;
    engineRunId: string;
    scope: 'turn' | 'session';
    /** false for runs recorded before turn boundaries were kept: only the session can be shown */
    turnAvailable: boolean;
    total: number;
    offset: number;
    limit: number;
    counts: Partial<Record<TrajectoryNode['type'], number>>;
    steps: TraceStep[];
}

export interface TracePart {
    key: string;
    label: string;
    kind: 'text' | 'json';
    text?: string;
    json?: unknown;
    /** recorded size, for a payload */
    bytes?: number;
    truncated?: boolean;
    /** too large to send with the step: fetch it with ?part=<key> */
    deferred?: boolean;
    error?: string;
}

export interface TraceStepDetail {
    step: TraceStep;
    parts: TracePart[];
}

interface Flat {
    node: TrajectoryNode;
    depth: number;
    branch?: string;
    /** index of the trunk node it belongs to */
    top: number;
    /** `zen inspect` id */
    key: string;
}

// `zen inspect` numbers nodes in the order the run appended them: a join's branches ran before
// the join, so their nodes are numbered first (ZeneraNeo packages/cli/src/trace.ts, flatten).
function inspectKeys(trajectory: TrajectoryNode[]): Map<TrajectoryNode, string> {
    const keys = new Map<TrajectoryNode, string>();
    const walk = (nodes: TrajectoryNode[]) => {
        for (const node of nodes) {
            if (node.type === 'join') for (const b of node.branches) walk(b.nodes);
            keys.set(node, `n${keys.size + 1}`);
        }
    };
    walk(trajectory);
    return keys;
}

export function flatten(trajectory: TrajectoryNode[]): Flat[] {
    const keys = inspectKeys(trajectory);
    const out: Flat[] = [];
    const walk = (
        nodes: TrajectoryNode[],
        depth: number,
        branch: string | undefined,
        top?: number,
    ) => {
        nodes.forEach((node, i) => {
            const at = top ?? i;
            out.push({ node, depth, branch, top: at, key: keys.get(node)! });
            if (node.type === 'join') {
                for (const b of node.branches) {
                    walk(b.nodes, depth + 1, branch ? `${branch} › ${b.name}` : b.name, at);
                }
            }
        });
    };
    walk(trajectory, 0, undefined);
    return out;
}

function title(n: TrajectoryNode): string {
    switch (n.type) {
        case 'user_input':
            return n.synthetic ? 'Runtime input' : 'User input';
        case 'system_prompt':
            return 'System prompt';
        case 'load_skills':
            return `Skills · ${n.skills.map((s) => s.name).join(', ')}`;
        case 'memory_recall':
            return `Memory recall · ${n.nodes.length} nodes`;
        case 'memory_op':
            return `Memory ${n.op} · ${n.nodes.length} nodes`;
        case 'llm_call':
            return `LLM call · ${n.model}`;
        case 'tool_call':
            return `Tool call · ${n.name}`;
        case 'tool_result':
            return `Tool result · ${n.name}`;
        case 'handoff':
            return `Handoff · ${n.from} → ${n.to}`;
        case 'fork':
            return `Fork · ${n.branches.map((b) => b.name).join(', ')}`;
        case 'join':
            return `Join · ${n.branches.map((b) => `${b.name} ${b.status}`).join(', ')}`;
        case 'compaction':
            return `Compaction · ${n.covers.length} nodes`;
        case 'final_output':
            return 'Final output';
    }
}

export function toStep(f: Flat, index: number): TraceStep {
    const n = f.node;
    const step: TraceStep = {
        index,
        id: n.id,
        type: n.type,
        agent: n.agent,
        ts: n.ts,
        depth: f.depth,
        ...(f.branch ? { branch: f.branch } : {}),
        node: f.key,
        title: title(n),
    };
    if (n.type === 'llm_call') {
        step.model = n.model;
        step.usage = n.usage;
        step.stopReason = n.stopReason;
        if (n.toolCalls.length) step.tools = n.toolCalls.map((c) => c.name);
    } else if (n.type === 'compaction') {
        step.usage = n.usage;
    } else if (n.type === 'tool_result') {
        step.isError = n.isError;
        if (n.durationMs !== undefined) step.durationMs = n.durationMs;
    } else if (n.type === 'join') {
        step.usage = n.usage;
        step.isError = n.branches.some((b) => b.status !== 'ok');
    } else if (n.type === 'user_input' && n.synthetic) {
        step.synthetic = true;
    }
    return step;
}

async function loadState(statePath: string): Promise<AgentState> {
    try {
        return assertState(JSON.parse(await readFile(statePath, 'utf8')));
    } catch (err) {
        throw new HttpError(
            500,
            `the recorded run state cannot be read: ${(err as Error).message}`,
        );
    }
}

function int(req: Request, key: string, fallback: number, min: number, max: number): number {
    const raw = req.query[key];
    if (raw === undefined) return fallback;
    const n = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(n) || n < min || n > max) {
        throw new HttpError(400, `${key} must be a whole number from ${min} to ${max}`);
    }
    return n;
}

function only(req: Request, allowed: string[]): void {
    for (const [key, value] of Object.entries(req.query)) {
        if (!allowed.includes(key)) throw new HttpError(400, `unsupported query parameter: ${key}`);
        if (typeof value !== 'string') throw new HttpError(400, `${key} must be given once`);
    }
}

export async function openTrace(store: ChatStore, req: Request) {
    const t = store.thread(req);
    const { record, session, statePath } = recordedRun(
        store.runsDir(t),
        store.existingSession(t),
        String(req.params.runId),
    );
    const state = await loadState(statePath);
    const payloads = new PayloadResolver(new FilePayloadStore({ dir: session.blobs, id: 'file' }));
    const runDir = runPaths(session, record.engineRunId!).dir;
    return { thread: t, record, runDir, state, payloads, flat: flatten(state.trajectory) };
}

/** The step a route names by its index, or 404. */
export function stepParam(flat: Flat[], raw: string): { f: Flat; index: number } {
    if (!/^\d{1,7}$/.test(raw)) throw new HttpError(400, 'invalid step');
    const index = Number(raw);
    const f = flat[index];
    if (!f) throw new HttpError(404, 'no such step');
    return { f, index };
}

async function payloadPart(
    payloads: PayloadResolver,
    key: string,
    label: string,
    p: Payload,
    max = MAX_PART_CHARS,
): Promise<TracePart> {
    try {
        const text = await payloads.get(p);
        return {
            key,
            label,
            kind: 'text',
            text: text.length > max ? text.slice(0, max) : text,
            bytes: p.size,
            ...(text.length > max ? { truncated: true } : {}),
        };
    } catch (err) {
        return {
            key,
            label,
            kind: 'text',
            bytes: p.size,
            error: `payload unavailable: ${(err as Error).message}`,
        };
    }
}

const json = (key: string, label: string, value: unknown): TracePart => ({
    key,
    label,
    kind: 'json',
    json: value,
});

export async function stepParts(
    n: TrajectoryNode,
    payloads: PayloadResolver,
): Promise<TracePart[]> {
    const parts: TracePart[] = [];
    const add = async (key: string, label: string, p: Payload | undefined) => {
        if (p) parts.push(await payloadPart(payloads, key, label, p));
    };
    switch (n.type) {
        case 'user_input':
            for (const [i, c] of n.content.entries()) {
                if (c.type === 'text') await add(`content.${i}`, 'Input', c.text);
                else
                    parts.push({
                        key: `content.${i}`,
                        label: `Attached ${c.type}`,
                        kind: 'text',
                        // An inline data: url can be megabytes of base64; name it, do not send it.
                        text: c.url.startsWith('data:')
                            ? `${c.mimeType ?? c.type} (inline data, ${c.url.length} characters)`
                            : c.url,
                    });
            }
            break;
        case 'system_prompt':
            await add('prompt', 'System prompt', n.prompt);
            if (n.sources?.length)
                parts.push(
                    json(
                        'sources',
                        'Prompt sources',
                        n.sources.map((s) => s.path),
                    ),
                );
            break;
        case 'load_skills':
            parts.push(
                json('skills', 'Skills', {
                    provider: n.provider,
                    skills: n.skills,
                    tools: n.toolNames,
                }),
            );
            await add('content', 'Instructions', n.content);
            break;
        case 'memory_recall':
            parts.push(json('query', 'Query', n.query));
            await add('content', 'Recalled block', n.content);
            parts.push(json('nodes', 'Nodes', { seeds: n.seeds, nodes: n.nodes, edges: n.edges }));
            break;
        case 'memory_op':
            parts.push(
                json('op', 'Operation', {
                    op: n.op,
                    nodes: n.nodes,
                    edges: n.edges,
                    files: n.files,
                }),
            );
            break;
        case 'llm_call':
            parts.push(
                json('call', 'Call', { model: n.model, stopReason: n.stopReason, usage: n.usage }),
            );
            await add('thinking', 'Thinking', n.thinking);
            await add('text', 'Response', n.text);
            for (const [i, c] of n.toolCalls.entries()) {
                await add(`toolCalls.${i}`, `Tool call · ${c.name} (${c.callId})`, c.args);
            }
            if (n.request) {
                parts.push({
                    key: 'request',
                    label: 'Recorded request',
                    kind: 'text',
                    bytes: n.request.size,
                    deferred: true,
                });
            }
            break;
        case 'tool_call':
            await add('args', `Arguments · ${n.name} (${n.callId})`, n.args);
            break;
        case 'tool_result':
            parts.push(
                json('result.meta', 'Result', {
                    callId: n.callId,
                    isError: n.isError,
                    durationMs: n.durationMs,
                }),
            );
            await add('result', n.isError ? 'Error output' : 'Output', n.result);
            break;
        case 'handoff':
            parts.push(json('handoff', 'Handoff', { from: n.from, to: n.to, reason: n.reason }));
            break;
        case 'fork':
            parts.push(json('fork', 'Fork', { callId: n.callId, contextMode: n.contextMode }));
            for (const [i, b] of n.branches.entries()) {
                await add(`branches.${i}`, `Instructions · ${b.name} (${b.agent})`, b.instructions);
            }
            break;
        case 'join':
            for (const [i, b] of n.branches.entries()) {
                parts.push(
                    json(`branches.${i}.meta`, `Branch · ${b.name}`, {
                        agent: b.agent,
                        status: b.status,
                        error: b.error,
                        usage: b.usage,
                        steps: b.nodes.length,
                    }),
                );
                await add(`branches.${i}`, `Output · ${b.name}`, b.output);
            }
            break;
        case 'compaction':
            parts.push(
                json('compaction', 'Compaction', {
                    reason: n.reason,
                    covers: n.covers.length,
                    usage: n.usage,
                }),
            );
            await add('summary', 'Summary', n.summary);
            break;
        case 'final_output':
            await add('output', 'Output', n.output);
            if (n.parsed !== undefined) parts.push(json('parsed', 'Parsed output', n.parsed));
            break;
    }
    return parts;
}

export function traceRouter(store: ChatStore): Router {
    const router = Router();

    router.get('/:tid/runs/:runId/trace', async (req, res) => {
        only(req, ['scope', 'offset', 'limit', 'types']);
        const scopeParam = req.query.scope ?? 'turn';
        if (scopeParam !== 'turn' && scopeParam !== 'session') {
            throw new HttpError(400, 'scope must be turn or session');
        }
        const types =
            typeof req.query.types === 'string' && req.query.types
                ? req.query.types.split(',')
                : [];
        for (const t of types) {
            if (!STEP_TYPES.has(t as TrajectoryNode['type']))
                throw new HttpError(400, `unknown step type: ${t}`);
        }
        const offset = int(req, 'offset', 0, 0, 1_000_000);
        const limit = int(req, 'limit', DEFAULT_LIMIT, 1, MAX_LIMIT);
        const { record, flat } = await openTrace(store, req);
        const start = record.trajectoryStart;
        const turnAvailable = start !== undefined;
        const scope = turnAvailable ? scopeParam : 'session';
        const inScope = flat
            .map((f, index) => ({ f, index }))
            .filter(({ f }) => scope === 'session' || f.top >= start!);
        const counts: TracePage['counts'] = {};
        for (const { f } of inScope) counts[f.node.type] = (counts[f.node.type] ?? 0) + 1;
        const shown = types.length
            ? inScope.filter(({ f }) => types.includes(f.node.type))
            : inScope;
        const page: TracePage = {
            runId: record.runId,
            engineRunId: record.engineRunId!,
            scope,
            turnAvailable,
            total: shown.length,
            offset,
            limit,
            counts,
            steps: shown.slice(offset, offset + limit).map(({ f, index }) => toStep(f, index)),
        };
        res.setHeader('Cache-Control', 'no-store');
        res.json(page);
    });

    router.get('/:tid/runs/:runId/trace/:step', async (req, res) => {
        only(req, ['part']);
        const { flat, payloads } = await openTrace(store, req);
        const { f, index } = stepParam(flat, String(req.params.step));
        res.setHeader('Cache-Control', 'no-store');
        if (req.query.part !== undefined) {
            if (req.query.part !== 'request')
                throw new HttpError(400, 'only the request part is fetched separately');
            if (f.node.type !== 'llm_call' || !f.node.request) {
                throw new HttpError(404, 'this step has no recorded request');
            }
            res.json({
                part: await payloadPart(
                    payloads,
                    'request',
                    'Recorded request',
                    f.node.request,
                    MAX_REQUEST_CHARS,
                ),
            });
            return;
        }
        const detail: TraceStepDetail = {
            step: toStep(f, index),
            parts: await stepParts(f.node, payloads),
        };
        res.json(detail);
    });
    return router;
}
