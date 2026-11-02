import { claimLock, ownLock, type RunIdentity } from '@zenera/neo';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { EngineError, EXIT, invalidError, usageError } from './errors.ts';
import { readJson, writeJson } from './home.ts';
import { isStamp, stamp, stampInstant } from './ids.ts';
import { isBusy, runIds, sessionIds, sessionsDir } from './projects.ts';

// ---------------------------------------------------------------------------
// Sessions and runs
//
// A **session** is a context that persists: one workspace, one memory, one blob
// store, one accumulating trajectory. A **run** is one turn inside it.
//
// None of this invents a runtime concept. The session directory is the
// arguments to `FilePayloadStore` and `FileMemoryStore`, and the session state
// is the `AgentState` the runner already serializes. The layout is a place to
// put things the library already produces.
// ---------------------------------------------------------------------------

export interface SessionPaths {
    id: string;
    dir: string;
    /** what the agent can see and write */
    workspace: string;
    data: string;
    /** the live, resumable state — rewritten after every run */
    state: string;
    blobs: string;
    runs: string;
    lock: string;
    meta: string;
}

export function sessionPaths(projectDir: string, id: string): SessionPaths {
    if (!isStamp(id)) {
        throw usageError(`"${id}" is not a session id`, 'ids look like 20260825-143012-a7f3');
    }
    return sessionPathsAt(join(sessionsDir(projectDir), id));
}

/**
 * The same layout, rooted wherever a host keeps its sessions and named however
 * it names them: a server stores one per user and thread, not per project.
 */
export function sessionPathsAt(dir: string): SessionPaths {
    const data = join(dir, '.data');
    return {
        id: basename(dir),
        dir,
        workspace: join(dir, 'workspace'),
        data,
        state: join(data, 'state.json'),
        blobs: join(data, 'blobs'),
        runs: join(dir, 'runs'),
        lock: join(dir, '.lock'),
        meta: join(data, 'session.json'),
    };
}

export interface SessionMeta {
    version: 1;
    id: string;
    createdAt: string;
    /**
     * Absolute path the agent's file tools are rooted at. Recorded so resuming
     * never re-asks and never silently moves — a session that quietly changed
     * what "the workspace" meant between turns would be unexplainable.
     */
    workspace: string;
    lastRunAt?: string;
    title?: string;
}

// ---------------------------------------------------------------------------
// Creating and finding
// ---------------------------------------------------------------------------

export function createSession(projectDir: string, id: string, workspace: string): SessionPaths {
    return createSessionAt(sessionPaths(projectDir, id).dir, workspace);
}

export function createSessionAt(dir: string, workspace: string): SessionPaths {
    const p = sessionPathsAt(dir);
    mkdirSync(p.data, { recursive: true });
    mkdirSync(p.runs, { recursive: true });
    mkdirSync(resolve(workspace), { recursive: true });
    const meta: SessionMeta = {
        version: 1,
        id: p.id,
        createdAt: new Date().toISOString(),
        workspace: resolve(workspace),
    };
    writeJson(p.meta, meta, 0o644);
    return p;
}

export async function readSessionMeta(p: SessionPaths): Promise<SessionMeta> {
    const meta = await readJson<Partial<SessionMeta>>(p.meta, {});
    return {
        version: 1,
        id: p.id,
        createdAt: meta.createdAt ?? new Date().toISOString(),
        // Sessions from before the workspace was recorded fall back to their
        // own directory, which is where it would have been.
        workspace: meta.workspace ?? p.workspace,
        lastRunAt: meta.lastRunAt,
        title: meta.title,
    };
}

export function writeSessionMeta(p: SessionPaths, meta: SessionMeta): void {
    writeJson(p.meta, meta, 0o644);
}

export interface SessionSummary {
    id: string;
    createdAt?: string;
    runs: number;
    lastRunAt?: string;
    busy: boolean;
    title?: string;
}

/** Newest first — the order a picker wants. */
export async function listSessions(projectDir: string): Promise<SessionSummary[]> {
    const out: SessionSummary[] = [];
    for (const id of sessionIds(projectDir).reverse()) {
        const p = sessionPaths(projectDir, id);
        const meta = await readSessionMeta(p);
        const ids = runIds(p.dir);
        out.push({
            id,
            createdAt: meta.createdAt,
            runs: ids.length,
            lastRunAt: meta.lastRunAt,
            busy: isBusy(p.dir),
            title: meta.title,
        });
    }
    return out;
}

export function newestSession(projectDir: string): string | undefined {
    return sessionIds(projectDir).at(-1);
}

export function requireSession(projectDir: string, id: string): SessionPaths {
    const p = sessionPaths(projectDir, id);
    if (!existsSync(p.dir)) {
        throw invalidError(`no session ${id}`, 'see: zen list --sessions');
    }
    return p;
}

