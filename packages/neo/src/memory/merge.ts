import { createHash } from 'node:crypto';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { hostPath } from './files.ts';
import { DUPLICATE_SCORE, flatten } from './index.ts';
import { MEMORY_DB, MemoryStore, isMemory, type MemoryEmbedding } from './store.ts';
import { comparable, sameContent, twinKey } from './twin.ts';
import { MemoryError, type MemoryNode } from './types.ts';

// ---------------------------------------------------------------------------
// Folding several memories into one
//
// Warming a memory is embarrassingly parallel — N runs, N questions, N answers
// — and a batch gives each run its own copy so that none of them sees what the
// others are learning mid-round. This puts the results back together.
//
// Ids are ULIDs and are preserved, which makes the interesting case the one
// where the same id appears twice: the runs started from a copy of the same
// memory, so most of what they hold is a shared ancestor rather than a
// collision. That case reconciles to nothing more than counters, and the
// counters take the MAX rather than the sum, because merging the same source
// twice has to be a no-op. Anything that is not a shared ancestor is a real
// divergence and refuses the whole merge; `force` is the escape hatch, not the
// default, because picking a winner silently loses a memory.
//
// Nothing here embeds. A merge is offline and fast, and the price of that is
// that every side must already agree on the embedder.
// ---------------------------------------------------------------------------

/** How much of a diverged memory's text a conflict report carries. */
const CLIP = 80;

export interface MergeOptions {
    /** fold near-identical memories onto the one already there; on by default */
    dedupe?: boolean;
    /** resolve divergence by taking the highest revision instead of refusing */
    force?: boolean;
    /** plan and report, write nothing */
    dryRun?: boolean;
}

export interface MergeSource {
    dir: string;
    /** what the source holds */
    nodes: number;
    edges: number;
    /** what it contributed */
    added: number;
    /** ids the target already had, reconciled rather than duplicated */
    shared: number;
    /** new ids that turned out to be a memory the target already held */
    twins: number;
    files: number;
}

export interface MergeConflict {
    id: string;
    /** the source that disagreed */
    dir: string;
    /** revision already in the merge, and the one the source brought */
    mine: number;
    theirs: number;
    text: string;
}

export interface MergeReport {
    /** the memory everything was folded into */
    dir: string;
    sources: MergeSource[];
    added: number;
    shared: number;
    twins: number;
    /** edges the merge added, after re-pointing folded ends */
    edges: number;
    files: number;
    embedding?: MemoryEmbedding;
    dryRun: boolean;
}

/**
 * Refusal carrying what to look at. Thrown before anything is written, so a
 * conflicted merge leaves the target exactly as it was.
 */
export class MergeConflicts extends MemoryError {
    readonly conflicts: readonly MergeConflict[];

    constructor(conflicts: readonly MergeConflict[]) {
        super(
            `${conflicts.length} ${conflicts.length === 1 ? 'memory' : 'memories'} changed in more than one place`,
            'compare them with `zen memory show <id>`, or take the newest with --force',
        );
        this.name = 'MergeConflicts';
        this.conflicts = conflicts;
    }
}

/**
 * Fold `sources` into `target`, left to right.
 *
 * Order is visible: a memory folded onto a twin keeps the id of whichever copy
 * arrived first, so `merge a b` and `merge b a` can differ in which id
 * survives. They never differ in what is remembered.
 *
 * On `dryRun` the target is left with the merge applied in memory and nothing
 * on disk. Report the result and discard the store; do not commit it.
 */
export async function mergeMemories(
    target: MemoryStore,
    sources: readonly string[],
    opts: MergeOptions = {},
): Promise<MergeReport> {
    const opened = await openSources(target, sources);
    try {
        return await fold(target, opened, opts);
    } finally {
        for (const src of opened) {
            src.release();
        }
    }
}

