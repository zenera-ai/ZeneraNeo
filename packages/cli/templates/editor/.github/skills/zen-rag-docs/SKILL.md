---
name: zen-rag-docs
description: What a document index is, how to build one from a folder of `.md` files with `zen rag docs index` (or `npx @zenera/cli`), and how to ask it something - searching by meaning and narrowing to a release, a heading or a table, listing and grepping it exactly instead of reaching for shell `grep`/`rg`, reading a section back verbatim, giving it to an agent as tools, and writing the project skill that a wired-in index requires. For an OpenAPI description instead of prose, see `zen-rag-schema`.
user-invocable: false
---

# The document index

A document index is a pile of markdown turned into something that can be
**asked a question**. It is built once, on disk, and answered from - and what
comes back is not a summary but the documents themselves: the passages that
matched, quoted verbatim, with their line numbers.

It exists because a documentation tree does not fit in a context window and
grepping it does not help. The paragraph that answers "how are rate limits
counted?" does not contain the word "counted", sits four headings deep, and the
number you actually need is in a table two screens further down. Forty `grep`
hits for `limit` are not an answer; the eight lines around one of them are.

## The commands

```
zen rag docs <index|restore|ready|search|list|grep|show|stats> [path...]
```

| Command   | Answers                                    | Embedder? | Typical          |
| --------- | ------------------------------------------ | --------- | ---------------- |
| `index`   | builds the thing                           | yes       | minutes to hours |
| `restore` | _put the vectors back_                     | **yes**   | minutes to hours |
| `ready`   | _can this index answer at all?_            | no        | instant          |
| `search`  | _where does this corpus talk about X?_     | **yes**   | seconds          |
| `list`    | _what documents/headings/tables are here?_ | no        | instant          |
| `grep`    | _does the string X appear anywhere?_       | no        | instant          |
| `show`    | _print this section, verbatim_             | no        | instant          |
| `stats`   | _what is in this index?_                   | no        | instant          |

Only `search` ranks, and only `search` costs a network round trip - it embeds
the query before it can compare anything. The other four read `outline.json`
and the copies in `sources/` off the disk and answer in milliseconds. Reach for
`search` when the question is vague and for `list`/`grep`/`show` when it is
precise. If a search feels slow, it is that one embedding call, not the index:
near-zero CPU for several seconds is the tell.

> **Never reach for shell `grep`, `rg`, `find`, `cat` or `head` here.**
> Not on the source tree, not on anything under the index directory.
> `zen rag docs grep` and `zen rag docs list` are the exact-matching commands,
> they are local, they need no credential, and they answer in milliseconds.
> Shell tools on the same files are strictly worse: they match raw lines, so
> they cannot say which heading a hit sits under, cannot narrow to one release
> of a tree by name, cannot tell a table row from the prose around it, and
> cannot report how many matches there were past the ones they printed.
> `rg -n 'Retry-After' docs/` gives you paths and offsets; `zen rag docs grep
"Retry-After"` gives you the line, the document, and the section it belongs
> to, counted in full.

## What is in one

Three things, and the third is the point.

| Piece          | Is                                                        |
| -------------- | --------------------------------------------------------- |
| `outline.json` | every heading and every table, with the lines they cover  |
| `sources/`     | the documents themselves, verbatim, exactly as indexed    |
| `lance/`       | one row per chunk: two texts, one vector, and the filters |

```
docs-db/
├── README.md       what this index holds - a live progress report while it builds
├── manifest.json   written LAST - its absence means "not indexed"
├── outline.json    headings and tables, read whole
├── sources/        the documents, verbatim - where every quoted line comes from
└── lance/          the chunks
```

`sources/` is not a convenience. A search returns **line ranges**, and the lines
are read back out of those copies, so what you are shown is the document and not
a reconstruction of it. That is also what makes an index one portable thing:
nothing in it names a path outside itself, so it can be committed, shipped, or
mounted somewhere else in an agent's sandbox and still answer. (A schema index
has `--no-sources`; a document index does not, because there the copies _are_
the answer.)

`manifest.json` records **which embedder made the vectors**, so a search with a
different model is refused rather than answered with noise.

### What survives a clone

