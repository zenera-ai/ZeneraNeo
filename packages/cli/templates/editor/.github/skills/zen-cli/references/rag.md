# API search - `zen rag`

```
zen rag schema <index|restore|ready|search|list|grep|trace|show|stats> [spec...]
```

Provided by `@zenera/rag` - `npm i -g @zenera/rag` if `zen rag` says it is not
installed.

Reads an OpenAPI/Swagger document as a **graph** - operations, schemas and the
fields inside them, joined by the `$ref`s between them - and makes it
searchable. The answer to a search is not a list of matches but the connected
piece of the API that matched: the operations, the schemas they carry and the
fields inside them, printed as text, a diagram, or TypeScript that compiles.

It exists because a large specification does not fit in a context window and
grepping it returns fragments that name types nobody printed.

## `index`

```
zen rag schema index <spec...> [--embedding <ref>] [-o <dir>] [--batch <n>]
```

| Flag                | Default       | Meaning                                                      |
| ------------------- | ------------- | ------------------------------------------------------------ |
| `--embedding <ref>` | -             | Which embedder makes the vectors. Omit it to see the choices |
| `-o`, `--out <dir>` | `./schema-db` | Where the index goes; `$ZEN_SCHEMA_DB` if set                |
| `--batch <n>`       | model's own   | Texts per embedding request. `gemini-embedding-*` takes 1    |
| `--no-sources`      | -             | Keep no copy of the documents in the index                   |
| `--quiet`           | -             | No narration                                                 |

```
zen rag schema index openapi.yaml --embedding openai/text-embedding-3-small
```

Unlike the gym, `$ref`s are **bundled, not dereferenced**: component names are
the node ids and the cycles between them are the edges. `discriminator` is kept -
it is what turns a `oneOf` into a tagged union a compiler can narrow.

What lands in `<out>`:

```
manifest.json     written last; its presence means the index is complete
graph.json        the nodes and edges
schemas.json      the schemas, read lazily
operations.json   the operations, read lazily
lance/            the vector and full-text indexes
```

The manifest records the embedding ref **and** the embedder's own id, so a
search with a different model is refused rather than quietly returning nonsense.

## `ready` and `restore`

```
zen rag <docs|schema> ready   [-d <dir>] [--quiet] [--json]
zen rag <docs|schema> restore [-d <dir>] [--embedding <ref>] [--dimensions <n>]
```

`lance/` is binary and rebuildable, so a project commits the index and
git-ignores the vectors. A clone then holds an index that looks built and cannot
search. `ready` is the question "can this answer", and the answer is the **exit
code**: 0 searchable, 3 absent or missing its vectors. It needs no embedder and
no credential.

`restore` re-embeds the index from the copies in its own `sources/`, so nothing
has to be fetched or found again. It is also how an index changes model:
`--embedding <ref>` re-embeds everything and rewrites the manifest. The rebuild
is staged beside the index and renamed into place, so a failure leaves the old
one intact - and needs room for both meanwhile. A schema index built with
`--no-sources` has nothing to restore from and is refused.

In a setup step, in this order:

```sh
if [ "${FORCE:-0}" = 0 ] && zen rag docs ready --dir "$OUT" --quiet; then exit 3; fi
if [ "${CHECK:-0}" = 1 ]; then zen rag docs ready --dir "$OUT" || true; exit 4; fi
if [ "${FORCE:-0}" = 0 ] && [ -f "$OUT/manifest.json" ]; then
    zen rag docs restore --dir "$OUT"; exit 0
fi
# … otherwise index it from the documents
```

Exit 4 is what `scripts/_setup.sh --check` reports as `needs setup`. Dropping
`--quiet` there is deliberate: `ready` prints what is missing and the command
that fixes it, and repeating that in the step would be a second opinion to keep
in step with this one.

## Which index gets read

Every reading command takes `-d`, `--dir`. Without one:

1. `$ZEN_SCHEMA_DB`, if it is set.
2. Otherwise the **nearest index** to the working directory - here, then a
   short way down, then up a level and again, stopping at your home directory.
   The one used is named on stderr.
3. Otherwise `./schema-db`, so the error names the directory you expected.

What is looked for is a `manifest.json`, not a directory called `schema-db`, so
an index called anything else is found the same way. Two the same distance away
is refused rather than guessed at - name one with `-d`, or set `ZEN_SCHEMA_DB`
once and stop typing it.

## `search`

```
zen rag schema search [terms…] [filters…]
```

