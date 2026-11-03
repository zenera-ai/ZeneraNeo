---
name: zen-memory
description: Agent memory in Zenera projects - the `memory:` block and per-agent `access`/`sees`/`writes`/`autoRecall`, the five `memory_*` tools (when to use `memory_grep` instead of `memory_search`), kinds, relations and how recall ranks, inspecting a graph with `zen memory`, designing a memory strategy, `agents/memory-instructions.md` vs `agents/memory-policy-instructions.md`, remembering files under `/memory`, and putting memory in front of a `zen rag` index.
user-invocable: false
---

# Memory

Memory is what an agent knows that nobody wrote down for it. A skill is
authored, reviewed and versioned; a memory is **produced by a run** and read by
the runs that follow. Both are knowledge, and they are not interchangeable -
anything authoritative belongs in a skill, where a human owns it.

It is a **graph**, not a list of rows. A node is one thing worth keeping - a
request, a plan, a fact, a script, a call that was made - and an edge says how
one led to another. That shape is the point: a script an agent wrote is useless
without the request that asked for it and the endpoint it calls, and a store
that can only return a ranked list leaves the joining to the model, every time.

It lives with the **project**, not the session. A memory that died with the
session would be a cache.

## Turning it on

Two keys, and the second one is what actually enables anything.

```yaml
memory: # where the graph lives, and what vectorises it
    dir: memory
    embedding: main

agents:
    - name: auditor
      memory: true # this agent gets the tools and auto-recall
```

That is the whole feature working the obvious way: the agent can search, load
and commit, and it recalls automatically before answering new user input.

The top-level block is optional - an agent that says `memory: true` gets the
defaults without one. A project that mentions memory nowhere opens no store and
creates no directory.

### `memory:` - the graph itself

| Field       | Type          | Default         | Meaning                             |
| ----------- | ------------- | --------------- | ----------------------------------- |
| `dir`       | path          | `memory`        | Relative to the project root        |
| `embedding` | embedding ref | the top-level   | The vectoriser recall searches with |
| `kinds`     | name[]        | the seven below | **Replaces** the node vocabulary    |
| `relations` | name[]        | the four below  | **Replaces** the edge vocabulary    |

**Set `embedding`.** Without one, recall falls back to term overlap: it finds a
memory phrased the way the query happened to be phrased and misses the rest,
which is the failure mode that makes people conclude memory does not work. The
width is learned from the first response rather than declared, and changing the
model afterwards is **refused** rather than silently mixing two vector spaces -
so choose it before the graph has anything in it.

```yaml
embeddings:
    main: openai:text-embedding-3-small
memory:
    embedding: main
```

`zen memory stats` says `embedding none - recall falls back to term overlap`
when this was skipped, and a vector count below the node count means some nodes
were committed before an embedder existed.

### `agents[].memory` - who may see and write what

```yaml
agents:
    - name: auditor
      memory:
          access: read-write
          sees: [audit]
          writes: [audit]
          autoRecall: { limit: 3 }
```

| Field        | Type                       | Default          | Meaning                                      |
| ------------ | -------------------------- | ---------------- | -------------------------------------------- |
| `access`     | `read`/`read-write`/`full` | `read-write`     | Which of the five tools this agent gets      |
| `sees`       | name[]                     | `[]`             | Private slices it may read, on top of `*`    |
| `writes`     | name[]                     | `[*]`            | Labels it may commit under                   |
| `autoRecall` | boolean or `{ limit }`     | `true`, limit 10 | Recall before a turn that follows user input |

`memory: true` is shorthand for all four defaults.

## The five tools

They are **not** listed in an agent's `tools:`. They are derived from the
binding and appear when it exists, so `access` is the only thing that decides
which of them the model is offered:

| Level        | Tools                                         |
| ------------ | --------------------------------------------- |
| `read`       | `memory_search`, `memory_grep`, `memory_load` |
| `read-write` | the above, plus `memory_commit`               |
| `full`       | the above, plus `memory_forget`               |

| Tool            | Does                                                                       |
| --------------- | -------------------------------------------------------------------------- |
| `memory_search` | Ranks, then stitches. Returns an outline of a subgraph and a legend of ids |
| `memory_grep`   | Exact and complete. Every node containing a string, with the lines         |
| `memory_load`   | Reads whole nodes by id. **The only call that counts as use**              |
| `memory_commit` | Writes a subgraph - nodes and the edges between them - in one transaction  |
| `memory_forget` | Removes nodes, their vectors and their file bytes together                 |

