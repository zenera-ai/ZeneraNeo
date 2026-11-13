# Gym oracles — relations for data that has no fixed answer

A generated search has no exact body to assert. These tests assert **relations**
between answers instead, run each one several times, and report a pass rate per
relation.

| File                   | What it is                                                                          | Needs a model?   |
| ---------------------- | ----------------------------------------------------------------------------------- | ---------------- |
| `oracles.ts`           | The relations, a pager that cannot hang (`walk`), and the report writer             | no               |
| `oracles.test.ts`      | Proves every oracle **fails** on known-bad data, and `walk` stops in all three ways | no — seconds     |
| `live-oracles.test.ts` | The five relations against a running Gym; writes `oracle-report.md`                 | yes (cold cache) |

## The relations

| ID  | Relation                                                  | Operations                            |
| --- | --------------------------------------------------------- | ------------------------------------- |
| R1  | `maxResults=n` returns at most n items                    | listMessages, listThreads, listEvents |
| R2  | adding a clause to `q` never grows the result set         | listMessages, listThreads             |
| R3  | the union of all pages equals the first page with no cap  | listMessages, listThreads, listEvents |
| R4  | every returned event overlaps `[timeMin, timeMax)`        | listEvents                            |
| R5  | `freeBusy.calendars` contains exactly the ids asked about | queryFreeBusy                         |

Design choices worth defending:

- **R4 bounds come from the spec, not intuition:** `timeMin` bounds an event's
  _end_ and `timeMax` its _start_, both exclusive — so the check is
  `end > timeMin && start < timeMax`, compared as instants, not strings.
- **R4 windows are built from the world's own events**, plus one window in 1990
  that must be empty. A window with no events would pass without proving
  anything, so the suite fails if it cannot find a non-empty one, and the report
  counts vacuous passes separately.
- **R2 skips calendar `q`.** The spec defines mail search operators, so "adding a
  clause" means something there. Calendar `q` is free text with no defined
  meaning for two words; testing it would be testing my guess.
- **R3 records why each walk stopped** (`end`, `repeated-token`, `seen-token`,
  `page-cap`) so a failure can be classified, not just counted.

## Run

This is a standalone suite, so it lives under `reports/` with its own
`vitest.config.ts` and is not part of the workspace test run.

```sh
# terminal 1 and 2 — from examples/mock-apis (zen does not read .env itself, hence --env-file)
node --env-file=../../.env ../../packages/cli/dist/main.js gym serve specs/mail.yaml     --story stories/northwind-launch.md --docs kb --port 8787 --seed 42
node --env-file=../../.env ../../packages/cli/dist/main.js gym serve specs/calendar.yaml --story stories/northwind-launch.md --docs kb --port 8788 --seed 42

# terminal 3 — from the repo root
npx vitest run --config reports/gym-oracles/vitest.config.ts   # no model, seconds; the live file self-skips without the URLs

GYM_MAIL_URL=http://localhost:8787 GYM_CALENDAR_URL=http://localhost:8788 ORACLE_REPEATS=5 \
  npx vitest run --config reports/gym-oracles/vitest.config.ts live-oracles   # writes oracle-report.md
```

`ORACLE_QUARANTINE="R3 union of pages"` keeps a relation running and reported
without failing the suite.

## Results

Three runs against one world (`--seed 42`, the Northwind story, `google:gemini-3.5-flash-lite`).
The full per-trial table of the last run is in [oracle-report.md](oracle-report.md).

| Relation          | Run 1 (×3)                | Run 2 (×5)      | Run 3 (×5, R3 quarantined) |
| ----------------- | ------------------------- | --------------- | -------------------------- |
| R1 maxResults     | 27/27                     | 45/45           | 45/45                      |
| R2 narrowing      | 24/24, **21 vacuous**     | 60/60           | 60/60                      |
| R3 union of pages | 18/18                     | **24/30 (80%)** | **28/30 (93%)**            |
| R4 time window    | 12/12, **could not fail** | 35/35           | 35/35                      |
| R5 freeBusy keys  | 9/9                       | 15/15           | 15/15                      |

Run 1 was all green and proved little: most R2 trials had an empty narrow side, and every
R4 window contained the whole calendar (all 8 events fall between 9 and 11 November). Runs 2
and 3 add R2 pairs whose narrow side has members (3 ⊆ 8, 2 ⊆ 8) and single-day R4 windows
that hold 1–2 of the 8 events, so both relations could now fail — and did not.

## Note: what each failure is

| Finding                                        | Evidence                                                                                                                | Class                         |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| R3 fails 7–20% of the time                     | Walks stop after 1–2 pages with no `nextPageToken`; ids missing (e.g. 3 of 8 events)                                    | **Deliberate mock behaviour** |
| Threads search ignores `is:unread` and `from:` | `listMessages` returns 2 for each; `listThreads` returns 0, although every message is its own thread (`threadId == id`) | **Mock defect**               |
| R2 and R4 passed vacuously in run 1            | 21/24 empty narrow sides; week windows held every event                                                                 | **Test defect** (fixed)       |
| First call waited 381 s, then HTTP 500         | `503 This model is currently experiencing high demand` from the default Gemini model                                    | **Environment**               |

- **R3** is `PaginationLimiter` in `packages/gym/src/paging.ts`: every paged stream is cut at a
  random 1–10 pages. The handler pages correctly; the host cuts it. The cut is **silent** — the
  token simply disappears, exactly like a real last page — and it uses `crypto.randomInt`, so
  `--seed` does not make it reproducible (80% in one run, 93% in the next). Mail clients can
  notice (`resultSizeEstimate` 8, 6 items received); calendar clients cannot, since
  `listEvents` has no estimate. A stateful world is not the obstacle; the cap is.
- **Threads** is a consistency defect between two operations over the same records. The spec
  defines the search operators only on `listMessages`, so I report it as a mock defect against
  the API's own behaviour, not as a spec violation.
- **Environment:** a suite against Gym cannot tell "the mock is wrong" from "the model provider
  is down" unless it reads the error detail. Errors are recorded as trial failures with their
  message, so the report shows which it was.

## Quarantine vs. release blocker

- **Blocks a release:** R1, R2, R4 and R5 — relations the spec states plainly and the mock can
  keep. Any pass rate below 100% blocks.
- **Quarantined:** R3. It still runs and is still reported (`ORACLE_QUARANTINE="R3 union of pages"`),
  with this reason, until Gym can signal a cut or switch the cap off for tests.
- **Never quarantined silently:** a quarantined relation names its reason in the report header
  and here. "Flaky" is not a reason.
- **A vacuous pass is not a pass:** the report counts them separately, and R4 fails outright if
  the world gives it nothing to judge.

## A test I removed because it was wrong

`resultSizeEstimate equals the number of messages walked` (added and removed in two commits on
this branch). It looks reasonable and failed 2 of 10 runs. It was wrong twice over:

1. The spec calls the field an **estimate** (Gmail semantics). Equality is a promise the spec
   never made, so the test would fail a correct mock.
2. In practice it failed only when the page cap cut the walk — it was testing the cap, which R3
   already covers, and it made the suite flaky.

## What I decided not to do

- Calendar `q` in R2: free text with no defined meaning for two words.
- Asserting the content of any search result: these are relations, not judgements of relevance.
- Changing Gym: the findings are reported, not patched.

## Side findings

- `.env.example` names `ANTROPIC_API_KEY`; the code reads `ANTHROPIC_API_KEY`.
- `zen gym serve` does not read `.env`; a key kept only there needs `node --env-file=.env`.