Every argument is validated before an embedder is constructed, so a typo is a
usage error rather than a credential error.

**Bare words are the query, not a subcommand.** `zen rag schema search list
methods` searches for the phrase _"list methods"_ and returns ranked guesses;
`zen rag schema list methods` is the listing. `search` is also the only read
command that embeds, so it is the only slow one.

### Terms - repeatable, and the field is the point

| Term                    | Searches                                 |
| ----------------------- | ---------------------------------------- |
| `<text>`                | Everything, the same as `--all`          |
| `--all <q>`             | Everything, unfiltered                   |
| `--method <q>`          | Operations                               |
| `--type <q>`            | Schemas, on the side `--direction` names |
| `--input-type <q>`      | Schemas a call accepts                   |
| `--output-type <q>`     | Schemas a call returns                   |
| `--property <q>`        | Fields and parameters, per `--direction` |
| `--input-property <q>`  | Fields and parameters a call accepts     |
| `--output-property <q>` | Fields a call returns                    |
| `--query <json\|->`     | A whole query object; `-` reads stdin    |

Putting the intent in the field that matches what is wanted is what makes the
search good. A request field belongs in `--input-property`, a response field in
`--output-property`; `--all` cannot filter and is the weakest of them.

### Filters and shape

| Flag                        | Default     | Meaning                                                 |
| --------------------------- | ----------- | ------------------------------------------------------- |
| `-d`, `--dir <dir>`         | found       | Which index - see "Which index gets read"               |
| `--embedding <ref>`         | the index's | Must be the one the index was built with                |
| `--direction <d>`           | `any`       | `input`, `output` or `any`                              |
| `--method-type <t>`         | `any`       | `read_only`, `read_write` or `any`                      |
| `--exclude-id <id>`         | -           | Drop a node. Repeatable                                 |
| `--exclude-method <name>`   | -           | Drop an operation by name. Repeatable                   |
| `--exclude-type <name>`     | -           | Drop a schema by name. Repeatable                       |
| `--exclude-property <name>` | -           | Drop a field by name. Repeatable                        |
| `--limit <n>`               | `5`         | Seeds kept per term                                     |
| `--max-hops <n>`            | `3`         | How far apart two hits may be                           |
| `--max-nodes <n>`           | `200`       | Nodes per result                                        |
| `--format <f>`              | `text`      | `text`, `mermaid`, `mermaid-flowchart`, `ts`, `openapi` |
| `--show-source`             | -           | Tag each operation and schema with its document         |
| `--no-docs`                 | -           | Leave the descriptions out                              |
| `--interactive`             | -           | Prompt, search, refine. Needs a terminal                |
| `--quiet`                   | -           | No narration                                            |

```
zen rag schema search --method "reset a user password" --format ts
zen rag schema search --output-property "invoice total" --direction output
echo '{"methods":["cancel a subscription"]}' | zen rag schema search --query -
```

The exclusions are what turn one search into a session: pass back the ids of
what you have already been shown to be shown something else instead of the same
thing again.

`--format ts` emits TypeScript closed over its own `$ref`s - everything named is
also declared, so the output compiles on its own.

### `--interactive`

A prompt that keeps the query between searches:

```
<text>                  search everything
all|method|type <text>  search one field
input-property <text>   also: output-property, property, input-type, output-type
direction <d>           input | output | any
method-type <t>         read_only | read_write | any
format <f>              text | mermaid | mermaid-flowchart | ts | openapi
show                    the query as it stands
reset                   forget it, exclusions included
quit
```

## `list` and `grep`

```
zen rag schema list <methods|types|properties> [-d <dir>] [--name <p>] [--path <p>]
zen rag schema grep <pattern> [-d <dir>] [--name <p>] [--path <p>] [--kind <k>]
```

Exact, and therefore complete. `search` ranks, so it can only hand back the top
of a list - it cannot tell you that something is _not_ there. These can: they
read `graph.json` directly, with no embedder, no credential and no network.