Search and load are split on purpose. Search hands back context the model never
asked for; counting that as use would poison recency ranking. Commit is one
call because a remembered thing is a subgraph, and building it with three calls
leaves the graph half-formed when the model stops early.

Grep is separate from search because exactness is not a tuning of nearness. A
ranking returns the top of a list, so "nothing came back" and "nothing is there"
are the same result - and the second is what you need when the question is
whether a host, a flag or a command was already written down. Grep reads the
text, the metadata and the bytes of remembered files, applies the mask, leaves
out superseded nodes unless asked, and names any file it could not read. It is
also what an agent is supposed to reach for instead of running a shell `grep`
over `/memory`, which the house rules forbid.

It is not a diagnostic instrument, though - it is ordinary retrieval, and an
agent is expected to reach for it mid-run as readily as for search. The line
between them is what is being looked for: **a subject goes to `memory_search`,
a string goes to `memory_grep`** - a name, path, id, host, flag or command
spelled exactly, everywhere a thing is mentioned before it is changed, or
whether it was ever recorded at all. `agents/memory-instructions.md` puts that
division in front of the agent as a table, at the point where it chooses.

It takes `pattern` plus `in` (`text`, `metadata`, `file` - all three by
default), `regex`, `case_sensitive`, `kinds`, `include_superseded` and `limit`
(20 nodes). **`in: ["file"]` is the one worth knowing about**: only a node's
`text` is embedded, so the contents of a remembered script or config are
unreachable by any ranking, and grep is the only tool that reads them at all.

`agents/memory-instructions.md` already explains all of this to the agent - how
to read a recollection, when committing is worthwhile, why correction is a new
node. It is house rules under `requires: [memory]`, so it reaches exactly the
agents that have the store and no others, and it gates its own advice on the
tools the reader actually holds. The runtime adds the preference block and
nothing else. Do not restate any of it in a prompt; state project-specific
policy instead, and leave the file exactly as `zen` wrote it - `zen check`
reports any byte that differs as `rules.stale`.

## How it is organised

### The vocabulary

Seven kinds and four relations, both closed sets, offered to the model as enums.
That is what keeps a graph built by a language model still queryable a month
later.

| Kind         | Is                                                             |
| ------------ | -------------------------------------------------------------- |
| `task`       | a request that started a piece of work                         |
| `plan`       | an approach that worked, worth reusing on a similar request    |
| `fact`       | a durable truth about the environment or the domain            |
| `snippet`    | a short piece of code or configuration, too small to be a file |
| `file`       | an artifact kept whole under `/memory` and re-runnable         |
| `operation`  | an external call that was made - an endpoint, command or query |
| `preference` | a standing instruction from the user that applies to every run |

| Relation     | Reads as                                                  | Effect on recall                |
| ------------ | --------------------------------------------------------- | ------------------------------- |
| `PRODUCED`   | the source led to the target being made (task → artifact) | spine - pulled in first         |
| `CALLS`      | the source invokes the target                             | spine                           |
| `SUPERSEDES` | the source replaces the target; the target is stale       | spine, and **hides** the target |
| `INFORMED`   | the source was context the target was built from          | background - dropped first      |

Override the vocabularies only if the defaults genuinely do not fit the domain.
A wider vocabulary is a vaguer one, and a kind nothing else understands is a
kind no other agent can search for. `kinds` **replaces** the built-in set, with
one exception: `preference` is always available, because the engine itself reads
that kind to build the system prompt.

### Every node

| Field                    | Why it matters                                              |
| ------------------------ | ----------------------------------------------------------- |
| `text`                   | the only thing ranked, and the only thing embedded          |
| `kind`                   | filters a search, and decides how it renders                |
| `audience`               | who may see it. `['*']` is everyone; denied by default      |
| `createdAt`              | provenance, and what `newer_than` filters on                |
| `lastUsedAt`, `useCount` | bumped by `memory_load` alone - the input to recency        |
| `revision`               | optimistic concurrency, via `expected_revision` on a commit |
| `file`                   | the remembered bytes, if any                                |

### How recall actually works

1. **Rank.** The query is embedded and compared against node texts. Anything
   scoring below a fixed floor of `0.15` is noise and is dropped. Superseded
   nodes are excluded, and so are `preference` nodes unless asked for by kind.
2. **Order by recency, but do not admit by it.** Relevance alone clears the
   threshold; decay by `lastUsedAt` only breaks the tie afterwards. Memory that
   keeps proving useful surfaces ahead of memory written once and never read -
   without anything ageing out of reach however well it matches.
