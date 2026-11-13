# Specification-driven projects

A Zenera project is a folder of files an agent can read and change: prompts,
skills, `agents.yaml`, a Dockerfile, a few scripts. That makes it a rare thing -
a system whose implementation an agent can actually maintain, provided somebody
says what it is supposed to do.

`SPECIFICATION.md` is where that is said. It is the intent; everything around
it is the implementation. Where the two disagree the specification wins, so a
change to what the system does starts there and not in `agents.yaml`.

`zen init` writes one, and the one it writes is true: it specifies the project
that was just scaffolded, line for line, so you start from a specification and
its implementation rather than from an empty heading list.

## Getting to it

```sh
zen init my-project      # writes SPECIFICATION.md and the project implementing it
zen open my-project      # opens that folder in your editor
```

`zen open` launches the editor you already use - the one this terminal belongs
to, or `$ZENERA_EDITOR`, or the first of VS Code, Cursor, Windsurf, Zed, Sublime
Text or IntelliJ it can find; `--editor <cmd>` names one outright. On the way in
it rewrites `.vscode/settings.json` and the `.github/` tree, so the chat
commands below are always the current ones.

Then, in that window:

1. **Edit `SPECIFICATION.md`.** What the system is for, which agents exist, what
   each may reach for, and what _done_ means.
2. **Open the chat panel and send `/spec-sync-project`.**
3. **Answer `SPECIFICATION-FEEDBACK.md`.** It is a questionnaire: every question
   carries two to four written-out answers, each with a `[ ]` box. Put an `x` in
   the box of the one you want, delete the ones you do not, or write your own in
   their place - any of those is an answer.
4. **Send `/spec-apply-feedback`.** It folds the answers you chose into
   `SPECIFICATION.md` - which is why you never edit a prompt to fix a
   specification problem - and then `/spec-sync-project` again.

Back in the terminal: `zen check`, `scripts/_setup.sh`, `zen run`.

`zen init` installs these commands as skills under `.github/skills/`, which
VS Code and the Copilot CLI offer as chat slash-commands:

| In chat                | Does                                                             |
| ---------------------- | ---------------------------------------------------------------- |
| `/spec-sync-project`   | Makes every file match `SPECIFICATION.md`, both directions.      |
| `/spec-apply-feedback` | Folds your answers in `SPECIFICATION-FEEDBACK.md` into the spec. |
| `/project-review`      | Reads the project as a reviewer would, and reports.              |
| `/new-agent`           | Adds an agent - prompt, wiring and hand-offs.                    |
| `/new-skill`           | Adds a skill under `agents/skills/`.                             |

In an editor with no support for skills, paste the contents of
`.github/skills/spec-sync-project/SKILL.md` into its chat instead - it is only a
prompt, and it says everything it needs about where to look.

## The loop

```
edit SPECIFICATION.md
        ↓
/spec-sync-project       make the files match it
        ↓
SPECIFICATION-FEEDBACK.md   what it could not do without guessing:
        ↓                   tick one answer per question
/spec-apply-feedback        the ones you chose become the spec
        ↓
zen check                the project still loads
        ↓
scripts/_setup.sh        what has to be built is built
        ↓                (--check first, to see what is missing)
zen run                  see whether it does the thing
        ↓
edit SPECIFICATION.md    ← the report goes back into the spec, not into a prompt
```

The turn that matters is the last one. When a run comes out wrong, the fix is
not a sentence bolted onto a prompt - it is the sentence that was missing from
the specification, after which the prompt edit follows from it. Prompts patched
directly drift away from the document that is supposed to describe them, and a
project whose specification is no longer true is a project with no specification.

### `/spec-sync-project`

`zen init` installs `.github/skills/spec-sync-project/SKILL.md`, so the command
is available in your editor's chat from the first minute - type `/` in the chat
panel and it is in the list. It is a long prompt and worth reading once; in
outline it:

1. **Reads everything before editing anything** - the specification, then
   `agents.yaml`, the house rules under `agents/`, every prompt, every skill, the
   assets, the Dockerfile and the scripts. Then runs `zen check`.
2. **Builds a difference list both ways.** Forwards: for each item in the
   specification, is it present, missing, divergent or unclear. Backwards: for
   each line of each prompt and skill, which specification item does it serve -
   a line serving none is an **extra**, and that is how prompts stop growing
   sediment.
3. **Changes the smallest thing that closes the gap** - a prompt edit over a new
   skill, a new skill over a new agent, a tool grant over asking the model to
   remember. A capability gap is a `tools:` grant _plus_ the prompt line that
   says when to use it, because a granted tool no prompt mentions is not
   implemented.
4. **Never invents a value you did not state.** A model id, a limit, a retry
   count, a path - an unstated value becomes a question, not a guess.
5. **Writes `SPECIFICATION-FEEDBACK.md`** for everything it could not settle,
   grouped under 🛑 blocking, ❓ ambiguous, ⚡ contradictions, ✏️ errors, ➕ out
   of scope. Each question quotes the specification, says what goes wrong, says
   what was built in the meantime, and offers two to four answers - each one a
   line you could have said yourself, what choosing it would change, and the
   text that goes into the specification if you do.
