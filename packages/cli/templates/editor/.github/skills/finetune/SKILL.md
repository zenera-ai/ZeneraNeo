---
name: finetune
description: Fine-tune this project against a training set, a batch at a time - every batch first with no memory, fixing the instructions, then with the memory it just built, making the same work cheaper - starting from a 3-case smoke test and doubling each smooth batch, until every case is used and no difficult case is open.
argument-hint: '[training set] [limit]'
disable-model-invocation: true
---

Tune this project against real queries. Nothing here touches model weights: what
changes is the prose the project is made of - the agent prompts, the skills and
the house rules under `agents/` - and the evidence is the trajectories the
queries produce.

**Load the `zen-finetune` skill before anything else**, and load `zen-inspect`,
`zen-analyze-run`, `zen-topology` and `zen-inspect-ask` before you grade, and
`zen-instructions` before you write a policy file. This command is the order of the work; the skill
is how each step is done, and it holds the rules that are easy to get wrong. If
loading a skill fails, read `.github/skills/<name>/SKILL.md` with your file tool
before going on - never carry on without it.

**Read runs and memories through commands, never by code.** Do not open
`output.json`, `batch.json`, `state.json`, `graph.json` or `manifest.json` with
`node -e`, `python -c`, `jq` or a script of your own - every question has a
command:

| Question                                     | Command                                                           |
| -------------------------------------------- | ----------------------------------------------------------------- |
| each case's trajectory directory             | `report.mjs -d "$RUN/batch" paths [id...]`                        |
| what each case answered, under its rubric    | `report.mjs -d "$RUN/batch" answers [id...]`                      |
| what each case committed to memory           | `report.mjs -d "$RUN/batch" commits [id...]`                      |
| every recall and memory tool step            | `report.mjs -d "$RUN/batch" recalls [id...]`                      |
| one memory node in full                      | `zen memory show <node-id> --dir "$RUN/batch/<id>/memory"`        |
| a whole memory, or what one added to another | `zen memory ls --dir <dir>`, `zen memory diff <base> --dir <dir>` |

This command is **reentrant**. Tuning is long and gets interrupted - a run dies, a
session ends, I stop you mid-batch. Every step leaves its result on disk under
`finetune/`, so a second invocation does not start over: it reads that state,
works out where the work stopped, says so, and carries on from there unless I
tell you otherwise.

## Words used here

Use these words, and only these, in everything you write - findings, README,
reports to me. Two words for one thing is how a reader loses the thread.

| Word                 | Means                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------- |
| **case**             | one query from the training set, with its rubric if it has one                               |
| **dataset**          | every case in the training set, `finetune/dataset.json` - never cut down                     |
| **limit**            | how many cases this tuning uses - the whole dataset, unless I gave a smaller number          |
| **selection**        | those cases, evenly by class, rubric and complex first, `finetune/selection.json`            |
| **batch**            | the cases worked on together until they pass without memory and then with it                 |
| **batch size**       | how many new cases a batch takes - 3 for batch 1, doubling after each smooth batch, to a max |
| **recheck cases**    | cases from earlier batches, run again - difficult ones first, then complex ones              |
| **run**              | one execution of a batch's cases - a no-memory run or a with-memory run                      |
| **no-memory run**    | every case starts from an empty memory and writes its own: tunes the instructions            |
| **with-memory run**  | every case starts from its own copy of the candidate memory: tunes the memory policy         |
| **proposal**         | one improvement a case's grading suggests - merged with the others before anything is edited |
| **passed**           | a run where every case is right AND its review found nothing left to cut                     |
| **concurrency**      | how many cases execute at the same time inside a run - 16 at most, halved on OOM             |
| **trajectory**       | what one case did in one run - its graph                                                     |
| **difficult case**   | a case that caused real trouble - listed in `finetune/difficult.json`, retested until fixed  |
| **candidate memory** | the last good memory plus what the batch's passing no-memory run committed                   |
| **last good memory** | every passed batch's candidate, in turn; always whole on disk                                |

Run directories are `finetune/runs/batch<NN>-<nomem|mem>-run<N>/` -
`batch03-nomem-run2` is batch 3's second run without memory, `batch03-mem-run1`
its first with memory. Each holds a `batch/` folder: that is `zen run batch`'s
own output for that run, named by the command, not by this method.

## What a batch is

The selection is not run all at once. After one big run there is too much to
read, and after one big edit nobody can say which change helped. So it is
worked a **batch** at a time, and each batch is decided when it is needed:

```
size       = 3 for batch 1 - a smoke test
           = twice the last batch, up to maxBatch, if it went smoothly
             (at most 2 runs of each kind, no case put on the difficult list)
           = the same as the last batch otherwise
next batch = that many new cases    (not used yet: classes taking turns,
                                     rubric and complex cases first)
           + up to recheck earlier cases  (open difficult first, then fixed
                                           difficult, then complex, then the rest)
```

Then every case of the batch goes through the same fifteen steps:

**Without memory**

1. **Run** the batch with no memory.
2. **Analyze** every trajectory: right? what did it cost? where is it
   suboptimal? `zen inspect ask` the model at each critical point.
3. **See what it committed** to memory - durable facts, or live readings?
4. **Propose** improvements, per case.
5. **Merge** the proposals of every case into patterns.
6. **Update** prompts, skills, house rules, policies - create what is missing.
7. **Run again**, no memory, the same cases.
8. **See** whether the edits worked and fixed everything. If not, back to 2 -
   at most 4 no-memory runs. When every case is right and nothing is left to
   cut, the run **passes**.

**With memory**

9. **Build the candidate**: the last good memory plus what every case of the
   passing run committed, merged - what the graph already held is folded, not
   added.
10. **Run** the batch with memory: **every case gets its own copy** of the
    candidate.
11. **Analyze the memory use** - recall, savings, re-commits - with
    `zen inspect ask` and the other tools.
12. **Merge** the proposals.
13. **Update** the memory policy.
14. **Run again** from the same candidate. Back to 11 until it passes - at most
    4 with-memory runs.
15. **Keep it**: the candidate becomes the last good memory, and the next batch
    is built, with the difficult and complex cases tracked for rechecks.

A run whose cases are all correct has **not** passed: that is exactly when the
cost work starts. Being right is the entry ticket; the tuning is making it
cheap - first without memory, then with it.

The recheck cases are there to fail - a rule written for batch 3 is read on every
query, and the case it breaks is usually in batch 1.

### Difficult cases, and why the number of batches is not fixed

Some cases cause most of the trouble. Put each on the difficult list the moment
grading shows it - `difficult.mjs add` - and it keeps coming back:

- **Open difficult cases come first** in every later batch's rechecks, until
  fixed.
- **Fixed ones stay ahead of the other rechecks**, because what was hard once
  breaks again first.
- **A batch that added one does not grow the next.**
- **When the selection is used up**, a batch is made of open difficult cases
  only. So the tuning takes as many batches as it needs.
- **Stuck is reported, not looped.** A case still open after `maxRetries`
  batches since it was added (default 3) is `stuck` - the model's ceiling or a
  bad rubric - and stops being picked.

The tuning is over when **every case in the selection has been used and no
difficult case is open** - then comes the final check.

### The memory

When a no-memory run passes, `memory.mjs candidate <run>` copies the last good
memory into a new directory and merges in what each of that run's cases
committed. Every with-memory run of the batch starts from that candidate, a
copy per case, so no case's commits reach another case or the candidate. When a
with-memory run passes, `memory.mjs checkpoint <run>` makes the candidate the
last good memory - switching only when it is complete. So whenever the tuning
stops - finished, or killed mid-run - `memory.mjs path` names a whole graph
holding everything the passed batches learned, ready to promote into `memory/`.

## No memory first, then memory - in every batch

Never run them together, and never run a batch with memory before it passed
without. Say which kind of run you are in at the top of every report.

**No-memory runs.** Every case starts from an empty memory, so a right answer is
the instructions' doing and not something remembered. Here you tune agent
prompts, `agents/instructions.md`, the project's skills and policy files -
creating or updating them. The runs still _write_ memory, each into its own
throwaway graph, and what they write is graded too: commits must be durable,
generalisable facts, not cached live readings - because the candidate is built
from them. These runs optimise **correctness** first, then the cost of getting
there - fewer llm calls, then better fan-out with forks, then fewer things
discovered that could have been known.

**With-memory runs.** The same cases, from the candidate. They optimise **memory
use and memory correctness**, and the expected result is a dramatic drop in
tokens and wall clock with no verdict changed - and **no commit of anything the
memory already held**: every such commit is a call spent on nothing. The only
prose they edit is the memory policy - `agents/memory-policy-instructions.md`,
or the memory paragraph a `why` line names. A finding that needs any other
prose is an open problem whose cases go on the difficult list; the next batch's
no-memory runs fix it.

## The README

`finetune/README.md` is the page I read to know what is going on. **You write
it**, by hand, for a person who has never seen this project - not a log dump.
Start from `.github/skills/zen-finetune/references/readme-template.md`.

- **Before the first run**, write it whole: what is being tuned and why, the
  dataset by class, the limit and how the cases were chosen, what a batch is and
  how it grows, its two halves, the settings - and a mermaid **map** from the
  dataset to the final check, with the batches the growth rule gives if every
  batch is smooth drawn ahead, each with its no-memory and with-memory half.
