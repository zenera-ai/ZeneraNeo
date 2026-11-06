// Read-only inspection of a chat's memory graph. Every operation is rooted at the
// ChatStore's memoryDir for the thread (sessions.ts); no route accepts or derives a
// filesystem path from input.
//   memoryRouter(store)  - the routes
import { KeyStore } from '@zenera/engine';
import {
    isMemory,
    MemoryError,
    MemoryIndex,
    MemoryStore,
    buildMemoryReport,
    buildMemorySlice,
    grepMemory,
    projectRegistry,
    readProjectConfig,
    renderMemoryHtml,
    renderRecollection,
    type Embedder,
    type EmbeddingRef,
    type GrepField,
    type MemoryEdge,
    type MemoryGrepResult,
    type MemoryNode,
    type MemoryQuery,
    type NodeVia,
    type ProjectConfig,
    type Recollection,
    type ReportNode,
} from '@zenera/neo';
import { Router, type Request } from 'express';
import { settings } from './config.ts';
import { HttpError } from './http.ts';
import { applyProjectEnv } from './projectEnv.ts';
import { asHttpError, errorMessage, usesMemory, type ChatStore } from './store.ts';

export type MemoryStatus = 'disabled' | 'not-created' | 'ready';

export interface MemoryStats {
    nodes: number;
    edges: number;
    superseded: number;
    files: number;
    embedding?: { model: string; dimensions: number };
    vectors?: { rows: number; dims: number; bytes: number };
}

export interface MemoryOverview {
    status: MemoryStatus;
    stats: MemoryStats;
    kinds: string[];
    audiences: string[];
}

export interface MemoryNodesPage {
    status: MemoryStatus;
    nodes: ReportNode[];
    found: number;
    offset: number;
    limit: number;
    truncated: boolean;
    kinds: string[];
    audiences: string[];
}

export interface MemoryNodeDetails {
    status: 'ready';
    node: ReportNode;
    edges: MemoryEdge[];
}

export interface MemoryGrepResponse extends MemoryGrepResult {
    status: MemoryStatus;
}

export interface MemoryRecallNode {
    node: MemoryNode;
    score: number;
    seed: boolean;
    via?: NodeVia;
    stale: boolean;
}

export interface MemoryRecallResponse {
    status: MemoryStatus;
    ranking: { by: 'meaning' | 'term overlap'; model?: string; reason?: string };
    sees: string[];
    query: {
        text: string;
        kind?: string;
        limit: number;
        hops: number;
        nodes: number;
        minScore?: number;
    };
    seeds: string[];
    truncated: boolean;
    nodes: MemoryRecallNode[];
    edges: MemoryEdge[];
    block: string;
}

export interface MemoryReportResponse {
    html: string;
}

const EMPTY_STATS: MemoryStats = { nodes: 0, edges: 0, superseded: 0, files: 0 };
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 30;
const MAX_OFFSET = 10_000;
const MAX_KIND_LENGTH = 64;
const MAX_QUERY_LENGTH = 200;
const MAX_RECALL_QUERY_LENGTH = 500;
const MAX_AUDIENCE_LENGTH = 64;
const GREP_FIELDS = new Set<GrepField>(['text', 'metadata', 'file']);

type OpenMemory = { status: 'ready'; store: MemoryStore } | { status: 'disabled' | 'not-created' };

function translateMemoryError(err: unknown): never {
    if (err instanceof HttpError) throw err;
    if (err instanceof MemoryError) throw new HttpError(422, err.message);
    const mapped = asHttpError(err);
    if (mapped !== err) throw mapped;
    throw new HttpError(500, `could not read memory: ${errorMessage(err)}`);
}

async function openMemory(dir: string | undefined): Promise<OpenMemory> {
    let enabled: boolean;
    try {
        enabled = usesMemory();
    } catch (err) {
        translateMemoryError(err);
    }
    if (!enabled || !dir) return { status: 'disabled' };

    if (!isMemory(dir)) return { status: 'not-created' };
    try {
        return {
            status: 'ready',
            store: await MemoryStore.open(dir, { readOnly: true }),
        };
    } catch (err) {
        translateMemoryError(err);
    }
}

