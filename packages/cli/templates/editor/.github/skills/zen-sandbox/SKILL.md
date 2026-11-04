---
name: zen-sandbox
description: 'How the container sandbox works, when and how to configure it in `agents.yaml` (`sandbox:` and `agents[].sandbox`), the four `sandbox:*` tools, mount layout (/workspace, $HOME, /tmp, /run/zenera/keys), lifecycle and persistence (`persist: true`), credential forwarding by name, resource ceilings (cpus, memory, pids), standard vs strict hardening profiles, path rules, and debugging container issues with `zen sandbox`. Refers to `zen-cli` (`.github/skills/zen-cli/references/sandbox.md`).'
user-invocable: false
---

# The Container Sandbox

A shell, and a boundary around it. The boundary is a Linux container: the
agent's commands run against an image the project chose, with the session's
workspace bind-mounted at `/workspace` and nothing else of the host machine in
reach.

The container is the boundary rather than any parsing or filtering of what the
model wrote. On the host side, every process is spawned with `shell: false` and
arguments assembled as an array; command text travels exclusively down **stdin**
into `/bin/sh -s` inside the container. There is no host shell to inject into,
and no argv length to overflow.

The container engine is **Podman** (rootless by default).

For the CLI subcommands (`zen sandbox status`, `top`, `up`, `pull`, `clean`, `disk`)
and command-line options, see the [zen-cli skill](../zen-cli/SKILL.md) and its
dedicated reference document [sandbox.md](../zen-cli/references/sandbox.md).

---

## 1. The Sandbox Tools (`sandbox:*`)

When an agent is granted sandbox tools in `agents.yaml`, it receives up to four
tools from the `sandbox` group:

| Tool                     | Type       | Description                                                           |
| ------------------------ | ---------- | --------------------------------------------------------------------- |
| `run_command`            | foreground | Runs a shell command under `/bin/sh`, waits for exit, captures output |
| `run_command_background` | background | Starts a detached command (server, watcher) and returns a `job_id`    |
| `read_command_output`    | inspection | Reads a window of log lines from a background job and checks status   |
| `stop_command`           | control    | Signals and terminates a background job process group                 |

### `run_command`

- **Parameters:**
    - `command` (string, required): the shell command string, interpreted by `/bin/sh` inside the container.
    - `cwd` (string, optional): working directory relative to `/workspace`. Defaults to `/workspace`.
    - `timeout` (integer, optional): seconds before SIGTERM/SIGKILL. Defaults to 120 s; capped at 3600 s.
- **Output:** returns `exit_code`, `stdout`, `stderr`, `duration_ms`. Combined output is capped at 64 KiB (`truncated: true` when exceeded).

### `run_command_background`

- **Parameters:** `command` (string, required), `cwd` (string, optional).
- **Execution:** written to `/tmp/zenera-jobs/<job_id>.sh` and started in a separate session via `setsid`. Output and exit status stream to `/tmp/zenera-jobs/<job_id>.log` and `<job_id>.exit`.
- **Returns:** `{ job_id, started: true }`.

### `read_command_output`

- **Parameters:** `job_id` (string, required), `start_line` (integer, optional, 1-based).
- **Returns:** `{ job_id, running: boolean, exit_code?: number, output: string, start_line, end_line, lines }`. Displays up to 400 lines per call.

### `stop_command`

- **Parameters:** `job_id` (string, required).
- **Behaviour:** sends SIGTERM to the job's entire process group (`-$pid`), waits 1 s grace period, then sends SIGKILL.

---

## 2. Tool Selection in `agents.yaml`

Agents select tools through `tools:` using exact names, group wildcards, or subtraction:

```yaml
agents:
    - name: developer
      tools: [files:*, sandbox:*] # all file and shell tools

    - name: reviewer
      tools: [files:*, sandbox:run_command] # foreground only, no background servers

    - name: tester
      tools: [sandbox:*, -stop_command] # sandbox tools without stop_command

    - name: analyst
      tools: [files:*] # no shell tools; container is never started
```

An agent with no `sandbox:*` tools never triggers an image pull, container creation, or VM startup.

---

## 3. Filesystem and Mount Layout

Inside the container, paths are isolated to designated mount points:

| Path inside container | Host Source               | Mode        | Lifecycle / Purpose                                    |
| --------------------- | ------------------------- | ----------- | ------------------------------------------------------ |
| `/workspace`          | Session workspace         | read-write* | The work itself. Changes survive session completion.   |
| `/home/agent`         | `.data/sandbox/home`      | read-write  | User home (`$HOME`). Persists across sessions.         |
| `/tmp`                | In-memory / host tmpfs    | read-write  | Ephemeral scratch; holds `/tmp/zenera-jobs`.           |
| `/assets`             | Project assets directory  | read-only   | Reference assets declared in `SPECIFICATION.md`.       |
| `/skills`             | Project skills directory  | read-only   | Custom skill files available to agents.                |
| `/run/zenera/keys`    | Keychain / temp directory | read-only   | Forwarded file credentials (e.g. Vertex service keys). |

