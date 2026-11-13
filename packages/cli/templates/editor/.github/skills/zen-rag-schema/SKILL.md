---
name: zen-rag-schema
description: What a schema index is, how it finds the right call inside a large OpenAPI/Swagger document, and how to build and query one with `zen rag schema` (or `npx @zenera/cli`) - searching it by meaning, listing and grepping it exactly instead of reaching for shell `grep`/`rg`, tracing a field up to the operations that carry it, giving it to an agent as tools, and writing the project skill that a wired-in index requires. For a pile of markdown instead of an API description, see `zen-rag-docs`.
user-invocable: false
---

# The schema index

A schema index is an OpenAPI/Swagger description turned into something that can
be **asked a question**. It is built once, on disk, and answered from without a
model: `zen rag schema index` writes it, and six commands read it.

It exists because a real specification does not fit in a context window, and
grepping it does not help. The parts that answer "how do I reset a password?"
are scattered on purpose: the field is on a schema, the schema is a request
body, the request body belongs to one operation out of three hundred, and the
word "password" appears in forty places that are not the one you want.

## The commands

```
zen rag schema <index|restore|ready|search|list|grep|trace|show|stats> [spec...]
```

| Command   | Answers                                | Embedder? | Typical          |
| --------- | -------------------------------------- | --------- | ---------------- |
| `index`   | builds the thing                       | yes       | minutes to hours |
| `restore` | _put the vectors back_                 | **yes**   | minutes to hours |
| `ready`   | _can this index answer at all?_        | no        | instant          |
| `search`  | _what is this API's way to do X?_      | **yes**   | seconds          |
| `list`    | _what methods/types/fields are there?_ | no        | instant          |
| `grep`    | _does the string X appear anywhere?_   | no        | instant          |
| `trace`   | _which call can reach this field?_     | no        | instant          |
| `show`    | _print exactly these things_           | no        | instant          |
| `stats`   | _what is in this index?_               | no        | instant          |

Only `search` ranks, and only `search` costs a network round trip - it embeds
the query before it can compare anything. The other five read `graph.json` off
the disk and answer in milliseconds, so reach for `search` when the question is
vague and for `list`/`grep`/`trace` when it is precise. If a search feels slow,
it is that one embedding call, not the index: near-zero CPU for several seconds
is the tell.

> **`search` takes bare words as the query, not as a subcommand.**
> `zen rag schema search list methods` does not list anything - it runs a
> semantic search for the phrase _"list methods"_ and returns ten ranked
> guesses. The listing command is `zen rag schema list methods`.

> **Never reach for shell `grep`, `rg`, `find`, `cat` or `jq` here.**
> Not on the specification, not on `graph.json`, not on anything under the
> index directory. `zen rag schema grep` and `zen rag schema list` are the
> exact-matching commands, they are local, they need no credential, and they
> answer in milliseconds. Shell tools on the same files are strictly worse:
> they match raw YAML/JSON lines rather than nodes, so they cannot tell a
> field from a `$ref` from a description, cannot say which operation a hit
> belongs to, cannot filter by kind or direction, and they miss every name
> the index normalised. A `grep -r password openapi.yaml` returns forty lines
> of text; `zen rag schema grep password` returns the nodes, with their ids,
> ready to hand back to `show`.

## Why it is a graph and not a search box

Two structures, kept together, because neither answers alone:

| Structure                            | Answers                            |
| ------------------------------------ | ---------------------------------- |
| A vector + full-text index (LanceDB) | _where is `password` in this API?_ |
| A graph (graphology)                 | _what is `password` connected to?_ |

Finding the field is retrieval. Getting from the field to `POST
/auth/reset-password` and the exact shape of its body is traversal. So a search
does both: it seeds on the vector hits, walks the graph outward from them, and
answers with **the connected piece of the API that matched** - the operations,
the schemas they carry and the fields inside them - rather than a ranked list of
fragments naming types nobody printed.

## What is in one

Three kinds of node, joined by the `$ref`s between them. Documents are
**bundled, not dereferenced**: `#/components/schemas/User` stays an edge and
`User` is a node id.

| Kind       | Id                           | Is                                |
| ---------- | ---------------------------- | --------------------------------- |
| `method`   | `Method:resetUserPassword`   | an operation                      |
| `type`     | `Type:ResetPasswordPayload`  | a schema                          |
| `property` | `Type:User.email` (a field)  | a field on a schema               |
| `property` | `Method:listUsers#page_size` | a query/path/header **parameter** |