function one(req: Request, key: string): string | undefined {
    const value = req.query[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'string') throw new HttpError(400, `${key} must be specified once`);
    return value;
}

function assertQueryKeys(req: Request, allowed: readonly string[]): void {
    const accepted = new Set(allowed);
    for (const key of Object.keys(req.query)) {
        if (!accepted.has(key)) throw new HttpError(400, `unsupported query parameter: ${key}`);
    }
}

function booleanParam(req: Request, key: string, fallback = false): boolean {
    const value = one(req, key);
    if (value === undefined) return fallback;
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new HttpError(400, `${key} must be true or false`);
}

function integerParam(
    req: Request,
    key: string,
    fallback: number,
    minimum: number,
    maximum: number,
): number {
    const value = one(req, key);
    if (value === undefined) return fallback;
    if (!/^(0|[1-9]\d*)$/.test(value)) throw new HttpError(400, `${key} must be an integer`);
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
        throw new HttpError(400, `${key} must be between ${minimum} and ${maximum}`);
    }
    return parsed;
}

function listParam(req: Request, key: string): string[] | undefined {
    const value = one(req, key);
    if (value === undefined) return undefined;
    if (value.length > 256) throw new HttpError(400, `${key} must be 256 characters or fewer`);
    const values = value.split(',');
    if (
        values.length > 20 ||
        values.some((part) => !part || part.length > MAX_KIND_LENGTH) ||
        new Set(values).size !== values.length
    ) {
        throw new HttpError(400, `${key} contains an invalid or repeated value`);
    }
    return values;
}

function checkKind(kind: string): string {
    if (!kind || kind.length > MAX_KIND_LENGTH) {
        throw new HttpError(400, `kind must be 1-${MAX_KIND_LENGTH} characters`);
    }
    return kind;
}

function emptyPage(status: MemoryStatus, offset: number, limit: number): MemoryNodesPage {
    return {
        status,
        nodes: [],
        found: 0,
        offset,
        limit,
        truncated: false,
        kinds: [],
        audiences: [],
    };
}

function emptyGrep(status: MemoryStatus): MemoryGrepResponse {
    return { status, found: 0, matches: [], truncated: false, skipped: [] };
}

function overviewFromReport(report: Awaited<ReturnType<typeof buildMemoryReport>>): MemoryOverview {
    return {
        status: 'ready',
        stats: {
            nodes: report.nodes.length,
            edges: report.edges.length,
            superseded: report.nodes.filter((node) => node.stale).length,
            files: report.nodes.filter((node) => node.file !== undefined).length,
            ...(report.embedding ? { embedding: report.embedding } : {}),
            ...(report.vectors ? { vectors: report.vectors } : {}),
        },
        kinds: report.kinds,
        audiences: report.audiences,
    };
}

type Ranking = MemoryRecallResponse['ranking'];
type EmbedderChoice = { embedder: Embedder } | { reason: string };
type EmbedderFactory = (config: ProjectConfig) => Embedder | undefined;

const recalling = new Set<string>();
let embedderOverride: EmbedderFactory | undefined;

/** Test-only seam: replaces credential and model resolution for recall. */
export function setRecallEmbedderFactory(factory: EmbedderFactory | undefined): void {
    embedderOverride = factory;
}

function numberParam(
    req: Request,
    key: string,
    minimum: number,
    maximum: number,
): number | undefined {
    const value = one(req, key);
    if (value === undefined) return undefined;
    if (!/^(\d+(\.\d+)?|\.\d+)$/.test(value)) throw new HttpError(400, `${key} must be a number`);
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
        throw new HttpError(400, `${key} must be between ${minimum} and ${maximum}`);
    }
    return parsed;
}

