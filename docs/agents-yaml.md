# `agents.yaml` reference

The one file a project must have. It says who exists, what they may reach for,
and which model answers for them.

The schema is **strict**: an unknown key is an error, not a value silently
ignored. Failures are reported as `agents.yaml: agents[1].skills.discovery - …`,
naming the path rather than dumping a JSON blob.

Everything below is also a JSON Schema, which `zen init` and `zen open` write to
`.vscode/agents.schema.json` and point the editor at - so with the
`redhat.vscode-yaml` extension installed, a key is completed, documented on
hover and underlined when it is wrong as it is typed. It is an editor aid; the
loader is the authority, and `zen check` is how to ask it.

See [projects.md](projects.md) for the folder around this file.

## Skeleton

```yaml
version: 1
default: intake

providers: {} # named connections
provider: openai # which provider a bare model id belongs to
models: {} # named model configurations
model: fast # fallback for agents that do not pin their own
embeddings: {} # named vectorisers
embedding: main # the one `embedder()` hands back when asked for none
skills: agents/skills # one directory, or a list
assets: assets # reference material, read-only at /assets
memory: {} # the shared graph agents remember into
sandbox: {} # the container shell commands run in

agents:
    - name: intake
      # ...
```

Only `agents:` is required, and it must hold at least one entry.

## Names

`agents[].name`, and the keys of `providers:` and `models:`, must match:

```
^[a-z0-9]+(?:[-_][a-z0-9]+)*$
```

Lower-case words joined by `-` or `_`: `intake`, `order-triage`, `house_style`.
The restriction exists because these names reach the model as part of
`transfer_to_<name>` and reach the file system as skill directory names, and
they should be unambiguous in both.

## Top-level keys

| Key          | Type                    | Meaning                                                    |
| ------------ | ----------------------- | ---------------------------------------------------------- |
| `version`    | `1`                     | Schema version. Defaults to `1`                            |
| `default`    | name                    | Entry agent. Wins over any `default: true`                 |
| `providers`  | map of name → provider  | Named connections                                          |
| `provider`   | name                    | The provider a bare model id belongs to (otherwise openai) |
| `models`     | map of name → model     | Named model configurations                                 |
| `model`      | model ref               | Fallback for agents that do not pin their own              |
| `embeddings` | map of name → embedding | Named vectorisers                                          |
| `embedding`  | embedding ref           | The one `embedder()` returns when asked for none           |
| `skills`     | string or string[]      | Skill directories, merged into one catalog                 |
| `assets`     | string                  | Reference material, mounted read-only at `/assets`         |
| `memory`     | memory                  | Where the shared memory graph lives, and how it is indexed |
| `sandbox`    | sandbox                 | The container `run_command` and friends execute in         |
| `agents`     | agent[]                 | At least one                                               |

---

## `providers:`

A provider is a **connection**, not a model: where requests go, and what
credentials sign them. Splitting it out is what lets one project hold two keys
for the same vendor - the key is declared once, under a name, and models point
at the name. One client is built per name and shared, so five agents on one key
open one connection pool.

```yaml
providers:
    openai-eu:
        baseURL: https://eu.api.openai.com/v1
        apiKey: ${OPENAI_API_KEY_EU}
    gemini:
        kind: google
        apiKey: ${GEMINI_API_KEY}
    vertex-eu:
        kind: vertex
        project: ${GOOGLE_CLOUD_PROJECT}
        location: europe-west4
    claude:
        kind: anthropic
        apiKey: ${ANTHROPIC_API_KEY}
```

### Fields

| Field         | Meaning                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------ |
| `kind`        | `openai` \| `google` \| `vertex` \| `anthropic` \| `openrouter` \| `openai-compatible`. Defaults to `openai` |
| `apiKey`      | Literal key or `${VAR}`. Wins over any env lookup                                                            |
| `apiKeyEnv`   | Env var holding the key; defaults to the kind's conventional name                                            |
| `baseURL`     | Literal url or `${VAR}`, for gateways and compatible endpoints                                               |
| `baseURLEnv`  | Env var holding the base url                                                                                 |
| `project`     | **vertex only** - GCP project id                                                                             |
| `location`    | **vertex only** - a region, or `global`                                                                      |
| `headers`     | Sent on every request: gateway routing, attribution, api versions                                            |
| `timeoutMs`   | Per-request timeout                                                                                          |
| `maxRetries`  | Retry count; defaults to `4`, `0` disables                                                                   |
| `concurrency` | Ceiling on **embedding** requests in flight on this connection                                               |

### Retries

Every kind retries the same way, whichever SDK is behind it: up to `maxRetries`
extra attempts on a rate limit (`429`), a request timeout (`408`) or a `5xx`,
waiting 1s, then 2s, 4s, 8s - doubling up to a minute - and honouring a
`Retry-After` header when the provider sends one. A 429 is the provider asking
to be called again shortly, so it costs a few seconds rather than the run.

Retrying happens at the transport, below the adapter, so a retried call is one
that never started: no partial stream is replayed and nothing reaches the
trajectory twice. Set `maxRetries: 0` to fail fast instead.

