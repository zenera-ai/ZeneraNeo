# Giving agents knowledge

A pile of documents nobody can search is a pile of documents. `zen rag docs`
turns one into an index an agent can ask questions of - and, just as
importantly, one it can grep, list and read exactly, without a model in the way.

This is the answer when the knowledge is **prose that already exists**: product
manuals, runbooks, release notes, an internal handbook, a folder of RFCs. For an
API description see [integrations.md](integrations.md); for things the agents
learn as they go see [memory.md](memory.md).

`zen rag` ships in `@zenera/rag`, which has no binary of its own - installing it
adds the `rag` subcommand to `zen`, where the credentials already are.

```sh
npm i -g @zenera/cli @zenera/rag
```

## Build the index

```sh
zen rag docs index ./assets/docs --embedding openai/text-embedding-3-small -o assets/docs-db
```

Point it at a file, a directory or a glob. `.md`, `.markdown`, `.txt` and
`.text` are read and nothing else is. Chunking follows the markdown rather than
a character count - a paragraph, a list, a fenced block - and every chunk knows
the heading it sits under, which is what makes searching within a section a
filter rather than a hope. Tables are indexed twice over, once as a descriptor
and once per row, because a limits table is a hundred facts and not one
paragraph.

Every document is copied into the index, so it is one portable thing: nothing in
it names a path outside itself, and every quoted line comes from the document
rather than from a rebuild of it. That is what makes it safe to mount somewhere
else in a container.

| Flag             | For                                                          |
| ---------------- | ------------------------------------------------------------ |
| `--embedding`    | Which embedder makes the vectors. Omit it to see the choices |
| `-o, --out`      | Where it goes. Default `./docs-db`, or `$ZEN_DOCS_DB`        |
| `--chunk-tokens` | Target chunk size. Default 384                               |
| `--dimensions`   | Narrower vectors, if the model allows                        |
| `--no-cache`     | Parse and embed again, ignoring the shared cache             |

Embedding is cached per machine, so re-indexing a corpus that mostly did not
change costs almost nothing, and two projects indexing the same handbook pay for
it once between them.

## Where the index lives

The convention is `assets/docs-db` inside the project, because `assets/` is
mounted read-only at `/assets` in every agent's sandbox. An index the agents can
read and nothing can corrupt is exactly what reference material should be.

Nothing searches for a directory _name_: an index is self-describing, so what is
looked for is a `manifest.json` saying `"kind": "docs"`. The order is:

1. `--dir`, taken as written - naming a directory that turns out not to hold an
   index is an error, because quietly using a different one is a worse answer
2. `$ZEN_DOCS_DB`, likewise
3. the nearest document index at or above the working directory
4. `./docs-db`

Two indexes equally close is an ambiguity, and it is reported as one rather than
broken by a coin toss - the wrong index does not error, it answers confidently
about another corpus.

## Search it yourself first

```sh
zen rag docs search "how does failover work when the primary is unreachable"
zen rag docs search "rate limits" --file "acme_4.2*/api/**" --kind table_row
```

`list`, `grep` and `show` are the other half, and they are deliberately not
searches - no embedder, no credential, no ranking:

```sh
zen rag docs list files          # every document, with what it holds
zen rag docs list sections       # every heading
zen rag docs grep deprecated     # every matching line, counted in full
zen rag docs show guide.md --section "Rate limits"
zen rag docs show "guide.md:40-80" "faq.md#Limits"   # several passages, one call
```

Reach for those whenever the question is whether something is there at all. A
ranking can only hand back the top of a list, so it cannot answer "does the word
`deprecated` appear anywhere" - the honest answer is every match or none.

Run `zen rag docs --help` for the full flag list.

## Wiring it into a project

There are two ways in, and which one you get depends on how the project runs.

### From the agent's sandbox - what a `zen` project uses

The scaffolded image installs `zen` and `@zenera/rag`, and model credentials are
forwarded into the container by default, so an agent with `sandbox:*` can search
the index by running the CLI:

```
run_command  zen rag docs search "certificate rotation" -d /assets/docs-db
```

Point it at the index outright rather than relying on the search. In
`sandbox/Dockerfile`:

```dockerfile
ENV ZEN_DOCS_DB=/assets/docs-db
```

It has to be set there and not in `sandbox: env:`, because that key is a
name-only allow-list - it forwards the _host's_ value, which would be a host
path that does not exist inside the container.

### As tools - what the library uses

`@zenera/rag` exports the same engine as four tools in the group `docs`, which
an agent takes with `docs:*`:

