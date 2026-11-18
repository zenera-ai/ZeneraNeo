---
name: zen-finetune-apply
description: Apply a batch of improvement requests from the tuning loop to the project's prose - merge them into patterns, edit prompts, skills and policy files, tidy up every file touched, and record what was done with each. Run only by `zen meta finetune`, never by hand; the words given with it name the apply directory, and a brief follows them.
user-invocable: false
disable-model-invocation: true
---

The tuning loop has collected improvement requests from several cases and
wants them applied **together**. The words given with this skill name the
apply directory.

Every sentence you add is read by every later call of every agent that loads
it, so prose has a price even when it fixes the case in front of you. The loop
measures it: after you finish, an apply that grows the prose past its budget
is **undone** - all of it. Then a few cases that passed before run again on
your edit; one it broke comes back to the next apply as a request.

## What you are given

A `## The brief` section after them is what the loop already read and
worked out for you, from the files below. Work from it:

- Do not read a file the brief shows, and do not run a command it shows -
  until you have edited that file yourself.
- Do not parse `inputs.json`, `deferred.json`, `budget.json` or `growth.json`
  with a script: `Requests by file`, `The requests`, `Growth` and the
  `budget.json` block are their content. Open one only for a field the brief
  marks `(cut at ...)` or `(left out ...)`.
- Do not open other `finetune/applies/*` folders: `Earlier tries of these
cases` is what they hold about these cases.

The files behind it:

- `<apply dir>/inputs.json` - the requests: each has `id` (`<case>@<phase>-<attempt>`),
  `case`, `phase` (`nomem` or `mem`), `summary`, `improvements` (each with `id`,
  `kind`, `file`, `change`, `why`, `expect`), `file`, the feedback it came from,
  and `missedSkills` - skills an earlier apply made for this case that its last
  run never loaded. The analysis behind each is `analysis.md` beside that file -
  read it when an improvement is unclear.
  A request with `recheck` (id `<case>@recheck-<apply>`) is a **regression**: the
  case passed before that apply and failed twice on it. Its analysis quotes the
  hunk of that apply's `diff.patch` that did it. Narrow or revert that rule -
  never stack an exception under it.
- `<apply dir>/deferred.json` - improvements earlier applies held back because
  only one case asked for them, with their case and apply. They count as
  evidence below.
- `<apply dir>/budget.json` - what the agents read, in bytes: `alwaysRead` per
  agent (house rules, its prompt, preloaded skills, the skill index lines),
  `skills` (each on-demand skill body), `visible` (skills each agent can see),
  the same at the start of the tuning (`start`), and the limits: `budget` (the
  most this apply may add to the always-read total), `ceiling` (above it, an
  apply may add nothing), `skillCap`, `maxSkills`.
- `<apply dir>/growth.json` - per file under `agents/`: bytes at the start of
  the tuning and now, how many applies changed it, and the latest of them.
- Earlier requests of the same cases, and what each apply decided about them -
  the brief's `Earlier tries of these cases`. Do not re-apply a rule an
  earlier apply added and a later run showed did not work; change it instead.
- From your previous attempt, if it was undone - the first files in the brief:
  `check.log` (it failed `zen check`), `budget.md` (it grew the prose past a
  limit - this attempt must cut) and `missing.md` (it ended without a decision
  for every improvement).

## Load the skills

A request says what a run did wrong; the rules for fixing it live in the editor
skills, not in the request. The brief's `Skills to load` lists the ones this
project's capabilities call for. Load every one of them now, before the first
edit. Load `zen-sandbox` too when any improvement is about the container,
installing packages, or a command that failed for want of a tool. No other
`zen-*` skill is needed.

An improvement that already sounds right is not a reason to skip its skill -
the skill is how you find out whether it is.

## What to do

1. **Merge before editing.** The brief's `Requests by file` has already put
   the improvements - and the entries of `deferred.json` - under the file each
   names, with the distinct cases behind each file. Now group them by the
   behaviour they fix, across files too. Several cases asking for the
   same thing in different words is one pattern. Two that contradict each
   other: decide, and say why. Count the **distinct cases** behind each
   pattern.
2. **Hold each against its skill.** An improvement's `change` is one analyst's
   guess at the fix. A change that breaks a skill's rule - shell `grep` over an
   index, a paraphrase of a copied house rule, a one-off inline script, a
   handoff with no way back - is rewritten to what the skill prescribes, or
   rejected naming the rule. When the skill already states the rule, the agent
   never saw it: fix how the skill is reached (its description, a load line in
   the prompt), not a second copy of the rule.