`lance/` is binary, large, and rebuildable, so a project commits the index and
git-ignores the vectors. What a fresh checkout holds is therefore an index that
**looks built and cannot answer**: the manifest is there, `sources/` is there,
and the first search fails deep in the store with `holds no searchable table`.

Two commands close that gap, and neither needs the original documents:

```sh
zen rag docs ready --dir assets/docs-db      # exit 0 searchable, exit 3 not
zen rag docs restore --dir assets/docs-db    # re-embed from sources/
```

`ready` answers with its **exit code**, so a setup step branches on it without
parsing anything; `--json` gives the same answer as `{ ready, state, embedding }`
for a caller that wants the detail. `restore` reads the documents back out of
`sources/`, re-embeds them with the model the manifest names, and renames the
result into place - so a failed restore leaves the old index untouched, at the
cost of room for both while it runs.

> **Never test for a built index with `[ -f .../manifest.json ]`.** The manifest
> is committed and the vectors are not, so that test is true on exactly the
> machine where it is wrong. `zen rag docs ready` is the test.

`restore` is also how an index **changes embedder**: `--embedding <ref>`
re-embeds everything and rewrites the manifest, so later searches ask for the
new model. Same corpus, same names, same chunk ids - only the vectors are new.

### How a document is cut up

Chunking follows the markdown rather than a character count: a paragraph, a
list, a fenced code block, the frontmatter. Every chunk knows the heading it
sits under, which is what makes `--section` a filter and not a hope.

Tables are indexed **twice over** - once as a descriptor carrying the caption
and the column names, and once per row, with the header row travelling
alongside so the columns are still named wherever a row lands. A row too wide
to be one chunk is cut into column groups with the key column repeated. That is
why `--kind table_row` is a useful thing to ask for: a limits table is a
hundred facts, not one paragraph.

Every chunk gets a `kind`: `paragraph`, `list`, `table`, `table_row`, `code`,
`frontmatter`, `html`.

## Installing

`zen rag` ships in `@zenera/rag`, a sibling of the CLI. It has no binary of its
own - installing it adds the `rag` subcommand to `zen`, which is also where the
credentials already live.

```sh
npm i -g @zenera/cli @zenera/rag       # then: zen rag docs …
```

For a one-off, without installing anything, **both** packages must be in the
same temporary install or `zen` will report `rag` as not installed:

```sh
npx --package @zenera/cli --package @zenera/rag -- zen rag docs index ./docs --embedding openai/text-embedding-3-small
```

Every example below is spelled `zen …`; prefix it with that `npx` form if you
have not installed globally.

## Building an index from `.md` files

```
zen rag docs index <path...> [--embedding <ref>] [-o <dir>] [--batch <n>] [--chunk-tokens <n>]
```

```sh
zen rag docs index ./docs --embedding openai/text-embedding-3-small
```

That is the whole thing: point it at a directory and it walks it.

### What gets read

| You name        | What happens                                                      |
| --------------- | ----------------------------------------------------------------- |
| a **file**      | that file                                                         |
| a **directory** | walked, recursively                                               |
| a **glob**      | anchored at the deepest directory it names outright, then matched |

`.md`, `.markdown`, `.txt` and `.text` are read; `.txt` and `.text` are treated
as prose with no headings. Anything else is not a document and is not indexed.
Hidden directories and `node_modules` are skipped - a file nobody can see is
not one anybody meant to index. A file over 16 MB is skipped as a data dump and
said so on stderr, next to the per-document table.

Several paths can go into one index, and usually should: one index over a whole
documentation tree is what makes "which release says this?" answerable at all.

```sh
zen rag docs index ./docs ./README.md ./packages/*/README.md --embedding openai/text-embedding-3-small
zen rag docs index "releases/acme_4.*/**/*.md" --embedding google/gemini-embedding-001 -o .index/acme
```

### The name is the identity

Every document is given a **name**: its path relative to the common root of
everything you named. Nothing anywhere records where the file was on the machine
that built the index.

That name is what `--file` patterns match, so it is worth arranging on purpose.
Indexing two release trees at once keeps `acme_4.1.0/api/routing.md` and
`acme_4.2.0/api/routing.md` apart, and a search can be pinned to one of them.
Indexing one tree from inside it gives you `api/routing.md`. Two files that
would land on the same name are deduped rather than merged.

### The flags

