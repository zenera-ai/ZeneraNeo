import type { Matcher } from '@zenera/neo';
import { usageError } from '../../host.ts';
import {
    anchorText,
    type Case,
    COMPLEXITIES,
    type NoteKind,
    type NoteRow,
    type Verdict,
} from './types.ts';

// ---------------------------------------------------------------------------
// Drawing cases by criteria
//
// Filters decide which cases are eligible. Then the whole draw is laid out in
// order before anything is cut: cases are grouped into strata, each stratum is
// ordered by priority with ties broken by a seeded shuffle, and the strata take
// turns by smooth weighted round-robin. Cutting that list at `n` is what makes a
// sample prefix-stable — asking for ten after asking for five keeps the five.
//
// Only notes written against a case's current revision count: a verdict on an
// older rubric is about a different question.
// ---------------------------------------------------------------------------

export interface Criteria {
    status: 'active' | 'retired' | 'all';
    classes?: string[];
    complexities?: string[];
    tags?: string[];
    rubric?: boolean;
    expected?: boolean;
    ids?: Matcher;
    exclude?: Matcher;
    idsFrom?: ReadonlySet<string>;
    changedSince?: number;
    restarted?: ReadonlySet<string>;
    verdicts?: Verdict[];
    neverGraded?: boolean;
    noteKinds?: NoteKind[];
    gradedIn?: string[];
    source?: Matcher;
    anchor?: Matcher;
    grep?: Matcher;
}

export const STRATA_FIELDS = ['class', 'complexity', 'tag', 'source', 'rubric', 'verdict'] as const;
export type StratumField = (typeof STRATA_FIELDS)[number];

export const ORDER_KEYS = ['rubric', 'complexity', 'verdict', 'rev', 'id'] as const;
export type OrderKey = (typeof ORDER_KEYS)[number];

export interface Draw {
    by: StratumField[];
    weights: ReadonlyMap<string, number>;
    order: OrderKey[];
    count?: number;
    seed: number;
}

export interface Stratum {
    key: string;
    weight: number;
    available: number;
    chosen: number;
}

export interface Sampled {
    ids: string[];
    strata: Stratum[];
    /** cases that passed the filters */
    matched: number;
}

export type NotesOf = (c: Case) => readonly NoteRow[];

/** Notes about this revision of the case, oldest first. */
const current = (c: Case, notes: NotesOf): NoteRow[] => notes(c).filter((n) => n.caseRev === c.rev);

export function lastVerdict(c: Case, notes: NotesOf): Verdict | undefined {
    return current(c, notes).findLast((n) => n.verdict)?.verdict;
}

const textOf = (c: Case): string =>
    [
        typeof c.input === 'string'
            ? c.input
            : c.input
                  .map((p) => (typeof p === 'string' ? p : 'text' in p ? p.text : ''))
                  .join('\n'),
        ...c.rubric.map((r) => r.text),
    ].join('\n');

export function matches(c: Case, k: Criteria, notes: NotesOf): boolean {
    if (k.status !== 'all' && c.status !== k.status) {
        return false;
    }
    if (k.classes && !k.classes.includes(c.class ?? 'unclassified')) {
        return false;
    }
    if (k.complexities && !k.complexities.includes(c.complexity ?? 'unrated')) {
        return false;
    }
    if (k.tags && !(c.tags ?? []).some((t) => k.tags!.includes(t))) {
        return false;
    }
    if (k.rubric !== undefined && k.rubric !== c.rubric.length > 0) {
        return false;
    }
    if (k.expected !== undefined && k.expected !== (c.expected !== undefined)) {
        return false;
    }
    if (k.ids && !k.ids(c.id)) {
        return false;
    }
    if (k.exclude?.(c.id)) {
        return false;
    }
    if (k.idsFrom && !k.idsFrom.has(c.id)) {
        return false;
    }
    if (k.changedSince !== undefined && c.rev <= k.changedSince) {
        return false;
    }
    if (k.restarted && !k.restarted.has(c.id)) {
        return false;
    }
    if (k.source && !(c.source && k.source(c.source.file))) {
        return false;
    }
    if (k.anchor && !(c.source && k.anchor(anchorText(c.source.anchor)))) {
        return false;
    }
    if (k.grep && !k.grep(textOf(c))) {
        return false;
    }
    if (k.verdicts || k.neverGraded || k.noteKinds || k.gradedIn) {
        const mine = current(c, notes);
        const verdict = mine.findLast((n) => n.verdict)?.verdict;
        if (k.verdicts && !(verdict && k.verdicts.includes(verdict))) {
            return false;
        }
        if (k.neverGraded && mine.some((n) => n.kind === 'graded' || n.verdict)) {
            return false;
        }
        if (k.noteKinds && !mine.some((n) => k.noteKinds!.includes(n.kind))) {
            return false;
        }
        if (k.gradedIn && !mine.some((n) => n.run !== undefined && k.gradedIn!.includes(n.run))) {
            return false;
        }
    }
    return true;
}