Embeddings are the exception, and deliberately: they retry one layer up, in the
adapter, because a batch is thousands of requests and a 429 the transport
swallows is one nothing can learn from. See [Embeddings](#embeddings).

### Kinds and their defaults

| Kind                | Protocol / SDK      | Key env              | Base url env          | APIs                |
| ------------------- | ------------------- | -------------------- | --------------------- | ------------------- |
| `openai`            | OpenAI              | `OPENAI_API_KEY`     | `OPENAI_BASE_URL`     | `chat`, `responses` |
| `openai-compatible` | OpenAI              | `OPENAI_API_KEY`     | `OPENAI_BASE_URL`     | `chat`, `responses` |
| `openrouter`        | `@openrouter/sdk`   | `OPENROUTER_API_KEY` | `OPENROUTER_BASE_URL` | one                 |
| `google`            | `@google/genai`     | `GEMINI_API_KEY`     | `GEMINI_BASE_URL`     | one                 |
| `vertex`            | `@google/genai`     | `VERTEX_API_KEY`     | `VERTEX_BASE_URL`     | one                 |
| `anthropic`         | `@anthropic-ai/sdk` | `ANTHROPIC_API_KEY`  | `ANTHROPIC_BASE_URL`  | one                 |

`openrouter` defaults its base url to `https://openrouter.ai/api/v1`, so a
provider entry needs nothing but the kind. Model ids carry the vendor prefix
(`anthropic/claude-sonnet-4.5`), which the shorthand handles because only the
first colon separates: `openrouter:anthropic/claude-sonnet-4.5`.

`kind` selects a _protocol_, which picks the SDK and the adapter. Only the
OpenAI protocol speaks more than one API, so naming `api:` on a Gemini or Claude
model is an error rather than a field to ignore.

Each vendor's own SDK is used rather than its OpenAI-compatible endpoint,
because those endpoints are porting aids and drop exactly what this runtime is
built on: Google's loses thinking budgets, thought signatures and cached-content
accounting; Anthropic's loses cache accounting and extended thinking.
`openai-compatible` is the shim kind - vLLM, a self-hosted gateway - where the
OpenAI client is exactly right. `openrouter` used to be that shim with its base
url and key env filled in; it now has its own SDK, for the same reason as the
others - provider routing, fallback chains and per-call cost have nowhere to go
in a chat-completions request.

### OpenRouter

OpenRouter is a gateway: one key and one endpoint in front of several hundred
models from every vendor. `kind: openrouter` speaks a protocol of its own,
through `@openrouter/sdk`, which is what makes the routing controls below
available. Pointing `openai-compatible` at the same base url is still
supported, and gives the older chat-completions client with none of them.

The whole declaration is therefore the kind:

```yaml
providers:
    openrouter:
        kind: openrouter

agents:
    - name: triage
      model: openrouter:anthropic/claude-sonnet-4.5
```

`baseURL` defaults to `https://openrouter.ai/api/v1` and the key is read from
`OPENROUTER_API_KEY`. Since the built-in kinds are usable as provider names, the
`providers:` block above says nothing the default does not and can be deleted
outright.

#### Model ids

Ids are `vendor/model`, and may carry a **variant suffix** after a colon -
`:free`, `:nitro` (throughput-routed), `:floor` (price-routed), `:online` (web
search). Both survive the shorthand, because only the _first_ colon separates:

| Ref                              | Provider     | Model                 |
| -------------------------------- | ------------ | --------------------- |
| `openrouter:openai/gpt-5.4-nano` | `openrouter` | `openai/gpt-5.4-nano` |
| `openrouter:z-ai/glm-5.2:free`   | `openrouter` | `z-ai/glm-5.2:free`   |
| `openrouter:x-ai/grok-4:nitro`   | `openrouter` | `x-ai/grok-4:nitro`   |

A slash in the id is not ambiguous either: the slash that splits `provider/api`
is only read inside the prefix, before the first colon.

#### No api to choose

This kind speaks one protocol, its own, so `api:` names nothing:

```
provider "openrouter" (openrouter) has one api, so "responses" means nothing here
```

That is raised when the model is _built_, not when the ref is parsed - so it
surfaces from `zen check` rather than at the first request.
The same error covers the shorthand form, `openrouter/responses:…`.

Reasoning arrives on the message as `reasoning`, which the adapter reads into
`thinking` deltas. Both `reasoningEffort` and `reasoningSummary` are forwarded.

#### Attribution

OpenRouter credits apps by two headers, and `headers:` already carries anything
that belongs on every request - there is no dedicated field, and does not need
to be one:

```yaml
providers:
    openrouter:
        kind: openrouter
        headers:
            HTTP-Referer: https://example.com
            X-Title: My Agent
```

#### Routing and fallbacks

The two knobs the SDK exists for. `routing` says which upstream providers may
serve the request; `fallbacks` says which _models_ to try when none of them
can:

```yaml
models:
    routed:
        provider: openrouter
        model: openai/gpt-5.4-nano
        routing:
            order: [azure, openai]
            requireParameters: true
            sort: throughput
        fallbacks:
            - anthropic/claude-sonnet-4.5
            - google/gemini-3.5-flash
```

`routing` is OpenRouter's `provider` field, renamed because `provider:` already
means the connection here; `fallbacks` is its `models` field, named for which
of the two lists it is. It belongs to a model rather than to a `providers:`
entry - the choice is made per request, and the provider schema is strict, so
writing it there is a load error.

| Key                 | Value                                                                        |
| ------------------- | ---------------------------------------------------------------------------- |
| `order`             | Providers to try first - a _preference_, not a restriction                   |
| `only` / `ignore`   | Restrict serving to, or away from, these                                     |
| `allowFallbacks`    | May OpenRouter go beyond `order` - on unless set `false`                     |
| `sort`              | `price`, `throughput`, `latency`, `exacto`                                   |
| `requireParameters` | Skip a provider that would drop a parameter rather than serve it             |
| `dataCollection`    | `allow` \| `deny`                                                            |
| `quantizations`     | `int4` `int8` `fp4` `mxfp4` `nvfp4` `fp6` `fp8` `mxfp8` `fp16` `bf16` `fp32` |
| `zdr`               | Zero-data-retention endpoints only                                           |

`serviceTier` (`auto`, `default`, `fast`, `flex`, `priority`, `scale`) is
accepted alongside `routing`, not inside it.

`requireParameters: true` is worth knowing: without it a provider that does not
support a parameter may serve the request having quietly dropped it.

Provider names and `sort` are plain strings here, so a typo in `order` is not
rejected locally - and because `allowFallbacks` is on by default, it is not
rejected remotely either: the unknown name is skipped and something else serves
the request. Values the gateway does check, it checks at request time rather
than at load, naming the field:

```
400 provider.sort: Invalid input
400 provider.quantizations.0: Invalid option: expected one of "int4"|"int8"|…
```

Use `only`, or `allowFallbacks: false`, when the constraint is meant to bind.
An unroutable request is then a 404 instead of a quiet reroute.

#### What is not modelled yet

`plugins` (web search, file parsing, moderation) is typed on `ModelSpec` for
code that builds a spec directly, but has no schema entry, so it cannot be
written in yaml. `models:` entries are `.strict()`, so an unknown key is a load
error rather than a silently ignored one.

Four fields of the SDK's `provider` object have no `routing` spelling either:
`maxPrice`, `preferredMaxLatency`, `preferredMinThroughput` and
`enforceDistillableText`. `sort` takes the string form only, not the
`{ by, partition }` object the SDK also accepts.

Per-call **cost** is returned by this SDK and is not yet surfaced: `TokenUsage`
counts tokens only.

On the connection, `maxRetries` is honoured as a time budget rather than a
count. This SDK takes a retry _strategy_, so the count is converted into the
wall-clock window the same schedule would spend; `0` still disables retries.
`timeoutMs` and `headers` behave as they do everywhere else.

`reasoningEffort` **is** forwarded, as `reasoning.effort`. The gateway maps it
onto whatever the destination model understands: for OpenAI models it passes
through, and for others it becomes a fraction of the thinking budget. Whether a
given model accepts it at all is listed as `reasoning_effort` in its
`supported_parameters`.

#### Check capabilities before pinning an id

A gateway routes to whatever provider serves that model, so a request can fail
on a capability rather than on the model existing:

```
404 No endpoints found that support image input
```

The catalog is public and needs no key, which makes this cheap to check up
front:

```bash
curl -s https://openrouter.ai/api/v1/models | jq -r '
  .data[] | select(.id == "z-ai/glm-5.2:free")
  | "modalities: \(.architecture.input_modalities | join("+"))",
    "params:     \(.supported_parameters | join(","))"'
```

`input_modalities` decides whether images may be sent at all;
`supported_parameters` decides whether `tools`, `tool_choice` and
`reasoning_effort` are honoured. An agent with tools needs `tools` in that list.

#### Keys

```bash
zen key add openrouter
```

The keyring stores it under `OPENROUTER_API_KEY` and materialises it into the
environment before a project loads, so `${OPENROUTER_API_KEY}` in a config keeps
working either way.

`zen key check` authenticates against `/api/v1/key` rather than listing models,
because the model catalog answers `200` to a request carrying no key at all -
listing it would report every credential live, including a revoked one.

### Built-in names

`openai`, `google`, `vertex`, `anthropic`, `openrouter` and `openai-compatible`
are usable as provider _names_ with no declaration at all. A `providers:` entry
is only needed when it says something the default does not - a second key, a
region, a base url. A project can have no `providers:` block and still name
`vertex`.

`vertex` is the one kind that needs no key: the GenAI SDK resolves and refreshes
Application Default Credentials itself. It needs a project id, taken from
`project:`, then `GOOGLE_CLOUD_PROJECT`, then the `project_id` inside the
service-account key file named by `GOOGLE_APPLICATION_CREDENTIALS`.

It also accepts an **express-mode** api key, in `apiKey:` or `VERTEX_API_KEY`,
and that is an alternative rather than an addition. Express mode addresses no
project, so a key and a project cannot both be sent: naming both would build a
project-scoped url and then authenticate it with the key header, which the
service refuses with a `403` that mentions neither. A key given here therefore
wins outright, and `project:` and `location:` are ignored alongside it.

```yaml
providers:
    vertex-express:
        kind: vertex
        apiKey: ${VERTEX_API_KEY} # no project, no location

    vertex-eu:
        kind: vertex
        project: acme-prod # a service account, and a region to call
        location: europe-west4
```

### Environment references

`${VAR}` reads the environment; `${VAR:-fallback}` supplies a default. It
composes inside a longer value - `https://${GATEWAY}/v1` - which a whole-value
token could not, and no literal secret contains `${`, so there is no rule to
remember about which strings are magic.

Expansion is **lazy**: nothing is read until an agent actually reaches for that
provider. A repository may therefore declare a vendor a given deployment has no
key for, and still load.

### Gateway mode (Bifrost)

Setting `BIFROST_BASE_URL` sends **every** provider through a
[Bifrost](https://github.com/maximhq/bifrost) gateway, with `BIFROST_API_KEY` as
the one credential. Nothing in this file changes: each model keeps its own
vendor's SDK and wire format, and is pointed at the gateway's matching drop-in
endpoint instead of at the vendor.

| Kind                             | Endpoint     | Model id on the wire |
| -------------------------------- | ------------ | -------------------- |
| `openai`, `openai-compatible`    | `/openai`    | `openai/<id>`        |
| `anthropic`                      | `/anthropic` | `anthropic/<id>`     |
| `google`                         | `/genai`     | `gemini/<id>`        |
| `vertex` (Gemini)                | `/genai`     | `vertex/<id>`        |
| `vertex` (Claude, `anthropic/…`) | `/anthropic` | `vertex/claude-…`    |
| `openrouter`                     | `/openai`    | `openrouter/<id>`    |

The protocol is kept on purpose. Bifrost's unified chat-completions endpoint
would cost the thinking budgets, thought signatures and cache accounting the
native adapters exist for.

- Declared providers are rerouted too; their own `apiKey` and `baseURL` are set
  aside, their `headers`, `timeoutMs` and `maxRetries` are kept. Only a
  pre-built `client` (code only) stays where it is.
- The model id is qualified **on the wire only**. A model's `id`, the trajectory
  and an embedder's id - which a memory and a rag index record - keep the id
  written here, so switching modes orphans nothing.
- OpenRouter goes through the OpenAI endpoint, so OpenRouter-only knobs
  (`routing`, `fallbacks`, `plugins`, …) are a load error in this mode.
- The virtual key is sent as each SDK's own key header and as `x-bf-vk`, which
  Bifrost still reads when `Authorization` is taken by gateway login.

`zen key mode bifrost` is the usual way to turn it on; see
[`zen key`](../packages/cli/templates/editor/.github/skills/zen-cli/references/keys.md).
The full guide - setup, the sandbox, `zen models`, checking thought signatures,
known limits - is [gateway.md](gateway.md).

---

## `models:`

Named model configurations. Each value is either a shorthand string or an
object.

```yaml
models:
    fast: openai/responses:gpt-5.4-mini
    careful:
        provider: openai
        api: responses
        model: gpt-5.4
        reasoningEffort: high
    grounded:
        provider: vertex-eu
        model: gemini-3-pro-preview
        thinkingLevel: high
    deliberate:
        provider: claude
        model: claude-sonnet-4-5
        maxTokens: 16000
```

### Shorthand

```
[provider[/api]:]model
```

`gpt-4o` · `openai:gpt-4o` · `openai/responses:o3` · `vertex:gemini-3.5-flash`

Only the **first** colon separates, so a fine-tuned id keeps its own - it just
has to name its provider: `openai:ft:gpt-4o:acme::a1b2`.

**Always write the prefix.** The first segment is a provider _name_, not a vendor
hint - nothing reads `gemini-3.5-flash` and infers Google. An unprefixed id goes
to the default provider, which is `openai` unless a top-level `provider:` says
otherwise, so a bare `gemini-3.5-flash` asks OpenAI for a Google model and fails
with `OPENAI_API_KEY is not set`.

Anything the shorthand cannot express (keys, base urls, reasoning knobs) needs
the object form - which does **not** re-parse a shorthand: its `model:` is the
bare id, with `provider:` beside it.

### Object fields

| Field                    | Applies to                    | Meaning                                                                         |
| ------------------------ | ----------------------------- | ------------------------------------------------------------------------------- |
| `model`                  | all                           | **Required.** The vendor's model id                                             |
| `provider`               | all                           | A `providers:` name, or a built-in kind                                         |
| `api`                    | openai                        | `chat` or `responses`. Reasoning needs `responses` - see note below             |
| `apiKey` / `apiKeyEnv`   | all                           | One-off credentials; opts out of the shared client                              |
| `baseURL` / `baseURLEnv` | all                           | Same                                                                            |
| `reasoningEffort`        | openai, openrouter            | Free string - see note below                                                    |
| `reasoningSummary`       | openai, openrouter            | `auto` \| `concise` \| `detailed`                                               |
| `store`                  | openai                        | Whether the provider retains the response                                       |
| `maxTokens`              | anthropic, gemini, openrouter | Output cap. Anthropic requires one (default 8192) and bills thinking against it |
| `thinkingBudgetTokens`   | anthropic                     | Extended thinking budget                                                        |
| `thinkingBudget`         | gemini 2.5                    | Token budget: `0` off, `-1` auto                                                |
| `thinkingLevel`          | gemini 3                      | `minimal` \| `low` \| `medium` \| `high`                                        |
| `includeThoughts`        | gemini                        | Return thought summaries (default `true`)                                       |
| `routing`                | openrouter                    | Which upstream providers may serve the request                                  |
| `fallbacks`              | openrouter                    | Models to try when none of them can                                             |
| `serviceTier`            | openrouter                    | `auto` \| `default` \| `fast` \| `flex` \| `priority` \| `scale`                |

Knobs are rejected when they do not apply to the chosen vendor. The schema
accepts every one of them on every model - vendor differences live in the
provider, so there is nothing in the _file_ to discriminate on - but building
the model resolves the provider to a kind, and a knob that adapter would never
read fails there and is reported by `zen check` as `model.knob`. Dropping it
silently was worse: the config claimed a setting that no request carried.

`reasoningEffort` is a plain string on purpose. The vendor's accepted set
changes faster than this schema would, and the request that carries a bad value
is the authority on rejecting it; an enum here would mean a config the API
accepts failing to load.

**OpenAI reasoning needs `api: responses`.** The default is `chat`, which
exposes no reasoning summary and rejects `reasoningEffort` outright when the
request also carries function tools: `400 Function tools with reasoning_effort
are not supported for <model> in /v1/chat/completions`. Nothing catches this at
load - the API is the one to say no.

### Resolution order

A `model:` value anywhere is resolved as:

1. `ProjectOptions.models[ref]` - the host's alias table
2. `models[ref]` - this file's alias table
3. The shorthand parser

Results are memoized, so two agents naming `fast` share one model over one
client, and a bad ref raises its error once, at the agent that wrote it.

---

## `embeddings:`

Vectorisers, named the same way models are, and reached through the same
`providers:` and the same memoized clients.

```yaml
embeddings:
    main: vertex:gemini-embedding-001 # shorthand
    wide:
        provider: openai
        model: text-embedding-3-large
        dimensions: 1536

embedding: main # what `embedder()` returns when asked for none
```

| Field            | Applies to | Meaning                                             |
| ---------------- | ---------- | --------------------------------------------------- |
| `provider`       | all        | A name from `providers:`, or a built-in kind        |
| `model`          | all        | Required. Sent to the API verbatim                  |
| `dimensions`     | all        | Truncate to this width, where the model supports it |
| `title`          | gemini     | A document title the retrieval task type weighs     |
| `maxBatch`       | all        | Texts per request; defaults to the model's own cap  |
| `maxBatchTokens` | all        | Estimated tokens per request; likewise              |
| `routing`        | openrouter | Who serves the request                              |

Deliberately smaller than a model entry: an embedding call has no conversation,
no tools and no reasoning, so a connection, an id and a width is all there is to
say. There is **no `api:`** - `/v1/responses` has no embeddings endpoint, and
naming one is an error. There is no `taskType` either: that describes the text
rather than the model, so it belongs to the call.

### Batching and back-pressure

`embed()` takes as many texts as you have. It splits them to whatever the model
accepts - 2048 per request for `text-embedding-3-*`, one for
`gemini-embedding-*` - and issues those requests in parallel. There is no wave:
a slot is granted the moment one frees, so a single slow request does not idle
the others.

How many run at once is not configured, because the honest number depends on the
account, the model and whatever else is spending the same quota right now. It
starts at 4, gains a slot every 8 consecutive successes, and halves the moment
the provider answers `429` - once per overload, not once per refusal, so sixteen
simultaneous rejections cost one halving rather than dropping to a single
request in flight. A `Retry-After` pauses every request on that connection, not
just the one that was refused.

`concurrency:` on the _provider_ caps how high that may climb, which is what to
reach for when a key is shared with something else. `maxBatch` and
`maxBatchTokens` are for a gateway whose limits are not its vendor's. Both
default to the model's, and both are ceilings - nothing here makes requests
larger than the model allows.

Progress is reported per text through `onProgress`, since a large corpus is
minutes inside one `await`.

This is **not a per-agent key**. Nothing in the runtime consumes an embedder on
an agent's behalf yet, and a key nothing honours is worse than a key that is not
there. What reads it is a host, through `AgentProject.embedder(name?)` - with no
argument, the project's `embedding:`, and `undefined` when it declares none.
Only `embedding:` resolves at load; a named one resolves when it is asked for.

Anthropic publishes no embeddings API, so a `provider` pointing at it is an
error whatever the model says.

---

## `skills:`

```yaml
skills: agents/skills
# or
skills:
    - agents/skills
    - ../shared/skills
```

Directories are relative to the project root and may not escape it. Several
directories are merged into a single catalog with the provider id `project`.
If the key is absent and `agents/skills` exists, it is used.

Each skill in a catalog is a directory holding `SKILL.md`:

```
agents/skills/pdf_forms/SKILL.md
agents/skills/pdf_forms/scripts/fill.py
```

A bare `agents/skills/pdf_forms.md` is indexed by the provider but is not a
project layout - `zen check` reports it as `skill.flat`, because a skill with no
directory of its own cannot ship anything but prose.

The catalog is also mounted into the run, read-only, at `/skills` - one
directory becomes `/skills`, several become `/skills/<folder name>` each. That
is what lets a skill ship a script instead of describing one: a skill's
instructions are rendered with the line "This skill's files are at
/skills/<name>", so `run_command` can execute `python
/skills/pdf_forms/scripts/fill.py` and `read_file` can open it. Write that
absolute path in the skill body: the text is loaded into a prompt, not executed
from its directory, and the working directory is `/workspace`. The interpreter
has to be in the `sandbox:` image already, and anything the script produces has
to be written under `/workspace`, since the mount refuses writes.

The whole catalog is mounted, for every agent, before anything is loaded - a
container's mounts are fixed when it is created, so a folder cannot appear at
the moment `skill_load` asks for it. An agent's `allow:` therefore decides what
it can _load_, not what it can _read_: a determined model that already knows a
name can open the file. `allow:` is a prompt boundary, not a filesystem one.

---

## `assets:`

Reference material every agent can read and none can write.

```yaml
assets: handbook
```

If the key is absent and an `assets/` directory exists next to `agents.yaml`,
it is used - the folder is the whole configuration for most projects. The key
exists for material kept elsewhere in the tree; like every other path here it
is relative to the project root and may not escape it, and naming a directory
that is not there fails the load.

It is mounted at `/assets`, always read-only, for every agent:

- `read_file`, `list_dir` and `find_files` reach it under that name, and
  `find_files` with no `path` searches it along with the workspace.
- `list_dir` with no path (or `/`) lists the trees themselves - `/workspace`
  and `/assets` - since with more than one in reach there is a level above
  both.
- `write_file`, `apply_patch`, `move_file` and `delete_file` refuse it. A
  patch that touches one file under `/assets` writes none of its files.
- `copy_file` reads out of it but not into it: the destination has to be
  writable, which is how an asset is brought into the workspace.
- `run_command` sees the same directory at the same path, bind-mounted `:ro`.

There is no per-agent `assets:`. An agent that may see only part of the
material is a different project, not a different key - and since the mount is
fixed when the container starts, it could not be varied per hand-off anyway.

What belongs here is what agents consult: handbooks, specifications, schemas,
style guides, worked examples. What does not is the project's own directory.
`zen check` warns when `assets:` resolves to somewhere containing `sessions/`,
because that hands every agent every transcript of every run, including the one
reading it.

> Adding or removing a mount changes the container's name, exactly as a
> `sandbox:` field does. With `persist: true` that abandons the old container
> and whatever was installed in it - see below.

---

## `memory:`

What agents remember between runs, and from each other. Memory is a **graph**,
not a list: a node is one thing worth keeping - a task, a plan, a fact, a
snippet, a file, an API call - and an edge says how one led to another. Recall
returns the connected piece, so an agent that finds the right answer also gets
the reasoning that produced it and the script that ran it.

It lives with the project, not the session. A memory that died with the session
would be a cache.

```yaml
memory:
    dir: memory
    embedding: main

agents:
    - name: auditor
      memory: true
```

That is the whole feature: the agent can search, load, and commit, and it
recalls automatically before answering new user input.

| Field       | Type          | Default         | Meaning                             |
| ----------- | ------------- | --------------- | ----------------------------------- |
| `dir`       | path          | `memory`        | Relative to the project root        |
| `embedding` | embedding ref | the top-level   | The vectoriser recall searches with |
| `kinds`     | name[]        | the seven below | Replaces the node vocabulary        |
| `relations` | name[]        | the four below  | Replaces the edge vocabulary        |

The block is optional. A project whose agents say `memory: true` gets the
defaults without writing one, and a project that mentions memory nowhere opens
no store and creates no directory.

**Kinds** are `task`, `plan`, `fact`, `snippet`, `file`, `operation`,
`preference`.
**Relations** are `PRODUCED`, `INFORMED`, `CALLS`, `SUPERSEDES`. Both are closed
sets, offered to the model as enums, which is what keeps a graph built by a
language model queryable a month later. Override them only if the defaults
genuinely do not fit the domain - a wider vocabulary is a vaguer one.

`kinds` _replaces_ the default set rather than extending it, with one exception:
`preference` is always available, because the engine itself reads that kind to
build the system prompt. A project that could define it away would lose the
feature silently rather than opt out of it.

**Embedding is optional but wanted.** Without one, recall falls back to term
overlap, which finds a memory phrased the way the query was and misses the rest.
The width is learned from the first response rather than declared, and changing
the model afterwards is refused rather than silently mixing two vector spaces.

### Remembered files

An agent that writes a working script can keep it. The file is copied into the
memory directory under a generated id. It is not mounted into the sandbox: a
later run copies it into the workspace with `memory_copy_file`, then runs it:

```
memory_copy_file  { "id": "01JD9Q7X8N2K4M6P8R0T2V4W6Y" }   → /workspace/01JD9Q7X8N2K4M6P8R0T2V4W6Y.py
run_command       python3 01JD9Q7X8N2K4M6P8R0T2V4W6Y.py
```

The graph holds the provenance around it - what asked for it, what plan it came
from, what it called - and that subgraph is what comes back on recall. Files are
capped at 2 MiB, and one under 32 KiB is returned inline rather than as a path.

### Standing preferences

A memory of kind `preference` is a standing instruction from the user - "always
report findings as a table", "use ISO dates". These are not recalled by
similarity, because they are not _about_ the request in front of the agent: an
instruction on how to report is nowhere near a question about gateway rules in
embedding space, and a search would never surface it.

So they are listed instead of ranked, and rendered into the system prompt with
their ids:

```
<memory-preferences>
- report findings as a table with a severity column [01JD9Q7X8N2K4M6P8R0T2V4W6Y]
</memory-preferences>
```

How to read a recollection and when committing is worthwhile is not in this
block: it is the project's own house rules, in `agents/memory-instructions.md`,
which carry `requires: [memory]` and so reach exactly the agents that have the
store. The runtime composes the preference block and nothing else, so a project
that deletes that file leaves its agents with the `memory_*` schemas and no
explanation - `zen check` fails it as `memory.uninstructed`. Because it all
lands in the cached prefix rather than in the conversation, it costs once per
run rather than once per turn, and the id is what lets the model replace a
preference with `SUPERSEDES` instead of quietly ignoring it.

Preferences are deliberately left out of ordinary recall results - they are in
the prompt already, and repeating them would state the same instruction twice in
two framings. `memory_search` with `kinds: [preference]` still finds them, which
is how an agent checks for a duplicate before committing another.

### `agents[].memory`

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
| `access`     | `read`/`read-write`/`full` | `read-write`     | Which of the six tools this agent gets       |
| `sees`       | name[]                     | `[]`             | Private slices this agent may read, plus `*` |
| `writes`     | name[]                     | `[*]`            | Labels it may write under                    |
| `autoRecall` | boolean or `{ limit }`     | `true`, limit 10 | Recall before a turn that follows user input |

`access` decides the tools, and nothing else does:

| Level        | Tools                                                             |
| ------------ | ----------------------------------------------------------------- |
| `read`       | `memory_search`, `memory_grep`, `memory_load`, `memory_copy_file` |
| `read-write` | the above, plus `memory_commit`                                   |
| `full`       | the above, plus `memory_forget`                                   |

**One memory, masked - not one memory each.** Every node carries an audience,
and `sees` is the set of audiences an agent reads. `*` is the public slice and
is always included, so a binding can only ever widen what an agent sees, never
hide the common ground. Two agents with `sees: []` share everything public; give
one `sees: [audit]` and it also reads what was committed under `audit`, which
nothing else can see at all - an invisible node is indistinguishable from a
missing one, deliberately, so that a mask cannot be probed by id.

`writes` is the other half: an agent can only commit under a label it was given,
so an agent that reads a private slice need not be able to add to it. When
`writes` names exactly one label the tool schema omits the field entirely and
applies it - there is nothing to choose, and nothing for the model to get wrong.

**Auto-recall is on by default** because an agent that has to remember to go
looking mostly does not. It costs one embedding call and a small prompt section
on turns that follow new user input, and it is off for everything else - a turn
after a tool result does not re-recall. `autoRecall: false` turns it off without
giving up the tools, which is the right setting for an agent that should decide
for itself when to search.

**Correction is a new node, not an edit.** A memory that turns out to be wrong
gets superseded by one that is right, joined by a `SUPERSEDES` edge, and recall
follows the edge forward. The old node stays because the reason a thing changed
is often the useful part. `memory_forget` - `access: full` - is for the case
where something should never have been written down at all: it removes the node,
its vector, and its file bytes together.

---

## `sandbox:`

Where `run_command` runs. Command-line tools execute in a Linux container with
the session's workspace bind-mounted at `/workspace`; nothing else of the host
is reachable, and the container is the boundary rather than any inspection of
what the model wrote.

```yaml
sandbox:
    persist: true
    image: docker.io/library/python:3.13-slim
    cpus: 4
    memory: 4096
    network: bridge
    timeout: 300
    env: [HTTPS_PROXY, NO_PROXY]
```

| Field       | Type                   | Default                                       | Meaning                                             |
| ----------- | ---------------------- | --------------------------------------------- | --------------------------------------------------- |
| `image`     | string                 | `docker.io/library/python:3.14-slim-bookworm` | The base image commands run in                      |
| `build`     | object                 | none                                          | A Dockerfile to build instead of an image to pull   |
| `cpus`      | number                 | `4` (`2` under `strict`)                      | Fractional cores, as podman's `--cpus`              |
| `memory`    | integer, MiB           | `4096` (`2048` under `strict`)                | As podman's `--memory`                              |
| `network`   | `bridge`/`none`/`host` | `bridge`                                      | `none` for a project that must not reach out        |
| `workdir`   | absolute path          | `/workspace`                                  | Where the workspace is mounted, and the default cwd |
| `timeout`   | integer, seconds       | `120`                                         | Per command, unless a call asks for less            |
| `hardening` | `standard`/`strict`    | `standard`                                    | How much of the host the container may be           |
| `user`      | string                 | the image's                                   | uid, name, or `uid:gid`                             |
| `persist`   | boolean                | `false` - **recommended `true`**              | Keep the container between runs of a session        |
| `env`       | string[]               | none                                          | Host variables to forward, **by name**              |
| `keys`      | boolean                | `true`                                        | Whether the model credentials reach the container   |

`image` and `build` cannot both be set: a Dockerfile names its own base in its
`FROM` line, so one of the two would be silently ignored.

`cpus` and `memory` do two jobs on macOS and Windows: they cap the container,
and they size the Podman virtual machine if the CLI has to create one. On
Linux there is no machine and they only cap the container.

### `hardening:`, for running code nobody has read

Every sandbox gets the same floor: a container, an init process, a pid ceiling
of 1024, resource limits (`cpus: 4`, `memory: 4096`), `no-new-privileges`, no
restart policy, never `--privileged`, and podman's own seccomp profile, which
is never turned off.

`standard` stops there, deliberately. Dropping the kernel capabilities breaks
`apt` and `pip`, and installing a package is the ordinary use of a shell - so
under `standard` the container is the boundary and nothing inside it is taken
away.

`strict` makes the opposite trade, for a project whose agents run code that
arrived from somewhere else:

```yaml
sandbox:
    hardening: strict
    build:
        dockerfile: sandbox/Dockerfile
```

| What it changes                                    | Why                                                       |
| -------------------------------------------------- | --------------------------------------------------------- |
| `--cap-drop ALL`                                   | No `CAP_SYS_ADMIN`, `CAP_NET_ADMIN`, `CAP_CHOWN`, nothing |
| `--read-only` root filesystem                      | The image becomes reference material, not scratch space   |
| `/tmp` as `noexec,nosuid,nodev` tmpfs, 64 MiB      | The only writable temporary space, and it is in memory    |
| `--userns keep-id`                                 | Runs as your own unprivileged uid, not as container root  |
| `network: none` unless you say otherwise           | Default network blackout                                  |
| `cpus: 2`, `memory: 2048` unless you say otherwise | A ceiling nobody wrote down is not a ceiling              |

Name any of those keys yourself and your value wins - `network: bridge` under
`strict` is a project that needs egress and has accepted what that means.

Two consequences worth stating plainly:

- **Nothing can be installed at run time.** `apt`, `pip install`, `npm i` and
  anything else that writes outside the mounts stop working, so a strict
  project bakes its dependencies into the image with `build:` above. The
  persistent `$HOME` still works, but an install that needs the capabilities
  or a writable `/usr` does not.
- **It needs rootless podman.** `--userns keep-id` is rootless-only, which is
  also the property that makes a container escape land on an unprivileged host
  account. Set `user:` explicitly to opt out of `keep-id` and take
  responsibility for the uid yourself.

The mounts do not go away. `/workspace` is the work itself and stays writable;
`strict` shrinks what a command can reach, it does not pretend the agent has
nothing to edit.

### `build:`, for what the project always needs

A published image is the right answer when one exists. When it does not - a
project that needs Python _and_ Node, or a pinned toolchain - the alternative
is an agent installing it at the start of every run, which is slow, silently
version-drifting, and thrown away with the container.

```yaml
sandbox:
    persist: true
    build:
        dockerfile: sandbox/Dockerfile
```

| Field        | Type | Default                     | Meaning                        |
| ------------ | ---- | --------------------------- | ------------------------------ |
| `dockerfile` | path | required                    | Relative to the project root   |
| `context`    | path | the Dockerfile's own folder | What the build may `COPY` from |

Both must resolve inside the project; a path that escapes the root is refused
at load, as everywhere else in this file.

`zen init` writes a `sandbox/Dockerfile` with Python and Node in it and points
this at it. It is the project's file from then on - edit it, commit it, and
`zen init` will not touch it again.

**The tag is a hash of the content.** The image is tagged
`localhost/zenera-sandbox:<digest>`, where the digest covers the Dockerfile and
every file in the context. Editing either produces a different tag, and
therefore a different container name - which is what you want, and is also the
cost noted under `persist: true` below: the old container is abandoned, along
with whatever was installed in it.

The build is **skipped once the tag is on disk**, which is the point of hashing
the content: the image existing means the Dockerfile and its context are
unchanged, so an ordinary `zen run` costs one `podman image exists` and nothing
else. What that does not catch is a base image that moved - `podman build`
reuses whatever `FROM node:24` resolved to last time - so `zen sandbox pull`
forces the build when you want a fresh one.

A `.dockerignore` is honoured by the engine but **not** by the digest, so a
file the build ignores can still change the tag. That direction is wasteful and
never wrong; the other direction would hand you a stale image.

`zen check` builds the image and runs one command in it, against a temporary
directory rather than your workspace - a Dockerfile that does not build is a
broken project, and nothing short of building it says so. `zen check
--no-sandbox` skips that. A machine with no container engine gets a warning
rather than an error, since that is the machine most likely to be running the
check.

### What survives, and what does not

By default the container is removed when the session closes, so anything
installed into its root filesystem is gone. These directories are bind mounts
and do survive:

| Inside       | On the host                                           |
| ------------ | ----------------------------------------------------- |
| `/workspace` | the session's workspace                               |
| `/assets`    | the project's `assets:`, read-only, if it has one     |
| `/skills`    | the project's skill catalog, read-only, if it has one |

`/workspace` is the same directory the file tools work in, and they are told so:
`read_file`, `apply_patch` and the rest accept `/workspace/src/a.ts` as well as
`src/a.ts`, and they answer with the mounted name - one vocabulary on both
sides. A path copied out of a compiler error, a `find` listing or a stack trace
can be handed straight to a file tool, and a path a file tool reported can be
handed straight to `run_command`, without the model having to translate either
way. Changing `workdir` moves both names together.

So `pip install --user`, `npm config`, `~/.cache` and anything else an agent
puts in its home directory are still there when the session is opened again,
and they travel with the session directory when it is copied.

### `persist: true`, and why to write it

What the two mounts do **not** cover is the ordinary case. An agent that runs
`pip install duckdb` or `apt-get install` is root in its container, so the
package lands in the image's system paths - not under `$HOME` - and the next
`zen run` starts from a fresh rootfs without it. The agent reinstalls on every
run, and its own transcript from last time claims the install succeeded, so it
usually does not notice.

```yaml
sandbox:
    persist: true
```

With it the container is **stopped** rather than removed, and the next run of
the same session starts that same container back up with everything still in
place. This is the recommended setting for any project whose agents install
things; `zen sandbox status` lists what is left behind and `zen sandbox clean`
removes it.

A container is per **session**, not per project, so a project used for a week
accumulates one per session it ran. They are cheap - a stopped container costs
disk and one of the engine's locks, and the writable layer is usually tens of
kilobytes, because everything worth keeping is already in the two mounts - but
they are not free. Podman has 2048 locks by default and every container holds
one, stopped or not; at zero nothing can be created, and `zen sandbox status`
says so. `zen run batch` items are sessions nobody resumes, so their containers
are removed on close whatever `persist:` says. `zen sandbox clean --idle`
clears the rest without touching live runs - stopped containers, and running
ones whose run was killed before it could stop them - and `zen sandbox disk`
shows what they and every project directory add up to.

Changing any field here changes the container's name, so a project that bumps
its image gets a new container rather than an old one quietly persisting with
the wrong contents. Adding or removing an `assets:` directory or a skill
directory does the same, since the mounts are part of what a container is. That
is also the cost of `persist: true`: a config change abandons the old container
along with whatever was installed in it, so anything the project always needs
still belongs in `image:` - or in `build:` - rather than in an accumulated
rootfs.

### `env:` names, never values

A value in this file would be a secret in the repository, so only names are
accepted and the host's environment supplies the value. Names that read like a
credential - anything containing `KEY`, `TOKEN`, `SECRET`, `PASSWORD` or
`CREDENTIAL` - are refused at load. Not because credentials never belong in the
sandbox, but because `env:` is the wrong door for them: they go through `keys:`,
which forwards a known set and can be turned off in one place, where a
hand-written `env: [OPENAI_API_KEY]` would be a second, silent way in.

The door for a project's own secrets is the project's own `.env`, which `zen
init` writes and `.gitignore` covers. `zen run` reads it before it loads the
project - so `${VAR}` anywhere in this file can name something in it - and
forwards every name it declares into the container by name, alongside the
keys. Anything already set in the shell wins over the file, and the keyring
fills in whatever neither supplied.

### `keys:`, and what it gives away

The model credentials reach the container by default. The scaffolded image
installs `zen` itself, and an agent that cannot run `zen check` inside its own
sandbox is a surprise rather than a safety feature.

It is still a real trade, and worth stating plainly: **the container runs
whatever the model wrote**, so a forwarded key is a key that generated code can
read, and on a `bridge` network it is a key that code can send somewhere. Two
ways to close that:

```yaml
sandbox:
    keys: false # nothing credential-shaped is forwarded
    network: none # or: nowhere to send it
```

`zen run --no-keys` does the same for one run, whatever the file says.

What is forwarded, when it is on: the API key of every provider the run has a
credential for, plus `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION`, plus
every name in the project's `.env`. A Vertex service-account file is
bind-mounted read-only - that one file, not the directory it sits in - under
`/run/zenera/keys`, and `GOOGLE_APPLICATION_CREDENTIALS` points there instead.

The `.env` travels with the keys rather than beside them, because that is where
an api token lives: `keys: false` and `--no-keys` withhold it too, or the
switch would be a promise it does not keep.

Secrets are handed to podman **by name**, never as `NAME=value`, so a key does
not appear in the container's argv, in `ps`, or in `podman inspect`. For the
same reason the container's identity is computed from the names alone: rotating
a key does not abandon a `persist: true` container's filesystem.

`ZEN_USER_*` is reserved. Those variables say which user the run acts for, and
only the host sets them. They are set on each command, never on the container,
so `env:` cannot name one. See [identity.md](identity.md).

### `agents[].sandbox`

Agents share one container by default. They already share the workspace, and a
hand-off is meant to be continuous: whatever the first agent installed should
still be there when the second takes over.

An agent that needs a different image says so, and gets its own:

```yaml
sandbox:
    image: docker.io/library/debian:bookworm-slim

agents:
    - name: analyst
      tools: [sandbox:*]
      sandbox:
          image: docker.io/library/python:3.13-slim
    - name: writer
      tools: [sandbox:*] # shares the project's container
```

The fields are the same, merged over the top-level block. Two agents that
resolve to the same configuration still share one container.

An agent that sets `image` displaces a project-level `build`, and an agent that
sets `build` displaces a project-level `image` - the two are exclusive after
the merge as well as before it.

---

## `agents:`

```yaml
agents:
    - name: intake
      description: Takes the first message, gets the claim reference, routes the case.
      system: agents/prompts/intake.md
      model: router
      tools: [policy_lookup]
      handoffs: [adjuster]

    - name: adjuster
      description: Applies the written peril policies to a claim and explains the outcome.
      model: balanced
      skills:
          discovery: index
          preload: [house_style]
```

| Field         | Meaning                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------- |
| `name`        | **Required.** See [Names](#names)                                                                    |
| `description` | What a sibling agent's `transfer_to_<name>` tool tells the model. Write it for the model             |
| `system`      | Path to a markdown file, relative to the root. Defaults to `agents/prompts/<name>.md` if that exists |
| `model`       | A `models:` name or a shorthand. Falls back to the top-level `model:`                                |
| `tools`       | Tool selectors resolved against `ProjectOptions.tools` - code cannot live in yaml                    |
| `handoffs`    | Agent names this one may transfer to                                                                 |
| `skills`      | Skill binding; see below                                                                             |
| `memory`      | `true`, or a binding - opt-in to the shared memory; see below                                        |
| `fork`        | `true`, or a binding - opt-in to parallel branches; see below                                        |
| `sandbox`     | Overrides on the top-level `sandbox:`; see below                                                     |
| `default`     | `true` marks the entry point, if no top-level `default:`                                             |

`handoffs` takes bare strings by design, not objects. A hand-off carries no
configuration in this version, so there is nothing for an object form to hold,
and accepting one would mean accepting keys nothing honours.

**A hand-off must be returnable.** For every `A → B` there has to be a path from
B back to A; indirect counts, so `B → C → A` is a way home, and the rule amounts
to saying every edge lies on a cycle. The reason is that a hand-off is a one-way
door: control moves to the other agent and stays there, and nothing hands it
back. An agent reached by a dead-end edge therefore owns the conversation for the
rest of the session - the next question, whatever it is about, is answered by
whoever the router last transferred to.

This is not a load error, because the project runs; it just cannot come back.
`zen check` reports it as a warning, `handoff.one-way`, naming the edge and both
ways out of it.

`fork:` is the exception, and usually the fix. A branch runs, answers, and
control returns to the agent that forked it, so a fork needs no return edge - the
return is the mechanism. An agent that wants an _answer_ rather than to give up
the conversation should fork; an agent that wants the other one to take over
should hand off, and something on the far side has to lead back.

**The return is condensed.** `A → fork → B` rejoins as a single tool result
holding B's answer, so A never sees the steps B took to reach it - not the tool
calls, not the files read, not the intermediate reasoning. That is what makes
fanning out cheap (N branches cost A `N × answer`, not `N × transcript`), and it
is also the thing to design around: whatever A will need has to be _in_ the
answer, so say so in B's prompt. Work whose value is in the trace, rather than
in its conclusion, does not survive a fork.

**One branch is the delegation case, and it is valid.** A fork of one runs a
single assignment elsewhere and brings back its conclusion - no siblings, no
parallelism, just the transcript kept out of A's conversation. Reach for it when
another agent is better suited to the job, or when the job would otherwise fill
A's context with material it has no use for afterwards: a long file survey, a
noisy build loop, an exploration that may go nowhere. The mechanism is identical
to a fan-out; the number of branches is the only difference.

### `agents[].tools`

An entry is a tool name, or a selector:

| Selector          | Selects                                                                 |
| ----------------- | ----------------------------------------------------------------------- |
| `read_file`       | that one tool                                                           |
| `files:read_file` | the same tool, written out in full                                      |
| `group:*`         | every tool in a group - `files:*` (alias `workspace:*`) is all file ops |
| `'*'`             | everything the host passed to `loadProject`                             |
| `-<any>`          | removes what it matches from the selection so far                       |

Quote a lone `'*'`: unquoted, YAML reads it as an alias and refuses the file.
`files:*` and `workspace:*` need no quoting.

Selectors are applied in the order written, so subtraction reads as an
exception to the line above it:

```yaml
tools: [files:*, -delete_file, -move_file, policy_lookup]
```

Groups come from the tool, not from config: `fileTools()` tags its eight with
`files` (with `workspace` recognized as an alias), `sandboxTools()` tags its four
with `sandbox`, and a host's own tools can carry any `group` they like. The
model never sees a group - it gets the same flat list of names either way.

The same grammar resolves a skill's `tools:` frontmatter against the tools
registered on its provider.

The two groups the CLI registers:

| Group                        | Tools                                                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `files:*` (or `workspace:*`) | `read_file`, `list_dir`, `find_files`, `write_file`, `apply_patch`, `copy_file`, `move_file`, `delete_file` |
| `sandbox:*`                  | `run_command`, `run_command_background`, `read_command_output`, `stop_command`                              |

Declaring file tools makes the operations available. How to discover files, read
ranges without blowing context, and safely patch files is in the house rules
`agents/files-instructions.md`, carrying `requires: [files]`. An agent with
file tools whose project has deleted that file gets the file schemas and no
explanation - `zen check` reports that as `files.uninstructed`.

Naming `sandbox:*` is what makes a project need a container engine. See
[`sandbox:`](#sandbox).

### `agents[].skills`

| Field             | Default           | Meaning                                                       |
| ----------------- | ----------------- | ------------------------------------------------------------- |
| `provider`        | the sole provider | Which catalog to draw on                                      |
| `discovery`       | `index`           | `index` \| `search` \| `none`                                 |
| `allow`           | all               | Restricts the catalog this agent sees                         |
| `preload`         | -                 | Activated before the first call of every turn this agent owns |
| `maxIndexEntries` | -                 | Caps the rendered index                                       |

`discovery` controls how the agent finds out what exists:

- **`index`** - names and descriptions are rendered into the system prompt, so
  the model can see the catalog and pull what the case needs.
- **`search`** - no index; only a `skill_search` tool. For catalogs too large to
  render.
- **`none`** - preloads only.

`preload` is for content there is no case for the model to decline: house tone,
a formatting contract. Making it choose would be a wasted round trip. Preloaded
skills are activated before the first model call and filtered _out_ of the
rendered index, so the model never spends a turn re-loading something already
active. Because activation lands at the head of the transcript and never moves,
it sits inside the cached prefix instead of being appended after the first
reply.

### `agents[].fork`

Without the key an agent has no `fork` tool at all: it can only work in its own
conversation. `fork: true` gives it the unrestricted form, and the object form
narrows it.

| Field         | Default              | Meaning                              |
| ------------- | -------------------- | ------------------------------------ |
| `agents`      | every declared agent | Which agents a branch may run        |
| `maxBranches` | unlimited            | Cap on branches per call (minimum 1) |

```yaml
- name: trunk
  fork:
      agents: [lens] # every branch runs the specialist
      maxBranches: 4
```

`maxBranches: 1` is not a contradiction: it says this agent may hand one job to
a branch but may not fan out.

`agents` may include the forking agent itself - one role fanned out over ten
regions is the common shape, and unlike `handoffs` that is not an error. The
list reaches the model as an `enum` on each branch's `agent` field, so a name
outside it cannot be decoded rather than merely being told off afterwards.

Nesting is capped independently: a branch may fork again, but only while
`forkDepth` is below the run's `maxForkDepth` (2 by default, a `RunOptions`
field), so a fan-out cannot recurse without bound.

Declaring the key only makes the tool available. What a fork costs and what
survives a join is the project's own house rules, in
`agents/fork-instructions.md` under `requires: [fork]`, so an agent that cannot
fork never reads it - and an agent that can, whose project has deleted the file,
gets the `fork` schema and no explanation. `zen check` fails that as
`fork.uninstructed`. What is left to the agent's own prompt is _when_, in the
terms of its domain.

---

## Errors caught at load

- Unknown key anywhere (strict schema)
- A name that breaks the name pattern
- `requires:` in a house-rules document naming something outside `files`,
  `files-write`, `fork`, `memory`, `memory-write`, `memory-forget` (or aliases
  `workspace`, `workspace-write`)
- `models.<alias>.provider` naming an undeclared provider
- `agents[].tools` naming a tool not passed to `loadProject`, or a group with
  nothing in it
- `agents[].handoffs` naming an unknown agent, or the agent itself
- `agents[].skills.provider` naming an unknown catalog
- `agents[].skills.allow` / `.preload` naming a skill not in the catalog
- A `preload` entry absent from `allow`
- `agents[].fork.agents` naming an unknown agent, or being empty
- `agents[].fork.maxBranches` below 1, which no valid call could satisfy
- `system:` pointing at a missing file, or outside the project root

The loader stops at the first of these. `zen check` does not: it reports every
one it can reach, each with the key it is about and the fix, and adds the checks
that are not load errors - a hand-off with no path back, an agent with no prompt
at all, a skill with no description, a folder in the catalog with no `SKILL.md`,
a model with no credential on this machine. Nothing is called; `--json` for the
same report
without the rendering.
