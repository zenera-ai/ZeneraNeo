---
name: spec-sync-project
description: Bring the project into compliance with SPECIFICATION.md, and record every open question in SPECIFICATION-FEEDBACK.md.
argument-hint: '[file or area to focus on]'
disable-model-invocation: true
---

Make this project match `SPECIFICATION.md`. The specification is the intent;
the files are the implementation. Where they disagree, the specification wins -
except where it is ambiguous, contradictory or impossible, which is what
`SPECIFICATION-FEEDBACK.md` is for.

## 0. Decide the size of this pass

Load the `zen-spec-sync` skill first, before anything else and whatever state
the project is in - a project with no baseline is the one that needs it most,
because this pass has to make the first. Then, from the project root:

```sh
.github/skills/zen-spec-sync/scripts/snapshot.sh status
.github/skills/zen-spec-sync/scripts/snapshot.sh diff
```

`status` answers `full`, `incremental` or `tampered`. Say which in the chat
before reading anything. `full` and `tampered` mean everything below as
written, from nothing: read the whole tree, load every enabled capability's
skill, run setup in full and run the full check.

On an incremental pass, the skill owns everything that makes the pass smaller:
the scope drawn from the diffs, precedence when inputs disagree, and the pass
plan that decides which capability skills to load, which setup proof and which
check to run. Post the scope and the plan before reading the project. Wherever a
section below says **the plan**, it means that plan; on a full pass, read it as
"everything".

## 1. Read before changing anything

Read, in this order, and do not edit until all of it is read:

1. `SPECIFICATION.md` - what the system is meant to be.
2. `agents.yaml` - providers, models, embeddings, agents, tools, handoffs,
   skills, sandbox.
3. Every `agents/*instructions.md` and every file under `agents/prompts/`.
4. Every `agents/skills/*/SKILL.md`, plus what each skill folder ships.
5. `assets/`, `sandbox/Dockerfile` and every script under `scripts/`, starting
   with `scripts/_setup.sh`.
6. `SPECIFICATION-FEEDBACK.md`, if it exists - do not re-raise something already
   open there.

Never read `.tmp/logs/meta.*` - those are other runs of this command, not
evidence - nor anything of `zen`'s own (copilot instructions §0.2).

On an incremental pass this list narrows to what the plan reaches.

If an initial diagnostic is needed, run
`zen check --no-models --no-sandbox` and record what it said. A project that
does not load is the first thing to fix. Do not run expensive model or sandbox
probes both before and after a narrow edit; the final check covers them.

## 2. Build the difference

Produce a difference list before touching a file. For every item in the
specification, decide which of these it is:

- **present and correct** - leave it alone
- **missing** - the specification asks for it and nothing implements it
- **divergent** - implemented, but not as specified
- **extra** - implemented, and the specification does not ask for it
- **unclear** - the specification does not say enough to implement it

Check at least: the model and embedding ids and which agent uses which; that
every agent named in the specification exists with that job and no second job;
handoff edges and fork permissions; the tools each agent holds; every skill the
specification implies; and every setup step, index or asset it depends on.

Then build the difference the other way, because the list above can only find
what the specification asked for and nothing implements. Read every
`agents/*instructions.md`, each `agents/prompts/*.md` and each `SKILL.md` **line
by line**, and for every line name the specification item it serves. A line
serving none is an **extra** - the category covers a single sentence in a prompt,
not only a whole file. Three things to look for while reading, none of which the
forward pass can see:

- **A line that contradicts another file.** One prompt against another, a prompt
  against the house rules, or a prompt against `agents.yaml` - an instruction
  to use a tool the agent does not hold, to hand to an agent that is not in its
  `handoffs:`, or to load a skill outside its `allow:`.
- **A line that asks for something the system already supplies.** A question put
  to the user about a value that arrives from the environment, a file or an
  earlier step is unanswerable, and the answer would be discarded.
- **A line the agent cannot carry out** - naming a path it cannot reach, a tool
  it was not granted, or an agent it cannot transfer to.

These are bugs whatever the specification says: fix them in place and report each
one. An extra that is merely unspecified is reported under `➕`, not removed.