_\*Mounted read-only if the session or project was opened in read-only mode._

### Path Rules

- All relative paths and `cwd` arguments resolve against `/workspace`.
- Lexical escapes outside `/workspace` (`../../etc`, absolute `/etc`, null bytes `\0`) are **strictly rejected** by the runtime and return an actionable error to the model.
- Path resolution inside the container never resolves against host symlinks.

---

## 4. Lifecycle, Container Naming, and Persistence

### Lazy Initialization

Containers are started on-demand. If an agent never invokes a `sandbox:*` tool, no image is pulled and no container runs. Concurrent tool calls in the same turn await a single startup promise without racing.

### Deterministic Container Naming

Container names follow the pattern:

```
zn-<key>-<digest>
```

- `<key>` is derived from the session identifier or project key.
- `<digest>` is the first 10 hex characters of the SHA-256 hash of the configuration:
  `[root, image, hashCpus, hashMemory, network, workdir, user, readOnly, mounts, env, secrets, hardening]`

### The Persistence Rule (`persist: true` vs `persist: false`)

- **`persist: false` (ephemeral):** when the session finishes, the container is deleted (`podman rm --force --volumes`). Changes made to `/workspace` and `/home/agent` survive on the host; changes made to the root filesystem (such as `apt-get` or root `pip install`) are discarded.
- **`persist: true` (recommended for development):** the container is stopped (`podman stop --time 2`) rather than removed. System packages and global caches survive between runs.
- **Caveat:** because the container name depends on its configuration, **any edit to `sandbox:` in `agents.yaml` generates a new container name**, abandoning the persisted container rootfs. When dependencies must be permanent across config changes, bake them into the image using `sandbox.build`.

---

## 5. Configuring `sandbox:` in `agents.yaml`

Configured at the top level and optionally overridden per agent under `agents[].sandbox`:

```yaml
sandbox:
    persist: true
    image: docker.io/library/python:3.14-slim-bookworm
    cpus: 4
    memory: 4096
    network: bridge
    timeout: 120
    hardening: standard
    env: [HTTPS_PROXY, NO_PROXY]
    keys: true

agents:
    - name: builder
      # Inherits base sandbox configuration

    - name: isolated-runner
      sandbox:
          hardening: strict
          network: none
```

### Configuration Fields

| Field       | Type                   | Default                                       | Meaning                                                 |
| ----------- | ---------------------- | --------------------------------------------- | ------------------------------------------------------- |
| `image`     | string                 | `docker.io/library/python:3.14-slim-bookworm` | Base image to run. Mutually exclusive with `build`.     |
| `build`     | object                 | none                                          | `{ dockerfile, context? }`. Builds a local Dockerfile.  |
| `cpus`      | number                 | `4` (`2` in `strict`)                         | Fractional CPU limit (`--cpus`). `0` for unconstrained. |
| `memory`    | integer (MiB)          | `4096` (`2048` in `strict`)                   | Memory limit (`--memory`). `0` for unconstrained.       |
| `network`   | `bridge`/`none`/`host` | `bridge` (`none` in `strict`)                 | Network connectivity mode.                              |
| `workdir`   | absolute path          | `/workspace`                                  | Working directory and workspace mount destination.      |
| `timeout`   | integer (seconds)      | `120`                                         | Default per-command execution timeout.                  |
| `hardening` | `standard`/`strict`    | `standard`                                    | Security posture (see §6).                              |
| `user`      | string                 | image user                                    | `uid`, `name`, or `uid:gid` inside the container.       |
| `persist`   | boolean                | `false`                                       | Keep container filesystem between runs.                 |
| `env`       | string[]               | `[]`                                          | Host environment variables to pass by name.             |
| `keys`      | boolean                | `true`                                        | Forward model credentials to the container.             |

### `memory` and `cpus` divide a machine they cannot enlarge

On macOS and Windows these are shares of the podman VM, not of the host. The VM
is sized **once**, by whichever project first ran `zen sandbox up` on this
machine, and it defaults to **2048 MiB and 2 CPUs** however large the host is.
Raising `sandbox.memory` afterwards never resizes it — the init flags are only
read when no machine exists yet.

So the scaffolded default, `memory: 4096`, promises each container twice the
whole default VM, and podman will admit as many of them as you ask for without
complaining. Nothing reports this: `zen check` does not, and `zen sandbox
status` prints no memory figure at all. It surfaces later as an exit 137, or as
an exit 124 that looks like a slow index.

One container is rarely the problem. Before running several at once — a
`zen run batch` with `--concurrency` above 1 — load **zen-sandbox-capacity** and
run its `preflight_sandbox.sh`, which measures the VM, the container cap and the
index and says whether the arithmetic fits. A `zen-finetune` run is the
exception: it starts at `min(maxBatch + recheck, 16)` and halves on OOM instead.

---

## 6. Hardening Postures: `standard` vs `strict`

