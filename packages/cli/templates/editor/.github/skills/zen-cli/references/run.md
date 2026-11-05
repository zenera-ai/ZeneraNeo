# Running - `zen run`

```
zen run [project] [prompt] [options]
```

On a terminal with no prompt it opens the TUI. With a prompt, or with no tty, it
answers once on stdout and exits.

## Options

| Flag                    | What it does                                              |
| ----------------------- | --------------------------------------------------------- |
| `--project <name\|dir>` | Which project. Inferred from the directory otherwise      |
| `--session <id>`        | Continue a particular session                             |
| `--new`                 | Start a new session rather than continuing one            |
| `--input <file>`        | Read the whole request from JSON; `-` is stdin            |
| `--workspace <dir>`     | What the agent may read and write                         |
| `--here`                | `--workspace` with the directory you are in               |
| `--memory <dir>`        | Where the agents remember into, instead of the project's  |
| `--memory-read-only`    | Recall from it; write nothing back                        |
| `--model <ref>`         | Override the default model for this run                   |
| `--image <ref>`         | Override the container image commands run in              |
| `--podman`              | Podman here, even when a `ZEN_PLUGINS` plugin provides it |
| `--read-only`           | Withhold every tool that can write                        |
| `--as <user>`           | Act for this user - see below                             |
| `--plain`               | Never open the TUI; a prompt is then required             |
| `--theme <dark\|light>` | Palette for the TUI; `auto` detects. `$ZENERA_THEME`      |
| `--out <file>`          | Put the answer in this file instead of on stdout          |
| `--batch-dir <dir>`     | Where a batch's runs live. `<project>/batches/<stamp>`    |
| `--concurrency <n>`     | How many of a batch run at once. Default 16, most 32      |
| `--yes`                 | Say yes to the workspace and install questions            |

Flags always beat the file: the repository states intent, the invocation
overrides it.

## Where the answer goes

The answer goes to stdout and the progress to stderr, so `zen run "…" >
answer.md` leaves a file with the answer in it and nothing else, watched or not.
`--out` is a destination rather than a copy: it takes the answer off stdout, so
the file is the only place it lands.

```
zen run "what changed?" > out.md              answer in the file, progress on screen
zen run "what changed?" > out.md 2>/dev/null  ... and nothing on screen at all
zen run --out out.md "what changed?"          the same file, stdout left empty
zen run --json --out run.json "what changed?" the whole envelope, in a file
```

There is no `--quiet`. Narration is on stderr already, so a redirect is enough;
`--json` silences it for machine use.

`--json` answers with the paths as well as the answer: the session and run
directories, every file the run left behind, and every tree the agent could see,
with the path it had on this machine beside the path it had inside the
container. `--out` takes that envelope off stdout the same way it takes the
prose — with `--json` the envelope _is_ the answer, so the file holds all of it
and stdout is left empty.

```json
{
    "session": { "id": "...", "dir": "<project>/sessions/<id>" },
    "run": {
        "id": "...",
        "dir": "<project>/sessions/<id>/runs/<run-id>",
        "input": ".../input.md",
        "output": ".../output.md",
        "state": ".../state.json",
        "meta": ".../meta.json",
        "report": ".../report.html",
        "graph": ".../graph.mmd"
    },
    "mounts": [
        { "host": "...", "at": "/workspace", "readOnly": false },
        { "host": "...", "at": "/assets", "readOnly": true },
        { "host": "...", "at": "/skills/<name>", "readOnly": true }
    ],
    "agent": "...",
    "stopReason": "final",
    "durationMs": 0,
    "usage": {},
    "output": "the answer"
}
```

`mounts` also lists the container's `$HOME` and, when keys are forwarded, the
credential files mounted under `/run/zenera/keys`.

## A request in a file

`--input <file.json>` is the whole invocation written down. It is the only way
to ask about a picture - a command line cannot carry one - and it is what makes
a run reproducible: a case is a file, so it can be checked in, diffed and re-run.

```json
{
    "project": "acme",
    "input": [{ "text": "what is in this picture?" }, { "image": "./shot.png" }],
    "workspace": "./ws",
    "memory": "./mem"
}
```

Only `input` is required, and it may be a plain string instead of an array. Each
part is a bare string, `{ "text": "…" }`, one of `{ "image" | "audio" | "video" |
"file": "…" }`, or the canonical `{ "type", "url", "mimeType" }` - the same shapes
the library's `Input` accepts, because the file is a JSON projection of it.

Three rules, and they are the whole of the format:

- **Paths are relative to the file**, not to the directory you ran from, so a
  case travels with the images beside it. With `--input -` there is no file, so
  they are relative to the cwd. A bare `project` is a registered name and is
  left alone; one starting with `.` or `/` is a directory.
- **The file wins** over the same flag on the command line. A field it leaves
  out falls through to the flag, then to the usual default. This is the one
  place the rule above the options table is reversed - the file _is_ the
  invocation, not a repository's standing intent.
