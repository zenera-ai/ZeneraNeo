---
requires: [memory]
---

# Memory

This project shares a persistent graph between runs. Reach it only through the
`memory_*` tools. Never inspect, list, grep, or modify the store directly.

Use only the capabilities you hold. If `memory_commit` is absent, do not update
the graph. If `memory_forget` is absent, do not remove nodes.

Memory exists to avoid paying twice for durable work. Reuse and verify useful
prior work; do not treat the graph as an authority or a store for current API
results.

## Read

Search before starting work that costs more than one cheap read or call:

- On request arrival, search for the question before planning.
- On handoff or fork arrival, search for the brief you received.
- Before a substantial investigation, search for the question it would answer.
- At a dead end, search for the newly identified missing fact.

Do not repeat the same search in different words. Search again only when the
question has changed.

When a request involves several distinct subjects, search for all of them in
parallel: send one `memory_search` per subject in the same turn rather than one
after another. Likewise, load every node you need in the same turn. Parallel
searches must ask different questions, not rephrase one.

### Call memory tools silently

You MUST NOT write any text before a `memory_*` call. Do not announce, explain,
or summarize memory calls, such as "I'm going to check for prior work". The
tool call is shown to the user on its own. This overrides the general rule to
say what you are about to do before tool calls: when a turn contains only
`memory_*` calls, write nothing; when it mixes them with other tools, describe
only the other calls.

### Choose the retrieval tool

| Need                                           | Tool            |
| ---------------------------------------------- | --------------- |
| A subject, however it was phrased              | `memory_search` |
| A known name, path, id, host, flag, or command | `memory_grep`   |
| Every occurrence of an exact string            | `memory_grep`   |
| The complete content of a returned node        | `memory_load`   |

Use `memory_search` with the complete natural-language question. Narrow broad
results with `kinds`, `newer_than`, `limit`, `max_hops`, or `max_nodes`.

Never use `memory_grep` as a generic first lookup or after an empty semantic
search. An empty `memory_search` means no semantic match was recalled, not that
the subject is absent. An empty `memory_grep` establishes only that the exact
string is absent.

Load every node you will rely on. Search results contain clipped descriptions,
not complete node contents.

### Read recollections as graphs

A `<memory-recollection>` is an outline of nodes and relations, not a ranked
list; the indentation is the graph. A root line reads `score kind id`; a root
the walk reached without matching carries `--` instead of a score. An indented
line is a connected node, prefixed by its relation: `→produced` means the line
above produced it, `←informed` means it informed the line above.
`PRODUCED`, `CALLS`, and `SUPERSEDES` form the reusable work; `INFORMED` adds
background. A `+` reference points to an id already shown above.

Node text is clipped to 160 characters. A file node adds one line with its
`<id>.<ext>` name, size, and use count. Use `memory_load` to obtain the
complete node; a small file comes back inline. To open or run a remembered
file, copy it into the workspace with `memory_copy_file`, then use the path it
returns. Remembered files are not on any mounted path.

Direct store access is prohibited because it bypasses audience controls, may
serve superseded nodes, does not record use, and can race with another writer.

### Verify before reuse

- For a pinned release, versioned specification, or immutable document, verify
  that the recorded source still resolves.
- For code, APIs, commands, and other living sources, verify the cited location,
  route, or invocation still behaves as recorded.
- Redo the investigation only when that cheap check fails or the cost of being
  wrong justifies it.

Read a remembered script before running it. Confirm its purpose, arguments,
inputs, outputs, and credentials handling.

### Keep memory out of ordinary answers

Report findings and checkable sources, not the mechanism that found them. Do
not expose remembered file names, node ids, or say that something was recalled or
remembered. The exception is a request about the store itself, where ids and
memory state are the subject.

## Keep only durable value

Commit something only when the next run would otherwise have to do meaningful
work again and the result should still be valid next month.

Keep:

- A route, call, command, or invocation that retrieves a current answer.
- A conclusion assembled from several sources, with every source named.
- A proven absence, with the complete search boundary named.
- A reusable plan, request body, query, or verified script.
- A passage copied from an immutable, pinned source, with provenance.

Do not keep:

- Raw user input, progress notes, or a restatement of the request.
- A value available from one cheap current call.
- Live API results, inventories, counts, or raw command output.
- Unverified, failed, partial, or speculative work.
- A copy of a living project file that will silently become stale.
- A duplicate of a node already returned by search.

