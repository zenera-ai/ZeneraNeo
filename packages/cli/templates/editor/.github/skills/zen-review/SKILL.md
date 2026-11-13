---
name: zen-review
description: Reviewing, checking or validating an agent project - the whole procedure `/project-review` follows. Picks the depth from the request (a quick check by default, everything at once when a full or pre-commit check is asked for), runs the fast mechanical half (`zen check --no-models --no-sandbox`, the §2.5 path sweep, the setup dry run) and the slow half (`zen check` with the sandbox image build and model probes) separately, walks the judgement checklist no tool can make, and reports findings with the command that fixes each one - rebuild the sandbox, run the setup script, `zen check --fix`. Load whenever the user asks to check, review or validate a project, before saying a project is ready, and whenever a review finding needs verifying rather than restating.
user-invocable: false
---

# Reviewing a project

A review of an agent project is two jobs wearing one name. One half is
decidable - a schema is valid or it is not, a path resolves or it does not, an
index is built or it is not - and a human doing it by hand gets it wrong in the
same places every time. The other half is judgement: whether an agent has one
job, whether a description routes, whether a number is in the wrong file.

The decidable half is scripted and split by cost into a **fast** part and a
**slow** part. The judgement half is the checklist further down. A review ends
in one report that says what is wrong and what to run next.

## 1. Choose the depth from the request

| The user asked                                                         | Do                                                                                              |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| "check", "is it ok?", "quick check", anything unqualified              | **Quick**: the fast half and the judgement checklist. Then ask whether to run the slow half.    |
| "full check", "check everything", "deep", "before I commit", "release" | **Full**: the fast half, then warn and start the slow half right away; judgement while it runs. |
| one area ("check the paths", "does the sandbox build?")                | Only the part that owns it - `check-paths.sh`, or the slow half - and say what was not covered. |

`/project-review` with nothing after it is a quick review. When in doubt, go
quick and ask: the fast half costs seconds, the slow one can cost minutes. When
you ask, say what the slow half would add - whether the Dockerfile builds and
whether every model id is real - so the answer is an informed one. When nobody
can answer - a scripted `zen meta run /project-review` - do not ask: run the
quick review and end the report with the command for the slow half.

## 2. The fast half - files, paths, setup

```sh
.github/skills/zen-review/scripts/review.sh fast
```

Seconds, offline, no Docker, no tokens. It always runs, first. Each step's
header is the exact command it ran:

| Step                                 | Owns                                                                   |
| ------------------------------------ | ---------------------------------------------------------------------- |
| `zen check --no-models --no-sandbox` | everything decidable about the configuration and the files it names    |
| `paths (check-paths.sh)`             | paths a running agent cannot open - §2.5                               |
| `setup (scripts/_setup.sh --check)`  | whether what must exist before a run (an index, a generated file) does |
| `sandbox`                            | a hint: `sandbox/` changed since the last commit                       |

Every step runs even when an earlier one fails. The exit code is `1` if any
step wants attention, `0` if none does; the `sandbox` step is a hint and never
fails the run. Nothing else matters while `zen check` fails - report what it
said and fix that first. There is no point paying for a container build on a
project whose `agents.yaml` does not parse.

## 3. The slow half - sandbox build and model probes

```sh
.github/skills/zen-review/scripts/review.sh slow          # add --fix to repair zen's own files first
```

This is the full `zen check`, with the sandbox image build and the model probes
turned on. **Before starting it, tell the user it may take several minutes**:
it builds the project's image with Docker (a cold build with no layer cache is
the slow part) and asks every model that has a credential to answer once. Then
start it on its own - in the background where your tools allow - and do the
judgement checklist while it runs. Report its result when it finishes.

It is the only check that proves a Dockerfile builds and a model id is real: a
key that authenticates says nothing about the model it is spent on. A project
with no sandbox only pays for the model probes; a machine with no container
engine gets a warning rather than an error - say so, do not call that a pass.

`slow` does not repeat the path sweep or the setup dry run, and it saves a
receipt (§7) so the same pass does not pay for it twice. If files change after
the fast half, run `fast` again; it is cheap. `review.sh` with no argument
still runs everything in one blocking go - prefer the split.

## 4. The judgement half

Read `agents.yaml`, every `agents/*instructions.md`, every file under
`agents/prompts/` and the skill descriptions under `agents/skills/` before
saying anything. Do not re-verify by hand anything the scripts already decided.