A parameter is a property like any other, deliberately. Nobody should have to
know in advance whether `page_size` lives in a query string or a body - that is
the thing they came here to find out.

Every node carries a **direction** - `input`, `output` or `both` - propagated
from the operations down through composition, so a DTO used on both sides is
honestly both rather than whichever side was read last. That is what makes
"a field in a **response**" a filter and not a hope.

`discriminator` is kept: it is what turns a `oneOf` into a tagged union a
TypeScript compiler can narrow.

```
schema-db/
├── manifest.json     written LAST - its absence means "not indexed"
├── graph.json        topology, read whole
├── schemas.json      the raw schemas, read on first hydrate
├── operations.json   likewise
└── lance/            one row per node: one text column, one vector
```

`manifest.json` records **which embedder made the vectors**, so a search with a
different model is refused rather than answered with noise.

### What survives a clone

`lance/` is binary, large, and rebuildable, so a project commits the index and
git-ignores the vectors. What a fresh checkout holds is therefore an index that
**looks built and cannot answer**: the manifest is there, the graph is there,
and the first search fails with `holds no searchable table`.

```sh
zen rag schema ready --dir assets/schema-db      # exit 0 searchable, exit 3 not
zen rag schema restore --dir assets/schema-db    # re-embed from sources/
```

`ready` answers with its **exit code**, so a setup step branches on it without
parsing anything. `restore` rebuilds from the bundled copies in `sources/` and
renames the result into place, so a failure leaves the old index untouched -
which means an index built with `--no-sources` cannot be restored at all, and
says so. `--embedding <ref>` is how an index moves to another model: everything
is re-embedded and the manifest rewritten.

> **Never test for a built index with `[ -f .../manifest.json ]`.** The manifest
> is committed and the vectors are not, so that test is true on exactly the
> machine where it is wrong. `zen rag schema ready` is the test.

## Installing

`zen rag` ships in `@zenera/rag`, a sibling of the CLI. It has no binary of its
own - installing it adds the `rag` subcommand to `zen`, which is also where the
credentials already live.

```sh
npm i -g @zenera/cli @zenera/rag       # then: zen rag schema …
```

For a one-off, without installing anything, **both** packages must be in the
same temporary install or `zen` will report `rag` as not installed:

```sh
npx --package @zenera/cli --package @zenera/rag -- zen rag schema index openapi.yaml --embedding openai/text-embedding-3-small
```

Every example below is spelled `zen …`; prefix it with that `npx` form if you
have not installed globally.

## Building an index

```
zen rag schema index <spec...> [--embedding <ref>] [-o <dir>] [--batch <n>]
```

| Flag                | Default       | Meaning                                                                                        |
| ------------------- | ------------- | ---------------------------------------------------------------------------------------------- |
| `--embedding <ref>` | -             | Which embedder makes the vectors. Omit it to see the choices                                   |
| `-o`, `--out <dir>` | `./schema-db` | Where the index goes; `$ZEN_SCHEMA_DB` if that is set                                          |
| `--batch <n>`       | model's own   | Texts per embedding request. `gemini-embedding-*` takes 1                                      |
| `--no-sources`      | -             | Keep no copy of the documents; `show --source` rebuilds them, and `restore` becomes impossible |
| `--quiet`           | -             | No narration                                                                                   |

```sh
zen rag schema index openapi.yaml --embedding openai/text-embedding-3-small
zen rag schema index specs/*.yaml --embedding google/gemini-embedding-001 -o .index/api
```

Several documents can go into one index; they share a graph, which is usually
what you want when an API is split across files. Swagger 2.0 and OpenAPI
3.0/3.1, JSON or YAML, are all converted to JSON Schema 2020-12 on the way in.

This is the one command here that spends money and time: it embeds every
operation, schema and field. It prints a per-document table (paths, operations,
schemas, fields) and a progress line per batch, and **stdout is the output
directory and nothing else** - so `DIR=$(zen rag schema index …)` works.

The embedding reference names a provider first: `openai/text-embedding-3-small`,
not a bare model id. Credentials come from the `zen` keyring (`zen key ls`), and
a real environment variable always wins.

Rebuild the index when the specification changes. Nothing watches it, and a
stale index is a confident wrong answer.

## Which index gets read

Every reading command takes `-d`, `--dir`. Without one:

