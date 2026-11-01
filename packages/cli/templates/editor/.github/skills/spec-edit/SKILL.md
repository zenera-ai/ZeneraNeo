---
name: spec-edit
description: Change SPECIFICATION.md as the request given with the command asks - written in the specification's own structure and voice, checked against what the runtime can actually do - and nothing else. SPECIFICATION.md is the only file it may edit (plus a throwaway temp file when a computation needs one). Never explores the project or the environment; discovering how things work is /spec-sync-project's job.
argument-hint: 'what to add, change or remove in the specification'
disable-model-invocation: true
---

Edit `SPECIFICATION.md` the way the request given with this command asks. The
specification is the intent of the project; you are changing the intent, not
the implementation. Making the project match it is `/spec-sync-project`, which
runs after this.

**The only file you may edit is `SPECIFICATION.md`.** Do not create, edit,
rename, move or delete any other file in the project - not `agents.yaml`, not a
prompt, not a skill, not a script, not `sandbox/`, not
`SPECIFICATION-FEEDBACK.md`, not a new notes or draft file. The one exception:
when a computation genuinely needs scratch space, you may use a temporary file
outside the project (created with `mktemp` in the system temp directory), and
you delete it before you finish. Anything else the request seems to need
changed goes into the report for `/spec-sync-project`, never into the project.

## 0. Size the edit, then read only what it needs

If no request was given with the command, ask what to change and stop.

### Decide the kind of edit first

From the request and `SPECIFICATION.md` alone, before reading anything else:

- **Greenfield** - `SPECIFICATION.md` is still the `zen init` scaffold (generic
  placeholders such as "Carry out work inside a workspace on request…",
  "Currently: no steps", "the only agent; nobody to hand work to"), or the
  request asks to define or make a specification for a project or domain.
- **Incremental** - anything else: the specification already describes a real
  project and the request asks for a specific change.

Then decide which sections the request touches (§1), because that decides
which skills you read.

### Read in one batch

Always:

- [SPECIFICATION.md](../../../SPECIFICATION.md) - the file you are editing.
- [SPECIFICATION-FEEDBACK.md](../../../SPECIFICATION-FEEDBACK.md) - the questions
  still open against it, and the ones already answered. It may not exist; that
  only means nothing is open.

What the runtime can do, so that what you write is something it can build. On
a **greenfield** edit read all of them. On an **incremental** edit read only the
ones for the sections the request touches; when unsure whether a section is
touched, read its skill:

| Section touched                                             | Skill                                                                                                                                               |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Agents** (split, hand-off, fork)                          | [zen-topology](../zen-topology/SKILL.md) - one agent or several, hand-off or fork, and what each costs                                              |
| **Tools and boundaries** (scripts, writing or running code) | [zen-code-python](../zen-code-python/SKILL.md) - reusable scripts as tools, where they live, and which agents own them                              |
| **Knowledge** / **Setup** (index over OpenAPI)              | [zen-rag-schema](../zen-rag-schema/SKILL.md) - an index over an OpenAPI description                                                                 |
| **Knowledge** / **Setup** (index over documents)            | [zen-rag-docs](../zen-rag-docs/SKILL.md) - an index over a folder of markdown documents                                                             |
| **Memory**                                                  | [zen-memory](../zen-memory/SKILL.md) - what memory is, who may read and write it, and what a strategy for it has to say                             |
| **Environment** (image, packages, network, persistence)     | [zen-sandbox](../zen-sandbox/SKILL.md) - the container: what it mounts, what it can reach, what persists                                            |
| Rules every agent is told                                   | [zen-instructions](../zen-instructions/SKILL.md) - house rules, and what belongs there rather than in a prompt                                      |
| **Models**                                                  | [zen-cli](../zen-cli/SKILL.md) and [its models reference](../zen-cli/references/models.md) - how to find which models this machine can actually use |

Any of these already in your context - attached, or loaded as a skill - you
need not read again. Read the rest in **one** batch of parallel reads, never
one at a time.