async function fold(
    target: MemoryStore,
    opened: readonly MemoryStore[],
    opts: MergeOptions,
): Promise<MergeReport> {
    const dedupe = opts.dedupe !== false;
    const reports = new Map<MemoryStore, MergeSource>(
        opened.map((src) => [
            src,
            {
                dir: src.dir,
                nodes: src.graph.order,
                edges: src.graph.size,
                added: 0,
                shared: 0,
                twins: 0,
                files: 0,
            },
        ]),
    );

    const embedding = agree(target, opened);
    if (embedding) {
        target.adopt(embedding);
    }

    // --- plan: everything refusable is refused here, before a single write ---

    const plan = new Map<string, Planned>();
    for (const node of target.graph.nodes()) {
        plan.set(node.id, { node, fresh: false });
    }

    const conflicts: MergeConflict[] = [];
    for (const src of opened) {
        const report = reports.get(src)!;
        for (const node of src.graph.nodes()) {
            const held = plan.get(node.id);
            if (!held) {
                plan.set(node.id, { node, from: src, fresh: true });
                continue;
            }
            if (held.node.revision === node.revision && sameContent(held.node, node)) {
                plan.set(node.id, { ...held, node: reconcile(held.node, node) });
                report.shared++;
                continue;
            }
            if (!opts.force) {
                conflicts.push({
                    id: node.id,
                    dir: src.dir,
                    mine: held.node.revision,
                    theirs: node.revision,
                    text: clip(node.text),
                });
                continue;
            }
            report.shared++;
            plan.set(
                node.id,
                newer(node, held.node)
                    ? { node: reconcile(node, held.node), from: src, fresh: held.fresh }
                    : { ...held, node: reconcile(held.node, node) },
            );
        }
    }
    if (conflicts.length) {
        throw new MergeConflicts(conflicts);
    }
    await checkFiles(plan);

    // --- fold, in memory ---

    const before = target.graph.size;
    const moved = new Map<string, string>();
    for (const planned of plan.values()) {
        if (planned.fresh) {
            continue;
        }
        target.graph.adopt(planned.node);
        if (planned.from) {
            carryVector(planned.from, target, planned.node.id);
        }
    }

    const lexical = new Map<string, string>();
    for (const node of target.graph.nodes()) {
        lexical.set(twinKey(node), node.id);
    }

    for (const src of opened) {
        const report = reports.get(src)!;
        const stale = target.graph.superseded();
        for (const node of src.graph.nodes()) {
            const planned = plan.get(node.id)!;
            if (!planned.fresh || planned.from !== src || moved.has(node.id)) {
                continue;
            }
            const twin = dedupe ? twinOf(target, src, planned.node, lexical, stale) : undefined;
            if (twin) {
                moved.set(node.id, twin);
                report.twins++;
                continue;
            }
            target.graph.adopt(planned.node);
            carryVector(src, target, node.id);
            lexical.set(twinKey(planned.node), node.id);
            moved.set(node.id, node.id);
            report.added++;
        }
        for (const link of src.graph.links()) {
            const from = moved.get(link.source) ?? link.source;
            const to = moved.get(link.target) ?? link.target;
            // A self-edge is what a fold leaves behind when both ends collapsed
            // onto the same memory; it says nothing and is dropped.
            if (from === to || !target.graph.has(from) || !target.graph.has(to)) {
                continue;
            }
            target.graph.adoptEdge(from, to, link.attrs);
        }
    }

    const report: MergeReport = {
        dir: target.dir,
        sources: opened.map((src) => reports.get(src)!),
        added: 0,
        shared: 0,
        twins: 0,
        edges: target.graph.size - before,
        files: 0,
        ...(target.embedding ? { embedding: target.embedding } : {}),
        dryRun: opts.dryRun === true,
    };
    if (opts.dryRun) {
        for (const [id, planned] of plan) {
            if (copies(id, planned, moved)) {
                reports.get(planned.from!)!.files++;
            }
        }
        return total(report);
    }

    await copyFiles(target, plan, moved, reports);
    await target.commit();
    return total(report);
}

interface Planned {
    /** the attributes that win, counters already reconciled */
    node: MemoryNode;
    /** whose copy won; absent when the target's own node stands */
    from?: MemoryStore;
    /** the id was new to this merge, so it may still fold onto a twin */
    fresh: boolean;
}

async function openSources(
    target: MemoryStore,
    sources: readonly string[],
): Promise<MemoryStore[]> {
    if (!sources.length) {
        throw new MemoryError('no memories to merge', 'name at least one memory directory');
    }
    const here = resolve(target.dir);
    const seen = new Set<string>();
    for (const dir of sources) {
        const path = resolve(dir);
        if (path === here) {
            throw new MemoryError(
                `${dir} is the memory being merged into`,
                'name only the memories to fold in',
            );
        }
        if (seen.has(path)) {
            throw new MemoryError(`${dir} was named twice`, 'name each memory once');
        }
        seen.add(path);
        if (!isMemory(path)) {
            throw new MemoryError(`${dir} is not a memory`, `no ${MEMORY_DB} in it`);
        }
    }
    const out: MemoryStore[] = [];
    try {
        for (const path of seen) {
            // Read-only: a run may still be writing a source, and a snapshot of it is enough.
            out.push(await MemoryStore.open(path, { readOnly: true }));
        }
    } catch (err) {
        for (const src of out) {
            src.release();
        }
        throw err;
    }
    return out;
}

/**
 * The one embedder everything must already share. Sources that hold nothing are
 * not asked: a warmup run that found nothing worth keeping never adopted one.
 */
function agree(target: MemoryStore, sources: readonly MemoryStore[]): MemoryEmbedding | undefined {
    const holding = sources.filter((src) => src.graph.order > 0);
    const chosen = target.embedding ?? holding.find((src) => src.embedding)?.embedding;
    for (const src of holding) {
        const theirs = src.embedding;
        if (chosen && theirs) {
            if (theirs.model !== chosen.model || theirs.dimensions !== chosen.dimensions) {
                throw new MemoryError(
                    `${src.dir} was embedded with ${theirs.model} (${theirs.dimensions}d), ` +
                        `but this merge is ${chosen.model} (${chosen.dimensions}d)`,
                    'merge memories warmed with the same embedder',
                );
            }
        } else if (chosen) {
            throw new MemoryError(
                `${src.dir} has no embedder, but this merge is ${chosen.model} (${chosen.dimensions}d)`,
                'its memories would be invisible to search; re-warm it with that embedder',
            );
        }
    }
    return chosen;
}

