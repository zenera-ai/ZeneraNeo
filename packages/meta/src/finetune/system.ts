import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    appendFileSync,
    copyFileSync,
    cpSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// The system under tuning, as numbered versions
//
// What tuning changes is `agents.yaml` and everything under `agents/`, so that
// is the system: hashed as a whole, copied whole at every version, so any
// version can be diffed against another or put back. A version is recorded
// when the hash moves - by an apply, or by someone's hand between sessions.
// ---------------------------------------------------------------------------

const CONFIG_FILES = ['agents.yaml', 'agents.yml'];
const AGENTS = 'agents';

export interface VersionRow {
    v: number;
    hash: string;
    at: string;
    from: 'start' | 'external' | 'apply';
    apply?: string;
}

const pad = (n: number): string => String(n).padStart(2, '0');

export class SystemVersions {
    readonly root: string;
    readonly dir: string;

    constructor(root: string, dir: string) {
        this.root = root;
        this.dir = dir;
    }

    #files(): string[] {
        const found = CONFIG_FILES.filter((f) => existsSync(join(this.root, f)));
        const agents = join(this.root, AGENTS);
        if (existsSync(agents)) {
            for (const entry of readdirSync(agents, { recursive: true, withFileTypes: true })) {
                if (entry.isFile() && entry.name !== '.DS_Store') {
                    const rel = join(entry.parentPath, entry.name).slice(this.root.length + 1);
                    found.push(rel.split('\\').join('/'));
                }
            }
        }
        return found.sort();
    }

    hash(): string {
        const h = createHash('sha256');
        for (const rel of this.#files()) {
            h.update(rel)
                .update('\0')
                .update(readFileSync(join(this.root, rel)))
                .update('\0');
        }
        return h.digest('hex').slice(0, 16);
    }

    rows(): VersionRow[] {
        try {
            return readFileSync(join(this.dir, 'systems.jsonl'), 'utf8')
                .split('\n')
                .filter(Boolean)
                .map((line) => JSON.parse(line) as VersionRow);
        } catch {
            return [];
        }
    }

    current(): VersionRow | undefined {
        return this.rows().at(-1);
    }

    version(): number {
        return this.current()?.v ?? 0;
    }

    snapshotDir(v: number): string {
        return join(this.dir, `v${pad(v)}`);
    }

    /** A new version when the system moved since the last one; the last one otherwise. */
    record(from: VersionRow['from'], apply?: string): VersionRow {
        const hash = this.hash();
        const last = this.current();
        if (last?.hash === hash) {
            return last;
        }
        const row: VersionRow = {
            v: (last?.v ?? 0) + 1,
            hash,
            at: new Date().toISOString(),
            from: from === 'start' && last ? 'external' : from,
            ...(apply ? { apply } : {}),
        };
        const to = this.snapshotDir(row.v);
        rmSync(to, { recursive: true, force: true });
        mkdirSync(to, { recursive: true });
        for (const f of CONFIG_FILES) {
            if (existsSync(join(this.root, f))) {
                copyFileSync(join(this.root, f), join(to, f));
            }
        }
        if (existsSync(join(this.root, AGENTS))) {
            cpSync(join(this.root, AGENTS), join(to, AGENTS), { recursive: true });
        }
        mkdirSync(this.dir, { recursive: true });
        appendFileSync(join(this.dir, 'systems.jsonl'), `${JSON.stringify(row)}\n`);
        return row;
    }

    /** Puts version `v` back, exactly: files added since are removed. */
    restore(v: number): void {
        const from = this.snapshotDir(v);
        for (const f of CONFIG_FILES) {
            rmSync(join(this.root, f), { force: true });
            if (existsSync(join(from, f))) {
                copyFileSync(join(from, f), join(this.root, f));
            }
        }
        rmSync(join(this.root, AGENTS), { recursive: true, force: true });
        if (existsSync(join(from, AGENTS))) {
            cpSync(join(from, AGENTS), join(this.root, AGENTS), { recursive: true });
        }
    }

    /** Forgets the versions an apply recorded, as if it never ran. */
    drop(apply: string): void {
        const rows = this.rows();
        const keep = rows.filter((r) => r.apply !== apply);
        if (keep.length === rows.length) {
            return;
        }
        for (const r of rows) {
            if (r.apply === apply) {
                rmSync(this.snapshotDir(r.v), { recursive: true, force: true });
            }
        }
        writeFileSync(
            join(this.dir, 'systems.jsonl'),
            keep.map((r) => `${JSON.stringify(r)}\n`).join(''),
        );
    }

    /** `git diff` between two versions' copies; a file list where git is missing. */
    diff(a: number, b: number): string {
        const res = spawnSync(
            'git',
            ['diff', '--no-index', '--no-color', '--', `v${pad(a)}`, `v${pad(b)}`],
            { cwd: this.dir, encoding: 'utf8' },
        );
        if (res.error || (res.status !== 0 && res.status !== 1)) {
            return `(git diff unavailable) v${pad(a)} -> v${pad(b)}\n`;
        }
        return res.stdout;
    }
}