6. **Runs `scripts/_setup.sh` and watches it finish**, then runs it again to
   prove every step reports `skipped`.

Read the feedback file first, every time. It is the shortest description of what
your specification does not yet say.

#### Incremental passes

After the first completed pass, `.spec-sync/` records the specification,
wiring, agent files and unresolved work that pass left behind. The next sync
reads their diffs instead of starting from nothing. Generated house-rule drift
is reported separately as maintenance and repaired by `zen check --fix`.

Two narrow tiers avoid a full audit:

- **Spec-only:** no project implementation change or requirement affecting
  runtime behavior, under the sync skill's eligibility rules.
- **Model-reference-only:** replace an existing chat model reference without
  changing providers, agent assignments, prompts, skills or setup. Embedding
  changes and sandbox version pins are not eligible model-reference changes.

Outstanding implementation work in feedback or the previous pass's `Still open`
prevents these narrow tiers. Other incremental passes load only capability
skills their changes reach; the first pass still checks every enabled capability.
When setup has no steps, one successful `scripts/_setup.sh --check` suffices.

A model-reference-only pass validates configuration and probes models once.
It may skip the sandbox probe only after confirming the sandbox and its build
inputs are unchanged. Pin repairs require a sandbox check. The shipped
`review.sh check` and `review.sh --skip-check` commands allow the final review
to reuse successful validation for unchanged project inputs, rather than
probing again. Receipts are for the same pass, not a long-lived health cache.

`snapshot.sh record` fills in a history entry's timestamp and specification hash
from explicitly supplied outcomes and unresolved items. It does not certify
those claims or move the baseline: `snapshot.sh commit` remains the separate,
last step after verification.

### `/spec-apply-feedback`

Answering the feedback file is a tick or a delete. Under every question are two
to four answers, each headed by a `[ ]` box: mark one `[x]`, or delete the ones
you do not want, or - where none of them is right - replace them with a sentence
of your own. Then `/spec-apply-feedback` takes the answer you chose, puts
its text into `SPECIFICATION.md` at the line the answer names, and moves the
question to an `✅ Answered` section recording what was chosen and what still
has to be built for the specification to be true.

It edits those two files and nothing else. A question with two answers still
under it and no box ticked has not been answered, and it is left alone; a
question with none left means you rejected them all, and it asks you what would
fit rather than inventing a fifth. Send `/spec-sync-project` afterwards - the
specification has changed, and the project has not yet caught up.

## A worked example

From a few sentences to a working two-agent system, with no hand-written wiring.

```sh
zen init repo-notes && cd repo-notes
zen open
```

Replace `SPECIFICATION.md` with what you want. This is the entire input - no
YAML, no prompt files:

```markdown
# Specification

## Purpose

Read a codebase and leave a short written note about it in the workspace.

## Agents

- `reader` - explores the workspace and forms a picture of it. May read files
  and list directories, and nothing else. Hands off to `writer`.
- `writer` - turns that picture into `NOTES.md`. May write to the workspace.

## Done means

- `NOTES.md` exists, is Markdown, and is under 40 lines.
- Every claim in it comes from a file that was actually read.
```

