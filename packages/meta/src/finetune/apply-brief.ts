import { globSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { type ProjectReport, SHARED_RULES, validateProject } from '../host.ts';
import {
    type Brief,
    files,
    type Maybe,
    oneLine,
    PHASE_WORD,
    renderBrief,
    skillIndex,
    type Step,
} from './brief.ts';
import { type Feedback, forProse, type Improvement, lead } from './feedback.ts';
import type { Deferred } from './improvements.ts';
import { readJson, type Tuning } from './tuning.ts';

// ---------------------------------------------------------------------------
// The brief an apply starts from
//
// What /zen-finetune-apply would otherwise spend its first dozen calls on, done by
// the loop: the requests and the held-back improvements grouped by the file
// they name, the editor skills this project needs, what earlier tries of the
// same cases asked for and what became of it, the budget, and the files to
// edit as they are now. Same engine and limits as the analysis brief (brief.ts).
// ---------------------------------------------------------------------------

/** One entry of inputs.json. */
export type Request = Feedback & { file: string; missedSkills?: string[] };

export interface ApplyBrief extends Brief {
    dir: string;
    attempt: number;
    inputs: Request[];
    deferred: Deferred[];
}

const NO_FILE = '(no file named)';
const EARLIER_PER_CASE = 3;
const TARGET_MAX = 40_000;

const clip = (s: string, n: number): string => {
    const line = oneLine(s);
    return line.length > n ? `${line.slice(0, n)}…` : line;
};

/** An improvement's file as a path relative to the project. */
function fileOf(b: ApplyBrief, i: Improvement): string {
    const f = i.file?.trim();
    if (!f) {
        return NO_FILE;
    }
    return (isAbsolute(f) ? relative(b.systemDir, f) : f).replace(/^\.\//, '');
}

interface Entry {
    request: string;
    case: string;
    improvement: Improvement;
    /** the apply that deferred it; absent for this batch */
    apply?: string;
}

/** Every improvement of the batch, and every deferred one, by the file it names - most cases first. */
function groups(b: ApplyBrief): { file: string; entries: Entry[]; cases: Set<string> }[] {
    const byFile = new Map<string, Entry[]>();
    const add = (file: string, e: Entry): void => {
        byFile.set(file, [...(byFile.get(file) ?? []), e]);
    };
    for (const f of b.inputs) {
        for (const i of forProse(f)) {
            add(fileOf(b, i), { request: f.id, case: f.case, improvement: i });
        }
    }
    const batch = new Set(byFile.keys());
    for (const d of b.deferred) {
        const file = fileOf(b, d.improvement);
        if (batch.has(file)) {
            add(file, {
                request: d.request,
                case: d.case,
                improvement: d.improvement,
                apply: d.apply,
            });
        }
    }
    return [...byFile.entries()]
        .map(([file, entries]) => ({ file, entries, cases: new Set(entries.map((e) => e.case)) }))
        .sort((x, y) => y.cases.size - x.cases.size || x.file.localeCompare(y.file));
}

/** The files this batch asks to change that exist and an apply may edit. */
function targets(b: ApplyBrief): string[] {
    return groups(b)
        .map((g) => g.file)
        .filter(
            (f) =>
                f.startsWith('agents/') &&
                !SHARED_RULES.includes(f) &&
                exists(join(b.systemDir, f)),
        );
}

/** The editor skills this project's capabilities call for, each with why. */
export function editorSkills(root: string, inputs: { phase: string }[]): [string, string][] {
    let yaml = '';
    try {
        yaml = readFileSync(join(root, 'agents.yaml'), 'utf8');
    } catch {
        // No agents.yaml: only the always-on skill applies.
    }
    let prose = '';
    for (const f of globSync('agents/**/*', { cwd: root })) {
        if (exists(join(root, f))) {
            prose += `${readFileSync(join(root, f), 'utf8')}\n`;
        }
    }
    const out: [string, string][] = [['zen-instructions', 'every apply']];
    if (/^\s*memory:/m.test(yaml)) {
        out.push(['zen-memory', '`memory:` in agents.yaml']);
    } else if (inputs.some((f) => f.phase === 'mem')) {
        out.push(['zen-memory', 'a request comes from a run with memory']);
    }
    if (/docs:/.test(yaml) || prose.includes('zen rag docs')) {
        out.push(['zen-rag-docs', 'a docs index, or `zen rag docs` in agents/']);
    }
    if (/schema:/.test(yaml) || prose.includes('zen rag schema')) {
        out.push(['zen-rag-schema', 'a schema index, or `zen rag schema` in agents/']);
    }
    if (/^\s*(handoffs|fork):/m.test(yaml)) {
        out.push(['zen-topology', '`handoffs:` or `fork:` in agents.yaml']);
    }
    if (prose.includes('run_command')) {
        out.push(['zen-code-python', '`run_command` in agents/']);
    }
    return out;
}

function skillsToLoad(b: ApplyBrief): string {
    return editorSkills(b.systemDir, b.inputs)
        .map(([name, why]) => `- \`${name}\` - ${why}`)
        .join('\n');
}

function byFile(b: ApplyBrief): Maybe<string> {
    // Held-back rows are evidence to count, not text to apply: clipped, whole in deferred.json.
    const cell = (e: Entry, s: string | undefined, n: number): string =>
        !s ? '-' : e.apply ? clip(s, n) : oneLine(s);
    return groups(b)
        .map((g) => {
            const rows = g.entries.map(
                (e) =>
                    `| ${e.request} | ${e.improvement.id} | ${e.improvement.kind ?? '-'} | ${cell(e, e.improvement.change, 300)} | ${cell(e, e.improvement.why, 160)} | ${e.apply ? '-' : cell(e, e.improvement.expect, 0)} | ${e.apply ? `deferred by ${e.apply}` : 'this batch'} |`,
            );
            return [
                `#### ${g.file} - ${g.cases.size} case(s): ${[...g.cases].join(', ')}`,
                '',
                '| Request | # | Kind | Change | Why | Expect | From |',
                '| --- | --- | --- | --- | --- | --- | --- |',
                ...rows,
                '',
            ].join('\n');
        })
        .join('\n');
}

function requests(b: ApplyBrief): Maybe<string> {
    return b.inputs
        .map((f) =>
            [
                `- \`${f.id}\` - ${PHASE_WORD[f.phase]}, try ${f.attempt}, ${f.verdict}`,
                f.recheck ? `, a regression after apply ${f.recheck}` : '',
                f.missedSkills?.length
                    ? `, never loaded: ${f.missedSkills.map((s) => `\`${s}\``).join(', ')}`
                    : '',
                `. ${clip(lead(f.summary), 400)} Analysis: \`${join(dirname(f.file), 'analysis.md')}\``,
            ].join(''),
        )
        .join('\n');
}