3. **Stitch.** Breadth-first from every seed at once, ignoring edge direction,
   because a memory is as often reached from the artifact back to the request as
   the other way.
4. **Spend the budget in tiers**: seeds, then the spine (`PRODUCED`, `CALLS`,
   `SUPERSEDES`), then `INFORMED` context. A tight budget therefore degrades by
   dropping background rather than by truncating the answer.

Defaults: 10 seeds, 2 hops, 25 nodes. `memory_search` takes `limit`, `max_hops`,
`max_nodes`, `kinds` and `newer_than` to move them.

What comes back is a `<memory-recollection>` block: an indented outline where
the indentation _is_ the graph, each line reading `score kind id` or
`→relation kind id`, with each node's text under it **clipped to 160
characters**. That clip is a design constraint on how you write a node - see
below.

### On disk

```
<project>/memory/
├── memory.db       SQLite: nodes, edges and vectors; every write one transaction
├── memory.db-wal   the write-ahead log while runs have it open; folded in on close
└── files/          remembered bytes, one per node that has any
```

Several runs may read and write one memory at once, and a run killed mid-write
leaves the last commit intact. It is committed with the project - everything
but `memory.db-wal`/`memory.db-shm`, which are runtime state. Only `files/` is
mounted, **read-only**, at `/memory` in the agent's namespace. A memory from an
older `zen` (`graph.json`, `vectors.f32`) is refused until converted once with
`zen memory migrate`.

## Designing a memory strategy

### The test for what to remember

**Would the next run otherwise have to work this out again?** That is the whole
question. A script that ran, an interface that behaved differently from its
documentation, a call sequence that turned out to be necessary - yes. The
request restated, progress notes, anything unverified, anything a search already
returned - no.

The second test is **would it still be true next month**. Memory has no expiry
and no reviewer. A fact about the environment survives; a fact about today's
data does not, and committing one is how a graph becomes confidently wrong.

### Write the text for the question, not for the answer

Recall ranks a node's `text` against **the user's next message**, because that
is what auto-recall embeds. So the text has to be phrased the way somebody will
ask for it, not the way the system that produced it names it.

| Instead of                        | Write                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------- |
| `POST /v2/subs/{id}:cancel - 204` | `Cancelling a subscription: POST /v2/subs/{id}:cancel, 204, no body`            |
| `fix for the 409`                 | `A duplicate customer email returns 409, not 422 - retry is wrong`              |
| `script.py`                       | `Weekly invoice reconciliation script - reads billing CSV, writes a diff table` |

Front-load the identifying facts: the first 160 characters are what appears in
a recollection, and everything after that costs a `memory_load` to see.

### The shape of a good commit

One call, several nodes, and the edges that explain them:

```
task      "reconcile invoices against the ledger for a month"
  PRODUCED → file      the script that did it
  INFORMED ← fact      "ledger exports use minor units; invoices use decimals"
file
  CALLS    → operation "GET /v2/invoices?created[gte]= - cursor paging"
```

Committed separately, a later run finds a script with no idea why it exists, or
a fact with nothing that acts on it. Committed together, one hit on any of them
brings the rest.

**Never edit a memory to correct it.** Commit the new one and link it to the old
with `SUPERSEDES`. Recall follows the edge forward and hides what it points at,
so the wrong answer stops being served without being destroyed - and the reason
a thing changed is often the useful part. `zen memory ls --stale` is the list of
corrections that have happened.

A new node whose text is a near-duplicate (cosine ≥ 0.97) of one already there
is **folded into it**, and the existing id comes back under the model's ref, so
the links still land on the memory that was already present.

### Audiences: one graph, masked - not one graph each

Every node carries an `audience`; `sees` is the set an agent reads. `*` is the
public slice and is always included, so a binding can only ever **widen** what
an agent sees, never hide the common ground. An invisible node is
indistinguishable from a missing one, deliberately, so a mask cannot be probed
by id.

Decide audiences before you decide agents. The useful question is not "which
agent wrote this" but "which agent would be misled by this":

| Situation                                         | Configuration                             |
| ------------------------------------------------- | ----------------------------------------- |
| Everything is common ground                       | `memory: true` everywhere. Do this first  |
| A specialist accumulates jargon nobody else needs | `sees: [x]`, `writes: [x]` on that agent  |
| A reviewer should read a slice but not add to it  | `sees: [x]`, `writes: []`, `access: read` |
| A summariser should never write at all            | `access: read`                            |
| One curator may delete                            | `access: full` on exactly one agent       |