On an incremental pass the skill says which files this reverse reading covers.
Generated house-rule copies and the editor tree are never read this way.

## 3. Change the smallest thing that closes the gap

Apply the fixes in the order the copilot instructions prefer: a prompt or skill
edit over a new skill, a new skill over a new agent, a tool grant over asking
the model to compute or remember. Specifically:

- A behaviour gap is a prompt or skill edit, not a new agent.
- A fact, rate, threshold or command surface goes in a skill, never in a prompt.
- Arithmetic or a fixed transformation goes in a script under the skill folder,
  called by its absolute `/skills/<name>/…` path.
- A capability gap is a `tools:` grant plus the prompt line that says when to
  use it. A granted tool no prompt mentions is not implemented.
- A toolchain the work always needs goes in `sandbox/Dockerfile`, not in a
  prompt that installs it every run.
- If the project has a `sandbox/Dockerfile`, pin `@zenera/cli` and `@zenera/rag`
  in it to the version of `zen` in hand. Read that version with `zen --version`
  and write it into the `npm install -g` line, so the CLI an agent runs inside
  the container is the same one that built it. An unpinned name drifts away from
  the host on the next image build; a stale pin leaves the container holding an
  older `zen` than the session outside it. `zen check` reports both, as
  `sandbox.pin.absent` and `sandbox.pin.stale`, and `zen check --fix` repairs
  both by rewriting only the version after each `@zenera/*` name. The pin
  follows `zen --version` even when `SPECIFICATION.md` names another number.
  The `zen-spec-sync` skill gives the one question to raise in that case.

Never delete an **extra** without saying so. Report it, say why the
specification does not cover it, and leave it unless I tell you to remove it.
Leave it where it is, too: a line you write for a specified item does not
mention an extra, so removing it later stays a removal of its own lines.

Do not invent a value the specification does not state - a model id, a limit, a
retry count, a file path. That is an entry in `SPECIFICATION-FEEDBACK.md`, not a
guess.

## 4. Every setup step is a script

Anything the project needs done before it can run - building an index, fetching
a document, generating a file, warming the sandbox image - is a shell script,
not a paragraph of instructions for a human.

- One step per file, under `scripts/`, named after the step:
  `scripts/build-schema-index.sh`, `scripts/fetch-api-docs.sh`.
- `scripts/_setup.sh` is the **only** entry point - the leading underscore is
  what separates the runner from the steps it runs. It runs the steps in the
  order they depend on each other and is the single command that initialises the
  project. `zen init` writes it; adding a step is adding `scripts/<name>.sh` and
  its name to the `STEPS` list at the top of it. Consolidate any setup script
  that lives elsewhere into this shape, including one left at the project root.
- Every script starts `set -eu`, works from any working directory
  (`cd "$(dirname "$0")/.."` first), needs no arguments, and exits non-zero on
  failure so `scripts/_setup.sh` stops rather than continuing on a broken step.
- **Re-entrancy is required.** Running `scripts/_setup.sh` a second time must be
  safe. A step whose output is present and newer than its inputs prints that it
  is up to date and exits **3**, which is how the runner tells `skipped` from
  `ok`; otherwise it redoes the work idempotently, writing
  to a temporary path and moving it into place so an interrupted run never leaves
  a half-built artefact behind. `scripts/_setup.sh --force` redoes everything,
  and reaches each step as `$FORCE=1`.
- **Every step answers a dry run.** `scripts/_setup.sh --check` reaches each step
  as `$CHECK=1` and means: make the same "already done" test, then do none of the
  work. Exit **3** when the answer is yes, otherwise say what is missing and exit
  **4**, which the runner reports as `needs setup`. This is the one command that
  says whether the project can run without spending the download and the
  embedding to find out, so the line a step prints under `$CHECK` is the whole
  value of it: name the artefact and the command that produces it. Pass a tool's
  own words through rather than writing a second opinion: `zen rag docs ready`
  without `--quiet` already prints what is wrong and the `restore` or `index`
  that fixes it. A check must not assume an earlier step has run: a missing
  prerequisite is a 4 of its own, not a failure, or the first unbuilt thing
  hides everything after it.
