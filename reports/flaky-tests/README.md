# Flaky tests in the offline suite

The offline suite (`npx vitest run --exclude '**/live-*'`, what CI runs) was run 157 times on one
machine, changing one input at a time: the order, the time zone, an agent marker, a provider key, a
home directory kept between runs, and extra CPU load. Every run started from a scrubbed environment
(only `PATH`, `HOME`, `TMPDIR`, `TZ` and `LANG`) and, unless the condition says otherwise, an empty
`HOME` of its own.

Machine: macOS 27.2 on Apple M4 (10 cores), Node 24.22.3, commit `0039398` (v1.3.4). No Linux run.

One input I could not hold still: background load, mostly Spotlight indexing (`mds_stores`) when I
looked, and the 1-minute load average before a run moved between 7 and 39. The second batch
records it per run; timing results below are read against it, not against the condition's label.

## Results

| Condition                             | Runs | Runs that failed | What failed (runs)                                                                         |
| ------------------------------------- | ---- | ---------------- | ------------------------------------------------------------------------------------------ |
| baseline                              | 38   | 2                | `review check receipts` timeout (1); `user state drains without waiting` (1)               |
| shuffled order, seeds 1001-1020       | 20   | 20               | 14 tests of `the file tools` (8-19 each); `zen view` serves a directory (11); others (1-2) |
| `TZ=Asia/Jakarta`                     | 20   | 4                | `review check receipts` timeout (4)                                                        |
| `TZ=America/New_York`                 | 20   | 2                | `review check receipts` timeout (2)                                                        |
| `TZ=Pacific/Kiritimati`               | 10   | 0                | -                                                                                          |
| `AI_AGENT` set                        | 5    | 5                | `a deferred banner > waits for a question that never comes` (5)                            |
| `OPENROUTER_API_KEY` set              | 5    | 5                | `Gym setup > embeds the docs only when --embedding asks` (5)                               |
| one `HOME` kept across runs           | 20   | 4                | `review check receipts` timeout (4)                                                        |
| 10 extra cores busy                   | 5    | 1                | `the registry picks an adapter by the provider's protocol` at 5.95 s (1)                   |
| this branch, baseline                 | 3    | 0                | -                                                                                          |
| this branch, `OPENROUTER_API_KEY` set | 3    | 0                | -                                                                                          |

"Baseline" counts the 30 baseline runs and the 8 unchanged runs of the comparison in cause 1. The
8 runs of the changed test in that comparison are left out: that checkout had no build, so an
unrelated test that reads `packages/cli/dist` failed in all of them. Every failure in the time zone
and kept-`HOME` rows is the timing failure in cause 1; why I do not read them as a time zone or home
directory effect is there.

## Causes

### 1. A timing budget: `review check receipts` (not fixed here)

`packages/cli/test/template-scripts.test.ts` > "review check receipts rejects stale inputs, added
and deleted files, and a different CLI version" takes about 1 s alone on an idle machine, but a
median of 3.2 to 4.5 s inside the full suite, against vitest's default 5 s timeout. It timed out in
11 of 129 runs that kept the declared order. The load average before a run did not predict it
(second batch, 45 runs):

| Load before the run | Runs | Median   | Max      | Timed out |
| ------------------- | ---- | -------- | -------- | --------- |
| under 20            | 10   | 4,069 ms | 5,522 ms | 2         |
| 20 to 25            | 10   | 4,210 ms | 5,523 ms | 2         |
| 25 to 30            | 10   | 4,150 ms | 4,642 ms | 0         |
| 30 and over         | 15   | 4,547 ms | 5,353 ms | 2         |

The timeouts came in the baseline (1 of 38), `Asia/Jakarta` (4 of 20), `America/New_York` (2 of 20) and a kept `HOME` (4 of 20), and not in `Pacific/Kiritimati` (0 of 10). Neither the test nor
the scripts it runs read a date or the time zone, and the rows that changed only the environment
(agent marker, provider key) showed the same raised durations, so I read the spread as timing noise
on a busy machine rather than a time zone or home directory effect. Twenty runs per row cannot rule
one out.

The test calls `review.sh` 11 times in a row. Each call starts `check-receipt.mjs` (Node), which
starts the test's fake `zen` (also Node) up to twice, and the `--skip-check` calls go on to the
path sweep in `check-paths.sh`. None of the CI runs since the test landed (2026-10-30) failed on
it; a 10-core laptop doing other work is where it shows.

I tried one change at the cause: writing the fake `zen` as a `#!/bin/sh` script, which keeps
`check-receipt.mjs` but drops the Node starts the test owns. All 15 tests in the file still pass.
Eight interleaved pairs of full runs (unchanged, changed, unchanged, ...), so both sides see the
same background load:

| Pair       | 1     | 2     | 3     | 4     | 5     | 6     | 7     | 8     |
| ---------- | ----- | ----- | ----- | ----- | ----- | ----- | ----- | ----- |
| unchanged  | 4,277 | 4,415 | 4,305 | 4,484 | 4,083 | 4,110 | 4,408 | 4,184 |
| shell fake | 3,299 | 3,766 | 3,713 | 3,613 | 3,221 | 3,151 | 3,253 | 3,186 |

Faster in 8 of 8 pairs, median 4.29 s to 3.28 s (-24 %). The change removes more than half of the
Node starts but only a quarter of the time, so most of it is elsewhere: `check-receipt.mjs`, bash
and the path sweep. I did not break that down further. The change narrows the gap to the budget
but does not close it, and I could not make the timeout happen on demand under a stated load, so I
left it out of this pull request. Raising the timeout would hide the same thing.

