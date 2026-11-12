import { existsSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { invalidError } from '../../host.ts';
import {
    type Anchor,
    CASE_ID,
    COMPLEXITIES,
    type Complexity,
    type Input,
    MEDIA_KINDS,
    type Part,
} from './types.ts';

// ---------------------------------------------------------------------------
// Reading a proposal
//
// A proposal is what an extraction produced: every case it read, in the shape
// the old `finetune/dataset.json` had, so that file imports as it stands. It is
// checked whole before anything is written, and every problem is reported at
// once — a model fixing one issue per round trip is a slow way to learn that
// there were nine.
// ---------------------------------------------------------------------------

export interface ProposedRubric {
    id?: string;
    text: string;
}

export interface Proposed {
    id: string;
    class?: string;
    complexity?: Complexity;
    tags?: string[];
    input: Input;
    rubric: ProposedRubric[];
    expected?: string;
    notes?: string;
    source?: { file: string; anchor?: Anchor };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

/** A url, a data uri: anything with a scheme is not a path to rebase. */
const URL_LIKE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * `{ heading: "A > B" }`, `{ heading: ["A", "B"] }`, `{ pointer: "/x/0" }`, or
 * nothing for the whole file.
 */
export function readAnchor(raw: unknown, where: string, issues: string[]): Anchor | undefined {
    if (raw === undefined || raw === null) {
        return undefined;
    }
    if (!isObject(raw)) {
        issues.push(`${where}: anchor must be an object`);
        return undefined;
    }
    if (raw.heading !== undefined && raw.pointer !== undefined) {
        issues.push(`${where}: anchor names both a heading and a pointer`);
        return undefined;
    }
    if (raw.heading !== undefined) {
        const path =
            typeof raw.heading === 'string'
                ? raw.heading.split(' > ')
                : Array.isArray(raw.heading) && raw.heading.every((h) => typeof h === 'string')
                  ? (raw.heading as string[])
                  : undefined;
        const clean = path?.map((h) => h.trim()).filter(Boolean);
        if (!clean || clean.length === 0) {
            issues.push(`${where}: anchor.heading must be a heading or a list of them`);
            return undefined;
        }
        return { heading: clean };
    }
    if (raw.pointer !== undefined) {
        if (
            typeof raw.pointer !== 'string' ||
            !(raw.pointer === '' || raw.pointer.startsWith('/'))
        ) {
            issues.push(`${where}: anchor.pointer must be a JSON pointer like /cases/0`);
            return undefined;
        }
        return { pointer: raw.pointer };
    }
    return undefined;
}

/** Inside the project: relative to it. Outside: absolute. */
export function projectPath(root: string, absolute: string): string {
    const rel = relative(root, absolute);
    return rel.startsWith('..') || isAbsolute(rel) ? absolute : rel.split(sep).join('/');
}

function readInput(
    raw: unknown,
    where: string,
    base: string,
    root: string,
    issues: string[],
): Input | undefined {
    if (typeof raw === 'string') {
        return raw.trim() ? raw : (issues.push(`${where}: input is empty`), undefined);
    }
    if (!Array.isArray(raw) || raw.length === 0) {
        issues.push(`${where}: input must be a string or a non-empty list of parts`);
        return undefined;
    }
    const parts: Part[] = [];
    raw.forEach((part, i) => {
        if (typeof part === 'string') {
            parts.push(part);
            return;
        }
        if (isObject(part) && typeof part.text === 'string') {
            parts.push({ text: part.text });
            return;
        }
        const kind = MEDIA_KINDS.find((k) => isObject(part) && typeof part[k] === 'string');
        if (!kind || !isObject(part)) {
            issues.push(`${where}: input[${i}] is neither text nor ${MEDIA_KINDS.join('/')}`);
            return;
        }
        const ref = part[kind] as string;
        let stored = ref;
        if (!URL_LIKE.test(ref)) {
            const at = resolve(base, ref);
            if (!existsSync(at)) {
                issues.push(`${where}: input[${i}] ${kind} ${ref} does not exist`);
            }
            stored = projectPath(root, at);
        }
        parts.push({
            [kind]: stored,
            ...(typeof part.mimeType === 'string' ? { mimeType: part.mimeType } : {}),
        });
    });
    return parts;
}

function readOne(
    raw: unknown,
    index: number,
    base: string,
    root: string,
    issues: string[],
): Proposed | undefined {
    if (!isObject(raw)) {
        issues.push(`case ${index}: not an object`);
        return undefined;
    }
    const id = raw.id;
    if (typeof id !== 'string' || !CASE_ID.test(id) || id === '.' || id === '..') {
        issues.push(`case ${index}: id must be letters, digits, dot, dash or underscore`);
        return undefined;
    }
    const where = id;
    const input = readInput(raw.input, where, base, root, issues);

    const rubric: ProposedRubric[] = [];
    if (raw.rubric !== undefined) {
        if (!Array.isArray(raw.rubric)) {
            issues.push(`${where}: rubric must be a list`);
        } else {
            raw.rubric.forEach((item, i) => {
                if (typeof item === 'string' && item.trim()) {
                    rubric.push({ text: item });
                } else if (isObject(item) && typeof item.text === 'string' && item.text.trim()) {
                    rubric.push({
                        text: item.text,
                        ...(typeof item.id === 'string' ? { id: item.id } : {}),
                    });
                } else {
                    issues.push(`${where}: rubric[${i}] is not a line of text`);
                }
            });
        }
    }

    let complexity: Complexity | undefined;
    if (raw.complexity !== undefined) {
        if (COMPLEXITIES.includes(raw.complexity as Complexity)) {
            complexity = raw.complexity as Complexity;
        } else {
            issues.push(`${where}: complexity must be one of ${COMPLEXITIES.join(', ')}`);
        }
    }
    const text = (key: string): string | undefined => {
        const v = raw[key];
        if (v === undefined || v === null) {
            return undefined;
        }
        if (typeof v !== 'string') {
            issues.push(`${where}: ${key} must be a string`);
            return undefined;
        }
        return v;
    };
    let tags: string[] | undefined;
    if (raw.tags !== undefined) {
        if (Array.isArray(raw.tags) && raw.tags.every((t) => typeof t === 'string' && t.trim())) {
            tags = [...new Set((raw.tags as string[]).map((t) => t.trim()))];
        } else {
            issues.push(`${where}: tags must be a list of words`);
        }
    }

    let source: Proposed['source'];
    const rawSource = typeof raw.source === 'string' ? { file: raw.source } : raw.source;
    if (rawSource !== undefined) {
        if (!isObject(rawSource) || typeof rawSource.file !== 'string' || !rawSource.file) {
            issues.push(`${where}: source must name a file`);
        } else {
            const at = resolve(root, rawSource.file);
            if (!existsSync(at)) {
                issues.push(`${where}: source ${rawSource.file} does not exist`);
            }
            source = {
                file: projectPath(root, at),
                ...(rawSource.anchor !== undefined
                    ? { anchor: readAnchor(rawSource.anchor, where, issues) }
                    : {}),
            };
        }
    }

    if (!input) {
        return undefined;
    }
    const cls = text('class');
    const expected = text('expected');
    const notes = text('notes');
    return {
        id,
        ...(cls ? { class: cls } : {}),
        ...(complexity ? { complexity } : {}),
        ...(tags && tags.length > 0 ? { tags } : {}),
        input,
        rubric,
        ...(expected ? { expected } : {}),
        ...(notes ? { notes } : {}),
        ...(source ? { source } : {}),
    };
}

/**
 * Every case in a proposal, or a thrown list of what is wrong with it. Media
 * paths resolve against the proposal file, the way `zen run batch` resolves
 * them against its input, and are kept relative to the project from then on.
 */
export function readProposal(doc: unknown, file: string, root: string): Proposed[] {
    const list = Array.isArray(doc) ? doc : isObject(doc) ? (doc.cases ?? doc.samples) : undefined;
    if (!Array.isArray(list)) {
        throw invalidError(
            `${file} holds no cases`,
            'write { "cases": [ … ] } — or a bare list of cases',
        );
    }
    const issues: string[] = [];
    const base = dirname(resolve(file));
    const cases = list.flatMap((raw, i) => readOne(raw, i, base, root, issues) ?? []);
    const seen = new Set<string>();
    for (const c of cases) {
        if (seen.has(c.id)) {
            issues.push(`${c.id}: the id appears more than once`);
        }
        seen.add(c.id);
    }
    if (issues.length > 0) {
        throw invalidError(
            `${file}: ${issues.length} problem${issues.length === 1 ? '' : 's'}\n  ${issues.join('\n  ')}`,
            'fix the proposal and apply it again; nothing was written',
        );
    }
    return cases;
}