1. `$ZEN_SCHEMA_DB`, if it is set. **Set this once** instead of typing `-d` on
   every command - `export ZEN_SCHEMA_DB=/assets/schema-db`.
2. Otherwise the **nearest index** to the working directory: here, then a short
   way down into it, then up a level and again, stopping at your home
   directory. The one chosen is named on stderr as it is used, so an answer is
   never anonymous.
3. Otherwise `./schema-db`, which is only so the error names the directory you
   were expecting.

What is looked for is a `manifest.json` - an index is self-describing, so
nothing searches for a directory _called_ `schema-db` and one called anything
else is found the same way. `schema-db` is just the name a new one is given.

Two indexes the same distance away is refused rather than guessed at: the wrong
index does not fail, it answers confidently about a different API. Name one
with `-d`, or set `ZEN_SCHEMA_DB`.

## Searching it

```
zen rag schema search [terms…] [filters…]
```

### The field is the point

A query is not one string. It is a handful of **fields**, and the field a phrase
arrives in decides the filter it runs under - `--output-property "invoice total"`
means _kind=property, on the response side_, and none of that has to be said
twice.

| Term                    | Searches                                          |
| ----------------------- | ------------------------------------------------- |
| `<text>`                | Everything - the same as `--all`                  |
| `--all <q>`             | Everything, unfiltered                            |
| `--method <q>`          | Operations                                        |
| `--type <q>`            | Schemas, on the side `--direction` names          |
| `--input-type <q>`      | Schemas a call accepts                            |
| `--output-type <q>`     | Schemas a call returns                            |
| `--property <q>`        | Fields and parameters, per `--direction`          |
| `--input-property <q>`  | Fields, parameters and body fields a call accepts |
| `--output-property <q>` | Fields a call returns                             |
| `--query <json\|->`     | A whole query object; `-` reads stdin             |

Every term is repeatable. **`--all` is the weakest of them** - it cannot filter,
so put the intent where it belongs: a request field in `--input-property`, a
response field in `--output-property`, an action in `--method`.

### Shaping the answer

| Flag                        | Default     | Meaning                                                    |
| --------------------------- | ----------- | ---------------------------------------------------------- |
| `-d`, `--dir <dir>`         | found       | Which index - see "Which index gets read"                  |
| `--embedding <ref>`         | the index's | Must be the one the index was built with                   |
| `--direction <d>`           | `any`       | `input`, `output` or `any`                                 |
| `--method-type <t>`         | `any`       | `read_only` (GET/HEAD/OPTIONS) or `read_write`             |
| `--exclude-id <id>`         | -           | Drop a node. Repeatable                                    |
| `--exclude-method <name>`   | -           | Drop an operation by name. Repeatable                      |
| `--exclude-type <name>`     | -           | Drop a schema by name. Repeatable                          |
| `--exclude-property <name>` | -           | Drop a field by name. Repeatable                           |
| `--source <name>`           | every one   | Search only this document, as `stats` names it. Repeatable |
| `--limit <n>`               | `5`         | Seeds kept per term                                        |
| `--max-hops <n>`            | `3`         | How far apart two hits may be and still join               |
| `--max-nodes <n>`           | `200`       | Nodes per result                                           |
| `--format <f>`              | `text`      | `text`, `mermaid`, `mermaid-flowchart`, `ts`, `openapi`    |
| `--show-source`             | -           | Tag each operation and schema with its document            |
| `--no-docs`                 | -           | Leave the descriptions out                                 |
| `--interactive`             | -           | Prompt, search, refine. Needs a terminal                   |
| `--quiet`                   | -           | No narration                                               |

```sh
zen rag schema search --method "reset a user password" --format ts
zen rag schema search --output-property "invoice total" --direction output
zen rag schema search --input-property "page size" --method-type read_only
zen rag schema search --method "apply a tag" --source policy_api --show-source
```

When an index holds two revisions of one API, `--source` is what keeps the
answer inside the one you mean - the same words rank in both, so without it the
two have to be told apart by eye after the fact. It is repeatable, and the names
it takes are the ones `stats` prints; anything else is refused, and the refusal
lists what the index does hold.

`--format ts` emits TypeScript closed over its own `$ref`s: everything named is
also declared, so the output compiles on its own. `--format openapi` emits a
standalone document holding just the matched slice - the one to hand to a code
generator or a mock server. The Mermaid formats are for looking at.

### Turning one search into a session

