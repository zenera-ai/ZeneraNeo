import * as Projects from '@zenera/engine';
import {
    createSession,
    listSessions,
    readSessionMeta,
    requireSession,
    sessionPaths,
    stamp,
    type SessionPaths,
} from '@zenera/engine';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import * as term from './term.ts';
import { ago, bold, cyan, dim, usageError, yellow } from './term.ts';

// ---------------------------------------------------------------------------
// Resolution
//
// Three questions — which project, which session, which workspace — each
// answered from a flag, then from context, then by asking. Off a terminal the
// asking step is an error instead, so a script fails with a message naming the
// flag it wants rather than hanging on a prompt nobody will answer.
// ---------------------------------------------------------------------------

export interface Wanted {
    project?: string;
    session?: string;
    fresh?: boolean;
    workspace?: string;
    /** false to take the session's own workspace without offering a choice */
    ask?: boolean;
    yes?: boolean;
    cwd: string;
}

export interface Target {
    project: Projects.Project;
    session: SessionPaths;
    /** true when this call created the session */
    created: boolean;
    /** absolute path the agent's file tools are rooted at */
    workspace: string;
    /** true when that directory is the session's own, made by this call */
    freshWorkspace: boolean;
}

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

export async function project(want: Wanted): Promise<Projects.Project> {
    if (want.project) {
        return Projects.open(want.project);
    }
    if (!statSync(want.cwd, { throwIfNoEntry: false })?.isDirectory()) {
        throw usageError(`not a directory: ${want.cwd}`, 'check the path given to -C');
    }
    const here = await Projects.current(want.cwd);
    if (here) {
        return here;
    }
    const registry = await Projects.Registry.open();
    const known = registry.entries.filter((e) => existsSync(e.path));
    if (known.length === 0) {
        throw usageError('not inside a project, and none are registered', 'create one: zen init');
    }
    if (!term.isInteractive()) {
        throw usageError('not inside a project', 'name one with --project');
    }
    // Most recently worked in first: the answer to "which project" is nearly
    // always the one from last time, and registration order is nothing to a
    // person. A project never run sorts last, by name.
    const ranked = known
        .map((entry) => ({ entry, used: Projects.lastUsedAt(entry.path) ?? '' }))
        .sort((a, b) => b.used.localeCompare(a.used) || a.entry.name.localeCompare(b.entry.name));
    const chosen = await term.choose(
        'Which project?',
        ranked.map(({ entry }) => ({ label: entry.name, detail: entry.path, value: entry })),
    );
    return Projects.openDir(chosen.path);
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export async function target(want: Wanted): Promise<Target> {
    const found = await project(want);
    const dir = found.dir;

    if (want.session && want.fresh) {
        throw usageError('--session and --new contradict each other');
    }
    if (want.session) {
        return await resumed(found, requireSession(dir, want.session));
    }
    if (!want.fresh) {
        const existing = await pickExisting(dir);
        if (existing) {
            return await resumed(found, existing);
        }
    }
    const made = await create(dir, want);
    return {
        project: found,
        session: made.session,
        created: true,
        workspace: made.workspace,
        freshWorkspace: contains(made.session.dir, made.workspace),
    };
}

/** A session that already exists brings its own workspace; it is never re-asked. */
async function resumed(project: Projects.Project, session: SessionPaths): Promise<Target> {
    const meta = await readSessionMeta(session);
    return {
        project,
        session,
        created: false,
        workspace: resolve(meta.workspace),
        freshWorkspace: false,
    };
}

/**
 * Past this many, you are looking for a session by name rather than scrolling
 * to it — and `--session <id>` is how you say a name.
 */
const MAX_SESSIONS = 25;

/**
 * Starting fresh is first, and it is the default: `zen run` followed by Enter
 * should be a new conversation in a new directory, because that is what the
 * command is asked for most often and the only answer that cannot go wrong.
 * Everything already here is offered under it, newest first.
 *
 * A session that has never run has nothing to continue — it is indistinguishable
 * from a fresh one, so it is left out rather than offered as a choice.
 */
async function pickExisting(projectDir: string): Promise<SessionPaths | undefined> {
    const all = (await listSessions(projectDir)).filter((s) => s.runs > 0 || s.busy);
    if (all.length === 0) {
        return undefined;
    }
    if (!term.isInteractive()) {
        return sessionPaths(projectDir, all[0]!.id);
    }
    const sessions = all.slice(0, MAX_SESSIONS);
    const choice = await term.choose<string | undefined>('Session', [
        {
            key: '0',
            label: bold(cyan('New session…')),
            detail: dim('a fresh conversation, in a directory of its own'),
            value: undefined,
        },
        ...sessions.map((s) => ({
            label: s.title ?? s.id,
            detail:
                `${s.id}  ${ago(s.lastRunAt ?? s.createdAt)}  ` +
                `${s.runs} run${s.runs === 1 ? '' : 's'}${s.busy ? yellow('  running') : ''}`,
            value: s.id as string | undefined,
        })),
    ]);
    return choice ? sessionPaths(projectDir, choice) : undefined;
}

interface Made {
    session: SessionPaths;
    workspace: string;
}

/**
 * The id is minted before anything is written, so the workspace question can be
 * asked against the real paths — and so a cancelled answer leaves no directory
 * behind.
 */
async function create(projectDir: string, want: Wanted): Promise<Made> {
    const id = stamp();
    const planned = sessionPaths(projectDir, id);
    const workspace = await chooseWorkspace(planned, want);
    return { session: createSession(projectDir, id, workspace), workspace };
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

/**
 * The workspace is what the agent can read and write, so pointing it outside
 * the session is the useful case and the dangerous one. It is confirmed once,
 * explicitly, naming the path — and a script has to say `--yes` to skip that.
 * An agent with file tools rooted at `$HOME` should take more than one
 * keystroke to arrange.
 */
export async function chooseWorkspace(session: SessionPaths, want: Wanted): Promise<string> {
    const own = resolve(session.workspace);
    if (want.workspace) {
        const at = resolve(want.cwd, want.workspace);
        await approve(at, session, want);
        return at;
    }
    if (want.ask === false || !term.isInteractive()) {
        return own;
    }
    const chosen = await term.choose('Workspace — what the agent can read and write', [
        { label: 'A fresh, empty directory', detail: own, value: own },
        { label: 'The directory you started in', detail: want.cwd, value: want.cwd },
    ]);
    await approve(chosen, session, want);
    return chosen;
}

async function approve(at: string, session: SessionPaths, want: Wanted): Promise<void> {
    if (contains(session.dir, at)) {
        return;
    }
    if (!want.workspace) {
        term.warn(`the agent will be able to read and write ${at}`);
    }
    if (want.yes) {
        return;
    }
    if (!term.isInteractive()) {
        throw usageError(
            'refusing a workspace outside the session without confirmation',
            'pass --yes if that is what you meant',
        );
    }
    if (!(await term.confirm('Continue?'))) {
        throw usageError('cancelled');
    }
}

function contains(parent: string, child: string): boolean {
    const from = resolve(parent);
    const to = resolve(child);
    if (from === to) {
        return true;
    }
    const rel = relative(from, to);
    return !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}
