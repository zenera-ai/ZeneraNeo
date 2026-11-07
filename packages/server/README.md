# @zenera/server

A project's chats over HTTP, for every user its host vouches for: the server
the agent image runs. Each turn opens the project with
[`@zenera/engine`](../engine), streams its events as
[AG-UI](https://docs.ag-ui.com), and runs the agents' commands in a sandbox —
under bubblewrap inside the agent image, with podman anywhere else, as `zen run`.

```sh
zen server start --insecure                            # try it here: tokens read, not checked
zen server token --user ann                            # a token such a server takes
zen server start --jwt-public-key app.pub.pem          # behind zenera-app
zen server start --container --insecure                # in the project's agent image, under bwrap
zen server check                                       # could it start here?
zen server status                                      # a running one's report
```

With `--insecure`, startup prints a ready-to-open `file://` link to a bundled
React chat page. It includes the server address and an unsigned JWT in the
fragment (not a query parameter); the page removes the fragment and keeps the
token only in memory. The default browser user is `local`; use `--user ann` to
test another user's sessions. The same works with `--container`: the outer CLI
prints the host's file path and published port, not paths inside the container.

The HTML contains its JavaScript, React components and CSS; it needs no frontend
server or CDN. It reuses ZeneraLite's chat messages, composer, tool cards and
AG-UI reducer. It lists sessions, loads history, streams turns, follows active
runs, cancels runs and deletes sessions. Connected-account actions still need
zenera-app. Reopen the printed link after a page reload, or paste a dev JWT into
the connection form: tokens are deliberately not saved in browser storage.

Local files send `Origin: null`. Only insecure servers allow that origin and
its GET/POST/DELETE preflights with Authorization and JSON headers; actual API
requests still require a token. Secure servers do not enable this CORS access.
A browser may ask you to allow local-network access.

```ts
import { createServer } from '@zenera/server';

const server = createServer({
    projectId: 'p1',
    projectDir: '/project',
    root: '/state',
    auth: {
        mode: 'jwt',
        publicKey: process.env.ZEN_SERVER_JWT_PUBLIC_KEY!,
        issuer: 'zenera-app',
        audience: 'zenera-runtime',
    },
});
await server.listen({ port: 3000, host: '0.0.0.0' });
```

## Who is calling: a JWT per request

Every request but `/healthz` carries `Authorization: Bearer <jwt>`, signed by the
host (zenera-app) for that one request with its Ed25519 key. The server holds
only the public key (`--jwt-public-key <file>` or `$ZEN_SERVER_JWT_PUBLIC_KEY`),
so neither it nor a sandboxed command that reaches its port can make one.

| Claim                   | Checked                                                                     |
| ----------------------- | --------------------------------------------------------------------------- |
| alg                     | `EdDSA` only                                                                |
| `iss`                   | `zenera-app` (`--jwt-issuer`)                                               |
| `aud`                   | `zenera-runtime` (`--jwt-audience`)                                         |
| `iat`                   | at most 2 minutes old, 30 s of clock skew                                   |
| `prj`                   | this server's project id                                                    |
| `req`                   | `"<METHOD> <url>"` of this very request: a token seen in transit is no good |
| `sub`                   | the user, required                                                          |
| `thr`                   | when there, must be the thread in the URL                                   |
| `role`, `email`, `name` | when there, handed to the run as the user's (`zenera` library)              |

Logging people in and deciding who may use which project stay in front of the
server (zenera-app); the server only trusts what it signed.

**`--insecure`** is for trying a server on your machine: tokens are read, not
checked (any signature or none, any age, any project or request), but `sub` is
still required — `zen server token --user ann` prints one. It listens on
loopback only, and is refused inside the agent image unless whoever runs the
container says so (`ZEN_SERVER_INSECURE_LOCAL=1`, which `--container` sets while
publishing the port on loopback only).

## Root: every user in a folder of their own

```
<root>/server.json                                  {version, projectId}: this server's
<root>/users/<user>/memory/                         the user's graph, shared by their chats
<root>/users/<user>/sessions/<thread>/.data/        the session's state (its conversation)
<root>/users/<user>/sessions/<thread>/runs/         the engine's record of each run
<root>/users/<user>/sessions/<thread>/workspace/    what the agent reads and writes
<root>/users/<user>/sessions/<thread>/agui/         each run's AG-UI events
```

- `--root` / `$ZEN_SERVER_ROOT`, else `~/.zenera/neo/servers/<project>`; `/state`
  in the agent image. `server.json` makes it one project's: a root of another
  project, or of a newer layout, is refused.
- `<user>` is `sub` as it is when it is a safe path segment (a UUID lower-cased),
  else `u-<sha256>`. A thread is one path segment (letters, digits, `_`, `-`).
- **Memory seed**: the first time a user needs a memory, it is copied from the
  seed — the project's own (`memory:` in agents.yaml), `--memory-seed <dir>`, or
  none (`--no-memory-seed`, everyone starts empty). From then on it is theirs:
  their chats share it, other users never see it, and the seed is not read again.

## Routes

| Route                                            | What                                                         |
| ------------------------------------------------ | ------------------------------------------------------------ |
| `GET /healthz`                                   | For probes; no token                                         |
| `GET /api/status`                                | Versions, auth, sandbox (and why not), image identity, root  |
| `GET /api/activity`                              | Whether a run is going, for idle stop                        |
| `GET /api/sessions`                              | The caller's sessions, newest activity first                 |
| `GET /api/sessions/:tid`                         | The chat so far, as AG-UI events                             |
| `POST /api/sessions/:tid/runs`                   | A turn (or AG-UI `resume` entries), streamed as SSE          |
| `GET /api/sessions/:tid/runs/:runId/events`      | Follow a run, or replay one that ended                       |
| `POST /api/sessions/:tid/runs/:runId/cancel`     | Stop it                                                      |
| `DELETE /api/sessions/:tid`                      | The thread and its files                                     |
| `/api/sessions/:tid/{runs,…/trace,memory}` debug | With `debug: true` only: recorded runs, traces, memory graph |

Every session route is the caller's own: `:tid` is looked up under their folder.
The list returns `{ sessions: [{ id, title, createdAt, updatedAt, running }] }`;
`running` is `{ runId }` or `null`, and titles come from the engine's session
metadata (falling back to the ID). A thread-scoped token lists only its thread.
Listing does not create sessions or memory. A new session is still created on
its first turn.

A run belongs to the server, not the request: it goes on when the caller leaves
and can be followed again. At most `maxRuns` (`ZEN_RUNTIME_MAX_RUNS`, 4) run at
once, `maxUserRuns` (`ZEN_RUNTIME_MAX_USER_RUNS`, 2) per user. An
`x-zenera-mcp-token` header on a run is handed to the run's MCP plugin
(`ZEN_PLUGINS`, `ZEN_MCP_BROKER_URL`).

## Sandbox

Chosen once, at start:

- **podman** — anywhere but the agent image, as `zen run`: a container per
  session on this machine. `zen server start` readies podman as `zen run` does,
  and a turn pulls or builds the image it needs.
- **bwrap** — inside the agent image, which ships `/opt/zenera/bin/bwrap` and is
  itself the container: each command under bubblewrap. Commands see the image
  (what the project's `sandbox/Dockerfile` installed, with its `ENV`), their own
  workspace and home, and the `zenera` library; never the root (other chats,
  other users, memories), the seed, the zen home, the project (its `.env`), the
  server's install, `/state` or `/run/secrets`.

`--sandbox` or `$ZEN_SERVER_SANDBOX` overrides the choice; `createServer` takes
`sandbox: 'podman' | 'bwrap' | factory` and an optional `preflight`. A sandbox
plugin in `ZEN_PLUGINS` never replaces it.

The `zenera` library (Python and Node: `identity()`, `require_identity()`) is one
shared read-only directory mounted at `/opt/zenera/runtime` for every session —
built into the agent image, or written once per content under the zen home.

`zen server start` refuses to listen when commands have nowhere to run (podman
not answering, bwrap unable to isolate), when the image was built for another
project environment (`ZEN_IMAGE_BUILD` / `ZEN_IMAGE_BASE`), or when the root is
another project's.

## `--container`

`zen server start --container` runs the server in the project's agent image on
this machine, with podman:

1. The project's sandbox image is readied as for `zen run` (`sandbox/Dockerfile`).
2. The agent image is built on it: this zen's packages (`npm pack` of the ones
   installed), Node in `/opt/zenera`, a static bwrap, the `zenera` library, the
   sandbox image's `ENV` (so commands get it under bwrap). Tagged
   `localhost/zenera-agent:<hash>`; built again only when something changed, or
   with `--rebuild`.
3. `podman run`: the project read-only at `/project`, the root at `/state`, the
   port published on `--host` (loopback by default), the auth flags and model
   keys passed through (by name; credential files are not), logs followed;
   Ctrl-C stops it.

The server runs as numeric UID/GID **10001**, with `HOME=/home/zenera`, not
as root or as the sandbox base image's `USER`. Commands inherit that UID unless
the project's sandbox config explicitly selects another user. Rootless podman
uses `--userns keep-id:uid=10001,gid=10001`: existing host-owned state stays
writable, without changing its ownership. With rootful podman, the host must
provide a state directory writable by UID/GID 10001; ownership is not changed
automatically. Project and seed mounts must also be readable by that user.
The container drops all capabilities and disables privilege escalation;
bwrap uses unprivileged user namespaces.

For Kubernetes, set `runAsNonRoot: true`, `runAsUser: 10001`,
`runAsGroup: 10001`, `fsGroup: 10001` for the state PVC, and
`allowPrivilegeEscalation: false` with all capabilities dropped. The node's
security policy must allow bwrap's unprivileged user namespaces; startup
reports a failed probe rather than running commands without isolation.

Model keys come from the keyring (`zen key …`) and the environment, as for any
run; in the agent image, the environment.

## Rebuilding the standalone page

The source and build live in ZeneraLite's `services/zenera-app`. Run there:

```sh
npm run build:chat -- --output /path/to/ZeneraNeo/packages/cli/assets/chat.html
```

Without `--output`, the result is `dist/chat.html`, which can be copied to
ZeneraNeo. The CLI package includes the compiled asset; ZeneraNeo needs no
frontend build dependencies.