3. **Prove the owner and the absence**, for every pattern:
    1. State the obligation in one sentence of your own, not the wording of
       any request.
    2. Name exactly which agents must obey it, and choose the narrowest place
       that reaches all of them - see the table in step 6.
    3. Search every file those agents read for the same obligation: house
       rules (`agents/instructions.md`, every `agents/*-instructions.md`),
       their prompts, their preloaded skills and the skills they would load
       for it. Search its distinctive verbs and nouns and obvious other
       wordings, not one exact quote.
    4. Choose exactly one disposition: `edit existing`, `move and delete`,
       `delete contradiction`, `extract to skill`, or `add because absent`.
       Every location found goes in `changes.md`.

    If several places say it, consolidate into the one owner and delete the
    others in this apply. If a broad rule caused the failure, rewrite or
    narrow that rule - never keep it and add an exception elsewhere.

4. **Evidence.** `add because absent` and `extract to skill` need **two or
   more distinct cases** behind the pattern, counting `deferred.json`. With
   one case you may only `edit existing`, `move and delete` or
   `delete contradiction`, and only if the always-read total does not grow.
   Anything else from one case is `deferred` - not applied, not rejected: it
   comes back in `deferred.json` until a second case asks for it.
5. **Generalise.** Write each rule for a class of queries, not for a case -
   it must hold for queries no case asked. Never write a case's answer, ids,
   names, numbers or data into the prose, nor an example lifted from a case's
   query. Keep a specific only when the rule cannot be stated without it - a
   tool, a command, a file path of this project. Before you save, check every
   sentence you added: a noun, number or quoted phrase that comes from a case
   and appears nowhere else in the project is overfit - replace it with the
   class it belongs to, or drop the rule. A request that only makes sense for
   its one case is rejected.
6. **Route by behaviour, not by phase.** A request from a run with memory goes
   where its behaviour is owned, like any other.

    | The obligation is…                                                   | It goes in                                                |
    | -------------------------------------------------------------------- | --------------------------------------------------------- |
    | one agent's behaviour, on every request it gets                      | `agents/prompts/<agent>.md`                               |
    | a procedure or facts only some kinds of request need                 | an on-demand skill under `agents/skills/` - see step 7    |
    | a standing rule every agent must obey                                | `agents/instructions.md`                                  |
    | what to commit to memory, when to recall, what to trust from it      | `agents/memory-policy-instructions.md`                    |
    | a rule every user of one capability must obey                        | that capability's `agents/<topic>-policy-instructions.md` |
    | the wrong agent had a tool, a skill binding, the dataset or a rubric | **structural** - record it, do not compensate with prose  |

7. **Skills.** `extract to skill` moves a procedure or a set of facts out of a
   prompt or a policy into `agents/skills/<name>/SKILL.md`, which the agent
   loads only when a request needs it. Its body costs nothing until then; its
   index line costs on every call.
    - The prompt keeps **one line** pointing at the skill: the condition and
      the name. Delete the moved prose from where it was.
    - The `description:` says **when** to load it - the condition, in words a
      request would match - and must not overlap another skill's.
    - Never make a skill for one case's data: what one case needs to know
      about its own data is memory's job. Rejected.
    - A skill in `missedSkills` was not loaded by the case it was written for:
      its description is the defect. Rewrite the description - not more
      prose. A skill missed twice goes back into its owner (`move and delete`)
      or into a skill that is loaded.
    - Keep each skill under `skillCap` and each agent under `maxSkills`: an
      oversized skill is split by when it is needed, overlapping ones merged.
    - You cannot preload a skill: that is `agents.yaml`, structural.