- **A local media path is inlined** as a `data:` url, so the state a run resumes
  from carries the picture rather than a path that meant something elsewhere.
  `http(s):` and `data:` urls are passed through untouched. The bytes land in
  `state.json` and are rewritten on every later turn of that session, so there
  is a 20 MB ceiling and a warning well before it.

A request never opens the TUI and never asks about the workspace, exactly like a
prompt on the command line. Giving both a prompt and `--input` is an error.

```
zen run --input case.json --json | jq -r .output
cat case.json | zen run --input - --json
zen run --input case.json --json --out result.json          everything, in a file
zen run --input case.json --session 20260825-143012-a7f3   continue, don't start
```

`--plain` never opens the TUI. The TUI is the only thing that can ask for a
prompt, so with `--plain` the prompt has to be there already - in the argument
or on stdin - and `zen run --plain` with neither is an error instead of a
window. Say it in a script that must not meet one.

## Many at once - `zen run batch`

```
zen run batch --input cases.json [--batch-dir <dir>] [--concurrency 16]
              [--memory <dir>] [--memory-read-only] [--out <file>] [--json]
```

The same file, pluralised. One project, many questions, sixteen at a time by
default:

```json
{
    "batch": [
        { "id": "vat", "input": "what is the VAT threshold?" },
        { "input": [{ "text": "what is this?" }, { "image": "./shot.png" }] },
        { "id": "ws", "input": "read the notes", "workspace": "./cases/ws" }
    ]
}
```

An item takes `input`, an optional `id` and an optional `workspace`, and nothing
else. `project` and `memory` belong to the batch rather than to an item, so they
are flags: a file that names either is refused rather than half-honoured. An
`id` names a directory, so it has to be one - letters, digits, dot, dash and
underscore - and it defaults to the item's index. Two items may not share an
`id` or a `workspace`, because they run at the same time.

Everything refusable is refused before the first model call. A batch pays for a
mistake once per item.

### What it leaves behind

```
<batch-dir>/
    README.md           a live dashboard, rewritten every second
    batch.json          the index: every item, whether it worked, where it is
    <id>/
        workspace/      what that item could read and write
        memory/         its own copy, in the copying mode only
        output.json     exactly what `zen run --json` prints for one run
```

`README.md` is where the progress of a batch lives. Sixteen agents narrating at
once would be noise, so instead the file is rewritten once a second: a
fixed-height panel showing every worker - what it is running, the tail of what
it is thinking or writing, its turns and its tokens - over a `Tokens by model`
table, a table of the finished ones and a list of the ones still waiting. The
panel keeps its height while there is work left to start, so nothing jumps
between ticks. Watch it in an editor preview, or `watch -n1 cat "$DIR/README.md"`.
When the batch ends the same file is the report.

Tokens are reported **per model**: agents may each use a different one, so one
total belongs to none of them. Every model id gets a row with its calls and its
input, cached, output and thinking tokens, and the rows always add up to the
batch total. Tokens spent summarising, which no node attributes to a model, are
shown as `(compaction)`.

Each `output.json` is written the moment its item finishes, so a batch stopped
half way still has every answer it managed to get. `batch.json` is an index, not
a second copy - it points at the files:

```json
{
    "batch": {
        "dir": "...",
        "items": 3,
        "ok": 2,
        "failed": 1,
        "concurrency": 16,
        "memory": { "source": "...", "mode": "read-only" },
        "usage": {
            "inputTokens": 0,
            "cachedInputTokens": 0,
            "outputTokens": 0,
            "reasoningTokens": 0
        },
        "models": [{ "model": "gemini-3-flash", "calls": 12, "usage": {} }],
        "durationMs": 0
    },
    "batch_results": [
        { "index": 0, "id": "vat", "ok": true, "input": "…", "output": ".../vat/output.json" },
        {
            "index": 1,
            "id": "1",
            "ok": false,
            "input": "…",
            "output": "...",
            "error": { "message": "…" }
        }
    ]
}
```

A failure is data. One item that cannot be answered costs one answer, not the
other ninety-nine; the exit code says how many failed, and it is set after
everything is written.

stdout is the batch directory and nothing else, so `ls "$(zen run batch --input
cases.json)"` works. `--json` prints the index there instead. Progress is in
`<batch-dir>/README.md` either way. `--out` puts the index in a second file as
well.

### Memory, in two modes

A memory is a locked directory, so sixteen runs cannot hold one. Which leaves
two honest arrangements, and the flag picks between them:

| Mode                 | What happens                                              |
| -------------------- | --------------------------------------------------------- |
| `--memory-read-only` | Every item recalls from the one graph. Nothing is written |
| default              | Each item gets a copy under `<batch-dir>/<id>/memory`     |

In the copying mode the project's own memory is never touched. Fold what the
items learned back in afterwards, having read it:

```
zen memory merge <batch-dir>/*/memory
```

An item that committed nothing leaves no `memory/` behind, so that line never
names a directory `merge` would refuse.

