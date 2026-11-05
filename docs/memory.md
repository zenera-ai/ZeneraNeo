# Giving agents memory

Memory is what an agent keeps when the session ends. Without it every run starts
from nothing: the same investigation is done twice, the script that worked last
week is written again, and a correction the user made on Tuesday is gone by
Thursday.

It is a **graph**, not a list. A node is one thing worth keeping - a task, a
plan, a fact, a snippet, a file, an API call, a preference - and an edge says
how one led to another. Recall returns the connected piece, so an agent that
finds the right answer also gets the reasoning that produced it and the script
that ran it.

It lives with the project, not the session. A memory that died with the session
would be a cache.

## Memory is not a corpus

The distinction is worth being firm about, because the two get confused and the
wrong one is expensive.

| Use                                                     | For                                                                                                                         |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Memory**                                              | What the agents learned by working: what was tried, what it cost, what the answer turned out to be, what the user asked for |
| **A document index** ([knowledge.md](knowledge.md))     | Prose that already exists and does not change per run                                                                       |
| **A schema index** ([integrations.md](integrations.md)) | An API description                                                                                                          |
| **`assets/`**                                           | Anything an agent should read the same way every time                                                                       |
| **`agents/*instructions.md`**                           | What is always true, for everybody                                                                                          |

If a fact is in a manual, index the manual. Memory is for what is not written
down anywhere yet.

## Turning it on

```yaml
memory:
    dir: memory
    embedding: main

agents:
    - name: auditor
      memory: true
```

That is the whole feature. The agent can search, load and commit, and it recalls
automatically before answering new user input. The block is optional - an agent
saying `memory: true` gets the defaults without one, and a project that mentions
memory nowhere opens no store and creates no directory.

`zen init` writes both halves, so a scaffolded project remembers from its first
run: the block, `memory: true` on the default agent, and
`agents/memory-instructions.md` - the house rules that tell an agent how to use
the store, copied from the `zen-memory` skill the same command installs. That
file is the whole of what a model is told about memory; the runtime adds the
preference block and nothing else, so `zen check` fails a project that switches
memory on without it. The file is ours rather than the project's - it describes
the runtime, not your agents - so `zen check --fix` writes the current text
back, over a copy that is missing, emptied or left behind by an upgrade. Project
policy about memory goes beside it, in a topic file of your own.

**Give it an embedding.** Without one, recall falls back to term overlap, which
finds a memory phrased the way the query was and misses the rest. The width is
learned from the first response, and changing the model afterwards is refused
rather than silently mixing two vector spaces. `zen init` picks one from the
same provider as the model, and leaves it out for a provider that publishes no
embeddings API - Anthropic - rather than writing an entry that would fail to
load.

The store is a directory in the project (`memory/` by default): one SQLite
database, `memory.db`, holding the graph and its vectors, and `files/` beside it
for what agents remembered byte for byte. Any number of runs may use one memory
at once - each write is a transaction, so they never lose each other's work, and
a run killed mid-write leaves the last commit intact. The database is worth
committing if the team shares one; `zen init` git-ignores only the write-ahead
log beside it, which is folded back in when the last run closes. A memory
written by an older version (`graph.json`) is converted once with
`zen memory migrate`.

`zen run --memory <dir>` points one run at a different directory - a scratch
graph for a trial, one graph per branch, or a shared one kept outside the
repository. It answers for a project that declares no memory at all, because
naming a directory is the declaration; which agents remember is still `memory:
true` in `agents.yaml`, and a run whose agents have no binding says so rather
than writing nothing quietly.

## What gets remembered

Kinds are `task`, `plan`, `fact`, `snippet`, `file`, `operation`, `preference`;
relations are `PRODUCED`, `INFORMED`, `CALLS`, `SUPERSEDES`. Both are closed
sets offered to the model as enums, which is what keeps a graph built by a
language model queryable a month later. Widen them only if the domain genuinely
does not fit - a wider vocabulary is a vaguer one.

Two kinds do something the others do not.

**Files.** An agent that writes a working script can keep it. The file is copied
into the memory directory under a generated id. It is never mounted into the
sandbox; a later run copies it back into its workspace and runs the copy:

```
memory_copy_file  { "id": "01JD9Q7X8N2K4M6P8R0T2V4W6Y" }   → /workspace/01JD9Q7X8N2K4M6P8R0T2V4W6Y.py
run_command       python3 01JD9Q7X8N2K4M6P8R0T2V4W6Y.py
```

`memory_copy_file` needs only read access to memory, takes an optional `to`
inside the workspace, and refuses to replace an existing file unless given
`overwrite`. Keeping the files out of the sandbox means a sandbox holds nothing
that changes while it runs, and the files stay with the graph that explains
them.

The graph holds the provenance around it - what asked for it, what plan it came
from, what it called - and that subgraph is what comes back on recall.

**Preferences.** A memory of kind `preference` is a standing instruction from
the user: "always report findings as a table", "use ISO dates". These are not
recalled by similarity, because they are not _about_ the request in front of the
agent - an instruction on how to report sits nowhere near a question about
gateway rules in embedding space, and a search would never surface it. So they
are listed rather than ranked, and rendered into the system prompt with their
ids, in the cached prefix, costing once per run rather than once per turn.

**Correction is a new node, not an edit.** A memory that turns out to be wrong
is superseded by one that is right, joined by a `SUPERSEDES` edge, and recall
follows the edge forward. The old node stays, because the reason a thing changed
is often the useful part.

