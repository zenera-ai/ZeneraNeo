import { display, stamp } from '@zenera/engine';
import type { ContentPart, Input, ModelUsage, RunIdentity } from '@zenera/neo';
import {
    addUsage,
    lockHolder,
    MANIFEST_FILE as MEMORY_MANIFEST,
    memoryDir,
    MemoryStore,
    mergeModelUsage,
    readProjectConfig,
    SANDBOX_GROUP,
    selectTools,
    usageByModel,
    zeroUsage,
} from '@zenera/neo';
import { existsSync } from 'node:fs';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import * as Engine from './engine.ts';
import { duration } from './narrate.ts';
import { assertLocks } from './podman.ts';
import { BatchProgress } from './progress.ts';
import type { BatchItem, BatchRequest } from './request.ts';
import { project as resolveProject, target } from './resolve.ts';
import {
    CliError,
    count,
    cyan,
    dim,
    EXIT,
    invalidError,
    json,
    jsonText,
    note,
    usageError,
    write,
} from './term.ts';
import { appendUsage } from './usage.ts';
import { availableTools } from './validate.ts';

/**
 * Many questions, one project, at once.
 *
 * The shape of the thing follows from two facts about a run. A workspace is a
 * directory the agent writes into, so two runs cannot share one; and a memory
 * takes a lock on its directory, so two runs cannot share that either. A batch
 * is therefore not "`zen run` in a loop with a semaphore" — it is a set of
 * isolated runs that happen to have been asked together, and the batch
 * directory is where that isolation is kept.
 *
 * The one thing they *can* share is a memory nobody writes to. That is what
 * `--memory-read-only` is for, and why it had to become real in the runtime
 * before this command could exist: recall used to commit a `lastUsedAt` bump,
 * which is a write, which is a lock, which is a batch of one.
 *
 * Everything that can be refused is refused before the first model call. A
 * batch is the case where a mistake is paid for a hundred times.
 */

export interface BatchOptions {
    request: BatchRequest;
    /** the batch file, for the record it leaves */
    input: string;
    /** `--batch-dir`, relative to the cwd; default `<project>/batches/<stamp>` */
    dir?: string;
    cwd: string;
    project?: string;
    /** `--memory`, already absolute */
    memory?: string;
    memoryReadOnly?: boolean;
    concurrency: number;
    model?: string;
    image?: string;
    readOnly?: boolean;
    keys?: boolean;
    yes?: boolean;
    /** `--as`: who every item acts for */
    user?: RunIdentity;
    /** a second home for the combined envelope */
    out?: string;
    json: boolean;
}

export type MemoryMode = 'read-only' | 'copied' | 'none';

interface ItemResult {
    index: number;
    id: string;
    ok: boolean;
    input: unknown;
    /** the file holding what `zen run --json` would have printed */
    output: string;
    error?: { message: string; hint?: string };
}

/** Past this, the limit is the provider's rate limit and the failures are 429s. */
const MAX_CONCURRENCY = 32;

