---
name: zen-instructions
description: The house rules - `agents/instructions.md` and every `agents/<topic>-instructions.md` prepended to every agent's system prompt. How the set is discovered and ordered, the `requires:` frontmatter and its closed vocabulary (`files`, `files-write`, `fork`, `memory`, `memory-write`, `memory-forget`), which four documents are `zen`'s own and are replaced by `zen check --fix`, how a project writes its own customisable topic prompts beside them (`files-policy-instructions.md`, `memory-policy-instructions.md`, `fork-<topic>-instructions.md`, `tools-<topic>-instructions.md`) without losing the copy, what belongs in a house rule as against an agent prompt or a skill, and every `zen check` finding these files can produce. Load before creating, editing, reviewing or deleting any `agents/*instructions.md`, before adding a capability whose rules arrive as one, and whenever `rules.stale`, `rules.unreached`, `files.uninstructed`, `memory.uninstructed` or `fork.uninstructed` is reported.
user-invocable: false
---

# House rules

An agent's prompt is assembled, not written. The house rules are the part every
agent gets, whoever is answering:

```
1. agents/instructions.md            the project's own, unconditional
2. agents/<topic>-instructions.md    every one of them, in filename order
3. agents/prompts/<name>.md          the agent's own job, or `system:`
```

Each document arrives as its own block tagged with the file it came from -
`<house_rules src="agents/memory-instructions.md">` - so the model can tell one
from the next and a report can say which file a rule was in. The documents are
read **once** and the same objects are given to every agent, which is why
`zen inspect` says "one document, five prompts" instead of showing five
identical blobs.

They are also the stable head of the cached prefix. A line here is paid for on
every call by every agent, and a line added here invalidates that prefix for all
of them. Change them rarely and deliberately.

## The set is a glob, not a list

There is **no key in `agents.yaml`** naming these files and no per-agent subset.
The loader takes `agents/instructions.md` first, then every file in `agents/`
whose name ends `-instructions.md`, sorted by filename. Directly inside
`agents/` only - `agents/prompts/style-instructions.md` is not one - and all of
it is optional: a one-agent project whose whole prompt is its role file needs
none of them.

Two consequences worth holding on to:

- **Adding a file is the whole wiring.** Nothing else has to be edited, and
  nothing reports a file you meant to add and did not.
- **Order is the filename's**, because it is the only order that is the same on
  every machine and is visible without opening anything. `agents/instructions.md`
  does not end in `-instructions.md`, so it can never be counted twice.

## Conditioning a document: `requires:`

A document about one capability says so in its own frontmatter, and then reaches
only the agents that have it:

```markdown
---
requires: [memory]
---

# Memory

...
```

The condition lives on the document rather than in `agents.yaml` because the
condition and the prose it guards are one edit.

| Capability      | Reaches an agent when                                          |
| --------------- | -------------------------------------------------------------- |
| `files`         | it declares file tools (`files:*` or individual file tools)    |
| `files-write`   | it declares file write tools (`apply_patch`, `write_file`, …)  |
| `fork`          | it declares `fork:` - and, at run time, is under the depth cap |
| `memory`        | it declares `memory:` in any form                              |
| `memory-write`  | its memory `access` is `read-write` or `full`                  |
| `memory-forget` | its memory `access` is `full`                                  |

Legacy aliases `workspace` and `workspace-write` match `files` and `files-write`.

The vocabulary is **closed**. A name outside it is a load error
(`rules.requires.unknown`), not a rule that silently never fires. A list means
_all of it_ has to hold. There is no `not`: a rule for agents _without_ a
capability is a rule about the rest of the project, which is what
`agents/instructions.md` is for. No frontmatter means unconditional, which is
the usual case.

`fork` carries a run-time half as well - the tool is withdrawn at the fork depth
cap, and a rule about a tool the model does not have is a rule it can only be
confused by.

## Two owners, in the same directory

| File                                    | Whose     | `requires:` | Is                                                        |
| --------------------------------------- | --------- | ----------- | --------------------------------------------------------- |
| `agents/instructions.md`                | project's | -           | identity, shared model of the system, global constraints  |
| `agents/tools-instructions.md`          | **ours**  | -           | how tools are called: narrate, batch the independent ones |
| `agents/files-instructions.md`          | **ours**  | `files`     | how files are read, searched and patched; safety, mounts  |
| `agents/memory-instructions.md`         | **ours**  | `memory`    | how the graph is reached, what to commit, how to correct  |
| `agents/fork-instructions.md`           | **ours**  | `fork`      | what a branch is, what returns, when it is worth it       |
| `agents/tools-<topic>-instructions.md`  | project's | yours       | **this project's** tool policy                            |
| `agents/files-<topic>-instructions.md`  | project's | `files`     | **this project's** file policy                            |
| `agents/memory-<topic>-instructions.md` | project's | `memory`    | **this project's** memory policy                          |
| `agents/fork-<topic>-instructions.md`   | project's | `fork`      | **this project's** forking policy                         |

The four marked **ours** describe _this version of `zen`_ - how the memory
graph works, how its tools are called, what survives a join, how files are safely
handled. They land under `agents/` only because that is where a document has to
be to reach a prompt. They are not the project's to maintain:

- `zen check --fix` **replaces all four** with the bytes this `zen` ships.
- A copy that differs - edited in place, or scaffolded by an older `zen` - is
  reported as `rules.stale`, because prose about a runtime that has since moved
  reads exactly as authoritative as the version that is true.
