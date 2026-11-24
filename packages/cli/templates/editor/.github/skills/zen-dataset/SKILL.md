---
name: zen-dataset
description: Keep a project's evaluation dataset in `dataset/` with `zen meta dataset` - every case read from its sources with a class, a complexity, tags, a verbatim rubric and an anchor to the section it came from. Covers extracting a training set of any shape into a proposal, applying it as a revision, finding which cases their sources moved under (drift) and re-reading only those sections, settling gone and uncovered sections, overriding a field by hand, leaving notes and verdicts on a case, reading a case's history and the sessions that touched it, and drawing samples by criteria (class, complexity, tag, rubric, revision, verdict, note kind, source, text) stratified, weighted and seeded. Load before building or refreshing a dataset, before running /dataset, before choosing which cases to run, and before writing a note or verdict on a case.
user-invocable: false
---

# The dataset

A dataset is the project's set of real queries, each with what it should be
judged by. It lives in `dataset/` at the project root, it is committed, and it
outlives any one tuning. **Only `zen meta dataset` writes to it.** A hand edit
skips the history, the revision, the session stamp and the lock, and the next
drift check will not see it.

Reading a source and deciding what is a case is your work. Everything after
that - what changed, which revision, which cases restart, what to run next - is
the command's.

## What is stored

```
dataset/
    manifest.json      revision, a hash per source file, the ignored sections
    revisions.jsonl    one line per revision: added, updated, retired, restarted
    cases/<id>.json    each case as it is now
    log/<id>.jsonl     each case's history: every change, every note, who made it
```

A case:

```json
{
    "id": "planning-organize-day",
    "rev": 3,
    "status": "active",
    "class": "planning",
    "complexity": "complex",
    "tags": ["calendar", "mail"],
    "input": "organize my day",
    "rubric": [
        { "id": "r1", "text": "calls api /mail/list" },
        { "id": "r2", "text": "proposes a schedule, does not just list both" }
    ],
    "expected": "A time-ordered plan naming the two conflicting meetings.",
    "source": {
        "file": "SPECIFICATION.md",
        "anchor": { "heading": ["Examples", "Query: organize my day"] }
    }
}
```

- **`rev`** is the dataset revision that last changed the case. A run that
  records `{id, rev}` can always be read back against the rubric it ran under:
  `zen meta dataset show <id>@<rev>`.
- **Rubric ids** stay with their line. An unchanged line keeps its `r<n>`; a
  new line gets a new one; a note that says `r2 failed` keeps meaning the same
  line.
- **Nothing is deleted.** A removed case is `retired`: out of every sample,
  still readable, its id never reused.

## Extracting cases

Read the source yourself and write the structure out; do not write a parser.
Large sources are read in parts, and the count is checked against the source at
the end.

| In the source                                                    | In the case                                                          |
| ---------------------------------------------------------------- | -------------------------------------------------------------------- |
| A heading like `## Query:` and a quoted string                   | One case, `input` is the string                                      |
| A bullet list under `### Rubric:`                                | `rubric` - **verbatim**, one entry per bullet                        |
| An embedded image, a `![](...)` link, an audio or PDF attachment | A media part in `input`, path relative to the proposal file          |
| A paragraph of context before the query                          | `notes`, not `input` - unless the agent is meant to see it           |
| The expected answer                                              | `expected`, one string; it is context for grading, not a diff target |
| Nothing but a query                                              | A case with no `rubric`                                              |

- **The rubric is the source's words.** A paraphrased rubric grades the
  paraphrase. A wrong rubric is fixed in the source and re-read; when the
  source is not yours to edit, `update --rubric-edit ... --override` and say why.
- **Class** is a distinction the source already makes - a section, an agent,
  an API, a task type. Do not invent a taxonomy.
- **Complexity** rates the trajectory the query demands, not the sentence:

| Level     | What it means                                                               |
| --------- | --------------------------------------------------------------------------- |
| `simple`  | One tool call or none; one agent; the answer is a lookup or a restatement   |
| `medium`  | Several calls that depend on each other, or one delegation, or one artefact |
| `complex` | Fan-out, multi-agent, ambiguity to resolve, or a plan that can go wrong     |

