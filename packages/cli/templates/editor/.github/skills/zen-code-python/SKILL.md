---
name: zen-code-python
description: Code an agent writes must be a reusable tool that can be remembered and re-run, never a one-off. Holds the coding rules (`references/code_python.md`) and decides where they go in the target project - a section of a dedicated code agent's system prompt, or a coding skill for generic agents that sometimes run code - how to adapt them, and what a prompt or skill for a code-writing agent must never say. Load before writing, editing or reviewing any agent prompt, skill or house rule for an agent that writes or runs code - any agent holding `sandbox:*` or `run_command` - and before shipping a script inside a skill.
user-invocable: false
---

# Code an agent writes is a tool

A script an agent writes is worth more than the answer it printed. Written
generically - every changing value an argument, a name that says what it does -
it can be committed to memory as a `file` node and found again by the next
similar question, which runs it instead of writing it again. Written as a
one-off - this customer's id, this month, this path, as literals - it can only
ever answer the question that produced it, and memory fills up with near-copies
that never fold together.

Nothing in the runtime enforces this, and `zen check` does not report it. The
rules reach an agent only through what you write into the target project.

## The reference

`references/code_python.md` is the rule set, in wording that has been tested on
models. It is a source to build from, not a file to copy. Start from its
sentences - copying and then editing them works; rewriting them from scratch in
your own words loses the mechanical phrasing that makes them obeyed.

**Keep in substance, and never soften:**

- every value that would change for the next similar question is a named
  argument, never a literal
- the user the run acts for comes from `zenera.require_identity()`, never from
  an argument, a literal or the conversation - the one value that changes per
  question and is still not an argument
- the file is named for what it does, and describes itself through `--help`
- the result goes to stdout, a produced file to an `--output` path
- the script is written to a file and the file is run - no `python -c`, no
  heredoc
- before using the output, the script is checked against a different question
  of the same kind
- with memory: search before writing, commit the working script after

**Adapt to the project:**

- the interpreter and language, if the sandbox image runs something other than
  Python
- where scripts are written - `/workspace/scripts/` unless the project already
  has a place
- libraries the image carries and the agent should prefer, and the output
  format the project expects (JSON, CSV, a table)
- an example invocation from this project's own domain, values passed as
  arguments
- the memory steps: keep them when the agent holds `memory_search` /
  `memory_commit`, drop them when it never will. In a skill several agents may
  load, keep them gated on the tool, as the reference does

## Decide where the rules go

List the agents that hold `sandbox:*` or `run_command`, and read each one's
prompt for what its job is. Then:

| The project has                                                                          | Write                                                                                                          |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| A **dedicated code agent** - a runner, an executor, an analyst whose answers are scripts | A `## Writing code` section in that agent's `agents/prompts/<name>.md`                                         |
| **No dedicated code agent** - generic agents that sometimes run code                     | A coding skill, `agents/skills/code_python/SKILL.md`                                                           |
| Both                                                                                     | The prompt section, and the generic agents hand the code work to that agent rather than writing it - see below |
| No agent that writes or runs code                                                        | Nothing                                                                                                        |

**A dedicated code agent gets the rules in its system prompt.** It writes code
on nearly every turn, so the rules are part of its job description: a skill
would cost a load on every case, and preloading one is the same text in the
prefix with an extra file to keep in step. Put the section after the agent's
identity and procedure, before its prohibitions.

**Generic agents get a skill.** Most of their turns write no code, so the rules
should cost nothing until one does. The `description` is the routing key - name
the condition, not the topic:

```yaml
description: Before writing, changing or running any Python script - how to write it as a reusable tool rather than a one-off.
```

Leave it in the agent's index; do not preload it. If `allow` is used, add
`code_python` to it for every agent holding `sandbox:*`.

**With both, one copy.** Generic agents that can reach a code agent should
`fork:` to it for an answer, or hand off to it, rather than writing code
themselves - then the rules have one home and the scripts one author. Grant
them no `sandbox:*` for code work. If they must keep a shell of their own, they
need the skill too, and its rules are the same sentences as the prompt section:
a second wording is how one copy ends up softer than the other, and the softer
one is the one obeyed.

Run `zen check` after any change to `agents.yaml` or a skill.

## Writing anything else around it

- **One home per agent.** Once an agent has the rules - in its prompt or in its
  skill - no house rule, other skill or prompt line restates them. A prompt that
  needs to point at the skill names it: _"Follow `code_python` for every
  script."_
- **Never add an exemption.** _"Hard-coding is fine for a quick one-off check"_
  is a permission: every probe is a one-off by construction, so the exception
  admits exactly what the rule forbids. The same goes for `python -c`.
- **Never show a one-off as an example.** A prompt or skill that shows
  `python -c "..."`, or a script with a literal id, date or path in its body,
  teaches the shape the rule forbids. Every example invocation passes its values
  as named arguments:
  `python /workspace/scripts/list_overdue_invoices.py --customer-id 42`.
- **Never show the asker as an argument.** `--user-id`, `--email` or `--me` for
  the person asking teaches the model to fill in who someone is. An example for
  "my invoices" passes no user at all -
  `python /workspace/scripts/list_my_overdue_invoices.py --since 2026-01-01` -
  and the script reads `zenera.require_identity()`.
- **Scripts shipped inside a skill** (`agents/skills/<name>/scripts/`, §3.4.1 of
  the copilot instructions) follow the same rules: named arguments, a `--help`,
  the result on stdout, an `--output` path under `/workspace` for any file,
  since `/skills` is read-only.
- **Memory is what makes the reuse happen.** A code-writing agent without
  memory still writes reusable scripts, but cannot find them in a later session.
  Say so if the project expects reuse and that agent has no `memory:`.

## Review

- [ ] Every agent that writes or runs code has the rules - a prompt section for
      a dedicated code agent, the `code_python` skill reachable for the others
- [ ] Every rule under _Keep in substance_ is there, none softened, and the
      memory steps match whether the agent holds the memory tools
- [ ] Generic agents beside a dedicated code agent hand code work to it, or
      carry the same wording - not a second paraphrase
- [ ] No other prompt, skill or house rule restates the rules, adds an
      exemption, or shows `python -c` or a script with literal values
- [ ] No script or example takes the asking user as an argument; per-user
      scripts read `zenera.require_identity()`
- [ ] Every script shipped in a skill takes its values as named arguments