When `writes` names exactly one label, the tool schema omits the field and
applies it - there is nothing to choose and nothing for the model to get wrong.
Neither `sees` nor `writes` is ever a tool parameter: an agent that could name
its own audience could read another agent's slice just by asking.

Keep `access: full` rare. Forgetting is almost never the right correction, and a
model that can delete will occasionally tidy.

### Auto-recall

On by default, because an agent that has to remember to go looking mostly does
not. It fires **after new user input and after a hand-off** - not before every
call, because recalling on every turn costs tokens and defeats prompt caching
for a marginal gain. A turn following a tool result does not re-recall.

| Setting          | For                                                                      |
| ---------------- | ------------------------------------------------------------------------ |
| `true` (default) | Almost everything                                                        |
| `{ limit: 2 }`   | A cheap model, or a graph big enough that five seeds is a page           |
| `{ limit: 8 }`   | A research agent where breadth beats prompt size                         |
| `false`          | An agent that should decide for itself when to look - it keeps the tools |

`autoRecall: false` is right for a tool-driven agent whose first turn is
mechanical, and for anything where the user's message is a payload rather than a
question.

### Preferences

A `preference` node is a standing instruction - "always report findings as a
table", "use ISO dates". These are **not recalled by similarity**, because they
are not about the request in front of the agent: an instruction on how to report
is nowhere near a question about gateway rules in embedding space, and a search
would never surface it.

So they are listed rather than ranked, and rendered into the system prompt with
their ids:

```
<memory-preferences>
- report findings as a table with a severity column [01JD9Q7X8N2K4M6P8R0T2V4W6Y]
</memory-preferences>
```

They land in the cached prefix, so they cost once per run rather than once per
turn, and the id is what lets a model replace one with `SUPERSEDES` instead of
quietly ignoring it. They are left out of ordinary recall on purpose - they are
in the prompt already.

Commit one only when the user's own words generalise: "always", "from now on",
"I prefer", "never". A single request being fulfilled is not a standing
instruction, and a graph full of false preferences is a system prompt nobody
wrote.

What the user states about themselves is the same kind of node, for the same
reason - the name to address them by, their role, their timezone, which of
several environments is theirs. Asking again next run is exactly what the block
exists to prevent. Credentials and secrets are not preferences, however they
were offered; `agents/memory-policy-instructions.md` is where a project says so
in its own terms.

## Remembering files, and running them again

The workspace is disposable - it may be a container about to be discarded - so a
reference to a path in it dangles the moment the run ends. `memory_commit` takes
a `file` argument on a node instead, and copies the **bytes** out:

```json
{
    "nodes": [
        {
            "ref": "s",
            "kind": "file",
            "text": "Invoice reconciliation script - reads the billing CSV, writes a diff table",
            "file": "reconcile.py"
        },
        { "ref": "t", "kind": "task", "text": "reconcile invoices against the ledger for March" }
    ],
    "edges": [{ "from": "t", "to": "s", "relation": "PRODUCED" }]
}
```

The path is the one the **file tools** use, resolved the same way. The copy
lands at `<project>/memory/files/<id>.<ext>` and appears to the agent as:

```
/memory/01JD9Q7X8N2K4M6P8R0T2V4W6Y.py
```

| Rule      | Value                                                            |
| --------- | ---------------------------------------------------------------- |
| Size cap  | 2 MiB. Over it, keep the artifact and commit a `snippet` instead |
| Inlined   | under 32 KiB - `memory_load` returns the contents                |
| Larger    | `memory_load` returns the path; open or run it                   |
| Mount     | `/memory`, **read-only**                                         |
| Extension | preserved, because it decides how the file runs and renders      |

### The agent has to be able to write the file first

`memory_commit` **copies** a file that already exists. It is not an upload
channel and it cannot create one. So everything too big for a node's `text` - a
script, a config, an assembled passage - depends on the agent having a tool that
puts bytes in the **workspace**, and an agent with none can only ever commit
text no matter how much the memory design leans on `file` nodes.

| The agent's `tools:`         | Can it commit a `file`?                                                 |
| ---------------------------- | ----------------------------------------------------------------------- |
| `write_file` / `apply_patch` | Yes. Write it, then name the same path                                  |
| `run_command` only           | Yes, but only under `/workspace` - a heredoc into `/tmp` is unreachable |
| Neither                      | No. Everything worth keeping has to fit on one line of `text`           |