- **A step's "already done" test must name something that survives a clone.**
  Git-ignored output does not. A rag index commits its `manifest.json` and
  ignores `lance/`, so `[ -f "$OUT/manifest.json" ]` is true on a fresh checkout
  that cannot search at all - every step reports `skipped` and the failure
  surfaces much later, as a search error nobody connects to setup. Ask the tool
  rather than guessing at files: `zen rag docs ready --dir "$OUT" --quiet` exits
  0 when the index can answer and 3 when it cannot, and
  `zen rag docs restore --dir "$OUT"` re-embeds it from the copies it already
  holds instead of indexing the documents again. A step that builds an index
  looks like this:

    ```sh
    if [ "${FORCE:-0}" = 0 ] && zen rag docs ready --dir "$OUT" --quiet; then
        echo "$OUT is already built"
        exit 3
    fi
    if [ "${CHECK:-0}" = 1 ]; then
        zen rag docs ready --dir "$OUT" || true   # its reason and its fix
        exit 4
    fi
    if [ "${FORCE:-0}" = 0 ] && [ -f "$OUT/manifest.json" ]; then
        zen rag docs restore --dir "$OUT"   # committed index, ignored vectors
        exit 0
    fi
    rm -rf .tmp/docs-db
    zen rag docs index assets/docs --embedding <ref> --out .tmp/docs-db
    rm -rf "$OUT" && mv .tmp/docs-db "$OUT"
    ```

- **It must be watchable.** `scripts/_setup.sh` tees each step's output to
  `.tmp/logs/setup-<step>.log`, prints a heartbeat line while a long step runs,
  and finishes with one line per step: `ok`, `skipped`, `needs setup`, or
  `failed`.
- **Everything transient goes under `.tmp/`** - logs, scratch files, downloads,
  test output, and the temporary path a step writes to before moving its
  artefact into place. Nothing else in the tree is a scratch directory, and
  `.tmp/` is git-ignored: add it to `.gitignore` if it is not there already.
  Deleting `.tmp/` must leave the project runnable and `scripts/_setup.sh`
  re-runnable.
- Steps that need credentials run on the host, not in the sandbox. Read keys
  from the environment or `.env`; never inline one into a script. Model
  provider keys are not among them: `zen` supplies those from its keyring, so
  no step checks for, requires or documents one.
- Anything the sandbox always needs belongs in `sandbox/Dockerfile`, not in a
  setup script that installs it again on every run.

## 5. Write `SPECIFICATION-FEEDBACK.md`

Create or update `SPECIFICATION-FEEDBACK.md` at the project root whenever
anything in the
specification is unclear, contradictory, impossible, or wrong. If there is
nothing to raise, say so in the chat and do not create the file.

**It is a questionnaire, and answering it must take one gesture.** Every
question carries two to four written-out answers, each with a `[ ]` box in its
heading. The reader marks the box of the one they want - `[x]` - and deletes the
others, then sends `/spec-apply-feedback`, which folds what survived into
`SPECIFICATION.md`. Either gesture alone is enough, and the file says so in
every question.

Two rules that come before everything else in this section:

- **No markdown tables anywhere in this file.** A table is unreadable the moment
  a pane is narrow or a cell wraps, and this is a file people read in a side
  panel. Every list is a list.
- **Never write a question the reader has to do work to answer.** No paragraph
  ending in "is that what you meant?", nothing that requires reading the
  implementation, and no answer phrased as a decision still to be made. If you
  cannot write two answers a reader could pick between, you have not understood
  the problem well enough to ask about it yet.

The file opens with one short paragraph: how many questions are open, and how to
answer them - put an `x` in the box of the answer you want, delete the answers
you do not want, or replace them all with a sentence of your own, then send
`/spec-apply-feedback`. Then a contents list, one line per question: its
number as an anchor link, the question in under ten words, and what is built in
the meantime. Then the questions, grouped under these headings, omitting any
heading with no questions. The file is scanned before it is read, so keep the
emoji on every heading:

