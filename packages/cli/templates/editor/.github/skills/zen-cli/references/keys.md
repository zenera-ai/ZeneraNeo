# Credentials - `zen key`

```
zen key <ls|add|use|mode|check|rm|show|env> [ref] [options]
```

Alias: `keys`.

Keys live in `~/.zenera/neo/keys.json`, mode `0600`, and are materialised into
the environment just before a run. **A real environment variable always wins**,
so a `.env` or an exported key still decides.

A reference is `provider` or `provider/name`. A provider may hold several named
keys; one of them is active.

## Subcommands

| Command                           | What it does                            |
| --------------------------------- | --------------------------------------- |
| `zen key ls [--check]`            | Everything stored, and its state        |
| `zen key add <provider>[/name]`   | Read a key from stdin, or ask for it    |
| `zen key use <provider>/<name>`   | Choose which one a run uses             |
| `zen key mode [direct\|bifrost]`  | Call vendors directly, or via a gateway |
| `zen key check [provider[/name]]` | Ask the provider whether it still works |
| `zen key rm <provider>/<name>`    | Forget one                              |
| `zen key show <ref> [--reveal]`   | Masked by default                       |
| `zen key env [provider …]`        | Shell exports, for other tools          |

`zen key add` also takes `--gcp-project` and `--gcp-location`, for a Vertex
service account.

```
zen key add openai                    # prompts, echo off
pbpaste | zen key add openai/work     # or from stdin
eval "$(zen key env)"                 # hand them to something else
```

**The secret never comes from argv.** A command line lands in `ps`, in shell
history and in CI logs, so `zen key add` takes the value from piped stdin or an
echo-off prompt and from nowhere else.

## Providers

| Name         | Environment variable             | Holds  | Where a key comes from              |
| ------------ | -------------------------------- | ------ | ----------------------------------- |
| `openai`     | `OPENAI_API_KEY`                 | secret | platform.openai.com/api-keys        |
| `anthropic`  | `ANTHROPIC_API_KEY`              | secret | console.anthropic.com/settings/keys |
| `google`     | `GEMINI_API_KEY`                 | secret | aistudio.google.com/apikey          |
| `vertex`     | `GOOGLE_APPLICATION_CREDENTIALS` | file   | a service-account JSON key from GCP |
| `vertex`     | `VERTEX_API_KEY`                 | secret | an express-mode key from GCP        |
| `openrouter` | `OPENROUTER_API_KEY`             | secret | openrouter.ai/settings/keys         |
| `exa`        | `EXA_API_KEY`                    | secret | dashboard.exa.ai/api-keys           |
| `bifrost`    | `BIFROST_API_KEY`                | secret | a virtual key from your Bifrost     |

`exa` is a service the tools call, not a model provider. `bifrost` is a
gateway: see below.

### Gateway mode - every model through Bifrost

```
zen key add bifrost --url https://bifrost.example.com   # the virtual key, prompted
zen key mode bifrost                                   # from now on, every run
zen key mode direct                                    # back to vendor keys
```

In `bifrost` mode a run exports `BIFROST_API_KEY` and `BIFROST_BASE_URL` and
**withholds every vendor key**. The runtime then sends every model and every
embedding through the gateway, each in its own vendor's protocol, and
`agents.yaml` does not change: `vertex/gemini-3.5-flash` reaches
`<url>/genai` as `vertex/gemini-3.5-flash`, `anthropic:*` reaches
`<url>/anthropic`, `openai:*` and `openrouter:*` reach `<url>/openai`.
Declared providers are rerouted too. `zen check` then reports
`BIFROST_API_KEY`, not the vendor variables, as the credential in use.

The switch is `BIFROST_BASE_URL` itself, so exporting it in a shell or a `.env`
turns gateway mode on without the keyring - and `zen key mode`/`ls`/`check`
report and probe it (`bifrost/$BIFROST_API_KEY`), with nothing stored. In this
mode `zen models` lists only
what the gateway serves - see `models.md`. The full guide is
[docs/gateway.md](https://github.com/zenera-ai/ZeneraNeo/blob/main/docs/gateway.md).

### Vertex takes either shape

A **service-account file** is absorbed into `~/.zenera/neo/keys/` and
`GOOGLE_APPLICATION_CREDENTIALS` points at it. It wants a project too, from
`--gcp-project`, or `GOOGLE_CLOUD_PROJECT`, or the `project_id` inside the file,
and a region from `--gcp-location` (`global` otherwise). Application Default
Credentials from `gcloud auth application-default login` work with no entry at
all.

An **express-mode key** is an ordinary secret under `VERTEX_API_KEY`, and
addresses no project: a key and a project are alternatives, and sending both
gets a `403` that mentions neither. `--gcp-project` and `--gcp-location` are
therefore refused alongside a key.

```
zen key add vertex --gcp-project acme-prod --gcp-location europe-west4
# paste a path  → the file shape
# paste a key   → the express shape
```

Which one you gave is read off the value: a path that exists is the file, and
anything else is the key.

## Credentials the keyring does not hold

`zen key ls` also lists what the environment brought and what `gcloud` left
behind, marked `~` and named for the variable rather than for a key:

```
~ vertex/$VERTEX_API_KEY   vx-1…9f0z   live   from the environment
~ vertex/adc               …/application_default_credentials.json
```

These can be listed and checked, not chosen or forgotten - there is nothing to
choose between, and nothing of ours to remove. Unset the variable, or
`gcloud auth application-default revoke`.

## Liveness

`zen key check` and `zen key ls --check` do one round trip per key and record
the verdict:

- **live** - authenticated. A rate-limited answer counts as live, because it
  proves the credential.
- **dead** - the provider rejected it. A verdict.
- **blocked** - the credential was accepted and the **account** refused: an API
  switched off in the project, an empty balance, a model this key was never
  granted. Do not rotate the key; a new one is refused identically. The check
  carries a `fix` - for a disabled Google API, the exact
  `gcloud services enable <api> --project <id>`.
- **unknown** - the provider could not be asked. Says nothing about the key;
  usually the network.

`zen init` uses the same probe to pick which provider to scaffold with, so a
project is not built around a revoked key.

## When a run says there is no credential

The frame does **not** materialise the keyring for you - each command that needs
a credential opens the store itself. If `zen key ls` shows a key as live and a
command still says `provider "openai": no api key - set OPENAI_API_KEY`, the
credential is fine and the command is at fault. Everything that runs a model
(`run`, `check`, `models`, `gym`, `rag`) already does this.

Exit code `4` means no usable credential for what was asked.