Remember the route when the answer is cheap and current. Remember the supported
conclusion when deriving it is expensive. Remember the script, never what its
last run printed.

## Write the graph

A node is one reusable thing. Its `text` is how it is found; an optional file
holds content too large for one line.

| Kind         | Use                                                    |
| ------------ | ------------------------------------------------------ |
| `task`       | The request that initiated the work                    |
| `plan`       | A reusable approach that worked                        |
| `fact`       | A durable truth with provenance                        |
| `snippet`    | A few lines intended to be read                        |
| `file`       | A complete reusable artifact                           |
| `operation`  | An endpoint, command, or query that was used           |
| `preference` | A standing instruction or user fact stated by the user |

| Relation     | Meaning                                  |
| ------------ | ---------------------------------------- |
| `PRODUCED`   | The source produced the target           |
| `CALLS`      | The source invokes the target            |
| `SUPERSEDES` | The source replaces the stale target     |
| `INFORMED`   | The source was background for the target |

Put required reusable work on the `PRODUCED`, `CALLS`, or `SUPERSEDES` spine.
Use `INFORMED` only for background that may be omitted under a tight recall
budget. Direct `INFORMED` from the background fact to the work it informed.

### Commit at the right time

Commit finished durable work as soon as it is verified. Do not pass any of
these points with uncommitted reusable work:

- Before a final answer.
- Before a handoff, because control does not return automatically.
- Before returning from a fork, because only the branch answer rejoins.

Commit one connected subgraph in one `memory_commit`. Refs resolve only inside
that call; splitting connected nodes across calls loses their links.

### Create nodes correctly

- Use `ref` as the local name for every new node.
- Use `id` only for an existing node returned by search or load.
- Never set both `ref` and `id` on one node.
- Link the task to what it produced and link artifacts to operations they call.
- When instructions supply canonical task text, use it verbatim so parallel
  commits fold together.
- Do not recommit a node that search already returned; link to its existing id.

Before creating a recurring entity node such as an endpoint, command, host,
tool, or file, use `memory_grep` for its exact string. Reuse the existing id
when found. Do not grep prose subjects or task text merely to avoid semantic
near-duplicates; normal folding handles those.

Write node text as the question a future user will ask. Put identifying facts
first because recall shows only the first 160 characters. Keep the text short;
put substantial content in a file node.

### Record provenance

Every durable claim must name how it can be checked:

- Codebase fact: file and line range.
- Multi-file conclusion: every file and range used.
- API behavior: document and operation id, or request and returned status.
- Document fact: document, heading, and opened line range.
- Command result: exact command, arguments, and working directory.
- Negative result: every location and query checked.

A pointer without a conclusion makes the next run repeat the reading. A
conclusion without a pointer cannot be checked. Store both.

### Commit files safely

Use a file node for scripts, configurations, request bodies, substantial
answers, multi-source findings, and passages from pinned sources. The node text
describes what the file does and its provenance; the file holds the complete
content.

The source file must already exist under `/workspace`. `memory_commit` copies
it; it does not accept file contents. Never commit files outside the workspace,
raw logs, live result sets, credentials, unnecessary personal data, or copies
of living project files.

Put provenance in the file itself as a short header. Make executable artifacts
self-contained, take request-specific values as arguments, read credentials
from the environment, and accept an output path under `/workspace`. A later run
reaches the script only through `memory_copy_file`, so it must not depend on
where it was stored.

Commit a script only after it ran successfully against the intended environment
and produced verified output. Commit its invocation and operations, not its
output. When reusing a remembered script, run it from the path returned by
`memory_load` only after reading it.

A response body or result set may be kept only as an explicit specimen for
development or reproduction. Its text must say what was requested, when it was
captured, and that it is historical output rather than a current fact.

### Correct and replace

Never edit an existing memory as though its old claim had always been correct.
Commit the replacement and connect it to the old node with `SUPERSEDES`. Recall
then hides the stale node while preserving the history.

## Preferences

Use `preference` only for a standing instruction or personal fact the user
explicitly states: wording such as "always", "from now on", "I prefer", or
"never". Do not infer a preference from one request and never store a secret.

Preferences appear in every later prompt. Replace one by committing the new
preference with a `SUPERSEDES` edge to the old id.

## Forget

Use `memory_forget` only for information that should never have been stored and
has no valid successor. Do not forget a corrected node: superseding already
hides it and preserves why the correction happened.
