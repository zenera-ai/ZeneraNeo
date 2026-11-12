import { anyOf, claimLock, ownLock, wildcard } from '@zenera/neo';
import { mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { CliError, confirm, EXIT, note, usageError } from '../host.ts';
import { DatasetStore } from './dataset/store.ts';
import type { Case } from './dataset/types.ts';
import { recover } from './journal.ts';
import { resultOf, selection } from './sampler.ts';
import type { Tuning } from './tuning.ts';
import { short, STAGES, total } from './usage.ts';

// ---------------------------------------------------------------------------
// Another round for difficult cases
//
// A case is difficult when its tries ran out on the prose of the day. The
// prose has moved on since, so `retry` gives it a fresh round on today's: the
// old tries, result and analyze session move to `rounds/r<rev>.<n>` - one
// rename, nothing deleted - and `start` runs it from the first try again.
// Completed cases are not retried: their memory is already kept and merged.
// ---------------------------------------------------------------------------

export interface RetryPick {
    /** every difficult case */
    difficult?: boolean;
    classes?: string[];
    /** ids or globs */
    ids: string[];
    yes?: boolean;
}

export interface RetryPlan {
    take: Case[];
    /** matched, but not difficult: why each is left as it is */
    skip: { id: string; why: string }[];
    /** what the cases taken spent last round, as a guide to what another will */
    tokens: number;
}

export function planRetry(t: Tuning, pick: RetryPick): RetryPlan {
    if (!pick.difficult && !pick.classes?.length && pick.ids.length === 0) {
        throw usageError(
            'retry which cases?',
            'name them (ids or globs), or --difficult for all of them, or --class <c>',
        );
    }
    const ids = anyOf(pick.ids.map((p) => wildcard(p)));
    const plan: RetryPlan = { take: [], skip: [], tokens: 0 };
    for (const c of selection(t)) {
        // Names add to --difficult; a class narrows both.
        const named = ids?.(c.id) ?? false;
        if (ids && !named && !pick.difficult) {
            continue;
        }
        if (pick.classes?.length && !pick.classes.includes(c.class ?? '')) {
            continue;
        }
        const r = resultOf(t, c);
        if (r?.state === 'difficult') {
            plan.take.push(c);
            for (const stage of STAGES) {
                const s = total(r.tokens?.[stage]);
                plan.tokens += s.input + s.output;
            }
            continue;
        }
        // Only named cases are worth a word; a class or --difficult says nothing of the rest.
        if (named) {
            plan.skip.push({
                id: c.id,
                why: !r
                    ? 'not finished yet - start carries on with it'
                    : r.state === 'failed'
                      ? 'failed, not difficult - start resumes it'
                      : 'completed - change the case to run it again',
            });
        }
    }
    return plan;
}

/** Moves each case's round aside, under the loop's lock so no tuning is writing into it. */
export async function retry(t: Tuning, pick: RetryPick): Promise<RetryPlan> {
    const plan = planRetry(t, pick);
    for (const s of plan.skip) {
        note(`${s.id}: ${s.why}`);
    }
    if (plan.take.length === 0) {
        note('nothing to retry');
        return plan;
    }
    const said = `${plan.take.length} case(s) for another round - about ${short(plan.tokens)} tokens, going by their last round`;
    if (!pick.yes && !(await confirm(`${said}. Go ahead?`))) {
        note('left as they were');
        return { ...plan, take: [] };
    }

    mkdirSync(t.dir, { recursive: true });
    const lock = join(t.dir, 'loop.lock');
    claimLock(
        lock,
        ownLock(),
        (held) =>
            new CliError(
                `a tuning is running here (pid ${held.pid})`,
                EXIT.failed,
                'stop it first: zen meta finetune stop',
            ),
    );
    try {
        // A step a kill cut off points into the very folders about to move.
        await recover(t);
        const store = DatasetStore.open(t.root);
        for (const c of plan.take) {
            const round = t.round(c);
            mkdirSync(t.roundsDir(c), { recursive: true });
            renameSync(t.caseDir(c), join(t.roundsDir(c), `r${c.rev}.${round}`));
            t.event({ what: 'retry', case: c.id, rev: c.rev, detail: `round ${round + 1}` });
            store.note(c.id, {
                type: 'note',
                at: new Date().toISOString(),
                kind: 'observation',
                caseRev: c.rev,
                text: `retried: round ${round} was difficult, round ${round + 1} starts on system v${t.system.version()}`,
                by: { prompt: 'finetune', host: hostname() },
            });
        }
    } finally {
        try {
            unlinkSync(lock);
        } catch {
            // Taken over as stale; nothing to give back.
        }
    }
    note(`${said}. Run them: zen meta finetune start`);
    return plan;
}
