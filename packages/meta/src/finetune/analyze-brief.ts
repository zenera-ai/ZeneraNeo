import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ProjectReport, SHARED_RULES, validateProject } from '../host.ts';
import {
    type Brief,
    cut,
    files,
    type Maybe,
    oneLine,
    PHASE_WORD,
    renderBrief,
    skillIndex,
    type Step,
    STEP_MAX,
    word,
} from './brief.ts';
import type { Case } from './dataset/types.ts';
import { feedbackId, type Phase } from './feedback.ts';
import { type Attempt, fence, rubricScore, since } from './report.ts';
import type { Run } from './train.ts';
import type { Tuning } from './tuning.ts';

// ---------------------------------------------------------------------------
// The brief an analysis starts from
//
// Before /analyze starts, the loop runs the commands every analysis would run
// first anyway - the case, the graph, the run's files, the project's agents
// and prompts - and hands their output over in the prompt (`brief.md`, sent
// with `zen meta run --prompt-file`), so the agent spends no call on them.
//
// `b.systemDir` is the copy of agents.yaml and agents/ the run read - the
// system version it ran on, under finetune/systems/vNN/ - so an apply made
// since cannot change what the analysis sees. Anything else (the run's
// folder, a recheck's patch) is named by an absolute path: `b.run.dir`,
// `b.recheck`.
// ---------------------------------------------------------------------------

export interface AnalyzeBrief extends Brief {
    run: Run;
    case: Case;
    phase: Phase;
    attempt: number;
    /** earlier tries of this case revision, oldest first */
    earlier: Attempt[];
    /** the patch a recheck checks */
    recheck?: string;
    /** skills an apply made for this case that the run never loaded */
    missed?: string[];
    /** the try's folder: brief.md, feedback.json and ask/ live here */
    dir: string;
}

export const ANALYZE_BRIEF: Step<AnalyzeBrief>[] = [
    { zen: (b) => ['meta', 'dataset', 'show', `${b.case.id}@${b.case.rev}`, '--json'] },
    { sh: () => "grep -nE 'memory:|handoffs:|fork:' agents.yaml" },
    { zen: (b) => ['inspect', 'graph', '--dir', b.run.dir, '--no-style'] },
    { cat: (b) => [join(b.run.dir, 'meta.json'), join(b.run.dir, 'input.md')] },
    { cat: (b) => [join(b.run.dir, 'output.md')], max: 8000 },
    { title: 'Earlier tries of this case', fn: earlierTries },
    // It cuts the diff itself, inside its fence.
    {
        title: 'What changed in agents.yaml and agents/ since the last try',
        fn: systemDiff,
        max: Infinity,
    },
    { cat: (b) => (b.recheck ? [b.recheck] : undefined) },
    { title: 'Skills an apply made for this case, never loaded by this run', fn: missedSkills },
    { cat: () => ['agents.yaml'] },
    {
        cat: (b) => files(b, 'agents/*instructions.md').filter((f) => !SHARED_RULES.includes(f)),
    },
    { title: 'Skills: which agent can load which, and the index', fn: skillIndex },
    // Last: the largest, and the agent can read a left-out prompt itself.
    { cat: (b) => files(b, 'agents/prompts/*.md'), max: 40_000 },
];

/** The analysis brief as markdown. */
export async function renderAnalyzeBrief(
    b: AnalyzeBrief,
    log: string,
    steps = ANALYZE_BRIEF,
): Promise<string> {
    return renderBrief(b, log, steps, [
        `The run is \`${b.run.dir}\`, on system v${b.run.system}: the project files below are as that version had them.\n`,
        [
            'Where to write - both folders exist, so no `mkdir` and no `test -f`:',
            '',
            `- each question for \`zen inspect ask\`: \`${join(b.dir, 'ask')}/<node>-<topic>.md\``,
            `- the feedback file: \`${join(b.dir, 'feedback.json')}\`, not written yet - write it in one call`,
            '',
        ].join('\n'),
    ]);
}