/** What earlier requests of these cases asked for, and what each apply decided. */
function earlier(b: ApplyBrief): Maybe<string> {
    const name = basename(b.dir);
    const decided = b.t.improvements.decisions();
    const past = b.t.improvements.applies().filter((a) => a.name !== name);
    const now = new Set(b.inputs.map((f) => f.id));
    const sections: string[] = [];
    for (const c of [...new Set(b.inputs.map((f) => f.case))]) {
        const mine = past
            .flatMap((a) => (a.inputs ?? []).map((f) => ({ f, apply: a })))
            .filter(({ f }) => f.case === c && !now.has(f.id))
            .slice(-EARLIER_PER_CASE);
        if (mine.length === 0) {
            continue;
        }
        const lines = mine.flatMap(({ f, apply }) => {
            const wrote = readJson(join(apply.dir, 'decisions.json')) !== undefined;
            return forProse(f).map((i) => {
                const d = decided[f.id]?.[i.id];
                const what = d?.decision
                    ? `${d.decision}${d.disposition ? ` (${d.disposition})` : ''}${d.note ? `: ${clip(d.note, 120)}` : ''}`
                    : wrote
                      ? 'no decision'
                      : `no decision - apply ${apply.name} wrote none`;
                return `- \`${f.id}\` ${i.id}, apply ${apply.name}, ${fileOf(b, i)}: ${clip(i.change, 160)} → ${what}`;
            });
        });
        sections.push([`#### ${c}`, '', ...lines, ''].join('\n'));
    }
    return sections.join('\n');
}

interface Growth {
    file: string;
    start: number;
    now: number;
    changes: number;
    recent: string[];
}