| Flag                | For    | Meaning                                      |
| ------------------- | ------ | -------------------------------------------- |
| `--name <p>`        | both   | Match the name. Repeatable                   |
| `--path <p>`        | both   | Match the route it sits on. Repeatable       |
| `--regex`           | both   | Read the patterns as regular expressions     |
| `--case-sensitive`  | both   | Stop ignoring case                           |
| `--source <name>`   | both   | Only nodes from one document                 |
| `--show-source`     | both   | Print which document each row came from      |
| `--method-type <t>` | `list` | `read_only`, `read_write` or `any`           |
| `--direction <d>`   | `list` | `input`, `output` or `any`                   |
| `--kind <k>`        | `grep` | `method`, `type` or `property`. Repeatable   |
| `--ids-only`        | `grep` | Just the ids, one per line, for piping       |
| `--limit <n>`       | both   | Rows to print. `found` still counts them all |
| `--quiet`           | both   | No narration                                 |

Under `--json`: `{found, truncated, rows}` from `list`, `{found, truncated,
matches}` from `grep`. `grep` takes **one** pattern - quote it if it has
spaces - and `list` **one** subject.

A pattern with `*` or `?` is a glob matched against the whole string; a plain
word is a substring. So `--name password` finds `ResetPasswordPayload`, and
`--name "Password*"` finds nothing, because nothing starts with it. `--regex`
makes it a regular expression instead - the only way to say "one of these". On
`list` it applies to every pattern; on `grep` it applies to the pattern, while
`--name` and `--path` stay globs-or-substrings:

```
zen rag schema list methods --regex --path "^/(users|teams)/"
```

`--path` selects on the route an operation sits on, and on the route a
parameter's operation sits on. A schema belongs to no one route, so `--path`
never selects one.

```
zen rag schema list methods --path "*/users*"
zen rag schema list types --name "*Password*"
zen rag schema grep password
zen rag schema grep "pass(word|phrase)" --regex
zen rag schema grep status --path "/invoices/*" --kind property
zen rag schema grep token --ids-only | xargs zen rag schema show --format ts
```

No match exits 0 with nothing on stdout - that is the answer, and unlike an
empty search it is a reliable one. Under `--limit`, `found` is still the true
total, so a shortened answer never misreports how much there is.

## `trace`

```
zen rag schema trace <pattern|id...> [-d <dir>] [--kind <k>] [--direction <d>]
                     [--max-hops <n>] [--limit <n>] [--routes <n>]
                     [--ids-only] [--regex] [--case-sensitive] [--source <name>]
                     [--show-source]
```

The question `list` and `grep` leave you holding: you have found the field, so
**which call can reach it?** `trace` walks up the `$ref`s from every node of
that name to the operations that accept or return it, and prints the chain in
between. Also a plain graph read - no embedder, no credential.

```
zen rag schema trace city
```

```
Property:Address.city
    GET /users/{userId}  getUser  output  PublicUserProfile.address → Address.city
```

By hand that is three lookups and a guess: find the field, find what holds
`Address`, find what accepts _that_, and hope you followed every branch.

`search` does some of this already - it stitches its seeds into one connected
piece and prints what each operation accepts and returns. But it links only
what **ranked**, only within `--max-hops`, and it never names the chain; and
`getUser` and `city` share no word, so the field has to rank on its own and the
call has to land near it. `trace` follows the edges instead, which are already
there and are certain.

| Flag              | Default            | Meaning                                              |
| ----------------- | ------------------ | ---------------------------------------------------- |
| `--kind <k>`      | types + properties | `method`, `type` or `property`. Repeatable           |
| `--direction <d>` | `any`              | Keep only the calls that accept it, or return it     |
| `--max-hops <n>`  | `8`                | How far up to walk                                   |
| `--limit <n>`     | -                  | Trace at most n matching nodes                       |
| `--routes <n>`    | -                  | Operations printed per node; `found` counts them all |
| `--ids-only`      | -                  | Bare operation ids, one per line, for piping         |
| `--regex`         | -                  | Read the pattern as a regex; `--case-sensitive` too  |
| `--source <name>` | -                  | Only nodes from one document                         |
| `--show-source`   | -                  | Print which document each operation came from        |

A bare word is matched the way `list --name` matches it - substring, or a glob
when it has `*` or `?`. A node id (`Type:User`) is taken as that node and not
as a pattern. Operations are left out of a name match on purpose: they are
where a trace ends.

```
zen rag schema trace password --direction input
zen rag schema trace "*Settings" --kind type
zen rag schema trace mfa_secret --ids-only | xargs zen rag schema show --format openapi
```

A node nothing carries prints `no operation reaches it` - a real answer, and
one worth having: it means the schema is unreachable in this document.

## `show`

```
zen rag schema show [id...] [-d <dir>] [--format <f>] [--exact]
                    [--method <name>] [--type <name>] [--source <name>]
                    [--show-source] [--max-nodes <n>] [--no-docs] [--quiet]
```

