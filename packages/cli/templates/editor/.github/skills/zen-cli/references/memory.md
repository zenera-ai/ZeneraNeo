# Memory - `zen memory`

```
zen memory [stats|ls|search|grep|show|export|merge|forget|migrate] [args] [options]
```

Alias: `mem`.

The memory graph from outside the agents. It exists to answer the question
memory always eventually raises: **why did it recall that?**

Only projects that enable memory have one, and the commands say so rather than
inventing an empty graph. Turning it on is the `memory:` block in `agents.yaml`.

This document is the command. For how the graph is organised, how to configure
it, and how to decide what an agent should remember, read the `zen-memory`
skill.

## Subcommands

| Command                   | What it does                                        |
| ------------------------- | --------------------------------------------------- |
| `zen memory stats`        | Size, vocabulary, whether it is embedded            |
| `zen memory ls`           | Nodes, newest first: kind, audience, revision, text |
| `zen memory search <q>`   | Recall it, the way an agent does. Ranked            |
| `zen memory grep <pat>`   | Every node containing it, with the lines            |
| `zen memory show <id>`    | One node in full, with what it links to             |
| `zen memory diff <base>`  | What this memory holds that `<base>` did not        |
| `zen memory export [f]`   | The whole graph as one HTML page                    |
| `zen memory merge <dir…>` | Fold other memories into this one                   |
| `zen memory forget <id…>` | Remove nodes, their vectors and their files         |
| `zen memory migrate`      | Convert a version 1 memory (`graph.json`) once      |

`ls` cuts the text to the terminal's width; piped, or run by an agent, it prints
all of it. Never query `memory.db` directly - `ls --json` is the same nodes in a
shape that does not change under you.

| Flag                          | Meaning                                        |
| ----------------------------- | ---------------------------------------------- |
| `--project <name\|dir>`       | Which project. Inferred from the directory     |
| `--dir <dir>`                 | Read this memory directory instead             |
| `--kind <name>`               | Only this kind of node                         |
| `--audience <name>`           | Only this label; for `search`, recall as it    |
| `--files`                     | Only nodes that remember a file                |
| `--stale`                     | Only nodes something has superseded            |
| `--all`                       | Superseded nodes too, marked. `search`, `grep` |
| `--regex`                     | Read the `grep` pattern as a regex, per line   |
| `--case-sensitive`            | Match case exactly. Off by default             |
| `--in <text\|metadata\|file>` | Where `grep` looks. Repeatable. All by default |
| `--ids-only`                  | Print bare ids, for piping into `show`         |
| `--limit <n>`                 | Rows to list, or seeds to rank. 30, search 10  |
| `--hops <n>`                  | How far `search` follows links. Default 2      |
| `--nodes <n>`                 | Cap on the subgraph `search` returns. 25       |
| `--min-score <n>`             | Drop seeds scoring below this. Default 0.15    |
| `--embedding <ref>`           | Rank `search` with this model, not the project |
| `--out <file>`                | Where `export` writes. Default `memory.html`   |
| `--open`                      | Open the exported page                         |
| `--dry-run`                   | Say what `merge` would do, and stop            |
| `--no-dedupe`                 | Keep memories `merge` would otherwise fold     |
| `--force`                     | Let `merge` pick a winner where copies differ  |
| `--yes`                       | Do not ask before removing or merging          |

## `search` is recall, run from here

The same ranker, the same walk, the same renderer the runtime uses. What it
prints is the block a model would have been handed - scores, kinds, ids, and the
edges the walk followed:

```sh
zen memory search 'how do we deploy'               what an agent would recall
zen memory search 'deploy' --audience reviewer     recall as that agent sees it
zen memory search 'deploy' --hops 0                the seeds, nothing stitched
zen memory search 'deploy' --all                   superseded nodes too
```

It embeds the query with the project's own model, so the order is the order an
agent gets. When it cannot - no key, no vectors in the store - it falls back to
term overlap and **says so**; that ranking is not the one a run sees, and a
block that looked like recall without being it would send you chasing a
difference that is only in the tool.

`--audience <label>` is the useful one. It recalls as an agent that sees only
that label, which is how _why did it **not** recall that?_ gets an answer: a
memory that is present but masked looks exactly like a memory that was never
written, and `ls` cannot tell you which it is.

It is the one subcommand that contacts a model. Everything else is offline.

## `grep` answers what recall cannot

Recall ranks, and a ranking returns the top of a list. It can say what is
closest; it can never say that nothing is there. `grep` reads every node
exactly - the text, the metadata, and the bytes of every remembered file - and
reports the lines it matched on:

```sh
zen memory grep 'staging.example.com'        everywhere that host is mentioned
zen memory grep 'API_KEY' --in file          only inside remembered files
zen memory grep '^def ' --regex --kind file  matched per line, as grep does
zen memory grep pandas --ids-only | xargs -n1 zen memory show
```

The count it prints is the true one even when `--limit` cut the list, and a
remembered file it could not read - too big, binary, missing - is named rather
than silently skipped, because a file that went unsearched must not pass for one
with no match.

## `diff` says what a run did to a copy

A run started from a copy of a memory leaves the whole copy behind, so `ls` on
it shows everything the base held too. `diff` shows only what changed:

```sh
zen memory diff <candidate> --dir <batch-dir>/<id>/memory
```