```ts
import { createEmbedder, loadProject } from '@zenera/neo';
import { docs } from '@zenera/rag';

const index = await docs.DocsIndex.open(
    './assets/docs-db',
    createEmbedder('openai/text-embedding-3-small'),
);
const project = await loadProject('./my-project', { tools: docs.docsTools(index) });
```

| Tool          | For                                                              |
| ------------- | ---------------------------------------------------------------- |
| `search_docs` | the passages that match, quoted with their line numbers          |
| `list_docs`   | the documents, their headings, or their tables - no search       |
| `grep_docs`   | every matching line, counted in full - no search                 |
| `read_docs`   | a section or a line range, verbatim; several at once via `reads` |

Only `search_docs` ranks. Every answer carries line numbers and `read_docs`
takes them, which is the loop the whole subject exists for: **find the passage,
read around it, then edit the file the passage came from.**

## Whichever way in - write the project a skill

**An index used by a project needs a skill in that project.** This is not
optional and it is not the same thing as wiring the tools in.

Wiring alone leaves the model to infer everything that matters. A tool
description says what `grep_docs` does; it cannot say that this index holds the
4.1 and 4.2 manuals side by side, that every answer must be pinned to a release,
that the reference lives under `*/api/**` and the guides under `*/guides/**`, or
that the numbers anybody actually wants are in tables. That is project
knowledge, and it belongs in a skill - loaded when the model is working on this
corpus, rather than sitting in the system prompt of every run.

```
<project>/agents/skills/<corpus>-docs/SKILL.md
```

| The skill says     | Because                                                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| which corpus       | what it is, which versions, and when it was indexed                                                                               |
| where the index is | an agent cannot guess a path                                                                                                      |
| the document names | every `--file` pattern is matched against them, and a model guessing at them narrows to nothing and concludes the corpus is empty |
| which command      | meaning → `search`; presence or a count → `grep`; what it says → `show`                                                           |
| never the shell    | say it outright - `grep`/`cat` over the tree is the reflex                                                                        |

Tell the agent to list the documents once before its first search.

## Keep it built

Indexing is a setup step, so it goes in `scripts/`, as one file named in the
`STEPS` list of `scripts/_setup.sh`:

```sh
# scripts/docs_index.sh
set -eu
cd "$(dirname "$0")/.."
OUT=assets/docs-db

if [ "${FORCE:-0}" = 0 ] && zen rag docs ready --dir "$OUT" --quiet; then
    echo "$OUT is already built"
    exit 3
fi
if [ "${CHECK:-0}" = 1 ]; then
    zen rag docs ready --dir "$OUT" || true   # its reason and its fix, verbatim
    exit 4
fi
# The index is committed and `lance/` is not, so a clone has the documents and
# no vectors: re-embed from the copies rather than indexing everything again.
if [ "${FORCE:-0}" = 0 ] && [ -f "$OUT/manifest.json" ]; then
    zen rag docs restore --dir "$OUT"
    exit 0
fi
rm -rf .tmp/docs-db
zen rag docs index assets/docs --embedding openai/text-embedding-3-small --out .tmp/docs-db
rm -rf "$OUT"
mv .tmp/docs-db "$OUT"
```

It builds into `.tmp/` and moves the result into place, so an interrupted run
never leaves a half-built index where a whole one should be. Nothing watches the
corpus: rebuild when the documents change.

The `ready` test is the part worth copying. `manifest.json` is written last and
is committed; `lance/` is binary and is git-ignored. Testing for the manifest
therefore reports `skipped` on a fresh clone that cannot search at all, and the
failure surfaces much later as a search error nobody connects to setup. `zen rag
docs ready` opens the store and answers with its exit code — 0 searchable, 3
not — and `zen rag docs restore` puts the vectors back from the index's own
`sources/`, which is also how an index moves to another embedding model.

The same test answers `scripts/_setup.sh --check`, which makes every step's
readiness test and does none of the work. That is the command to run on a fresh
clone: `zen check` will pass on a project whose index cannot answer anything,
because an index is not something `agents.yaml` declares, and without `--quiet`
the `ready` output the step passes through names the missing part and the
`restore` that fixes it.

Say in `SPECIFICATION.md` that the project has a document index, what is in it,
and which agents may read it - then `/spec-sync-project` maintains the skill, the
tool grant and the setup step for you. See
[specification.md](specification.md).

## Further

- Your editor has a `zen-rag-docs` skill installed by `zen init`, with the full
  command surface and the failure modes.
- [`packages/rag`](../packages/rag/README.md) - the package, and its library API
- [agents-yaml.md](agents-yaml.md) - the `assets:` and `sandbox:` reference
