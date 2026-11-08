<div align="center">
  <img
    src="https://raw.githubusercontent.com/zenera-ai/ZeneraNeo/main/docs/imgs/zenera-logo-with-media-queries.svg"
    alt="Zenera"
    width="24"
  />
  <div>Powered By Zenera</div>
  <br>
  <img
    src="https://raw.githubusercontent.com/zenera-ai/ZeneraNeo/main/docs/imgs/banner-server-with-media-queries.svg"
    alt="ZENERA SERVER"
    width="918"
  />

[![npm](https://img.shields.io/npm/v/@zenera/server.svg)](https://www.npmjs.com/package/@zenera/server)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/zenera-ai/ZeneraNeo/blob/main/LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A524-brightgreen.svg)](https://nodejs.org)

[Quickstart](#quickstart) · [Secure setup](#secure-setup) · [Commands](#commands) · [Options](#common-options) · [HTTP API](#http-api)

</div>

# `@zenera/server`

Serve a ZeneraNeo project's chats over HTTP. Each user has private sessions and
memory; agent commands run in Podman sandboxes, or under bwrap in an agent container.
Requires Node.js 24+ and the [Zenera CLI](../cli/README.md).

## Quickstart

For local testing, run the server in the configured project's agent container:

```sh
zen server start --insecure --container --user andrey
```

Open the printed HTTP `/chat` link to list sessions, send messages, follow active
runs, cancel them, or delete a session. `--user` selects the development JWT's
subject, not a server-wide user. The default is `local`.

**Insecure mode is for local testing only:** anyone who can reach the server can
impersonate any user. API requests still need a JWT, but signatures are not checked.
The test page is available only in this mode. Its token stays in memory; after a
reload, reopen the printed link or enter a development token again.

To show full image build logs:

```sh
zen server start --insecure --container --user andrey --verbose
```

Podman builds and caches the image. Default build output shows a spinner, elapsed
time, and the latest line; warnings remain visible. Use `--rebuild` to rebuild.
Press Ctrl+C to stop gracefully and save active runs.

To run the server directly on the host instead, omit `--container`:

```sh
zen server start --insecure --user andrey
```

## Secure setup

A trusted caller, usually Zenera-app, authenticates users, checks project access,
and signs a short-lived JWT for each runtime request. The runtime holds **only
the public key**.

For a standalone caller, generate an Ed25519 pair outside the project directory:

```sh
zen server keygen --out "$HOME/runtime-auth"
zen server start --jwt-public-key "$HOME/runtime-auth.public.pem"
```

`keygen` creates `<prefix>.private.pem` (PKCS#8, owner-only `0600` permissions)
and `<prefix>.public.pem` (SPKI). The parent directory must already exist.
Existing files are never overwritten; a failed write removes newly created files.
Keep the private key with the trusted caller, out of source control and runtime
containers. Zenera-app already manages its own signing identity; it does not need
this command.

Generating keys does **not** sign requests. Secure callers send an
`Authorization: Bearer <jwt>` header containing an EdDSA-signed token with:

- `iss` / `aud`: defaults `zenera-app` / `zenera-runtime`.
- `sub`: the authenticated user; `prj`: this server's project ID.
- `req`: the exact `"<METHOD> <path-and-query>"` of the request.
- `iat` / `exp`: issue time and expiry; maximum age 2 minutes, 30 seconds clock tolerance.

Use HTTPS at the ingress or a protected internal connection. A token cannot
authorize a different endpoint, but can be replayed for the same request until
it expires. The server does not perform user login or project-membership checks.

## Commands

| Command                            | Use                                                             |
| ---------------------------------- | --------------------------------------------------------------- |
| `zen server start`                 | Start a project's runtime.                                      |
| `zen server check`                 | Check whether it can start in the current environment.          |
| `zen server status`                | Inspect a running runtime; use `--token <jwt>` for secure mode. |
| `zen server keygen --out <prefix>` | Generate private/public signing keys.                           |
| `zen server token --user <id>`     | Print an **unsigned** development JWT for insecure mode.        |
| `zen server build`                 | Build (and push) a release image; see below.                    |

Test an API without the browser:

```sh
TOKEN=$(zen server token --user ann)
curl http://127.0.0.1:3000/api/sessions \
  -H "Authorization: Bearer $TOKEN"
```

`token` also accepts `--email`, `--role`, `--name`, and `--thread`. It neither
creates an account nor signs a secure token.

## Common options

| Option                            | Use / default                                                          |
| --------------------------------- | ---------------------------------------------------------------------- |
| `--project <name-or-dir>`         | Select a project; otherwise use the current project.                   |
| `--port <n>` / `--host <addr>`    | `3000` / `127.0.0.1`. Insecure mode is loopback-only.                  |
| `--root <dir>`                    | Persistent user state; `~/.zenera/neo/servers/<project>` on the host.  |
| `--memory-seed <dir>`             | Initial memory for new users; defaults to project memory.              |
| `--no-memory-seed`                | Start new users with empty memory.                                     |
| `--jwt-public-key <file>`         | Public PEM for secure mode; alternatively `ZEN_SERVER_JWT_PUBLIC_KEY`. |
| `--jwt-issuer` / `--jwt-audience` | Override the expected signer / audience.                               |
| `--container`                     | Run the server in the project image; commands use bwrap.               |
| `--verbose` / `--rebuild`         | Full container build logs / rebuild images.                            |
| `--debug`                         | Enable run, trace, and memory inspection routes.                       |

Run `zen server --help` for all options. Sessions and memory live under
`<root>/users/<user>/`; memory is private per user and shared across their sessions.
New users receive the memory seed captured at startup. Existing user memory is
never replaced by a restart.

Model credentials come from `zen key`, the environment, and the project's `.env`.
Container mode forwards provider settings, including Vertex and Bifrost, and
credential files. The gateway must be reachable from the container; host
`localhost` is not container `localhost`.
Set `sandbox.keys: false` to withhold credentials from agent-written commands,
while allowing the engine to use them for model calls.

## Release images

`zen server build` bakes a project into an immutable image for Kubernetes and
prints its digest (or the local tag when not pushed):

```sh
zen server build --project p1 --release r42 \
  --push registry.local:5000/agent-p1:r42 [--authfile auth.json] [--insecure-registry]
```

The image is the agent image plus the project at `/project`, its memory seed at
`/seed` (`--memory-seed <dir>` / `--no-memory-seed`), `ZEN_RELEASE` and
`ZEN_PROJECT_ID`. The release id defaults to `r-<content hash>`; `--json` prints
`{release, image, agentImage, base, built, ref, digest}`.

Never baked in: `.env*` (except `.env.example`), `sessions/`, `.git`,
`node_modules`, `.tmp/`, or the live memory directory. Deployment settings (JWT public key, MCP
plugin, Bifrost URL/key, storage) are passed at deploy time via environment
variables or a ConfigMap. Use `--add <src>:<dest>` (repeatable) to add large
content such as plugins, e.g. `--add ./plugins:/opt/zenera/plugins`.

## Many servers per project

Several servers can serve one project when users' data lives in a store rather
than on one disk. Name a store module with `ZEN_STATE_STORE` (ZeneraLite ships an
S3 store as `state.mjs`). The server then:

- loads a user's data before their first request, and a chat's files when it is opened;
- saves them after every run, after deletions, every `ZEN_STATE_CHECKPOINT_SECONDS`
  (300) while runs go on, when released, and on shutdown;
- refuses a token whose `gen` (lease generation) is older than the one it holds,
  and drops its copy when the store reports that a newer lease saved the user.

The host manages users through `/api/admin` with tokens for its own subject
(`ZEN_SERVER_SYSTEM_SUBJECT`, default `zenera-app`):

| Route                                 | Use                                                       |
| ------------------------------------- | --------------------------------------------------------- |
| `GET /api/admin/users[?usage=1]`      | Users here: lease, runs, unsaved changes, disk use.       |
| `POST /api/admin/users/:sub/release`  | Save and let go of one user; `409 busy` while runs go on. |
| `POST /api/admin/drain[?timeout=600]` | No new users; release each one as their runs end.         |
| `POST /api/admin/undrain`             | Take new users again.                                     |

Soft limits for many users per pod:

| Variable                   | Limit                                                      |
| -------------------------- | ---------------------------------------------------------- |
| `ZEN_RUNTIME_USER_DISK_MB` | Per-user disk; over it, no new runs and running ones stop. |
| `ZEN_RUNTIME_NICE`         | Lower CPU priority for commands (default 10).              |
| `ZEN_RUNTIME_MAX_FILE_MB`  | Largest file a command may write.                          |
| `ZEN_RUNTIME_TMP_MB`       | Size of each command's `/tmp` (it uses memory).            |

These are soft. Hard limits come from the pod: CPU, memory, and a fixed-size
volume for `/state`.

## HTTP API

Session routes operate only on the JWT subject's own sessions.

| Route                                          | Use                                            |
| ---------------------------------------------- | ---------------------------------------------- |
| `GET /healthz`                                 | Public health probe.                           |
| `GET /chat`                                    | Public test page, insecure mode only.          |
| `GET /api/status` / `GET /api/activity`        | Runtime status / active runs.                  |
| `GET /api/sessions` / `GET /api/sessions/:tid` | List sessions / load history.                  |
| `POST /api/sessions/:tid/runs`                 | Start a turn, streaming AG-UI events over SSE. |
| `GET /api/sessions/:tid/runs/:runId/events`    | Follow or replay a run.                        |
| `POST /api/sessions/:tid/runs/:runId/cancel`   | Cancel a run.                                  |
| `DELETE /api/sessions/:tid`                    | Delete a session and its files.                |

Runs continue after a client disconnects and can be followed again. Defaults:
4 concurrent runs total, 2 per user (`ZEN_RUNTIME_MAX_RUNS`,
`ZEN_RUNTIME_MAX_USER_RUNS`).

For deployment and sandbox details, see [agent-image architecture](../../docs/agent-image.md).
To rebuild the bundled test page, run `npm run build:chat` from ZeneraLite's root;
it automatically copies the page into a sibling ZeneraNeo checkout when present.