The workspace is the only tree that round-trips, because it is the only
writable one. `/assets`, `/skills` and `/memory` resolve as well - they are
mounts the file tools know by name - but they are **read-only**, so nothing can
be put there to be remembered. Every other absolute path is real to
`run_command` and outside the workspace root, so a file written to `/tmp` comes
back as:

```
error: outside the workspace: /tmp/report.py
```

A bare error carrying none of the `hint` the other memory refusals do, because
containment is a workspace answer rather than a memory one.

This is the trap in a `tools:` list trimmed to `run_command` alone: the shell
can create the file, so `file` nodes look supported, but nothing in the agent's
context ever uses workspace vocabulary and the model has no reason to prefer
`/workspace` over `/tmp`. Either give it the file tools, or say in its prompt
that work it means to keep goes in `/workspace`.

Reusing one is the point of keeping it:

```
run_command  python3 /memory/01JD9Q7X8N2K4M6P8R0T2V4W6Y.py
```

Which means the file has to be **self-contained**. A script that reads
`../data/latest.csv` or imports from the workspace will not run next week; one
that takes its inputs as arguments will. If it needs a credential, it should
read it from the environment and say so in the node text.

Nothing writes to `/memory` through the file tools, so every file under it has a
node explaining what it is and the graph cannot acquire orphans. To change a
remembered file: copy it into the workspace, edit it there, commit the new one
and link it with `SUPERSEDES` to the old.

The node text describes and locates; the file carries the content. Reach for a
node with no file only when the whole of what you know fits on one line.

| Commit as | When                                                                        |
| --------- | --------------------------------------------------------------------------- |
| `file`    | It is content - a script, a config, a query, a passage, an assembled answer |
| `snippet` | It is a few lines that only make sense read, and nothing will ever run them |
| `fact`    | It is one line. A file containing one sentence is a fact in a costume       |

## Memory in front of a `zen rag` index

This is the highest-value thing memory does in a project that has an index, and
it is entirely a matter of **what you commit**.

### The division of labour

|                 | A schema/docs index                                             | Memory                            |
| --------------- | --------------------------------------------------------------- | --------------------------------- |
| Holds           | the API or the documents, completely                            | what earlier runs worked out      |
| Authority       | the source of truth                                             | a record, never a substitute      |
| Completeness    | exact and countable                                             | a ranked, masked slice            |
| Freshness       | as fresh as the last `index`                                    | as stale as it was allowed to get |
| Cost of a query | one embedding round trip (`search`), or nothing (`list`/`grep`) | already in the prompt             |

So: **never copy content out of an index that still changes.** A schema pasted
into a node goes stale silently and the index already answers in milliseconds; a
documentation passage quoted into a node outlives the release it was true for
and will look exactly as authoritative when it is wrong.

A **pinned** index is the exception, and a real one. Docs indexed from a
released version or a versioned reference tree cannot change under the memory,
so a passage taken out of one stays true as long as the project stays on that
version. Keep it as a `file` node whose text names the documents and line ranges
and says which version it was. That is as well as the route, never instead of
it.

What memory should hold first is the **route** - the resolution, not the source:

| Commit                                                                            | Kind               | Because                                                                           |
| --------------------------------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------- |
| The endpoint that turned out to be the answer, and its shape                      | `operation`        | A `search_api` costs a round trip and returns five ranked guesses; this names one |
| The sequence of calls that was necessary                                          | `plan`             | No ranking finds an ordering. It is not in the document                           |
| Where the answer lives in the docs - document name, heading, line range           | `fact`             | `zen rag docs show` reads it back verbatim and current                            |
| The passage itself, when the index is pinned to a released version                | `file`             | It cannot change under you, and the pointer alone makes the next run re-read it   |
| A convention the index cannot state - auth, casing, base path, the error envelope | `fact`             | It is not in the graph, and it is wrong to re-derive it every run                 |
| Where the index itself is                                                         | `fact`             | `-d` or `$ZEN_SCHEMA_DB`. An agent cannot guess a path                            |
| A working request body, or a script that drives the API                           | `snippet` / `file` | The thing you would otherwise write again                                         |
| That a search returned nothing, and `grep` confirmed absence                      | `fact`             | Proving a negative twice is pure waste                                            |

### Why it makes search cheaper

Auto-recall fires **before the model's first tool call of the turn**. So the
recollection arrives before the decision to search is made - and a recalled
`operation` node naming `POST /v2/subs/{id}:cancel` removes the search
entirely, rather than making it faster. When the recollection is only close, it
still narrows: the model reaches for `list_api --name` or `grep_api` instead of
`search_api`, which are local, exact, and cost nothing.

