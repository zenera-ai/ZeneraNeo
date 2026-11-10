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
<img src="https://raw.githubusercontent.com/zenera-ai/ZeneraNeo/main/docs/imgs/banner-gym-with-media-queries.svg" alt="ZENERA GYM" width="738">

[![npm](https://img.shields.io/npm/v/@zenera/gym.svg)](https://www.npmjs.com/package/@zenera/gym)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/zenera-ai/ZeneraNeo/blob/main/LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A524-brightgreen.svg)](https://nodejs.org)
[![CI](https://github.com/zenera-ai/ZeneraNeo/actions/workflows/ci.yml/badge.svg)](https://github.com/zenera-ai/ZeneraNeo/actions/workflows/ci.yml)

[Install](#install) · [Use](#use) · [Commands](#commands) · [Credentials](#credentials) · [Family](#the-rest-of-the-family) · [License](#license)

</div>

# @zenera/gym

**Simulated API environments for agent training and evaluation. Point Gym at
OpenAPI/Swagger documents — and, if you like, a story about the world behind
them and the documentation that goes with it — and it serves the API:
stateful, consistent across endpoints and processes, and populated with
content that follows the story.**

Gym currently provides the API simulation layer, not a training loop, task
scoring, or rewards.

> Part of [ZeneraNeo](https://github.com/zenera-ai/ZeneraNeo). It ships no
> binary of its own: installing it adds a `gym` **subcommand** to
> [`zen`](https://github.com/zenera-ai/ZeneraNeo/blob/main/packages/cli/README.md),
> which is also where the credentials already are.

## What you get

- **A mock server from documents** - name OpenAPI/Swagger files, directories or
  patterns, and every operation answers.
- **A world, not random bodies** - every answer comes from a shared world of
  records. `GET /messages` lists what `GET /messages/{id}` returns, a `POST` is
  visible to the next `GET`, and a `DELETE` deletes.
- **A story it follows** - describe the people, the projects and what is going
  on, and the mailbox, the calendar and everything else read like that place.
- **Documentation it uses** - hand it a knowledge base, runbooks, an admin
  guide; agents search it for realistic values and for what the API does.
- **Several APIs, one world** - mail on one port and calendar on another, given
  the same story, share one world: the meeting in an email is the meeting on
  the calendar.
- **Code written once** - an agent writes a TypeScript handler per operation,
  judged before it is kept; after that a request is a function call, and the
  only tokens spent are on content the world does not have yet.
- **Large APIs** - thousands of operations load in seconds; nothing is written
  until it is called.
- **Lists that end** - paging is built in, judged, and cut at request time.

## Install

Node.js 24+. Install it alongside the CLI:

```sh
npm i -g @zenera/cli @zenera/gym
zen key add openai          # the keyring `zen` already uses
```

No container engine is needed: handlers are TypeScript that Node runs as it is.

## Use

```sh
zen gym serve api/openapi.yaml
curl -s localhost:8787/users/12324
```

Three kinds of input, each a file, a directory or a quoted pattern, each
repeatable:

| Input               | What it is                                                               | How the agents get it           |
| ------------------- | ------------------------------------------------------------------------ | ------------------------------- |
| `spec…`, `--schema` | API documents (`.yaml`, `.yml`, `.json` declaring `swagger:`/`openapi:`) | a graph of operations and types |
| `--story`           | the state of this world: who is who, what is happening                   | quoted whole, in every prompt   |
| `--docs`            | reference material: a knowledge base, guides, runbooks                   | searched when needed            |

```sh
zen gym serve --schema 'specs/*.yaml' --story world.md --docs kb/ --docs 'runbooks/*.md'
```

A directory is walked, and only files that declare `swagger:` or `openapi:` are
taken as API documents — so pointing `--schema` at a folder of mixed JSON, or at
an index somebody built, finds the APIs in it. Quote patterns so the shell leaves
them to Gym.

Two APIs, two processes, one world:

```sh
zen gym serve specs/mail.yaml     --story world.md --docs kb/ --port 8787
zen gym serve specs/calendar.yaml --story world.md --docs kb/ --port 8788
```

[`examples/mock-apis`](https://github.com/zenera-ai/ZeneraNeo/tree/main/examples/mock-apis)
has a story and a knowledge base for the mail and calendar specs beside it.

Everything is indexed before the server listens, so no request waits on an
index. Write every handler up front, before a demo or a test run:

```sh
zen gym build --schema 'specs/*.yaml' --story world.md --docs kb/
```

## How an answer is produced

Two agents, and a split between them that is the whole design.

**The handler agent writes mechanics.** The first time an operation is called,
an agent writes its **handler**: one TypeScript module, `export default async
function handle(req, ctx)`. It is shown the operation as TypeScript types, the
operations it must agree with (found by tracing its record type through the API
graph, so they are found however far apart their paths are), where each type
already lives, and the documentation about the operation. It can look further:
`read_handler`, `trace_api`, `grep_api`, `list_api`, `describe_types`, the world's
collections and the docs.

A handler owns which type an operation is about, how the query filters it, what
a write changes and how the list pages — and never the content. It names records
by their schema type:

```ts
export default async function handle(req, ctx) {
    const all = await ctx.ensure('Message', { hint: req.query.q });
    const q = (req.query.q ?? '').toLowerCase();
    const hits = all.filter((m) => `${m.subject} ${m.snippet}`.toLowerCase().includes(q));
    const page = ctx.page(hits, { token: req.query.pageToken, size: req.query.maxResults });
    return {
        messages: page.items.map(({ id, threadId }) => ({ id, threadId })),
        nextPageToken: page.nextToken ?? undefined,
        resultSizeEstimate: hits.length,
    };
}
```

**Where types live is decided once.** The first handler to use a type binds it to
a collection and an id field; every later handler is told the binding and held
to it. So `listMessages` and `getMessage` read the same records, whichever was
written first and whichever was rebuilt since.

**The world agent writes content.** When a handler finds the world short —
an inbox nobody has read yet, an id nobody has seen — `ctx.ensure` and
`ctx.lookup` ask, and an agent writes the records: from the story, from the
docs, and consistent with everything already in the world, checked against the
schema type before anything can read them. On a first read it makes what the
story says exists, however many that is. Records it refers to that do not exist
yet — a label, a calendar — it makes too, in their own collections.
`me`, `primary` and the like resolve through `ctx.owner()`, the account the story
says the API belongs to.

Because content lives in the world and not in the code, one cached handler
serves every story.

**Nothing is kept until it is judged.** `test_handler` runs the module against
probe requests in a throwaway copy of the world (content there is sampled from
the schema, so judging costs no model calls) and checks every answer against the
response schema, the **echo rule** (`GET /users/12324` must be about user
12324), the paging walk, and the bindings. The first test that passes ends the
build. A build that never passes leaves a report in `<cache>/builds/`, and every
agent run leaves an HTML report in `<cache>/reports/`.

Handlers run in a worker thread with an empty environment. A handler that
throws or times out is repaired, up to `--regen-limit` times per URL; a failure
of the world agent is never treated as a fault in the handler.

## Worlds

A world is one SQLite file under `<cache>/worlds/`. With `--story` and no
`--world`, it is named after what the story says, so every process given the
same story shares it; editing the story starts a new one, and Gym says so.
`--world <name>` names one that survives story edits; `--world ./path.sqlite`
puts it anywhere. Without either, there is one default world.

```sh
zen gym world ls             # every world, what it holds, when it was used
zen gym world rm northwind   # delete one
zen gym serve … --reset      # start the one in use from empty
```

Worlds are data, not cache: `zen gym cache clear` leaves them alone.

## Docs and embeddings

`--docs` are indexed into a directory Gym owns, keyed by their content and by the
model that embeds them: a restart reuses the index, and an edit pays only for the
chunks that changed. By default search is by wording (a full-text index), and no
embedding model is called. `--embedding` adds search by meaning: `--embedding <ref>`
names the model, and `--embedding on` (or `default`) takes the configured one —
`ZENERA_GYM_EMBEDDING`, then `zen gym model --embedding <ref>`, then the first
provider your keys offer. Those settings only answer which model; without the
flag they turn nothing on. `--embedding off` (or `none`) is the default.

## Pages that end

A list endpoint is the one place a mock can hang a real client. Where an
operation has a paging parameter (`cursor`, `page`, `offset`, `page_token`, …) and
a response property that carries the next one (`next`, `next_cursor`,
`has_more`, …), the handler is told to page with `ctx.page`, whose token always
advances and is absent on the last page; it is walked before it is kept; and at
request time a repeated or cycling token is cut, and streams are capped to a
random 1-10 pages. `GET /__gym/routes` reports the shape recognised.

A path key with a query string on it — `/x/{id}?action=retry` — is read for what
it means: the path is the part before the `?`, and each pair after it becomes a
required query value that tells those operations apart.

## Commands

```
zen gym serve [spec...]    Serve the APIs. Handlers are written on first use.
zen gym build [spec...]    Index everything and write every handler, then exit.
zen gym cache ls | clear   Handlers, bindings and indexes.
zen gym world ls | rm      Worlds.
zen gym model [ref]        Show or set the chat and embedding models.
```

Useful options: `--schema`, `--story`, `--docs`, `--world`, `--reset`,
`--embedding`, `--port`, `--host` (reachable only from this machine by default),
`--model`, `--seed`, `--rebuild`, `--attempts`, `--concurrency`, `--timeout`,
`--cache <dir>`, `--quiet`. `zen help gym` prints the full table.

The model is looked for in this order: `--model`, `ZENERA_GYM_MODEL`, what
`zen gym model <provider>:<id>` stored, then the best one your keys can buy.
Both agents call tools; OpenAI's reasoning models take tools over the Responses
API (`openai/responses:<id>`), which is what the default names.

`GET /` is a contents page: every operation, grouped by document, with a **Run**
button and a form per operation. `GET /__gym/routes` is the same as JSON;
`GET /__gym/health` is a health check.

See [DESIGN.md](DESIGN.md) for how the pieces fit together.

## Credentials

The keyring is `zen`'s, so there is nothing new to configure:

```sh
zen key add openai
zen key ls --check
```

Environment variables still win over the keyring, exactly as they do for `zen`.

## The rest of the family

| Package                                                                                    | What it is                                                    |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| [`@zenera/cli`](https://github.com/zenera-ai/ZeneraNeo/blob/main/packages/cli/README.md)   | `zen` - agent projects on the command line                    |
| [`@zenera/neo`](https://github.com/zenera-ai/ZeneraNeo/blob/main/packages/neo/README.md)   | the runtime - agents, models, tools, skills, memory           |
| **`@zenera/gym`**                                                                          | `zen gym` - a mock API from an openapi/swagger document       |
| [`@zenera/rag`](https://github.com/zenera-ai/ZeneraNeo/blob/main/packages/rag/README.md)   | `zen rag` - indexing and search for documents and API schemas |
| [`@zenera/view`](https://github.com/zenera-ai/ZeneraNeo/blob/main/packages/view/README.md) | `zen view` - a live local viewer for a folder                 |

## License

Early days and moving fast - issues, questions and pull requests are welcome.
[MIT](LICENSE).
