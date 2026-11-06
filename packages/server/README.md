# @zenera/server

One user's chats with a project, over HTTP: the server the agent image runs.
Each turn opens the project with [`@zenera/engine`](../engine), streams its
events as [AG-UI](https://docs.ag-ui.com), and runs the agents' commands in a
[`BwrapSandbox`](../sandbox): bubblewrap inside the container, with nothing of
the server's environment, state or socket visible to them.

```sh
zen server start --user ann                       # unix:/state/server.sock
zen server start --user ann --port 3000           # tcp:127.0.0.1:3000
zen server check --user ann                       # could it start here?
zen server status                                 # a running one's report
```

```ts
import { createServer } from '@zenera/server';

const server = createServer({
    projectId: 'p1',
    projectDir: '/project',
    stateDir: '/state',
    user: { id: 'ann', email: 'ann@acme.com' },
});
await server.listen({ socket: '/state/server.sock' });
```

## No authentication, by design

The server has no notion of callers. It serves **its one user** (named by its
host: `--user` / `ZEN_USER_ID`, `ZEN_USER_EMAIL`, `ZEN_USER_ROLE`) to whoever
can reach it, and who can reach it is the host's to decide:

- **Unix socket** (the default): owner-only (`0600`, in a `0700` directory),
  and its directory is hidden from every sandboxed command, so an agent cannot
  call its own server.
- **TCP**: only when asked, loopback unless a host is named (with a warning:
  anything that reaches it acts for the user).
- **In front of it**, whatever the deployment needs: in ZeneraLite a guard that
  checks zenera-app's per-request tokens and forwards to the socket; on a single
  box a reverse proxy with its own login.

Authentication can then change without touching the server.

## Routes

| Route                                            | What                                                          |
| ------------------------------------------------ | ------------------------------------------------------------- |
| `GET /healthz`                                   | For probes                                                    |
| `GET /api/status`                                | Versions, sandbox (and why not), image identity, state layout |
| `GET /api/activity`                              | Whether a run is going, for idle stop                         |
| `GET /api/sessions/:tid`                         | The chat so far, as AG-UI events                              |
| `POST /api/sessions/:tid/runs`                   | A turn (or AG-UI `resume` entries), streamed as SSE           |
| `GET /api/sessions/:tid/runs/:runId/events`      | Follow a run, or replay one that ended                        |
| `POST /api/sessions/:tid/runs/:runId/cancel`     | Stop it                                                       |
| `DELETE /api/sessions/:tid`                      | The thread and its files                                      |
| `/api/sessions/:tid/{runs,…/trace,memory}` debug | With `debug: true` only: recorded runs, traces, memory graph  |

A thread id is one path segment (letters, digits, `_`, `-`). A run belongs to
the server, not the request: it goes on when the caller leaves and can be
followed again. An `x-zenera-mcp-token` header on a run is handed to the run's
MCP plugin (`ZEN_PLUGINS`, `ZEN_MCP_BROKER_URL`).

## State

```
<state>/state.json            layout version, project, user — refused if not this server's
<state>/server.sock           the default socket
<state>/data/sessions/<tid>/  one zen session per thread (its workspace inside)
<state>/data/runs/<tid>/      each run's AG-UI events and record
<state>/data/memory/          the user's memory graph
```

`zen server check` only reads `state.json`; the server writes it on start.

## Sandbox

`'bwrap'` by default: the state directory, the socket's directory, `/state` and
`/run/secrets` are never visible to commands. `sandbox: 'podman'` gives the
engine's own default instead, as `zen run` has it. `zen server start` refuses
to listen when commands cannot be isolated, when the image was built for
another project environment (`ZEN_IMAGE_BUILD` / `ZEN_IMAGE_BASE`), or when the
state is not this user's.

Model keys come from the environment, as for any run.