Prints named nodes with no search in between. Needs no embedder and no
credential - it is a read of the graph.

Ids are one way in; `--method` and `--type` name things directly, which is
usually what you have. A bare name means exactly that name; add `*` to select
more than one. `--source <name>` takes a whole document, and `--show-source`
tags each node with the document it came from. `--exact` prints only what was
named instead of the neighbourhood around it - with `--format openapi` that is
a valid, self-contained slice of the specification. Without it the neighbours
are stitched in, up to `--max-nodes`.

`--source <name> --format openapi` with nothing else named prints the
**verbatim** document as it was indexed, unless the index was built
`--no-sources`, in which case it is rebuilt from the graph and says so.

A name that matches nothing is an **error**, not an empty answer: naming
something is a claim that it is there, and `list --name` is the command for
asking whether it is.

```
zen rag schema show --method GetCurrentUserInfo --format openapi --exact
zen rag schema show --type "*Invoice*" --format ts
```

## `stats`

```
zen rag schema stats [-d <dir>]
```

What is in an index and what built it: counts by kind, the embedding model, the
documents it came from. Also needs no embedder.

## Giving it to an agent

`@zenera/rag/tools` exports the same search as tools an agent can call:

| Tool                       | For                                                                 |
| -------------------------- | ------------------------------------------------------------------- |
| `search_api`               | The search above, with the same fields                              |
| `describe_types`           | Named schemas as TypeScript, closed over what they refer to         |
| `find_types_with_property` | Every schema with a field of this name - exact lookup, no searching |
| `list_api`                 | Methods, types or fields by name - complete, and counted in full    |
| `grep_api`                 | Every literal occurrence of a string - the way to prove absence     |
| `trace_api`                | Up from a field or schema to the operations that carry it           |

Only `search_api` ranks. Reach for the others whenever the question is whether
something exists, because a search that returns nothing and a thing that is not
there look exactly the same. `trace_api` is the one for after a field has been
found and the endpoint to call is what is actually wanted.

They share the group `schema`, so an agent takes them with `schema:*` in its
`tools:`.

# Document search - `zen rag docs`

```
zen rag docs <index|restore|ready|search|list|grep|show|stats> [args...]
```

The second subject of the same command. Where `schema` reads an API description
as a graph, `docs` reads a pile of **markdown and plain text** and answers with
the documents themselves: the passages that matched, quoted verbatim with their
line numbers, and a marker wherever something between two of them was skipped.

## `index`

```
zen rag docs index <path...> [--embedding <ref>] [-o <dir>] [--chunk-tokens <n>]
```

| Flag                 | Default     | Meaning                                                      |
| -------------------- | ----------- | ------------------------------------------------------------ |
| `--embedding <ref>`  | -           | Which embedder makes the vectors. Omit it to see the choices |
| `-o`, `--out <dir>`  | `./docs-db` | Where the index goes; `$ZEN_DOCS_DB` if set                  |
| `--batch <n>`        | model's own | Texts per embedding request. `gemini-embedding-*` takes 1    |
| `--chunk-tokens <n>` | `384`       | Target chunk size                                            |
| `--quiet`            | -           | No narration                                                 |

Paths may be files, directories or globs. `.md`, `.markdown`, `.txt` and
`.text` are read; hidden directories and `node_modules` are not.

Every document is **copied into the index**, and every quoted line is read back
out of that copy - so the index is one portable thing and what it quotes is the
document rather than a reconstruction of it. Each document is named by its path
relative to the common root of everything indexed, which is what keeps
`acme_4.1.0/api/routing.md` and `acme_4.2.0/api/routing.md` apart.

```
docs-db/
manifest.json     written last; its presence means the build finished
outline.json      every heading and table, with the lines they cover
sources/          the documents, verbatim
lance/            one row per chunk: two texts, one vector, the filter columns
```

The manifest means the build finished, not that the index can answer here:
`lance/` is usually git-ignored. `ready` and `restore` above are the pair that
closes the difference, for both subjects.

## `search`

```
zen rag docs search [text...] [-f <pattern>] [-s <section>] [--kind <k>]
```

