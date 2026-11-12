# @zenera/meta

The meta-agent for [`zen`](../cli): a coding agent pointed _at_ a zen project,
spending the same keys. `zen run` runs the agents a project describes;
`zen meta` runs an agent over the project to change it - sync it with its
specification, review it, build its dataset and fine-tune its prompts.

Today it drives [GitHub Copilot CLI](https://github.com/github/copilot-cli),
always on your own provider keys (`zen key add`), never on a Copilot
subscription.

## Install

Requires **Node.js 24 or newer** and `@zenera/cli`:

```sh
npm install --global @zenera/cli @zenera/meta
```

`zen` loads it by name, so there is no second binary: `zen meta …` works once it
is installed, and says what to install when it is not. Copilot CLI is used from
`PATH` when it is there (`npm i -g @github/copilot`), and fetched with `npx`
otherwise. `zen version` shows which.

## Commands

```
zen meta run [project] "<question>"      ask it something
zen meta run [project] /<name> [words]   run .github/skills/<name>/SKILL.md
zen meta run [project]                   pick one of those commands
zen meta prompts [project]               list those commands
zen meta resume [project] [session]      carry on a session that stopped
zen meta model [ref]                     show or set the model it uses
zen meta dataset <verb>                  the cases a project is evaluated on
zen meta finetune <verb>                 tune the project on those cases
```

`zen meta --help`, `zen meta run --help`, `zen meta dataset --help` and
`zen meta finetune --help` have the details. The fine-tuning loop is described
in [docs/finetuning.md](../../docs/finetuning.md).

## Design

It reaches `zen` only through [src/host.ts](src/host.ts), which imports
`@zenera/cli/lib` and nothing else; [test/meta-boundary.test.ts](test/meta-boundary.test.ts)
holds that line. The CLI keeps what `zen init` and `zen open` also need - the
`.github/` editor tree and its templates, and the usage ledger. See §7.6 of the
[CLI design notes](../cli/DESIGN.md).

## License

MIT