```markdown
# Feedback on SPECIFICATION.md

## 🛑 Blocking - cannot implement without an answer

## ❓ Ambiguous - implemented one way, confirm the choice

## ⚡ Contradictions

## ✏️ Errors and typos

## ➕ Out of scope - implemented but unspecified

## ✅ Answered - folded into the specification
```

`✅` is written by `/spec-apply-feedback`, not by you. Leave what is there
alone except to strike an entry this pass has actually implemented, and say in
the chat which ones you closed.

### The shape of one question

Each question is its own `###` heading - the emoji of its section, `Q` and a
number, then the question itself, ending in a question mark. Under it, in this
order:

- **Where it comes from** - the specification text quoted as a blockquote,
  introduced by a link to the exact line,
  `[SPECIFICATION.md#L66](SPECIFICATION.md#L66)`, plus the section name. Link
  every line you quote; a reader must reach it in one click. For a question
  about something the specification does not say at all, link the section it
  would belong to and say that it is silent there.
- **Why it is a problem** - two or three sentences on what goes wrong, in terms
  of behaviour: what an agent does, what a run produces, what breaks. Not
  "unclear" or "ambiguous", which describe the sentence rather than the damage.
- **Built in the meantime** - what the implementation does now, and the one fact
  that made it the default. Or "Nothing - blocked."
- **To answer** - the same sentence on every question, word for word: put an `x`
  in one box below and delete the other answers, either one is enough.

Then two to four answers, each its own `####` heading of the form
`#### [ ] A. <the answer in one line, as the reader would say it>`. The one that
is implemented comes first and is marked `_(built)_`, so the file reads as "this
is what happens if you change nothing"; mark one `_(recommended)_` where it is
better for a reason the reader can check. Under each answer heading:

- **What it changes** - one or two sentences on the consequence of choosing it:
  what the system would then do differently, and what it costs.
- **The specification text**, in a fenced block, introduced by where it goes -
  "replace line 66", "add after line 21", "delete lines 30-32". Written in the
  specification's own voice and format so it can be pasted without editing.

Every answer carries its own box and its own text. They are alternatives that
will be read alone, so nothing may be shared between them and nothing may refer
to a sibling ("as above", "same as A"). Where an answer needs a value only the
reader has, put a `<placeholder>` in the block and say in **What it changes**
what to substitute.

Two rules on the answers themselves:

- **An answer is a real alternative**, not a restatement of the question or a
  hedge. "Decide later" is not an answer; "leave it unspecified, and the
  reviewer keeps using whatever the default agent uses" is.
- **Never write only one answer.** A question with nothing to choose between is
  not a question. Even an `✏️` typo has two: the correction, and leaving it as
  written with a line saying what stays wrong.

Under `➕` the two answers are fixed: keep it, whose block is the specification
text that would cover what was built, and remove it, whose **What it changes**
says what removing it would cost and which files would go.

### One question, written out

Copy this shape exactly - the outer fence is four backticks only so the example
can contain its own:

````markdown
### ❓ Q4. Do the three agents share one memory, or keep their own?