function projectConfig(): ProjectConfig {
    try {
        return readProjectConfig(settings().projectDir).config;
    } catch (err) {
        throw new HttpError(422, errorMessage(err));
    }
}

// Mirrors how a run resolves its memory embedder (openEngine + load.ts): the
// project's env file, then the keyring, then memory.embedding ?? embedding through
// the project's model registry.
async function chooseEmbedder(store: MemoryStore, config: ProjectConfig): Promise<EmbedderChoice> {
    if (!store.embedding) return { reason: 'this memory holds no vectors' };
    try {
        if (embedderOverride) {
            const embedder = embedderOverride(config);
            return embedder ? { embedder } : { reason: 'the project declares no embedding model' };
        }
        applyProjectEnv();
        (await KeyStore.open()).materialize();
        const ref = config.memory?.embedding ?? config.embedding;
        if (!ref) return { reason: 'the project declares no embedding model' };
        const resolved = config.embeddings?.[ref] ?? ref;
        // The config keeps OpenRouter's quantizations as plain strings; the registry
        // checks them, as neo's own loader does.
        return { embedder: projectRegistry(config).embedder(resolved as EmbeddingRef) };
    } catch (err) {
        return { reason: `the embedding model could not be built: ${errorMessage(err)}` };
    }
}

function emptyRecall(
    status: MemoryStatus,
    query: MemoryRecallResponse['query'],
): MemoryRecallResponse {
    return {
        status,
        ranking: { by: 'term overlap' },
        sees: [],
        query,
        seeds: [],
        truncated: false,
        nodes: [],
        edges: [],
        block: '',
    };
}