### Models

Run this once from the project root, in the same batch, only when the edit is
greenfield, the request names or changes a model, or the specification will use
`memory/`, `assets/docs-db` or `assets/schema-db` and **Models** has no
embedding model yet:

```sh
zen models && zen models ls --chat && zen models ls --embeddings
```

That is the list of models with a credential on this machine - the only ones a
new **Models** line may name. A model the request names that is not in it: run
`zen models search <name>` once; if it is still absent, say so in the chat and
do not write it. A model already in `SPECIFICATION.md` that the request does not
mention is kept as it is and not checked.

### What you never read

This command changes intent, not implementation, so it needs nothing from the
project beyond the files above. Do not open, list or search anything else in
the project: not `agents/`, `scripts/`, `sandbox/`, `resources/`, `assets/`,
`gym/`, examples, code or data, and not the skills' own `references/` beyond
the models reference. Do not run any command other than the `zen models` ones
above and, when a computation needs it, commands that touch only your own
temporary file; do not inspect environment variables, the network, running
processes or installed tools. A path the request names is written into the
specification as named; you do not read it to find out what is in it.

What you would have looked up - an endpoint, an auth scheme, a base URL, a
file layout, how an existing script works - is either stated by role in the
specification (§3, "Unknowns are named, not researched") or settled later by
`/spec-sync-project`, which reads the project.

### Then edit

Once that one batch is read, your next action is the edit to
`SPECIFICATION.md`. If you feel the need to read something more, do not: put it
in the report as an open question instead.

## 1. Understand the request against what is there

Before writing a line, work out - from the request, `SPECIFICATION.md`, the
feedback file and the skills you read, nothing else:

- **How far the edit reaches.** A **greenfield** edit (§0) reaches **every**
  section: replace all generic template sentences and meta-explanations with a
  complete, concrete specification for that domain. An **incremental** edit
  stays narrow: touch only the sections the change implicates.
- **Which sections the request touches.** Usually more than the one it names: a
  new agent changes **Agents**, **Tools and boundaries** and **Done means**; an
  index changes **Setup**, **Knowledge** and **Environment**.
- **What it contradicts.** A sentence already in the specification that the
  request makes false is part of the edit - change it too, and report it.
- **What it settles in the feedback file.** An open question the request
  answers, or an answered one it reverses. Do not edit the feedback file; say
  which questions in the chat.
- **Whether the runtime can do it.** Check the request against the skills you
  read. Something no tool, agent setting or script can provide is not written
  into the specification as if it could be: say so in the chat, offer the
  nearest thing the runtime does do, and write that only if the request leaves
  no doubt it is wanted.

### Example: a narrow incremental request

Request: _"let the agent write code against our appliance's REST API, index the
API specs in `resources/apis/*.yaml`, and add a skill on how to write code for
that API"_, on a specification that already describes the project.

- Kind: incremental.
- Sections: **Agents** (which agent writes and runs the code), **Tools and
  boundaries** (scripts in `/workspace/scripts/`, the API it may call, what
  stays read-only), **Setup** and **Knowledge** (a `zen rag schema` index over
  `resources/apis/*.yaml` in `assets/schema-db`, and the new skill under
  `agents/skills/` with what it holds), **Environment** (the libraries and the
  network access the code needs, credentials by env-var name), **Models** only
  if no embedding model is listed yet, **Done means** (one checkable line per
  new behaviour).
- Skills read: zen-topology, zen-code-python, zen-rag-schema, zen-sandbox -
  plus zen-cli only if an embedding model has to be added.
- Not read: the API spec files, existing scripts, agents, examples, the
  environment.
- In the report: the base URL, auth scheme and any other value only the reader
  has, written into the specification by role and env-var name.

Once these are worked out, your next action is the edit.

## 2. The structure of a specification

Keep the sections the file already has, in its order. Add a section only when
the request needs one, at its place in this order, and leave out any section
that would be empty:

```markdown
# Specification

## Purpose

## Scope

## Models

## Setup

## Agents

## Tools and boundaries

## Knowledge

## Memory

## Environment

## Testing

## Done means

## Out of scope
```

What each one answers:

- **Purpose** - what the system produces, and for whom, in one paragraph.
- **Scope** - what one request covers, what is in and what is not, hard numeric
  bounds (when a request is refused with a count rather than truncated), and
  what has to happen before the system acts.
- **Models** - every chat and embedding model by its full id from `zen models`,
  and which agent or job uses which. Keep the chat model already in
  `SPECIFICATION.md` unless the request asks to change it; add an embedding
  model from `zen models ls --embeddings` whenever the specification uses
  `memory/`, `assets/docs-db`, or `assets/schema-db`.
- **Setup** - what has to exist before a run: OpenAPI specs or reference
  documents fetched, a `zen rag schema` index built in `assets/schema-db`, a
  `zen rag docs` index built in `assets/docs-db`, or reference files generated.
  Each is a named step `scripts/_setup.sh` runs in order; say what it produces,
  from what inputs, and where it lands.
- **Agents** - one entry per agent: its name, its one job, who it hands to or
  forks, and the behaviours that are specific to it. Use **zen-topology** to
  choose the right shape: split into focused agents (for example, a lead
  coordinator/analyst, a dedicated quantitative/code agent, and a read-only
  research agent) when tasks have distinct tool boundaries or heavy code
  execution (**zen-code-python**), and specify `fork` (`context: none`) when a
  request compares multiple independent items or runs independent research
  tracks in parallel.
- **Tools and boundaries** - what each agent may reach for (files, shell,
  reusable scripts in `/workspace/scripts/`, web search/read, memory, indexes,
  external APIs), what is read-only, how transient network/API errors are
  retried and fallen back from, and what nothing may reach. Every capability
  named here has an agent that holds it.
- **Knowledge** - each index (`assets/schema-db`, `assets/docs-db`), each skill
  under `agents/skills/` (naming the skill and the concrete procedure, formulas,
  API conventions, or `rag_search` rules it holds), and the concrete external
  APIs or data sources the project queries (naming specific zero-key primary
  APIs and endpoints, required headers and rate limits, optional free-tier
  keyed APIs, and fallback order).
- **Memory** - what is worth remembering (reusable scripts as `file` nodes,
  verified identifiers/mappings, API schemas, workflows) and what is not (or
  how time-sensitive facts are bounded), who may read and write, and when an
  agent recalls before working and commits after it - see **zen-memory**.
- **Environment** - the sandbox (`sandbox/Dockerfile`, persistence, network),
  the exact languages, CLI tools, and libraries pre-installed in the image so
  agents never install packages at run time, where scripts and data outputs
  live under `/workspace`, and the environment variables or credentials the
  project itself needs (an external API, a service) by name - see
  **zen-sandbox**. Never the credentials of chat or embedding models (§3).
- **Testing** - how a change to the project is checked: `zen check`,
  `scripts/_setup.sh --check`, `scripts/_setup.sh` run twice in a row reporting
  `skipped` the second time, and a concrete verification request the project
  must handle end-to-end.
- **Done means** - how a finished job is told from an unfinished one, written as
  concrete acceptance tests in prose that a reviewer could check against a run
  (exact attribution fields, script-computed numbers, verified page reads,
  reusable script paths, and required sections).
- **Out of scope** - what the runtime could do that this project deliberately
  does not, so nobody adds it because it seemed useful.

## 3. How to write it

- **Replace scaffold boilerplate on a greenfield request; change the smallest
  thing on an incremental edit.** When `SPECIFICATION.md` is still the initial
  `zen init` scaffold or the request asks to make a specification for a new
  project, rewrite every section for that domain and remove the scaffold's
  generic meta-commentary ("What the work always needs belongs in the image…",
  "Currently: no steps…", "The reply names what changed, file by file…"). When
  editing an already-written domain specification, leave every sentence the
  request does not reach as it is.
