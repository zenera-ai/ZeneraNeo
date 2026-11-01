---
name: zen-spec-sync
description: Running `/spec-sync-project` incrementally - the committed `.spec-sync` baseline, scope and precedence, the pass plan that maps changed areas to capability skills and checks, spec-only and model-reference-only verification tiers, generated-rule maintenance, reusable validation, explicit history recording and why the baseline moves last. Load before every `/spec-sync-project`, including a project's first pass.
user-invocable: false
---

# Syncing a project with its specification, one change at a time

`SPECIFICATION.md` is the intent and the files are the implementation, so
bringing the two together is a pass over the whole project. Done from nothing
every time, that pass re-reads every prompt, re-derives every decision the last
one already made, and re-raises questions someone has already answered.

A pass is worth repeating cheaply, so it keeps a record of **what it applied**.
The next pass diffs the specification against that record and works the
difference. What it must not do is confuse a narrow diff with a narrow
obligation: the record scopes what you _read and edit_. The pass plan below
also scopes which skills you load and which checks you run, from the areas the
changes reach, and grows when the work reaches further.

## What this owns

Everything is committed. `.spec-sync/` is a record, not scratch - `.tmp/` is
scratch.

```
.spec-sync/
├── baseline/
│   ├── SPECIFICATION.md              the spec the last completed pass applied
│   ├── SPECIFICATION-FEEDBACK.md     the questions it had open, if any
│   ├── agents.yaml                   the wiring it left behind
│   ├── agents/                       and every instruction, prompt and skill
│   ├── applied.txt                   the history entry this baseline belongs to
│   └── manifest.txt                  sha256 of every file above
└── history/
    └── 2026-09-13T104500Z.md         one file per pass, never edited after
```

The baseline mirrors the paths it records, so `baseline/agents/skills/x/SKILL.md`
is that skill as the last completed pass left it. Both sides are there on
purpose: the specification and the feedback say what was **asked for**, the
wiring and the `agents/` tree say what was **built**, and a pass has to know
which of the two moved.

The baseline is **not a copy of the current specification**. It is the
specification as the last completed pass left it, which is what makes the
difference between the two mean "work nobody has done yet".

`zen init` creates `baseline/` and `history/` empty, and git does not carry an
empty directory, so **the presence of `.spec-sync/` proves nothing**. The
manifest is the signal: no `manifest.txt` means no pass has ever completed.

## Deciding the size of the pass

Run this first, from the project root:

```sh
.github/skills/zen-spec-sync/scripts/snapshot.sh status
```

It prints one `mode:` line, the `applied:` stamp the baseline belongs to, and a
`changed:` line per file that differs - specification, feedback, `agents.yaml`
or anything under `agents/`:

The four generated `agents/{files,fork,memory,tools}-instructions.md` copies
print as `maintenance:` rather than `changed:`. Their diffs remain visible and
their bytes remain in the baseline. They are not project implementation edits:
`zen check` checks them against this version's templates, and `--fix` replaces
them. Account for repairs in history, but do not widen the pass merely because
one of these copies moved. A project requirement found in one must be moved to
a project-owned topic file; that is substantive work and widens the pass.

| Mode          | Means                                      | Do                                                                                    |
| ------------- | ------------------------------------------ | ------------------------------------------------------------------------------------- |
| `full`        | no manifest - no pass has ever completed   | the whole prompt as written, then write the first baseline                            |
| `incremental` | a baseline is there and the files differ   | scope from the four inputs below                                                      |
| `tampered`    | a baseline file does not match its own sha | treat as `full`, and say in the chat which file and that the baseline was not trusted |

`tampered` is either a baseline edited by hand or a pass that died between
copying the files and writing the manifest. Both mean the record is not
evidence. Do not rewrite `manifest.txt` to make the message go away - that
asserts a pass happened that did not.

`snapshot.sh diff` then prints the unified diffs, and is where the pass
actually starts.

## The four scope inputs

An incremental pass is scoped by the union of these. Write the union down before
editing anything, and report it in the chat as the pass's scope.

1. **The `SPECIFICATION.md` diff.** The primary input: added, changed and
   deleted requirements. A deleted requirement is work too - what implemented it
   is now an **extra**, to be reported under `➕` rather than quietly deleted.
