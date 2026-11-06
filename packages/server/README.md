# @zenera/server

A project's chats over HTTP: the server the agent image runs, for the one user
its container belongs to. Each turn opens the project with
[`@zenera/engine`](../engine), streams its events as
[AG-UI](https://docs.ag-ui.com), and runs the agents' commands in a
[`BwrapSandbox`](../sandbox) — bubblewrap inside the container, with nothing of
the server's environment or state visible to them.

```sh
zen server start --project /project --state /state --user u1   # what the image runs
zen server check                                                # could it start here?
zen server status --url http://localhost:3000                   # a running one's report
```

```ts
import { createServer } from '@zenera/server';

const server = createServer({
    projectId: 'p1',
    projectDir: '/project',
    stateDir: '/state',
    userId: 'u1',
    auth: { mode: 'token', token: process.env.ZEN_SERVER_TOKEN! },
});
await server.listen(3000);
```

## Routes

| Route                                            | What                                                          |
| ------------------------------------------------ | ------------------------------------------------------------- |
| `GET /healthz`                                   | Open, for probes                                              |
| `GET /api/status`                                | Versions, sandbox (and why not), image identity, state layout |
| `GET /api/activity`                              | Whether a run is going, for idle stop                         |
| `GET /api/sessions/:tid`                         | The chat so far, as AG-UI events                              |
| `POST /api/sessions/:tid/runs`                   | A turn (or AG-UI `resume` entries), streamed as SSE           |
| `GET /api/sessions/:tid/runs/:runId/events`      | Follow a run, or replay one that ended                        |
| `POST /api/sessions/:tid/runs/:runId/cancel`     | Stop it                                                       |
| `DELETE /api/sessions/:tid`                      | The thread and its files                                      |
| `/api/sessions/:tid/{runs,…/trace,memory}` debug | With `debug: true` only: recorded runs, traces, memory graph  |

Thread ids are UUIDs. A run belongs to the server, not the request: it goes on
when the caller leaves and can be followed again.

## Auth

- **`jwt`** — zenera-app signs an EdDSA token per request (`iss: zenera-app`,
  `aud: zenera-runtime`, `prj`, `req: "<METHOD> <url>"`, `sub`, `thr`, `role`);
  the server holds only the public key. A single-user server refuses a token
  for anyone but its user.
- **`token`** — one bearer token, for a host with no zenera-app (ZeneraSrv, a
  laptop). The caller is the server's user, as owner.

## State

Everything it writes is under `stateDir`, described by `state.json`: layout
version, project, and mode — `single` with its user, or `shared`. A server
refuses a newer layout, another project, the other mode, or another user's
directory. `zen server check` only reads it; the server writes it on start.

```
<state>/state.json
<state>/data/sessions/<tid>/   one zen session per thread (its workspace inside)
<state>/data/runs/<tid>/       each run's AG-UI events and record
<state>/data/memory/           the user's memory graph
```

Without a `userId` it serves any user a token names, each under
`<state>/users/<id>/` instead of `data/` — a project pod shared by its users.

## Sandbox

`bwrapSandbox` by default; `sandbox: 'podman'` gives the engine's own default
instead, as `zen run` has it. `zen server start` refuses to listen when commands
cannot be isolated, when the image was built for another project environment
(`ZEN_IMAGE_BUILD` / `ZEN_IMAGE_BASE`), or when the state layout is unknown.

Model keys come from the environment, as for any run.