- **Write in a direct, declarative voice.** Match the clean heading and list
  structure of the specification, stating concrete project rules rather than
  abstract explanations of how Zenera works.
- **Say what and why, never raw config syntax.** The specification is not
  `agents.yaml` in prose. Name the agents, skills, setup steps, indexes, APIs,
  packages, paths, and behavioural rules clearly, without pasting raw YAML
  snippets or shell implementation internals that `/spec-sync-project` derives.
- **On a greenfield request, turn high-level domain requests into concrete
  architectural choices.** When a request asks to design a project in broad
  terms (for example, "make a specification for financial analytics using open
  APIs"), do not repeat vague phrases like "open APIs" or "packages for data
  analysis". Make the concrete domain choices upfront, from what you know of
  public APIs and libraries and from the skills you read, so
  `/spec-sync-project` can build a working system without guessing:
    - Name specific, working zero-key public APIs and endpoints as primary
      sources (with required headers such as `User-Agent` and rate limits),
      optional keyed free-tier APIs as secondary sources with clean zero-key
      fallback when keys are absent, and `web_search` / `web_read` rules.
    - Name the concrete setup steps (`scripts/<name>.sh`), indexes
      (`assets/schema-db`, `assets/docs-db`), and domain skills under
      `agents/skills/`.
    - Name the exact Python/system libraries to pre-install in
      `sandbox/Dockerfile` and the `/workspace/scripts/` and `/workspace/data/`
      conventions from **zen-code-python**.
    - State explicit numeric limits (such as the maximum entities/tickers per
      request before refusing with a count), retry/fallback rules, and required
      citation fields.
- **On an incremental request, write what the request states.** Add what it
  asks for, plus the changes it forces in other sections (§1), in the same
  level of detail the specification already uses. Do not design beyond it.
- **Unknowns are named, not researched.** A value the request and the
  specification do not give - an endpoint, a base URL, an auth scheme, a
  credential, a file layout - is written by role and env-var name (for example
  "the appliance base URL from `APPLIANCE_URL`, credentials from
  `APPLIANCE_USER` and `APPLIANCE_PASSWORD`") and listed in the report as a
  value only the reader has. Never look for it in the project or the
  environment, and do not stop to ask for it.
- **Be specific where a reader could decide either way.** A limit is a number,
  a model is an id, a failure has a stated outcome. "Handles large inputs" is
  not implementable; "a request over 25 tickers is refused with a count, never
  truncated" is.
- **Never invent a model id or a user-owned secret.** Keep the model already in
  `SPECIFICATION.md` unless the request asks to change it, and take any new
  chat or embedding model strictly from the `zen models` output on this machine,
  never from memory.
- **Never name a model provider's credential.** `OPENAI_API_KEY`,
  `ANTHROPIC_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS` and the like live in
  the zen keyring and reach every run, setup step and sandbox without the
  specification saying so. A **Models** line names the model id, not the key
  behind it; **Environment** and the report list only the credentials of
  external services the project calls. If `SPECIFICATION.md` already names a
  model key, remove it as part of any edit to that section.
- **Make it checkable.** Every behaviour the request adds gets a line under
  **Done means** that a reviewer could verify against a recorded run.
- **Name what is now excluded.** When the request narrows the system, the thing
  it rules out goes under **Out of scope**.
- **Say it once.** If the rule already lives in another section, change it
  there rather than stating it a second time somewhere new.

## 4. Report

In the chat:

- every section you changed, with each new or changed line quoted
- every edit the request did not name but made necessary, and why
- every open question in `SPECIFICATION-FEEDBACK.md` the change settles or
  reopens, by number
- anything you did not write because the runtime cannot do it
- every value written by role or env-var name that only the reader has, and
  anything you would have wanted to look up but did not (§0)
- every change outside `SPECIFICATION.md` the request implies, left for
  `/spec-sync-project` rather than made
- then, in one line: send `/spec-sync-project` to make the project match.

## 5. The request

The words given with the command are the request the specification should
address. Without them, ask what to change and stop (§0).