`--memory <dir>` names the source in both modes; without it the source is the
project's own memory, and a project with none runs the batch with none. A
source that does not exist yet is not an error in the copying mode: a project
declares its memory directory and the first run makes it, so every item simply
starts from an empty graph. That is how a cold project is warmed, and pointing
`--memory` at a directory that is not there is how you ask for it deliberately.
Each copy is the source as of one moment, so a run still writing it is fine.

`--memory-read-only` works on a single `zen run` too. It is how you ask a
question of what the agents know without changing what they know.

### What means nothing in a batch

`--session`, `--new`, `--workspace`, `--here`, `--plain` and `--theme` are refused by
name rather than ignored. Every item is a new session of its own, they cannot
share a workspace, and a batch never draws the TUI.

For a project or a prompt actually called "batch", say `--project batch`.

## Acting for a user - `--as`

A run is for nobody unless the host says otherwise: `current_user` answers
`authenticated: false` and `ZEN_USER_*` is unset in the sandbox. `--as` names
the user, so a project whose answers depend on who is asking can be tried here:

```
zen run --as ann@acme.com "what are my open tickets?"
zen run --as u-123 "…"                                  an id: ZEN_USER_ID only
ZEN_USER_ROLE=viewer zen run --as ann@acme.com "…"      a role too
zen run batch --input cases.json --as ann@acme.com      every item as Ann
```

An email sets both the id and `ZEN_USER_EMAIL`; `ZEN_USER_ROLE` and
`ZEN_USER_NAME`, when exported, fill in the rest. It is always `source: local` -
a statement, not a login - so code that trusts the identity only for `host`
treats it as untrusted, which is what a test of that code should see. Without
`--as`, already-exported `ZEN_USER_*` are used the same way. A project's `.env`
cannot set them. `--json` and the run's `meta.json` record the user as `user`.

## Which word is the project

The first positional is read as a project when it names one, and as the first
word of the prompt when it does not:

```
zen run acme                     the acme project, TUI
zen run acme "what changed?"     the acme project, one answer
zen run "what changed?"          this directory's project, one answer
zen run --project why "why?"     when the project is called "why"
```

The prompt comes from the argument, or from stdin, or from the TUI:

```
git diff | zen run "summarise this diff"
```

## What a prompt on the command line implies

A prompt is a request for an answer, not a conversation to pick up, so it
answers the three questions itself: **a fresh session**, **a fresh, empty
directory inside it** (`<session>/workspace/`) as the workspace, and **no
confirmation**. To have it read and write the directory you are in, say
`--here` (the same as `--workspace .`). Every flag still wins - `--session`,
`--workspace`, `--here` and `--read-only` override it - and the TUI, where
there is someone to ask, still asks.

```
zen run "draft a release note"            works in sessions/<id>/workspace/
zen run --here "what changed?"            reads and writes the directory you are in
```

There is no `resume`. A session continues itself, because its state is what it
is; `--session <id>` picks which one.

`--new` only matters when there is no prompt. A prompt on the command line
already starts a new session, so `zen run --new "what changed?"` is the same as
`zen run "what changed?"`. Without a prompt the TUI asks which session to
continue, and `--new` is how you skip that question. It contradicts `--session`.

## The TUI

Drawn only when there is a terminal on both stdin and stdout, no prompt,
no `--plain` and no `--json`. It streams the answer, shows
reasoning as it arrives, and reports per-turn and per-session token usage in the
footer.

Reasoning only _arrives_ if the model was asked for it: OpenAI needs
`reasoningSummary` on the responses API, Anthropic needs `thinkingBudgetTokens`,
Gemini has `includeThoughts` on by default. An OpenAI project shows nothing
until `agents.yaml` asks.

Palette selection: `--theme` > `$ZENERA_THEME` > a query to the terminal >
`COLORFGBG` > dark.

## Sessions

One session is one continuing conversation, with its own workspace, memory and
run history. Ids look like `20260825-143012-a7f3`.

```
<project>/sessions/<id>/
    workspace/          what the agent sees, unless --workspace said otherwise
    runs/<run-id>/      input.md, output.md, state.json, report.html, graph.mmd, meta.json
    .data/
        state.json      the live, resumable state, rewritten after every run
        session.json    when it was made, and the workspace it is rooted at
        blobs/
        sandbox/home/   /home/agent inside the container
    .lock               held while a run is in flight
```

Memory is **not** in here: the graph belongs to the project, at
`<project>/memory/`, so what one session learned is there for the next one.

The recorded workspace is what makes resuming safe: a session that quietly
changed what "the workspace" meant between turns would be unexplainable, so it
is written once and reused.

None of `sessions/` is source and none of it is committed.

A session is locked while it runs, and a lock whose process is gone is stale by
definition and is taken over.

## Afterwards

Each run writes a `report.html` next to its state; the run prints a
`file://` link to it. It writes a `graph.mmd` beside it too - the same
trajectory as one Mermaid flowchart, which is what `zen inspect graph` prints.
See [inspect.md](inspect.md).