2. **The `SPECIFICATION-FEEDBACK.md` diff.** The file is a questionnaire the
   human answers by ticking one answer's `[ ]` box or deleting the answers they
   do not want. A question that has moved under `✅ Answered` was folded into the
   specification by `/spec-apply-feedback`, and its **Still to implement**
   line is the work. A question with a box marked `[x]`, or one answer left
   under it, and no `✅` entry was answered and never folded in - implement it,
   put its text into `SPECIFICATION.md`, and say so. A new question someone else
   raised is work too. Close what this pass resolves rather than re-raising it.
3. **What the last pass left open.** The `Still open` section of the entry named
   by `applied:`, in `.spec-sync/history/`. A specification line that has not
   changed since the baseline is **not therefore implemented**: the baseline
   records what the pass applied, and a pass can complete with items open. This
   is the only place that says which.
4. **The implementation diff.** `agents.yaml` and project-owned files under `agents/` -
   instructions, prompts and skills. This side is what was built rather than
   what was asked for, so it never narrows a pass: it says what moved under you
   since the last one. An agent, tool grant, handoff, model, house rule, prompt
   or skill edited outside a pass **widens** the pass to everything that names
   what changed, and the edit is itself an item - either the specification
   covers it, and you say which line, or it does not, and it is an **extra**
   reported under `➕`.

## When the inputs disagree

Two inputs can ask for different things - a ticked answer and a later edit to
the same specification line, say. Decide by this order, highest first, and do
not weigh them again:

1. **The user's message that started this pass**, where it says more than the
   command name. It is the newest and most direct statement of intent there is.
2. **`SPECIFICATION.md` as it stands now.** An edit to the specification is
   made on purpose and after the questions were written, so it outranks them.
3. **An answer ticked in `SPECIFICATION-FEEDBACK.md`** and not yet folded in.
4. **What the last pass left open.**

A ticked answer that the current specification text contradicts was
**superseded**, not ignored: do not fold its text back in over the newer line.
Strike the question with one line naming the specification line that replaced
it, and say in the chat that you did.

Facts outrank all four. `zen --version` decides the sandbox pin (below); a
specification line asking for something impossible is a question, not an order.
Where the order above does not decide, build what the higher-ranked input asks
for, write **one** question in `SPECIFICATION-FEEDBACK.md`, and carry on.

### Do not reconstruct intent

The diffs say what changed. The order above says what wins. A feedback question
covers whatever is left. Do not use anything else to work out _why_ somebody
changed something: no session history or chat transcripts, no file timestamps,
no `git log` or `git blame`, no older history entries beyond the one `applied:`
names. If a pass catches itself guessing at what the human meant, that guess is
the text of a question, and the pass moves on.

### The `zen` version in the specification

The `@zenera/cli` and `@zenera/rag` pin in `sandbox/Dockerfile` always follows
`zen --version` - `zen check` warns on any other number, older or newer. Nothing
outranks that, not a specification line and not the user's message: the image
cannot hold a `zen` other than the one building it. If a version was asked for
that is not the one in hand, say so in the chat - `zen` has to be upgraded on the
host first.

When `SPECIFICATION.md` names an exact version other than `zen --version`, pin
the Dockerfile to `zen --version` and keep **one** `✏️` question open for that
line. If one is already open, update it instead of adding another. Offer these
answers:

- State the pin without a number - "pinned to the `zen` version that builds the
  image" - so the next upgrade does not raise the question again
  _(recommended)_.
- Replace the number with the one `zen --version` reports.
- Keep the number, upgrade `zen` on the host to it, and run the pass again.

That is the whole of the work. A version mismatch is not a reason to look for
anything else.

## Plan the pass before loading anything

On an incremental pass, after `snapshot.sh diff` and before reading the
project, post a plan in the chat. Derive it from **what changed**, not from
what the project has turned on: a capability that is enabled and untouched owes
nothing it did not already owe when the last pass verified it.

1. **Classify every input into areas**, using the list below: every `changed:`
   path, every changed top-level key in `agents.yaml`, every `SPECIFICATION.md`
   hunk, every answered feedback question and every `Still open` item. A hunk
   counts by what it asks for, not by the section it sits in: a _Scope_ line
   that introduces writing scripts reaches **code**. A hunk that only
   describes what is already built asks for nothing: when the implementation
   diff is empty and reading the files the hunk names shows they already do
   exactly what it says, it counts as **specification**. A `✅` entry whose
   **Still to implement** says nothing is left is the usual source; confirm
   it by that reading rather than trusting it. One line that differs makes the
   hunk count by what it asks for.
