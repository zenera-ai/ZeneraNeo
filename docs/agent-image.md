# ZeneraNeo: agent image, bwrap sandbox, server

Status: in progress, 2026-11-07 — N1, N2, N4, N5 done; `zen server start --container` is a local
N7 + N8. Part of the ZeneraLite plan `doc/agent-image-plan.md` (ZeneraLite branch `agent_image`).

## Goal

One image per project that serves **every user's** chats with it, each user in a folder of their own,
and runs agents' commands under bwrap:

```
prj-<id>/agent:<tag>
├ <project's sandbox/Dockerfile environment>        root filesystem, glibc, its ENV
├ /opt/zenera/   node, @zenera/*, bwrap, runtime/    the zenera library under runtime/
├ /project/      agents.yaml, prompts, assets, skills (release: baked; draft: bind-mounted ro)
├ /state/        server.json, users/<user>/{sessions,memory}     the only writable mount
└ zen server start   :3000, a JWT per request, bwrap for every command
```

Unchanged: `zen run` / `zen check` / every other CLI command — podman only (desktop, editor/vscode);
the `Sandbox` contract, `describeSandbox` / `describeFsDriver`, the session layout, the plugin seam.

bwrap is used only by the server, and only inside the agent image (it ships `/opt/zenera/bin/bwrap`);
`zen server` anywhere else uses podman as `zen run`. There is no "no isolation" mode.

## Work items

### N1. `BwrapSandbox` in `@zenera/sandbox` — done (branch `bwrap-sandbox`)

`packages/sandbox/src/bwrap.ts`; exports `BwrapSandbox`, `bwrapSandbox`, `probeBwrap`, `bwrapArgs`,
`rootArgs`, `hiddenArgs`. Static bwrap recipe: `packages/sandbox/bwrap/Containerfile`.

- Every command: `/bin/sh -c '<oom_score_adj 1000>; exec bwrap …' -- /bin/sh -s` (script on stdin);
  a job: the same, detached in its own process group, `/bin/sh <script>` bound read-only into its `/tmp`,
  output to a log outside the command's view. Jobs end with the sandbox (and with the server).
- bwrap is started with exactly the command's environment: base (the image's `ENV`, else `PATH`, `LANG`,
  `LC_*`, `TZ`) + `env` + named `secrets` + `execEnv` + `execPaths`. Never `--clearenv`: bwrap's own process is
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

### N2. Engine: one shared `zenera` library — done

- The `zenera` library (Python and Node: `identity()`, `require_identity()`) is one read-only
  directory mounted at `/opt/zenera/runtime` (`python/zenera`, `node/zenera`; `PYTHONPATH`,
  `NODE_PATH`) in every sandbox, instead of a copy in each session's home.
- `runtimeDir()`: `/opt/zenera/runtime` in the agent image, else `<zen home>/runtime/<content hash>`,
  written once (tmp + rename). Its mount (`source.kind: 'runtime'`) is part of the podman container's
  name hash, so containers are made again when it changes.
- `prepareHome` only makes the home; the user comes from `ZEN_USER_*` in the command's env.
- No `ZEN_SANDBOX`, no engine flag: the server passes its sandbox to `openEngine`.

`BwrapSandbox` also starts each command from the image's `ENV` (`/opt/zenera/etc/image-env.json`,
written at build from the sandbox image), so `PYTHONPATH`, `PATH`, `VIRTUAL_ENV`… set by the project's
Dockerfile hold under bwrap; without the file, `PATH`/`LANG`/`LC_*`/`TZ` as before. Its probe passes
`--unshare-user`, so bwrap started as the container's root still makes a user namespace.

### N3. (dropped — the CLI keeps podman only)

### N4. `@zenera/server` — done (multi-user)

`packages/server`: ZeneraLite's runtime (`services/zenera-project/src`) made a package. See its README.

- `createServer({ projectId, projectDir, root, auth, memorySeed?, debug, sandbox, hidden, plugins,
limits… })`; `listen({ port, host = '127.0.0.1' })`.
- **Auth** (`auth.ts`): `Authorization: Bearer <jwt>` on every route but `/healthz`, signed per request
  by zenera-app (EdDSA). The server has only the public key. Checked: `iss` (`zenera-app`), `aud`
  (`zenera-runtime`), age ≤ 2 min (30 s skew), `prj` = this project, `req` = `"<METHOD> <url>"` of
  this request; `sub` names the user, `thr` (if any) must be the URL's thread, `role`/`email`/`name`
  go to the run. `insecure` mode reads the token without checking it (`sub` still required),
  loopback only, refused in the image unless `ZEN_SERVER_INSECURE_LOCAL=1`.