- **Tags** are free words for what cuts across classes - `mail`, `pagination`,
  `impossible`. Use the source's own words; a tag on one case is noise.
- **Ids** are letters, digits, dot, dash and underscore, `class-short-slug`,
  and **stable**: a case read again from the same section keeps its id. A new
  id for an old case restarts it and orphans its history.
- **`input` is exactly what `zen run batch` accepts**: a string, or a list of
  parts - a string, `{ "text": "…" }`, or `{ "image" | "audio" | "video" | "file": "<path or url>" }`.

### Anchors

Every case read from a file names the section it came from, so the command can
find that section again with no model involved:

| Source                 | Anchor                                   | The section                                       |
| ---------------------- | ---------------------------------------- | ------------------------------------------------- |
| Markdown               | `{ "heading": "Examples > Query: one" }` | from the heading to the next one at its level     |
| JSON or YAML           | `{ "pointer": "/cases/3" }`              | that value; key order and formatting do not count |
| Anything else, or none | no `anchor`                              | the whole file                                    |

A heading path needs only its last name while that is unique in the file; add
a parent to tell two apart. Headings inside code fences are not headings. An
anchor that does not resolve to exactly one section is refused at apply.

### The proposal

Write the cases to a scratch file - `.tmp/dataset/proposal.json` - as
`{ "cases": [ … ] }`. Media paths in it resolve against that file. Then:

```sh
zen meta dataset apply .tmp/dataset/proposal.json --dry-run
zen meta dataset apply .tmp/dataset/proposal.json --why "first extraction of SPECIFICATION.md"
```

A whole proposal **retires every active case it does not name**. A refresh of
a few sections is `--partial`: only the cases it names are touched. Read the
dry run before writing - an unexpected `retired` or an id you did not mean to
change is caught there and nowhere else.

The old `finetune/dataset.json` (`cases` or `samples`) applies as it stands.

## When the sources move

```sh
zen meta dataset drift
```

A source file whose hash is unchanged is not opened. In a file that moved, each
case's own section is compared, so a typo three sections away restarts nothing.

| State       | Means                                                 | Do                                                                    |
| ----------- | ----------------------------------------------------- | --------------------------------------------------------------------- |
| `changed`   | the case's section text differs                       | re-read that section; put the case in a `--partial` proposal          |
| `gone`      | its anchor no longer finds exactly one section        | `retire` it, or `reanchor` it if the section was only renamed         |
| `uncovered` | a section at the cases' level that no case comes from | new cases in the proposal, or `ignore <file> --heading "…" --why "…"` |
| `unsettled` | a file never recorded, because a section is uncovered | settle its uncovered sections                                         |

Re-reading a `changed` section and proposing the same case is fine: if what it
asks, expects and is judged by did not change, nothing is revised - only its
stored hash moves.

**What restarts a case.** A change to `input`, `rubric` or `expected` - the
question or how it is judged - lists the case under `restarted` in that
revision; results from its earlier revision are about a different question. A
change to `class`, `complexity`, `tags`, `notes` or `source` revises the case
without restarting it. Such a case keeps `questionRev`, the revision that last set its
question, and a tuning keeps its results against that revision.

## By hand

```sh
zen meta dataset update <id> --set class=search --set complexity=medium --why "…"
zen meta dataset update <id> --rubric-edit r2="proposes a schedule" --override --why "…"
zen meta dataset update <id> --rubric-add "says when it is impossible" --rubric-drop r3 --why "…"
zen meta dataset update <id> --tag-add impossible --why "…"
zen meta dataset retire <id>... --why "…"        # restore <id>... to undo
zen meta dataset reanchor <id> --heading "Examples > Query: plan" --why "section renamed"
```

`--set <field>=` with nothing after the `=` clears that field. `--override` keeps the
change through every later re-extraction; without it the next apply of that
section writes the source's version back.

## Notes, verdicts, history

```sh
zen meta dataset note <id>... -m "…" [--kind graded|analyze|difficult|rubric-suspect|observation] \
    [--run <run>] [--verdict right|wrong|void] [--rubric r1=pass,r2=fail]
zen meta dataset log [id...]
```