2. **Take the union** of the skills and checks those areas name. Load those
   skills and no others. Name each skill and expensive check left out, with
   the reason: `zen-sandbox - no sandbox/, sandbox: or pin change`. Reading
   narrows the same way, to the files the areas reach and the changed hunks of
   the specification. That narrowing is a claim too: name what you skip
   reading and why no change reaches it.
3. **Re-plan before verifying.** After the last edit and before the final
   check, classify again, now including this pass's own edits -
   `snapshot.sh diff` compares the baseline with the working tree, so it shows
   them. Run the checks the final plan names. An edit that reaches a new area
   adds that area's skill, loaded before the edit, and its checks. A plan only
   grows during a pass; it never drops an area it has named.

A full or tampered pass reaches every area.

### Areas

- **specification** - wording in `SPECIFICATION.md` or
  `SPECIFICATION-FEEDBACK.md` that asks for nothing in the areas below,
  including a hunk that only describes what is already built. Skill: none.
  Checks: baseline.
- **prompts and grants** - `agents/prompts/**`, `agents/skills/**`, and the
  `tools:` and `skills:` lists of an agent. Skill: none of its own; the content
  may reach another area. A `sandbox:*` or `files:*` grant is a tool grant, not
  a sandbox change. Checks: baseline.
- **house rules** - a project-owned `agents/*instructions.md`. Skill:
  `zen-instructions`. Checks: baseline.
- **memory** - a `memory:` block, a project-owned memory topic file, or what
  agents commit to or recall from memory. Skill: `zen-memory`. Checks:
  baseline.
- **code** - an agent that writes or runs code, its coding skill, or a script
  shipped under a skill folder. Skill: `zen-code-python`. Checks: baseline.
- **topology** - `handoffs:`, `fork:`, or an agent added, removed or given a
  different job. Skill: `zen-topology`. Checks: baseline.
- **models** - a chat model reference or `providers:`. Skill: none. Checks:
  baseline, whose check already probes models.
- **index** - an embedding reference, `assets/**`, or an index the project
  builds or searches. Skill: `zen-rag-docs` or `zen-rag-schema`. Checks:
  setup run.
- **setup** - `scripts/**`. Skill: `zen-cli` when a step's commands change.
  Checks: setup run.
- **sandbox image** - `sandbox/**`, the `sandbox:` block, the `@zenera/*` pin,
  a setup step that writes into the build context, or any `sandbox.pin.*` or
  `rules.stale` finding. Skill: `zen-sandbox`, except for a pin or
  `rules.stale` repair alone. Checks: sandbox.

### Checks

- **baseline** - every incremental pass: after the last edit and setup,
  `review.sh check no-sandbox`; `scripts/_setup.sh --check` reporting every
  step `skipped` (one run when `STEPS` is empty); then
  `review.sh --skip-check no-sandbox`.
- **setup run** - replaces the setup part of baseline with §6 of the prompt:
  `scripts/_setup.sh` to completion, again to prove every step `skipped`,
  `--check`, and `zen rag docs ready` for each index the project builds.
- **sandbox** - replaces `no-sandbox` with `full --fix` on the check and `full`
  on the review.

Results add areas. `--check` reporting anything but `skipped` adds **setup**.
A check finding `rules.stale` or a sandbox pin, or one that would repair any
file, adds **sandbox image**: run `review.sh check full --fix`, because a
partial check that changes files issues no reusable receipt. `--no-sandbox` is
allowed only once git confirms the sandbox configuration, Dockerfile and build
context are unchanged and no setup step writes into them; if that cannot be
established, the pass reaches **sandbox image**.

## Choose a verification tier

The plan is the tier. Use `full` for a missing or untrusted baseline. A plan
whose only area is **specification** is the spec-only pass; one whose only
area is **models**, through a chat model reference, is the
model-reference-only pass. Both carry the extra conditions below. Every other
plan runs the normal incremental checks. Unresolved items or feedback requiring
other work disqualify a narrow tier. Say the tier, its scope and the omitted
work in the chat. Escalate as soon as the actual work exceeds that scope; a
small original diff is not permission to skip new work.