export function memoryRouter(chats: ChatStore): Router {
    const memoryRouter = Router();

    memoryRouter.get('/:tid/memory', async (req, res) => {
        const t = chats.thread(req);
        assertQueryKeys(req, []);
        const opened = await openMemory(chats.memoryDir(t));
        if (opened.status !== 'ready') {
            res.json({
                status: opened.status,
                stats: EMPTY_STATS,
                kinds: [],
                audiences: [],
            } satisfies MemoryOverview);
            return;
        }
        try {
            res.json(
                overviewFromReport(await buildMemoryReport(opened.store, { maxContentBytes: 0 })),
            );
        } catch (err) {
            translateMemoryError(err);
        }
    });

    memoryRouter.get('/:tid/memory/nodes', async (req, res) => {
        const t = chats.thread(req);
        assertQueryKeys(req, ['offset', 'limit', 'kind', 'includeSuperseded', 'all']);
        const offset = integerParam(req, 'offset', 0, 0, MAX_OFFSET);
        const limit = integerParam(req, 'limit', DEFAULT_LIMIT, 1, MAX_LIMIT);
        const all = booleanParam(req, 'all');
        const includeSuperseded = booleanParam(req, 'includeSuperseded') || all;
        const kind = one(req, 'kind');
        if (kind !== undefined) checkKind(kind);

        const opened = await openMemory(chats.memoryDir(t));
        if (opened.status !== 'ready') {
            res.json(emptyPage(opened.status, offset, limit));
            return;
        }

        try {
            const graphNodes = opened.store.graph.nodes();
            if (kind && !graphNodes.some((node) => node.kind === kind)) {
                throw new HttpError(400, `unknown memory kind: ${kind}`);
            }
            const stale = opened.store.graph.superseded();
            const matching = graphNodes
                .filter(
                    (node) =>
                        (!kind || node.kind === kind) && (includeSuperseded || !stale.has(node.id)),
                )
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
            const pageIds = matching.slice(offset, offset + limit).map((node) => node.id);
            const slice = await buildMemorySlice(opened.store, pageIds);
            const byId = new Map(slice.nodes.map((node) => [node.id, node]));
            const kinds = [...new Set(graphNodes.map((node) => node.kind))].sort();
            const audiences = [...new Set(graphNodes.flatMap((node) => node.audience))].sort();
            res.json({
                status: 'ready',
                nodes: pageIds.flatMap((nodeId) => {
                    const node = byId.get(nodeId);
                    return node ? [node] : [];
                }),
                found: matching.length,
                offset,
                limit,
                truncated: offset + limit < matching.length,
                kinds,
                audiences,
            } satisfies MemoryNodesPage);
        } catch (err) {
            translateMemoryError(err);
        }
    });

    memoryRouter.get('/:tid/memory/nodes/:nodeId', async (req, res) => {
        const t = chats.thread(req);
        assertQueryKeys(req, []);
        const nodeId = req.params.nodeId;
        if (!nodeId || nodeId.length > 200)
            throw new HttpError(400, 'nodeId must be 1-200 characters');
        const opened = await openMemory(chats.memoryDir(t));
        if (opened.status !== 'ready') {
            throw new HttpError(
                404,
                opened.status === 'disabled' ? 'memory is disabled' : 'memory not created',
            );
        }
        try {
            if (!opened.store.graph.has(nodeId)) throw new HttpError(404, 'memory node not found');
            const slice = await buildMemorySlice(opened.store, [nodeId]);
            const node = slice.nodes[0];
            if (!node) throw new HttpError(404, 'memory node not found');
            res.json({
                status: 'ready',
                node,
                edges: opened.store.graph.neighbors(nodeId),
            } satisfies MemoryNodeDetails);
        } catch (err) {
            translateMemoryError(err);
        }
    });

    memoryRouter.get('/:tid/memory/grep', async (req, res) => {
        const t = chats.thread(req);
        if (one(req, 'regex') !== undefined) {
            throw new HttpError(400, 'regex searches are not supported');
        }
        assertQueryKeys(req, ['query', 'in', 'kind', 'caseSensitive', 'all', 'limit']);
        const query = one(req, 'query') ?? '';
        if (!query.trim() || query.length > MAX_QUERY_LENGTH) {
            throw new HttpError(400, `query must be 1-${MAX_QUERY_LENGTH} characters`);
        }
        const fields = listParam(req, 'in');
        if (fields?.some((field) => !GREP_FIELDS.has(field as GrepField))) {
            throw new HttpError(400, 'in must contain only text, metadata, or file');
        }
        const kinds = listParam(req, 'kind')?.map(checkKind);
        const caseSensitive = booleanParam(req, 'caseSensitive');
        const all = booleanParam(req, 'all');
        const limit = integerParam(req, 'limit', DEFAULT_LIMIT, 1, MAX_LIMIT);

        const opened = await openMemory(chats.memoryDir(t));
        if (opened.status !== 'ready') {
            res.json(emptyGrep(opened.status));
            return;
        }
        try {
            const kindsInMemory = new Set(opened.store.graph.nodes().map((node) => node.kind));
            const unknownKind = kinds?.find((kind) => !kindsInMemory.has(kind));
            if (unknownKind) throw new HttpError(400, `unknown memory kind: ${unknownKind}`);
            const result = await grepMemory(opened.store, query, {
                in: fields as GrepField[] | undefined,
                kinds,
                caseSensitive,
                stale: all ? 'include' : 'exclude',
                limit,
            });
            res.json({ status: 'ready', ...result } satisfies MemoryGrepResponse);
        } catch (err) {
            translateMemoryError(err);
        }
    });

    memoryRouter.get('/:tid/memory/report', async (req, res) => {
        const t = chats.thread(req);
        assertQueryKeys(req, []);
        const opened = await openMemory(chats.memoryDir(t));
        if (opened.status !== 'ready') {
            throw new HttpError(
                404,
                opened.status === 'disabled' ? 'memory is disabled' : 'memory not created',
            );
        }
        try {
            const report = await buildMemoryReport(opened.store);
            // The library includes the host directory in its report; it has no place
            // in HTML delivered to a caller.
            const html = renderMemoryHtml({ ...report, dir: 'user memory' });
            res.json({ html } satisfies MemoryReportResponse);
        } catch (err) {
            translateMemoryError(err);
        }
    });

    memoryRouter.get('/:tid/memory/recall', async (req, res) => {
        const t = chats.thread(req);
        assertQueryKeys(req, [
            'query',
            'kind',
            'audience',
            'limit',
            'hops',
            'nodes',
            'minScore',
            'all',
        ]);
        const text = (one(req, 'query') ?? '').trim();
        if (!text || text.length > MAX_RECALL_QUERY_LENGTH) {
            throw new HttpError(400, `query must be 1-${MAX_RECALL_QUERY_LENGTH} characters`);
        }
        const kind = one(req, 'kind');
        if (kind !== undefined) checkKind(kind);
        const audience = one(req, 'audience');
        if (audience !== undefined && (!audience || audience.length > MAX_AUDIENCE_LENGTH)) {
            throw new HttpError(400, `audience must be 1-${MAX_AUDIENCE_LENGTH} characters`);
        }
        const limit = integerParam(req, 'limit', 10, 1, 25);
        const hops = integerParam(req, 'hops', 2, 0, 4);
        const maxNodes = integerParam(req, 'nodes', 25, 1, 50);
        const minScore = numberParam(req, 'minScore', 0, 1);
        const all = booleanParam(req, 'all');
        const echo: MemoryRecallResponse['query'] = {
            text,
            ...(kind !== undefined ? { kind } : {}),
            limit,
            hops,
            nodes: maxNodes,
            ...(minScore !== undefined ? { minScore } : {}),
        };
        res.setHeader('Cache-Control', 'no-store');

        if (recalling.has(t.owner)) throw new HttpError(409, 'a recall is already running');
        recalling.add(t.owner);
        try {
            const opened = await openMemory(chats.memoryDir(t));
            if (opened.status !== 'ready') {
                res.json(emptyRecall(opened.status, echo));
                return;
            }
            const { store } = opened;
            const graphNodes = store.graph.nodes();
            if (kind && !graphNodes.some((node) => node.kind === kind)) {
                throw new HttpError(400, `unknown memory kind: ${kind}`);
            }
            const sees =
                audience === undefined
                    ? [...new Set([...graphNodes.flatMap((node) => node.audience), '*'])].sort()
                    : [...new Set([audience, '*'])];
            const config = projectConfig();
            const choice = await chooseEmbedder(store, config);
            const embedder = 'embedder' in choice ? choice.embedder : undefined;
            const ranking: Ranking = embedder
                ? { by: 'meaning', model: embedder.id }
                : { by: 'term overlap', reason: (choice as { reason: string }).reason };
            const index = new MemoryIndex({
                store,
                embedder,
                kinds: config.memory?.kinds,
                relations: config.memory?.relations,
            });
            const memoryQuery: MemoryQuery = {
                text,
                ...(kind !== undefined ? { kinds: [kind] } : {}),
                limit,
                maxHops: hops,
                maxNodes,
                ...(minScore !== undefined ? { minScore } : {}),
            };
            let rec: Recollection;
            try {
                rec = await index.search(memoryQuery, sees, { stale: all });
            } catch (err) {
                if (embedder && !(err instanceof MemoryError) && !(err instanceof HttpError)) {
                    throw new HttpError(502, `embedding the query failed: ${errorMessage(err)}`);
                }
                throw err;
            }
            const stale = store.graph.superseded(sees);
            res.json({
                status: 'ready',
                ranking,
                sees,
                query: echo,
                seeds: rec.seeds,
                truncated: rec.truncated,
                nodes: rec.nodes.map((scored) => ({
                    node: scored.node,
                    score: scored.score,
                    seed: scored.seed,
                    ...(scored.via ? { via: scored.via } : {}),
                    stale: stale.has(scored.node.id),
                })),
                edges: rec.edges,
                block: renderRecollection(rec, { tagged: false }),
            } satisfies MemoryRecallResponse);
        } catch (err) {
            translateMemoryError(err);
        } finally {
            recalling.delete(t.owner);
        }
    });
    return memoryRouter;
}