| Flag                     | Default  | Meaning                                              |
| ------------------------ | -------- | ---------------------------------------------------- |
| `-f`, `--file <pattern>` | -        | Only documents whose name matches. Repeatable        |
| `--exclude-file <p>`     | -        | Drop documents whose name matches                    |
| `-s`, `--section <name>` | -        | Only under this heading, and what nests in it        |
| `--kind <k>`             | -        | `paragraph`, `list`, `table`, `table_row`, `code`, … |
| `--mode <m>`             | `hybrid` | `hybrid`, `vector` or `text` for exact wording       |
| `--text-query <text>`    | -        | Wording for the full-text leg, instead of `[text]`   |
| `--vector-query <text>`  | -        | Wording for the vector leg, instead of `[text]`      |
| `--limit <n>`            | `8`      | Passages kept                                        |
| `-B`, `-A <n>`           | `0`      | Extra lines quoted before and after each passage     |
| `--max-lines <n>`        | `400`    | A ceiling on the whole answer                        |
| `--exclude-id <id>`      | -        | Drop a passage already seen. Repeatable              |
| `--hits`                 | -        | One line per passage instead of the text             |
| `--interactive`          | -        | Prompt, search, narrow, search again                 |

**Narrowing is the interface.** Nobody finds the right paragraph on the first
ask; the second call is the same question inside one part of the tree.

```
zen rag docs search "how are rate limits counted"
zen rag docs search --file "acme_4.2.*/api/**" "rate limit for the users route"
zen rag docs search --section "Rate limits" --kind table "requests per minute"
zen rag docs search --mode text "X-RateLimit-Remaining"
```

A `--file` pattern with `*` or `?` is a glob over the whole document name and
a substring otherwise.

### Limiting the search scope

`--file` selects the documents that are allowed to contribute passages. Repeat
it to include multiple document families; use `--exclude-file` to subtract a
family. Both are applied before ranking, so a returned passage cannot come from
a document outside the selected set. Start with `list files` when the corpus
names are unknown:

```sh
zen rag docs list files -d <index-dir>
zen rag docs search -d <index-dir> --file "manual-*/**" "<question>"
zen rag docs search -d <index-dir> --file "guide-*/**" --file "reference-*/**" \
  --exclude-file "*-archive/**" "<question>"
```

`--section` narrows the selected documents again, retaining a named heading and
all headings below it. It accepts a heading title, structure id, or structure
path printed by `list sections`. Combine it with `--file` when the same heading
exists in more than one document. `--kind` scopes by content shape: use `table`
or `table_row` for limits and matrices, and `code` for commands or examples.

```sh
zen rag docs list sections -d <index-dir> --file "manual-*/**"
zen rag docs search -d <index-dir> --file "manual-*/**" --section "Operations" \
  --kind table_row "<question about a limit>"
```

### Search strategy

### How retrieval modes work

Search has two independent retrieval legs, followed by reciprocal-rank fusion
and a diversity pass. It does **not** run full-text search and then use a vector
model to rerank those same results.

| Mode     | What runs                                | Best for                                                      | Caution                                               |
| -------- | ---------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------- |
| `hybrid` | Full-text and vector legs, fused by rank | Default: concepts, explanations, broad questions              | A broad corpus can still need `--file` or `--section` |
| `text`   | Full-text only                           | Exact errors, headers, commands, identifiers, and phrases     | Literal wording only; misses paraphrases              |
| `vector` | Vector similarity only                   | A concept whose wording is unknown or differs from the corpus | Can retrieve topical but imprecise passages           |

The full-text leg rewards words present in the chunk. The vector leg embeds the
question and retrieves similar meaning, even with different vocabulary. Hybrid
adds a rank-based contribution from each leg, so a passage supported by both
normally rises while a strong result from either leg can still appear. The final
diversity pass prevents near-identical neighbouring chunks from consuming the
whole answer.

**Use hybrid first.** Ask the user-facing question as a complete sentence. It
combines semantic similarity with the words in the corpus and is the strongest
default for concepts, explanations, and broad operational questions:

```sh
zen rag docs search -d <index-dir> "How is a failed request retried?"
```

Treat the answer as candidates, not confirmation. Search ranks a fixed number
of passages, so it cannot prove an exact phrase is absent and may return a
nearby version or an incident that happens to share terms. Read the returned
line-numbered passage; then use `show` for its surrounding section or `grep`
for an exact existence check.

**Narrow before rewriting the question.** For a corpus with releases, products,
or repeated manuals, a broad term can retrieve a relevant-looking answer from
the wrong part of the tree. Keep the question and progressively constrain it:

