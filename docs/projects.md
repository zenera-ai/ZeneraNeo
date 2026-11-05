# Creating a project

A project is a folder. It holds the same objects an author would otherwise
construct in TypeScript - agents, prompts, models, skills - serialised to files
that a non-programmer can edit. The loader introduces no runtime concept of its
own: everything it does is assembly.

See [agents-yaml.md](agents-yaml.md) for the configuration reference,
[specification.md](specification.md) for the loop that maintains all of it, and
`examples/sdk/project.ts` for a runnable version of everything below.

## Layout

```
my-project/
    SPECIFICATION.md                 what this project is for - the intent
    agents.yaml                      who exists, what they may reach for
    agents/
        instructions.md              house rules, prepended to every agent
        files-instructions.md        more of them, one topic at a time
        memory-instructions.md
        tools-instructions.md        how tools are called
        prompts/
            intake.md                one agent's own brief
            adjuster.md
        skills/
            house_style/
                SKILL.md         a skill; its files ship with it
            refund_policy/
                SKILL.md
                scripts/calculate.py
    assets/                          reference material, read-only at /assets
    scripts/_setup.sh                the one command that initialises it
```

Only `agents.yaml` is required, and only `agents:` is required inside it.
`SPECIFICATION.md` and `scripts/_setup.sh` are conventions the tooling knows
about rather than files the loader reads.

The `zen` CLI adds a few more conventions around the same folder:

```
my-project/
    dataset/                         evaluation cases and rubrics
    finetune/                        tuning status and per-case feedback
    sandbox/Dockerfile               the container commands run in
    .spec-sync/                      what the last sync with the specification applied
    .env                             this project's environment - git-ignored
    .env.example                     the names .env needs, without values
    .env.test                        read instead of .env by Zenera Lite's test chats - git-ignored
    sessions/                        one workspace, memory and trajectory each
        <id>/
            workspace/               what the agents can read and write
            runs/<id>/               input, output, state, report.html, graph.mmd, meta
```

Everything outside `sessions/` is the system; everything inside it is what
happened when it ran. Model credentials live in `$HOME`, never in the project,
so there is no secret to strip before sharing. `zen init` also writes `.vscode/`
and a `.github/` tree with the brief, prompts and skills a coding agent needs to
keep the project matching its specification; `zen check --fix` refreshes them
after an upgrade and touches nothing that describes your project.

The config file is found by looking for these names, in order:

1. `agents.yaml`
2. `agents.yml`
3. `agents/agents.yaml`
4. `agents/agents.yml`

## Loading

```ts
import { loadProject } from '@zenera/neo';
import { tool } from '@zenera/neo';

const project = await loadProject('./my-project', {
    tools: [policyLookup, fileClaim],
});

for await (const ev of project.run('Water damage, policy NM-448127.')) {
    // ...
}
```

`loadProject` reads **every** file the project will ever need, up front. A
missing prompt, an unknown tool name, a hand-off to nobody, a `preload:` naming
a skill that is not in the catalog - all of these fail at load with the
offending key named (`agents.adjuster.handoffs: unknown agent "resolvr"`),
rather than surfacing three turns into a production run as a confused model.

### `ProjectOptions`

Config can _name_ things; it cannot _contain_ code. These options are the seam
where code re-enters the declarative system.

| Option       | Purpose                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------ |
| `tools`      | Tool implementations by name. Resolves both `agents[].tools` and a skill's `tools:` header |
| `providers`  | Provider specs, merged **over** `providers:` - how ops repoints a key without a commit     |
| `models`     | Aliases merged **over** `models:` - the host decides what `fast` means this week           |
| `embeddings` | The same, for `embeddings:` - host last, for the same reason                               |
| `registry`   | An existing `ModelRegistry` to populate instead of a fresh one; share it to share clients  |
| `memory`     | `MemoryStore[]` handed to the runner                                                       |
| `payloads`   | A `PayloadStore` handed to the runner                                                      |
| `skills`     | Extra `SkillProvider`s, appended to the one the project declares                           |
| `skillsAt`   | Where the host mounted the skill catalog, so a skill can point at its own files            |

Host options always win. A repository describes intent; a deployment overrides
it, never the other way round.

## The loaded project

`AgentProject` is immutable, and therefore shareable. Load it once per process
and let every chat use the same instance - nothing per-conversation lives on
it. A conversation _is_ its `AgentState`; caller data reaches tools through
`RunOptions.context`. Two chats holding the object cannot observe each other.