The exclusions are the mechanism: pass back the ids you have already been shown
and you are shown something else instead of the same thing again.

```sh
zen rag schema search --all "subscription" --exclude-type Subscription --exclude-id Method:listSubscriptions
```

### As a machine interface

Non-interactive search is a tool, not an afterthought. Every field is a flag,
the whole query can arrive as one JSON object, `--json` is a stable shape, no
terminal is needed, and **an empty result exits 0** - a caller must never have
to tell "nothing matched" from "the index is missing" by parsing stderr.

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

The JSON field names are the flag names with underscores and plurals:
`all`, `methods`, `types`, `input_types`, `output_types`, `properties`,
`input_properties`, `output_properties`, `direction`, `method_type`,
`exclude_ids`, `exclude_methods`, `exclude_types`, `exclude_properties`,
`limit`, `max_hops`, `max_nodes`. An **unknown key is an error**, because a
silently ignored `output_propertys` looks exactly like a search that found
nothing. Flags win over `--query` when both name the same field.

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

## Reading it without searching

None of these need an embedder or a credential - they are plain reads of the
graph on disk.

```sh
zen rag schema show Type:Invoice Method:listInvoices --format ts
zen rag schema stats
```

`show` prints named nodes with no retrieval in between; `stats` says what is in
an index and what built it - counts by kind, the embedding model, the documents
it came from. `stats` is the fastest way to answer "is this index the one I
think it is?".

### Which one to reach for

| The question                                     | The command                              |
| ------------------------------------------------ | ---------------------------------------- |
| "how do I reset a password with this API?"       | `search --method "reset a password"`     |
| _anything you would have run `grep` for_         | `grep` / `list` - never the shell        |
| "which call can reach this field?"               | `trace <field>`                          |
| "what does the create-user request look like?"   | `search --input-type "create user"`      |
| "what operations exist under /users?"            | `list methods --path "*/users*"`         |
| "how many operations are there at all?"          | `list methods` (or `--json` for `found`) |
| "is there a field called `mfa_secret` anywhere?" | `grep mfa_secret`                        |
| "which schemas mention tenancy?"                 | `grep tenancy --kind type`               |
| "give me `GetUser` as OpenAPI"                   | `show --method GetUser --format openapi` |
| "is this index the right one?"                   | `stats`                                  |

The rule: **a question about meaning is a `search`; a question about presence,
count or spelling is a `list` or a `grep`; a question about reachability is a
`trace`.** Search cannot answer the last two, because a ranking always returns
its best guesses whether or not any of them are right.

### Exact matching, when the question is whether something exists

Search **ranks**. A ranking returns the top of a list, which means it can never
tell you that something is absent - "no results" and "not there" look the same.
When that is the actual question, do not search:

```
zen rag schema list <methods|types|properties> [-d <dir>] [filters…]
zen rag schema grep <pattern> [-d <dir>] [filters…]
```

| Flag                | For    | Meaning                                        |
| ------------------- | ------ | ---------------------------------------------- |
| `--name <p>`        | both   | Match the name. Repeatable                     |
| `--path <p>`        | both   | Match the route it sits on. Repeatable         |
| `--regex`           | both   | Read the patterns as regular expressions       |
| `--case-sensitive`  | both   | Stop ignoring case                             |
| `--source <name>`   | both   | Only one document, as `stats` names it         |
| `--show-source`     | both   | Print which document each row came from        |
| `--method-type <t>` | `list` | `read_only`, `read_write` or `any`             |
| `--direction <d>`   | `list` | `input`, `output` or `any`                     |
| `--kind <k>`        | `grep` | `method`, `type` or `property`. Repeatable     |
| `--ids-only`        | `grep` | Bare ids, one per line, for piping             |
| `--limit <n>`       | both   | Print at most n; `found` still counts them all |
| `--json`            | both   | `{found, truncated, rows}` / `…, matches}`     |
| `--quiet`           | both   | No narration                                   |

```sh
zen rag schema list methods                      # all of them, sorted by route
zen rag schema list methods --path "*/users*"    # every route under /users
zen rag schema list methods --method-type read_only
zen rag schema list types --name "*Password*"    # every schema so named
zen rag schema list types --direction output     # everything a call can return
zen rag schema list properties --name password   # every field so named
zen rag schema grep password                     # every literal occurrence
zen rag schema grep "pass(word|phrase)" --regex
zen rag schema grep password --kind type --ids-only
zen rag schema grep status --path "/invoices/*"   # the word, in one corner
```