function stratumValue(c: Case, field: StratumField, notes: NotesOf): string {
    switch (field) {
        case 'class':
            return c.class ?? 'unclassified';
        case 'complexity':
            return c.complexity ?? 'unrated';
        case 'tag':
            return c.tags?.length ? [...c.tags].sort().join(',') : 'untagged';
        case 'source':
            return c.source?.file ?? 'no source';
        case 'rubric':
            return c.rubric.length > 0 ? 'rubric' : 'no rubric';
        case 'verdict':
            return lastVerdict(c, notes) ?? 'ungraded';
    }
}

const COMPLEX_RANK: Record<string, number> = { complex: 0, medium: 1, simple: 2 };
const VERDICT_RANK: Record<string, number> = { wrong: 0, void: 1, right: 3 };

function rank(c: Case, key: OrderKey, notes: NotesOf): number | string {
    switch (key) {
        case 'rubric':
            return c.rubric.length > 0 ? 0 : 1;
        case 'complexity':
            return COMPLEX_RANK[c.complexity ?? ''] ?? COMPLEXITIES.length;
        case 'verdict':
            return VERDICT_RANK[lastVerdict(c, notes) ?? ''] ?? 2;
        case 'rev':
            return -c.rev;
        case 'id':
            return c.id;
    }
}

/** Lehmer / Park-Miller: exact in a double, so the same on every machine. */
function lehmer(seed: number): () => number {
    let s = seed % 2147483647;
    if (s <= 0) {
        s += 2147483646;
    }
    return () => {
        s = (s * 48271) % 2147483647;
        return s;
    };
}

/** FNV-1a, so each stratum shuffles on its own and a new case elsewhere moves nothing here. */
function hash(text: string): number {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
    }
    return h;
}

function ordered(cases: readonly Case[], key: string, draw: Draw, notes: NotesOf): Case[] {
    const next = lehmer(draw.seed + hash(key));
    const shuffled = [...cases].sort((a, b) => a.id.localeCompare(b.id));
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = next() % (i + 1);
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const position = new Map(shuffled.map((c, i) => [c.id, i]));
    return shuffled.sort((a, b) => {
        for (const k of draw.order) {
            const x = rank(a, k, notes);
            const y = rank(b, k, notes);
            if (x !== y) {
                return x < y ? -1 : 1;
            }
        }
        return position.get(a.id)! - position.get(b.id)!;
    });
}

export function sample(
    cases: readonly Case[],
    criteria: Criteria,
    draw: Draw,
    notes: NotesOf,
): Sampled {
    const eligible = cases.filter((c) => matches(c, criteria, notes));
    const groups = new Map<string, Case[]>();
    for (const c of eligible) {
        const key =
            draw.by.length === 0
                ? 'all'
                : draw.by.map((f) => stratumValue(c, f, notes)).join(' · ');
        groups.set(key, [...(groups.get(key) ?? []), c]);
    }
    const unknown = [...draw.weights.keys()].filter((k) => !groups.has(k));
    if (unknown.length > 0 && eligible.length > 0) {
        throw usageError(
            `no stratum ${unknown.map((k) => `"${k}"`).join(', ')}`,
            `the strata are: ${[...groups.keys()].sort().join(', ')}`,
        );
    }

    const lanes = [...groups.keys()].sort().map((key) => ({
        key,
        weight: draw.weights.get(key) ?? 1,
        queue: ordered(groups.get(key)!, key, draw, notes),
        taken: 0,
        current: 0,
    }));
    const ids: string[] = [];
    let live = lanes.filter((l) => l.weight > 0 && l.queue.length > 0);
    const limit = draw.count ?? Infinity;
    while (live.length > 0 && ids.length < limit) {
        const total = live.reduce((sum, l) => sum + l.weight, 0);
        let best = live[0];
        for (const lane of live) {
            lane.current += lane.weight;
            if (lane.current > best.current) {
                best = lane;
            }
        }
        best.current -= total;
        ids.push(best.queue[best.taken++].id);
        live = live.filter((l) => l.taken < l.queue.length);
    }
    return {
        ids,
        matched: eligible.length,
        strata: lanes.map((l) => ({
            key: l.key,
            weight: l.weight,
            available: l.queue.length,
            chosen: l.taken,
        })),
    };
}
