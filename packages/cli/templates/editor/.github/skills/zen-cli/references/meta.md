# `zen meta` - the meta agent, on this project

```
zen meta run [project] "<question>"        ask it something
zen meta run [project] /<name> [words]     run the command .github/skills/<name>/SKILL.md
zen meta chat [project] [question]         a conversation, in a terminal only
zen meta prompts [project]                 list the commands (skills without zen-)
zen meta resume [project] [session]        carry on a run that stopped
zen meta model [ref]                       show or set the model it uses
zen meta dataset <verb>                    see dataset.md
```

Provided by `@zenera/meta` - `npm i -g @zenera/meta` if `zen meta` says it is
not installed. `zen meta dataset` and `zen meta finetune` come with it.

`zen meta --help` has every option.

`zen meta chat` needs a person at a terminal: it refuses `--json` and a
stdin that is not a TTY. From a script or another agent, use `zen meta run`.

## `--json`

`zen meta run --json` prints ONE object on stdout when the run ends:

```json
{
    "project": "/path/to/project",
    "provider": "vertex",
    "model": "vertex/gemini-3.8-flash",
    "sessionId": "…",
    "exitCode": 0,
    "resumes": 0,
    "usage": {},
    "tokens": {
        "calls": 12,
        "inputTokens": 0,
        "cachedInputTokens": 0,
        "outputTokens": 0,
        "reasoningTokens": 0
    },
    "answer": "the final answer, as markdown",
    "answerFile": "/path/to/project/.tmp/logs/meta.<when>.md"
}
```

`tokens` is summed over every model call of the run; `usage` is the meta
agent's own end-of-session summary, passed through as it came, and may be absent.

- Progress goes to stderr as plain lines: no box, no animation, no status row.
  stdout carries the object and nothing else, so redirect it to keep it:

    ```
    zen meta run acme /analyze --json > analyze.json
    zen meta run acme /analyze --json > analyze.json 2> analyze.log
    ```

- Nothing is asked. A `run` with no question, no `/<name>` and nothing piped
  in is a usage error (exit 2) that lists the prompts, not a menu.
- A run the meta agent ends in failure still prints the object, then exits 1.
  Check `exitCode`; `sessionId` is what `zen meta resume` takes. A run that
  never starts (no key, bad model) prints no object, only the error.
- `--dry-run --json` gives `{project, provider, model, from, command, env}`,
  secrets masked, and runs nothing.
- `zen meta prompts --json` gives `[{name, description, path}]`;
  `zen meta model --json` gives `{model, from, sources}`.

The answer is also saved as markdown on every run, with or without `--json`;
`answerFile` is its path.