/** Writes `brief.md` into the try's folder; the path is what `--prompt-file` takes. */
export async function writeAnalyzeBrief(
    t: Tuning,
    dir: string,
    at: Omit<AnalyzeBrief, 't' | 'systemDir' | 'project' | 'dir'>,
): Promise<string> {
    mkdirSync(join(dir, 'ask'), { recursive: true });
    const snapshot = t.system.snapshotDir(at.run.system);
    const systemDir = existsSync(snapshot) ? snapshot : t.root;
    let report: Promise<ProjectReport | undefined> | undefined;
    const b: AnalyzeBrief = {
        ...at,
        t,
        dir,
        systemDir,
        project: () =>
            (report ??= validateProject({ dir: systemDir })
                .catch(() => validateProject({ dir: t.root }))
                .catch(() => undefined)),
    };
    const file = join(dir, 'brief.md');
    writeFileSync(file, await renderAnalyzeBrief(b, join(dir, 'brief.log')));
    return file;
}

// ---------------------------------------------------------------------------
// The computed sections
// ---------------------------------------------------------------------------

function earlierTries(b: AnalyzeBrief): Maybe<string> {
    const decided = b.t.improvements.decisions();
    const round = b.t.round(b.case);
    return b.earlier
        .filter((a) => a.feedback)
        .map((a) => {
            const f = a.feedback!;
            const id = feedbackId(b.case.id, a.phase, a.attempt, round);
            const cost = a.run
                ? `, v${a.run.system}, ${a.run.turns ?? '?'} LLM calls, ${since(a.run.durationMs ?? 0)}`
                : '';
            const rows = f.improvements.map((i) => {
                const d = decided[id]?.[i.id];
                const decision = d?.decision
                    ? `${d.decision}${d.note ? `: ${d.note}` : ''}`
                    : 'not applied yet';
                return `| ${i.id} | ${oneLine(i.change)} | ${oneLine(i.file ?? '-')} | ${oneLine(decision)} |`;
            });
            return [
                `#### ${PHASE_WORD[a.phase]}, try ${a.attempt} - ${f.verdict}, rubric ${rubricScore(f)}${f.done ? ', done' : ''}${cost}`,
                '',
                ...f.summary
                    .trim()
                    .split('\n')
                    .map((l) => (l.trim() ? `> ${l}` : '>')),
                '',
                ...(rows.length > 0
                    ? ['| # | Change | File | Decision |', '| --- | --- | --- | --- |', ...rows, '']
                    : []),
            ].join('\n');
        })
        .join('\n');
}

function systemDiff(b: AnalyzeBrief): Maybe<string> {
    const last = [...b.earlier].reverse().find((a) => a.run);
    if (!last?.run || last.run.system === b.run.system) {
        return undefined;
    }
    const diff = b.t.system.diff(last.run.system, b.run.system).trim();
    if (!diff) {
        return undefined;
    }
    const pad = (v: number): string => `v${String(v).padStart(2, '0')}`;
    const { body, note } = cut(
        diff,
        STEP_MAX,
        `the whole diff: git -C ${word(b.t.system.dir)} diff --no-index ${pad(last.run.system)} ${pad(b.run.system)}`,
    );
    const tick = fence(body);
    return [
        `From v${last.run.system} (${PHASE_WORD[last.phase]}, try ${last.attempt}) to v${b.run.system} (this run):`,
        '',
        `${tick}diff`,
        body,
        tick,
        ...(note ? [note] : []),
    ].join('\n');
}

async function missedSkills(b: AnalyzeBrief): Promise<Maybe<string>> {
    if (!b.missed?.length) {
        return undefined;
    }
    const entries = (await b.project())?.skills.entries ?? [];
    return b.missed
        .map((name) => {
            const s = entries.find((e) => e.name === name);
            return `- \`${name}\`: ${s ? s.description : '(no such skill in this version)'}`;
        })
        .join('\n');
}