function growth(b: ApplyBrief): Maybe<string> {
    const rows = readJson<Growth[]>(join(b.dir, 'growth.json')) ?? [];
    if (rows.length === 0) {
        return undefined;
    }
    return [
        `The ${Math.min(8, rows.length)} files that grew most since the tuning began (all in \`${join(b.dir, 'growth.json')}\`):`,
        '',
        '| File | Bytes at start | Now | Applies that changed it | Latest |',
        '| --- | --- | --- | --- | --- |',
        ...rows
            .slice(0, 8)
            .map(
                (r) =>
                    `| ${r.file} | ${r.start} | ${r.now} | ${r.changes} | ${r.recent.join(', ') || '-'} |`,
            ),
    ].join('\n');
}

function otherDeferred(b: ApplyBrief): Maybe<string> {
    const shown = new Set(groups(b).map((g) => g.file));
    return b.deferred
        .filter((d) => !shown.has(fileOf(b, d.improvement)))
        .map(
            (d) =>
                `- \`${d.request}\` ${d.improvement.id} (apply ${d.apply}), ${fileOf(b, d.improvement)}: ${clip(d.improvement.change, 160)}`,
        )
        .join('\n');
}

export const APPLY_BRIEF: Step<ApplyBrief>[] = [
    {
        cat: (b) =>
            b.attempt > 1
                ? ['check.log', 'budget.md', 'missing.md'].map((f) => join(b.dir, f)).filter(exists)
                : undefined,
        max: 6000,
    },
    { title: 'Skills to load', fn: skillsToLoad },
    { title: 'Requests by file', fn: byFile, max: 40_000 },
    { title: 'The requests', fn: requests },
    // The files to edit before the history: an edit needs them, the history only informs it.
    { cat: (b) => targets(b), max: TARGET_MAX },
    { title: 'Earlier tries of these cases', fn: earlier },
    { cat: (b) => [join(b.dir, 'budget.json')] },
    { title: 'Growth', fn: growth },
    { title: 'Skills: which agent can load which, and the index', fn: skillIndex },
    {
        cat: (b) =>
            files(b, 'agents/*instructions.md').filter(
                (f) => !SHARED_RULES.includes(f) && !targets(b).includes(f),
            ),
    },
    { cat: () => ['agents.yaml'] },
    { title: 'Improvements held back for files this batch does not touch', fn: otherDeferred },
];

function exists(file: string): boolean {
    try {
        return statSync(file).isFile();
    } catch {
        return false;
    }
}

/** Improvement ids each request still needs a decision for, as `id: i1, i2`. */
function due(b: ApplyBrief): string {
    return b.inputs
        .filter((f) => forProse(f).length > 0)
        .map(
            (f) =>
                `  - \`${f.id}\`: ${forProse(f)
                    .map((i) => i.id)
                    .join(', ')}`,
        )
        .join('\n');
}

/** Writes `brief.md` into the apply's folder, for this attempt; returns its path. */
export async function writeApplyBrief(t: Tuning, dir: string, attempt: number): Promise<string> {
    let report: Promise<ProjectReport | undefined> | undefined;
    const b: ApplyBrief = {
        t,
        dir,
        attempt,
        systemDir: t.root,
        project: () => (report ??= validateProject({ dir: t.root }).catch(() => undefined)),
        inputs: readJson<Request[]>(join(dir, 'inputs.json')) ?? [],
        deferred: readJson<Deferred[]>(join(dir, 'deferred.json')) ?? [],
    };
    const lead = [
        `This is apply ${basename(dir)}, attempt ${attempt}${attempt > 1 ? ' - the previous one was undone, its reasons are the first files below' : ''}. The project files below are as they are now, before your edits.\n`,
        [
            'Where to write - the folder exists, so no `mkdir` and no `test -f`:',
            '',
            `- \`${join(dir, 'changes.md')}\` and \`${join(dir, 'decisions.json')}\`, not written yet - write each in one call`,
            '- `decisions.json` needs a decision for every one of these:',
            due(b),
            `- when the edits are done: \`zen meta finetune gate ${dir}\``,
            '',
        ].join('\n'),
    ];
    const file = join(dir, 'brief.md');
    writeFileSync(file, await renderBrief(b, join(dir, 'brief.log'), APPLY_BRIEF, lead));
    return file;
}