Phrase these nodes accordingly. The next question will arrive as _"how do I
cancel someone's subscription?"_, not as `cancelSubscription`, so the node text
must contain the human phrasing **and** the identifiers. Put the question first
and the answer second.

### Keeping it honest against re-indexing

An index is rebuilt when the source changes; memory is not. Two habits keep the
two from drifting:

1. **Name the version in the node text** - "Billing API v2", "acme\_4.1.0 docs".
   A recollection about a version the project no longer uses is then visibly
   about the wrong thing rather than invisibly wrong.
2. **Supersede after a re-index.** When a route changes, commit the new
   `operation` node with `SUPERSEDES` pointing at the old one. `zen memory ls
--kind operation` is the review list.

And state the rule in the project's own skill for the index: **verify against
the index before acting on a recalled route.** Recall is a shortcut past the
search, not past the truth. One `list_api --name` or `zen rag docs show` is
cheap and settles it.

### The project skill is where this is written down

An index used by a project needs a skill in that project describing it - see
`zen-rag-schema` and `zen-rag-docs`. The memory policy that is **about the
index** belongs in that skill, because it is the same subject and it is read at
the moment the index is. Policy that holds whatever the agent is doing -
audiences, what must never be written down - goes in
`agents/memory-policy-instructions.md` instead, which every agent with the store
gets whether it loads the skill or not.

```md
- Recalled routes are a shortcut, not authority. Confirm with `list_api --name`
  before writing a call against one.
- After solving something the index made you work for, commit it: the
  `operation` you ended on, linked to the `task` that asked and any `fact` you
  had to discover. Phrase the text as the question, not as the operation id.
- Never commit schema text or documentation passages copied out of a document
  that still changes. Commit the pointer - document, heading, line range -
  alongside what you concluded from it, and read the passage back with
  `zen rag docs show` to check the conclusion still holds.
- Our docs are indexed from the pinned 1.4 tree, so a passage out of them is
  safe to keep whole: commit it as a `file` node headed with the documents and
  line ranges, next to the pointer and the conclusion.
```

## The house rules

**Every project that enables memory carries `agents/memory-instructions.md`**,
as shipped by `zen`. That file is how the agent is told to use the store: read
and search it only through the tools, never through `/memory` itself, and what a
node must carry to still be worth having.

`zen init` writes it, because the projects it scaffolds have memory on from the
first run. `zen check` covers the two cases left over:

- `memory.uninstructed` - memory is on and the file is missing or empty.
- `rules.stale` - any byte differs from what this `zen` ships. The usual drift
  is trailing whitespace inside a table, invisible on screen.

`zen check --fix` repairs both, writing the file from the version of `zen` in
hand. Never write or patch it by hand.

Everything the project keeps under `agents/` named `<topic>-instructions.md` is
prepended to every agent, in filename order, so this belongs in its own document
rather than as another section of `agents/instructions.md` - it arrives with
memory and it leaves with it.

### Two files, and which is which

| File                                   | Is                                                                 | Owned by    |
| -------------------------------------- | ------------------------------------------------------------------ | ----------- |
| `agents/memory-instructions.md`        | the DEFAULT rules - how the store works, and how any agent uses it | `zen`       |
| `agents/memory-policy-instructions.md` | this PROJECT's customisations on top of them                       | the project |

### Keep project policy additive

`agents/memory-policy-instructions.md` is not a second memory manual and is not
the default destination for every memory finding. A rule belongs there only
when it changes how **every memory-enabled agent in this project** uses memory
and the default rules do not already say it.

| The rule is about                                                   | Owner                                                   |
| ------------------------------------------------------------------- | ------------------------------------------------------- |
| How the memory tools and graph work in every Zenera project         | the upstream default; never repeat it in project policy |
| A project-wide restriction or obligation for every memory agent     | `agents/memory-policy-instructions.md`                  |
| One agent's job, finish condition, recall timing or commit behavior | that agent's prompt                                     |
| One workflow, index, API or body of domain knowledge                | the skill that teaches that workflow or knowledge       |
| One observed case with no repeated pattern yet                      | the tuning findings, not an instruction                 |

Before adding or changing a project memory rule:

1. Write the intended obligation in one sentence without naming a file.
2. Choose its owner from the table above and name the agents that must receive
   it. If that set is smaller than every memory-enabled agent, policy is the
   wrong owner.
3. Search the default memory rules, every project policy file, the affected
   prompts and the affected skills for the obligation. Search distinctive
   verbs and nouns plus obvious alternate wording; an exact-text search alone
   does not find semantic duplicates.