A note is about the case's **current** revision and is recorded with it; after
the case is revised, the note stays in its history but stops counting. A note
with a verdict defaults to `graded`. Leave a `rubric-suspect` note when a case
fails for a reason the rubric cannot be right about - the dataset prompt lists
them until someone fixes the source.

Every change and note records who made it: the `zen meta` session, the prompt
it ran (`/dataset`, `/analyze`, …) and the host. `log` prints
`resume: zen meta resume <project> <session>` for every session this machine
still holds.

## Drawing a sample

```sh
zen meta dataset sample [filters] [-n <count>] [--seed <n>] [--by <fields>] \
    [--weight <stratum>=<w>] [--order <keys>] [--format ids|batch|cases|json] [-o <file>]
```

**Filters** - all must hold; a repeated flag means any of its values:

| Flag                                     | Keeps                                                       |
| ---------------------------------------- | ----------------------------------------------------------- |
| `--class`, `--complexity`, `--tag`       | those values (`unclassified`, `unrated` for none)           |
| `--status active\|retired\|all`          | default `active`                                            |
| `--rubric yes\|no`, `--expected yes\|no` | cases with or without one                                   |
| `--id <glob>`, `--exclude <glob>`        | ids matching, ids not matching                              |
| `--ids-from <file>`                      | ids listed - plain, or json with `ids`, `batch`, `cases`    |
| `--changed-since <rev>`                  | revised after that revision                                 |
| `--restarted`                            | restarted by the latest revision (or the `--at` one)        |
| `--at <rev>`                             | the dataset as it stood then                                |
| `--verdict right\|wrong\|void`           | the latest verdict on the current revision                  |
| `--never-graded`                         | no verdict on the current revision                          |
| `--note <kind>`, `--graded-in <run>`     | has a note of that kind, or one from that run               |
| `--source <glob>`, `--anchor <glob>`     | read from that file, or that section                        |
| `--grep <text>`                          | input or rubric contains it (`--regex`, `--case-sensitive`) |

A value the dataset does not have - a misspelt class - is an error that lists
the real ones, never an empty sample.

**The draw.** Cases are grouped into strata by `--by` (default `class`; also
`complexity`, `tag`, `source`, `rubric`, `verdict`, several joined by commas,
or `none`). Inside a stratum they are ordered by `--order` (default
`rubric,complexity`: graded first, then complex, medium, simple; also
`verdict` - wrong first, `rev` - newest first, `id`), ties broken by `--seed`.
Strata take turns, `--weight alpha=2` giving one twice the turns. The whole
order is laid out before `-n` cuts it, so **a larger `-n` keeps every case a
smaller one chose**, and the same filters, seed and revision draw the same cases
on any machine.

**Output.** `ids` (default) one per line; `batch` - `{ "batch": [{ id, input }] }`
for `zen run batch`, **never a rubric**; `cases` - whole cases with rubrics, for
a grader; `json` - the ids with the criteria, seed, revision and per-stratum
counts, which is the record that reproduces the sample. Media paths are written
relative to the `-o` file. The per-stratum table goes to stderr.

```sh
# a cross-section of 12 graded cases
zen meta dataset sample --rubric yes -n 12 --format batch -o runs/r1/cases.json
# everything the latest revision restarted
zen meta dataset sample --restarted --by none --format batch -o runs/r2/cases.json
# what is still wrong, worst classes first
zen meta dataset sample --verdict wrong --order complexity --weight search=2
# the whole dataset, rubrics included, for another machine
zen meta dataset export -o dataset.json
```

`export [id...]` is the same filters with no strata, in id order, as `cases`
by default.

## Rules

- Only `zen meta dataset` writes `dataset/`.
- Every write says `--why`, in terms of the source: what changed in it, or why
  it is being overridden.
- Rubrics leave the dataset only through `--format cases` or `export`. Never
  put one in a batch input, a prompt, a skill or the workspace an agent reads.
- Moving a rubric to match what an agent did is not a fix; it deletes the test.