| Flag                 | Default     | Meaning                                                      |
| -------------------- | ----------- | ------------------------------------------------------------ |
| `--embedding <ref>`  | -           | Which embedder makes the vectors. Omit it to see the choices |
| `-o`, `--out <dir>`  | `./docs-db` | Where the index goes; `$ZEN_DOCS_DB` if that is set          |
| `--batch <n>`        | model's own | Texts per embedding request. `gemini-embedding-*` takes 1    |
| `--chunk-tokens <n>` | `384`       | Target chunk size. Leave it alone unless you have a reason   |
| `--quiet`            | -           | No narration                                                 |

The embedding reference names a provider first - `openai/text-embedding-3-small`,
not a bare model id. Credentials come from the `zen` keyring (`zen key ls`), and
a real environment variable always wins.

### What it prints

A per-document table (lines, sections, tables, chunks) with a total row, a line
per skipped file with the reason, then a progress line every few seconds:
`embedded 22416/242175 · 9% · 8m50s · ~1h26m left`. **That estimate is how
long the build takes, not a sign that it is stuck.** Time is chunks divided by
throughput, and a `gemini-embedding-*` model takes one text per request, so a
corpus of a few hundred thousand chunks is hours. **stdout is the output
directory and nothing else**, so `DIR=$(zen rag docs index …)` works; everything
else is stderr.

This is the one command here that spends money and time: it embeds every chunk.
While it runs, the output directory narrates itself - `README.md` is a live
progress report, rewritten at most every five seconds, replaced on completion by
a description of what the index turned out to hold, and left saying so if the
build dies. A `.lock` names the process, so a second build of the same directory
is refused unless the lock is stale.

Rebuild the index when the documents change. Nothing watches them, and a stale
index is a confident wrong answer - worse here than anywhere, because the quoted
lines will look exactly as authoritative as they did when they were true.

## Which index gets read

Every reading command takes `-d`, `--dir`. Without one:

1. `$ZEN_DOCS_DB`, if it is set. **Set this once** instead of typing `-d` on
   every command - `export ZEN_DOCS_DB=/assets/docs-db`.
2. Otherwise the **nearest index** to the working directory: here, then a short
   way down into it, then up a level and again, stopping at your home
   directory. The one chosen is named on stderr as it is used, so an answer is
   never anonymous.
3. Otherwise `./docs-db`, which is only so the error names the directory you
   were expecting.

What is looked for is a `manifest.json`, and the search is **scoped by kind** -
a `docs` index and a `schema` index can sit in the same tree without either
shadowing the other, and nothing searches for a directory literally called
`docs-db`. That is just the name a new one is given.

Two document indexes the same distance away is refused rather than guessed at:
the wrong index does not fail, it answers confidently about another corpus.
Name one with `-d`, or set `ZEN_DOCS_DB`.

## Searching it

```
zen rag docs search [text...] [narrowings…] [shape…]
```

```sh
zen rag docs search "how are rate limits counted"
```

The answer is the corpus quoting itself:

```
## acme_4.2.0/api/routing.md - 9 of 148 lines

  5 | ## Rate limits
  7 | Requests are counted per tenant and rejected past the limit.
... 12 lines omitted (Retries, Backoff) ...
 24 | | route | limit | window |
 25 | | --- | --- | --- |
 27 | | /api/users | 250 | 1m |
```

Every line carries its number, and the gaps say what was left out. That is
deliberate: a passage you cannot point at is a passage you cannot do anything
with. The numbers are what `show` and `read_docs` take.

### Narrowing is the interface

Nobody finds the paragraph they want on the first ask. They search, see it is
the wrong release, and search again inside one. So the second call is the same
question with a narrowing on it - not a different command.

| Flag                     | Narrows to                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------ |
| `-f`, `--file <p>`       | documents whose **name** matches. Repeatable                                         |
| `--exclude-file <p>`     | everything but those. Repeatable                                                     |
| `-s`, `--section <name>` | one heading and whatever nests inside it. Repeatable                                 |
| `--kind <k>`             | `paragraph`, `list`, `table`, `table_row`, `code`, `frontmatter`, `html`. Repeatable |
| `--mode <m>`             | `hybrid` (default), `vector`, `text`                                                 |
| `--exclude-id <id>`      | a passage already seen. Repeatable                                                   |