export async function runBatch(opts: BatchOptions): Promise<void> {
    const project = await resolveProject({ cwd: opts.cwd, project: opts.project });
    const items = opts.request.items;

    // Every item at once holds its own containers, so a short engine fails
    // here once instead of once per item.
    const boxes = containersPerItem(project.dir);
    if (boxes > 0) {
        await assertLocks(boxes * Math.min(opts.concurrency, items.length));
    }

    const dir = opts.dir ? resolve(opts.cwd, opts.dir) : join(project.dir, 'batches', stamp());
    // Two batches in one directory would interleave their item folders and the
    // second would overwrite the first's index while the first still points at
    // it. Cheaper to refuse than to explain.
    if (existsSync(join(dir, 'batch.json'))) {
        throw invalidError(
            `${dir} already holds a batch`,
            'name an empty directory with --batch-dir, or leave it out for a fresh one',
        );
    }
    await mkdir(dir, { recursive: true });

    const source = memorySource(project.dir, opts.memory);
    const mode: MemoryMode = source ? (opts.memoryReadOnly ? 'read-only' : 'copied') : 'none';
    // A project declares its memory directory; it is the first run that makes
    // one. So a batch may legitimately be pointed at a graph that is not there
    // yet - which is the whole of warming a cold project.
    const seeded = source !== undefined && existsSync(source);
    if (opts.memoryReadOnly && !source) {
        throw usageError(
            '--memory-read-only, but this project has no memory',
            'give one with --memory, or drop the flag',
        );
    }
    if (source && seeded) {
        // A graph is three files that only mean anything together. Reading one
        // mid-commit is a wrong answer and copying one is a wrong archive, so
        // both modes wait rather than race.
        const held = lockHolder(source);
        if (held) {
            throw invalidError(
                `that memory is in use (pid ${held.pid}, since ${held.startedAt})`,
                'wait for that run to finish, or point --memory at another directory',
            );
        }
    }

    // Serially, and before anything runs: sixteen recursive copies of the same
    // tree at once is the one moment a batch is disk-bound, and it would be
    // spent racing itself.
    const prepared = await prepareMemories(items, { dir, mode, source, seeded });
    // Opened once, here, so a path that is not a memory is one error rather
    // than one per item — and so the read-only refusal lands before any cost.
    if (mode === 'read-only' && source) {
        await MemoryStore.open(source, { readOnly: true });
    }

    // Ctrl-C asks every run to stop rather than killing the process: each one
    // still lands its turn, and each finished item keeps the answer it already
    // wrote.
    const stopping = new AbortController();
    const onInterrupt = (): void => stopping.abort();
    process.once('SIGINT', onInterrupt);

    if (!opts.json) {
        note(
            `${cyan(project.name)} ${dim(`${count(items.length, 'item')}, ${opts.concurrency} at a time`)}`,
        );
        note(
            dim(
                `memory: ${source ? `${mode}${seeded ? '' : ' (new)'}, ${display(source, opts.cwd)}` : 'none'}`,
            ),
        );
        note(dim(`batch:  ${display(dir, opts.cwd)}`));
        note(dim(`watch:  ${display(join(dir, 'README.md'), opts.cwd)}`));
        note('');
    }

    // The dashboard, from here until the last item lands.
    const progress = new BatchProgress({
        dir,
        project: project.name,
        projectDir: project.dir,
        input: opts.input,
        concurrency: opts.concurrency,
        memory: source ? `${mode}${seeded ? '' : ' (new)'} — \`${source}\`` : 'none',
        items,
    });
    progress.begin();

    const startedAt = new Date();
    let done = 0;
    // What each item spent, per model. Collected here rather than read back
    // out of the dashboard, which is deliberately not load-bearing.
    const spent: ModelUsage[][] = [];
    const results = await pool(items, opts.concurrency, async (item) => {
        const result = await runItem(item, {
            opts,
            projectDir: project.dir,
            dir,
            memory: prepared.get(item.id),
            memoryReadOnly: mode === 'read-only',
            signal: stopping.signal,
            progress,
            spent,
        });
        done += 1;
        if (!opts.json) {
            note(
                `${dim(`[${done}/${items.length}]`)} ` +
                    `${result.ok ? cyan('ok') : 'failed'} ${item.id}` +
                    `${result.error ? dim(` — ${result.error.message}`) : ''}`,
            );
        }
        return result;
    });
    process.off('SIGINT', onInterrupt);
    await progress.close();

    // An item that was given an empty graph and found nothing worth keeping
    // leaves a directory that is not a memory, and `merge` rightly refuses
    // one. Nothing was learned there, so there is nothing to leave behind.
    const written = mode === 'copied' ? await keepWritten(prepared) : 0;

    const finishedAt = new Date();
    const failed = results.filter((r) => !r.ok).length;
    const models = mergeModelUsage(...spent);
    const body = {
        batch: {
            dir,
            readme: join(dir, 'README.md'),
            input: opts.input,
            project: project.dir,
            items: items.length,
            ok: results.length - failed,
            failed,
            concurrency: opts.concurrency,
            memory: { source: source ?? null, mode },
            usage: models.reduce((sum, m) => addUsage(sum, m.usage), zeroUsage()),
            models,
            startedAt: startedAt.toISOString(),
            finishedAt: finishedAt.toISOString(),
            durationMs: finishedAt.getTime() - startedAt.getTime(),
        },
        batch_results: results,
    };
    const text = jsonText(body);
    await writeFile(join(dir, 'batch.json'), text, 'utf8');
    appendUsage(project.dir, {
        kind: 'batch',
        ts: finishedAt.toISOString(),
        batchDir: dir,
        input: opts.input,
        items: items.length,
        ok: results.length - failed,
        failed,
        concurrency: opts.concurrency,
        memory: mode,
        startedAt: startedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        models,
    });
    if (opts.out) {
        await writeFile(resolve(opts.cwd, opts.out), text, 'utf8');
    }

    if (opts.json) {
        json(body);
    } else {
        note('');
        note(
            `${count(results.length - failed, 'run')} ok, ${failed} failed  ` +
                dim(duration(finishedAt.getTime() - startedAt.getTime())),
        );
        if (mode === 'copied' && written > 0) {
            note(dim(`fold what they learned back in: zen memory merge ${dir}/*/memory`));
        }
        // The batch directory is the answer, and it is the whole answer: every
        // path in the index is under it.
        write(dir);
    }

    // After everything is written. A batch that ends in a non-zero exit still
    // has to leave behind the answers it did get.
    if (failed > 0) {
        throw new CliError(
            `${count(failed, 'item')} failed`,
            EXIT.failed,
            `what each one said: ${join(dir, 'batch.json')}`,
        );
    }
}

