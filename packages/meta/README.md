<div align="center"> 
  <img
    src="https://raw.githubusercontent.com/zenera-ai/ZeneraNeo/main/docs/imgs/zenera-logo-with-media-queries.svg"
    alt="Zenera Logo"
    width="20"
  />
  <div>Powered By Zenera</div>
</div>
<br>

<div align="center">
<img src="https://raw.githubusercontent.com/zenera-ai/ZeneraNeo/main/docs/imgs/banner-meta-with-media-queries.svg" alt="ZENERA META" width="801">

[![npm](https://img.shields.io/npm/v/@zenera/meta.svg)](https://www.npmjs.com/package/@zenera/meta)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/zenera-ai/ZeneraNeo/blob/main/LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A524-brightgreen.svg)](https://nodejs.org)
[![CI](https://github.com/zenera-ai/ZeneraNeo/actions/workflows/ci.yml/badge.svg)](https://github.com/zenera-ai/ZeneraNeo/actions/workflows/ci.yml)

[Install](#install) · [Use](#use) · [Commands](#commands) · [Models](#models) · [Credentials](#credentials) · [Family](#the-rest-of-the-family) · [License](#license)

</div>

# @zenera/meta

**The meta-agent: a coding agent pointed _at_ a zen project, on your own keys.
`zen run` runs the agents a project describes; `zen meta` runs an agent over
the project to change it - generate it from its specification, review it,
build its evaluation dataset and fine-tune its prompts against that dataset.**

It drives [GitHub Copilot CLI](https://github.com/github/copilot-cli) - and, for
a conversation, the [Copilot SDK](https://github.com/github/copilot-sdk) - with
your provider keys, never a Copilot subscription.

> Part of [ZeneraNeo](https://github.com/zenera-ai/ZeneraNeo). It ships no
> binary of its own: installing it adds a `meta` **subcommand** to
> [`zen`](https://github.com/zenera-ai/ZeneraNeo/blob/main/packages/cli/README.md),
> which is also where the credentials already are.

## What you get

- **Specification-driven builds** - `/spec-sync-project` reads
  `SPECIFICATION.md` and writes the agents, prompts, tools and skills, then asks
  what it could not decide in `SPECIFICATION-FEEDBACK.md`.
- **A chat in the terminal** - `zen meta chat` is the same agent turn by turn:
  the answer streams in, each tool call is a line, and `--ask` has it stop for a
  yes or no before it touches anything.
- **Commands from the project** - every `.github/skills/<name>/SKILL.md` the
  project carries is a `/<name>` you can run from the terminal, the same ones
  the editor offers.
- **Runs that survive** - a rate limit or provider outage is waited out and the
  session resumed; `zen meta resume` picks up one that stopped for any other
  reason.
- **A dataset and a tuning loop** - `zen meta dataset` keeps the cases a project
  is evaluated on; `zen meta finetune` runs them, analyzes each run and edits
  the project's prose until the cases pass. No model weights are touched.
- **Accounting** - tokens are counted per call as it runs; in a project being
  tuned every call lands in `finetune/usage/ledger.jsonl`.

## Install

Node.js 24+. Install it alongside the CLI:

```sh
npm i -g @zenera/cli @zenera/meta
zen key add openai          # the keyring `zen` already uses
```

Copilot CLI is used from `PATH` when it is there (`npm i -g @github/copilot`)
and fetched with `npx` otherwise. `zen meta chat` needs neither: the Copilot SDK
it runs on is a dependency and brings its own runtime. `zen version` shows
both, and every `@zenera/*` package version beside them.

## Use

```sh
zen meta model --pick                        # choose the model once
zen meta run "what does this project do?"    # ask it something
zen meta run acme /spec-sync-project         # run one of the project's commands
git diff | zen meta run "what broke?" --allow-tool read
zen meta resume acme                         # carry on the last session
zen meta chat acme                           # talk it through, turn by turn
```

The answer goes to stdout and the progress to stderr, so `> out.md` keeps the
answer alone. The whole run - prompt, every step, the answer - is logged under
`<project>/.tmp/logs/`, and the answer is saved beside it as markdown.

It may use every tool without asking: a prompt written for an editor expects
to read, write and run things, and a terminal has nobody watching to answer.
Narrow it with `--allow-tool`, or restore the asking with `--ask`.

`zen meta chat` takes the same model, key, tools and log as `run`, in a
conversation: the answer streams in, Esc stops a turn, `/help` lists the
chat's commands and `/<name>` runs a project command inside it. It ends by
printing the session, which `zen meta chat --resume` - or `--continue`, for
the last one - and `zen meta resume` both take.

The editor files `zen init` writes (`.vscode/` and the `.github/` tree) are
refreshed in the project before each run, because they are the brief the agent
works from and they describe this version of `zen`.

## Commands

```
zen meta run [project] "<question>"      Ask it something.
zen meta run [project] /<name> [words]   Run .github/skills/<name>/SKILL.md.
zen meta run [project]                   Pick one of those commands.
zen meta chat [project] [question]       Talk it through, turn by turn.
zen meta prompts [project]               List those commands.
zen meta resume [project] [session]      Carry on a session that stopped.
zen meta model [ref]                     Show or set the model it uses.
zen meta dataset <verb>                  The cases a project is evaluated on.
zen meta finetune <verb>                 Tune the project on those cases.
```

Useful options: `--project`, `--model`, `--provider`, `--prompt-file`,
`--agent`, `--effort`, `--allow-tool`, `--ask`, `--add-dir`, `--retries`,
`--share`, `--events`, `--dry-run` (print the command, secrets masked),
`--json`. `zen meta --help`, `zen meta run --help`, `zen meta chat --help`,
`zen meta dataset --help` and `zen meta finetune --help` print the full tables. The tuning loop is
described in [docs/finetuning.md](https://github.com/zenera-ai/ZeneraNeo/blob/main/docs/finetuning.md).

## Models

The model is looked for in this order: `--model`, `ZENERA_META_MODEL` in the
shell, `ZENERA_META_MODEL` in the project's `.env`, what `zen meta model`
stored, then the project's `agents.yaml`. With none set it uses the best model
it knows of for a provider you hold a key for - through a gateway, the best one
the gateway serves - and says which on stderr.

`zen meta model <provider>/<id>` asks the provider a one-word question before
storing it, so a model that will not answer is never kept; one whose API
rejects Copilot's tools (gpt-4o and older) is refused. `--force` skips both.

## Credentials

The keyring is `zen`'s, so there is nothing new to configure:

```sh
zen key add openai
zen key ls --check
```

Every credential reaches Copilot through its environment, never on a command
line, where other processes could read it. Vertex Claude goes through a local
relay that signs each request with your service account.

## Design

It reaches `zen` only through [src/host.ts](src/host.ts), which imports
`@zenera/cli/lib` and nothing else; [test/meta-boundary.test.ts](test/meta-boundary.test.ts)
holds that line. The CLI keeps what `zen init` and `zen open` also need - the
`.github/` editor tree and its templates, and the usage ledger. See §7.6 of the
[CLI design notes](https://github.com/zenera-ai/ZeneraNeo/blob/main/packages/cli/DESIGN.md).

`@zenera/meta/chat` exports `openMetaChat`, the session behind `zen meta chat`
without its screen, for a host that draws its own chat. It refreshes the editor
files, picks the model and key, logs and records usage as the terminal chat
does, and reports each turn as `ChatEvent`s.

## The rest of the family

| Package                                                                                    | What it is                                                    |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| [`@zenera/cli`](https://github.com/zenera-ai/ZeneraNeo/blob/main/packages/cli/README.md)   | `zen` - agent projects on the command line                    |
| [`@zenera/neo`](https://github.com/zenera-ai/ZeneraNeo/blob/main/packages/neo/README.md)   | the runtime - agents, models, tools, skills, memory           |
| **`@zenera/meta`**                                                                         | `zen meta` - the meta-agent that builds and tunes a project   |
| [`@zenera/gym`](https://github.com/zenera-ai/ZeneraNeo/blob/main/packages/gym/README.md)   | `zen gym` - a mock API from an openapi/swagger document       |
| [`@zenera/rag`](https://github.com/zenera-ai/ZeneraNeo/blob/main/packages/rag/README.md)   | `zen rag` - indexing and search for documents and API schemas |
| [`@zenera/view`](https://github.com/zenera-ai/ZeneraNeo/blob/main/packages/view/README.md) | `zen view` - a live local viewer for a folder                 |

## License

Early days and moving fast - issues, questions and pull requests are welcome.
[MIT](LICENSE).