// ---------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------

export interface Held {
    release(): void;
}

export function acquire(p: SessionPaths): Held {
    claimLock(
        p.lock,
        ownLock(),
        (held) =>
            new EngineError(
                `session ${p.id} is already running (pid ${held.pid})`,
                EXIT.failed,
                'wait for it, or start another with --new',
            ),
        2,
    );

    let released = false;
    const release = (): void => {
        if (released) {
            return;
        }
        released = true;
        rmSync(p.lock, { force: true });
    };
    return { release };
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export interface RunPaths {
    id: string;
    dir: string;
    input: string;
    output: string;
    state: string;
    report: string;
    /** the same run as one Mermaid flowchart, for a model to read */
    graph: string;
    meta: string;
}

export function runPaths(session: SessionPaths, id: string): RunPaths {
    if (!isStamp(id)) {
        throw usageError(`"${id}" is not a run id`);
    }
    const dir = join(session.runs, id);
    return {
        id,
        dir,
        input: join(dir, 'input.md'),
        output: join(dir, 'output.md'),
        state: join(dir, 'state.json'),
        report: join(dir, 'report.html'),
        graph: join(dir, 'graph.mmd'),
        meta: join(dir, 'meta.json'),
    };
}

export function createRun(session: SessionPaths): RunPaths {
    const p = runPaths(session, stamp());
    mkdirSync(p.dir, { recursive: true });
    return p;
}

/**
 * The same paths, reached from a directory instead of from a pair of ids.
 *
 * `zen run --json` hands back a run directory, and a caller holding one has no
 * reason to take it apart again to ask a second question about the same run.
 * The layout is fixed, so the ids can be read back out of the path — and both
 * still go through `isStamp`, so a path from anywhere cannot name a directory
 * this layout would never have produced.
 *
 * The session comes back too, not only the run: blobs are stored per session,
 * so anything that resolves a payload needs both halves — and the project, so
 * a command reached this way can still read the project's config.
 */
export function runPathsAt(dir: string): {
    project: string;
    session: SessionPaths;
    run: RunPaths;
} {
    const full = resolve(dir);
    const runId = basename(full);
    const sessionDir = dirname(dirname(full));
    const wrong = (): EngineError =>
        usageError(
            `${display(full)} is not a run directory`,
            'runs live at <project>/sessions/<session>/runs/<run>',
        );
    if (!isStamp(runId) || !isStamp(basename(sessionDir)) || basename(dirname(full)) !== 'runs') {
        throw wrong();
    }
    const project = dirname(dirname(sessionDir));
    const session = sessionPaths(project, basename(sessionDir));
    const run = runPaths(session, runId);
    if (resolve(run.dir) !== full) {
        throw wrong();
    }
    if (!existsSync(run.state)) {
        throw invalidError(
            `run ${runId} has no state.json`,
            'only a run that got far enough to save state can be inspected',
        );
    }
    return { project, session, run };
}

export interface RunMeta {
    version: 1;
    id: string;
    session: string;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    agent: string;
    stopReason: string;
    turns: number;
    usage: unknown;
    workspace: string;
    memory?: string;
    /** who the run acted for, when anyone */
    user?: RunIdentity;
    error?: string;
}

export function writeRunMeta(p: RunPaths, meta: RunMeta): void {
    writeJson(p.meta, meta, 0o644);
}

/**
 * Partial, because a run killed before it recorded anything still has a
 * directory, and every field here is worth having on its own.
 */
export async function readRunMeta(p: RunPaths): Promise<Partial<RunMeta>> {
    return await readJson<Partial<RunMeta>>(p.meta, {});
}

export interface RunSummary {
    id: string;
    startedAt?: string;
    finishedAt?: string;
    agent?: string;
    stopReason?: string;
    error?: string;
}

/** Newest first — the order a picker wants. */
export async function listRuns(session: SessionPaths): Promise<RunSummary[]> {
    const out: RunSummary[] = [];
    for (const id of runIds(session.dir).reverse()) {
        // A run killed before it recorded anything still has an id, and the id
        // says when it started, so it is listable without its meta.
        const meta = await readRunMeta(runPaths(session, id));
        out.push({
            id,
            startedAt: meta.startedAt ?? stampInstant(id),
            finishedAt: meta.finishedAt,
            agent: meta.agent,
            stopReason: meta.stopReason,
            error: meta.error,
        });
    }
    return out;
}

export function newestRun(session: SessionPaths): string | undefined {
    return runIds(session.dir).at(-1);
}

/** A path to show a human: relative when that is shorter, absolute otherwise. */
export function display(path: string, from = process.cwd()): string {
    const rel = relative(from, path);
    return !rel.startsWith('..') && rel.length < path.length ? rel || '.' : path;
}
