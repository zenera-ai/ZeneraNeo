<div align="center">
  <img
    src="https://raw.githubusercontent.com/zenera-ai/ZeneraNeo/main/docs/imgs/zenera-logo-with-media-queries.svg"
    alt="Zenera"
    width="24"
  />
  <div>Powered By Zenera</div>
  <br>
  <img
    src="https://raw.githubusercontent.com/zenera-ai/ZeneraNeo/main/docs/imgs/banner-cli-with-media-queries.svg"
    alt="ZENERA CLI"
    width="720"
  />

[![npm](https://img.shields.io/npm/v/@zenera/cli.svg)](https://www.npmjs.com/package/@zenera/cli)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/zenera-ai/ZeneraNeo/blob/main/LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A524-brightgreen.svg)](https://nodejs.org)
[![CI](https://github.com/zenera-ai/ZeneraNeo/actions/workflows/ci.yml/badge.svg)](https://github.com/zenera-ai/ZeneraNeo/actions/workflows/ci.yml)

[Why `zen`](#why-use-zen) · [Install](#install) · [Quickstart](#quickstart) · [Run](#run-it-your-way) · [Improve](#the-self-improving-loop) · [Evaluate](#evaluate-and-fine-tune) · [Share](#share-a-project) · [Commands](#commands-at-a-glance)

</div>

# `@zenera/cli`

**The CLI for [ZeneraNeo](https://github.com/zenera-ai/ZeneraNeo): build, run, and improve specialist AI agent systems from your terminal.**

The `zen` command is the everyday interface to ZeneraNeo. Describe a recurring
job, use the meta-agent to shape its agent system, run it against your files and
tools, then inspect what happened and improve it from evidence. Use the
interactive terminal app for hands-on work, or run commands non-interactively
in scripts and CI.

ZeneraNeo is built for work that benefits from focused specialists rather than
one general-purpose assistant: research and analysis, document and policy
review, operations, software delivery, and workflows that need to use your
existing knowledge. Agent runs can search project knowledge, use persistent
memory, and execute commands in a container. Their traces, outputs, timing, and
token usage are available to inspect.

> Part of [ZeneraNeo](https://github.com/zenera-ai/ZeneraNeo). This is an
> open-source side project for experimentation and chore work - **not** the
> official Zenera AI Platform. It carries no support or stability promises.

<details>
<summary><strong>Contents</strong></summary>

- [Why use `zen`?](#why-use-zen)
- [Install](#install)
- [Quickstart](#quickstart)
- [Run it your way](#run-it-your-way)
- [The self-improving loop](#the-self-improving-loop)
- [Evaluate and fine-tune](#evaluate-and-fine-tune)
- [Share a project](#share-a-project)
- [Commands at a glance](#commands-at-a-glance)
- [Learn more](#learn-more)

</details>

## Why use `zen`?

- **Turn a job description into a working system.** Describe the outcome and
  constraints; the meta-agent can create and update the specialist agents,
  instructions, skills, and hand-offs that implement them.
- **Keep improvement grounded in runs.** Validate the setup, inspect recorded
  traces, evaluate against cases, and tune prompts, skills, and memory policies.
  Fine-tuning here improves the agent system around the model; it does not
  train model weights.
- **Work with your own material.** Run agents against a chosen workspace, use
  document and API-schema retrieval through ZeneraNeo's RAG tools, and retain
  useful knowledge in memory.
- **See what the system did.** Open a run report or inspect its graph and
  individual steps, including tool calls and usage.
- **Use it interactively or automate it.** `zen run` offers a terminal UI when
  you want one and one-shot, JSON, and batch modes for scripts and pipelines.
- **Choose your model provider.** The CLI supports OpenAI, Anthropic, Google,
  Vertex AI, and OpenRouter, and provides commands to manage credentials and
  test available models.

## Install

Requires **Node.js 24 or newer**.

```sh
npm install --global @zenera/cli @zenera/meta
```

`@zenera/meta` adds `zen meta`, the meta-agent the quickstart below relies on.
The CLI is available as `zen`, `zn`, and `zenera`. To try it without a global
install:

```sh
npx @zenera/cli --help
```

Agent command execution uses a container sandbox. Install and configure
[Podman](https://podman.io/) for workflows that run shell commands;
`zen sandbox` checks and prepares the local environment.

## Quickstart

Add a key for a supported provider, choose the model used by the meta-agent,
and scaffold a project:

```sh
zen key add openai
zen meta model --pick
zen init my-project
zen open my-project
```

Write the job, constraints, and what counts as a successful result in the
generated `SPECIFICATION.md`. Then ask the meta-agent to bring the implementation
in line with it, validate the setup, and run it:

```sh
zen meta run my-project /spec-sync-project
zen check my-project
zen run my-project --here "Summarize this repository and write NOTES.md"
zen inspect
```

The meta-agent can ask for clarification in `SPECIFICATION-FEEDBACK.md` rather
than silently guessing. After you answer, apply that feedback with
`zen meta run my-project /spec-apply-feedback`. For the full workflow, see the
[specification-driven projects guide](https://github.com/zenera-ai/ZeneraNeo/blob/main/docs/specification.md).

## Run it your way

With no prompt, `zen run` opens the terminal UI. Provide a prompt for a
one-shot run, or use JSON and batch mode to integrate with other tools. A
one-shot run works in a fresh directory inside its session; `--here` points it
at the directory you are in instead:

```sh
zen run my-project                         # interactive terminal UI
zen run my-project --here "Review the latest changes"
git diff | zen run my-project
zen run my-project --here "Summarize the changes" --read-only
zen run my-project "Triage these alerts" --json | jq
zen run batch --input cases.json           # run a set of requests
```

Runs are recorded in the project so you can continue sessions and review the
work later. `zen inspect` opens a report; `zen inspect graph` produces a
Mermaid view of the run, and `zen inspect ask` lets you question a recorded
model call.

## The self-improving loop

An agent system should get better from the work it actually does. ZeneraNeo
keeps the specification, project checks, and run traces close together so you
can find what went wrong and improve the instruction that caused it:

1. Update the specification to clarify the intended behavior.
2. Run `zen meta run /spec-sync-project` to sync the implementation.
3. Run `zen check`, then try the task again with `zen run`.
4. Use `zen inspect` to review the trace, tool calls, and result.

This makes improvement repeatable and reviewable instead of accumulating
one-off prompt patches. The meta-agent can also analyze a run and recommend
which instruction to change. See the
[specification-driven workflow](https://github.com/zenera-ai/ZeneraNeo/blob/main/docs/specification.md).

## Evaluate and fine-tune

For systematic improvement, build an evaluation dataset from representative
requests and rubrics that describe what a successful run should do. Then run
cases in isolation or use the tuning loop to analyze traces, apply focused
changes, and try again:

```sh
zen meta run /dataset
zen meta dataset
zen run batch --input cases.json
zen meta finetune start
zen meta finetune
```

Fine-tuning here improves the agent system—its prompts, skills, instructions,
and memory practices—not model weights. Dataset cases and results provide a
repeatable way to check that changes improve the work rather than just reword
the prompts. Read the [fine-tuning guide](https://github.com/zenera-ai/ZeneraNeo/blob/main/docs/finetuning.md)
for dataset and rubric guidance.

## Share a project

Keep the work portable: export a project to a ZIP archive, then import and
register it on another machine.

```sh
zen export my-project --out my-project.zip
zen import my-project.zip
```

Exports include the agent setup and project resources while excluding local
sessions and `.env` values. Credential names are retained in `.env.example`,
so collaborators can see what to configure without receiving your secrets.
Vectors are included by default; `--no-vectors` makes a smaller archive that
may need an index or memory restore step. Import treats archives as untrusted
and does not execute their scripts or setup files.

## Commands at a glance

| Need                  | Commands                                                    |
| --------------------- | ----------------------------------------------------------- |
| Create and find work  | `zen init`, `zen open`, `zen list`                          |
| Build and validate    | `zen meta`, `zen check`, `zen sandbox`                      |
| Run and review        | `zen run`, `zen inspect`, `zen view`                        |
| Configure providers   | `zen key`, `zen models`                                     |
| Work with memory      | `zen memory`                                                |
| Serve chats over HTTP | `zen server start`, `zen server check`, `zen server status` |
| Server authentication | `zen server keygen`, `zen server token`                     |
| Share and maintain    | `zen export`, `zen import`, `zen cache`, `zen completion`   |

Run `zen --help` or `zen <command> --help` for details and options.

### Serve a project

```sh
zen server start --insecure --user ann             # local test chat; open the printed HTTP link
zen server start --container --insecure --user ann # run the server in the project's agent image
zen server keygen --out ./runtime-auth             # standalone Ed25519 signing keys
zen server start --jwt-public-key ./runtime-auth.public.pem
```

`keygen` creates private/public PEM files without overwriting existing files. Keep
the private key with the trusted caller, not the runtime. `token --user ann`
prints an **unsigned development JWT**, usable only with `--insecure`; it does
not sign production requests. See the [server usage guide](../server/README.md)
for secure callers, storage, and common options.

### Optional Zenera commands

The CLI can expose commands supplied by sibling Zenera packages:

- **`@zenera/meta`** adds `zen meta`: the meta-agent, its dataset and the
  fine-tuning loop, driven through GitHub Copilot on your own keys.
- **`@zenera/rag`** adds `zen rag` for indexing and searching documents and API
  schemas.
- **`@zenera/gym`** adds `zen gym` for building and serving mock APIs from
  OpenAPI or Swagger specifications.

Install each package separately to use its command:

```sh
npm install --global @zenera/meta @zenera/rag @zenera/gym
```

`zen version` lists every `@zenera/*` package this `zen` resolves, flags one
out of step with the CLI, and names the programs they run on (Node, Podman,
Copilot).

## The rest of the family

`@zenera/cli` is the command-line front end for ZeneraNeo. The other packages
provide the runtime and optional capabilities that work alongside it:

| Package                                                                                    | What it is                                                          |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| [`@zenera/cli`](https://github.com/zenera-ai/ZeneraNeo/blob/main/packages/cli/README.md)   | `zen` — agent projects on the command line                          |
| [`@zenera/neo`](https://github.com/zenera-ai/ZeneraNeo/blob/main/packages/neo/README.md)   | The runtime — agents, models, tools, skills, and memory             |
| [`@zenera/gym`](https://github.com/zenera-ai/ZeneraNeo/blob/main/packages/gym/README.md)   | `zen gym` — mock APIs from OpenAPI or Swagger documents             |
| [`@zenera/rag`](https://github.com/zenera-ai/ZeneraNeo/blob/main/packages/rag/README.md)   | `zen rag` — indexing and search for documents and API schemas       |
| [`@zenera/view`](https://github.com/zenera-ai/ZeneraNeo/blob/main/packages/view/README.md) | `zen view` — a live local viewer for a folder                       |
| [`@zenera/server`](../server/README.md)                                                    | `zen server` — multi-user chats over HTTP and server authentication |

`@zenera/rag` also exports tools that can be passed to `loadProject`, allowing
an agent to search an API schema it has not read beforehand.

## Learn more

- [ZeneraNeo repository and overview](https://github.com/zenera-ai/ZeneraNeo)
- [Specification-driven projects](https://github.com/zenera-ai/ZeneraNeo/blob/main/docs/specification.md)
- [Agent configuration reference](https://github.com/zenera-ai/ZeneraNeo/blob/main/docs/agents-yaml.md)
- [Memory](https://github.com/zenera-ai/ZeneraNeo/blob/main/docs/memory.md) · [Knowledge and retrieval](https://github.com/zenera-ai/ZeneraNeo/blob/main/docs/knowledge.md) · [Fine-tuning](https://github.com/zenera-ai/ZeneraNeo/blob/main/docs/finetuning.md)
- [Examples](https://github.com/zenera-ai/ZeneraNeo/tree/main/examples/projects)

## License

MIT