```sh
zen rag docs list files -d <index-dir>
zen rag docs list sections -d <index-dir> --file "guide-*/**"
zen rag docs search -d <index-dir> --file "guide-*/**" --section "Operations" \
  "How is a failed request retried?"
```

Use `--kind table` or `--kind table_row` for a limit, entitlement, or matrix;
use `--kind code` for a command or configuration sample. Pass returned ids to
`--exclude-id` when the next answer must be new rather than a repeat.

**Use exact lookup for exact claims.** `--mode text` is for a known error,
header, command, identifier, or phrase. `grep` is stronger when the question is
whether that exact string appears anywhere, because it counts every match and
does not depend on vector ranking:

```sh
zen rag docs search -d <index-dir> --mode text "exact identifier"
zen rag docs grep -d <index-dir> "exact identifier"
```

**Split the wording only when it is genuinely two wordings.** The text leg
wants a distinctive string likely to occur verbatim; the vector leg wants the
full intent. This is useful for an exact identifier plus an explanatory
question:

```sh
zen rag docs search -d <index-dir> --text-query "exact identifier" \
  --vector-query "what it means, its constraints, and how to use it"
```

Both flags run and fuse the two legs. One on its own runs only that leg.
`--text-query` and `--vector-query` replace positional `[text]` and settle the
mode themselves: do not combine them with `[text]` or `--mode`.

Split search is an expert control, not a stronger default. A generic text leg
such as a product name or common noun retrieves every incidental mention and
can displace the more useful semantic passages. Use it only when the text leg
is specific enough to add evidence rather than noise; otherwise stay with
ordinary hybrid search and narrow by file or section.

## `list`, `grep`, `show` - no embedder, no credential

```
zen rag docs list <files|sections|tables> [-f <pattern>] [-s <section>]
zen rag docs grep <pattern> [-f <pattern>] [--regex] [--case-sensitive]
zen rag docs show <file> [--section <name>] [--lines <from-to>]
zen rag docs show <target>... [--max-lines <n>]
```

`list sections` gives every heading with the lines it spans, which is how a
section is named before it is searched. `grep` reports `found` as the true
total even when `--limit` cuts the rows, so unlike a search it can answer
whether a string appears at all. `show` prints a document, a named section, or
a line range, verbatim.

### Reading several passages in one call

Name every passage you will read or cite in **one** `show`, as
`<document>:<a>-<b>`, `<document>:<a>` or `<document>#<heading>` - the form a
citation is written in, so a citation pastes back unchanged:

```sh
zen rag docs show -d <index-dir> "<doc-1>:24-60" "<doc-2>:25-40" "<doc-3>#<heading>"
```

Each target prints under a header that is itself a target, in the order given;
overlapping ranges in one document print once. A missing document or heading is
reported in place and the rest still print (exit 1 only when none could be
read). `--max-lines` (default 400) is shared fairly between targets, and a cut
block ends with the target that continues it. `--json` returns
`{results, printed, failed}`. `--section` and `--lines` read one document only.

### Reading a complete section or table

Search finds relevant passages, not necessarily every row of a table. When the
whole section or table is needed, use the exact readers instead of increasing a
search limit.

Read a heading and everything nested beneath it verbatim:

```sh
zen rag docs show -d <index-dir> "<document-name>" --section "<heading>"
```

For one complete table, list its metadata first. Each row reports the document
name and the table's inclusive `line` and `end` range. Give that range to
`show --lines` to print the complete table, including its header, verbatim:

```sh
zen rag docs list tables -d <index-dir> --file "<document-name>"
zen rag docs show -d <index-dir> "<document-name>" --lines <line>-<end>
```

Narrow `list tables` with `--file` or `--section` when the corpus has many
tables. `search --kind table` and `search --kind table_row` are useful to find
a relevant table, but remain ranked retrieval; use the listed line span when
the answer needs every row.

## Giving it to an agent

`@zenera/rag/docs/tools` exports four tools in the group `docs`:

| Tool          | For                                                              |
| ------------- | ---------------------------------------------------------------- |
| `search_docs` | The search above, with the same narrowing parameters             |
| `list_docs`   | The documents, their headings, or their tables - no ranking      |
| `grep_docs`   | Every matching line, counted in full - the way to prove absence  |
| `read_docs`   | A section or a line range, verbatim; several at once via `reads` |

Only `search_docs` ranks. Every answer carries line numbers and `read_docs`
takes them, which is the loop the subject exists for: find the passage, read
around it, then edit the file it came from.
