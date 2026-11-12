import { claimLock, ownLock } from '@zenera/neo';
import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { CliError, EXIT, META_PROMPT_ENV, META_SESSION_ENV } from '../../host.ts';
import {
    type By,
    type Case,
    type ChangeRow,
    DATASET_DIR,
    DATASET_VERSION,
    type JournalRow,
    type Manifest,
    type NoteRow,
    type RevisionRow,
} from './types.ts';

// ---------------------------------------------------------------------------
// The store
//
// Plain files, so git can diff them and a person can read them: a case per
// file, a journal per case, a line per revision, and a manifest written last —
// the manifest's revision is the commit marker, so an apply killed half-way
// shows up as cases newer than it.
//
// Writes take the directory lock; reads never do. A note is one appended line
// and takes no lock either, so an `analyze` running beside an apply can still
// say what it found.
// ---------------------------------------------------------------------------

const MANIFEST = 'manifest.json';
const REVISIONS = 'revisions.jsonl';
const CASES = 'cases';
const LOG = 'log';
const LOCK = '.lock';

export function whoIsThis(): By {
    const session = process.env[META_SESSION_ENV]?.trim();
    const prompt = process.env[META_PROMPT_ENV]?.trim();
    return {
        ...(session ? { session } : {}),
        ...(prompt ? { prompt } : {}),
        host: hostname(),
    };
}

function atomic(path: string, text: string): void {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, path);
}

function lines<T>(path: string): T[] {
    let text: string;
    try {
        text = readFileSync(path, 'utf8');
    } catch {
        return [];
    }
    return text
        .split('\n')
        .filter((line) => line.trim())
        .flatMap((line) => {
            try {
                return [JSON.parse(line) as T];
            } catch {
                return [];
            }
        });
}

const empty = (): Manifest => ({ version: DATASET_VERSION, revision: 0, sources: {}, ignored: [] });

export interface Commit {
    rev: number;
    rows: ChangeRow[];
    revision: RevisionRow;
    manifest: Manifest;
    /** cases whose stored source hash moved with no change worth a revision */
    refreshed: Case[];
}

export class DatasetStore {
    readonly root: string;
    readonly dir: string;
    manifest: Manifest;
    #locked = false;

    private constructor(root: string) {
        this.root = root;
        this.dir = join(root, DATASET_DIR);
        this.manifest = empty();
        try {
            const read = JSON.parse(readFileSync(join(this.dir, MANIFEST), 'utf8')) as Manifest;
            if (read.version !== DATASET_VERSION) {
                throw new CliError(
                    `${this.dir} is dataset version ${read.version}; this zen reads ${DATASET_VERSION}`,
                    EXIT.invalid,
                    'upgrade zen',
                );
            }
            this.manifest = { ...empty(), ...read };
        } catch (err) {
            if (err instanceof CliError) {
                throw err;
            }
        }
    }

    /** `write` claims the directory, creating it if it does not exist yet. */
    static open(root: string, options: { write?: boolean } = {}): DatasetStore {
        const store = new DatasetStore(root);
        if (options.write) {
            mkdirSync(join(store.dir, CASES), { recursive: true });
            mkdirSync(join(store.dir, LOG), { recursive: true });
            claimLock(
                join(store.dir, LOCK),
                ownLock(),
                (held) =>
                    new CliError(
                        `the dataset is being written (pid ${held.pid}, since ${held.startedAt})`,
                        EXIT.failed,
                        `wait for it, or remove ${join(store.dir, LOCK)} if that process crashed`,
                    ),
            );
            store.#locked = true;
        }
        return store;
    }

    exists(): boolean {
        return existsSync(join(this.dir, MANIFEST));
    }

    ids(): string[] {
        try {
            return readdirSync(join(this.dir, CASES))
                .filter((f) => f.endsWith('.json'))
                .map((f) => f.slice(0, -'.json'.length))
                .sort();
        } catch {
            return [];
        }
    }

    get(id: string): Case | undefined {
        try {
            return JSON.parse(readFileSync(join(this.dir, CASES, `${id}.json`), 'utf8')) as Case;
        } catch {
            return undefined;
        }
    }

    all(): Case[] {
        return this.ids().flatMap((id) => this.get(id) ?? []);
    }

    journal(id: string): JournalRow[] {
        return lines<JournalRow>(join(this.dir, LOG, `${id}.jsonl`));
    }

    /** The case as it stood at a revision, read back from its journal. */
    at(id: string, rev: number): Case | undefined {
        let found: Case | undefined;
        for (const row of this.journal(id)) {
            if (row.type === 'change' && row.rev <= rev) {
                found = row.case;
            }
        }
        return found;
    }

    revisions(): RevisionRow[] {
        return lines<RevisionRow>(join(this.dir, REVISIONS));
    }

    /** Cases written by an apply that never reached its manifest. */
    unfinished(): string[] {
        return this.all()
            .filter((c) => c.rev > this.manifest.revision)
            .map((c) => c.id);
    }

    note(id: string, row: NoteRow): void {
        mkdirSync(join(this.dir, LOG), { recursive: true });
        appendFileSync(join(this.dir, LOG, `${id}.jsonl`), `${JSON.stringify(row)}\n`);
    }

    commit(commit: Commit): void {
        if (!this.#locked) {
            throw new Error('commit without the dataset lock');
        }
        for (const row of commit.rows) {
            atomic(
                join(this.dir, CASES, `${row.case.id}.json`),
                `${JSON.stringify(row.case, null, 4)}\n`,
            );
            appendFileSync(join(this.dir, LOG, `${row.case.id}.jsonl`), `${JSON.stringify(row)}\n`);
        }
        for (const c of commit.refreshed) {
            atomic(join(this.dir, CASES, `${c.id}.json`), `${JSON.stringify(c, null, 4)}\n`);
        }
        if (commit.rows.length > 0) {
            appendFileSync(join(this.dir, REVISIONS), `${JSON.stringify(commit.revision)}\n`);
        }
        this.manifest = {
            ...commit.manifest,
            revision: commit.rows.length > 0 ? commit.rev : commit.manifest.revision,
            updatedAt: new Date().toISOString(),
        };
        atomic(join(this.dir, MANIFEST), `${JSON.stringify(this.manifest, null, 4)}\n`);
    }

    release(): void {
        if (!this.#locked) {
            return;
        }
        this.#locked = false;
        try {
            unlinkSync(join(this.dir, LOCK));
        } catch {
            // Already gone, or taken over as stale.
        }
    }
}