- **added** - each with the nearest node `<base>` held and its score. One
  `merge` would fold onto it is marked a twin: the run said again what the
  memory already held.
- **revised** - same id, new revision.
- **used** - nodes `memory_load` returned, and how often: what the run read.
- **removed**, and new `SUPERSEDES` edges.

It reads one consistent snapshot of each side, so it works on a memory a run is
writing.

Superseded nodes are left out unless you ask: `--all` includes them marked, and
`--stale` narrows to them alone.

Every subcommand reads one consistent snapshot, so all of them work while a run
is writing the memory - and the run keeps writing while they do.

## A graph that is not the project's

`--dir` opens a memory directory as it stands, and skips project resolution
entirely: there need be no `agents.yaml` anywhere above it. That is what to use
for a graph a run was pointed at with `zen run --memory <dir>`, and for the one
a running session is writing to - no copy needed.

```
zen run --memory .tmp/mem "…"     remember into .tmp/mem for this run
zen memory --dir .tmp/mem stats   then read that graph, from anywhere
```

## It reads unmasked, on purpose

Memory is masked per agent: a node's `audience` decides who can see it. Recall
is masked, ranked and truncated as well, so what an agent gets is never the
whole picture.

This command ignores all of that. When the mask is the thing that is wrong, the
part that was hidden is exactly the part you need - and this is a person at a
terminal in the project directory, not an agent inside a run.

It also contacts no model. The store is opened without an embedder, so
inspection is free and works offline; the price is that `ls` filters by text
rather than by meaning.

## `export` is the one to reach for

```sh
zen memory export --open
```

One self-contained HTML file, three panes:

- **left** - every node, with a search box and filters for kind, audience,
  files, superseded and unlinked
- **middle** - the graph as a Mermaid diagram, coloured by kind, with pan,
  zoom, and a hop-focus selector for following one node's neighbourhood
- **right** - whatever you clicked, in full: the text, the metadata, the links,
  and **the remembered file's actual content** - rendered as an image when it is
  one, and as text otherwise

Clicking a node in either the list or the diagram selects it in both. Above 300
drawn nodes the diagram asks you to narrow it with the filters, because a
Mermaid graph that large is not a picture of anything.

It is a single file with no server behind it, so it attaches to a bug report.
The only network it does is fetching Mermaid; without that it degrades to a
working list and detail view.

## Merging

Several runs may write one memory at once - each write is a transaction - but a
warmup should not share one: runs learning together see each other's commits
mid-round. They each warm their own, and `merge` puts the results back together:

```sh
zen memory merge .tmp/warmup-*/batch/*/memory            into the project’s
zen memory merge a/memory b/memory --dir merged/memory   into a named one
zen memory merge <batch-dir>/*/memory                    after `zen run batch`
```

`zen run batch` is the fan-out with the bookkeeping done for you: each item
gets its own copy of the memory, the project's is left alone, and the summary
prints the `merge` line. A batch that is only asking should say
`--memory-read-only` instead — nobody writes, so nothing changes under anyone,
and every item recalls from the one graph.

Sources are positional and the target is `--dir`, or the project you are in —
the same shape as everywhere else here. The shell expands the glob, so a
twelve-way fan-out is still one word. `merge` is the one subcommand that will
write a memory into existence: a target that is not there yet is created.

It is offline and contacts no model, which is why every side has to have been
embedded with the same model already. Node ids are kept, so the interesting
case is the same id on both sides:

- **Same revision, same content** — a shared ancestor, because the runs started
  from a copy of the same memory. Use counts and timestamps reconcile to the
  larger of the two, never the sum, so merging a source twice changes nothing.
- **Anything else** — a divergence. The whole merge is refused, nothing is
  written, and every conflicting id is listed with both revisions. `--force`
  takes the highest revision instead.

Memories that are not the same node but say the same thing fold together on the
same rule a commit uses for duplicates — near-identical by cosine, same kind,
same audience, never one that remembers a file. `--no-dedupe` turns that off.
Edges follow whatever their ends folded onto, and an edge whose ends both
landed on the same memory is dropped.

`--dry-run` reports all of it and writes nothing.

## Forgetting

```sh
zen memory forget 01M1YPN0C8QRQS5BCZ03ABQ1G0
```

Asks first, unless `--yes`, and refuses outright when there is no terminal to
ask at. A node, its vector row and its remembered file bytes go together -
there is one implementation of that, shared with the agent-facing tool, so the
three cannot drift apart.

**Forgetting is rarely the right correction.** The agents' own way to fix a
wrong memory is to commit the corrected node and supersede the old one, which
keeps the record of having been wrong. `zen memory ls --stale` lists what has
been superseded that way. Use `forget` for what should never have been stored -
a secret, a mistake, a pile of noise - not for what merely became untrue.

## Reading `stats`

```
nodes       7
edges       6
superseded  1
files       1 · 640 B
embedding   none - recall falls back to term overlap
vectors     -
```

`embedding none` is worth noticing: without an embedder, recall matches on
shared terms rather than on meaning, which works but is much blunter. Set
`memory.embedding` in `agents.yaml` to change it.

A vector count lower than the node count means some nodes were committed while
no embedder was configured, and they will only ever be found by term overlap
until they are re-embedded.
