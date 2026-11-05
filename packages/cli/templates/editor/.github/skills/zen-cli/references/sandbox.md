# The sandbox - `zen sandbox`

```
zen sandbox [status|top|up|pull|clean|disk] [options]
```

Shell commands run in a container over the session workspace, never on the
host. None of this is required: a run does all of it on its own, the first time
an agent that can reach a shell is about to start one. These subcommands are for
doing it deliberately - before a demo, in CI, or when diagnosing.

| Subcommand | What it does                                                        |
| ---------- | ------------------------------------------------------------------- |
| `status`   | What is installed, running and pulled. Changes nothing              |
| `top`      | Memory and cpu: this computer, the machine, every running container |
| `up`       | Install if asked, start the machine, pull or build the image        |
| `pull`     | Just the image: pulled, or built from the project's Dockerfile      |
| `clean`    | Remove every container this CLI created                             |
| `disk`     | What the engine and every known project occupy                      |

| Flag                    | Meaning                                                    |
| ----------------------- | ---------------------------------------------------------- |
| `--project <name\|dir>` | Which project the image comes from                         |
| `--image <ref>`         | Use this image instead of the project's                    |
| `--once`                | `top`: print one report instead of the live screen         |
| `--interval <seconds>`  | `top`: how often the live screen refreshes (default 2)     |
| `--brief`               | `top`: the figures without the notes saying what they mean |
| `--podman`              | Podman here, even when a plugin provides the sandbox       |

`top` draws a live screen only when a person is at a terminal. From an agent,
a script or with `--json` it measures twice a second apart (cpu needs an
interval) and prints once, so `zen sandbox top --json` is the form to read:
`host.vm` is what the machine costs the computer (`footprint` is Activity
Monitor's figure on macOS), `machine` is Linux's own split into `used`, `cache`
and `free`, `containers[]` carries `cpu` (percent of one core), `memory`,
`limit` and `orphaned`, and `hints[]` says what to do about it.

The engine is Podman. On macOS a machine has to exist and be running; `up`
offers to install and start one, and its size follows the project's `cpus` and
`memory`.

A plugin named in `$ZEN_PLUGINS` can run sandboxes somewhere else - a sandbox
service. Then `zen run` and `zen check` use it, the line under the session says
`sandbox <where>`, `status` and `clean` ask the service, and `top`, `up`, `pull`
and `disk` say they are about podman only. `--podman` goes back to this machine.

## Configuring it - `sandbox:` in `agents.yaml`

Top level, and again per agent, where an agent's block is merged over the base.

| Key       | Meaning                                                          |
| --------- | ---------------------------------------------------------------- |
| `image`   | The image to run. Mutually exclusive with `build`                |
| `build`   | `{ dockerfile, context? }` - build one instead. Excludes `image` |
| `cpus`    | CPU limit                                                        |
| `memory`  | Memory limit, in MiB                                             |
| `network` | Whether the container has one                                    |
| `workdir` | Where the workspace is mounted. `/workspace` by default          |
| `timeout` | Seconds one command may take                                     |
| `user`    | Who commands run as                                              |
| `persist` | Keep the container between runs                                  |
| `env`     | A name-only allow-list of variables to pass in                   |

`env` refuses names matching `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD` or
`CREDENTIAL`: the keyring has already materialised real credentials into the
process environment, and a sandbox is the last place they should be forwarded to.

The door for those is the project's `.env`, which `zen init` writes and
`.gitignore` covers. `zen run` reads it before loading the project and forwards
every name in it into the container **by name**, so the value never reaches an
argv. `keys: false` and `zen run --no-keys` withhold it along with the API keys.
The shell's environment wins over the file; the keyring fills in the rest.

## `persist: true` is usually what you want

Only `/workspace` and `/home/agent` survive an ephemeral container. A
`pip install` as root, or an `apt-get install`, lands in the image's system
paths and is gone by the next run - so the agent silently reinstalls its
toolchain every single time. `zen init` scaffolds `persist: true` for that
reason.

The caveat: the container's name is a function of its configuration, so any
change to the sandbox block names a _new_ container and abandons the installed
rootfs. If runs keep beginning with an install, either persist, or bake the
toolchain into the image.

## Building an image instead of naming one

```yaml
sandbox:
    build:
        dockerfile: sandbox/Dockerfile
    persist: true
```

The tag is content-addressed - a hash of the Dockerfile and every file in its
context - so a changed Dockerfile is a different image and a `persist: true`
container can never be left sitting on a stale rootfs. It is built only when
that tag is absent, which is safe precisely because the tag follows the content.
`zen sandbox pull` forces a rebuild.

## Hardening

Every container gets the same floor: `no-new-privileges`, an init process, a
pid limit of 1024, resource limits (`cpus: 4`, `memory: 4096`), no restart
policy, podman's own seccomp profile (never turned off), and never
`--privileged`.

`hardening: standard` (the default) stops there. `--cap-drop=ALL` breaks `apt`
and `pip`, and installing a package is the ordinary use of a shell - so the
container is the boundary and nothing inside it is taken away.

```yaml
sandbox:
    hardening: strict
```

`strict` is for running code nobody has read. It drops every capability,
mounts the root filesystem read-only with `/tmp` as a 64 MiB
`noexec,nosuid,nodev` tmpfs, runs as your own unprivileged uid via
`--userns keep-id`, and defaults `network` to `none` and `cpus`/`memory` to
`2`/`2048`. Name any of those keys yourself and your value wins.

Two consequences: nothing can be installed at run time, so a strict project
bakes its dependencies into the image with `build:`; and it needs rootless
podman, which is also what makes an escape land on an unprivileged host
account. Set `user:` explicitly to opt out of `keep-id`.

`/workspace` stays writable either way - `strict` shrinks what a command can
reach, not what the agent is there to edit.

## When it goes wrong

Exit code `5` means the container engine is missing or the image could not be
prepared, and the message names the command to run for this platform. `zen check`
distinguishes the two cases: a broken Dockerfile is an error, a laptop with no
Podman is a warning.

`zen sandbox clean` removes every container this CLI created - the way out of a
container left on a bad rootfs. `--idle` removes only what no live run is using:
stopped containers, and running ones whose run was killed before stopping them
(`zen sandbox status` marks those `orphaned`).

`could not create container … exceeded num_locks (2048)` means the engine is out
of locks: every container holds one, stopped ones included, and `persist: true`
leaves one stopped per session. `zen run` and `zen run batch` check this before
the first model call and exit `5` when the engine cannot hold them (a batch needs
one per item it runs at once). `zen sandbox status` shows a `locks` row when few
are left; `zen sandbox clean --idle` frees them.

For complete container architecture, the `sandbox:*` tools, mount rules, and
hardening details, load the `zen-sandbox` skill (`.github/skills/zen-sandbox/SKILL.md`).