4. Record one disposition: `edit existing`, `move and delete`, `delete
  contradiction`, or `add because absent`. An addition without this record is
   not ready to apply.
5. Make one source authoritative in the same change. Remove weaker copies and
   rewrite a conflicting rule as one complete rule; never preserve the old rule
   and append an exception beneath it.

The narrowest source that reliably reaches every intended agent owns the rule.
Several cases supporting one pattern do not make that pattern global; scope is
decided by who must obey it, not by how often it failed.

**Keep the first untouched.** It is predefined: it describes this version of
the runtime, not this project, and `zen check` compares it byte for byte.
Anything edited into it is lost the next time `zen check --fix` runs.

Everything a project decides for itself goes in the second - audiences, what
must never be written down, what an agent commits at the end of a job, which
index a recalled route is checked against. Filename order puts it directly
after the defaults, so it reads as the exceptions to them. Then keeping up with
a newer `zen` is `zen check --fix` again, rather than a hand-patch around prose
that has to be preserved.

**It must open with the same frontmatter**, or it is prepended to every agent in
the project, including the ones with no store to apply it to:

```md
---
requires: [memory]
---

# Memory policy

- Never commit a customer name or an account id; a `fact` says which tenant
  shape it was, never whose.
- ...
```

`requires: [memory]` is what delivers a topic file on the capability it is
about. Use `requires: [memory, memory-write]` for a rule only a committing agent
can act on.

## Inspecting and repairing it

```
zen memory [stats|ls|search|grep|show|export|merge|forget|migrate] [args] [options]
```

`zen memory export --open` is the one to reach for: one self-contained HTML
page with every node, the graph as a diagram, and the remembered file's actual
content in the detail pane. It reads **unmasked** - when the mask is what is
wrong, the hidden part is exactly the part you need - and like everything here
bar `search`, it contacts no model, so inspection is free and offline.

`zen memory search <query>` is recall itself, run from a terminal: the same
ranker, the same walk, the same block a model would have been given, scores and
all. It is the only one that embeds, and the only one that can distinguish a
memory that is missing from a memory that is merely ranked sixth.

| Question                                 | Command                               |
| ---------------------------------------- | ------------------------------------- |
| Is memory even on, and is it embedded?   | `zen memory stats`                    |
| What has this project learned?           | `zen memory export --open`            |
| Is this host/flag/path in there at all?  | `zen memory grep <pattern>`           |
| Everywhere a thing is mentioned          | `zen memory grep <pattern> --all`     |
| What would an agent recall for this?     | `zen memory search <query>`           |
| Why did it _not_ recall that?            | `zen memory search <q> --audience a`  |
| What is in one private slice?            | `zen memory ls --audience audit`      |
| What has been corrected?                 | `zen memory ls --stale`               |
| What files are being kept?               | `zen memory ls --files`               |
| One node in full, with what it links to  | `zen memory show <id>`                |
| What did a run add to its copy, or read? | `zen memory diff <base> --dir <copy>` |
| Fold parallel warmup graphs into one     | `zen memory merge <dir...>`           |
| That should never have been written down | `zen memory forget <id>`              |

Never query a memory's `memory.db` with code: every question
above has a command, and `--json` on any of them is the stable shape.

The directory is not fixed. `zen run --memory <dir>` sends one run's memory
somewhere else - a scratch graph for a trial, one per branch, or a shared one
outside the repository - and `zen memory --dir <dir>` reads any such directory
with no project around it, including one a run is writing to right now.

`zen run batch` is where parallel graphs usually come from now. Each item gets
its own copy to write into and the summary prints the `merge` line; a batch
that is only asking says `--memory-read-only` instead, and then every item
recalls from the one graph, because nothing writes and so nothing changes under
anyone.

`zen inspect` answers the other half: a run report shows the recollection block
exactly as the model received it, which is how you tell "memory had nothing"
apart from "memory had it and the model ignored it". A run given `--memory`
wants `zen inspect --memory <dir>` to rebuild its report against the same graph.

## A worked configuration

```yaml
embeddings:
    main: openai:text-embedding-3-small

memory:
    dir: memory
    embedding: main

agents:
    - name: triage # front door: reads everything, writes the common ground
      memory: true

    - name: api-worker # does the work; keeps its own routes and scripts
      memory:
          access: read-write
          sees: [api]
          writes: [api]
          autoRecall: { limit: 8 }

    - name: reporter # formats the answer; must not invent memories
      memory:
          access: read
          autoRecall: false

    - name: curator # the only thing that may delete
      memory:
          access: full
          sees: [api]
```