```sh
zen rag docs search --file "acme_4.2.*/api/**" "rate limit for the users route"
zen rag docs search --section "Rate limits" --kind table "requests per minute"
zen rag docs search --mode text "X-RateLimit-Remaining"
```

A `--file` pattern with `*` or `?` is a glob matched against the whole document
name; a plain word is a substring. So `--file routing` finds
`acme_4.2.0/api/routing.md` and `--file "routing*"` finds nothing.

`--section` takes a heading title, a structure id, or the structure path an
earlier answer printed. A title that appears in four documents becomes four
scopes, not a guess at one.

**`--mode text` is the one to remember.** `hybrid` blends meaning and wording,
which is right for a question; when what you have is an exact string - an error
message, a header name, a flag - `text` is exact wording only, and meaning can
only dilute it.

The narrowings are resolved against the manifest and the outline **before** the
store is touched, so a `--file` pattern that matches nothing says so instead of
quietly searching everything.

### One wording per leg

`hybrid` asks two retrievers the same sentence, and they read it differently:
the full-text leg wants the words the documents use, the vector leg wants the
question stated in full. When you know both - the exact header name _and_ what
you actually want to know about it - say each one:

```sh
zen rag docs search --text-query "Retry-After" \
  --vector-query "how long to wait before trying the request again"
```

Both legs run and the results fuse as usual. Either flag alone runs that leg
alone, so `--text-query` by itself is `--mode text` with its own wording.

They **replace** the positional text rather than narrowing it, and they settle
the mode by existing. `search "x" --text-query "y"` and `--text-query "y"
--mode vector` are both refused, because each says two things at once.

### Shaping the answer

| Flag                 | Default | Meaning                                   |
| -------------------- | ------- | ----------------------------------------- |
| `-d`, `--dir <dir>`  | found   | Which index - see "Which index gets read" |
| `--embedding <ref>`  | index's | Must be the one the index was built with  |
| `--limit <n>`        | `8`     | Passages kept                             |
| `-B`, `--before <n>` | `0`     | Extra lines quoted before each passage    |
| `-A`, `--after <n>`  | `0`     | Extra lines quoted after each passage     |
| `--max-lines <n>`    | `400`   | A ceiling on the whole answer             |
| `--no-numbers`       | -       | Quote the lines without their numbers     |
| `--hits`             | -       | One row per passage instead of the text   |
| `--interactive`      | -       | Prompt, search, narrow. Needs a terminal  |
| `--quiet`            | -       | No narration                              |

`--hits` is the fast triage: it prints where the passages are without spending
the lines on them, and you follow up with `show`.

### As a machine interface

Non-interactive search is a tool, not an afterthought. `--json` is a stable
shape - `{matches, files, scope, mode, considered, truncated}` - no terminal is
needed, and **an empty result exits 0**: a caller must never have to tell
"nothing matched" from "the index is missing" by parsing stderr.

Everything about the invocation is validated before an embedder is constructed,
so a typo is a usage error and not a credential error.

### `--interactive`

A prompt that keeps the query between searches, and excludes what it has
already shown you so asking again moves on:

```
<text>            search
file <pattern>    only documents matching it; blank for all
not <pattern>     drop documents matching it
section <name>    only under this heading, by title, id or path
kind <k>          paragraph | list | table | table_row | code | frontmatter | html
mode <m>          hybrid | vector | text
limit <n>         passages per search
files             the documents currently in scope
show              the query as it stands
reset             forget it, narrowings and exclusions alike
quit
```

## Reading it without searching

None of these need an embedder or a credential - they are plain reads of the
outline and the copies on disk.

```
zen rag docs list <files|sections|tables> [-d <dir>] [filters…]
zen rag docs grep <pattern> [-d <dir>] [filters…]
zen rag docs show <file> [--section <name>] [--lines <from-to>]
zen rag docs show <target>... [--max-lines <n>]
zen rag docs stats
```