/**
 * The existing twin rule, applied across memories: same kind, same audience, no
 * file, not superseded, and either near-identical by cosine or identical once
 * whitespace and case stop counting.
 */
function twinOf(
    target: MemoryStore,
    src: MemoryStore,
    node: MemoryNode,
    lexical: ReadonlyMap<string, string>,
    stale: ReadonlySet<string>,
): string | undefined {
    if (node.file) {
        return undefined;
    }
    const vector = src.vectors?.get(node.id);
    const block = target.vectors;
    if (vector && block && block.dims === vector.length && block.rows) {
        const allow = (id: string): boolean => {
            const other = target.graph.get(id);
            return !stale.has(id) && !!other && comparable(other, node);
        };
        const hit = block.topK(vector, 1, allow)[0];
        return hit && hit.score >= DUPLICATE_SCORE ? hit.id : undefined;
    }
    const id = lexical.get(twinKey(node));
    return id && !stale.has(id) ? id : undefined;
}

function carryVector(from: MemoryStore, to: MemoryStore, id: string): void {
    const vector = from.vectors?.get(id);
    const block = to.vectors;
    if (vector && block && block.dims === vector.length) {
        block.set(id, vector);
    }
}

/**
 * Use is not change: `touch` moves these and deliberately leaves `revision`
 * alone, which is what lets two runs of the same memory reconcile instead of
 * colliding. MAX and not sum, so merging a source twice changes nothing.
 */
function reconcile(keep: MemoryNode, other: MemoryNode): MemoryNode {
    return {
        ...keep,
        // ISO-8601 in UTC is fixed width, so string order is time order.
        createdAt: keep.createdAt <= other.createdAt ? keep.createdAt : other.createdAt,
        lastUsedAt: keep.lastUsedAt >= other.lastUsedAt ? keep.lastUsedAt : other.lastUsedAt,
        useCount: Math.max(keep.useCount, other.useCount),
    };
}

function newer(a: MemoryNode, b: MemoryNode): boolean {
    return a.revision === b.revision ? a.updatedAt > b.updatedAt : a.revision > b.revision;
}

/** Stat every file the merge would copy before it copies any of them. */
async function checkFiles(plan: ReadonlyMap<string, Planned>): Promise<void> {
    for (const planned of plan.values()) {
        const file = planned.node.file;
        if (!planned.from || !file) {
            continue;
        }
        const source = hostPath(planned.from.dir, file);
        const info = await stat(source).catch(() => undefined);
        if (!info?.isFile()) {
            throw new MemoryError(
                `${file.path} is missing from ${planned.from.dir}`,
                'that memory is incomplete; re-run it, or forget the node that names the file',
            );
        }
    }
}

/**
 * Bytes last, and all or nothing: the digest is checked against the one the
 * node records, and anything written before a failure is taken back, so a
 * refused merge cannot leave files no graph mentions.
 */
async function copyFiles(
    target: MemoryStore,
    plan: ReadonlyMap<string, Planned>,
    moved: ReadonlyMap<string, string>,
    reports: Map<MemoryStore, MergeSource>,
): Promise<void> {
    const written: string[] = [];
    try {
        for (const [id, planned] of plan) {
            const file = planned.node.file;
            if (!copies(id, planned, moved)) {
                continue;
            }
            const source = hostPath(planned.from!.dir, file!);
            const destination = hostPath(target.dir, file!);
            if (source === destination) {
                continue;
            }
            const bytes = await readFile(source);
            const sha = createHash('sha256').update(bytes).digest('hex');
            if (sha !== file!.sha256) {
                throw new MemoryError(
                    `${file!.path} in ${planned.from!.dir} does not match the digest its memory records`,
                    'that memory was modified outside zen; merge it after re-running it',
                );
            }
            const existed = await stat(destination).then(
                () => true,
                () => false,
            );
            await writeFile(destination, bytes);
            if (!existed) {
                written.push(destination);
            }
            reports.get(planned.from!)!.files++;
        }
    } catch (err) {
        await Promise.all(written.map((path) => rm(path, { force: true })));
        throw err;
    }
}

/** A file comes across when its node came from a source and survived the fold. */
function copies(id: string, planned: Planned, moved: ReadonlyMap<string, string>): boolean {
    if (!planned.from || !planned.node.file) {
        return false;
    }
    return !planned.fresh || moved.get(id) === id;
}

function total(report: MergeReport): MergeReport {
    for (const src of report.sources) {
        report.added += src.added;
        report.shared += src.shared;
        report.twins += src.twins;
        report.files += src.files;
    }
    return report;
}

function clip(text: string): string {
    const flat = flatten(text);
    return flat.length > CLIP ? `${flat.slice(0, CLIP - 1)}…` : flat;
}