- So an edit made in one of them is lost at the next `--fix`, and a rule that
  mattered is gone without a diff to show for it.

They arrive whether or not the project uses the capability; their `requires:` is
what keeps an inert one out of every prompt.

## The project's own topic prompts

This is the customisation point, and it is a **file beside**, never an edit
inside. Anything this project decides for itself on a subject one of ours
covers - which audience holds what, what must never be written down, how wide a
fan-out may go, which tools are off limits here - is its own document:

| Instead of editing       | Write                                  |
| ------------------------ | -------------------------------------- |
| `files-instructions.md`  | `agents/files-policy-instructions.md`  |
| `memory-instructions.md` | `agents/memory-policy-instructions.md` |
| `fork-instructions.md`   | `agents/fork-policy-instructions.md`   |
| `tools-instructions.md`  | `agents/tools-policy-instructions.md`  |

`<topic>` is yours; `policy` is the convention and needs no explaining. Then a
`zen check --fix`, a `zen init` or a `zen open` refreshes our copy and takes
nothing of yours with it.

Three things to get right:

1. **`requires:` is not inherited.** A `memory-policy-instructions.md` with no
   frontmatter reaches every agent, including ones with no store. Copy the
   condition from the document it qualifies - usually the same line.
2. **Filename order decides what qualifies what.** A policy meant to be read
   after our rules needs a topic word that sorts after `instructions`:
   `memory-policy-…` lands after `memory-instructions.md` (`p` > `i`), and
   `memory-audience-…` lands **before** it (`a` < `i`), qualifying prose the
   model has not read yet.
3. **It is a prompt, not a note.** Second person, imperative, failure paths
   stated. Everything §4.2 of the copilot instructions says applies in full.

## What belongs in a house rule

Only what is true for **every** agent the document reaches:

- identity and domain - _"You work the property claims desk"_
- non-negotiable prohibitions: regulatory, legal, safety
- global format and tone constraints
- domain vocabulary and identifier formats
- the shared model of the system: what the agents are collectively for, and how
  work moves between them, in terms they can act on - _"the adjuster owns
  coverage decisions; you do not"_ - not in terms of files or YAML keys

Not here:

| That                                          | Goes in                           |
| --------------------------------------------- | --------------------------------- |
| Anything one agent needs and another does not | `agents/prompts/<name>.md`        |
| Long reference data, procedures, tables       | a skill, loaded when it is needed |
| Anything that changes weekly                  | a skill, or `assets/`             |
| A tour of the codebase                        | nowhere - it is not a README      |

If you find yourself writing _"if you are the router…"_, you are in the wrong
file. Target 20-60 lines per document; past ~100, split the stable half into a
preloaded skill.

Split a topic out of `agents/instructions.md` when it is true for every agent
but belongs to **one capability** - it then arrives when the capability is
turned on and is deleted when it is turned off, which is a whole file rather
than a section somebody has to find. Do not split by author, by date, or to keep
a file short.

## Paths

Every path-shaped token in these files is read by a model as an instruction to
open something, and a running agent sees three: `/workspace`, `/assets`,
`/skills`. Remembered files are not mounted; `memory_copy_file` brings one into
`/workspace`. The sweep is in the `zen-review` skill:

```sh
.github/skills/zen-review/scripts/check-paths.sh
```

It reads `agents/*instructions.md` and exits `1` on any candidate.
`agents/memory-instructions.md` is exempt: it is worked examples by design, and
`rules.stale` is the check it actually needs.

## What `zen check` reports

| Finding                  | Severity | Means                                                            |
| ------------------------ | -------- | ---------------------------------------------------------------- |
| `rules.requires.unknown` | error    | `requires:` names no capability - the loader refuses the project |
| `files.uninstructed`     | error    | an agent has file tools and `files-instructions.md` is absent    |
| `memory.uninstructed`    | error    | memory is on and `memory-instructions.md` is missing or empty    |
| `fork.uninstructed`      | error    | an agent can fork and `fork-instructions.md` is missing or empty |
| `rules.stale`            | warning  | one of ours is not the copy this `zen` ships                     |
| `house-rules.empty`      | warning  | a document contributes nothing but a prompt section              |
| `rules.unreached`        | note     | a document of **yours** whose `requires:` no agent satisfies     |
| `house-rules.missing`    | note     | no house rules at all, which is allowed                          |

`zen check --fix` answers the first five between them: it rewrites all four of
ours and the whole `.github/` tree, then validates, so the report and its exit
code describe the repaired project.

Two silences to know about. **There is no `tools.uninstructed`** - that document
is unconditional and its absence is not reported, so a project that deleted it
is quietly a project whose agents were never told how to call a tool. And
`rules.unreached` deliberately never fires for ours, because they land in every
project whether the capability is used or not.

`rules.stale` compares bytes, so it catches the usual drift - trailing
whitespace inside a table, invisible on screen. Never compare one of ours
against anything by eye, and never paraphrase one into prose of your own.

## Related

- `zen-memory` - what `memory-instructions.md` says, and how to design a policy
  to put beside it
- `zen-review` - the path sweep and the rest of the mechanical review
- `zen-cli` - `zen check`, `zen check --fix`, `zen init`, `zen open`
- §3.2 and §5.3 of `.github/copilot-instructions.md` - the short form of all of
  the above