- **Root** (`layout.ts`, `store.ts`): `<root>/server.json` `{version: 1, projectId}` (another
  project's root or a newer layout is refused); `<root>/users/<user>/sessions/<thread>/` is a
  `zen run` session (`.data/`, `runs/`, `workspace/`, plus `agui/`); `<user>` is `sub` when a safe
  segment, else `u-<sha256>`.
- **Memory**: `<root>/users/<user>/memory/`, copied from the seed (the project's memory,
  `memorySeed`, or none) the first time the user needs one — single-flight, tmp + rename, `seed.json`
  recorded — then shared by that user's chats only.
- bwrap hides the root, the seed, the zen home, the project and (in the image) `/opt/zenera/app` from
  commands; their workspace and home are bound back in.
- Limits: `maxRuns` overall, `maxUserRuns` per user.
- Sandbox: `defaultSandbox()` — bwrap inside the agent image, podman anywhere else; or a factory.
- `GET /api/status`: versions, auth mode, sandbox, image identity, root (`dir`, `version`, error),
  memory seed. Debug routes only with `debug`.
- Per-run plugins: `envRunPlugins()` (the MCP plugin, given the run's `x-zenera-mcp-token`).
- Shutdown: the listener closes, new runs get 503, running ones end as interrupted (they save).

### N5. `zen server` — done

```
zen server start  [--port 3000] [--host 127.0.0.1] [--project <name|dir>] [--root <dir>]
                  [--memory-seed <dir> | --no-memory-seed]
                  [--jwt-public-key <file>] [--jwt-issuer …] [--jwt-audience …] | [--insecure]
                  [--container [--rebuild]] [--debug] [--sandbox podman|bwrap]
zen server check  (same options)        # sandbox, image identity, root; exit 5 when not ready
zen server status [--port …] [--host …] [--token <jwt>]   # a running server's report
zen server token  --user <id> [--email …] [--role …] [--name …] [--thread …]   # for --insecure
```

- Project: `--project`, else `$PROJECT_DIR`, else the one you are in, as `zen run` (`/project` in
  the image). Root: `--root`/`$ZEN_SERVER_ROOT`, else `~/.zenera/neo/servers/<project>` (`/state`
  in the image).
- Auth: `--jwt-public-key <file>` or `$ZEN_SERVER_JWT_PUBLIC_KEY` (the PEM), else it refuses to start
  and suggests `--insecure`. `status` sends an unsigned token unless `--token`.
- Env: `PROJECT_DIR`, `ZEN_PROJECT_ID`, `ZEN_SERVER_{PORT,HOST,ROOT,DEBUG,SANDBOX}`,
  `ZEN_SERVER_JWT_{PUBLIC_KEY,ISSUER,AUDIENCE}`, `ZEN_RUNTIME_MAX_{RUNS,USER_RUNS,RUN_MINUTES}`.
- Sandbox: bwrap in the agent image, podman elsewhere (readied as `zen run` does).
- Keys: the keyring and the environment, as `zen run`; in the image, the environment.
- Insecure startup prints a `file://` link to the CLI's bundled React chat (`assets/chat.html`),
  with the server address and a dev JWT in the fragment. Default browser user `local`, or
  `--user`. The page is compiled in ZeneraLite from its existing chat components into one HTML
  file, then copied to the CLI package; no frontend build is needed in ZeneraNeo.
  Only insecure servers allow local-file (`Origin: null`) CORS preflights. `GET /api/sessions`
  lists the caller's sessions from engine metadata; history, streaming and cancellation use
  the existing AG-UI routes.
- **Startup memory** (`cli/src/seed.ts`): the host CLI takes a consistent snapshot of the
  configured/project seed before serving, including committed SQLite WAL data and attached
  files. It uses rollback-journal mode so the snapshot needs no WAL/SHM writes on read-only
  mounts. New users copy that fixed initial memory; existing private memories are untouched.
  An uninitialized or disabled startup seed stays empty until the next server start.
- **`--container`** (`cli/src/container.ts`), optional — plain `start` still uses podman sandboxes:
  Startup presentation (`cli/src/serverDisplay.ts`) groups the runtime settings and chat link.
  Base/agent builds use a single updating line with a spinner and elapsed build time by default,
  including during quiet steps, with warnings/errors retained;
  `--verbose` keeps every build line, grouped and colored. Piped output has no cursor controls
  and retains the final progress line. Managed images report HTTP readiness without duplicating
  the host summary or insecure warning.
    1. ready the project's sandbox image as `zen run` does; read its `Env`;
    2. `npm pack` this zen's `@zenera/{sandbox,neo,view,engine,server,cli}` from where they are
       installed (no npm release needed), `npm install` them in a `node:24-trixie-slim` stage into
       `/opt/zenera/app` (`overrides` point at the tarballs), copy its `node` to `/opt/zenera/bin`;
    3. a static bwrap stage (Alpine, musl, `-static`);
    4. final stage `FROM` the sandbox image: `/opt/zenera`, bwrap, `runtime/`, `etc/image-env.json`,
       `ZEN_IMAGE_BUILD`/`BASE`, entrypoint `zen server start`; tag `localhost/zenera-agent:<hash>`
       (rebuilt only when an input changes, or `--rebuild`);
    5. snapshot the seed on the host, then `podman run --rm -d`: `/project:ro`, the root at `/state`,
       the prepared snapshot at `/seed:ro` (or `--no-memory-seed`), the port on `--host`, auth flags and
       model keys and provider context passed by environment name; credential files
       mounted as private Podman secrets and staged into the container's private home
       so bwrap can bind container-owned copies when keys are allowed,
       logs followed, Ctrl-C → `podman stop`.
       The server runs as numeric UID/GID 10001 with `HOME=/home/zenera`; the image deliberately
       overrides the base's `USER`. Rootless podman maps the host user to it with
       `--userns keep-id:uid=10001,gid=10001`, preserving host-owned state. With rootful podman the
       host must provide state writable by 10001. All capabilities are dropped and privilege
       escalation is disabled.
       The temporary seed lives under the private server root and is removed after the container
       stops, including failed startup. The source project remains read-only in the container.

    Verified on macOS (podman machine): a `python:3.12-slim` project whose Dockerfile installs
    `pyfiglet` and sets `PYTHONPATH`; a command under bwrap imports both and `zenera` (user `alice`),
    and sees no `/state`, no `/project`, an empty `/opt/zenera/app`.

### ZeneraLite: a JWT per request (next, in ZeneraLite)

- zenera-app signs, for each request it proxies to a project's pod, an EdDSA JWT: `iss` zenera-app,
  `aud` zenera-runtime, `sub` the user, `prj` the project, `req` `"<METHOD> <path>"`, `thr`, `role`,
  `email`, `name`; short-lived. It keeps the private key; every pod gets only the public key
  (`ZEN_SERVER_JWT_PUBLIC_KEY`).
- One pod per project (or several, sharded by user) serves every user; login and project access stay
  in zenera-app. It forwards the run's `x-zenera-mcp-token` too.
- NetworkPolicy: only zenera-app → the pod's port.

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
| 1.2.x   | N2 ✓, N4 ✓, N5 ✓                                                                                     | ZeneraLite signs a JWT per request; its pods run `@zenera/server`                       |
| 1.3.0   | N6, N7, N8                                                                                           | `zen image build --release` + `zen image run` serve a chat locally with bwrap           |
| later   | N9, BuildKit builder, musl runtime                                                                   | —                                                                                       |

## Decisions

- One server per project image serves every user; each user has a folder of their own under the root
  (`users/<user>/{sessions,memory}`); `server.json` ties the root to one project.
- Who is calling is a JWT zenera-app signs per request; the server holds only the public key.
  `--insecure` (no checks, loopback only) is the one dev mode.
- A user's memory starts as a copy of the seed (the project's memory) and is shared by their chats.
- One shared read-only `zenera` library at `/opt/zenera/runtime`; the image's `ENV` reaches bwrap.
- The server is started by `zen server start`; `--container` builds and runs the agent image locally.
- Background jobs end with the server; a restarted server has none.
- Hidden paths: `/state`, `/run/secrets` by default, extended by the host (`BwrapHost.hidden`).

## Open questions

- GKE Sandbox (gVisor): not verified yet.
- Non-root bwrap must be allowed by the host's user-namespace policy. Verified under rootless
  podman with UID/GID 10001, no capabilities and no privilege escalation; GKE is still unverified.
- Node ESM `import 'zenera'` ignores `NODE_PATH` (CommonJS `require` works).
- Gym in the agent image: not now.
