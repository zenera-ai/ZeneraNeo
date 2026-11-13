import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    atMost,
    exactKeys,
    fetchJson,
    notGrowing,
    overlapsWindow,
    report,
    sameSet,
    walk,
    withQuery,
    type Json,
    type Trial,
    type Verdict,
} from './oracles.ts';

// ---------------------------------------------------------------------------
// The relations against a running Gym. Spends tokens on a cold cache, so it is
// named live-* like the repo's other live tests, and it self-skips unless both
// mocks are pointed at:
//
//   GYM_MAIL_URL=http://localhost:8787 GYM_CALENDAR_URL=http://localhost:8788 \
//     npx vitest run --config reports/gym-oracles/vitest.config.ts live-oracles
//
// Each case runs ORACLE_REPEATS times (default 3); every run is one trial in
// the pass-rate report written to ORACLE_REPORT (default: oracle-report.md here).
// Relations named in ORACLE_QUARANTINE (comma-separated) still run and still
// report, but do not fail the suite.
// ---------------------------------------------------------------------------

const MAIL = process.env.GYM_MAIL_URL?.replace(/\/$/, '');
const CAL = process.env.GYM_CALENDAR_URL?.replace(/\/$/, '');
const REPEATS = Number(process.env.ORACLE_REPEATS ?? 3);
const REPORT = process.env.ORACLE_REPORT ?? join(import.meta.dirname, 'oracle-report.md');
const QUARANTINE = new Set(
    (process.env.ORACLE_QUARANTINE ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
);

const COLD = 600_000; // a first call can cost a model turn per operation

const trials: Trial[] = [];

/** Run one case REPEATS times, record each run, then fail loudly with every bad run. */
async function trial(relation: string, name: string, run: () => Promise<Verdict>) {
    const bad: string[] = [];
    for (let i = 1; i <= REPEATS; i++) {
        let verdict: Verdict;
        try {
            verdict = await run();
        } catch (err) {
            verdict = { ok: false, vacuous: false, detail: `error: ${(err as Error).message}` };
        }
        trials.push({ relation, case: name, run: i, verdict });
        if (!verdict.ok) bad.push(`run ${i}: ${verdict.detail}`);
    }
    if (QUARANTINE.has(relation)) return;
    expect(
        bad,
        `[${relation}] ${name} failed ${bad.length}/${REPEATS}:\n${bad.join('\n')}`,
    ).toEqual([]);
}

const messages = (q = '') => withQuery(`${MAIL}/users/me/messages`, { q });
const threads = (q = '') => withQuery(`${MAIL}/users/me/threads`, { q });
const events = (query: Record<string, string> = {}) =>
    withQuery(`${CAL}/calendars/primary/events`, query);

describe.runIf(Boolean(MAIL && CAL))('oracles against a live Gym', () => {
    beforeAll(async () => {
        // Warm every list operation once so the first trial is not timed against a model turn.
        await fetchJson(`${MAIL}/__gym/health`);
        await fetchJson(`${CAL}/__gym/health`);
        await fetchJson(withQuery(messages(), { maxResults: 1 }));
        await fetchJson(withQuery(threads(), { maxResults: 1 }));
        await fetchJson(withQuery(events(), { maxResults: 1 }));
    }, COLD);

    afterAll(() => {
        writeFileSync(
            REPORT,
            report(trials, {
                date: new Date().toISOString(),
                mail: MAIL!,
                calendar: CAL!,
                repeats: String(REPEATS),
                quarantined: [...QUARANTINE].join(', ') || 'none',
            }),
        );
        console.log(`oracle report written to ${REPORT}`);
    });

    // R1 ----------------------------------------------------------------------
    describe('R1 maxResults=n returns at most n items', () => {
        const cases: [string, (n: number) => string, string][] = [
            ['listMessages', (n) => withQuery(messages(), { maxResults: n }), 'messages'],
            ['listThreads', (n) => withQuery(threads(), { maxResults: n }), 'threads'],
            ['listEvents', (n) => withQuery(events(), { maxResults: n }), 'items'],
        ];
        for (const [op, url, key] of cases) {
            for (const n of [1, 3, 7]) {
                it(
                    `${op} n=${n}`,
                    () =>
                        trial('R1 maxResults', `${op} n=${n}`, async () => {
                            const body = await fetchJson(url(n));
                            return atMost((body[key] as unknown[]) ?? [], n);
                        }),
                    COLD,
                );
            }
        }
    });

    // R2 ----------------------------------------------------------------------
    describe('R2 adding a clause to q never grows the result set', () => {
        // Calendar q is free text with no defined meaning for two words, so it is
        // left out on purpose: "adding a clause" is only defined for the mail syntax.
        // The first run showed most narrow queries returning nothing, so those pairs
        // passed vacuously. The pairs below were added because their narrow side is
        // non-empty in this world: a subset check only means something when it has members.
        const pairs: [string, string][] = [
            ['', 'is:unread'],
            ['', 'launch'],
            ['', 'from:sarah.chen@northwind.io'],
            ['launch', 'launch is:unread'],
            ['from:sarah.chen@northwind.io', 'from:sarah.chen@northwind.io subject:launch'],
            ['Tempo', 'Tempo has:attachment'],
        ];
        for (const [op, list, key] of [
            ['listMessages', messages, 'messages'],
            ['listThreads', threads, 'threads'],
        ] as const) {
            for (const [broad, narrow] of pairs) {
                it(
                    `${op} "${broad}" ⊇ "${narrow}"`,
                    () =>
                        trial('R2 narrowing', `${op} "${broad}" ⊇ "${narrow}"`, async () => {
                            const b = await walk(withQuery(list(broad), { maxResults: 500 }), key);
                            const n = await walk(withQuery(list(narrow), { maxResults: 500 }), key);
                            return notGrowing(b.items, n.items);
                        }),
                    COLD,
                );
            }
        }
    });

    // R3 ----------------------------------------------------------------------
    describe('R3 the union of all pages equals the uncapped first page', () => {
        const cases: [string, (q: string) => string, string, number][] = [
            ['listMessages', messages, 'messages', 500],
            ['listThreads', threads, 'threads', 500],
            ['listEvents', (q) => events({ q }), 'items', 2500],
        ];
        for (const [op, list, key, max] of cases) {
            for (const q of ['', 'launch']) {
                it(
                    `${op} q="${q}"`,
                    () =>
                        trial('R3 union of pages', `${op} q="${q}"`, async () => {
                            const whole = await fetchJson(withQuery(list(q), { maxResults: max }));
                            const paged = await walk(withQuery(list(q), { maxResults: 3 }), key);
                            const v = sameSet(paged.items, (whole[key] as unknown[]) ?? []);
                            // The stop reason is the evidence for classifying a failure.
                            return {
                                ...v,
                                detail: `${v.detail} [walk: ${paged.pages} page(s), stop=${paged.stop}]`,
                            };
                        }),
                    COLD,
                );
            }
        }
    });

    // R4 ----------------------------------------------------------------------
    describe('R4 every listed event overlaps [timeMin, timeMax)', () => {
        let windows: [string, string, string][] = [];

        beforeAll(async () => {
            // Build windows from the world itself, so they are never empty by accident.
            const all = (await fetchJson(withQuery(events(), { maxResults: 2500 })))
                .items as Json[];
            const starts = (all ?? [])
                .map((e) => (e.start as { dateTime?: string } | undefined)?.dateTime)
                .filter((s): s is string => Boolean(s) && !Number.isNaN(Date.parse(s!)))
                .slice(0, 3);
            const day = 86_400_000;
            // A week around an event held the whole calendar in the first run, so every
            // event qualified and the check could not fail. The single-day windows exclude
            // most of the calendar, which is what gives the relation teeth.
            windows = starts.flatMap((s): [string, string, string][] => {
                const t = Date.parse(s);
                const dayStart = Math.floor(t / day) * day;
                return [
                    [
                        `week around ${s}`,
                        new Date(t - 3 * day).toISOString(),
                        new Date(t + 4 * day).toISOString(),
                    ],
                    [
                        `UTC day of ${s}`,
                        new Date(dayStart).toISOString(),
                        new Date(dayStart + day).toISOString(),
                    ],
                ];
            });
            windows.push(['a week in 1990', '1990-01-01T00:00:00Z', '1990-01-08T00:00:00Z']);
        }, COLD);

        it(
            'has at least one non-empty window to judge (no vacuous pass)',
            () => {
                expect(
                    windows.length,
                    'the calendar returned no events with a start.dateTime; R4 cannot be judged',
                ).toBeGreaterThan(1);
            },
            COLD,
        );

        it(
            'each window',
            async () => {
                for (const [name, timeMin, timeMax] of windows) {
                    await trial('R4 time window', name, async () => {
                        const w = await walk(
                            events({ timeMin, timeMax, maxResults: '50' }),
                            'items',
                        );
                        return overlapsWindow(w.items, timeMin, timeMax);
                    });
                }
            },
            COLD,
        );
    });

    // R5 ----------------------------------------------------------------------
    describe('R5 freeBusy.calendars contains exactly the ids asked about', () => {
        const now = Date.now();
        const timeMin = new Date(now).toISOString();
        const timeMax = new Date(now + 7 * 86_400_000).toISOString();
        const asks: string[][] = [
            ['primary'],
            ['alex.rivera@northwind.io', 'marcus.vance@northwind.io'],
            ['primary', 'nobody@nowhere.invalid'],
        ];
        for (const ids of asks) {
            it(
                ids.join(' + '),
                () =>
                    trial('R5 freeBusy keys', ids.join(' + '), async () => {
                        const body = await fetchJson(`${CAL}/freeBusy`, {
                            method: 'POST',
                            headers: { 'content-type': 'application/json' },
                            body: JSON.stringify({
                                timeMin,
                                timeMax,
                                items: ids.map((id) => ({ id })),
                            }),
                        });
                        return exactKeys(body.calendars, ids);
                    }),
                COLD,
            );
        }
    });

    // resultSizeEstimate ---------------------------------------------------------
    describe('resultSizeEstimate equals the number of items walked', () => {
        it(
            'listMessages',
            async () => {
                const first = await fetchJson(withQuery(messages(), { maxResults: 3 }));
                const w = await walk(withQuery(messages(), { maxResults: 3 }), 'messages');
                expect(w.items.length).toBe(first.resultSizeEstimate);
            },
            COLD,
        );
    });
});
