import { invalidError } from '../../host.ts';
import { canonical, Sources } from './anchors.ts';
import type { Proposed, ProposedRubric } from './schema.ts';
import type { Commit, DatasetStore } from './store.ts';
import {
    anchorText,
    type By,
    type Case,
    type ChangeOp,
    type ChangeRow,
    CONTENT_FIELDS,
    type ContentField,
    type FieldChange,
    type Manifest,
    RESTART_FIELDS,
    type RevisionRow,
    type RubricItem,
    sameAnchor,
} from './types.ts';

// ---------------------------------------------------------------------------
// From what was asked to what gets written
//
// Every write — an apply, an edit, a retirement — is planned in full against
// the store before a byte moves: the cases as they will be, a journal row for
// each one that changed, and one revision line naming them all. What changed is
// decided field by field, and only a change to what the case asks or how it is
// judged makes it a different case; a moved source hash alone is noted, not
// counted.
// ---------------------------------------------------------------------------

export interface Plan extends Commit {
    /** cases that were looked at and found the same */
    unchanged: string[];
}

interface Next {
    before?: Case;
    after: Case;
}

const same = (a: unknown, b: unknown): boolean => canonical(a ?? null) === canonical(b ?? null);

/**
 * Rubric items keep their ids across edits, so a note saying `r3 failed` still
 * means the same line. An explicit id wins; otherwise the same words are the
 * same item; anything else is new.
 */
export function assignRubric(
    before: readonly RubricItem[],
    proposed: readonly ProposedRubric[],
): RubricItem[] {
    const known = new Map(before.map((item) => [item.id, item]));
    const taken = new Set<string>();
    let next = before.reduce(
        (max, item) => Math.max(max, Number(/^r(\d+)$/.exec(item.id)?.[1] ?? 0)),
        0,
    );
    const pending: { index: number; text: string }[] = [];
    const out: (RubricItem | undefined)[] = proposed.map((item, index) => {
        if (item.id && known.has(item.id) && !taken.has(item.id)) {
            taken.add(item.id);
            return { id: item.id, text: item.text };
        }
        pending.push({ index, text: item.text });
        return undefined;
    });
    for (const { index, text } of pending) {
        const match = before.find((item) => !taken.has(item.id) && item.text === text);
        if (match) {
            taken.add(match.id);
            out[index] = { id: match.id, text };
        }
    }
    return out.map((item, index) => {
        if (item) {
            return item;
        }
        let id: string;
        do {
            id = `r${++next}`;
        } while (taken.has(id));
        taken.add(id);
        return { id, text: proposed[index].text };
    });
}

function rubricChanges(before: readonly RubricItem[], after: readonly RubricItem[]): FieldChange[] {
    const was = new Map(before.map((i) => [i.id, i.text]));
    const now = new Map(after.map((i) => [i.id, i.text]));
    const out: FieldChange[] = [];
    for (const [id, text] of now) {
        if (!was.has(id)) {
            out.push({ path: `rubric/${id}`, to: text });
        } else if (was.get(id) !== text) {
            out.push({ path: `rubric/${id}`, from: was.get(id), to: text });
        }
    }
    for (const [id, text] of was) {
        if (!now.has(id)) {
            out.push({ path: `rubric/${id}`, from: text });
        }
    }
    if (
        out.length === 0 &&
        !same(
            before.map((i) => i.id),
            after.map((i) => i.id),
        )
    ) {
        out.push({ path: 'rubric', from: before.map((i) => i.id), to: after.map((i) => i.id) });
    }
    return out;
}

const withoutHash = (c: Case): Case['source'] =>
    c.source
        ? { file: c.source.file, ...(c.source.anchor ? { anchor: c.source.anchor } : {}) }
        : undefined;

function fieldChanges(before: Case, after: Case): FieldChange[] {
    const out: FieldChange[] = [];
    for (const field of CONTENT_FIELDS) {
        if (field === 'rubric') {
            out.push(...rubricChanges(before.rubric, after.rubric));
            continue;
        }
        const from = field === 'source' ? withoutHash(before) : before[field];
        const to = field === 'source' ? withoutHash(after) : after[field];
        if (!same(from, to)) {
            out.push({
                path: field,
                ...(from !== undefined ? { from } : {}),
                ...(to !== undefined ? { to } : {}),
            });
        }
    }
    return out;
}