### The model-reference-only pass

All of these must hold:

- The only substantive requirement change replaces an existing **chat model
  reference**, with an explicit replacement in the specification or user input.
- The only project implementation change is that corresponding scalar in
  `agents.yaml`, either pending or already edited. No agent assignment, provider
  configuration, tool, prompt, skill, capability or setup step changes.
- There is no other outstanding work from feedback or `Still open`.

Embedding references are not eligible: indexes may need rebuilding. Version
pins are not model references; a pin repair requires sandbox validation.

Read only the affected requirement hunks, wiring and their direct references.
Load no capability skill for a model swap alone. After editing, run:

```sh
.github/skills/zen-review/scripts/review.sh check no-sandbox
scripts/_setup.sh --check
.github/skills/zen-review/scripts/review.sh --skip-check no-sandbox
```

The check still validates the whole configuration and probes its models; do not
also run `zen models test`. Every tier must resolve `rules.stale` and sandbox
pin findings before completion, even when the CLI reports them as warnings.
`--no-sandbox` is allowed only after confirming the
sandbox configuration, Dockerfile and build context are unchanged. Compare
them with git, inspect pending edits and account for any setup-generated build
inputs: the spec-sync baseline does not track those paths. If that cannot be
established, use `check full`. Use maintenance diffs and, when needed, a cheap
`zen check --no-models --no-sandbox` diagnostic to identify repairs before
probing models. If rules or pins need repair, load
`zen-instructions` only if a project-owned house rule needs editing, then run
`review.sh check full --fix`. It repairs before validating, including the
sandbox. No separate pre-repair model probe is required.

Work only the §9 **Models** and **Specification** groups, plus any group reached
by additional work (which may require escalation). If setup is empty, one
successful `--check` is all the setup proof. If existing steps all report
`skipped`, that also suffices for this tier; otherwise run setup, prove
re-entrancy and repeat the final check. Finish all builds before recording.

### The normal incremental checks

Outside the two narrow tiers:

1. **`zen check` passes after the last edit and setup**, in the mode the final
   plan names: `review.sh check no-sandbox` unless the plan reaches **sandbox
   image**, then `review.sh check full --fix`. When an initial diagnostic is
   needed, use `zen check --no-models --no-sandbox`; do not repeat expensive
   probes before and after editing. Reuse the final receipt with
   `review.sh --skip-check` in the same mode rather than invoking a third check
   during review.
2. **Setup satisfies the plan.** `scripts/_setup.sh --check` must report every
   step `skipped`: it makes each step's own readiness test without doing the
   work, which is what tells a real `skipped` from a step that only looked done.
   When the plan reaches **setup** or **index**, run `scripts/_setup.sh` to
   completion in this session and re-run it clean first: a step that tests for a
   committed `manifest.json` skips on a fresh clone whose git-ignored `lance/`
   vectors are missing, and the project cannot search. When `STEPS` is empty,
   one successful `--check` is sufficient.
3. **§9 of the copilot instructions, worked as a checklist**, group by group.
4. **The capability obligations in §0.1**, through the skills the plan names.
   For a full pass, every enabled capability is in scope. `zen check` must
   still report no `rules.stale`, whether or not its capability was in scope.
5. **`zen-instructions` is loaded before editing a project-owned house rule.** A pass
   whose scope reaches `agents/*instructions.md` - and input 4 puts it there
   whenever a project-owned one moved - has to know that `tools-instructions.md`,
   `files-instructions.md`, `memory-instructions.md` and `fork-instructions.md`
   are `zen`'s and are replaced by `zen check --fix`. A pass that writes a
   requirement into one of them has implemented nothing: the next `open` reverts
   it, the history entry claims it, and the baseline records it as applied.
   Specification-driven rules go in a topic file of the project's own beside it.

### The spec-only pass

A pass qualifies when **all** of the following hold, and no outstanding
feedback or `Still open` item requires implementation work:

- the implementation diff (input 4) is empty
- the pass edits nothing except `SPECIFICATION.md`, `SPECIFICATION-FEEDBACK.md`
  and the `@zenera/*` pin in `sandbox/Dockerfile`
- no changed specification hunk names an agent, tool, model, embedding, skill,
  house rule, handoff, memory, index, asset or setup step - except a hunk that
  only describes what is already built, confirmed as the plan says, such as a
  `➕` keep answer folded into the specification

