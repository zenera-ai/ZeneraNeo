# @zenera/gym - Design

Status: draft
Scope: `packages/gym`

## 1. What it is

A mock HTTP server for OpenAPI/Swagger documents, backed by a **stateful world**
that follows a **story** and draws on **reference documents**. Two agents do the
writing:

- the **handler agent** writes one TypeScript handler per operation: the API's
  _mechanics_ (which type, which filter, what a write changes, how it pages);
- the **world agent** writes the _content_ those handlers read: records that
  agree with the story, the docs, and everything already in the world.

The split is the whole design. A handler holds no content, so one cached handler
serves every story: change the story and the world changes, the code does not.

## 2. Inputs

```
zen gym serve [spec…] --schema <path>… --story <path>… --docs <path>… --world <name|file>
                 │            │                │                 │                │
                 ▼            ▼                ▼                 ▼                ▼
            inputs.ts    inputs.ts       knowledge.ts       knowledge.ts       store.ts
            expandSchemas: files,        story: read,       docs: indexed      worldPath
            dirs (only files that        quoted whole in    (rag), searched
            declare swagger/openapi),    every world-agent  by both agents
            quoted globs                 prompt
                 │
                 ├──▶ spec.ts     Operation[] (dereferenced, 2020-12)  → router, validate, probes
                 └──▶ catalog.ts  rag graph (bundled, named types)     → TS briefs, graph tools,
                                                                         record types, references
```