`list` walks one kind of node and matches its structured fields; `grep` matches
the text of every node in the index - the same text the search was built from,
so the two agree on what the API says. A pattern with `*` or `?` is a glob
matched against the whole string; a plain word is a substring, so `--name
password` finds `ResetPasswordPayload` and `--name "Password*"` finds nothing.

**`--regex` is the only way to say "one of these"** - a glob has no alternation.
On `list` it turns every pattern into a regular expression. On `grep` it turns
the **pattern** into one; `--name` and `--path` stay globs-or-substrings there,
because they are always names:

```sh
zen rag schema list methods --regex --path "^/(users|teams)/"
zen rag schema list types --regex --name "(Request|Response)$"
zen rag schema grep "pass(word|phrase)" --regex --path "*/users*"
```

`--name` and `--path` are constraints on `grep` as well, which is what makes a
common word usable: `grep status` across a whole API is unreadable,
`grep status --path "/invoices/*" --kind property` is an answer. On `list
properties` and on `grep`, `--path` matches the route a parameter's operation
sits on; a schema belongs to no one route, so `--path` never selects one.

When an index holds several documents, `--show-source` puts
`[source: billing_api_v2]` on every row, so which document answered does not
have to be recovered from `--json`.

Both report `found` as the true total even when `--limit` shortens what is
printed, so a cut answer never misreports how much there is. Nothing matching
exits 0 with empty stdout - and that emptiness is trustworthy, which is the
whole point of them.

`grep --ids-only` composes:

```sh
zen rag schema grep token --ids-only | xargs zen rag schema show --format ts
```

### Upwards, from a field to the calls that carry it

Finding the field is half the job. The other half - which operation can
actually reach it - is a walk up the `$ref`s.

`search` does part of it: it stitches its seeds into one connected piece and
prints what each operation accepts and returns, so a lucky search does show the
call. But it joins only what **ranked**, only within `--max-hops` (3 by
default), and it never names the chain - and the call almost never repeats the
word, so `GET /users/{userId}` and `city` have nothing in common except the
edges between them. `trace` follows those edges instead of guessing at them:
exhaustive, and certain.

```
zen rag schema trace <pattern|id...> [-d <dir>] [filters…]
```

```sh
zen rag schema trace city
```

```
Property:Address.city
    GET /users/{userId}  getUser  output  PublicUserProfile.address → Address.city
```

One command instead of three lookups and a guess: find the field, find what
holds `Address`, find what accepts _that_, and hope you followed every branch.
The last column is the whole route, so the shape of the call can be read off
the answer.

| Flag              | Default            | Meaning                                              |
| ----------------- | ------------------ | ---------------------------------------------------- |
| `--kind <k>`      | types + properties | `method`, `type` or `property`. Repeatable           |
| `--direction <d>` | `any`              | Only the calls that accept it, or that return it     |
| `--max-hops <n>`  | `8`                | How far up to walk                                   |
| `--limit <n>`     | -                  | Trace at most n matching nodes                       |
| `--routes <n>`    | -                  | Operations printed per node; `found` counts them all |
| `--ids-only`      | -                  | Bare operation ids, one per line, for piping         |
| `--regex`         | -                  | Read the pattern as a regex; `--case-sensitive` too  |
| `--source <name>` | -                  | Only nodes from one document                         |
| `--show-source`   | -                  | Print which document each operation came from        |

A bare word matches the way `list --name` does - a substring, or a glob when it
has `*` or `?`. A node id (`Type:User`) is taken as that node rather than as a
pattern. Operations are left out of a name match on purpose: they are where a
trace ends, not where one starts.

```sh
zen rag schema trace password --direction input
zen rag schema trace "*Settings" --kind type
zen rag schema trace mfa_secret --ids-only | xargs zen rag schema show --format openapi
```

`no operation reaches it` is a real answer, and one worth having: the schema is
unreachable in this document, so no request will ever carry it.

### Instead of the shell

Every reflex that reaches for a shell tool has a command here that answers the
same question better. Add `-d <dir>` when the index is not the nearest one, or
name it once with `ZEN_SCHEMA_DB`.