Generated copies and the editor tree repaired by `--fix` are maintenance, not
project implementation edits for this test.

A pass like that changes nothing an agent reads, so it has no capability
obligation to re-check. Checks 4 and 5 drop out: load no capability skill and no
`zen-instructions`. One final `review.sh check full --fix` repairs generated
copies and pins, validates the result and saves a reusable receipt. Check 2
shrinks to `scripts/_setup.sh --check`, which
must report every step `skipped`. If it reports anything else, run
`scripts/_setup.sh` in full as written. Check 3 shrinks to the §9
**Specification** group and the groups covering any file the pass edited.

Decide this before loading anything, and say it in the chat - "spec-only pass:"
followed by the reason. If any edit turns out to reach further, the pass is no
longer spec-only: run all five checks.

Verification is narrowed only by these explicit tier rules.

## What else an incremental pass still owes

The reverse pass of §2 - reading each line and naming the specification item it
serves - runs over every project-owned file this pass touched, plus every file the
implementation diff named. It is the only pass that finds a line contradicting
another file, and an edit made this session, or made by hand since the last
pass, is exactly where a new contradiction comes from.
Do not audit generated house-rule copies or the generated editor tree line by
line; byte comparison and repair belong to `zen check`. Inspect maintenance
diffs only to identify any project policy that must be preserved in an owned file.

## The history entry

One file per pass, `.spec-sync/history/<stamp>.md`, where the stamp is UTC and
filename-safe: `date -u +%Y-%m-%dT%H%M%SZ`. Never edit a file that is already
there; a pass that did nothing still writes one saying so.

These headings, in this order, because the next pass reads them:

Prefer `snapshot.sh record` over writing boilerplate by hand. Every section
must be supplied explicitly; repeat section flags for multiple items, and use
`None` for an empty section. Review the applied entry's unresolved items and
carry forward each one not closed; the script never silently copies or closes
them.

```sh
.github/skills/zen-spec-sync/scripts/snapshot.sh record \
  --mode incremental \
  --scope "model-reference-only: replace the main chat model" \
  --changed "agents.yaml: model reference now matches the specification" \
  --feedback "None" \
  --still-open "None" \
  --checks "configuration and models pass; setup check passes; Models and Specification reviewed"
```

This fills in the UTC stamp and specification hash, refuses to overwrite an
entry and leaves the baseline unchanged. It does not run checks or certify the
claims supplied to it. Run `commit` separately, only after verification.

```markdown
# Sync pass 2026-09-13T104500Z

- **Mode** - incremental
- **Spec sha** - 3f9a… (`shasum -a 256 SPECIFICATION.md`)

## Scope

What drove the pass: the diff hunks, the feedback entries, what the last pass
left open, and the first and final plans. `full` if it was a full pass.

## Changed

One row per file changed, and the specification item it closes.

## Feedback

Entries opened and entries closed, by number.

## Still open

Every specification item this pass did **not** close, with its
`SPECIFICATION-FEEDBACK.md` anchor. Empty means empty - this is what the next
pass trusts.

## Checks

`zen check`, each `scripts/_setup.sh` step, and the §9 groups: pass or fail.
```

## Write the baseline last

The one rule that must not be got wrong.

```sh
.github/skills/zen-spec-sync/scripts/snapshot.sh commit
```

runs **after** `zen check` passes, **after** setup satisfies the selected tier,
and **after** the history file is on disk. It takes the newest entry in
`.spec-sync/history/` - the stamps sort chronologically by name - records it in
`applied.txt`, and writes `manifest.txt` last of all. It refuses to run when
there is no history file, and when the newest one is the entry `applied.txt`
already names: that means this pass wrote no entry of its own.

A pass that moves the baseline early and then fails records a specification as
applied that was never applied - and the next pass diffs against it, sees
nothing, and skips the work for good. Failing with the baseline unmoved costs
one repeated pass; failing with it moved costs a requirement that is never
implemented and that nothing will report. Say in the chat which history file was
written and that the baseline moved.

## The first pass on a project that has no baseline

`mode: full`, so run the prompt as written, end to end. Then write the history
file and commit the baseline exactly as any other pass does - a project only
becomes incremental by having completed one full pass.