## Who sees what

```yaml
agents:
    - name: auditor
      memory:
          access: read-write
          sees: [audit]
          writes: [audit]
          autoRecall: { limit: 3 }
```

`access` decides the tools and nothing else does: `read` gets `memory_search`,
`memory_grep`, `memory_load` and `memory_copy_file`, `read-write` adds
`memory_commit`, `full` adds `memory_forget`. These six are never named in `tools:` - the binding is what
grants them.

**One memory, masked - not one memory each.** Every node carries an audience,
and `sees` is the set an agent reads. `*` is the public slice and is always
included, so a binding can only widen what an agent sees, never hide the common
ground. `writes` is the other half: an agent that reads a private slice need not
be able to add to it.

**Auto-recall is on by default**, because an agent that has to remember to go
looking mostly does not. It costs one embedding call on turns that follow new
user input, and nothing on the rest. `autoRecall: false` keeps the tools and
leaves the agent to decide when to search.

## Looking at it

Recall is masked, ranked and truncated by design, so what an agent sees is never
the whole picture - and when the picture is what is wrong, you need the part
that was hidden. `zen memory` reads the graph **unmasked**, locally:

```sh
zen memory stats            # size, vocabulary, whether it is embedded
zen memory ls --files       # nodes, newest first
zen memory search <query>   # recall it, the way an agent does. ranked
zen memory grep <pattern>   # every node containing it, with the matching lines
zen memory show <id>        # one node in full, with what it links to
zen memory export --open    # the whole graph as one self-contained HTML page
zen memory merge <dir...>   # fold other memories into this one
zen memory forget <id...>   # remove nodes, their vectors and their files
```

`export` is the one to reach for: node list on the left, graph in the middle,
whatever you clicked on the right, file contents and all.

`search` is recall itself, run from a terminal. It embeds the query with the
project's own model and prints the block a model would have been handed, scores
and all - so _why did it recall that?_ has a direct answer. `--audience <label>`
recalls as an agent that sees only that label, which is how the harder question
gets one too: a memory that is present but masked, or superseded, or merely
ranked sixth looks exactly like a memory that was never written, and only the
ranking can tell you which. It is the one subcommand that contacts a model; when
it cannot, it falls back to term overlap and says so.

`grep` is the counterpart to recall rather than a variant of it. Recall ranks,
and a ranking returns the top of a list, so it can say what is closest but never
that nothing is there. `grep` reads every node exactly - the text, the metadata
and the bytes of remembered files - reports the lines it matched on, and reports
the true total even when `--limit` cut the list. Every subcommand reads one
consistent snapshot, so all of them work on a memory a run is writing. Agents
get the same thing as `memory_grep`.

`--dir <dir>` reads a memory directory as it stands, with no project around it:
the graph a run was given with `zen run --memory`, or the one a running session
is writing to.

`forget` is for what should never have been written down - it removes the node,
its vector and its file bytes together. A memory that is merely out of date
should be superseded instead.

## Merging several memories

Runs can share one memory, but a warmup usually should not: N runs learning
from one graph at once each see what the others committed mid-round, so no run
is an independent sample. Warming in parallel therefore means N runs writing N
memories, and `merge` is how they come back together:

```sh
zen memory merge .tmp/warmup-20260923/memory-*
```

`zen run batch` is that fan-out made into a command. It gives every item a copy
of the memory under its own directory, never touches the project's, and prints
the `merge` line when it is done:

```sh
zen run batch --input cases.json --batch-dir .tmp/cases
zen memory merge .tmp/cases/*/memory
```

Leaving `--batch-dir` out picks `<project>/batches/<stamp>` instead, and prints
it on stdout - which is the other way to write the pair:

```sh
dir=$(zen run batch --input cases.json)
zen memory merge "$dir"/*/memory
```

When the batch is asking questions rather than learning, `--memory-read-only`
is the other half of the same fact: nobody writes, so nothing changes under
anyone, and all sixteen runs recall from the one graph. It works on a single `zen run`
too — it is how you ask what the agents know without changing what they know.

Sources are positional, the target is the project you are in or whatever
`--dir` names, and a target that does not exist yet is created. It is offline -
no model, no re-embedding - so every side must already share an embedder.

Node ids survive a merge, which makes the same id on both sides the ordinary
case rather than a collision: parallel runs usually start from a copy of the
same memory. When both copies are at the same revision with the same content
they are one memory, and only the use counts reconcile - to the larger of the
two, so merging the same source twice changes nothing. When they disagree the
whole merge is refused and the conflicting ids are listed, because which piece
of work was right is a question for a person; `--force` answers it with the
highest revision. `--dry-run` reports what would happen and writes nothing.

## Say it in the specification

Memory changes what the system is, so it belongs in `SPECIFICATION.md`: that
agents remember between sessions, what kind of thing is worth keeping, who may
read whose, and what must never be written down. The scaffolded specification
lists memory under **Out of scope** for exactly this reason - moving it out of
that list is the change, and `/spec-sync-project` does the wiring. See
[specification.md](specification.md).

## Further

- [agents-yaml.md](agents-yaml.md#memory) - the full `memory:` and
  `agents[].memory` reference
- Your editor has a `zen-memory` skill installed by `zen init`, with the
  commit-worthiness rules and the recall shapes.