**List the capabilities this project turns on** - a `memory:` block, a `zen
rag` index, a sandbox, an agent that writes code (`zen-code-python`),
`handoffs:` or `fork:` (`zen-topology`) - and load the editor skill for each
before judging it. The obligations live in the skill, not in `agents.yaml`, and
`zen check` reports none of them. A capability that is already configured and
already passing is exactly the case that looks finished and is not.

Then, what no tool can see:

- **One job each.** Can you state every agent's job in one sentence? If not,
  say which agent and what the two jobs are.
- **Prompts.** Second person, imperative, failure paths stated, no hedging, no
  politeness padding, no meta-talk about the runtime. Nothing in the house rules
  that is true of only one agent, and nothing in `agents/instructions.md` that
  belongs in a `<topic>-instructions.md` of its own because it only applies when
  one capability is on.
- **Facts.** Any number, threshold, fee or date living in a prompt is in the
  wrong file. Name it and say which skill it belongs in.
- **Paths.** For each candidate `check-paths.sh` printed: is it a path the agent
  cannot open, or noise? Say which, and for a real one say what it should have
  been. Judge the rest of the §2.5 checklist yourself - that no instruction
  assumes the workspace is this directory, that every `/assets/…` and
  `/skills/<name>/…` names a committed file, and that the agent holding the
  prompt has the tool the path implies.
- **Memory.** Anything this project decides for itself belongs in
  `agents/memory-policy-instructions.md`, not in the copy - and it should say
  something. Audiences that exist because an agent would be _misled_ by the
  other slice, not merely because it does not need it.
- **Skill descriptions.** Each one a condition, not a title; no two overlapping.
  Every skill a folder with a `SKILL.md`, and a skill that ships a script writes
  its `/skills/<name>/…` path.
- **Tools.** Every grant justified by the agent's job; nothing mutating held by
  an agent that only reads; every granted tool mentioned by the prompt. An agent
  with no `skills:` key indexes the whole catalog - check that every agent can
  actually follow the skills it is offered.
- **Sandbox.** `persist: true` unless a throwaway rootfs is wanted on purpose.
  What the work always needs is in the image, not installed by a prompt on every
  run.
- **Control flow.** Load `zen-topology` first when `agents.yaml` has
  `handoffs:` or `fork:`. A handoff moves the conversation and must have a path
  back; a fork returns by itself and condenses to one result, so whatever the
  caller needs must be in the branch's answer. Wanting one lookup and spending
  the conversation on it is a fork, not a handoff. No router that answers.
- **Models.** Each agent on the cheapest tier that is right, not the safest.
- **Cache.** Nothing volatile - dates, ids, counts - in the stable prefix.
- **Secrets.** No key inlined anywhere; `.env` ignored, `sessions/` ignored.

§9 of the copilot instructions is the long form of this list.

## 5. Suggest the next step

A finding without a next step is half a finding. Map what the checks said to
the command that addresses it, and put it in the report:

| What the review saw                                               | Suggest                                                                                    |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `rules.stale`, a missing house-rule copy, an outdated editor tree | `zen check --fix` (load `zen-instructions` first - §9)                                     |
| `setup` says not done; an index is not `ready`                    | `scripts/_setup.sh` - and `scripts/_setup.sh --force` when the source documents changed    |
| `sandbox` hint: `sandbox/` changed since the last commit          | `review.sh slow` to prove it builds, then `zen sandbox pull` to rebuild the image runs use |
| slow half: no container engine, or the machine is not running     | `zen sandbox up`                                                                           |
| slow half: the image build failed                                 | fix `sandbox/Dockerfile`, then `review.sh slow` again; load `zen-sandbox`                  |
| slow half: a model refused or never answered                      | `zen models test <ref>`; fix the model id, or the credential with `zen key`                |
| a sandbox pin was repaired by `--fix`                             | `review.sh slow` - a repair may have changed the image                                     |
| quick review done, slow half not run                              | ask whether to run `review.sh slow`, and say it can take several minutes                   |
| only judgement findings                                           | the edit, by file and line - and run `review.sh fast` again after making it                |

Load `zen-cli` before suggesting any other `zen` command, so the arguments come
from the contract rather than memory.

## 6. The report

Open with the mechanical results, one line per command actually run, named as
the script's step headers name it - never collapse two into one:

```
• zen check --no-models --no-sandbox: passed (0 errors, 0 warnings)
• check-paths.sh: passed - every path is under /workspace, /assets or /skills
• scripts/_setup.sh --check: 1 step needs setup (docs_index)
• zen check (sandbox build + model probes): not run - quick review
```

