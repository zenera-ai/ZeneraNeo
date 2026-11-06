# ZeneraNeo: agent image, bwrap sandbox, server

Status: in progress, 2026-11-06 — N1, N4, N5 done. Part of the ZeneraLite plan `doc/agent-image-plan.md`
(ZeneraLite branch `agent_image`).

## Goal

One image per project that serves one user's chats and runs agents' commands under bwrap:

```
prj-<id>/agent:<tag>
├ <project's sandbox/Dockerfile environment>        root filesystem, glibc
├ /opt/zenera/   node, @zenera/*, server, bwrap      COPY --link from zenera/runtime:<zen>
├ /project/      agents.yaml, prompts, assets, skills (release: baked; draft: bind-mounted ro)
├ /state/        data/ (sessions, runs, memory) + state.json      the only writable mount
└ CMD /opt/zenera/bin/zen server start   :3000, bwrap for every command
```

Unchanged: `zen run` / `zen check` / every CLI command — podman only (desktop, editor/vscode); the
`Sandbox` contract, `describeSandbox` / `describeFsDriver`, session layout, the plugin seam.

bwrap is used only by the server inside the agent image: `@zenera/server` passes
`openEngine({ newSandbox: bwrapSandbox })`, a seam that already exists. No environment variable,
CLI flag or provider order changes; there is no "no isolation" mode.

## Work items

### N1. `BwrapSandbox` in `@zenera/sandbox` — done (branch `bwrap-sandbox`)

`packages/sandbox/src/bwrap.ts`; exports `BwrapSandbox`, `bwrapSandbox`, `probeBwrap`, `bwrapArgs`,
`rootArgs`, `hiddenArgs`. Static bwrap recipe: `packages/sandbox/bwrap/Containerfile`.

- Every command: `/bin/sh -c '<oom_score_adj 1000>; exec bwrap …' -- /bin/sh -s` (script on stdin);
  a job: the same, detached in its own process group, `/bin/sh <script>` bound read-only into its `/tmp`,
  output to a log outside the command's view. Jobs end with the sandbox (and with the server).
- bwrap is started with exactly the command's environment: base (`PATH`, `LANG`, `LC_*`, `TZ`) +
  `env` + named `secrets` + `execEnv` + `execPaths`. Never `--clearenv`: bwrap's own process is
  `/proc/1` in the sandbox and its environment is readable there.
- Namespaces: `--unshare-user --unshare-pid --unshare-ipc --unshare-uts`, `--die-with-parent --new-session`;
  `network: none` → `--unshare-net`; `strict` → `--cap-drop ALL`, 64 MiB `/tmp`; numeric `user` → `--uid/--gid`.
- Root: an empty tmpfs; each top-level entry of `/` bound read-only, symlinks recreated. A directory is
  opened (its entries bound one by one) only for a mount point the image lacks (`/home/agent`,
  `/run/zenera/keys`). Hidden paths (`/state`, `/run/secrets` + the host's list): left out at the top,
  covered with an empty tmpfs (dir) or `/dev/null` (file) below. The empty root stays writable scratch:
  `--remount-ro /` and re-binding runtime-made mounts are refused under SELinux.
- Own `/dev` (`--dev-bind`, a new devpts is refused in containers), `/tmp` (tmpfs), `/proc`:
  `fresh` (`--proc`) where the container allows it, else `bind` (`--ro-bind /proc /proc`): still a pid
  namespace of its own, and the user namespace denies the server's `environ`/`mem`/`fd`.
- `probeBwrap()` once per binary: fresh, else bind, else not ok with the reason and a hint. `start()`
  refuses when not ok; nothing falls back to running unisolated.
- `prepare()` builds nothing: `build:` must hash (`buildIdentity`) to `ZEN_IMAGE_BUILD`, `image:` must
  equal `ZEN_IMAGE_BASE`. `cpus`, `memory`, `persist` are the container's.
- OOM: exit 137 → the container cgroup's `memory.max`, `memory.peak`, `oom_kill` delta.

Tests: `test/bwrap.test.ts` (arguments, environment, probe, image check; every platform) and
`test/live-bwrap.test.ts` (contract + isolation: server env unreadable, own pid namespace, hidden
paths, read-only image, mount points the image lacks, no network, `oom_score_adj`, job stop and exit
code; self-skips without bwrap). CI job `bwrap` on ubuntu-latest.

Verified (27/27): podman 6.1 rootless with SELinux (bind), podman `unmask=ALL`+`label=disable` (fresh),
Docker Desktop 27.5 default (bind) and `systempaths=unconfined` (fresh), Docker Desktop Kubernetes
1.31 default pod (bind); with Debian's bwrap and with the static recipe's. Not yet: GKE Sandbox (gVisor).

### N2. Engine: nothing to select

- No `ZEN_SANDBOX`, no `--sandbox` flag: the server passes `newSandbox: bwrapSandbox` and
  `provider: 'bwrap (this container)'` to `openEngine`; podman stays the default for everything else.
- `prepareHome` / `installRuntime` unchanged (HOME per session, `zenera` libs inside it).
- The CLI's podman preflight is never reached by the server (it passes its own `preflight`).

### N3. (dropped — the CLI keeps podman only)

### N4. `@zenera/server` — done

`packages/server`: ZeneraLite's runtime (`services/zenera-project/src`: runtime, auth, identity,
sessions → `store.ts`, runs, history, agui, runLog, runRecords, projectEnv, http, trace, memory)
with its tests, made a package. See its README.