Run `zen meta run /spec-sync-project` (or send `/spec-sync-project` in the
editor's chat). It writes `agents.yaml`, which says who exists and what each may
use:

```yaml
default: reader
model: openai/gpt-5.4-mini

agents:
    - name: reader
      description: Reads the workspace and summarises what is in it.
      system: agents/prompts/reader.md
      tools: [files:read_file, files:list_dir, files:find_files]
      handoffs: [writer]

    - name: writer
      description: Turns a summary into a file on disk.
      system: agents/prompts/writer.md
      tools: [files:*]
      handoffs: [reader] # a hand-off does not return by itself; give it a way back
```

It also writes one prompt file per agent.

`agents/prompts/reader.md`:

```markdown
You explore a codebase and describe it plainly: what it is, how it is laid out,
how it is built and tested. Read before you conclude. When you have a picture,
hand off to `writer`.
```

`agents/prompts/writer.md`:

```markdown
You write the summary you were handed to `NOTES.md`, in Markdown, under 40
lines. Then say where you put it and stop.
```

What each key means is in [agents-yaml.md](agents-yaml.md#agents). The file is
validated strictly at load: an unknown tool, a hand-off to nobody, a missing
prompt file each fails immediately and names the offending key, instead of
surfacing three turns into a run as a confused model
([errors caught at load](agents-yaml.md#errors-caught-at-load)).

Check it, then point it at a real directory:

```sh
zen check                                  # validates every file it names
cd ~/code/some-repo
zen run repo-notes --here "summarise this repo"   # --here: the current directory is the workspace
zen inspect --project repo-notes --open    # what it actually did
```

`repo-notes` is now a command like any other, usable from any directory.
Commit the folder, and whoever clones it runs `zen init repo-notes` once: an
existing project is registered, not rebuilt, and nothing in it is touched.

Two complete projects built this way, each from a specification alone, are in
[`examples/projects/`](../examples/projects/).

## Writing a specification an agent can implement

The scaffolded file has the headings worth keeping:

| Section                  | The question it answers                                           |
| ------------------------ | ----------------------------------------------------------------- |
| **Purpose**              | What the system produces, in one paragraph                        |
| **Scope**                | What is in, what is out, and what a single request covers         |
| **Agents**               | Who exists, what each is for, and who hands to whom               |
| **Tools and boundaries** | What each may reach for, and what nothing may reach               |
| **Environment**          | Models, container, network, what has to exist before a run        |
| **Done means**           | How a finished job is told from an unfinished one                 |
| **Out of scope**         | What the runtime could do that this project deliberately does not |

Two of those do more work than the rest.

**Done means** is what turns a description into something checkable. "Reports
its findings" cannot be implemented; "the reply names every file it changed, and
every claim about a command is one it ran and read the output of" can be, and
can be reviewed afterwards. Write the acceptance test in prose.

**Out of scope** is what stops a helpful agent from adding memory, a second
agent and a document index because they seemed useful. Naming the thing you are
not doing is cheaper than removing it later.

### Be specific where a reader could decide either way

An ambiguity here becomes a guess three files away, and a value nobody stated
becomes one somebody invented. Say the model. Say the limit. Say what happens
when the answer is not knowable - because if you do not, something will be
written down that sounds right.

| Instead of                  | Write                                                                   |
| --------------------------- | ----------------------------------------------------------------------- |
| "handles large inputs"      | "a request over 200 files is refused with a count, not truncated"       |
| "uses a fast model"         | "`openai/gpt-5-mini`, with reasoning off"                               |
| "asks the user when unsure" | "asks at most once per run, and only for a value nothing else supplies" |
| "should be reliable"        | "a failed tool call is retried once, then reported"                     |

### Say it once

The specification is not a copy of `agents.yaml` in prose. It says _what_ and
_why_; the files say _how_. If a line of the specification could be pasted into
`agents.yaml` unchanged, it is probably configuration that wandered into the
wrong file.

## Setup steps are scripts

Anything that has to be done before the project can run - an index built, a
document fetched, a file generated - is a script under `scripts/`, and
`scripts/_setup.sh` is the only entry point. Not a paragraph in a README that a
person is supposed to follow, because the thing following it is usually an
agent.

```sh
scripts/_setup.sh            # do whatever is not done yet
scripts/_setup.sh --force    # do all of it again
scripts/_setup.sh --check    # say what is not done, and do none of it
```

The runner `zen init` writes holds a `STEPS` list at the top and runs
`scripts/<name>.sh` for each name, in order, teeing each one's output to
`.tmp/logs/setup-<name>.log` and finishing with one line per step. Adding a step
is adding a file and a name.

Each step exits **0** when it did the work, **3** when there was nothing to do,
and non-zero when it failed - which is how a second run can report `skipped` and
prove itself re-entrant. A step writes into `.tmp/` and moves the result into
place, so an interrupted build never leaves half an artefact behind, and reads
`$FORCE` to know whether `--force` was passed.

A step decides it has nothing to do by testing for something that **survives a
clone**. Git-ignored output does not: a rag index commits its `manifest.json`
and ignores `lance/`, so `[ -f "$OUT/manifest.json" ]` is true on a fresh
checkout that cannot search at all, every step reports `skipped`, and the
failure appears much later as a search error nobody connects to setup. Ask the
tool instead - `zen rag docs ready --dir "$OUT" --quiet` exits 0 only when the
index can answer, and `zen rag docs restore --dir "$OUT"` re-embeds it from the
copies it already carries.

That same test is the whole of `--check`, which is why the dry run is a flag on
the runner rather than a second script: the steps already know what "done"
means, and asking them is cheaper and more honest than a second opinion about
what a directory ought to contain. Under `$CHECK` a step makes its test, does
none of the work, and exits **3** when there is nothing to do or **4** when
there is - reported as `needs setup`, and a non-zero exit overall. It answers
the question `zen check` cannot: `zen check` says the project loads, this says
it can run.

Everything transient lives under `.tmp/`, which is git-ignored: deleting it must
leave the project runnable and `scripts/_setup.sh` re-runnable.

## `zen check`

`zen check` validates the project - that it loads, that every model reference
resolves, that every agent's tools and handoffs exist, that the sandbox is
buildable. It says nothing about whether the prose is any good, which is what
the review pass in `/spec-sync-project` is for. Run it before the setup script and
again after the changes.

## Further

- [projects.md](projects.md) - what a project directory is, and how it loads
- [agents-yaml.md](agents-yaml.md) - the configuration reference
- [knowledge.md](knowledge.md) - giving agents a corpus to search
- [integrations.md](integrations.md) - giving agents an API to work against
- [memory.md](memory.md) - carrying something from one session to the next