There is a quieter payoff: because tool schemas are fixed at load and do not
change as skills activate, every chat on a shared project opens with a
byte-identical `[tool schemas][system prompt]` prefix. That is a provider cache
hit _across_ conversations, not merely within one.

| Member               | What it is                                                |
| -------------------- | --------------------------------------------------------- |
| `root`, `source`     | Resolved project directory, and the config file read      |
| `config`             | The parsed, validated `ProjectConfig`                     |
| `entry`              | Name of the agent a run starts on                         |
| `agents`, `registry` | The assembled agents                                      |
| `models`             | The `ModelRegistry`, with its memoized clients            |
| `embedder(name?)`    | A declared vectoriser, memoized; the default when unnamed |
| `assets`             | The resolved reference directory, or `undefined`          |
| `skillProviders`     | The catalogs bound agents draw on                         |
| `runner(overrides?)` | The shared `AgentRunner`; pass overrides for a fresh one  |
| `run(input, opts?)`  | Starts a run on `entry` with the shared runner            |

## Prompts

Each agent's instructions are assembled in a fixed order:

1. The house rules - read **once** and shared by every agent, so the report says
   "one document, five prompts" instead of five identical blobs:
   `agents/instructions.md`, then every `agents/<topic>-instructions.md` in
   filename order. The name is deliberately not `AGENTS.md`: that one is claimed
   by coding assistants, and these rules address _this project's_ agents.
2. The agent's own file: `system:` if given, otherwise
   `agents/prompts/<name>.md` if it exists.

Each arrives as its own block, tagged with the path it came from - `<house_rules
src="agents/memory-instructions.md">` - so the model can tell one document from
the next and a report can say which file a rule was in.

A topic file earns its own document when it is true for every agent but is about
one capability: the memory usage rules travel with the `memory:` block, and a
project that switches memory off deletes one file rather than editing around a
section. Filename order, because it is the only order that is the same on every
machine.

A document that is only about one capability can say so, and then reaches only
the agents that have it:

```markdown
---
requires: [fork]
---

Branches run at once and can exchange nothing...
```

`requires:` takes a list, and all of it has to hold. The vocabulary is closed -
`fork`, `memory`, `memory-write`, `memory-forget` - and a name outside it is a
load error rather than a rule that silently never fires. There is no `not`: a
rule for agents _without_ a capability is a rule about the rest of the project,
which is what `agents/instructions.md` is for. A document with no frontmatter is
unconditional, which is the usual case.

Shared context before the specific job - which also puts the stable half of the
prompt in front, where a cache can reuse it. All of them are optional; an agent
with neither simply has no instructions.

## Paths

Every path a project file names goes through one chokepoint. A project is data
someone else may have written, so `system: "../../.ssh/id_rsa"` is a load-time
error, not a prompt containing a private key.

- Paths are resolved against the **project root**, never `process.cwd()`, so a
  project loads identically from any working directory.
- Anything resolving outside the root is rejected.
- `file:///abs/path` is accepted and normalised; `file://host/...` is refused.

## Skills

The `skills:` key takes one directory or several. If it is absent and
`agents/skills` exists, that is used. Several directories become **one**
provider (id `project`), not several - a binding names exactly one catalog, and
"which folder is this skill in?" is not a question an agent author should have
to answer.

A skill is a **directory holding `SKILL.md`**, and the directory name is the
skill name:

```
<dir>/refund_policy/SKILL.md    the instructions
<dir>/refund_policy/rates.csv   whatever they refer to
```

`FileSkillProvider` also indexes a bare `<dir>/refund_policy.md`, which is how
the provider has always behaved and what a library host may still rely on. It
is not a project layout: `zen check` reports it as `skill.flat`, because a
skill with no directory of its own can never ship the table, example or script
that is half of what a skill is for.

Frontmatter is a deliberately small subset of YAML - `key: value`, plus
`[a, b]` flow lists for `tags` and `tools`:

```markdown
---
name: refund_policy
description: When a refund is owed, and how much.
version: 2
tags: [billing, policy]
tools: [issue_refund]
---

The written policy follows...
```

Every key is optional. `name` defaults to the directory name and `description`
to the first non-empty line of the body, so the minimum viable skill is a
`SKILL.md` with no frontmatter at all.