| Flag                     | For    | Meaning                                        |
| ------------------------ | ------ | ---------------------------------------------- |
| `-f`, `--file <p>`       | both   | Only these documents. Repeatable               |
| `--exclude-file <p>`     | both   | Drop these documents. Repeatable               |
| `-s`, `--section <name>` | both   | Only under this heading. Repeatable            |
| `--depth <n>`            | `list` | `sections` only: deepest heading level to show |
| `--regex`                | both   | Read the patterns as regular expressions       |
| `--case-sensitive`       | both   | Stop ignoring case                             |
| `--limit <n>`            | both   | Print at most n; `found` still counts them all |
| `--json`                 | both   | `{found, rows, truncated}`                     |
| `--quiet`                | both   | No narration                                   |

```sh
zen rag docs list files                       # every document, and what it holds
zen rag docs list sections --file "api/**"    # every heading, with its line span
zen rag docs list sections --depth 2          # just the shape of the tree
zen rag docs list tables                      # every table, with its columns
zen rag docs grep "Retry-After"               # every matching line, and its section
zen rag docs grep "X-RateLimit-\w+" --regex --file "api/**"
zen rag docs show api/routing.md --section "Rate limits"
zen rag docs show api/routing.md --lines 40-80
zen rag docs show "api/routing.md:24-31" "api/errors.md#Retries"   # several, one call
zen rag docs stats
```

`list files` reports the name, title, format, and how many lines, sections,
tables and chunks each document holds - which is also the fastest way to learn
the names your `--file` patterns will be matched against. `list sections` is a
table of contents with line spans; `list tables` names every table's caption,
columns and row count, which is how you find the limits table without reading
the prose around it.

`grep` reports `found` as the **true total** even when `--limit` cuts the rows,
so unlike a search it can answer whether a string appears at all. Every hit
carries the innermost heading it sits under, so a match has a place. Nothing
matching exits 0 with empty stdout - and that emptiness is trustworthy, which is
the whole point of it.

`show` prints a document, a named section, or a line range, verbatim, with a
line-number gutter (`--no-numbers` to drop it). It is the natural follow-up to
every search: find the passage, then read what is actually around it.

**Read every passage you will cite in one `show`.** It takes any number of
targets written the way a citation is - `<document>:<a>-<b>`, `<document>:<a>`,
`<document>#<heading>`, or a bare name - and prints each under a header that is
itself a target, in the order given. Overlapping ranges print once; a missing
document or heading is reported in place while the rest still print. The
`--max-lines` budget (default 400) is shared fairly, and a cut block ends with
the target that continues it. One call per passage costs a whole turn each.

`stats` says what is in an index and what built it - the documents, the counts,
the embedding model. It is the fastest way to answer "is this index the one I
think it is?".

### Which one to reach for

| The question                                      | The command                                     |
| ------------------------------------------------- | ----------------------------------------------- |
| "how does this thing handle retries?"             | `search "how are retries handled"`              |
| _anything you would have run `grep` for_          | `grep` / `list` - never the shell               |
| "does `X-Request-Id` appear anywhere?"            | `grep X-Request-Id`                             |
| "what does the rate-limits section actually say?" | `show <file> --section "Rate limits"`           |
| "read the four passages the search turned up"     | `show <doc>:<a>-<b> <doc>:<a>-<b> ...` - once   |
| "which documents are even in here?"               | `list files`                                    |
| "what is the shape of this manual?"               | `list sections --depth 2`                       |
| "where is the table of per-route limits?"         | `list tables --file "api/**"`                   |
| "the exact error string, not something like it"   | `search --mode text "connection reset by peer"` |
| "same question, but only the 4.2 docs"            | `search --file "acme_4.2*/**" "…"`              |
| "is this index the right one?"                    | `stats`                                         |

The rule: **a question about meaning is a `search`; a question about presence,
spelling or a count is a `list` or a `grep`; a question about what a passage
actually says is a `show`.** Search cannot answer the middle one, because a
ranking always returns its best guesses whether or not any of them are right.

### Instead of the shell

Add `-d <dir>` when the index is not the nearest one, or name it once with
`ZEN_DOCS_DB`.

