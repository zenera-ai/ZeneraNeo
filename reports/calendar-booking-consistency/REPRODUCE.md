# Reproduce the saved observation

The deterministic reproduction is the two Node commands in [README.md](README.md). They read the included capture and replay its generated handlers without a model, network or container. A fresh model-generated world is a different experiment and may not reproduce the same handlers. No seed was explicitly set in the original run.

## Original service configuration

The service ran from revision `00d1017e9becfbb03bb3f5586d1518f8cd96e2b2` in a rootless Podman container, with Node 24.22.2. The container image ID was `67baaa09255e5ae767d3d7ba03ae63e8d440548060ce83ac3103fbed8670fd24`. These were the service arguments inside that container. `<run-id>` replaces the machine-specific session identifier.

```sh
zen gym serve \
  --schema /opt/zenera/examples/mock-apis/specs/calendar.yaml \
  --story /opt/zenera/examples/mock-apis/stories/northwind-launch.md \
  --docs /opt/zenera/examples/mock-apis/kb \
  --model openai/responses:gpt-4.1-mini-2025-04-14 \
  --embedding none --host 0.0.0.0 --port 8787 \
  --cache /runtime/sessions/<run-id>/gym \
  --world booking-lab \
  --requests-dir /runtime/sessions/<run-id>/requests
```

The host published that port on loopback only. The agent used the same container's private address. The helper verified the container's saved run label and assigned IP before launching the agent. Credentials were supplied separately on the host, not through the project or transcript.

For another machine, build and configure that source revision, adapt the repository and runtime paths, and use a new isolated cache/world. Do not reuse the incident world or expect a seed alone to reproduce model-written handler source. The shown configuration records the original run. A fresh live run from this document has not been performed as part of the offline review.

## Agent and tool

[reproduction/](reproduction/) contains the original agent configuration, system prompt and calendar client. Copy it to a separate working directory. Copy the pinned repository's `examples/mock-apis/specs/calendar.yaml` into that project's `assets/specs/calendar.yaml`. Set `CALENDAR_API_BASE_URL` on the host to the private address of the intended mock, reachable from the agent container. The client accepts only a literal loopback/private IP origin and refuses redirects.

The original commands, with machine paths replaced, were:

```sh
zen run --project <booking-agent-directory> --new --no-keys
zen run --project <booking-agent-directory> --session <existing-session-id> --no-keys
```

The second command resumed the same conversation. It did not start a fresh calendar. `agents.yaml` also sets `sandbox.keys: false`. The client is mounted as a read-only asset. It records a request, response text and parsed body, elapsed time and errors. It never retries a create automatically.

The five controlled user prompts, actual tool commands, outputs and agent answers are in [agent-excerpts.json](agent-excerpts.json). Use them as a sequence to adapt in an isolated mock, waiting for human confirmation before creation. Do not copy the recorded job ID `job-25df2d` or the 256-character ID-length assertion into a fresh run. Recover that run's actual job output and use its returned event ID, which can have a different length. The final existing event ID in this capture came from the completed create command's saved output. `capture.beforeCreate` preserves the records from earlier exploration that formed this run's baseline.

## Snapshot method and store identity

The snapshots were read from the running service container, after checking its saved session label. The database path was the service's own cache directory plus `worlds/booking-lab.sqlite`. All four original snapshots carry the same saved session ID. The published capture omits machine paths and retains the original snapshot hashes.

Each snapshot opened that database with Node's `DatabaseSync(path, { readOnly: true })` and used one read transaction:

```sql
BEGIN;
SELECT collection, id, data, updated_at
FROM records ORDER BY collection, id;
SELECT key, value FROM meta
WHERE key LIKE 'populated:%' ORDER BY key;
COMMIT;
```

The helper then fingerprinted existing handler-build report files. It made no calendar HTTP request. This reads SQLite's live WAL view. Copying only the main `.sqlite` file can miss committed WAL data and is not an equivalent snapshot. For a portable database copy, use SQLite's backup facilities or the repository's `WorldStore.snapshot`, which uses `VACUUM INTO`.

The offline diagnostic cannot authenticate a capture's origin. The caller must establish that snapshots came from the authoritative store serving the HTTP requests. A stale copy or different world can make an absence conclusion meaningless. Any read returning an event absent from the supplied snapshots is therefore inconclusive.

## Capture format

`capture.json` is the executable example. Fields are:

| Field                     | Meaning                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `formatVersion`           | Must be `1`                                                                                                                     |
| `create`, `list`, `get`   | Each has `startedAt`, nonnegative `elapsedMs`, `request`, and `response`                                                        |
| `request`                 | HTTP method, encoded path, parsed query object and create body. Optional `target` preserves the complete encoded path and query |
| `response`                | Integer HTTP status and parsed body. Optional `bodyText` preserves the raw JSON text                                            |
| `beforeCreate`            | Complete pre-create snapshot, required to classify absence from snapshots or claim the ID was new                               |
| `beforeRead`, `afterRead` | Required complete snapshots before list/GET and after GET                                                                       |
| `afterList`               | Optional intermediate snapshot, used when present to detect changes later reversed                                              |
| Snapshot contents         | `complete: true`, `observedAt`, and `records` with `collection`, `id`, parsed object `data`, and `updated_at`                   |
| `provenance`              | Source, model, seed configuration, story, schema and captured handler hashes                                                    |

The request and snapshot clocks must be comparable. Successful writes precede the pre-read snapshot. Listing precedes the exact-ID GET. The final snapshot follows both. Record counts are retained even when changes prevent a stable-state diagnosis.

The supported verdicts are `visible`, `persisted_omitted_from_list`, `absent_from_snapshots` and `inconclusive`. The absence verdict means absence at the observed boundaries, not proof that the write never occurred. Unsupported or contradictory input produces an inconclusive result, or an input error for a malformed capture.

## What would make the next investigation faster

Use the existing Gym request dumps to retain request/response evidence. Add the serving-world identity, returned event ID and agent-run ID to the case. Preserve `x-gym-operation`, `x-gym-cache`, the request seed and phase timings if available, excluding credentials and other sensitive headers. These headers were not captured by the original client and are not reconstructed here.

Three insert-handler build-report filenames fall inside the recorded 15.706-second create interval. That supports investigating on-demand generation as part of the delay. It does not measure each phase or establish that all of the delay was model time. A create timeout or pending job should lead to recovery of the existing attempt's result before any new write.