Nothing in the interface mentions indexes: the API graph is built in memory, and
the docs index lives under `<cache>/indexes/`, keyed by the docs' content and the
embedding model, if `--embedding` asked for one (by default there is none, and
the docs are searched by wording through the index's full-text half). `serve` and `build`
both index everything **before** anything else happens; `build` then writes
every handler and exits.

## 3. Threads

```
 main thread (the server process)                    worker thread
 ────────────────────────────────                    ─────────────
 server.ts    HTTP: route, check, answer
 cache.ts     which handler; builds, one at a time
 generate.ts  handler agent ─── model calls ─▶ LLM
 synth.ts     world agent   ─── model calls ─▶ LLM
 box.ts       talks to the worker ◀── messages ──▶  worker.ts + runtime.ts
                                                     imports handler.ts, runs handle(req, ctx)
                  │                                          │
                  └────────── world.sqlite (WAL) ────────────┘
                         both open the same file
```

Agents, the model and the keys stay on the main thread. The worker has an empty
environment and runs model-written code only; a handler stuck in a loop costs one
request and a worker restart.

## 4. File map

| File                               | Role                                                                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| [command.ts](./src/command.ts)     | `zen gym serve / build / cache / world / model`; flags, narration                                                       |
| [quiet.ts](./src/quiet.ts)         | Quiets LanceDB's logger before anything loads it                                                                        |
| [setup.ts](./src/setup.ts)         | Credentials → model → inputs → catalog → embedding → knowledge → world → bindings → box → cache                         |
| [inputs.ts](./src/inputs.ts)       | `--schema` expansion (files, directories, globs); keeps story/docs and API documents apart                              |
| [spec.ts](./src/spec.ts)           | Documents → `Operation[]`; handler key (`CONTRACT_VERSION`, shape without annotations)                                  |
| [schema.ts](./src/schema.ts)       | OpenAPI 3.0 / Swagger 2 → JSON Schema 2020-12                                                                           |
| [router.ts](./src/router.ts)       | Method + path (+ pinned query) → operation; clash errors                                                                |
| [validate.ts](./src/validate.ts)   | Ajv checks for path, query, body and response                                                                           |
| [catalog.ts](./src/catalog.ts)     | The documents as `@zenera/rag` reads them: TS declarations, validators, graph tools, record types, carriers, references |
| [knowledge.ts](./src/knowledge.ts) | Story (inlined) and docs (indexed, searched, recalled); text-only fallback                                              |
| [store.ts](./src/store.ts)         | `WorldStore`: SQLite records + meta, snapshots, leases; world paths, listing                                            |
| [bindings.ts](./src/bindings.ts)   | Type → collection + id field, add-only, machine-wide                                                                    |
| [runtime.ts](./src/runtime.ts)     | The `ctx` a handler gets; type → collection resolution; structural `where`; paging                                      |
| [worker.ts](./src/worker.ts)       | Worker entry: imports a handler, builds `ctx`, relays synthesis, reports what was used                                  |
| [box.ts](./src/box.ts)             | Host side of the worker: run, timeouts paused while an agent works, restart on hang                                     |
| [agents.ts](./src/agents.ts)       | Runs a `@zenera/neo` agent with a tool budget, early stop, HTML report                                                  |
| [generate.ts](./src/generate.ts)   | The handler agent: brief, siblings, tools, `test_handler`, the judge, binding checks                                    |
| [prompt.ts](./src/prompt.ts)       | The handler contract (`SYSTEM`), per-operation brief, repair brief                                                      |
| [probe.ts](./src/probe.ts)         | Probe requests, the echo rule, page-walk helpers                                                                        |
| [synth.ts](./src/synth.ts)         | `World`: the world agent, its tools, dependents, dangling references, locks and leases, sampled fallback                |
| [fake.ts](./src/fake.ts)           | Schema sampler: content for judging and fallbacks                                                                       |
| [cache.ts](./src/cache.ts)         | Handlers in the shared cache with the bindings they used; one build per operation, across processes                     |
| [server.ts](./src/server.ts)       | The HTTP pipeline, regeneration, pagination backstop                                                                    |
| [paging.ts](./src/paging.ts)       | Recognising paged operations; cutting looping tokens                                                                    |
| [logger.ts](./src/logger.ts)       | Log lines, request dumps, build reports                                                                                 |
| [page.ts](./src/page.ts)           | The `GET /` contents page                                                                                               |

## 5. One request

```
client          server.ts            cache.ts          box.ts / worker.ts        synth.ts
  │  GET /x/{id}     │                   │                    │                    │
  │─────────────────▶│ route, validate   │                    │                    │
  │                  │ ensure(op) ──────▶│ hit (bindings still │                    │
  │                  │                   │   agree) or build §6│                    │
  │                  │ run(key, req) ───────────────────────▶ │ handle(req, ctx)   │
  │                  │                   │                    │ ctx.lookup('Thing')│
  │                  │                   │                    │  → bindings: things│
  │                  │                   │                    │  → missing ───────▶│ world agent §7
  │                  │                   │  (handler clock    │◀── records ────────│ (stored first)
  │                  │                   │   paused)          │                    │
  │                  │◀───────────────────── outcome ─────────│                    │
  │                  │ ok + status    → that status (ctx.fail)                     │
  │                  │ agentFault     → 502, never a rebuild                       │
  │                  │ fault/mismatch → rebuild with a repair brief, run again     │
  │                  │ ok             → validate, page backstop                    │
  │◀─────────────────│ 200 + body                                                  │
```

## 6. Writing a handler

```
cache.ensure(op) ── miss ──▶ lease build:<key> (machine-wide; another process waits, then reads)
                                 │
                                 ▼
  brief:  operation as TypeScript (catalog.describe)
          "this operation is about `Thing` records" (catalog.itemType: unwraps list envelopes)
          RELATED OPERATIONS, closest first: same record type, same resource,
              carriers traced through the graph, nearby paths — [built] marked
          WHERE TYPES LIVE: the bindings
          FROM THE REFERENCE DOCUMENTS: recalled passages about the operation
          THE WORLD SO FAR
  tools:  read_handler, list_operations, list_collections, read_collection,
          describe_types, trace_api, grep_api, list_api, find_types_with_property,
          search_docs, grep_docs, list_docs, read_docs, test_handler
                                 │ test_handler(source)
                                 ▼
          write it under a candidate key of its own, never the live one
          snapshot the world → scratch copy; run probes there (probe: true → fake.ts content)
          judge: runs? a body, not ctx.fail? response schema? echo rule? page walk?
          placement: every (collection, type, idField) the runs touched —
              untyped collection → refused; unknown type → refused;
              disagrees with a binding → refused; two ways in one handler → refused
                                 │
              pass ──────────────┴────────────── fail
       bind new types; keep the source        problems back to the agent;
       with the bindings it used; write       after --attempts: BuildFailed + report
       it to the live handler.ts              (the candidate file is deleted either way)
```

## 7. Writing the world

```
handler (worker)                   box.ts (host)            synth.ts World
  ctx.ensure('Event', { where })      │                          │
  first read of (collection, where),  │                          │
  or fewer than min ──▶ 'synthesize' ─▶ hook ──────────────────▶ │ probe → fake.ts
                                      │  (clock paused)          │ lock (db, collection)
                                      │                          │ lease fill:<col>:<where|ids>
                                      │                          │   (other processes wait,
                                      │                          │    then read what was made)
                                      │                          │ ready already? → return
                                      │            ┌─────────────▼──────────────┐
                                      │            │ world agent                │
                                      │            │ instructions: STORY whole; │
                                      │            │   REFERENCE DOCUMENTS;     │
                                      │            │   rules: agree with story, │
                                      │            │   docs, world; never point │
                                      │            │   at what does not exist   │
                                      │            │ brief: type as TS, ids /   │
                                      │            │   "what the story says     │
                                      │            │   exists", REFERENCES,     │
                                      │            │   OTHER TYPES, recalled    │
                                      │            │   passages, the world      │
                                      │            │ tools: docs tools,         │
                                      │            │   list/read_collection,    │
                                      │            │   describe_types,          │
                                      │            │   save_records({type?})    │
                                      │            └─────────────┬──────────────┘
                                      │                          │ requested records → its collection
                                      │                          │ save_records({type}) → that type's
                                      │                          │   collection (bound if new);
                                      │                          │   not marked populated
                                      │                          │ check: references that name a type
                                      │                          │   and point at nothing → reported
                                      │◀────────── records ──────│ short of what was required → sampled
   re-reads ctx.db ◀──── 'synthesized'│                          │
```

- `ctx.lookup(Type, id)` asks for exactly that id; `ctx.ensure(Type, …)` asks
  for a population. A collection that only holds what clients wrote is not
  _populated_ until its first read fills it as the story has it.
- `where` matches structurally: scalars as text, objects as subsets, a scalar
  against a list as membership.
- `ctx.owner()` is the `accounts` record `@me`, shaped by gym (no document
  declares it). Handlers resolve `me` / `primary` / `self` through it.

## 8. The worker

```
 host (box.ts)                                   worker (worker.ts)
 run ── { type: 'run', id, file, version,     ──▶ import(file?v=version)
          db, input, bindings }                    ctx = createContext(input, store,
 start timer (--timeout)                                   synthesize, bindings, record)
 pause  ◀── { type: 'synthesize', id, call,  ◀──── await handle(input, ctx)
              db, request }                         │
 World.synthesize(...)                              │
 resume ── { type: 'synthesized', … }        ──▶   │
 settle ◀── { type: 'done', id, ok,           ◀────┘ body | HttpError(status) | throw
              value|status|fault, used[] }          used: every (collection, type, idField)
 release(db) ── { type: 'close', db }         ──▶ close a snapshot's connection
```

`runtime.ts` and `store.ts` load inside the worker, so they import only `node:`
built-ins and `randexp`, and use only erasable TypeScript.

## 9. Bindings

```
handler names a type ── ctx.lookup('Message', id) ──▶ resolve():
                                                        bound?   → binding's collection, idField
                                                        unbound? → collectionFor('Message') = 'messages'
                                                        lowercase name → a collection; its type
                                                                         from the bindings, if any
judge: placement(used) ──▶ conflicts? refused : new pairs bound on a pass
cache: stored { source, meta, bindings } ──▶ on a hit, any disagreement → miss (rebuilt);
                                              a cleared store is refilled from its handlers
world agent: save_records({ type }) ──▶ binds a type nobody has used yet
```

Bindings are add-only and live in the machine-wide cache (`gym-bindings`), keyed
by the documents' type names — the same documents share them from anywhere, like
their handlers.

## 10. Several processes

```
 zen gym serve mail.yaml --story w.md        zen gym serve calendar.yaml --story w.md
          │ :8787                                      │ :8788
          ▼                                            ▼
   <cache>/worlds/story-<digest(w.md)>.sqlite  ◀── same file ──▶  (or --world <name|file>)
       records(collection, id, data, updated_at)
       meta(key, value):  populated:<collection>:<where>
                          lease:fill:<collection>:<where|ids>     one world agent per fill
 ~/.zenera/neo/cache/gym-handler/leases.sqlite:
                          lease:build:<key>                       one handler build per key
 ~/.zenera/neo/cache/gym-bindings/…                               one set of bindings
```

A lease lapses when its time is up or its process is gone, so a crash never
costs anyone the whole lease.

## 11. On disk

```
~/.zenera/neo/
├── gym.json                          stored chat and embedding models
├── cache/
│   ├── gym-handler/<ab>/<sha>.json   handler source + meta + bindings used, by operation key
│   ├── gym-handler/leases.sqlite     build leases
│   ├── gym-bindings/<ab>/<sha>.json  type → collection, by the documents' type names
│   ├── vectors/, docs-parse/         @zenera/rag's shared caches (docs embeddings, parses)
└── gym/                              --cache (default)
    ├── handlers/<key>/handler.ts     what the worker runs (a copy of the cache)
    ├── handlers/<key>-…-candidate/   a candidate while it is judged, deleted after
    ├── indexes/docs-<digest>-<model>/  the docs index
    ├── worlds/<name>.sqlite          worlds (data: `cache clear` keeps them)
    ├── scratch/                      judging snapshots, deleted after each test
    ├── reports/<time>-<agent>-<label>.html   every agent run
    ├── builds/<time>-build-….md      failed or retried builds
    └── requests/<time>-….md          request dumps (or --requests-dir)
```

## 12. Keys

```
handler   = sha256(CONTRACT_VERSION, method, path, operationId, parameters,
                   request and response schemas without annotations, paging)
            + the bindings it used, checked on every hit
bindings  = sha256(the documents' type names)
docs idx  = sha256(docs content) + embedding model
world     = --world <name|file>  |  sha256(story content)  |  default
not keyed : the model, the story and docs (for handlers), the file a spec came from
```

Nothing is ever invalidated: a changed input is a different key, and the old
artefact is simply never looked up again.

## 13. When things fail

| What failed                                      | Answer                        | Rebuilds the handler?              |
| ------------------------------------------------ | ----------------------------- | ---------------------------------- |
| Request does not match the document              | 400 / 404 / 405               | no                                 |
| Two documents define the same route              | refuses to start, names both  | —                                  |
| Handler build never passed the judge             | 501 + build report link       | no (remembered for the process)    |
| Model unreachable while building                 | 500                           | no (retried on the next request)   |
| Handler threw, timed out, or answered off-schema | rebuilt with a repair brief   | yes, up to `--regen-limit` per URL |
| Handler chose `ctx.fail(status)`                 | that status and body          | no                                 |
| World agent failed inside a handler              | 502 `WORLD_AGENT_FAILED`      | no                                 |
| World agent made fewer than required             | sampled records fill in       | no                                 |
| A made record points at nothing                  | reported in the narration     | no                                 |
| Embedding the docs failed                        | docs searched by wording only | —                                  |
| Worker could not start                           | 503                           | no                                 |
| Client loops past the last page                  | token cut, items emptied      | no                                 |
