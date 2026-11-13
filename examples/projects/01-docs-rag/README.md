# 01 - Documentation RAG

A worked example: a project that answers questions about the Hugging Face
Transformers documentation from an index built out of it, and quotes the
passage each answer came from.

Everything in this folder is one file - [SPECIFICATION.md](SPECIFICATION.md).
The project that implements it is generated from that file by the meta agent,
so what you copy is the intent, not the code.

## Before you start

- Node.js 24+ and `npm i -g @zenera/cli`
- Podman, which is what `zen run` runs the agent in
- An OpenAI key - the specification names `openai/gpt-5.6-luna` for chat and
  `openai/text-embedding-3-small` for the vectors

## 1. Add a key

```sh
zen key add openai
```

It asks for the value without echoing it and stores it in `~/.zenera`; the key
is never passed as an argument. Pipe it instead with
`zen key add openai < key.txt`.

Other providers, second keys, Vertex service accounts and which key a model
ends up using are all in
[Credentials](../../../packages/cli/README.md#credentials).

## 2. Choose the model for the meta agent

The meta agent is what turns the specification into the project. It runs on
your own key, separately from the models the project itself declares.

```sh
zen meta model --pick     # choose from providers you hold a key for
```

Or name one outright:

```sh
zen meta model openai/gpt-5.6-sol
```

Use a reasoning model - `gpt-5.6-sol`, `claude-opus-5`, `gemini-3.8-flash`. The
meta agent declares its tools in a form only the reasoning APIs accept. Setting
one asks the provider a one-word question first, so a model that will not answer
is refused now rather than mid-run. `zen meta model` with no argument prints the
whole resolution chain with the winner marked; see
[Which model it runs on](../../../packages/cli/README.md#which-model-it-runs-on).

## 3. Create the project

```sh
cd ~/your-work-dir
zen init rag-example
cd rag-example
```

That writes `rag-example/` - `agents.yaml`, `agents/`, `scripts/`,
`sandbox/Dockerfile`, the `.github/` prompt tree - plus a `SPECIFICATION.md`
describing the scaffold it just made. Every command below runs from inside that
folder.

## 4. Replace SPECIFICATION.md with [this one](SPECIFICATION.md)

Use any text editor, or the command line:

```sh
curl -fsSL -o SPECIFICATION.md \
  https://raw.githubusercontent.com/zenera-ai/ZeneraNeo/main/examples/projects/01-docs-rag/SPECIFICATION.md
```

From a clone of this repository, copy it instead:

```sh
cp <clone>/examples/projects/01-docs-rag/SPECIFICATION.md SPECIFICATION.md
```

The scaffold's specification is now gone and this one is the intent. Nothing
else in the project has changed yet - the files still implement the old one.

## 5. Generate the project from it

```sh
zen meta run rag-example /spec-sync-project
```

`/spec-sync-project` is a command - a skill under `.github/skills/`. It reads the
specification, reads every file the project ships, and edits the files until
they match: the model and embedding refs in `agents.yaml`, the `default` agent
and its instructions, the search skill, and `scripts/_setup.sh` to download the
documentation archive and build the index into `assets/docs-db`.

Progress goes to stderr and the whole run is written to
`rag-example/.tmp/logs/meta.<when>.log`; `tail -f` it from another terminal to
watch.

Anything it could not decide without guessing is left in
`SPECIFICATION-FEEDBACK.md` as a questionnaire. Tick one answer per question,
then fold them back in:

```sh
zen meta run rag-example /spec-apply-feedback
```

Then verify and build:

```sh
zen check                  # the project loads, the models answer
scripts/_setup.sh --check  # ...and says what it still needs
scripts/_setup.sh          # downloads the docs and builds the index - once
```

The setup script skips the work when `assets/docs-db` can already answer - it
asks `zen rag docs ready`, not whether the directory exists - so it is safe to
re-run. On a clone of a project whose index is committed, the vectors under
`lance/` are git-ignored and the step re-embeds them with
`zen rag docs restore` instead of downloading and indexing everything again.

`--check` asks those same questions and does none of the work, printing what is
missing and the command that produces it. That is the one to run on a fresh
clone: `zen check` will pass on a project whose index cannot answer a thing,
because an index is not something `agents.yaml` declares.

## 6. Ask it something

```sh
zen run rag-example
```

That opens the chat TUI. Try:

- `what is a pipeline and how do I create one?`
- `how do I fine-tune a model with the Trainer API?`
- `what is the weather today?` - it should decline, and say what it does cover

Every answer should name the document and the paragraph it came from. One-shot
runs work too:

```sh
zen run rag-example "how do I load a pretrained tokenizer?"
```

To see what actually happened in a run - prompts, tool calls, retrieved
passages, timings, token use:

```sh
zen inspect
```

## When an answer comes out wrong

Fix [SPECIFICATION.md](SPECIFICATION.md), not a prompt. Edit the sentence that
was missing, run `/spec-sync-project` again, and run it again. That loop is the
point of the example, and it is described in
[Specification-driven projects](../../../docs/specification.md).

## See also

- [Agent knowledge and document retrieval](../../../docs/knowledge.md)
- [Agent configuration](../../../docs/agents-yaml.md)
- [`@zenera/cli`](../../../packages/cli/README.md)
