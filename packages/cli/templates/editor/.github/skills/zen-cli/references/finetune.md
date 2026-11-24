# `zen meta finetune` - tuning the project, one case at a time

Trains the project's prose - prompts, skills, house rules - on every case of
its dataset (`zen meta dataset`). Nothing here touches model weights.

```sh
zen meta finetune start [-N 4] [-M 4] [--tries 4] [--mem-tries 3] [--merge-every 3] [--seed 1] \
    [--recheck 3] [--budget 1500] [--max-growth 50] \
    [--skill-cap 12000] [--max-skills 10] \
    [--class <c>] [--id <glob>] [--rubric yes|no] [--limit <n>] [--more <n>] [--force]
zen meta finetune [status]
zen meta finetune stop
zen meta finetune session <case>
zen meta finetune gate <apply dir>   # would this apply pass? run by the apply agent
```

## What one case goes through

```
without memory, up to --tries times:
    zen run (empty memory)  ->  /analyze  ->  done? go on : park until the next apply
with memory, up to --mem-tries times, from the memory the passing run wrote:
    zen run  ->  /analyze  ->  done? completed : park until the next apply
tries used up  ->  difficult
```

- **N workers**, each training one case at a time. Cases come in the dataset's
  own order: classes taking turns, cases with a rubric first, then seeded
  random. Cases added to the dataset are picked up as it goes.
- **A parked case gives its worker back**, so another case runs while it waits
  for an apply; once woken, it takes a worker before any new case does.
- **Applies are batched.** Parked cases' improvement requests are applied
  together by `/zen-finetune-apply` once **M** cases are parked, or once nothing is
  running and no case is left to start. `-M` is at least 2 (`-M 1` needs
  `--force`): one case is an anecdote. No run starts during an apply; runs in
  flight finish first. Each apply gets its own `applies/<NNN>/APPLY.md`: every
  request and improvement, what was decided for each, the apply agent's account
  of what it changed and why, every file changed with its diff, and the gates.
- **An apply passes two gates, or is undone.** `zen check` must pass. What
  every call reads - house rules, prompts, preloaded skills, the skill index,
  summed over the agents - may grow by at most `--budget` bytes, and by nothing
  once it is `--max-growth` percent over the start; no skill may pass
  `--skill-cap` and no agent see more than `--max-skills`. A failed gate undoes
  the edit and the agent tries once more, told why. A second `zen check`
  failure stops the tuning; a second budget failure only undoes the apply, and
  the parked cases carry on on the prose they had. `gate <apply dir>` runs both
  gates on an apply in progress, against the same numbers, so the agent can cut
  before it finishes.
- **An apply tidies up after itself.** Every file it touches loses its
  duplicates, contradictions and stacked exceptions in the same edit; the
  bytes that frees count against its budget. `growth.json` tells it which
  files grew most since the tuning began.
- **Then `--recheck` completed cases run again on the new version** - without
  memory, as ordinary work on a worker, ahead of new cases; nothing waits for
  them. One that fails both of its two tries has regressed: its feedback
  (`<case>@recheck-<apply>`) joins the improvement queue, the next apply
  repairs it, and the case is rechecked first after that. Nothing is undone.
  A case sends at most two such requests; after that a regression is only
  reported, so the tuning ends.
- **One case adds nothing.** A new rule, or a procedure moved into a skill,
  needs two cases asking for it. With one, the apply may only edit, move or
  delete without growing the prose; anything else is `deferred` and offered to
  every later apply (`deferred.json`) until a second case asks.
- **Prose cannot fix everything.** When all an apply could say of a request is
  `structural` - a tool, a skill binding, the dataset - the case is difficult
  at once, reason `structural: ...`, instead of trying again on the same prose.