const restarts = (changes: readonly FieldChange[]): boolean =>
    changes.some((c) => RESTART_FIELDS.some((f) => c.path === f || c.path.startsWith(`${f}/`)));

/** Fills in each case's source hash; a source that cannot be found is refused. */
function hashSources(sources: Sources, nexts: readonly Next[]): void {
    const issues: string[] = [];
    for (const { after } of nexts) {
        if (!after.source || after.status !== 'active') {
            continue;
        }
        const found = sources.section(after.source.file, after.source.anchor);
        if (!found.found) {
            issues.push(
                `${after.id}: ${after.source.file} ${anchorText(after.source.anchor)} — ${found.why}`,
            );
            continue;
        }
        after.source = { ...after.source, sha256: found.sha256 };
    }
    if (issues.length > 0) {
        throw invalidError(
            `${issues.length} source${issues.length === 1 ? '' : 's'} could not be found\n  ${issues.join('\n  ')}`,
            'name a heading path or pointer that exists exactly once; nothing was written',
        );
    }
}

/**
 * A file's hash is what lets a drift check skip it, so it only moves forward
 * once the file is settled: every case read from it matches its section, and
 * every section is a case or ignored. A partial apply that left one drifted case
 * behind must leave the file looking moved, or that case is never looked at again.
 */
function manifestFor(
    store: DatasetStore,
    sources: Sources,
    finals: readonly Case[],
    ignored = store.manifest.ignored,
): Manifest {
    const byFile = new Map<string, Case[]>();
    for (const c of finals) {
        if (c.status === 'active' && c.source) {
            byFile.set(c.source.file, [...(byFile.get(c.source.file) ?? []), c]);
        }
    }
    for (const i of ignored) {
        byFile.set(i.file, byFile.get(i.file) ?? []);
    }
    const hashed: Manifest['sources'] = {};
    for (const [file, cases] of [...byFile].sort(([a], [b]) => a.localeCompare(b))) {
        const now = sources.hash(file);
        const was = store.manifest.sources[file]?.sha256;
        if (!now) {
            continue;
        }
        const settled =
            now === was ||
            (cases.every((c) => {
                const found = sources.section(file, c.source!.anchor);
                return found.found && found.sha256 === c.source!.sha256;
            }) &&
                sources
                    .uncovered(file, [
                        ...cases.map((c) => c.source!.anchor),
                        ...ignored.filter((i) => i.file === file).map((i) => i.anchor),
                    ])
                    .every((a) => ignored.some((i) => i.file === file && sameAnchor(i.anchor, a))));
        if (settled) {
            hashed[file] = { sha256: now };
        } else if (was) {
            hashed[file] = { sha256: was };
        }
    }
    return { ...store.manifest, sources: hashed, ignored };
}

function finish(
    store: DatasetStore,
    sources: Sources,
    nexts: readonly Next[],
    why: string,
    by: By,
): Plan {
    hashSources(sources, nexts);
    const rev = store.manifest.revision + 1;
    const at = new Date().toISOString();
    const rows: ChangeRow[] = [];
    const refreshed: Case[] = [];
    const unchanged: string[] = [];
    const revision: RevisionRow = {
        rev,
        at,
        why,
        by,
        added: [],
        updated: [],
        retired: [],
        restored: [],
        restarted: [],
    };

    for (const { before, after } of nexts) {
        if (!before) {
            const added = { ...after, rev };
            rows.push({ type: 'change', rev, at, op: 'add', changes: [], why, by, case: added });
            revision.added.push(after.id);
            continue;
        }
        const changes = fieldChanges(before, after);
        let op: ChangeOp | undefined;
        if (before.status !== after.status) {
            op = after.status === 'retired' ? 'retire' : 'restore';
            changes.unshift({ path: 'status', from: before.status, to: after.status });
        } else if (changes.length > 0) {
            op = 'update';
        }
        if (!op) {
            if (before.source?.sha256 !== after.source?.sha256) {
                refreshed.push({ ...after, rev: before.rev });
            } else {
                unchanged.push(after.id);
            }
            continue;
        }
        const written = { ...after, rev };
        rows.push({ type: 'change', rev, at, op, changes, why, by, case: written });
        if (op === 'retire') {
            revision.retired.push(after.id);
        } else if (op === 'restore') {
            revision.restored.push(after.id);
        } else {
            revision.updated.push(after.id);
        }
        if (op !== 'retire' && restarts(changes)) {
            revision.restarted.push(after.id);
        }
    }

    const touched = new Map([...rows.map((r) => r.case), ...refreshed].map((c) => [c.id, c]));
    const finals = store.all().map((c) => touched.get(c.id) ?? c);
    for (const c of touched.values()) {
        if (!finals.some((f) => f.id === c.id)) {
            finals.push(c);
        }
    }
    return {
        rev,
        rows,
        refreshed,
        unchanged,
        revision,
        manifest: manifestFor(store, sources, finals),
    };
}

