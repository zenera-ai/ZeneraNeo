import { claimLock, ownLock } from '@zenera/neo';
import { mkdirSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { CliError, EXIT } from '../host.ts';
import { StepError } from './failure.ts';
import { recover } from './journal.ts';
import { publish } from './live.ts';
import type { Recheck } from './recheck.ts';
import { nextCase, resultOf } from './sampler.ts';
import { markFailed, SandboxDown, train, VoidRun } from './train.ts';
import { Stopped, type Seat, type Tuning } from './tuning.ts';

// ---------------------------------------------------------------------------
// The loop: N workers, cases started as they come free, one applier
//
// Whenever a worker is free - and no woken case is waiting for one - the next
// recheck, or else the next case, starts on it and is trained to the end. A
// parked case gives its worker back, so a lane never sits idle waiting for an
// apply. A stop never interrupts a step: it is noticed between steps, and the
// case resumes next time.
// ---------------------------------------------------------------------------

const REPORT_EVERY_MS = 15_000;
const LIVE_EVERY_MS = 1000;

export async function runLoop(t: Tuning): Promise<void> {
    mkdirSync(t.dir, { recursive: true });
    const lock = join(t.dir, 'loop.lock');
    claimLock(
        lock,
        ownLock(),
        (held) =>
            new CliError(
                `a tuning is already running here (pid ${held.pid}, since ${held.startedAt})`,
                EXIT.failed,
                `stop it with: zen meta finetune stop - or remove ${lock} if it crashed`,
            ),
    );
    rmSync(t.stopFile, { force: true });
    const timer = setInterval(() => t.report(), REPORT_EVERY_MS);
    const live = setInterval(() => {
        publish(t);
        t.report(true);
    }, LIVE_EVERY_MS);
    try {
        await recover(t);
        t.rechecks.resume();
        const start = t.system.record('start');
        await t.improvements.baseline();
        t.event({ what: 'started', detail: `system v${start.v}, ${t.workers.length} workers` });
        publish(t);
        const applier = t.improvements.loop();
        await dispatch(t);
        t.finished = true;
        await applier;
        await t.memories.finish();
        t.event({ what: t.stopping ? 'stopped' : 'finished' });
    } finally {
        clearInterval(timer);
        clearInterval(live);
        t.finished = true;
        publish(t);
        t.report();
        try {
            unlinkSync(lock);
        } catch {
            // Taken over as stale; nothing to give back.
        }
    }
    if (t.fatal) {
        throw t.fatal;
    }
}

async function dispatch(t: Tuning): Promise<void> {
    const running = new Set<Promise<void>>();
    const start = (seat: Seat, work: (s: Seat) => Promise<void>): void => {
        const task: Promise<void> = work(seat).finally(() => running.delete(task));
        running.add(task);
    };
    while (!t.stopping) {
        if (t.improvements.applying || t.resuming > 0 || !t.freeWorker()) {
            await t.tick();
            continue;
        }
        // A recheck tests the prose of the day, so it goes before a new case.
        const taken = t.rechecks.take();
        if (taken) {
            const seat: Seat = { case: taken.case };
            t.claimed.add(taken.case.id);
            await t.seat(seat, false);
            start(seat, (s) => recheckCase(t, s, taken.recheck));
            continue;
        }
        const c = nextCase(t);
        if (!c) {
            t.drained = true;
            // An apply still to come queues rechecks; only when none can is the work done.
            const more =
                running.size > 0 ||
                t.improvements.applying ||
                t.improvements.pending.length > 0 ||
                t.rechecks.waiting() > 0;
            if (!more) {
                break;
            }
            await t.tick();
            continue;
        }
        const seat: Seat = { case: c };
        t.claimed.add(c.id);
        t.tried.add(c.id);
        const before = resultOf(t, c);
        if (before?.state === 'failed') {
            // Taken again: until it ends anew it is in progress, not failed.
            rmSync(join(t.caseDir(c), 'result.json'), { force: true });
            t.event({ what: 'resumed', case: c.id, rev: c.rev, detail: before.reason });
        }
        await t.seat(seat, false);
        start(seat, (s) => trainCase(t, s));
    }
    await Promise.all(running);
}

async function recheckCase(t: Tuning, s: Seat, r: Recheck): Promise<void> {
    try {
        await t.rechecks.run(s, r, s.case);
    } catch (err) {
        if (!(err instanceof Stopped)) {
            t.error(
                `${s.case.id} · recheck after ${r.apply}`,
                (err as Error).message,
                err instanceof StepError ? err.log : undefined,
            );
            if (err instanceof SandboxDown) {
                // Left running: the next start queues it again.
                t.sandboxDown(err.message);
            } else {
                t.rechecks.void(r, (err as Error).message);
                t.failed(`recheck: ${(err as Error).message}`);
            }
        }
    } finally {
        t.unseat(s);
        t.claimed.delete(s.case.id);
        t.report();
    }
}

async function trainCase(t: Tuning, s: Seat): Promise<void> {
    const c = s.case;
    try {
        await train(t, s, c);
    } catch (err) {
        if (!(err instanceof Stopped)) {
            const why =
                err instanceof SandboxDown
                    ? `sandbox: ${err.message}`
                    : err instanceof VoidRun
                      ? `void: ${err.message}`
                      : `error: ${(err as Error).message}`;
            markFailed(t, c, s.phase ?? 'nomem', why);
            const attempt = s.worker?.attempt;
            t.error(
                `${c.id} · ${s.phase === 'mem' ? 'with memory' : 'no memory'}${attempt ? ` try ${attempt}` : ''}`,
                (err as Error).message,
                err instanceof StepError ? err.log : undefined,
            );
            if (err instanceof SandboxDown) {
                t.sandboxDown(err.message);
            } else {
                t.failed(why);
            }
        }
    } finally {
        t.unseat(s);
        t.claimed.delete(c.id);
        t.report();
    }
}