- **A broken rubric is the dataset's to fix.** The analysis grades a line
  `invalid` when it says how one implementation did it rather than what is
  right, with a `specification` improvement saying how it should read. No
  apply sees those, an `invalid` line never keeps a case from completing, and
  a case whose only findings are `specification` is difficult at once, reason
  `specification: ...`. STATUS.md lists them under **Rubric problems**.
- **A skill must be loaded.** When an apply makes or changes a skill for a
  case, the case's next run must load it. If it does not, the run says so
  (`missedSkills`), the analysis is told (`missed-skills=`), and the next apply
  fixes the skill's description.
- **No run shares a memory.** Every try runs on its own private directory:
  empty without memory, a copy of the case's passing memory with it. A case
  whose with-memory run passes keeps a copy in `memories/submitted/`; every
  `--merge-every` kept memories are merged, with the last merge, into
  `memories/merged/mNN/` - numbered, never rewritten, each listing the cases it
  holds. Whatever is left is merged when the tuning ends.
- **Each analysis starts from a brief.** The loop runs what every analysis
  reads - the case, the graph, the run's files, the prose, the earlier tries
  and the diff since the last one - writes it to the try's `brief.md`, and
  hands it to `/analyze` in the prompt (`zen meta run --prompt-file`). Each try
  is analyzed in a session of its own; `session <case>` prints the command to
  resume the latest one.
- **So does each apply.** Its `brief.md` holds the requests and held-back
  improvements grouped by the file they name, the editor skills to load, the
  earlier tries of the same cases with their decisions, the budget, and the
  files to edit. An attempt that ends without a decision for every
  improvement is undone (`missing.md`) and tried once more.
- **Stop and resume freely.** `stop` (or Ctrl-C once) lets the steps in flight
  finish, then exits; Ctrl-C twice, or SIGTERM, kills them. `start` again carries on: every
  step's result is on disk, and nothing finished is repeated.
- **`--limit` and `--more` are for one start**, never kept in `loop.json`.
  `--limit <n>` cuts the order to its first n cases: once those have a result,
  that start ends. `--more <n>` takes at most n cases of any kind - new,
  part-way or failed - in the order, so `start --more 4` again takes the next
  four.
- `start` refuses a dataset that has drifted from its sources - run `/dataset`
  first, or pass `--force`.

## What it leaves

```
finetune/
    STATUS.md            the whole tuning: summary (spend per phase, tuning and memory
                         effect), workers and what each is doing now, queue, applies,
                         cases - generated, rewritten every second while it runs
    loop.json            the settings; flags on start update it
    events.jsonl         every step, in order
    cases/<id>/
        FEEDBACK.md      that case: rubric, latest analysis, decisions, history, metrics
                         of every try and how they moved - generated
        r<rev>/result.json            completed or difficult, once it ends
        r<rev>/<NN>-<nomem|mem>/      one try: request.json, run.json, memory/,
                                      brief.md, session, feedback.json, analysis.md,
                                      run.log, analyze.log
    applies/<NNN>/       APPLY.md (generated), inputs.json, deferred.json, budget.json,
                         growth.json, gate.json, brief.md, apply.log, check.log,
                         changes.md, decisions.json, diff.patch, cost.md; budget.md
                         or missing.md when an attempt was undone
    rechecks.json        every recheck: case, apply, state, tries, the request it sent
    rechecks/<NNN>/<id>/<NN>-nomem/   one recheck try, as a case's try
    baseline.json        what the agents read when the tuning began
    memories/            submissions.jsonl, merges.jsonl, submitted/<case>@r<rev>/, merged/mNN/
    systems/             systems.jsonl + a copy of agents.yaml and agents/ per version
```

Open `STATUS.md` first; every row links to the detail behind it. Its Summary
says whether the tuning is working: the fixes, as a case's first try without
memory against its passing one, and memory, as the passing try without memory
against the passing try with it - tokens, calls, tool errors and time, totalled
over the same cases. A case's `FEEDBACK.md` has the same metrics per try and per
model, each try against the one before it in its phase.
