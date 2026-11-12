// ---------------------------------------------------------------------------
// A dataset, as stored
//
// One file per case holds what the case is now; one append-only journal per
// case holds how it got there and what was learned about it. Nothing is ever
// deleted: a removed case is `retired`, so an id is never reused and an old run
// that names it still resolves.
// ---------------------------------------------------------------------------

export const DATASET_DIR = 'dataset';
export const DATASET_VERSION = 1;

export const COMPLEXITIES = ['simple', 'medium', 'complex'] as const;
export type Complexity = (typeof COMPLEXITIES)[number];

export const STATUSES = ['active', 'retired'] as const;
export type Status = (typeof STATUSES)[number];

export const NOTE_KINDS = [
    'graded',
    'analyze',
    'difficult',
    'rubric-suspect',
    'observation',
] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export const VERDICTS = ['right', 'wrong', 'void'] as const;
export type Verdict = (typeof VERDICTS)[number];

/** A case id names a directory under a batch dir, so it is one path segment. */
export const CASE_ID = /^[A-Za-z0-9_.-]+$/;

export const MEDIA_KINDS = ['image', 'audio', 'video', 'file'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export type Part =
    string | { text: string } | ({ [K in MediaKind]?: string } & { mimeType?: string });

export type Input = string | Part[];

export interface RubricItem {
    id: string;
    text: string;
}

/** Where in a source file a case came from. Neither key means the whole file. */
export interface Anchor {
    heading?: string[];
    pointer?: string;
}

export interface Source {
    /** project-relative */
    file: string;
    anchor?: Anchor;
    /** of the section the anchor names, when the case was last applied */
    sha256?: string;
}

export interface Case {
    id: string;
    rev: number;
    status: Status;
    class?: string;
    complexity?: Complexity;
    tags?: string[];
    input: Input;
    rubric: RubricItem[];
    expected?: string;
    notes?: string;
    source?: Source;
    /** fields a re-extraction must not overwrite */
    overrides?: string[];
}

/** A change to these is a different question: earlier results no longer count. */
export const RESTART_FIELDS = ['input', 'rubric', 'expected'] as const;

/** Fields a proposal or `update --set` may write. */
export const CONTENT_FIELDS = [
    'class',
    'complexity',
    'tags',
    'input',
    'rubric',
    'expected',
    'notes',
    'source',
] as const;
export type ContentField = (typeof CONTENT_FIELDS)[number];

/** Who did it: read from the environment `zen meta` gives its agent. */
export interface By {
    session?: string;
    prompt?: string;
    host: string;
}

export interface FieldChange {
    path: string;
    from?: unknown;
    to?: unknown;
}

export type ChangeOp = 'add' | 'update' | 'retire' | 'restore';

export interface ChangeRow {
    type: 'change';
    rev: number;
    at: string;
    op: ChangeOp;
    changes: FieldChange[];
    why: string;
    by: By;
    /** the case as it stood after this change, so any revision can be read back */
    case: Case;
}

export interface NoteRow {
    type: 'note';
    at: string;
    kind: NoteKind;
    /** the case revision the note is about */
    caseRev: number;
    run?: string;
    verdict?: Verdict;
    rubric?: Record<string, Grade>;
    text: string;
    by: By;
}

/** `invalid`: the rubric line itself is broken - it says how one implementation did it, not what is right. */
export type Grade = 'pass' | 'fail' | 'invalid';

export type JournalRow = ChangeRow | NoteRow;

export interface Ignored {
    file: string;
    anchor: Anchor;
    why: string;
    rev: number;
}

export interface Manifest {
    version: number;
    revision: number;
    updatedAt?: string;
    /** whole-file hash of every source a case or an ignore names */
    sources: Record<string, { sha256: string }>;
    ignored: Ignored[];
}

export interface RevisionRow {
    rev: number;
    at: string;
    why: string;
    by: By;
    added: string[];
    updated: string[];
    retired: string[];
    restored: string[];
    /** cases whose input, rubric or expected changed */
    restarted: string[];
}

export const anchorText = (anchor: Anchor | undefined): string =>
    anchor?.heading ? anchor.heading.join(' > ') : (anchor?.pointer ?? '(whole file)');

export const sameAnchor = (a: Anchor | undefined, b: Anchor | undefined): boolean =>
    anchorText(a) === anchorText(b);
