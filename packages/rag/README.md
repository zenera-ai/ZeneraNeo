<div align="center"> 
  <img
    src="https://raw.githubusercontent.com/zenera-ai/ZeneraNeo/main/docs/imgs/zenera-logo-with-media-queries.svg"
    alt="Zenera Logo"
    width="20"
  />
  <div>Powered By Zenera</div>
</div>
<br>

<div align="center">
  <img src="https://raw.githubusercontent.com/zenera-ai/ZeneraNeo/main/docs/imgs/banner-rag-with-media-queries.svg" alt="ZENERA RAG" width="702">

[![npm](https://img.shields.io/npm/v/@zenera/rag.svg)](https://www.npmjs.com/package/@zenera/rag)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/zenera-ai/ZeneraNeo/blob/main/LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A524-brightgreen.svg)](https://nodejs.org)
[![CI](https://github.com/zenera-ai/ZeneraNeo/actions/workflows/ci.yml/badge.svg)](https://github.com/zenera-ai/ZeneraNeo/actions/workflows/ci.yml)

[Install](#install) · [API schemas](#api-schemas---zen-rag-schema) · [Documents](#documents---zen-rag-docs) · [From code](#from-code---an-index-is-a-toolset) · [Family](#the-rest-of-the-family) · [License](#license)

</div>

# @zenera/rag

**Advanced indexing and retrieval for documents and API schemas, purpose-built
for agentic RAG.
Full-text, semantic, hybrid and graph search combine with
precise inspection and filtering so agents can verify every answer.**

> Part of [ZeneraNeo](https://github.com/zenera-ai/ZeneraNeo). It ships no
> binary of its own: installing it adds a `rag` **subcommand** to
> [`zen`](https://github.com/zenera-ai/ZeneraNeo/blob/main/packages/cli/README.md),
> so indexing, retrieval and agent tools fit one developer workflow.

## Complete retrieval for agentic systems

`@zenera/rag` is a complete retrieval layer for agents that work with technical
knowledge. Index content once, then discover relevant context, narrow the scope,
inspect exact source material and return only the representation the next step
needs. The same workflow is available through CLI commands and agent tools.

### Document indexing and search

- **Semantic, full-text and hybrid search** across Markdown and plain-text
  collections, with hybrid retrieval as the default.
- **Structure-aware indexing** for headings, sections, paragraphs, lists, code
  blocks and tables instead of treating every document as undifferentiated text.
- **Precise scoping** by file, section and content kind, with iterative exclusion
  of passages an agent has already considered.
- **Verbatim evidence** with source files, exact line ranges and configurable
  surrounding context, ready for citation or follow-up reading.
- **Deterministic inspection** through file, section and table listing, literal
  or regular-expression search, and direct reads by section or line range.
- **Multi-document indexing** with portable source-aware indexes, incremental
  rebuilds and interactive or non-interactive search workflows.

### API schema indexing and search

- **OpenAPI and Swagger indexing** across one specification, many services or
  multiple API revisions in a single searchable index.
- **Semantic, full-text and hybrid discovery** across operations, schemas,
  properties, parameters, request bodies and responses.
- **Graph retrieval** that follows schema relationships and returns the connected
  API context around a match instead of isolated search results.
- **Typed query controls** for methods, input and output types, properties,
  direction, read-only or mutating operations, source and graph depth.
- **Relationship tracing** from a field or schema to every operation that accepts
  or returns it, even when the operation and field share no searchable terms.
- **Multiple output formats** including readable trees, Mermaid diagrams,
  self-contained TypeScript declarations and standalone OpenAPI documents.
- **Deterministic inspection** through exact method, type and property listing,
  literal or regular-expression search, node lookup and source filtering.

### Agent-ready workflows

- **Discovery and verification in one workflow.** Search finds relevant context;
  exact operations establish whether something exists and retrieve it directly.
- **Progressive narrowing.** Agents can refine by source, structure, direction,
  type, path and previous results without rebuilding an index.
- **Stable machine interfaces.** Structured queries and JSON output support
  repeatable automation, while typed toolsets expose the same capabilities to
  ZeneraNeo agents.
- **Bounded context.** Result limits, graph depth, line ranges and output formats
  keep retrieved context focused and suitable for model input.

## From relevant to verified

Search is how an agent starts with an incomplete question. Verification is how
it finishes with evidence. `grep`, `list`, `trace` and `show` inspect the index
directly, so an agent can confirm a field, identify the operations that carry
it, read the surrounding source and refine the next query from what it found.

That workflow avoids treating a similarity score as proof: retrieve a relevant
starting point, inspect the exact material, then return an answer with the
context needed for the next decision.

## Install

Node.js 24+. Install it alongside the CLI:

```sh
npm i -g @zenera/cli @zenera/rag
zen key add openai          # the keyring `zen` already uses
```

Use the CLI to create and query indexes, or expose an opened index as tools to a
ZeneraNeo agent.

## API schemas - `zen rag schema`

**OpenAPI 3.1, OpenAPI 3.0 and Swagger 2.0**, as `.json`, `.yaml` or `.yml`,
one document or a whole folder of them. External references and multiple
specification versions are indexed as one connected API surface, so a query can
follow relationships across services, revisions and shared definitions.

A large specification does not fit in a prompt, and the parts of it that answer
a question are scattered: the field is on a schema, the schema is on a request
body, the body belongs to one operation out of three hundred. Search finds the
field. Only a graph gets from there to the call - so this keeps both, and
answers with the connected piece of the API that matched, rendered as a tree, a
Mermaid diagram, TypeScript declarations that compile on their own, or a
standalone OpenAPI document.

```
zen rag schema index <spec...>   Read the documents and write a searchable index.
zen rag schema restore           Re-embed an index from its own copies of the documents.
zen rag schema ready             Can this index answer? Exit 0 if it can, 3 if it cannot.
zen rag schema search            Ask it something. --interactive for a prompt.
zen rag schema list <what>       Every method, type or property. No ranking.
zen rag schema grep <pattern>    Every literal match across the whole index.
zen rag schema trace <what>      Up from a field to the calls that carry it.
zen rag schema show [id...]      Print named nodes, with no search in between.
zen rag schema stats             What is in an index, and what built it.
```

Index once, then ask:

```sh
zen rag schema index --embedding openai:text-embedding-3-small ./specs/*.yaml
zen rag schema search --output-property "user billing history"
zen rag schema search --input-property "password reset token" --format ts
zen rag schema search --interactive
zen rag schema show Type:Invoice      # a named node, with no search in between
```

### Exact API inspection

Search finds a starting point; exact inspection answers whether something is in
the API and shows every matching result:

```sh
zen rag schema list methods --path "*/users*"   # every route under /users
zen rag schema list types --name "*Password*"   # every schema so named
zen rag schema grep password                    # every literal occurrence
zen rag schema grep "pass(word|phrase)" --regex
zen rag schema show --method GetCurrentUserInfo --format openapi --exact
```

Nothing matching exits 0 - an empty answer is an answer, and here it is a
trustworthy one: if `grep` finds nothing, the word is not in the description.

### Which call carries this field

Finding a field is half the job; the other half is which call can reach it, and
that is a walk up the `$ref`s rather than a match on anything:

```sh
zen rag schema trace city
```

```
Property:Address.city
    GET /users/{userId}  getUser  output  PublicUserProfile.address → Address.city
```

No search can be relied on for this - `getUser` and `city` share no word for
either of them to rank on. A node nothing carries says so, which is worth
knowing: it means no request in this document will ever carry it.

<details>
<summary>Every flag</summary>

`zen rag schema --help` prints the same table.

**index**

```
--embedding <ref>          Which embedder makes the vectors. Omit it to be shown the choices.
-o, --out <dir>            Where the index goes. Default schema-db, or $ZEN_SCHEMA_DB.
--batch <n>                Texts per embedding request. Default: the model's own cap.
--dimensions <n>           Narrower vectors, if the model allows it.
--no-sources               Do not keep a copy of each document in the index.
--no-cache                 Embed everything again, ignoring vectors this machine already has.
--cache-dir <dir>          Keep the vectors somewhere other than the shared cache.
```

**search** - terms, one flag each, all repeatable

```
<text>                     A bare phrase, the same as --all.
--all <q>                  Against everything, unfiltered.
--method <q>               Operations.
--type <q>                 Schemas, on the side --direction names.
--input-type <q>           Schemas a call accepts.
--output-type <q>          Schemas a call returns.
--property <q>             Fields and parameters, per --direction.
--input-property <q>       Fields and parameters a call accepts.
--output-property <q>      Fields a call returns.
--query <json|->           A whole query object; - reads stdin.
```

**search** - filters and shape

```
-d, --dir <dir>            Which index. Found from here if unset; see $ZEN_SCHEMA_DB.
--embedding <ref>          Must be the one the index was built with.
--direction <d>            input | output | any. Default any.
--method-type <t>          read_only | read_write | any. Default any.
--exclude-id <id>          Drop a node. Repeatable, as are the three below.
--exclude-method <name>    Drop an operation by name.
--exclude-type <name>      Drop a schema by name.
--exclude-property <name>  Drop a field by name.
--source <name>            Only this document, as stats names it. Repeatable.
--limit <n>                Seeds kept per term. Default 5.
--max-hops <n>             How far apart two hits may be. Default 3.
--max-nodes <n>            Nodes per result. Default 200.
--format <f>               text | mermaid | mermaid-flowchart | ts | openapi.
--show-source              Name the document each operation and schema came from.
--no-docs                  Leave the descriptions out.
--interactive              Prompt, search, refine. Needs a terminal.
--quiet                    No narration.
```

**list** and **grep**

```
list methods               Operations. Filter with --path and --name.
list types                 Schemas. Filter with --name.
list properties            Fields and parameters. Filter with --name and --path.
grep <pattern>             Substring over every node; --regex for a regex.
--regex                    Read every pattern as a regex, list and grep alike.
--case-sensitive           Match the capitals too.
--kind <k>                 grep: method | type | property. Repeatable.
--name <p>                 Only nodes whose name matches. Repeatable.
--path <p>                 Only what sits on a matching route.
--ids-only                 grep: bare ids, to pipe into show.
--source <name>            Only this document, as stats names it.
--show-source              Print which document each row came from.
--limit <n>                Keep at most n; the count still reports them all.
```

A pattern with `*` or `?` is a glob over the whole name; otherwise it is a
substring, so `--name password` finds `ResetPasswordPayload`. Under `--regex` it
is a regular expression either way - the only way to say "one of these
prefixes". A `--path` selects on the route an operation sits on, and on the
route a parameter's operation sits on; a schema belongs to no one route, so it
never selects one.

```sh
zen rag schema list methods --regex --path "^/(users|teams)/"
zen rag schema grep status --path "/invoices/*" --kind property

# Everything that mentions a token, rendered as TypeScript.
zen rag schema grep token --ids-only | xargs zen rag schema show --format ts
```

**trace**

```
<pattern|id...>            What to trace up from. A name, a glob, or a node id.
--kind <k>                 method | type | property. Schemas and fields by default.
--direction <d>            Keep only the calls that accept it, or return it.
--max-hops <n>             How far up to walk. Default 8.
--limit <n>                Trace at most n matching nodes.
--routes <n>               Operations printed per node; the count still has them all.
--ids-only                 Bare operation ids, one per line, for piping into show.
--regex                    Read the pattern as a regex. --case-sensitive too.
--source <name>            Only nodes from this document.
```

**show**

```
<id...>                    Node ids, e.g. Type:User or Property:User.email.
--method <name>            An operation by name. * to take more. Repeatable.
--type <name>              A schema by name. * to take more. Repeatable.
--source <name>            A whole document, as it was indexed.
--show-source              Name the document each node came from.
--exact                    Only what was named, without the neighbours.
```

Search is also a machine interface: every field is a flag, a whole query can
arrive as one JSON object, and `--json` returns a stable structure for
automation.

```sh
zen rag schema search --query - --format ts <<'JSON'
{
  "input_properties": ["password reset token"],
  "method_type": "read_write",
  "exclude_ids": ["Type:PublicUserProfile"],
  "limit": 3
}
JSON
```

</details>

## Documents - `zen rag docs`

**Markdown and plain text** - `.md`, `.markdown`, `.txt` and `.text` - named as
files, directories or globs; hidden directories and `node_modules` are skipped.

The answer is the documents themselves: the passages that matched, quoted
verbatim with their line numbers, and a marker wherever something between two of
them was left out. Nothing is paraphrased, so the next question can be phrased
in line numbers and the file can be edited from the answer.

```
zen rag docs index <path...>     Read the documents and write a searchable index.
zen rag docs restore             Re-embed an index from its own copies of the documents.
zen rag docs ready               Can this index answer? Exit 0 if it can, 3 if it cannot.
zen rag docs search [text]       Ask it something. --interactive for a prompt.
zen rag docs list <what>         Every document, section or table. No ranking.
zen rag docs grep <pattern>      Every matching line, with the section it sits in.
zen rag docs show <target...>    Documents, sections or line ranges, several in one call.
zen rag docs stats               What is in an index, and what built it.
```

```sh
zen rag docs index --embedding openai:text-embedding-3-small ./docs
zen rag docs search "how are rate limits counted"
```

```
## acme_4.2.0/api/routing.md - 9 of 148 lines

  5 | ## Rate limits
  7 | Requests are counted per tenant and rejected past the limit.
... 12 lines omitted (Retries, Backoff) ...
 24 | | route | limit | window |
 25 | | --- | --- | --- |
 27 | | /api/users | 250 | 1m |
```

### Narrowing is the interface

Nobody finds the paragraph they want on the first ask. The second call is the
same question asked inside one part of the tree, one heading, or one kind of
content:

```sh
zen rag docs search --file "acme_4.2.*/api/**" "rate limit for the users route"
zen rag docs search --section "Rate limits" --kind table "requests per minute"
zen rag docs search --mode text "X-RateLimit-Remaining"   # exact wording only
zen rag docs search --interactive                          # narrow by typing
```

Two releases of the same file stay apart, because a document is known by its
path relative to the common root of everything indexed. Tables survive the trip
whole: a row that matches still arrives with its column names attached, so a
number is never quoted without the thing it measures.

### One wording per leg

A plain query is asked of two retrievers that read it differently: the full-text
index wants the words the documents themselves use, and the vector index wants
the question stated in full. One sentence rarely suits both. `--text-query` and
`--vector-query` say each outright, and what comes back is fused exactly as it
would have been:

```sh
zen rag docs search --text-query "Retry-After" \
  --vector-query "how long to wait before trying the request again"
```

Either flag on its own runs that leg alone. They replace the positional text
rather than narrowing it, and they settle the mode by existing, so `--mode`
alongside a single wording is refused instead of quietly losing.

### Exact document inspection

```sh
zen rag docs list files                      # every document, and what it holds
zen rag docs list sections --file "api/**"   # every heading, with its line span
zen rag docs list tables                     # every table, with its columns
zen rag docs grep "Retry-After"              # every matching line, and its section
zen rag docs show api/routing.md --section "Rate limits"
zen rag docs show api/routing.md --lines 40-80
zen rag docs show "api/routing.md:24-31" "api/errors.md#Retries"
```

`grep` counts every match, not the top of a list, so unlike a search it can
answer whether a string appears at all.

`show` takes any number of targets written the way a citation is -
`<document>:<a>-<b>`, `<document>:<a>`, `<document>#<heading>`, or a bare name -
and prints each under a header that is itself a target, so reading every
passage an answer cites costs one call. Overlapping ranges print once, a
missing target is reported in place, and `--max-lines` (default 400) is shared
between them, each cut block naming the target that continues it.

<details>
<summary>Every flag</summary>

`zen rag docs --help` prints the same table.

**index**

```
<path...>                  Files, directories or globs. .md, .markdown, .txt, .text.
--embedding <ref>          Which embedder makes the vectors. Omit it to be shown the choices.
-o, --out <dir>            Where the index goes. Default docs-db, or $ZEN_DOCS_DB.
--batch <n>                Texts per embedding request. Default: the model's own cap.
--dimensions <n>           Narrower vectors, if the model allows it.
--chunk-tokens <n>         Target chunk size. Default 384.
--no-cache                 Parse and embed everything again, ignoring what is already kept.
--cache-dir <dir>          Keep the work somewhere other than the shared cache.
```

**search**

```
<text>                     What to look for. One question, not a list of terms.
-d, --dir <dir>            Which index. Found from here if unset; see $ZEN_DOCS_DB.
--embedding <ref>          Must be the one the index was built with.
-f, --file <pattern>       Only these documents. Repeatable.
--exclude-file <pattern>   Drop these documents. Repeatable.
-s, --section <name>       Only under this heading, and what nests in it.
--kind <k>                 paragraph | list | table | table_row | code | frontmatter | html.
--mode <m>                 hybrid | vector | text. Default hybrid.
--exclude-id <id>          Drop a passage already seen. Repeatable.
--limit <n>                Passages kept. Default 8.
-B, --before <n>           Extra lines quoted before each passage.
-A, --after <n>            Extra lines quoted after each passage.
--max-lines <n>            A ceiling on the whole answer. Default 400.
--no-numbers               Quote the lines without their numbers.
--hits                     One line per passage instead of the text.
--interactive              Prompt, search, narrow, search again. Needs a terminal.
--quiet                    No narration.
```

**list**, **grep** and **show**

```
list files                 Every document, with its size and what it holds.
list sections              Every heading. --depth to stop at a level.
list tables                Every table, with its columns and row count.
grep <pattern>             Every matching line. --regex for a regex.
show <file>                A document name, as list files prints it.
--file <pattern>           Narrow to documents. Repeatable, as everywhere.
--section <name>           Narrow to a heading and what nests in it.
--lines <from-to>          show: just those lines, e.g. --lines 40-80.
--regex                    Read every pattern as a regex.
--case-sensitive           Match the capitals too.
--no-numbers               show: without the line-number gutter.
--limit <n>                Keep at most n; the count still reports them all.
```

A `--file` pattern is a glob when it has `*` or `?` and a substring otherwise,
matched against the document's name relative to what was indexed - so
`--file "acme_4.2*/api/**"` is one release and `--file routing` is a word.
`--section` takes a heading title and covers whatever nests inside it. `--kind`
is for when the answer is a table and not the prose around it.

</details>

## Which index gets read

Indexes are discovered from the working directory, so commands and agents use
the relevant project index without repeating its path. Use `-d, --dir` to choose
one explicitly; `$ZEN_SCHEMA_DB` and `$ZEN_DOCS_DB` set a project-wide default.

When more than one index could apply, the command asks for an explicit choice
rather than searching the wrong project.

<details>
<summary>Index discovery</summary>

Document and schema indexes are discovered independently, so both can sit in a
project tree. A new index defaults to `docs-db` or `schema-db`, but any directory
can be used with `--out`.

</details>

## Portable, source-faithful indexes

An index is a self-contained project asset. It can be moved, committed or
supplied to an agent environment without depending on the paths from which it
was built. Schema indexes preserve the connected API surface across external
references; document indexes preserve the source material used for retrieval.

For documents, search results are always grounded in the original text, with
source names and line ranges available for inspection and follow-up work.

Because the documents travel inside the index, it can be rebuilt from itself.
Vector files are large and binary, so a project typically commits the index and
git-ignores `lance/`; a fresh checkout then has an index that looks complete and
cannot answer. `ready` reports that in an exit code, and `restore` re-embeds
from the copies already present.

```sh
zen rag docs ready --dir assets/docs-db      # exit 0 searchable, 3 not
zen rag docs restore --dir assets/docs-db    # re-embed from sources/
```

<details>
<summary>Built for project workflows</summary>

Indexes report their contents and build progress, prevent conflicting builds,
and can be inspected with `stats`. Use `--no-sources` for schema indexes when
you do not need to retain the source material alongside the index.

</details>

## Configure semantic retrieval

Choose an embedding provider with `--embedding <ref>` when creating an index.
Run `index` without the flag to see the providers available in your environment.

```sh
zen rag docs index --embedding openai:text-embedding-3-small ./docs
zen rag schema index --embedding openai:text-embedding-3-small ./specs
```

The selected provider stays associated with the index, ensuring search uses a
compatible representation of its content.

To change it later, `restore --embedding <ref>` re-embeds an existing index from
its own copies and rewrites the manifest, so no source material has to be
located again.

### Efficient rebuilds

Rebuild an index as content changes without repeating work for unchanged files
or passages. Interrupted builds resume, and shared content is reused across
indexes to keep large documentation and schema collections practical to update.

Use [`zen cache`](https://github.com/zenera-ai/ZeneraNeo/blob/main/packages/cli/README.md)
to inspect and manage reusable indexing data when needed.

## From code - an index is a toolset

Open an index in process to expose the same retrieval capabilities as tools an
agent can call:

```ts
import { createEmbedder, loadProject } from '@zenera/neo';
import { docs, SchemaIndex, schemaTools } from '@zenera/rag';

const embedder = createEmbedder('openai:text-embedding-3-small');
const api = await SchemaIndex.open('./schema-db', embedder);
const handbook = await docs.DocsIndex.open('./docs-db', embedder);

const project = await loadProject('./my-project', {
    tools: [...schemaTools(api), ...docs.docsTools(handbook)],
});
```

Six tools in the group `schema`, selectable as `schema:*`:

| Tool                       | For                                                     |
| -------------------------- | ------------------------------------------------------- |
| `search_api`               | the connected piece of the API that matches an intent   |
| `describe_types`           | named schemas as declarations that compile on their own |
| `find_types_with_property` | which types have a field of this name - no search       |
| `list_api`                 | the shape of the API: methods, types or fields          |
| `grep_api`                 | every literal occurrence of a string - no search        |
| `trace_api`                | the operations that carry a given field or schema       |

Only the first ranks. `find_types_with_property` is the one for the repair loop

- when `tsc` says `'password' does not exist in type 'PublicUserProfile'`, the
  model does not need the word explained again, it needs the list of types that
  have one. `grep_api` is the same instinct widened to the whole description, and
  `trace_api` is the step after both.

Four tools in the group `docs`, selectable as `docs:*`:

| Tool          | For                                                              |
| ------------- | ---------------------------------------------------------------- |
| `search_docs` | the passages that match, quoted with their line numbers          |
| `list_docs`   | the documents, their headings, or their tables - no search       |
| `grep_docs`   | every matching line, counted in full - no search                 |
| `read_docs`   | a section or a line range, verbatim; several at once via `reads` |

`search_docs` is the way in when the question is vague; `grep_docs` is how "it
is not in here" can actually be concluded. Every answer carries line numbers and
`read_docs` takes them, which is the loop the subject exists for: find the
passage, read around it, then edit the file the passage came from.

## The rest of the family

| Package                                                                                    | What it is                                                    |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| [`@zenera/cli`](https://github.com/zenera-ai/ZeneraNeo/blob/main/packages/cli/README.md)   | `zen` - agent projects on the command line                    |
| [`@zenera/neo`](https://github.com/zenera-ai/ZeneraNeo/blob/main/packages/neo/README.md)   | the runtime - agents, models, tools, skills, memory           |
| [`@zenera/meta`](https://github.com/zenera-ai/ZeneraNeo/blob/main/packages/meta/README.md) | `zen meta` - the meta-agent that builds and tunes a project   |
| [`@zenera/gym`](https://github.com/zenera-ai/ZeneraNeo/blob/main/packages/gym/README.md)   | `zen gym` - a mock API from an openapi/swagger document       |
| **`@zenera/rag`**                                                                          | `zen rag` - indexing and search for documents and API schemas |
| [`@zenera/view`](https://github.com/zenera-ai/ZeneraNeo/blob/main/packages/view/README.md) | `zen view` - a live local viewer for a folder                 |

## License

Early days and moving fast - issues, questions and pull requests are welcome.
[MIT](LICENSE).
