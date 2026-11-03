---
name: zen-cli
description: How to drive this project from the terminal with `zen` - running it, validating it, credentials, the sandbox, run reports, and the `gym` and `rag` modules.
user-invocable: false
---

# The `zen` command line

`zen` runs agent projects from a terminal. Everything here operates on a project
directory, resolved from the working directory, or by name from the registry
`zen init` wrote to, or explicitly with `--project <name|dir>`. Every command
takes `--json` and prints a machine-readable answer instead of a rendered one.

**stdout is the answer, stderr is the narration.** Exit codes: `0` ok, `1`
failed, `2` usage, `3` invalid project, `4` no usable credential, `5` sandbox.

## The commands

```
zen init     [dir] [--name <name>] [--model <ref>] [--force]
zen list     [--sessions] [--runs] [--limit <n>] [--prune]
zen run      [project] [prompt] [options]
zen run      batch --input <file> [--batch-dir <dir>] [--concurrency <n>] [--memory-read-only]
zen open     [project] [--editor <cmd>] [--wait]
zen key      <ls|add|use|check|rm|show|env> [ref] [options]
zen models   <providers|ls|search|show|test|browse> [ref] [options]
zen check    [name|dir] [--project <name|dir>] [--no-sandbox] [--no-models] [--strict] [--quiet]
zen inspect  [report|graph|node|ask] [run] [--dir <run dir>] [--part <name>] [--full] [--open]
zen memory   [stats|ls|search|grep|show|export|merge|forget|migrate] [args] [options]
zen export   [project] [--out <file>] [--no-vectors] [--no-memory] [--force]
zen import   <file.zip> [dir] [--name <name>] [--force] [--no-register]
zen sandbox  [status|up|pull|clean|disk] [options]
zen version

zen meta     <run|prompts|resume|model|dataset> [project] [args]

zen gym      <serve|build|cache|world|model> [spec...]
zen rag      schema <index|restore|ready|search|list|grep|trace|show|stats> [spec...]
zen rag      docs <index|restore|ready|search|list|grep|show|stats> [path...]
```

## Read the reference before answering

The full reference lives next to this file, one document per part of the command
line. **Read the one that covers the question before answering it** - do not
guess a flag, and do not read them all.

| The question is about                                                | Read                                                            |
| -------------------------------------------------------------------- | --------------------------------------------------------------- |
| Global flags, `--json`, exit codes, environment, where files live    | [frame.md](./references/frame.md)                               |
| Creating, finding or opening a project                               | [projects.md](./references/projects.md)                         |
| Running: the TUI, one-shot answers, sessions, workspaces, overrides  | [run.md](./references/run.md)                                   |
| Many questions at once: `zen run batch`, its file, where answers go  | [run.md](./references/run.md)                                   |
| Validating: `zen check`, what it can and cannot see                  | [check.md](./references/check.md)                               |
| API keys, providers, the keyring, "no credential" errors             | [keys.md](./references/keys.md)                                 |
| Which models exist, whether one works, recovering from a refusal     | [models.md](./references/models.md)                             |
| The container shell commands run in, images, `persist`               | [sandbox.md](./references/sandbox.md) (and `zen-sandbox` skill) |
| Run reports, trajectories, what a session directory holds            | [inspect.md](./references/inspect.md)                           |
| Reading a run yourself: the node graph, opening a node by id         | [inspect.md](./references/inspect.md) (and `zen-inspect` skill) |
| What the agents remember, why something was recalled, forgetting     | [memory.md](./references/memory.md)                             |
| The meta agent: `zen meta run`, its `/commands`, its `--json` object | [meta.md](./references/meta.md)                                 |
| The evaluation dataset: cases, drift, notes, drawing a sample        | [dataset.md](./references/dataset.md) (and `zen-dataset` skill) |
| Tuning the prose on the dataset: workers, applies, STATUS.md         | [finetune.md](./references/finetune.md)                         |
| Sharing a project: archives, what travels, importing one safely      | [export.md](./references/export.md)                             |
| `zen gym` - a mock API from an OpenAPI/Swagger document              | [gym.md](./references/gym.md)                                   |
| `zen rag` - searching an API description, or a pile of markdown      | [rag.md](./references/rag.md)                                   |