## Review checklist

- [ ] `zen check` reports neither `memory.uninstructed` nor `rules.stale`, so
      `agents/memory-instructions.md` is what `zen` ships byte for byte - and
      project policy lives in `agents/memory-policy-instructions.md`, opening
      with `requires: [memory]`.
- [ ] Every project memory-policy rule applies to every memory-enabled agent;
      role-specific rules are in prompts and workflow-specific rules are in
      skills.
- [ ] For every added or changed policy rule, the review records its one-sentence
      obligation, owner, semantic searches, existing locations and disposition.
- [ ] No project policy rule restates a default memory rule, and no equivalent
      or softer copy remains in another loaded prompt, skill or policy file.
- [ ] `memory.embedding` is set, and was set before the graph had content.
- [ ] Every agent that should learn has a `memory:` binding - the top-level
      block alone enables nothing.
- [ ] `access: full` appears at most once.
- [ ] Any agent the design expects to commit `file` nodes can write to the
      workspace - `write_file`/`apply_patch`, or `run_command` with `/workspace`
      named in its prompt. Nothing else round-trips.
- [ ] `sees`/`writes` exist because an agent would be **misled** by the other
      slice, not merely because it does not need it.
- [ ] `autoRecall: false` on any agent whose user message is a payload.
- [ ] Nothing authoritative is expected to live here - that is a skill's job.
- [ ] The project's index skill says to verify a recalled route.
- [ ] `zen memory search` on a question the project actually gets back returns
      what you expected, and says `ranked by meaning` rather than falling back to
      term overlap.
- [ ] `zen memory export --open` after a week of use, to see what it actually
      learned rather than what you hoped.

## When it goes wrong

| Symptom                                             | Cause                                                                                                                           |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| The `memory_*` tools are missing                    | No `memory:` on the agent. They come from the binding, never from `tools:`                                                      |
| `zen memory` says the project has none              | Neither a `memory:` block nor an agent binding - nothing is opened and no directory is made                                     |
| Recall finds a memory only when reworded            | No embedder. `zen memory stats` says `embedding none`                                                                           |
| A memory is in the graph but never comes back       | Ask `zen memory search` for it: a score under `0.15` is dropped as noise, and `--audience <label>` shows whether a mask hid it  |
| `zen memory search` says `ranked by term overlap`   | It could not build the project's embedder - no credential, or the graph holds no vectors. That order is not the one a run gets  |
| Recall finds nothing after changing the embedder    | Refused rather than mixed - the memory records the model. Change it back, or start a new memory                                 |
| Vectors fewer than nodes                            | Some nodes were committed with no embedder; they are only reachable by term overlap                                             |
| The graph fills with restated requests              | The commit rule is not in a prompt or skill. State the "would a later run redo this" test                                       |
| Runs do real work and the graph stays empty         | The agent is bound `read`, or nothing names the moments: empty recall then work, before an answer, a handoff or a fork's return |
| An agent greps `/memory` or queries `memory.db`     | The house-rules block is missing from `agents/memory-instructions.md` - the system prompt never forbids it                      |
| A recalled fact cannot be checked or continued      | Nodes were committed with no provenance. The block's "say where it came from" rule is what prevents it                          |
| Recall returns pointers and the run re-reads it all | Content was committed as `text` alone. A node's text describes and locates; the content belongs in a file                       |
| A wrong memory keeps coming back                    | It was edited instead of superseded, or superseded in the wrong direction - the **new** node is the source                      |
| An agent cannot see a node you can                  | Its `audience` is not in that agent's `sees`. Invisible and missing are the same thing, on purpose                              |
| "this agent cannot remember files"                  | The agent has no workspace, so a path cannot be resolved. Commit without `file`                                                 |
| `error: outside the workspace: /tmp/…`              | The file is real to the shell and outside the only tree memory reads. Write it under `/workspace`                               |
| Long content arrives as `text`, never as a `file`   | The agent has no tool that writes to the workspace, so it has no path to name                                                   |
| A remembered file will not run                      | It is not self-contained - it referenced the workspace it was written in                                                        |
| Recollections are large and unhelpful               | `autoRecall.limit` is too high, or node texts describe answers rather than questions                                            |
| The model recalls a route the API no longer has     | Nothing re-checks memory against a rebuilt index. Supersede, and require verification                                           |
| A second run of the same project refuses to start   | The directory lock. A lock whose process is gone is stale and is taken over                                                     |