- **After every step** - a run finishing, a run graded, edits applied, a
  candidate built, a batch passing - patch it: "Where we are", the map (move
  nodes between the `done` / `now` / `ahead` / `failed` classes, update their
  labels, add a node when a batch the plan did not foresee is built), the
  batch's row, "Difficult cases", a log entry, "Results so far" when a batch
  passes, and "Next".

The map is the first thing I look at: it must always show exactly one `now` node,
everything behind it as done, and everything ahead of it as ahead, with a line
saying what is left - unused cases and open difficult ones. Link me to the README
in your reports instead of re-typing it.

## Where you are - work this out before anything else

Do this every time this command runs, including the first:

```sh
.github/skills/zen-finetune/scripts/next.mjs
.github/skills/zen-finetune/scripts/batch.mjs      # progress: used, left, next size, difficult
.github/skills/zen-finetune/scripts/memory.mjs     # the candidate and the last good memory
```

`next.mjs` reads the whole `finetune/` tree and prints the next step. Do not
re-derive the state from an `ls`. Map what it says onto this command:

| What `next.mjs` says                                             | Go to                                                                             |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `first: patch finetune/README.md ...`                            | patch the README, then act on the next line                                       |
| `note: limit N of T cases ...`                                   | unless I asked for a cut: section 2, raise the limit and re-select, then carry on |
| `build finetune/dataset.json ...`                                | section 0, then 1                                                                 |
| `write finetune/config.json ...`                                 | section 2                                                                         |
| `choose the cases: select.mjs ...`                               | section 2                                                                         |
| `write finetune/README.md: the plan ...`                         | section 2, the README step                                                        |
| `build batch 1: batch.mjs next ...`                              | section 3                                                                         |
| `... not run yet - zen run batch ...`                            | run exactly that, then section 4 (no memory) or 7 (with memory)                   |
| `... the run never finished ...`                                 | the run is **void** - see below, then re-run                                      |
| `batchNN-nomem-runN: not graded yet - report.mjs ... oom ...`    | section 4                                                                         |
| `batchNN-mem-runN: not graded yet - report.mjs ... oom ...`      | section 7, analyze                                                                |
| `... void - out of memory at concurrency C: set ...`             | do exactly that - halve it, re-run the cases                                      |
| `... void - ... the floor ...`                                   | stop and tell me - the only machine stop                                          |
| `... says PASSED but has no "## Cost review" ...`                | section 4, the cost review                                                        |
| `... says PASSED but has no "## Memory review" ...`              | section 7, the memory review                                                      |
| `batchNN-nomem-runN: graded, nothing applied ...`                | section 5                                                                         |
| `batchNN-mem-runN: graded, nothing applied ...`                  | section 7, merge and update                                                       |
| `edits applied - confirm them: ... zen run batch ...`            | run exactly that, then section 6 (no memory) or 7 (with memory)                   |
| `... says PASSED but applied edits ...`                          | confirm them with another run of the same kind                                    |
| `batch N has had 4 ... runs - stop tuning it ...`                | section 6 or 7, the run cap                                                       |
| `... passed without memory - build the candidate memory: ...`    | section 6, the candidate                                                          |
| `batch N passed without memory and the candidate is built - ...` | section 7                                                                         |
| `batch N passed with memory - keep its memory first: ...`        | section 7, the checkpoint                                                         |
| `batch N passed (...) - build batch N+1: batch.mjs next ...`     | section 3 for the new batch                                                       |
| `every case used, none open ... run the final check ...`         | section 8                                                                         |
| `done - ...`                                                     | nothing left to tune - report and stop                                            |

Read the latest run's `findings.md` for the verdict and its `changes.md` for what
was already applied. Two things `next.mjs` cannot see, so check them by hand:

- **Uncommitted edits under `agents/` with no `changes.md` to explain them.** An
  apply was interrupted part-way. Read `git status --short agents/` and the diff,
  finish writing `changes.md` from what is actually on disk, then re-run - do not
  layer new edits on top of edits you have not recorded.
- **`zen check` before you resume anything.** A project left broken mid-edit
  fails every case identically and looks like a catastrophic regression.

A run whose `batch/` never got a `batch.json` produced no evidence. Move it aside
rather than grading or deleting it - `mv finetune/runs/<run>/batch
finetune/runs/<run>/batch.partial` - and re-run from the same `cases.json`.

