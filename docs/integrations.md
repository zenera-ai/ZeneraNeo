# Giving agents an integration

An agent that has to call somebody else's API has a context-window problem
before it has an engineering one: a real OpenAPI document is megabytes, and the
part that answers the question is a few hundred lines. `zen rag schema` indexes
one as a **graph** - operations, schemas, properties, and the edges between
them - so the answer to "which call cancels a subscription, and what does it
take" is a connected slice rather than the top of a ranking.

For prose documentation see [knowledge.md](knowledge.md). The two are separate
subjects with separate index formats, and an index says which it is, so pointing
one at the other is an error rather than a confident answer about the wrong
corpus.

```sh
npm i -g @zenera/cli @zenera/rag
```

## Build the index

```sh
zen rag schema index ./assets/openapi.yaml \
    --embedding openai/text-embedding-3-small -o assets/schema-db
```

Several documents can go into one index; each entity remembers which document it
came from, and `--source` narrows to one. The documents themselves are bundled
into the index unless you pass `--no-sources`, so it can be moved or mounted
whole and still answer.

Resolution is the same as for a document index: `--dir`, then `$ZEN_SCHEMA_DB`,
then the nearest index at or above the working directory, then `./schema-db`.
The convention is `assets/schema-db`, which the sandbox sees read-only at
`/assets/schema-db`.

## Ask it something

```sh
zen rag schema search "cancel a subscription and refund the remainder"
zen rag schema search --method "list invoices" --output-property amount_due
```

The search terms are separate flags because the questions are different
questions: `--method` is about operations, `--type` about schemas,
`--property` about fields and parameters, and `--input-*` / `--output-*` say
which side of a call you mean. A bare phrase is `--all`.

| Flag            | For                                                        |
| --------------- | ---------------------------------------------------------- |
| `--direction`   | `input`, `output` or `any`                                 |
| `--method-type` | `read_only`, `read_write` or `any` - the safety filter     |
| `--max-hops`    | how far apart two hits may be and still count as connected |
| `--format`      | `text`, `mermaid`, `mermaid-flowchart`, `ts`, `openapi`    |
| `--source`      | only this document                                         |

`--format ts` is the one to reach for when the answer is going into code: the
slice comes back as TypeScript interfaces, which is a shape a model writes
against without inventing a field.

And, as always, the exact half - no embedder, no credential, no ranking:

```sh
zen rag schema list methods --path "^/v1/(subscriptions|invoices)/" --regex
zen rag schema grep password --kind property
zen rag schema trace tenant_id --direction input   # up from a field to the calls that carry it
zen rag schema show Type:Subscription
```

`trace` has no equivalent in the document world and is the reason the graph is a
graph: given a field, it walks up to the operations that accept or return it.
"Which endpoints expose this?" is a question about edges, and a ranking cannot
answer it.

Run `zen rag schema --help` for the full flag list.

## Wiring it into a project

The same two ways in as a document index.

**From the sandbox**, which is what a `zen` project uses - the scaffolded image
has `zen` and `@zenera/rag`, and model credentials are forwarded, so:

```
run_command  zen rag schema search --method "cancel subscription" --format ts
```

Name the index in `sandbox/Dockerfile`, not in `sandbox: env:` - that key
forwards the host's value, which would be a host path:

```dockerfile
ENV ZEN_SCHEMA_DB=/assets/schema-db
```

**As tools**, which is what the library uses - six tools in the group `schema`,
taken all at once with `schema:*`:

```ts
import { createEmbedder, loadProject } from '@zenera/neo';
import { SchemaIndex, schemaTools } from '@zenera/rag';

const index = await SchemaIndex.open(
    './assets/schema-db',
    createEmbedder('openai/text-embedding-3-small'),
);
const project = await loadProject('./my-project', { tools: schemaTools(index) });
```

| Tool                       | For                                                   |
| -------------------------- | ----------------------------------------------------- |
| `search_api`               | the connected piece of the API that matches an intent |
| `describe_types`           | named schemas in full                                 |
| `find_types_with_property` | every schema carrying a field                         |
| `list_api`                 | operations, schemas or properties by pattern          |
| `grep_api`                 | every literal match, counted in full                  |
| `trace_api`                | up from a field to the operations that carry it       |

Only `search_api` ranks; the other five are exact.

**And write the project a skill.** An index wired in without one leaves the
model to infer what a tool description cannot say: which API this is, which
version, that ids are opaque strings and not integers, that every write needs an
idempotency key, which endpoints are deprecated. That is project knowledge and
it belongs in `agents/skills/<api>-api/SKILL.md`, loaded when the model is
working against this API rather than sitting in every prompt.

## Working against it before it exists

`zen gym` serves the same OpenAPI document as a working mock - a stateful one:
what a list returns, a get returns; what a POST writes, the next GET reads. Give
it a story of the world behind the API and reference documents, and the data
follows them.

```sh
zen gym serve ./assets/openapi.yaml --story world.md --docs ./kb --port 8787
```

That closes the loop: index the specification so the agent knows what to call,
serve the specification so it can call it, and neither half needs the real
system to exist yet. See
[`packages/gym`](../packages/gym/README.md).

## Keep it built

Indexing is a setup step. It goes in `scripts/`, named in the `STEPS` list of
`scripts/_setup.sh`, exiting 3 when the index is already there and building into
`.tmp/` before moving it into place - see
[specification.md](specification.md#setup-steps-are-scripts) and the worked
example in [knowledge.md](knowledge.md#keep-it-built).

"Already there" means `zen rag schema ready` exits 0, not that a manifest is on
disk: the index is committed and its `lance/` vectors are not, so a clone needs
`zen rag schema restore` rather than a full re-index. `scripts/_setup.sh --check`
asks that question for every step and does none of the work, which is how a
fresh clone finds out before a search does.

Rebuild when the API description changes. Nothing watches it, and a stale index
answers about the API as it used to be.

## Further

- Your editor has a `zen-rag-schema` skill installed by `zen init`, with the
  full command surface, the node id shapes and the failure modes.
- [`packages/rag`](../packages/rag/README.md) - the package, and its library API
- [agents-yaml.md](agents-yaml.md) - the `assets:` and `sandbox:` reference