// ---------------------------------------------------------------------------
// The writes
// ---------------------------------------------------------------------------

function fromProposal(p: Proposed, before: Case | undefined): Case {
    const after: Case = {
        id: p.id,
        rev: before?.rev ?? 0,
        status: 'active',
        ...(p.class !== undefined ? { class: p.class } : {}),
        ...(p.complexity !== undefined ? { complexity: p.complexity } : {}),
        ...(p.tags !== undefined ? { tags: p.tags } : {}),
        input: p.input,
        rubric: assignRubric(before?.rubric ?? [], p.rubric),
        ...(p.expected !== undefined ? { expected: p.expected } : {}),
        ...(p.notes !== undefined ? { notes: p.notes } : {}),
        ...(p.source !== undefined ? { source: { ...p.source } } : {}),
    };
    for (const field of before?.overrides ?? []) {
        const kept = before![field as ContentField];
        if (kept === undefined) {
            delete (after as unknown as Record<string, unknown>)[field];
        } else {
            (after as unknown as Record<string, unknown>)[field] = kept;
        }
    }
    if (before?.overrides?.length) {
        after.overrides = before.overrides;
    }
    return after;
}

/**
 * A proposal, applied. Whole by default: an active case the proposal does not
 * name is retired. `partial` touches only the cases it names — what a refresh
 * of a few drifted sections writes.
 */
export function planApply(
    store: DatasetStore,
    proposed: readonly Proposed[],
    options: { partial: boolean; why: string; by: By },
): Plan {
    const sources = new Sources(store.root);
    const named = new Set(proposed.map((p) => p.id));
    const nexts: Next[] = proposed.map((p) => {
        const before = store.get(p.id);
        return { before, after: fromProposal(p, before) };
    });
    if (!options.partial) {
        for (const c of store.all()) {
            if (c.status === 'active' && !named.has(c.id)) {
                nexts.push({ before: c, after: { ...c, status: 'retired' } });
            }
        }
    }
    return finish(store, sources, nexts, options.why, options.by);
}

/** One case, changed by hand. `override` keeps the change through later re-extractions. */
export function planEdit(
    store: DatasetStore,
    id: string,
    edit: (c: Case) => Case,
    options: { why: string; by: By; override?: readonly string[] },
): Plan {
    const before = store.get(id);
    if (!before) {
        throw invalidError(`no case ${id}`, 'see: zen meta dataset ls');
    }
    const after = edit(structuredClone(before));
    if (options.override?.length) {
        after.overrides = [...new Set([...(before.overrides ?? []), ...options.override])].sort();
    }
    return finish(store, new Sources(store.root), [{ before, after }], options.why, options.by);
}

export function planStatus(
    store: DatasetStore,
    ids: readonly string[],
    status: Case['status'],
    options: { why: string; by: By },
): Plan {
    const nexts = ids.map((id) => {
        const before = store.get(id);
        if (!before) {
            throw invalidError(`no case ${id}`, 'see: zen meta dataset ls --status all');
        }
        return { before, after: { ...before, status } };
    });
    return finish(store, new Sources(store.root), nexts, options.why, options.by);
}

/** The ignore list changed: no case moves, so no revision; the manifest is rewritten. */
export function planIgnored(store: DatasetStore, ignored: Manifest['ignored']): Plan {
    const sources = new Sources(store.root);
    return {
        rev: store.manifest.revision,
        rows: [],
        refreshed: [],
        unchanged: [],
        revision: {
            rev: store.manifest.revision,
            at: new Date().toISOString(),
            why: '',
            by: { host: '' },
            added: [],
            updated: [],
            retired: [],
            restored: [],
            restarted: [],
        },
        manifest: manifestFor(store, sources, store.all(), ignored),
    };
}