8. **Never write:**
    - an exception stacked under a general rule, or "this overrides X" -
      rewrite X;
    - a tool-call script ("call A first", "read lines 1-200") - write the
      invariant it serves;
    - a prohibition with an exemption the agent judges for itself ("unless
      clearly needed") - that is a permission. Forbid it, or do not.
9. **Stay inside the budget** in `budget.json`. Over `ceiling`, this apply must
   not grow the always-read total at all: cut, move or extract to make room.
10. **Edit** prompts under `agents/prompts/`, skills under `agents/skills/`,
    `agents/instructions.md` and `agents/<topic>-policy-instructions.md`
    (create a policy file only when step 3 proved the rule absent and every
    agent with that capability must obey it).
11. **Never edit** `agents.yaml`, `agents/memory-instructions.md`,
    `agents/tools-instructions.md`, `agents/fork-instructions.md`,
    `agents/files-instructions.md`, `agents/mcp-instructions.md`,
    `agents/mcp-memory-instructions.md`, `agents/markdown-instructions.md`,
    `agents/a2ui-instructions.md` or the
    `agents/skills/a2ui*/` skills, nor anything outside `agents/`.
12. **Tidy up every file you touched** - the whole file, not only your lines.
    For each obligation in it, search the files the same agents read, and pick
    one move:
    - `merge duplicates` - the same obligation twice for the same audience:
      keep it in the owner, delete the rest;
    - `delete contradiction` - two sentences that cannot both be obeyed: keep
      the one the later `changes.md` chose;
    - `narrow` - a general rule followed by its exceptions: rewrite the rule so
      it needs none, delete the exceptions;
    - `move and delete` - a rule in a file wider than the agents it binds;
    - `split skill` / `merge skills` - a skill over `skillCap`, two whose
      descriptions overlap, or an agent over `maxSkills`.

    Never weaken an obligation: what an agent must do stays what it must do.
    The bytes this frees count against your budget, so a crowded file is where
    to make room. Then take the largest growth in `growth.json` you did not
    touch: if it says one thing twice, merge it too.

13. **Read it back.** Search again for each obligation's terms, and read each
    affected agent's prompt in the order it is assembled - house rules first,
    then its prompt. Every remaining copy must have a different audience, or
    go.
14. **Gate**: when your edits are done, run once
    `zen meta finetune gate <apply dir>`. It judges the edit exactly as the
    loop will after you: the bytes moved per agent, skill and file, any limit
    broken, and `zen check`. On `gate: fail`, fix what it names and run it
    again. Do not measure or diff files yourself and do not use git: the loop
    never commits, so `git diff` mixes in earlier applies, and it records the
    diff and the bytes of this apply after you finish.

## What to write

- `<apply dir>/changes.md` - read by a person deciding whether to trust this
  apply, so leave nothing out. One section per file you touched:

    ```markdown
    ## agents/prompts/default.md

    **Answers:** plan-day@nomem-1 i1, long-list-3@nomem-1 i1 (merged)

    **The pattern:** what the cases did wrong, in one paragraph, with the node
    ids from their analyses - not a case's answer.

    **Obligation:** the one sentence of step 3, and the agents it binds.

    **Searched:** the terms you searched for, and every place they were found.

    **Disposition:** `edit existing`, `move and delete`, `delete contradiction`,
    `extract to skill` or `add because absent` - with the cases behind it.

    **After:** the text as it is now, quoted.

    **Checked against:** the skill and rule it was held to, or "no skill
    covers this".

    **Why it generalises:** which queries beyond these cases it changes, and
    which it must not.

    **Expect:** what the next run's graph should show if it worked - for a
    skill, the `skills <name>` node before the step it covers.
    ```

    A section for a tidy-up move has **Move**, **Obligation** and **After**
    only. The diff and the bytes moved are added by the loop - do not write
    them.

    Then a section **Not applied**: every rejected, deferred or structural
    improvement, with why.

- `<apply dir>/decisions.json` - a decision for **every** improvement of every
  request, nothing skipped. When you apply or merge an entry of
  `deferred.json`, add it under its own request id too:

```json
{
    "plan-day@nomem-1": {
        "i1": {
            "decision": "applied",
            "disposition": "extract to skill",
            "skill": "calendar-planning",
            "note": "agents/skills/calendar-planning - planning procedure moved out of the prompt"
        },
        "i2": { "decision": "merged", "note": "same rule as long-list-3@nomem-1 i1" }
    },
    "long-list-3@nomem-1": {
        "i1": {
            "decision": "applied",
            "disposition": "edit existing",
            "note": "agents/pagination-policy-instructions.md"
        },
        "i2": { "decision": "structural", "note": "needs a tool in agents.yaml" },
        "i3": { "decision": "rejected", "note": "only true for this case's data" },
        "i4": { "decision": "deferred", "note": "one case; waits for a second" }
    }
}
```

`decision` is one of `applied`, `merged`, `rejected`, `deferred`, `structural`.
`disposition` is the one from step 3, on every `applied`. `skill` names the
skill an improvement created or changed - the loop checks the case's next run
loads it. The note is one line a person reads in the case's FEEDBACK.md.

Your answer is a short summary: how many rules, which files, what the tidy-up
merged or cut, the net change in bytes `gate` printed, and anything structural
the user must decide.