| The reflex                          | The command                                           |
| ----------------------------------- | ----------------------------------------------------- |
| `grep -rn "Retry-After" docs/`      | `zen rag docs grep "Retry-After"`                     |
| `rg -i retry --glob 'api/**'`       | `zen rag docs grep retry --file "api/**"`             |
| `grep -E "X-RateLimit-\w+"`         | `zen rag docs grep "X-RateLimit-\w+" --regex`         |
| `grep -c` / `wc -l`                 | `--json`, and read `found` - it counts past `--limit` |
| `find docs -name '*.md'`            | `zen rag docs list files`                             |
| `grep '^#' file.md`                 | `zen rag docs list sections --file file.md`           |
| `sed -n '40,80p' file.md`           | `zen rag docs show file.md --lines 40-80`             |
| `cat file.md` (to find one section) | `zen rag docs show file.md --section "Rate limits"`   |
| a `sed`/`show` per passage          | `zen rag docs show a.md:40-80 b.md:12-30`             |
| `ls` the index directory            | `zen rag docs stats`                                  |

```sh
export ZEN_DOCS_DB=/assets/docs-db   # once, then never again
zen rag docs grep "Retry-After" --limit 10
zen rag docs list sections --file "api/**" --depth 3
```

If none of these fits the question, the question is about meaning, and the
answer is `search` - still not the shell.

## Giving it to an agent

The same engine, as four tools in the group `docs`. An agent takes them all
with `docs:*` in its `tools:`.

```ts
import { createEmbedder, loadProject } from '@zenera/neo';
import { docs } from '@zenera/rag';

const index = await docs.DocsIndex.open(
    './docs-db',
    createEmbedder('openai/text-embedding-3-small'),
);
const project = await loadProject('./my-project', { tools: docs.docsTools(index) });
```

| Tool          | For                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------ |
| `search_docs` | the passages that match, quoted with their line numbers                                    |
| `list_docs`   | the documents, their headings, or their tables - no search                                 |
| `grep_docs`   | every matching line, counted in full - no search                                           |
| `read_docs`   | a section or a line range, verbatim and with nothing omitted; several at once with `reads` |

Only `search_docs` ranks; the other three are exact, because a model told "no
results" by a vector search has learned nothing - a ranking returns the top of a
list, so an empty answer and an absent thing look identical. `grep_docs` is how
"it is not written down anywhere" can actually be concluded.

`search_docs` is shaped for the **second** call rather than the first. The first
is always a sentence and always returns some of the wrong tree; the second is
the same sentence with `files: ["acme_4.2*/api/**"]`, or `section: "Rate limits"`,
or `kind: ["table"]`. Those are parameters and not separate tools, so narrowing
costs one call instead of three. `exclude_ids` takes the ids from an earlier
answer, so asking again moves on instead of repeating itself.

`text_query` and `vector_query` are the tool's version of the two flags above:
send one to run that leg alone, or both to word each half of a hybrid search.
They replace `query`, so sending it as well is refused.

Every answer carries line numbers and `read_docs` takes them. That is the loop
the whole subject exists for: **find the passage, read around it, then edit the
file the passage came from.**

Tell the agent in its prompt to call `list_docs` once before its first search -
the document names are what every `files` pattern is matched against, and a
model guessing at them narrows to nothing and concludes the corpus is empty.

## Wiring it into a project means writing the project a skill

**Whenever an index is used by a Zenera project - as `docs:*` tools, or as
`zen rag` reachable from the agent's sandbox - write a skill for it in that
project.** Not optional, and not the same thing as passing the tools in.

Wiring alone leaves the model to infer everything that matters. A tool
description says what `grep_docs` does; it cannot say that this index holds the
ACME 4.1 and 4.2 manuals side by side, that every answer must be pinned to a
release with `files`, that the API reference lives under `*/api/**` and the
task guides under `*/guides/**`, or that the numbers anybody actually wants are
in tables and so `kind: ["table_row"]` is the right first move. That is project
knowledge, and project knowledge belongs in a skill - where it is loaded only
when the model is working on this corpus, instead of sitting in the system
prompt of every run.

```
<project>/agents/skills/<corpus>-docs/SKILL.md
```

Frontmatter is `name` and `description`; the description is what the model reads
when choosing, so it must name the corpus and the questions it answers. Add
`tools: [search_docs, list_docs, grep_docs, read_docs]` if the skill should be
what unlocks them.

### What the skill has to say