// ---------------------------------------------------------------------------
// One item
// ---------------------------------------------------------------------------

/**
 * The most containers one item can start: one shared by the agents on the
 * project's sandbox block, one more for each agent with a block of its own.
 * A project that does not load is each item's to report, so it counts none.
 */
export function containersPerItem(dir: string): number {
    let read: ReturnType<typeof readProjectConfig>;
    try {
        read = readProjectConfig(dir);
    } catch {
        return 0;
    }
    const tools = availableTools(read.root, read.config);
    const shells = read.config.agents.filter((a) => {
        try {
            return selectTools(tools, [...(a.tools ?? [])], { where: a.name }).some(
                (t) => t.group === SANDBOX_GROUP,
            );
        } catch {
            return false;
        }
    });
    const own = shells.filter((a) => a.sandbox).length;
    return own + (shells.length > own ? 1 : 0);
}

interface ItemContext {
    opts: BatchOptions;
    projectDir: string;
    dir: string;
    memory?: string;
    memoryReadOnly: boolean;
    signal: AbortSignal;
    progress: BatchProgress;
    /** every finished item appends its own per-model split here */
    spent: ModelUsage[][];
}

/**
 * A failure is data. One item that asks something the model cannot answer must
 * not cost the other ninety-nine their answers, so everything is caught and
 * written down, and the exit code is decided once at the end.
 */
async function runItem(item: BatchItem, ctx: ItemContext): Promise<ItemResult> {
    const at = join(ctx.dir, item.id);
    const output = join(at, 'output.json');
    const watch = ctx.progress.watch(item.id);

    try {
        const where = await target({
            cwd: ctx.opts.cwd,
            project: ctx.projectDir,
            // Every item is its own conversation. There is no session to
            // resume and nobody to ask which one.
            fresh: true,
            workspace: item.workspace ?? join(at, 'workspace'),
            yes: true,
        });

        const engine = await Engine.open({
            project: where.project,
            session: where.session,
            readOnly: ctx.opts.readOnly,
            model: ctx.opts.model,
            image: ctx.opts.image,
            memoryDir: ctx.memory,
            memoryReadOnly: ctx.memoryReadOnly,
            keys: ctx.opts.keys,
            user: ctx.opts.user,
            yes: true,
            // The project's own problems are the batch's, not each item's.
            quiet: true,
            // A fresh session nobody resumes: a stopped container per item
            // is how a few fine-tuning rounds used up every engine lock.
            disposable: true,
        });

        try {
            // Nothing is narrated to the terminal — a hundred interleaved
            // streams there is not progress, it is noise. The events go to the
            // dashboard instead, where each item has a line of its own.
            const outcome = await Engine.run(engine, item.input, watch, ctx.signal);
            // Written the moment it is known, not at the end — a batch killed
            // halfway still has every answer it managed to get.
            await writeFile(output, jsonText(Engine.envelope(engine, outcome)), 'utf8');
            const models = usageByModel(outcome.result.state.trajectory);
            ctx.spent.push(models);
            appendUsage(ctx.projectDir, {
                kind: 'run',
                ts: new Date().toISOString(),
                runDir: outcome.run.dir,
                session: engine.session.id,
                batchDir: ctx.dir,
                item: item.id,
                ok: true,
                stopReason: outcome.result.stopReason,
                durationMs: outcome.durationMs,
                models,
            });
            ctx.progress.finish(item.id, { ok: true, usage: outcome.result.usage, models });
            return { index: item.index, id: item.id, ok: true, input: index(item.input), output };
        } finally {
            await engine.close();
        }
    } catch (err) {
        const error = {
            message: err instanceof Error ? err.message : String(err),
            ...(err instanceof CliError && err.hint ? { hint: err.hint } : {}),
        };
        await writeFile(output, jsonText({ ok: false, id: item.id, error }), 'utf8');
        appendUsage(ctx.projectDir, {
            kind: 'run',
            ts: new Date().toISOString(),
            batchDir: ctx.dir,
            item: item.id,
            ok: false,
            error: error.message,
            models: [],
        });
        ctx.progress.finish(item.id, { ok: false, error: error.message });
        return {
            index: item.index,
            id: item.id,
            ok: false,
            input: index(item.input),
            output,
            error,
        };
    }
}

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

