# @zenera/server

One user's chats with a project, over HTTP: the server the agent image runs.
Each turn opens the project with [`@zenera/engine`](../engine), streams its
events as [AG-UI](https://docs.ag-ui.com), and runs the agents' commands in a
[`BwrapSandbox`](../sandbox): bubblewrap inside the container, with nothing of
the server's environment or state visible to them.

```sh
zen server start --user ann                       # the project you are in, as zen run
zen server start --user ann --host 0.0.0.0        # in a container
zen server check --user ann                       # could it start here?
zen server status                                 # a running one's report
```

```ts
import { createServer } from '@zenera/server';

const server = createServer({
    projectId: 'p1',
    projectDir: '/project',
    sessionsDir: '/state/sessions',
    memoryDir: '/state/memory',
    user: { id: 'ann', email: 'ann@acme.com' },
    token: process.env.ZEN_SERVER_TOKEN!,
});
await server.listen({ port: 3000, host: '0.0.0.0' });
```

## One token, no identity

Who the server is for is its host's to say: **one user**, `--user` /
`ZEN_USER_ID` (`ZEN_USER_EMAIL`, `ZEN_USER_ROLE`). No request can name another.

Every request but `/healthz` carries `Authorization: Bearer <token>`, the one
token the host gave it (`ZEN_SERVER_TOKEN`; `zen server start` otherwise makes
`<zen home>/servers/<project>/<user>.token`, owner-only, and `zen server status`
reads it there).
The token names nobody: it only proves the caller may reach this server.
Logging people in and deciding who may use which server happen in front of it
— zenera-app in ZeneraLite, which keeps one token per user's pod; a proxy on
ZeneraSrv — so that can change without the server.

Sandboxed commands share the container's network, so they can reach the port;
they cannot see the token (it is in neither their environment nor their view of
the filesystem: the zen home is hidden), so they are refused.

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

## Sessions, workspace, memory — as `zen run`

A chat thread is a session, kept the way `zen run` keeps its own, and opened
the way `zen run` opens one:

```
<sessions>/<thread id>/.data/        the session's state (its conversation)
<sessions>/<thread id>/runs/         the engine's record of each run
<sessions>/<thread id>/workspace/    what the agent reads and writes, unless `workspace`
<sessions>/<thread id>/agui/         each run's AG-UI events (never in the sandbox's view)
```

| Setting       | `zen server`                                  | Default                                  | In the agent image |
| ------------- | --------------------------------------------- | ---------------------------------------- | ------------------ |
| `sessionsDir` | `--sessions`, `$ZEN_SESSIONS_DIR`             | `<project>/sessions`                     | `/state/sessions`  |
| `workspace`   | `--workspace`, `--here`, `$ZEN_WORKSPACE_DIR` | each session's own                       | each session's own |
| `memoryDir`   | `--memory`, `$ZEN_MEMORY_DIR`                 | the project's (`memory:` in agents.yaml) | `/state/memory`    |

The image's project is read-only, so what it writes goes to `/state`.

## Sandbox

Chosen once, at start:

- **podman** — anywhere but the agent image, as `zen run`: a container per
  session on this machine. `zen server start` readies podman as `zen run` does
  (the machine started, without asking), and a turn pulls or builds the image
  it needs.
- **bwrap** — inside the agent image, which ships `/opt/zenera/bin/bwrap` and is
  itself the container: each command under bubblewrap, with the other sessions,
  the memory, the zen home, `/state` and `/run/secrets` kept from it.

`--sandbox` or `$ZEN_SERVER_SANDBOX` overrides the choice; `createServer` takes
`sandbox: 'podman' | 'bwrap' | factory` (default: the same choice) and an
optional `preflight`. A sandbox plugin in `ZEN_PLUGINS` never replaces it.

`zen server start` refuses to listen when commands have nowhere to run (podman
not answering, bwrap unable to isolate), when the image was built for another
project environment (`ZEN_IMAGE_BUILD` / `ZEN_IMAGE_BASE`).

Model keys come from the keyring (`zen key …`) and the environment, as for any
run; in the agent image, the environment.