**Where it comes from** - [SPECIFICATION.md#L14](SPECIFICATION.md#L14), _Common
memory strategies_:

> use memory to save plans of answering what was delegated to what

**Why it is a problem** - the specification says what each agent writes and
never says who may read it. Memory is one graph with an audience on every node,
so this decides whether the orchestrator can plan from what a specialist
resolved last week, or re-derives it every time.

**Built in the meantime** - one shared slice: `memory: true` on all three, so
anything one agent writes, another can recall. Chosen because nothing in the
specification separates them.

**To answer** - put an `x` in one box below and delete the other answers. Either
one is enough.

#### [ ] A. All three agents share one memory _(built)_

**What it changes** - a lookup is paid for once for the whole system, and every
agent's recall competes with every other agent's notes for the same few slots.

Add under _Common memory strategies_, after line 17:

```markdown
All three agents read and write one shared memory: whatever one of them
discovers is recallable by the others.
```

#### [ ] B. Each agent keeps its own memory

**What it changes** - recall gets sharper and cheaper because an agent only ever
sees its own kind of note, and the same lookup is repeated by whoever did not do
it first.

Add under _Common memory strategies_, after line 17:

```markdown
Each agent reads and writes only its own memory. A finding one agent needs from
another travels as part of the hand-off, not through the store.
```
````

Use no emoji except the one on each heading. Keep the prose short. Do not
editorialise about the specification's quality, do not restate the runtime, and
do not copy a whole section in.

Append to the existing file rather than rewriting it, keeping the numbering and
the contents list in step. Numbers are never reused: a struck question's number
retires with it.

A question the human answered since the last pass is work to close, not a
question to ask again; the skill says how to implement or supersede it.

## 6. Run `scripts/_setup.sh` and watch it finish

Run setup to the proof the plan names. When it names a full run, a pass is not
done until `scripts/_setup.sh` has run to completion in this session, as below.

It is slow - embedding a large corpus is hours, and the progress line says how
many - so start it in the background and follow the logs instead of waiting
blind:

- Tail `.tmp/logs/setup-*.log` and check the output artefact is still growing.
- **Slow is not failed.** A step has failed when it exits non-zero, or when its
  log has not grown for 10 minutes. A long estimate is the answer to how long
  the step takes, not a problem to investigate.
- **Wait in a loop, never in one long sleep.** Sleep at most 30 seconds at a
  time, then check the log and say what it shows, and repeat until the step
  finishes. A single long block makes the run unwatchable and hides a failure
  that happened in the first ten seconds.
- Report progress as you go: which step is running, how long it has been going,
  what the last log line said.
- Do not kill a quiet step. Confirm the process is dead or the log and the
  output have both stopped growing before calling it stuck.
- On failure, read that step's log, fix the cause, and run `scripts/_setup.sh`
  again - re-running is the fix path, not a reset. If the same step fails twice
  for the same reason, stop and raise it in `SPECIFICATION-FEEDBACK.md`.
- The cause you fix is in the project: the step's script, its inputs,
  `agents.yaml`. When the log points inside `zen` itself, do not go looking -
  quote the command and the line in `SPECIFICATION-FEEDBACK.md`, report the step
  as failed, and go on to §7.
- Prove re-entrancy: once it has succeeded, run `scripts/_setup.sh` once more and
  check that every step reports `skipped` rather than rebuilding.
- Prove the dry run: `scripts/_setup.sh --check` must then report every step
  `skipped` and exit 0. `needs setup` for something setup has just built means
  the step's two tests disagree, and one of them is wrong.
- **`skipped` on a machine that has never built it is a bug, not a pass.** A
  step that tests for a committed file skips on a fresh clone and leaves the
  project unusable. For every index the project builds, check it can actually
  answer - `zen rag docs ready --dir <dir>` - and fix the step's test if the
  answer disagrees with what setup reported.

## 7. Verify and report

After the final edit and setup, re-plan, then run the check the final plan names
(`.github/skills/zen-review/scripts/review.sh check full --fix` on a full pass)
and fix whatever it names rather than working around it. Run it once; edits
after it invalidate it. Then run `review.sh --skip-check` in the same mode for
the mechanical review, which reuses the receipt instead of probing again.
That validates structure and says nothing about the prose, so work §9 of the
copilot instructions as a checklist afterwards and report each group pass or
fail, narrowed only by the plan. Then report in the chat:

- what changed, file by file, and which specification item each change closes
- every prompt or skill line that served no specification item, and what became
  of it - corrected, or reported and left alone
- the outcome of every `scripts/_setup.sh` step, and what each one produced
- what is still open, with a pointer to its `SPECIFICATION-FEEDBACK.md` entry
- anything you found that the specification does not cover at all

## 8. Record the pass

Last, and only once §6 and §7 have actually passed: write the history entry
with `snapshot.sh record`, including both plans and `Still open`, then
`snapshot.sh commit`. Never the other way round; the skill says why and how.
A pass that changed nothing still records and commits. Say in the chat which
history file you wrote and that the baseline moved.

Do not report a specification item as done unless the file that implements it
exists, `zen check` passes, and setup satisfies the plan's proof.