/**
 * A bounded map that keeps its order. Workers pull from one cursor rather than
 * taking a slice each, so a batch of one slow item and fifty fast ones finishes
 * in the time of the slow one instead of the time of the slowest slice.
 *
 * `worker` is expected not to throw; `runItem` is the only caller and catches.
 */
export async function pool<T, R>(
    items: readonly T[],
    limit: number,
    worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
    const out = new Array<R>(items.length);
    let next = 0;
    const runner = async (): Promise<void> => {
        for (;;) {
            const i = next;
            next += 1;
            if (i >= items.length) {
                return;
            }
            out[i] = await worker(items[i]!, i);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
    return out;
}

/** `--concurrency`, or the default. */
export function concurrency(value: string | undefined): number {
    if (value === undefined) {
        return 16;
    }
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) {
        throw usageError(`--concurrency ${value}: expected a whole number, 1 or more`);
    }
    if (n > MAX_CONCURRENCY) {
        throw usageError(
            `--concurrency ${n} is more than this runs at once`,
            `${MAX_CONCURRENCY} is the most; past that the limit is the provider's, not ours`,
        );
    }
    return n;
}

/**
 * Each item's memory, made before any of them runs.
 *
 * In the copying mode every item gets its own graph to write into, so that
 * sixteen runs at once are sixteen private histories rather than one contended
 * lock. A source that is not there yet is not an error: a project declares its
 * memory directory and the first run makes it, so warming a cold project means
 * copying from nothing, and nothing is what each item starts with.
 */
export async function prepareMemories(
    items: readonly BatchItem[],
    at: { dir: string; mode: MemoryMode; source?: string; seeded: boolean },
): Promise<Map<string, string>> {
    const prepared = new Map<string, string>();
    for (const item of items) {
        await mkdir(join(at.dir, item.id), { recursive: true });
        if (at.mode === 'copied' && at.source) {
            const mine = join(at.dir, item.id, 'memory');
            if (at.seeded) {
                await cp(at.source, mine, { recursive: true, filter: notLock });
            }
            prepared.set(item.id, mine);
        } else if (at.mode === 'read-only' && at.source) {
            prepared.set(item.id, at.source);
        }
    }
    return prepared;
}

/**
 * Drops the memories nothing was committed to, and counts the ones left.
 *
 * A memory is its manifest and the two files beside it; a directory without
 * one is not a memory and `merge` refuses it by name. Leaving those behind
 * would mean the `merge` line this command prints is advice that fails, so an
 * item that learned nothing leaves nothing.
 */
export async function keepWritten(prepared: ReadonlyMap<string, string>): Promise<number> {
    let kept = 0;
    for (const at of prepared.values()) {
        if (existsSync(join(at, MEMORY_MANIFEST))) {
            kept += 1;
        } else {
            await rm(at, { recursive: true, force: true });
        }
    }
    return kept;
}

/** Where the batch reads memory from: `--memory`, else what the project says. */
function memorySource(projectDir: string, override?: string): string | undefined {
    try {
        return memoryDir(projectDir, readProjectConfig(projectDir).config, override);
    } catch {
        // An unloadable project is about to fail properly, with its own error.
        return override;
    }
}

/** The lock belongs to the run that took it, never to a copy of its memory. */
const notLock = (src: string): boolean => basename(src) !== '.lock';
/**
 * The question, for the index — text whole, media named rather than repeated.
 * Every byte is already in the item's own run input file, and a combined file
 * carrying forty inlined screenshots is not an index of anything.
 */
function index(input: Input): unknown {
    if (typeof input === 'string') {
        return input;
    }
    const parts = Array.isArray(input) ? input : [input];
    return parts.map((part) => summarise(part as ContentPart));
}

function summarise(part: ContentPart): unknown {
    if (part.type === 'text') {
        return part;
    }
    if (part.url.startsWith('data:')) {
        return { type: part.type, mimeType: part.mimeType, bytes: part.url.length, inlined: true };
    }
    return part;
}