`tools:` names are resolved against `ProjectOptions.tools`. Skill-owned tools
are declared to the model from turn one and gated at call time - they are never
appended mid-run, because a growing tools array destroys the provider's prompt
cache.

### Files and scripts

A skill ships more than text. Pass `ProjectOptions.skillsAt` - the CLI passes
`/skills` - and each skill is loaded with a `path`, the name its directory can
be reached by, and its rendered instructions say so:

```
<skill name="house_style" src="house_style/SKILL.md">
This skill's files are at /skills/house_style, read-only. Paths written in it
are relative to that directory.
...
</skill>
```

`src` is the skill file relative to the catalog root - the same contract as a
prompt block's `src`, so the model can name the file to edit and the prompt
stays identical on every machine.

That is what makes `python /skills/house_style/scripts/lint.py` runnable rather
than aspirational. The CLI bind-mounts the whole catalog into the sandbox
read-only and hands the same paths to the file tools; a library host that mounts
nothing leaves `skillsAt` unset, and no skill claims a directory that is not
there.

What follows from that, for whoever writes the skill:

- The body names files by their **absolute** `/skills/<name>/...` path. A skill
  is loaded into a prompt, not executed from its directory, and the working
  directory is the workspace.
- The mount is read-only. A script that produces a file takes an output path and
  writes it under `/workspace`.
- The agent needs the tools to act on it - `sandbox:*` to run a script,
  `read_file` to open a data file - and the interpreter has to be in the sandbox
  image already.
- One catalog is the whole of `/skills`; several take `/skills/<folder>` each,
  and two directories ending in the same name are a load error rather than one
  quietly hiding the other.
- Every mount exists before anything is loaded, so a binding's `allow:` decides
  what an agent may **load**, not what it may **read**.

## Assets

`assets:`, or an `assets/` folder next to `agents.yaml`, is material every
agent can read and none can write. It is mounted at `/assets` - the file tools
resolve paths under it, the container sees it bind-mounted `:ro`, and every
tool that would change it refuses.

It is project-wide. There is no per-agent key: the mount is fixed when the
container is created, so it could not vary by hand-off, and an agent that may
see only part of the material is a different project.

`AgentProject.assets` is the resolved directory, or `undefined`.

## Tools and the sandbox

Config can name a tool; it cannot contain one. Nothing is wired in by default -
the file tools and the shell tools are ordinary arrays the host passes in, which
is what keeps a loaded project from being able to touch anything the host did
not hand it.

```ts
import { loadProject, fileTools, sandboxTools, WORKSPACE_MOUNT } from '@zenera/neo';

const project = await loadProject('./my-project', {
    tools: [...fileTools({ root: workspace, mount: WORKSPACE_MOUNT }), ...sandboxTools(pool)],
});
```

- `fileTools({ root, readOnly, mount, mounts })` - `read_file`, `list_dir`,
  `find_files`, and `write_file`, `apply_patch`, `copy_file`, `move_file`,
  `delete_file` when it is writable. Everything is contained to `root`,
  resolving symlinks first.
- `sandboxTools(pool)` - `run_command`, `run_command_background`,
  `read_command_output`, `stop_command`, all in group `sandbox`.
- `identityTools(user)` - `current_user`, in group `identity`: who the run acts for. Pass
  it as `alwaysTools` and every agent gets it without naming it, though
  `-current_user` still removes it. See [identity.md](identity.md).

Pass `mount` and both sets speak the same names: a path a command prints in the
container is a path `read_file` accepts. That is the reason for the key, and it
is worth setting whenever both are present.

**The loader never starts a container.** `sandbox:` is validated and left on
`project.config.sandbox` for the host to act on, because building an image and
running a container are host concerns - `SandboxSpec` does not know what a
Dockerfile is. `zen run` resolves that block into one box for the session and
passes the tools above; a host embedding the runtime does the same thing
itself. Every agent of the session shares that box.

### Where the sandbox runs

A **sandbox** is everything a session's agents work in: one place their
commands run, and the files those commands see. Every agent of the session
shares it. It lives in its own package, `@zenera/sandbox`, which depends on Node
alone (`@zenera/neo` re-exports it). The tools are written against one
interface, so it does not have to be on this machine:

- `Sandbox` - `start`, `exec`, the job calls
  (`startJob` returns an id, `readJob` a `JobOutput`, `stopJob` a
  `JobStopped`; an unknown id is a `SandboxError`), and `close` at the end of
  a turn. It also holds the files: `fs`, an `FsDriver`, and `files(opts)`,
  which turns the host's workspace and mounts into the paths `fs` actually
  finds them at. The invariant every implementation keeps: **a file written
  through `fs` is the file `exec` sees under the same name, and the reverse**.
- `PodmanSandbox` is the one `zen run` uses: a container binding host
  directories, with `fs = localFs`, and `files()` returns the host paths as
  they are. `podmanSandbox` is its factory. A second constructor argument,
  `{ engine, exec }`, drives another binary or a fake runner.
- A sandbox that keeps its files with the container (a sandbox service)
  serves `fs` itself, and its `files()` returns `inSandboxPaths(opts, fs)`:
  the workspace at `/workspace`, each tree where the container has it
  (`logicalMounts()` merges the skill folders into one `/skills`).

Another implementation proves itself with the suites in
`@zenera/sandbox/testing`: `describeFsDriver` for a filesystem driver and
`describeSandbox` for the invariant, the same ones podman passes.

`FsDriver` stays its own seam because the file tools need no running sandbox:
`fileTools({ ..., fs })` works on `localFs` or `InMemoryFs` on their own.
`sandboxTools(sandbox)` builds the shell tools on one sandbox.

The sandbox also owns its **image**: the spec names an `image` to pull or a
`build` to build, and `prepare()` gets it there - `podman build` here, the
service's own builders there. `buildIdentity()` is what every backend agrees a
build is: the context's files and their hash, which is the tag.

Which sandbox a run gets, in order:

1. `openEngine({ newSandbox })` - a host's own `SandboxFactory`.
2. A plugin whose `sandbox()` answers with a `SandboxProvider` - passed in
   `plugins`, or named by `ZEN_PLUGINS`, which is how `zen run` in a terminal
   reaches a sandbox service. Two answers is an error.
3. Podman on this machine.

`zen run --podman` skips step 2, and `zen check` smoke-tests whichever sandbox
a run would get. `ZEN_PLUGINS` and `ZEN_SANDBOX_*` come from the machine's
environment only: a project's `.env` cannot set them, and `sandbox.env` cannot
forward them into a sandbox.

## Embeddings

`embeddings:` and `embedding:` declare vectorisers against the same
`providers:` and the same memoized clients as models.

```ts
const embedder = project.embedder(); // the project's `embedding:`
const named = project.embedder('wide'); // an entry in `embeddings:`

const { vectors } = await embedder!.embed({
    input: ['the text to place'],
    taskType: 'query', // or 'document' - it describes the text, not the model
});
```

Both return `undefined` when the project declares nothing. Only `embedding:`
resolves at load; a named one resolves the first time it is asked for, so
declaring an entry whose credential is missing costs nothing until it is used.

Vectors come back **normalised to unit length** unless the request says
`normalize: false`. That is a guarantee of the `Embedder` contract rather than
of any one vendor: truncating to `dimensions` is a raw Matryoshka slice that
only some models rescale, and cosine similarity divides the magnitude out, so a
caller comparing by dot product would get quietly worse results and never an
error.

No agent consumes an embedder on its own. This is a seam for the host - a
retriever, a memory store, an index - which is why there is no per-agent key.

## Entry point

The agent a conversation starts on is chosen in this order:

1. Top-level `default: <name>`
2. An agent with `default: true`
3. The first agent declared

Prefer the first. Without it, file order is load-bearing.

## Validation

Beyond schema shape, the loader cross-references the config against what was
actually loaded:

- `models.<alias>.provider` names a declared provider or built-in kind. Provider
  _names_ are checkable without credentials, so a typo in an entry no agent uses
  is still caught - unlike the key it would need.
- `agents[].tools` names a tool passed in `ProjectOptions.tools`.
- `agents[].handoffs` names a real, different agent (self-hand-off is an error).
- `agents[].skills.provider` names a loaded provider.
- `agents[].skills.allow` / `.preload` name skills in that catalog.
- A `preload:` entry must also be in `allow:`, when `allow:` is given -
  otherwise the runner would activate it and then hide it from the index.

All of these are thrown, so the load stops at the first. To see every problem
at once, from a folder rather than from a host, run `zen check` - it walks the
same ground without stopping, and also reports what is not an error but is
probably not what was meant.