- `createServer({ projectId, auth, projectDir, stateDir, userId?, debug, sandbox, plugins, limits… })`;
  settings replace the old module-level environment reads.
- Auth: `jwt` (as before, plus `sub` must be the server's user when it has one) or `token`.
- State: `<state>/data/{sessions,runs,memory}` for one user; without `userId`,
  `<state>/users/<id>/…` (today's `/data` layout, so ZeneraLite can adopt it before per-user pods).
  `state.json` (layout 1, mode `single`+user or `shared`) refuses a newer layout, another
  project, the other mode, another user; `check` only reads it.
- Sandbox: `bwrapSandbox` by default (`newSandbox`, plugin sandboxes off); `'podman'` = engine default.
- `GET /api/status`; debug routes (runs, trace, memory) only with `debug`.
- Per-run plugins: `envRunPlugins()` (the MCP plugin in `ZEN_PLUGINS` + `ZEN_MCP_BROKER_URL`).
- Tests: the moved suites (vitest now) + `server.test.ts`: a real turn over HTTP against a scripted
  OpenAI-compatible model (run_command → answer), both auth modes, layouts, debug gating, status,
  `state.json`; with bwrap (Linux) the turn runs under a real bwrap and sees none of the server's env.

### N5. `zen server` — done

```
zen server start  [--port 3000] [--host 0.0.0.0] [--project /project] [--state /state] [--user <id>]
                  [--auth jwt|token] [--debug] [--sandbox bwrap|podman]
zen server check  (same options)        # bwrap, image identity, /state layout; exit 5 when not ready
zen server status [--url …] [--token …] # a running server's /api/status
```

- Env defaults: `PROJECT_DIR`, `ZEN_STATE_DIR`, `ZEN_USER_ID`, `ZEN_PROJECT_ID` (else the project
  dir's name), `ZEN_IDENTITY_PUBLIC_KEY` (→ jwt), `ZEN_SERVER_TOKEN` (→ token, needs a user),
  `ZEN_SERVER_DEBUG`, `ZEN_SERVER_PORT`, `ZEN_RUNTIME_MAX_*` limits. Keys from env; no keyring.
- `start` refuses what `check` reports; SIGTERM/SIGINT: the listener closes, new runs get 503,
  running ones end as interrupted within 20 s, exit 0.
- The image's entrypoint: `CMD ["/opt/zenera/bin/zen", "server", "start"]`.
- `@zenera/server` is a dependency of the CLI, imported only by `zen server`.
- `BwrapSandbox.prepare()` checks the image identity only when the container states one, as
  `/api/status` does; `zen image build` always will.

### N6. `zenera/runtime` image (published per zen release, per arch)

A data-only image (`FROM scratch`) holding one directory, `/opt/zenera`, that every agent image
copies in with one `COPY --link`:

```
/opt/zenera/
├ bin/node        official Node 24 linux build (needs glibc ≥ 2.28)
├ bin/zen         shim: exec /opt/zenera/bin/node /opt/zenera/lib/node_modules/@zenera/cli/dist/main.js "$@"
├ bin/bwrap       bubblewrap, statically linked
└ lib/node_modules/  @zenera/{cli,engine,neo,sandbox,server,rag,gym}, vendor SDKs, express, jose, …
```

- Own prefix: nothing collides with the project's own `node`/`python`/packages in the base image,
  and nothing depends on what the base has installed.
- Same bytes for every project → `COPY --link` gives one layer digest, pulled once per node.
- **Static bwrap**: built from source against musl with `-static`, libcap linked in; one file with
  no shared-library dependencies, so it runs on any Linux base (Debian, Ubuntu, Fedora, Alpine,
  distroless) without `apt`/`dnf` in the generated Dockerfile. Needs no setuid (unprivileged user
  namespaces). Built in the release workflow per arch, version pinned, checksum recorded.
- Node is the only glibc dependency: glibc bases only for now (musl variant later if asked).
- Built and pushed by the release workflow (`ghcr.io/zenera-ai/runtime:<version>`, `linux/amd64,linux/arm64`).

### N7. `zen image build`

```
zen image build [--draft | --release <tag>] [--platform linux/amd64] [--push <repo>]
                [--builder podman|buildkit] [--runtime <ref>]
```

1. Environment: today's `ensurePodmanImage` for `build:` (or the `image:` ref).
2. Generated Dockerfile (in `.tmp/zenera/image/`), never written into the project:
    ```dockerfile
    FROM <environment image>
    COPY --link --from=<runtime ref> /opt/zenera /opt/zenera
    # release only:
    COPY --link project/ /project/            # filtered context, see below
    ENV ZEN_IMAGE_BUILD=<hash> ZEN_IMAGE_BASE=<ref> ZEN_RELEASE=<tag>   # PATH left as the base's
    LABEL zenera.build=<hash> zenera.release=<tag> zenera.zen=<version>
    CMD ["/opt/zenera/bin/zen", "server", "start"]
    ```
3. Release context: the project minus `.env*`, `sessions/`, `.tmp/`, `.data/`, `.git/`, memory dirs,
   plus `.dockerignore`; large assets split into buckets (one `COPY --link` each).
4. `ImageBuilder` interface; `PodmanBuilder` now, `BuildKitBuilder` (buildctl) later.
5. Lint before building: fully qualified `FROM`, no `.containerignore`, base has glibc (checked by
   running `ldd --version` in the built image), `--platform` explicit for `--push`.

### N8. `zen image run` (local single user; seed of ZeneraSrv)

`zen image run [--draft] [--state ./.zen-state] [--port 3000] [--user local]`:
`podman run` with `/state` bound, keys forwarded by name from the keyring, `--auth token` (printed),
and no special flags (bwrap binds the container's `/proc`); `--security-opt unmask=ALL` (+ `label=disable`
under SELinux) gives commands a `/proc` of their own. `--draft` binds the project read-only and sets `--debug`.

### N9. ZeneraSrv (`zen srv`, later)

Config of users and tokens → reverse proxy → one `zen image run` container per user, idle stop.
Out of scope until N1–N8 are released.

## Order and releases

| Release | Items                                                                                                | Done when                                                                               |
| ------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| spike   | static bwrap + `probeBwrap` in a test image under rootless podman, Docker Desktop, kind, GKE Sandbox | which flags each host needs is known                                                    |
| 1.2.0   | N1 ✓                                                                                                 | `BwrapSandbox` passes `describeSandbox` + isolation tests in Linux CI; podman unchanged |
| 1.2.x   | N4 ✓, N5 ✓                                                                                           | ZeneraLite runtime imports `@zenera/server`; same API, tests green                      |
| 1.3.0   | N6, N7, N8                                                                                           | `zen image build --release` + `zen image run` serve a chat locally with bwrap           |
| later   | N9, BuildKit builder, musl runtime                                                                   | —                                                                                       |

## Decisions

- `/state` layout: flat per user (`/state/data/{sessions,runs,memory}`).
- The server is started by `zen server start` (CLI subcommand over `@zenera/server`).
- Background jobs end with the server; a restarted server has none.
- Hidden paths: `/state`, `/run/secrets` by default, extended by the host (`BwrapHost.hidden`).

## Open questions

- GKE Sandbox (gVisor): not verified yet.
- Gym in the agent image: not now.