Then the findings, each naming the file and the line, ordered by how much they
will cost to leave, each with its next step from §5. Say plainly if you find
nothing worth changing, and say which checks did not run. Do not edit anything
unless the user asks.

## 7. Reusing a check within the same pass

Instead of calling `zen check` separately and repeating it in the review, run:

```sh
.github/skills/zen-review/scripts/review.sh check full --fix
.github/skills/zen-review/scripts/review.sh --skip-check
```

`check` runs only the CLI check and saves a receipt in `.tmp/review-check.json`
on success. `--skip-check` verifies that receipt, then still runs the path
sweep. It fails explicitly for a missing, failed, stale or
insufficient check; it never silently treats a skipped check as success.

Receipts cover project file contents, permissions, additions and deletions, and the CLI
version. They exclude only the root `.git/`, `.tmp/` and history directories,
so writing scratch output or history does not invalidate a result. Symlinks and
special files are unsupported: run the ordinary review instead. Hashing
includes assets and dependencies and can itself be costly for large projects;
the ordinary review remains available.

This is same-pass reuse, not a persistent health cache. Do not reuse after
changing credentials, environment variables, external files, ignored scratch
inputs or remote resources: those are not certified by the receipt. Run a fresh
check instead. Only use reuse for a self-contained project's stable inputs.

`check no-sandbox` and `--skip-check no-sandbox` are for a change that does not
reach the sandbox image. They still probe models. `check fast` and
`--skip-check fast` omit both expensive probes and are for iteration only.
A full receipt covers either partial mode, but a partial receipt cannot stand
in for a full one. If a partial check repairs or otherwise changes files, no
reusable receipt is issued: run `check full`, because a repair may have changed
the sandbox pin. Finish setup and all edits before saving the final receipt.

## 8. `check-paths.sh` - the §2.5 sweep

A running agent's whole world is three paths: `/workspace`, `/assets` and
`/skills`. Every path-shaped token in `agents/*instructions.md`,
`agents/prompts/*.md` and a skill's markdown is read by a model as an
instruction to open something, so anything outside those three is an instruction
to open a file that is not there.

```sh
.github/skills/zen-review/scripts/check-paths.sh        # each candidate, with file and line
.github/skills/zen-review/scripts/check-paths.sh raw    # the tokens alone, unfiltered
```

It exits `1` whenever it prints a candidate, because the list is meant to be
emptied or explained rather than skimmed. It strips urls before tokenising, skips
a handful of English constructions that contain a slash, and leaves the four
copies `zen` ships (`agents/{files,fork,memory,tools}-instructions.md`) out
entirely - they are worked examples by design, and `zen check` keeps them
byte-identical (`rules.stale`).

Everything it does print is either noise the script has not learned yet or a
real finding. There is no third case. A candidate that is genuinely noise is a
one-line addition to `NOISE` in the script - **upstream**, see below, not in the
copy sitting in this project.

`raw` is the sweep with nothing filtered, for when you suspect the filter.

## 9. Findings that are not yours to fix in place

`zen check` reports `rules.stale`, `files.uninstructed`, `memory.uninstructed`,
`fork.uninstructed`, `rules.requires.unknown` or `rules.unreached` against a
file under `agents/`, and the obvious repair - open it and edit it - is wrong for
four of those files. `tools-instructions.md`, `files-instructions.md`,
`memory-instructions.md` and `fork-instructions.md` are `zen`'s copies:
`zen check --fix` replaces them, so an edit made inside one is gone at the next
fix, `init` or `open`.

**Load `zen-instructions` before acting on any of those findings**, and before
judging a house rule at all. It owns which documents belong to whom, where a
project's own rules on the same subject go instead, what `requires:` does, and
what filename order decides. A review that fixes one of ours in place has
undone itself by the next `zen open` and left nothing behind to say so.

## 10. Where these scripts live, and why edits to them vanish

`zen init` and `zen open` rewrite the whole `.github/` tree from the version of
`zen` in hand. These scripts arrive with it, so a change made to the copy in a
project is gone at the next `open`. A filter that should hold for every project
belongs in the distribution - `packages/cli/templates/editor/.github/skills/` in
the @zenera/neo repository - and reaches this project the next time the tree is
written.

Do not confuse these with a project's own scripts. `agents/skills/<name>/scripts/`
is run by **the project's agents**, inside the sandbox, at
`/skills/<name>/scripts/…`. `.github/skills/<name>/scripts/` is run by **the
editor's assistant**, on the host, at a workspace path. The two have different
readers and neither can see the other.