Every container runs with baseline safety controls:

- `--security-opt no-new-privileges` prevents setuid escalation.
- `--init` provides a dedicated init process (catatonit) to reap zombie background processes.
- `--pids-limit 1024` halts fork bombs.
- `--restart no` prevents runaway resurrection.
- Never `--privileged`.
- Podman's default seccomp filter is always enabled.

### Comparison

| Security Dimension   | `standard` (default)                        | `strict`                                          |
| -------------------- | ------------------------------------------- | ------------------------------------------------- |
| **Intended Use**     | General development, testing, builds        | Executing unreviewed or untrusted code            |
| **Kernel Caps**      | Default set kept (allows `apt`, `pip`)      | `--cap-drop ALL` (all capabilities dropped)       |
| **Root Filesystem**  | Writable                                    | `--read-only` (immutable rootfs)                  |
| **Temporary Space**  | Standard `/tmp`                             | `--tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m`    |
| **User Namespace**   | Rootless default (uid 0 inside = host user) | `--userns keep-id` (host uid inside, owns mounts) |
| **Default Network**  | `bridge`                                    | `none`                                            |
| **Default Ceilings** | `cpus: 4`, `memory: 4096`                   | `cpus: 2`, `memory: 2048`                         |
| **Package Installs** | Allowed (`apt-get`, `pip`, `npm`)           | Refused (must pre-bake into Dockerfile)           |
| **Workspace**        | `/workspace` is read-write                  | `/workspace` is read-write                        |

### Key Strict Mode Nuances

1. **Pre-baked dependencies:** because `/` is read-only and caps are dropped, dynamic package installations fail. Dependencies must be defined in `sandbox/Dockerfile` using `sandbox.build`.
2. **`keep-id` user mapping:** under rootless Podman, `--userns keep-id` maps your host UID to the container UID. Files written to `/workspace` remain owned by you on the host, and the container user cannot access root-only files inside the image. If an explicit `user:` is specified in config, `keep-id` is omitted.
3. **`noexec` on `/tmp`:** prevents running downloaded binaries directly from scratch space. Interpreted scripts (`/bin/sh /tmp/script.sh` or `python /tmp/test.py`) remain functional because the interpreter executable lives in the read-only root.

---

## 7. Credentials and Secret Forwarding

1. **Forwarded by Name, Never by Value:**
   Host environment variables and credentials are passed using Podman's `--env NAME` syntax (without an `=value`). Podman pulls values from its own environment at execution time. Secrets never appear on command-line arguments, in process lists (`ps`), or in `podman inspect`.
2. **Env Name Blacklist:**
   The `env:` array in `agents.yaml` strictly refuses variables named `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, or `CREDENTIAL` to prevent accidental credential leakage into uninspected scripts.
3. **File-Shaped Credentials:**
   Key files (such as Google Vertex service account keys) are mounted read-only to `/run/zenera/keys/` and their environment variables (e.g. `GOOGLE_APPLICATION_CREDENTIALS`) are automatically rewritten to point to the in-container path.
4. **Disabling Forwarding:**
   Set `keys: false` in `agents.yaml` or launch runs with `zen run --no-keys` to prevent any model API keys or service credentials from reaching the container.

---

## 8. Multi-Agent Sandboxes (`SandboxPool`)

- Two agents with identical sandbox configurations share the **same container**.
- Two agents with different images or configurations receive separate containers.
- The `sandbox:*` tool definitions remain uniform across the session; when an agent calls a tool, the pool routes the call to that specific agent's container at invocation time.

---

## 9. Diagnostics and Troubleshooting (`zen sandbox`)

Use the `zen sandbox` commands via terminal to inspect and manage container state:

```sh
zen sandbox status          # Check podman version, machine status, and active containers
zen sandbox top --once      # Memory and cpu of the machine and every running container
zen sandbox up              # Start VM (macOS) and pull or build the required image
zen sandbox pull            # Re-pull base image or force build of sandbox/Dockerfile
zen sandbox clean           # Force remove all zn-* containers created by this CLI
zen sandbox clean --idle    # Only what no live run uses: stopped and orphaned ones
zen sandbox disk            # Inspect disk space consumed by images, containers, and volumes
```

### Exit Codes and Common Issues

- **Exit Code 5:** Container engine failed or image build failed.
    - On macOS: ensure Podman machine is running (`zen sandbox up` or `podman machine start`).
    - On Linux: verify rootless subuid/subgid mapping is configured (`/etc/subuid`).
- **Permission Denied in `/workspace`:**
    - In `strict` mode without `user:`, rootless Podman uses `keep-id` to preserve host UID. If using custom `user:`, verify host directory permissions allow that UID.
- **Disk Space Pressure:**
    - Run `zen sandbox clean --idle` to prune stopped and orphaned session containers.
- **`could not create container … exceeded num_locks`:**
    - Every container holds one engine lock (2048 by default), stopped ones included. Run `zen sandbox clean --idle`.
