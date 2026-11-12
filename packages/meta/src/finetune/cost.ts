import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type ProjectReport, validateProject } from '../host.ts';
import type { Config } from './tuning.ts';

// ---------------------------------------------------------------------------
// What the agents read, in bytes
//
// An agent pays for its house rules, its prompt, the skills it preloads and one
// index line per skill it can see on every call it makes. A skill's body is
// paid only once it is loaded, so it is counted apart: moving a procedure out
// of a prompt into a skill is then a saving, not a wash.
// ---------------------------------------------------------------------------

export interface Cost {
    /** per agent: house rules, prompt, preloaded skills, skill index lines */
    alwaysRead: Record<string, number>;
    /** `alwaysRead` summed over the agents */
    total: number;
    /** per skill: its SKILL.md */
    skills: Record<string, number>;
    /** per agent: the skills it can see */
    visible: Record<string, number>;
    /** every markdown file under agents/ */
    files: Record<string, number>;
}

export interface Limits {
    /** bytes one apply may add to `total` */
    budget: number;
    /** above this `total`, an apply may add nothing */
    ceiling: number;
    skillCap: number;
    maxSkills: number;
}

/** `gate.json` in an apply's folder: what its budget gate compares against, kept for `finetune gate`. */
export interface Gate {
    before: Cost;
    limits: Limits;
}

export async function measure(root: string): Promise<Cost> {
    return costOf(root, await validateProject({ dir: root }));
}

export interface Binding {
    discovery: string;
    allow?: string[];
    preload?: string[];
}

/** No `skills:` key is the whole catalog as an index, the same as the runtime. */
export const bindingOf = (a: ProjectReport['agents'][number]): Binding =>
    a.skills ?? { discovery: 'index' };

/** The skills a binding lets its agent load. */
export const visibleTo = <S extends { name: string }>(b: Binding, entries: S[]): S[] =>
    entries.filter((s) => !b.allow || b.allow.includes(s.name));

function size(root: string, rel: string): number {
    try {
        return statSync(join(root, rel)).size;
    } catch {
        return 0;
    }
}

export function costOf(root: string, report: ProjectReport): Cost {
    const entries = report.skills.entries;
    const skills = Object.fromEntries(entries.map((s) => [s.name, size(root, s.path)]));
    const alwaysRead: Record<string, number> = {};
    const visible: Record<string, number> = {};
    for (const a of report.agents) {
        const binding = bindingOf(a);
        const seen = visibleTo(binding, entries);
        const index =
            binding.discovery === 'index'
                ? seen.reduce((n, s) => n + Buffer.byteLength(`- ${s.name}: ${s.description}\n`), 0)
                : 0;
        const preloaded = (binding.preload ?? []).reduce((n, s) => n + (skills[s] ?? 0), 0);
        alwaysRead[a.name] =
            a.instructions.reduce((n, rel) => n + size(root, rel), 0) + preloaded + index;
        visible[a.name] = seen.length;
    }
    const total = Object.values(alwaysRead).reduce((n, b) => n + b, 0);
    return { alwaysRead, total, skills, visible, files: markdown(root) };
}

function markdown(root: string): Record<string, number> {
    const out: Record<string, number> = {};
    let names: string[] = [];
    try {
        names = readdirSync(join(root, 'agents'), { recursive: true }) as string[];
    } catch {
        return out;
    }
    for (const name of names.sort()) {
        if (name.endsWith('.md')) {
            const rel = join('agents', name).split('\\').join('/');
            out[rel] = size(root, rel);
        }
    }
    return out;
}

export function limits(start: Cost, c: Config): Limits {
    return {
        budget: c.budget,
        // A project that starts nearly empty still gets one apply's worth of room.
        ceiling: Math.max(
            start.total + c.budget,
            Math.round(start.total * (1 + c.maxGrowth / 100)),
        ),
        skillCap: c.skillCap,
        maxSkills: c.maxSkills,
    };
}

/** Every limit an edit broke, said so the next attempt can act on it; empty when none. */
export function overLimits(before: Cost, after: Cost, l: Limits): string[] {
    const out: string[] = [];
    const grew = after.total - before.total;
    if (grew > l.budget) {
        out.push(
            `what the agents always read grew by ${grew} bytes (${before.total} -> ${after.total}), over the budget of ${l.budget}`,
        );
    }
    if (grew > 0 && after.total > l.ceiling) {
        out.push(
            `what the agents always read is ${after.total} bytes, over the ceiling of ${l.ceiling}: past it an apply may add nothing - cut, move or extract to make room`,
        );
    }
    for (const [name, bytes] of Object.entries(after.skills)) {
        if (bytes > l.skillCap && bytes > (before.skills[name] ?? 0)) {
            out.push(
                `skill ${name} holds ${bytes} bytes, over the cap of ${l.skillCap}: split it by when each part is needed`,
            );
        }
    }
    for (const [agent, n] of Object.entries(after.visible)) {
        if (n > l.maxSkills && n > (before.visible[agent] ?? 0)) {
            out.push(
                `agent ${agent} sees ${n} skills, over ${l.maxSkills}: merge skills whose descriptions overlap`,
            );
        }
    }
    return out;
}

/** What moved between two measures, per agent, skill and file - for a person and the next attempt. */
export function costChanges(before: Cost, after: Cost): string[] {
    const rows: string[] = [];
    const diff = (label: string, a: Record<string, number>, b: Record<string, number>): void => {
        for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
            const was = a[key] ?? 0;
            const now = b[key] ?? 0;
            if (was !== now) {
                rows.push(
                    `| ${label} | ${key} | ${was} | ${now} | ${now - was > 0 ? '+' : ''}${now - was} |`,
                );
            }
        }
    };
    diff('always read', before.alwaysRead, after.alwaysRead);
    diff('skill', before.skills, after.skills);
    diff('file', before.files, after.files);
    return rows.length > 0
        ? ['| What | Name | Before | After | Change |', '| --- | --- | --- | --- | --- |', ...rows]
        : [];
}