### 2. A provider key in the developer's environment (fixed in this pull request)

`packages/gym/test/setup.test.ts` > "embeds the docs only when --embedding asks" expects
`chooseEmbedding('on')` to fail when no provider has a key. The test clears `OPENAI_API_KEY`, but
`defaultEmbedding` (`packages/gym/src/setup.ts`) accepts a key for any provider in `PROVIDERS`, so
a key for another provider picks a default embedding and the test fails. `npm test` loads `.env`
(`node --env-file=.env`), and `.env.example` lists `OPENROUTER_API_KEY` and
`GOOGLE_APPLICATION_CREDENTIALS`, so a `.env` filled in from it is enough to see it. CI has no
`.env` and no keys, so CI stays green.

The test file alone, one variable set to a fake value at a time:

| Variable set                     | Before | After |
| -------------------------------- | ------ | ----- |
| none                             | pass   | pass  |
| `OPENAI_API_KEY`                 | pass   | pass  |
| `ANTHROPIC_API_KEY`              | pass   | pass  |
| `GEMINI_API_KEY`                 | fail   | pass  |
| `GOOGLE_APPLICATION_CREDENTIALS` | fail   | pass  |
| `VERTEX_API_KEY`                 | fail   | pass  |
| `OPENROUTER_API_KEY`             | fail   | pass  |

Anthropic passes before the fix only because it has no curated embedding model.

The fix clears every provider variable (`envNames` of each of `PROVIDERS`, the list the code
reads) before each test, and lets each test add the keys it means. No skip, retry or timeout.

### 3. An agent marker in the environment (not fixed here)

`packages/cli/test/trace.test.ts` > "a deferred banner > waits for a question that never comes"
expects the error `/without a terminal/`. `requireTty` (`packages/cli/src/term.ts`) words it
`when an agent is running zen` when `drivenByAgent()` is true, which reads `AI_AGENT` and
`COPILOT_AGENT`. Coding agents export these (Claude Code, for one, sets `AI_AGENT`), so the suite is red
for anyone who runs it from an agent. A likely fix is one line in that `describe`:
`ZENERA_AGENT=0`, the override `drivenByAgent` already honours.

### 4. Test order (not fixed here)

`packages/neo/test/files.test.ts` > `the file tools` creates one temporary workspace for the
whole `describe`, and its tests build on the files earlier tests left there; the two backends in
`packages/neo/test/backend.test.ts` do the same. In declared order they pass; shuffled, 4 to 13 of
them fail in every run, and several fail when run alone with `-t`, for example "moves and renames,
without clobbering by accident", "describes what it lists" and "will not add a file that is
already there". The `apply_patch` `describe` in `files.test.ts` already seeds its own files with a
`seed()` helper; doing the same would make each test stand alone, but it touches about twenty
tests and the chain may be on purpose.

`packages/cli/test/view.test.ts` > "zen view: what it serves serves a directory from itself" failed
in 11 of 20 shuffled runs (a missing `finetune` directory). Three more failed once or twice in 20
shuffled runs: two in `packages/server/test/server.test.ts` (`user state`) and one in
`packages/neo/test/memory-sqlite.test.ts` (writers in other processes). I did not replay their
seeds, so order versus timing is not settled; one `user state` test also failed once in declared
order.

### 5. The real home directory

Every run wrote into `HOME`: `.zenera/neo/cache` (vectors, docs-parse) and `.zenera/neo/runtime/<id>`.
On a developer machine that is the real `~/.zenera`. (A `Library/` also appeared in the empty
`HOME`; I could not trace it to the repository.) The runtime copy comes from
`packages/engine/test/identity.test.ts` (`runtimeDir()` without `ZENERA_HOME`); the cache from tests
that leave `ZENERA_HOME` and the cache directory unset. A home kept across 20 runs changed nothing
measurable (see the table), so this is hygiene rather than a cause of failures.

### 6. A fresh clone

`npm test -- --exclude '**/live-*'` exits at once with `node: .env: not found` until a `.env`
exists (`--env-file-if-exists=.env` would keep the same behaviour when it does). In a run without
a build, 75 of 114 test files failed to resolve `@zenera/*` packages; CI builds first
(`npm run typecheck`), but nothing in the README says so.

## Reproduce

From the repository root, after `npm ci && npm run build`:

```sh
node reports/flaky-tests/flaky.mjs --label baseline --runs 20
node reports/flaky-tests/flaky.mjs --label shuffle --runs 20 --shuffle
node reports/flaky-tests/flaky.mjs --label tz-jakarta --runs 10 --tz Asia/Jakarta
node reports/flaky-tests/flaky.mjs --label tz-newyork --runs 10 --tz America/New_York
node reports/flaky-tests/flaky.mjs --label tz-kiritimati --runs 10 --tz Pacific/Kiritimati
node reports/flaky-tests/flaky.mjs --label agent-marker --runs 5 --set AI_AGENT=1
node reports/flaky-tests/flaky.mjs --label provider-key --runs 5 --set OPENROUTER_API_KEY=not-a-real-key
node reports/flaky-tests/flaky.mjs --label shared-home --runs 10 --home keep
node reports/flaky-tests/flaky.mjs --label load10 --runs 5 --load 10
node reports/flaky-tests/summarize.mjs
```

The Results table pools two batches of these (the second rerun baseline, time zones and kept
`HOME` with the load recorded) and the comparison in cause 1. Shuffled runs use seeds 1001 to 1020, so `--sequence.seed=1001` replays the first one. Pass fake
values to `--set`: the summary keeps only the names, but the tests see the values. Each run records
the load average before and after, and its five slowest tests.