| Section            | Because                                                                             |
| ------------------ | ----------------------------------------------------------------------------------- |
| Which corpus       | What it is, which version(s), and when it was indexed                               |
| Where the index    | `ZEN_DOCS_DB`, or the `-d` to pass - an agent cannot guess a path                   |
| The document names | The shape `--file`/`files` patterns match, with two real examples                   |
| Which command      | Meaning → `search`; presence or a count → `grep`; what it says → `show`/`read_docs` |
| Never the shell    | State it outright. `grep`/`rg`/`cat` on the tree is the default reflex              |
| How to narrow      | Which `files` prefixes matter here, and when the answer is a table                  |
| Worked examples    | Two or three, with **real document names and headings from this index**             |
| Citing             | Answer with the document name and line numbers, because the tools give them         |

Best practice, in order of how often it is got wrong:

1. **Use real names.** `list_docs` output the model will actually see beats a
   generic `<file>` placeholder, because the names are the anchors it steers by.
2. **Say which command answers which question**, and say that a ranking cannot
   prove absence. Left alone a model searches for everything, gets eight ranked
   guesses, and answers from the best of them.
3. **Name the narrowing that matters here.** Two releases in one index is the
   common case, and an unpinned search silently mixes them.
4. **Keep it short.** A skill is prompt. One screen of routing rules beats a
   transcription of this document - link to `zen rag docs --help` for the flags.
5. **Re-index, then re-read the skill.** Both go stale against the same change,
   and a skill quoting headings that no longer exist is worse than none.
6. **One skill per corpus**, named after it. Two corpora in one skill and the
   model mixes their conventions.

```md
---
name: acme-docs
description: How to find an answer in the ACME 4.1 and 4.2 manuals - which document says it,
    what it says verbatim, and which release it is true of. Use before answering anything
    about ACME behaviour, limits or API routes.
---

# The ACME manuals

Indexed at `/assets/docs-db` (already in `$ZEN_DOCS_DB`). Two releases side by
side; document names begin `acme_4.1.0/` or `acme_4.2.0/`, then `api/` for the
reference and `guides/` for the task documentation.

- Always pin the release: `files: ["acme_4.2.0/**"]`. An unpinned search mixes them.
- Vague question ("how does edge failover work?") → `search_docs`, then ask again
  with `section` or `files` once you can see which half of the tree it is in.
- Does X exist, how is it spelled, how many are there → `grep_docs`. It is
  complete; a search is not, and cannot prove absence.
- Limits and defaults are in tables → add `kind: ["table_row"]`.
- Then `read_docs` the lines around every hit before answering, all of them in
  one call with `reads`. Never answer from the excerpt alone.
- Never `grep`/`rg`/`cat` the tree - the tools above are local and exact.

Worked: per-route rate limits are the table under "Rate limits" in
`acme_4.2.0/api/routing.md` (lines 24-31); the retry envelope is described two
sections down. Cite the document name and the line numbers.
```

## When it goes wrong

| Symptom                                          | Cause                                                                                                          |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| "not installed"                                  | `@zenera/rag` is not resolvable - install it, or use the two-`--package` npx form                              |
| `nothing to index`                               | No `.md`/`.markdown`/`.txt`/`.text` under those paths, or they are all hidden                                  |
| A document you expected is missing               | Hidden directory, `node_modules`, an unlisted extension, or over 16 MB - check stderr                          |
| Refused for a different embedding                | The index records the model that built it; pass the right `--embedding`, or move it with `restore --embedding` |
| No manifest / not an index                       | A build that did not finish. `manifest.json` is written last on purpose                                        |
| `holds no searchable table`                      | A manifest with no vectors - a clone, since `lance/` is git-ignored. `restore` it                              |
| A step reported `skipped` but nothing can search | The step tested for `manifest.json` instead of asking `ready`                                                  |
| A build is refused                               | `.lock` - another build is running. It is taken over when the process is gone                                  |
| `provider "openai": no api key`                  | `zen key ls` - the keyring, or a real environment variable                                                     |
| A usage error before any credential is asked for | Deliberate: everything about the invocation is checked first, so a typo is a typo                              |
| `no document matched --file`                     | The pattern is matched against the document **name**; `list files` prints them                                 |
| Nothing matched                                  | Exit 0 with an empty answer. Try fewer words, or `--mode text` for an exact string                             |
| Answers quoting text that is no longer there     | Nothing watches the documents. Re-index after they change                                                      |
| A search took ten seconds, using no CPU          | One embedding round trip, not the index. `list`/`grep`/`show` make none                                        |
