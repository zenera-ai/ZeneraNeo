import { Sources } from './anchors.ts';
import type { DatasetStore } from './store.ts';
import { type Anchor, sameAnchor } from './types.ts';

// ---------------------------------------------------------------------------
// What moved in the sources
//
// The manifest holds a hash of every source file as of the last write. A file
// whose hash still matches cannot have moved any case, so it is not opened —
// which keeps a drift check over a large corpus to a hash per file. Inside a
// file that did move, each case's own section is found again and compared, so
// a typo fixed three sections away restarts nothing.
// ---------------------------------------------------------------------------

export type CaseDrift = 'changed' | 'gone';

export interface DriftedCase {
    id: string;
    file: string;
    anchor?: Anchor;
    state: CaseDrift;
    why?: string;
}

export interface DriftReport {
    revision: number;
    /** `unsettled`: never recorded, because a section in it is still uncovered */
    files: { file: string; state: 'changed' | 'missing' | 'unsettled' }[];
    cases: DriftedCase[];
    /** active cases checked and found where they were */
    unchanged: number;
    /** active cases with no source to drift from */
    untracked: number;
    uncovered: { file: string; anchor: Anchor }[];
    clean: boolean;
}

/** `all` re-reads unchanged files too, to list their uncovered sections. */
export function drift(store: DatasetStore, options: { all?: boolean } = {}): DriftReport {
    const sources = new Sources(store.root);
    const active = store.all().filter((c) => c.status === 'active');
    const byFile = new Map<string, typeof active>();
    let untracked = 0;
    for (const c of active) {
        if (!c.source) {
            untracked++;
            continue;
        }
        byFile.set(c.source.file, [...(byFile.get(c.source.file) ?? []), c]);
    }
    for (const ignored of store.manifest.ignored) {
        if (!byFile.has(ignored.file)) {
            byFile.set(ignored.file, []);
        }
    }

    const report: DriftReport = {
        revision: store.manifest.revision,
        files: [],
        cases: [],
        unchanged: 0,
        untracked,
        uncovered: [],
        clean: true,
    };
    for (const [file, cases] of [...byFile].sort(([a], [b]) => a.localeCompare(b))) {
        const now = sources.hash(file);
        const was = store.manifest.sources[file]?.sha256;
        const moved = now !== was;
        if (now === undefined) {
            report.files.push({ file, state: 'missing' });
        } else if (moved) {
            report.files.push({ file, state: was ? 'changed' : 'unsettled' });
        }
        if (!moved && !options.all) {
            report.unchanged += cases.length;
            continue;
        }
        for (const c of cases) {
            const found = sources.section(file, c.source!.anchor);
            const anchor = c.source!.anchor ? { anchor: c.source!.anchor } : {};
            if (!found.found) {
                report.cases.push({ id: c.id, file, ...anchor, state: 'gone', why: found.why });
            } else if (found.sha256 !== c.source!.sha256) {
                report.cases.push({ id: c.id, file, ...anchor, state: 'changed' });
            } else {
                report.unchanged++;
            }
        }
        if (now === undefined) {
            continue;
        }
        const ignored = store.manifest.ignored.filter((i) => i.file === file).map((i) => i.anchor);
        const covered = [...cases.map((c) => c.source!.anchor), ...ignored];
        for (const anchor of sources.uncovered(file, covered)) {
            if (!ignored.some((i) => sameAnchor(i, anchor))) {
                report.uncovered.push({ file, anchor });
            }
        }
    }
    report.clean = report.cases.length === 0 && report.uncovered.length === 0;
    return report;
}