A run `report.mjs oom` calls void (any exit 137) is out of memory. Write
`## VOID` in its `findings.md`, halve `concurrency` in `finetune/config.json` -
never below 4 - and run a copy of its `cases.json` as the next run. A void run is
not graded and does not count toward the run cap. Void at concurrency 4 means
the machine cannot run the batch: stop and tell me.

Resuming never re-selects and never rebuilds a batch. `minBatch`, `maxBatch`,
`recheck` and `seed` in `finetune/config.json` are frozen once batch 1 has run.
Every later run of a batch - no memory or with memory - re-uses **its first
run's `cases.json`, copied** - never rebuilt, because the rechecks depend on the
difficult list, which moves. `findings.md`, `changes.md`, `difficult.json` and
the README are the record; read them rather than remembering.

Then tell me, in three lines before you do any work: which batch and which half
(no memory or with memory) you are resuming at and the limit as
`limit N of T cases`, which step of the fifteen, and what you are about to run -
and then **keep going**. If I named a batch or a run, do that instead of what
the state says.

### Run to the end

Once started, run the whole tuning - every batch, both halves, the final check -
**without stopping to ask**. Between runs, between halves and between batches,
report and carry on. `next.mjs` printing `done - ...` is the only normal end.

**Never end your turn to wait for a command.** A `zen run batch` outlasts the
wait of the tool that started it. When a tool says the command is still running,
read its output again in your next call (`read_bash` with a delay, or your
terminal's equivalent), and repeat until it has completed.

Stop and wait for me only when:

- **The machine cannot run the batch** - it ran out of memory at concurrency 4.
- **I asked you to pause** - after each batch, or anywhere else.

Everything that used to be a question is now a note that does not stop the work:

- **A structural finding** - the fix needs `agents.yaml`. Do not edit it; write
  the finding under "Open problems" in the README, put the cases it blocks on the
  difficult list, and carry on. It is in the final report.
- **A with-memory finding that needs other prose.** Note it under "Open
  problems", put its cases on the difficult list, finish the batch; the next
  batch's no-memory runs fix it.

When a batch passes, post a short note - batch, size, runs of each kind, cases
right, llm calls and tokens without memory first run to last and with memory
against without, re-commits, what changed, what is left - patch the README, and
build the next batch straight away. Never end your turn with "proposed next
step" or "ready to proceed upon your confirmation"; take the step.

`finetune/USAGE.md` is the token bill - project agents, you, and every
`zen inspect ask` - by model, batch, run and stage. `next.mjs` rewrites
it; never edit it, and link it rather than copying its numbers.

## 0. Before the first run

Name the training set. If I have not given you one, ask - a specification
section, a file of examples, a transcript, a CSV. Fewer than about eight queries
is a debugging session, not a tuning loop; say so and read the runs singly
instead.

Then run the mechanical checks and report what they say:

```sh
zen check
.github/skills/zen-review/scripts/check-paths.sh
```

A project that does not load fails every case for one reason. Do not start until
`zen check` passes.

## 1. Dataset - all of it

Build `finetune/dataset.json` if it is not there, and read it if it is. **Read
the whole training set and write every case into it** - no limit, no sampling,
no "the first twenty". The dataset is the record of what the project is meant to
handle; the limit is applied later, when cases are selected, and only there.

Read the source yourself and write the structure out - do not write a parser.
Rubrics are copied **verbatim**, one entry per bullet. Classify only the
distinctions the source already makes, and rate complexity by the trajectory the
query demands, not by the length of the sentence. Keep ids stable across
re-extractions. Report the count per class when you are done.

## 2. Settings, selection, README

**Settings.** You now know the dataset size. Set the limit, propose the batch
sizes, recheck and concurrency, say what each costs, and write them to
`finetune/config.json` - every script reads its defaults from there:

```json
{
    "datasetSize": 64,
    "limit": 64,
    "minBatch": 3,
    "maxBatch": 10,
    "recheck": 3,
    "concurrency": 13,
    "seed": 1,
    "maxRetries": 3
}
```

- **limit** - **equal to `datasetSize`**: every case in the dataset is tuned
  against. Write a smaller number only when I gave you one. Never cut it on your
  own to save cost or time - a limit below the dataset silently drops cases the
  project is meant to handle.
- **minBatch** - new cases in batch 1, the smoke test. 3.
- **maxBatch** - the most new cases a batch grows to. Small enough that you will
  actually read every trajectory; 8-12 is the usable range. `batch.mjs` doubles
  from `minBatch` towards it after each smooth batch - you do not size batches
  by hand. **Not the same as concurrency.**
- **recheck** - earlier cases re-run in each batch. 2-4. Zero means no
  regression guard and no retesting of difficult cases.
- **concurrency** - the most cases running at once: `min(maxBatch + recheck, 16)`.
  Do not size it any other way. On an out-of-memory run (exit 137) halve it,
  never below 4, and re-run the same cases. The only setting that changes
  mid-way.
- **maxRetries** - batches a difficult case gets after it is added before it is
  `stuck`. 3.

**Selection.** Choose the cases:

```sh
.github/skills/zen-finetune/scripts/select.mjs -o finetune/selection.json
```

It takes the limit from the **whole** dataset, evenly by class - one case from
each class in turn; inside a class, cases with a rubric first, and the most
complex first - and that order is the order batches take new cases in, so the
first small batches hold the hard, graded cases. It prints chosen-versus-available
per class; report that table to me. A class with fewer cases than its share gives
all it has.

**README.** Write `finetune/README.md` now, before anything runs - see "The
README" above.

## 3. Build a batch, run it without memory (step 1)

```sh
RUN=finetune/runs/batch01-nomem-run1
C=$(node -p 'require("./finetune/config.json").concurrency')
.github/skills/zen-finetune/scripts/batch.mjs next -o "$RUN/cases.json"
zen run batch --input "$RUN/cases.json" \
    --batch-dir "$RUN/batch" --memory finetune/empty --concurrency "$C"
```

`--concurrency` is always the value in `finetune/config.json` - read it fresh
for every run, since an out-of-memory run halves it.

`batch.mjs next` prints the size and why, which cases are new and which are
rechecks, and writes the same into `plan.json` beside `cases.json` - put that in
the README's batch row. Then patch the README: the map's `now` node, the row, a
log line.

Batch 1 is a smoke test. If its cases crash - the project, the sandbox, a key -
that is not the prose: fix it and run the three again before grading anything.

Every no-memory run has no memory. A graph with content lets a run succeed by
recall instead of by instruction. `finetune/empty` is never created - naming a
directory that does not exist is what gives each case an empty memory.

Never hand-write a `cases.json`, and never re-select mid-way. Build a batch once,
for its first no-memory run, with `batch.mjs next`; every later run of that
batch - no memory or with memory - gets a **copy** of that file, which is what
makes one run comparable to the next.

## 4. Grade without memory (steps 2-4)

`report.mjs oom` first - a run with any exit 137 is void, is not graded, and its
tokens are compared to nothing. Then read the answers (`report.mjs answers`) and
the graphs before the numbers. Grade
every case against all eight criteria in the skill: rubric compliance,
optimality, memory hygiene, fork, delegation, tools and skills, grounding,
failure handling. **Cite a node id for every finding.** A finding you cannot
point at in the graph did not happen.

Where a node shows **what** went wrong but not **why** - memory not searched,
lookups not forked, a skill not followed, a tool misused - ask the model at the
call that made the choice, once per pattern: `zen inspect ask`, worded as
**zen-inspect-ask** says. Load that skill before the first ask of the run, even
if you loaded it in an earlier run. A rule written in section 5 without the
sentence an ask named is a guess.

Grade in this order, because they are not equally urgent:

1. **The recheck cases.** A recheck that passed before and fails now means a
   rule written since broke it, and that outranks every other failure in the
   run - nothing else is worth grading until it is resolved.
2. **Correctness of the new cases.** Rubric compliance gates everything.
3. **The cost of getting there** - as soon as correctness holds, and in the same
   run. llm calls first - read straight off the graph header - then fan-out, then
   discovery the run should not have needed because something authoritative
   could have told it.

**The cost review is not optional.** Every `findings.md` of a run where all cases
are right has a `## Cost review` section - `next.mjs` refuses a `PASSED` without
one. It contains:

- the llm calls per case, the batch's median, and every case above 1.5x the
  median with the reason it cost that much, citing nodes;
- **repeated work** - the same call with the same arguments twice, a loop, a
  search made as four calls that could have been one: the pattern, or `none`;
- **missed forks** - independent calls or sub-tasks run one after another: the
  pattern, or `none`;
- **unneeded discovery** - listing, probing or reading to learn something a
  prompt or skill could simply have stated: the pattern, or `none`;
- **excess prose** - every paragraph, example, table row, skill and skill
  binding the agents carried this run that no trajectory needed: a rule nothing
  in the run tested, a second wording of a rule stated elsewhere, a rationale
  the model does not act on, a preloaded skill no case used, a skill bound to an
  agent that never needs it. Grep the assembled prefix - prompt, house rules,
  every preloaded and loaded skill - and list each with its file and lines, or
  `none`. Every token of it is paid on every call of every case.

`none` needs the evidence for it - the trajectory you checked, not the absence
of a look. A case averaging 40+ llm calls almost never has `none` on all three.

**See what each case committed** (step 3), as seriously as the answer it gave.
Start from `report.mjs -d "$RUN/batch" memory` for the counts, then
`report.mjs -d "$RUN/batch" commits` for every node each case committed: every
commit should be an operation, a pointer, a shape or a
rule that is still true next week. A cached live reading poisons every future
run, and committing nothing after learning something durable throws the run
away. The candidate memory is built from exactly these commits, so commit
policy is fixed here, without memory, while the cause is still attributable.

**End every case with its proposals** (step 4): what that case alone says should
change - criterion, file, the sentence its `why` line named, the edit. They are
not edits yet; section 5 merges them.

Write `$RUN/findings.md`: the verdict heading first - `PROGRESS`, `NO CHANGE`,
`REGRESSION`, `MIXED`, `CORRECT`, `PASSED` or `VOID` - the `memory:` and
`machine:` lines as printed, and the `report.mjs compare` table with the recheck
cases marked; then the cost review; then the per-case grading, each case ending
in its proposals. The title names the run and says `NO MEMORY` or
`WITH MEMORY`. Then patch the README.

`CORRECT` means every case is right but the cost review found something worth
changing - apply it and run again. `PASSED` means every case is right **and** the
cost review found nothing worth changing, so this run applies no edits. It is
load-bearing: `next.mjs` reads it to move on, and refuses it on a run with a
`changes.md` or without a cost review. Never write it on a run that merely
improved, and never on a run you are about to edit after.

**Then update the difficult list** - mechanically, every graded run:

```sh
D=.github/skills/zen-finetune/scripts/difficult.mjs
$D add <id> --why wrong     --run <run> --note "<what goes wrong>"  # wrong after a run that tried to fix it
$D add <id> --why regressed --run <run>                              # a recheck case that failed
$D add <id> --why flaky     --run <run>                              # right before, wrong now, no rule aimed at it
$D add <id> --why memory    --run <run> --note "<what goes wrong>"  # with memory: wrong, no cheaper, or re-commits, after a fix
$D add <id> --why costly    --run <run>                              # over 2x the median llm calls in a passing run
$D fix <id> --run <run>                                              # a difficult case right, in a PASSED run
$D                                                                   # the list
```

A case wrong on run 1 is not difficult yet - that is what the batch is for. It
is difficult when it is **still** wrong after a run that tried to fix it.

## 5. Merge the proposals, then apply (steps 5-6)

If a recheck case failed, stop here and revert or narrow the rule that broke it.
Find it in the earlier batches' `changes.md`, undo or qualify it, record the
over-reach, and go straight to the next run. Adding a rule on top of a rule that
over-reached is how a tuning ends with prose nobody can unpick.

Otherwise: collect every case's proposals into one table before writing a word
of instruction - wrong answers and cost findings alike - and write it into
`findings.md` under `## Proposals, merged`, one row per pattern with the cases
and nodes behind it. Two proposals saying the same thing in different words are
one pattern; two proposing opposite edits to one sentence are a conflict, and
the conflict is the finding. A cost pattern is a rule
just as a correctness pattern is: "these three cases each listed the directory
to find a file the skill could name" becomes a line in that skill; "these ran
four independent lookups in sequence" becomes a fan-out rule in the prompt. The
unit of change is a pattern across proposals, not a proposal: three cases missing
the same beat is a rule, one case is a note in `findings.md`. The three do not
have to be in this batch - grep the earlier runs' findings before calling
something an anecdote. Each cost or behaviour pattern carries the sentence its
`zen inspect ask` named - verified by grep in the recorded request - or
`no instruction`: that sentence is what the rule edits. For a difficult case, read its notes (`difficult.mjs`)
and every earlier `findings.md` that names it first: the rules already tried and
failed are the most useful thing you know about it. Write the rule one level up
from the case that produced it; a rule that names the dataset's own endpoints
makes the eval pass and the product fail. Prefer mechanical wording, and
remember that a prohibition with a self-judged exemption is a permission.

**Cut as well as add.** Every apply also removes what the excess-prose review
found: delete duplicated rules (keep one copy, in the place the routing below
names), collapse paragraphs to the sentence the model acts on, drop examples
and rationale no trajectory used, and delete skill sections no case needed. A
skill binding or preload no case needed lives in `agents.yaml` - record it as
an open problem, do not edit it. A rule written in an earlier run that no case has tested since is a
candidate too. An apply that only adds is suspect: say in `changes.md` what was
cut and how many lines each file lost or gained. Cuts are confirmed like any
edit - a cut that makes a case wrong is restored, nothing else.

Route each rule by what kind of thing it is: one agent's behaviour to its prompt,
a fact or a procedure to a skill - update an existing one or create a new one, a
standing rule to `agents/instructions.md`, a rule about one capability to a new
`agents/<topic>-policy-instructions.md`.

You may edit prompts, skills, house rules and new policy files. You may not edit
`agents/memory-instructions.md`, `agents/fork-instructions.md`,
`agents/tools-instructions.md`, `agents/files-instructions.md`,
`agents/mcp-instructions.md` or `agents/mcp-memory-instructions.md` - `zen check
--fix` overwrites them. You may not change a rubric to make a run pass. Do not
change `agents.yaml`: a finding that needs it is structural - record it as an
open problem and carry on.

Record every edit and the merged pattern behind it in `$RUN/changes.md`, then
run `zen check` and patch the README.

## 6. Confirm without memory, build the candidate (steps 7-9)

An edit is a guess until the same cases have run against it. Run the same batch
again as the next run - a copy of its cases, new prose, still no memory:

```sh
PREV=finetune/runs/batch01-nomem-run1
RUN=finetune/runs/batch01-nomem-run2
mkdir -p "$RUN" && cp finetune/runs/batch01-nomem-run1/cases.json "$RUN/cases.json"
C=$(node -p 'require("./finetune/config.json").concurrency')
zen run batch --input "$RUN/cases.json" \
    --batch-dir "$RUN/batch" --memory finetune/empty --concurrency "$C"
.github/skills/zen-finetune/scripts/report.mjs -d "$RUN/batch" -p "$PREV/batch" compare
```

Same queries, same machine, same memory, exactly one thing changed. The verdict
column decides first: a cost edit that makes any case wrong is reverted, whatever
it saved. Then the cost columns: a cost edit that did not cut llm calls or tokens
in the cases it was aimed at by more than the noise floor is reverted too - prose
that does not pay is a cost on every future run. Read the recheck cases first,
then the cases the rule was written for, then the ones it was not about. Cost
growth concentrated in the cases the rule touches is its price; growth spread
evenly across all of them is prose leaking into every agent, and that is a
regression even when every case still passes. If the instruction files grew by a
third and one case moved, revert and say so.

Then grade this run exactly as in section 4 - cost review, commits, proposals
and difficult list included. If every case is right and the cost review finds
nothing more worth changing, write `PASSED`, then **build the candidate memory**
from it before anything else (step 9):

```sh
M=.github/skills/zen-finetune/scripts/memory.mjs
$M candidate batch01-nomem-run2
zen memory stats --dir "$($M path --candidate)"
```

It copies the last good memory and merges in what each case of this run
committed - what the graph already held is folded, not added. A candidate of 0
nodes means nothing was committed: a commit-policy finding, and the with-memory
runs will measure nothing. Then patch the README and go straight to section 7.
If the review finds more, it is `CORRECT`: back to section 5.

The no-memory runs get **at most 4** per batch. After the 4th, stop tuning:
revert whatever it did not confirm, add every case still wrong to the difficult
list, and write `PASSED` on it. If a case is still wrong, the map shows the
batch `failed`, not `done` - the case comes back first in the next batches.

**Never compare two different batches.** They hold different cases, so the
difference between them is the cases and not the prose. Compare run to run
within one batch and kind, or a with-memory run against the no-memory run that
passed the same batch.

## 7. With memory (steps 10-15)

Run the **same cases** from the candidate - every case gets **its own copy** of
it, recalls from the copy and commits into the copy, so nothing one case writes
reaches another case or the candidate:

```sh
M=.github/skills/zen-finetune/scripts/memory.mjs
RUN=finetune/runs/batch01-mem-run1
mkdir -p "$RUN" && cp finetune/runs/batch01-nomem-run1/cases.json "$RUN/cases.json"
C=$(node -p 'require("./finetune/config.json").concurrency')
zen run batch --input "$RUN/cases.json" \
    --batch-dir "$RUN/batch" --memory "$($M path --candidate)" --concurrency "$C"
```

Do not use `--memory-read-only`: it removes the commit tool and changes the
memory prose, which makes a with-memory run differ from its no-memory baseline
in two ways instead of one.

**Analyze the memory use** (step 11). `report.mjs oom` first, then
`report.mjs memory` - recalls, memory reads, commits and `known` per case - then
`report.mjs recalls` - what each recall put in front of the model and every
memory tool step - and `report.mjs commits` - each case against the candidate:
what it committed, which of those the candidate already held, and which nodes
it loaded - then
`compare` against **the no-memory run that passed the same batch**, and from
run 2 on also against the previous with-memory run. Read the trajectories, and
`zen inspect ask` at the critical points - the first research call that ignored
a recall, the call right after a recall that redid the work, the call that
committed what it had just recalled - once per pattern, worded as
**zen-inspect-ask** says.

The target is reuse: recall should replace the discovery the no-memory runs
repeated every time, so the run is dramatically cheaper in tokens, calls and
wall clock with no verdict changed. A run that costs about the same, or more,
means memory was carried and not used - a recall-timing finding, not a reason
for more memory. A run that is much cheaper still needs one trajectory opened
to confirm the saving is recall replacing _discovery_ and not recall replacing a
_live reading_. The recheck cases, recalling what earlier batches committed,
are where that shows up first.

**Do not commit what memory already holds.** Every commit of a fact the graph
had - `known` above 0 in `report.mjs memory`, `ALREADY HELD` in
`report.mjs commits`, or a near-copy of a node it just
recalled - is an llm turn and a tool call that bought nothing, in every future
run. The target is `known` 0, and commits only of what the run genuinely
learned. A correction committed without `SUPERSEDES` beside the stale node it
contradicts is worse than a duplicate.

Write `findings.md` titled `WITH MEMORY`, with a `## Memory review` straight
after the verdict block - `next.mjs` refuses a `PASSED` without one: the saving
against the no-memory run, per case and in total; whether recall replaced
discovery, citing nodes; any live reading replaced by a recall; re-commits; and
corrections - each the pattern or `none` with the evidence. Then the per-case
grading, each case ending in its proposals.

**Merge and update** (steps 12-13) exactly as in section 5, into
`agents/memory-policy-instructions.md` - or the memory paragraph of a prompt or
skill where a `why` line names one: when to recall, when to trust a recalled
fact, when to go and look anyway, when **not** to commit because memory already
holds it. A pattern that cannot be written as one of those is a no-memory
finding that escaped: note it under "Open problems", put its cases on the
difficult list, do not edit the prose - the next batch's no-memory runs fix it.
A live reading sitting in the candidate is a commit-policy rule, and its nodes
may be removed with `zen memory forget --dir "$($M path --candidate)" <id>...`,
recorded in `changes.md`. Never edit the candidate otherwise, and never merge a
with-memory run's copies back into it.

**Run again** (step 14) from the **same candidate** - `batch01-mem-run2`, a copy
of the same cases. At most 4 with-memory runs. A case memory makes wrong or no
cheaper, still, after a run that tried to fix it, goes on the difficult list
`--why memory`.

**Keep it and move on** (step 15). When no verdict regressed, the saving is
obvious next to the noise floor, every large saving is explained, and nothing
was committed that memory already held, write `PASSED` and keep the candidate
before anything else:

```sh
.github/skills/zen-finetune/scripts/memory.mjs checkpoint batch01-mem-run1
```

Then mark difficult cases right in both passing runs `fixed`, patch the README
(the batch turns `done` on the map, the next one `now`), and build the next
batch as `next.mjs` says - section 3 - straight away. It grows on its own if
this one went smoothly.

## 8. The final check

When every case in the selection has been used and no difficult case is open -
`next.mjs` says so - run the whole selection as one run - the last good memory,
the same flags, the same machine - into `finetune/runs/final-check/`. It is the
only run that measures every case under the final prose and the final memory at
once. Grade it, and
write `findings.md` with the heading `VERIFIED` if no verdict regressed and the
saving holds. Change nothing. If something did regress, write it up as a finding
and under "Open problems" - which batch's rules are the suspect and why. Patch the README
to its final state - every node `done` or `failed`, "Results so far" as the
summary of the whole tuning, and every `stuck` difficult case and open problem
listed with what was tried.

Then, and only then, report to me: the final summary, the open problems, and a
link to the README. That is the end of the tuning.

## If the tuning stops for good

Whenever it stops - finished, abandoned, or killed mid-run - the prose under
`agents/` is whatever the last confirmed run left, and the memory worth keeping
is `memory.mjs path`: every passed batch's candidate, whole on disk, never
the graph a half-finished merge was writing. If the project will ship with a
memory, that is the one to promote into `memory/` - read `zen-memory-warmup`
first.

## Housekeeping

Commit `dataset.json`, `config.json`, `selection.json`, `difficult.json`,
`README.md`, `USAGE.md`, `usage.json`, every `cases.json`, `plan.json`, `findings.md` and `changes.md` - they are the
eval history, and they are what a resumed session reads to find its place. Write
each as its step ends rather than at the end of the batch, so an interruption
never costs more than the step it lands in. Add `finetune/runs/*/batch/`,
`finetune/memory/`, `finetune/empty/` and `finetune/usage/` to `.gitignore` - `batch/` folders are
large and may hold live API responses, and the memory graphs are built from them.