| The reflex                              | The command                                           |
| --------------------------------------- | ----------------------------------------------------- |
| `grep -ri password spec.yaml`           | `zen rag schema grep password`                        |
| `grep -r password` \| _only in schemas_ | `zen rag schema grep password --kind type`            |
| `grep -E "pass(word\|phrase)"`          | `zen rag schema grep "pass(word\|phrase)" --regex`    |
| `grep password` (case matters)          | `zen rag schema grep password --case-sensitive`       |
| `grep -c` / `wc -l`                     | `--json`, and read `found` - it counts past `--limit` |
| `grep -l` / `grep -o` for piping        | `zen rag schema grep password --ids-only`             |
| `grep "/users" spec.yaml`               | `zen rag schema list methods --path "*/users*"`       |
| `grep -i "updateuser"`                  | `zen rag schema list methods --name "*Update*"`       |
| `grep "UserSettings"`                   | `zen rag schema list types --name "*UserSettings*"`   |
| `grep -A5 password` for the field       | `zen rag schema list properties --name "*password*"`  |
| `grep -rl password specs/` (which one?) | `zen rag schema grep password --show-source`          |
| `cat`/`yq` a schema out of the document | `zen rag schema show --type UserSettings --format ts` |
| `ls` the index directory                | `zen rag schema stats`                                |

```sh
export ZEN_SCHEMA_DB=/assets/schema-db   # once, then never again
zen rag schema grep "password" --limit 10
zen rag schema list methods --path "*user*"
zen rag schema list types --name "*UserSettings*"
zen rag schema list properties --name "*password*" --show-source
```

If none of these fits the question, the question is about meaning, and the
answer is `search` - still not the shell.

### Naming what you want in `show`

```sh
zen rag schema show --method GetCurrentUserInfo --format openapi --exact
zen rag schema show --type "*Invoice*" --format ts
zen rag schema show --source billing-api --format openapi
zen rag schema show --type "*Invoice*" --show-source
```

Ids are one way in, but `--method` and `--type` take the names you already
have. A bare name means exactly that name; add `*` to take more than one.
`--show-source` names the document each node came from, which is the quick way
to tell two versions of the same API apart. `--exact` prints only what was
named instead of the neighbourhood around it, which with `--format openapi`
gives a valid self-contained slice of the specification - enough to generate a
client or a mock payload from.

## Giving it to an agent

The same engine, as six tools in the group `schema`. An agent takes them all
with `schema:*` in its `tools:`.

```ts
import { createEmbedder, loadProject } from '@zenera/neo';
import { SchemaIndex, schemaTools } from '@zenera/rag';

const index = await SchemaIndex.open(
    './schema-db',
    createEmbedder('openai/text-embedding-3-small'),
);
const project = await loadProject('./my-project', { tools: schemaTools(index) });
```

| Tool                       | For                                                                 |
| -------------------------- | ------------------------------------------------------------------- |
| `search_api`               | the search above, with the same fields                              |
| `describe_types`           | named schemas as TypeScript, closed over what they refer to         |
| `find_types_with_property` | every schema with a field of this name - exact lookup, no searching |
| `list_api`                 | methods, types or fields by name - complete, and counted in full    |
| `grep_api`                 | every literal occurrence of a string - the way to prove absence     |
| `trace_api`                | up from a field or schema to the operations that carry it           |

Only `search_api` ranks; the other five are exact. `find_types_with_property`
is the one for the repair loop. When `tsc` says `'password' does not exist in
type 'PublicUserProfile'`, the model does not need the word explained again -
it needs the list of types that _do_ have one, and embedding the word will only
rank the guess it already made near the top. `grep_api` is the same instinct
widened: it is how a model checks that a search returning nothing really means
there is nothing. `trace_api` is the step after either of them: a field is of
no use until the call that carries it is known, and no ranking will find that
call - the operation and the field share no words, only edges.

`list_api` and `grep_api` take `name`, `path`, `regex` and `source`, so a
common word can be narrowed to one route or one document rather than read out
in full. When an index holds more than one document, both tools name the source
of every row without being asked - with two versions of the same API indexed
together, which one answered is part of the answer.

Tell the agent in its prompt to search before it writes a call, and to put the
intent in the narrow field. A model left to itself puts everything in `all`.

## Wiring it into a project means writing the project a skill

**Whenever an index is used by a Zenera project - as `schema:*` tools, or as
`zen rag` reachable from the agent's sandbox - write a skill for it in that
project.** Not optional, and not the same thing as passing the tools in.

