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
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/zenera-ai/ZeneraNeo/main/docs/imgs/banner-neo-dark.svg">
  <img src="https://raw.githubusercontent.com/zenera-ai/ZeneraNeo/main/docs/imgs/banner-neo-with-media-queries.svg" alt="ZENERA NEO" width="720">
</picture>

[![npm](https://img.shields.io/npm/v/@zenera/neo.svg)](https://www.npmjs.com/package/@zenera/neo)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/zenera-ai/ZeneraNeo/blob/main/LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A524-brightgreen.svg)](https://nodejs.org)
[![CI](https://github.com/zenera-ai/ZeneraNeo/actions/workflows/ci.yml/badge.svg)](https://github.com/zenera-ai/ZeneraNeo/actions/workflows/ci.yml)

[Install](#install) · [Use](#use) · [Entry points](#entry-points) · [Documentation](#documentation) · [Family](#the-rest-of-the-family) · [License](#license)

</div>

# @zenera/neo

**A multi-agent runtime for Node.js: agents, models, tools, skills, memory and
an append-only trajectory.**

> Part of [ZeneraNeo](https://github.com/zenera-ai/ZeneraNeo). This is an
> open-source side project for experimentation and chore work - **not** the
> official Zenera AI Platform. It carries no support or stability promises.

## What it gives you

- **Agents** - an instruction, a model, tools, skills, who it may hand the work
  to, and how it splits into parallel branches. There is no hidden orchestration
  layer.
- **Models** - OpenAI, Anthropic, Google/Vertex and OpenRouter behind one
  interface, each through its own SDK, plus any OpenAI-compatible endpoint.
  Named providers and model aliases resolve from config or from the host.
- **Tools** - plain typed functions, selectable per agent by name, group or
  wildcard. Workspace file tools and a Podman sandbox ship with the library.
- **Skills** - instruction bundles discovered and loaded on demand instead of
  permanently occupying the prompt, optionally owning their own tools.
- **Memory** - a timed, masked knowledge graph that outlives a run: recall
  returns a stitched subgraph rather than a ranked list, remembered files are
  mounted at `/memory`, and standing preferences go into the system prompt.
- **Trajectory** - an append-only log of everything that happened. What is sent
  to a provider is derived from it, and compaction _covers_ nodes rather than
  deleting them, so the full record survives even when older turns have to be
  pushed out of the context window.
- **Inspection** - `renderReportHtml` turns any run into one self-contained HTML
  file: the graph, every request, every token.

## Install

Node.js 24+, ESM only. Runtime dependencies are `yaml` and `zod` and nothing
else; the four vendor SDKs are **optional peer dependencies**, not loaded until
a client for that vendor is first built, so an OpenAI-only application never
pays for the others.

```sh
npm i @zenera/neo openai
npm i @zenera/neo @anthropic-ai/sdk
npm i @zenera/neo @google/genai
npm i @zenera/neo @openrouter/sdk
```

## Use

There are two ways in, and they meet in the middle: declare the agents in code,
or load them from a folder.

### In code

An agent is an instruction, a model, some tools, and who it may hand work to.
That is the whole list - there is no orchestration layer underneath.

```ts
import { AgentRunner, createModel, tool } from '@zenera/neo';

const getWeather = tool<{ city: string }>({
    name: 'get_weather',
    description: 'Current weather for a city.',
    parameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
        additionalProperties: false,
    },
    execute: ({ city }) => ({ city, tempC: 21, sky: 'clear' }),
});

const runner = new AgentRunner({ model: createModel('openai/gpt-5.4-mini') });

const planner = runner.agent({
    name: 'planner',
    description: 'Turns a request into a concrete day-by-day plan.',
    instructions: 'Answer with a plan. Check the weather before you commit to a day.',
    tools: [getWeather],
});

const result = await runner.run(planner, 'Two days in Rome, outdoors where possible.');
console.log(result.output);
```

`run()` returns a handle: `await` it for the answer, or iterate it for the
stream - token deltas plus a checkpoint for every model call, tool call,
handoff, fork and join.

```ts
for await (const ev of runner.run(planner, 'Two days in Rome.')) {
    if (ev.type === 'text_delta') process.stdout.write(ev.delta);
}
```

A second agent and a handoff is one more `runner.agent({ … })` plus
`handoffs: [planner]` on the first. Skills, memory scopes and payload stores are
declared once on the runner and referenced by id from each agent allowed to use
them.

### From a folder

An agentic project is a folder - prompts, agent wiring, skills and tool
selections are Markdown and YAML files, not code buried inside an application.
Load one and run it:

```ts
import { loadProject } from '@zenera/neo';

const project = await loadProject('./my-project', { tools: [lookupPolicy] });

for await (const ev of project.run('Water damage, policy NM-448127.')) {
    // stream events: thinking, text, tool calls, handoffs, usage
}
```

The whole system is an `agents.yaml`:

```yaml
default: intake
model: anthropic/claude-sonnet-4-5
skills: agents/skills

agents:
    - name: intake
      description: Takes the first message and routes the case.
      system: agents/prompts/intake.md
      tools: [policy_lookup]
      handoffs: [adjuster]

    - name: adjuster
      description: Weighs the written policy against the case and explains the outcome.
      system: agents/prompts/adjuster.md
      model: openai/gpt-5.4
      tools: [files:*, sandbox:*]
      skills:
          discovery: index # the model loads what the case needs
          preload: [house_style] # always on, from turn one
```

It is validated strictly at load: an unknown tool, a handoff to nobody, a
missing prompt file - each fails immediately, naming the offending key, instead
of surfacing three turns into a run as a confused model.

## Entry points

| Specifier                                                                                  | Contents                                                    |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `@zenera/neo`                                                                              | agents, models, tools, kernel, inspection                   |
| [`@zenera/meta`](https://github.com/zenera-ai/ZeneraNeo/blob/main/packages/meta/README.md) | `zen meta` - the meta-agent that builds and tunes a project |
| `@zenera/neo/project`                                                                      | loading a project folder                                    |
| `@zenera/neo/skill-providers`                                                              | skill discovery and loading                                 |
| `@zenera/neo/payload-stores`                                                               | payload persistence                                         |

## Documentation

[docs/projects.md](https://github.com/zenera-ai/ZeneraNeo/blob/main/docs/projects.md) ·
[docs/agents-yaml.md](https://github.com/zenera-ai/ZeneraNeo/blob/main/docs/agents-yaml.md)
· and
[`examples/sdk/`](https://github.com/zenera-ai/ZeneraNeo/tree/main/examples/sdk) for
eight worked demos, from a single agent to a project loaded entirely from a
folder.

## The rest of the family

| Package                                                                                    | What it is                                                    |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| [`@zenera/cli`](https://github.com/zenera-ai/ZeneraNeo/blob/main/packages/cli/README.md)   | `zen` - agent projects on the command line                    |
| **`@zenera/neo`**                                                                          | the runtime - agents, models, tools, skills, memory           |
| [`@zenera/meta`](https://github.com/zenera-ai/ZeneraNeo/blob/main/packages/meta/README.md) | `zen meta` - the meta-agent that builds and tunes a project   |
| [`@zenera/gym`](https://github.com/zenera-ai/ZeneraNeo/blob/main/packages/gym/README.md)   | `zen gym` - a mock API from an openapi/swagger document       |
| [`@zenera/rag`](https://github.com/zenera-ai/ZeneraNeo/blob/main/packages/rag/README.md)   | `zen rag` - indexing and search for documents and API schemas |
| [`@zenera/view`](https://github.com/zenera-ai/ZeneraNeo/blob/main/packages/view/README.md) | `zen view` - a live local viewer for a folder                 |

`@zenera/rag` also exports tools you can hand straight to `loadProject`, so an
agent can search an API it has never read.

## License

Early days and moving fast - issues, questions and pull requests are welcome.
[MIT](LICENSE).