## The short version

```
zen init                              scaffold a project here, pick a model
zen check                             validate everything before spending a turn
zen run                               the TUI
zen run "what changed?"               one answer, in a fresh session directory
zen run --here "what changed?"        ... about the files in this directory
zen run batch --input cases.json      many questions at once, each isolated
zen inspect --open                    what the model was actually given
zen inspect graph --dir <run dir>     the same run as a graph you can read
zen inspect node n14..n20 --dir <d>   the nodes behind the ids, in full
zen memory export --open              the whole memory graph, as a page
zen export                            the project as a zip you can send
zen import a.zip                      unpack one somebody sent, run nothing in it
zen key ls --check                    which credentials still work
zen models test <ref>                 whether one model actually answers
zen models ls --embeddings            the embedders this machine can reach
zen meta run acme /analyze --json > analyze.json   a command, the result as JSON
```

## Searching documents without help

Use `zen rag docs` for a directory of Markdown or text, and put the index path
in `-d <index-dir>` when it is not beside the working directory. These commands
are enough to discover the corpus and retrieve evidence; do not spend a turn on
`--help` first:

```sh
zen rag docs list files -d <index-dir>
zen rag docs list sections -d <index-dir> --file "<path-pattern>"
zen rag docs search -d <index-dir> "<question in natural language>"
zen rag docs search -d <index-dir> --file "<path-pattern>" --section "<heading>" "<question>"
zen rag docs grep -d <index-dir> "<exact string>" --file "<path-pattern>"
zen rag docs show -d <index-dir> "<file>" --section "<heading>"
zen rag docs show -d <index-dir> "<doc-1>:<a>-<b>" "<doc-2>#<heading>"   # several in one call
```

Start with one ordinary hybrid question. It is the best default for concepts and
open questions. Search returns candidates, not proof: read the quoted lines,
then use `show` or `grep` before claiming a fact is present or absent. Read
every passage you will cite with ONE `show` naming them all, not one call each.

When the first answer is from the wrong product area, version, file, or heading,
ask the same question again with `--file` and then `--section`. A bare `--file`
value is a substring; `*` and `?` make it a glob. Use `--kind table` or
`--kind table_row` for limits and matrices, `--mode text` for a known exact
phrase, and `--exclude-id <id>` to continue past an already-read passage.

`--file` is the primary scope control: repeat it to admit several document
families, and use `--exclude-file` to remove a noisy family. Both are resolved
before ranking, so a result cannot come from an excluded document. `--section`
then keeps only a matching heading and its nested headings within those files.
For example, search two manual families but exclude archived releases:

```sh
zen rag docs search -d <index-dir> --file "manual-*/**" --file "guide-*/**" \
	--exclude-file "*-archive/**" --section "Operations" "<question>"
```

Hybrid is not a vector reranker. It retrieves a candidate list from full-text
search and another from vector similarity, then fuses their ranks. Full-text
finds literal terms; vector search finds passages with the same meaning even
when their wording differs. `--mode text` or `--mode vector` runs only one leg;
ordinary hybrid runs both and is normally the right choice.

Use `--text-query` with `--vector-query` only when one wording cannot serve both
retrievers: a distinctive corpus term or command for the text leg, and the full
question for the vector leg. For example:

```sh
zen rag docs search -d <index-dir> --text-query "exact identifier" \
	--vector-query "what it means and how to use it"
```

This is not a general upgrade over hybrid search. Generic product names and
common nouns make weak text legs that can displace better semantic results. The
two flags replace positional text and `--mode`; give neither alongside them.

Run `zen check` after any edit to `agents.yaml`, a prompt or a skill: it reads
the project the way a run does, reports everything wrong at once, and calls no
model. It is the cheapest possible test.

When behaviour is wrong and the prompt looks right, open the run report. It
shows what the model was actually given, which is rarely what you assumed.

Flags always beat the file: the repository states intent, the invocation
overrides it. Failure messages name the offending key or file - a load error
names the exact path, as in `agents.yaml: agents[1].skills.discovery - …` - so
read it rather than guessing. The loader is strict on purpose, and an unknown
key is an error rather than a value quietly ignored.