Wiring alone leaves the model to infer everything that matters. A tool
description says what `grep_api` does; it cannot say that this index holds the
ACME policy API, that names are `snake_case`, that every route is under
`/api/v1/policy`, or that `list_api` is the right first move here because the
API has three hundred operations and search will hand back five. That is
project knowledge, and project knowledge belongs in a skill - where it is
loaded only when the model is actually working on this API, instead of sitting
in the system prompt of every run.

```
<project>/agents/skills/<api>-api/SKILL.md
```

Frontmatter is `name` and `description`; the description is what the model
reads when choosing, so it must name the API and the questions it answers.
Add `tools: [search_api, list_api, grep_api, trace_api, describe_types,
find_types_with_property]` if the skill should be what unlocks them.

### What the skill has to say

| Section         | Because                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------ |
| Which API       | The name, the version, and the document it was built from                                                          |
| Where the index | `ZEN_SCHEMA_DB`, or the `-d` to pass - an agent cannot guess a path                                                |
| Which command   | Meaning → `search`; presence, spelling or a count → `list`/`grep`; which endpoint carries a field → `trace`        |
| Never the shell | State it outright. `grep`/`rg`/`jq` on the spec is the default reflex                                              |
| The conventions | Auth, base path, pagination, casing, error envelope - none of it is in the graph                                   |
| Worked examples | Two or three, with **real operation and schema names from this index**                                             |
| The repair loop | Compiler said the field is not on the type → `find_types_with_property`, then `trace` for the call that carries it |

Best practice, in order of how often it is got wrong:

1. **Use real names.** `list_api types --name "*Policy*"` with output the model
   will actually see beats a generic `<TypeName>` placeholder, because the
   names are the anchors it steers by.
2. **Say which command answers which question**, and say that a ranking cannot
   prove absence. Left alone a model searches for everything, gets five ranked
   guesses, and writes a call against the best of them.
3. **Keep it short.** A skill is prompt. One screen of routing rules and
   conventions beats a transcription of this document - link to `zen rag
schema --help` for the flags.
4. **Re-index, then re-read the skill.** Both go stale against the same
   change, and a skill quoting operations that no longer exist is worse than
   none.
5. **One skill per API**, named after it. Two APIs in one skill and the model
   mixes their conventions.

```md
---
name: billing-api
description: How to find the right call in the Acme Billing API (v2) - which schema
    carries which field, and which endpoint accepts it. Use before writing any request.
---

# The Billing API

Indexed at `/assets/schema-db` (already in `$ZEN_SCHEMA_DB`). 214 operations,
all under `/v2`. Bearer token in `Authorization`; cursors, never page numbers.

- Vague question ("how do I cancel a subscription?") → `search_api`, intent in
  the narrowest field: `methods`, not `all`.
- Does X exist, how is it spelled, how many are there → `list_api` / `grep_api`.
  These are complete; a search is not, and cannot prove absence.
- Which endpoint carries this field → `trace_api`. Never guess the owner.
- Never `grep`/`rg`/`jq` the spec - the tools above are local and exact.

Worked: the invoice total is `Invoice.amount_due` (minor units), returned by
`GetInvoice` and `ListInvoices`; `trace_api of: amount_due` shows both.
```

## When it goes wrong

| Symptom                                          | Cause                                                                                                          |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| "not installed"                                  | `@zenera/rag` is not resolvable - install it, or use the two-`--package` npx form                              |
| Refused for a different embedding                | The index records the model that built it; pass the right `--embedding`, or move it with `restore --embedding` |
| No manifest / not an index                       | A build that did not finish. `manifest.json` is written last on purpose                                        |
| `holds no searchable table`                      | A manifest with no vectors - a clone, since `lance/` is git-ignored. `restore` it                              |
| A step reported `skipped` but nothing can search | The step tested for `manifest.json` instead of asking `ready`                                                  |
| `provider "openai": no api key`                  | `zen key ls` - the keyring, or a real environment variable                                                     |
| A usage error before any credential is asked for | Deliberate: everything about the invocation is checked first, so a typo is a typo                              |
| Nothing matched                                  | Exit 0 with an empty answer. Try fewer words, or `--all` instead of a narrow field                             |
| Answers about the wrong version of the API       | Nothing watches the document. Re-index after it changes                                                        |
| A search took ten seconds, using no CPU          | One embedding round trip, not the index. `list`/`grep` make none                                               |
| `search <word> <word>` gave ranked nonsense      | Bare words after `search` are the QUERY, not a subcommand. You meant `list`/`grep`                             |
