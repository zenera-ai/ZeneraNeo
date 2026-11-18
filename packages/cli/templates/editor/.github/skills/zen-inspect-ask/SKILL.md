---
name: zen-inspect-ask
description: 'Use when formulating a question for `zen inspect ask` about an `llm_call` node of a recorded Zenera run - especially a "why did you NOT do X" question (why no `memory_search` first, why no `fork` for independent research branches, why no skill, why no test run). Covers choosing the node, ruling out missing tools before asking, wording the counterfactual so the answer quotes the instruction that blocked the better behaviour, and verifying that quote against the recorded request.'
user-invocable: false
---

# Asking a run why it did not do the better thing

`zen inspect ask` replays one recorded `llm_call` - its system prompt, messages
and tool schemas, byte for byte - with tool calling off and a preamble that
permits the model to quote its own instructions. Load **zen-inspect** for the
mechanics (graph, node, flags). This skill is about the one thing that decides
whether the call is worth its cost: **the question**.

The goal of every question here is the same: **find the sentence in the
assembled prompt that prevented the good behaviour**, or prove that no sentence
asked for it. That sentence is what you are about to edit. An answer that does
not name one is a wasted call.

Non-interactive rule, as in zen-inspect: always pass the node, the question and
the run. The question is always a file (section 3):

```sh
zen inspect ask <llm-node-id> --question-file <question file> --dir <run-dir>
```

Each non-interactive call is a **fresh replay**. It does not remember your
previous question. A follow-up must restate what it builds on.

For a whole-run audit, **zen-analyze-run** owns the replay budget: default
zero, at most two invocations including retries and second opinions. Its
budget and uncertainty gate take precedence over the retry suggestions below.
Do not replay a healthy run or ask about a cause already established by
recorded evidence.

## 1. Rule out the cheap causes first

A "why didn't you" question is only about instructions if the model could have
done it. Check these from the graph and the node before spending a model call -
each one is a finding on its own, and asking the model about it produces an
invented rationale.

| Check                                  | How                                                                                     | If it fails, the cause is                          |
| -------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------- |
| The tool was offered on that call      | `--part tools` of that call (below)                                                     | `agents.yaml` - tool not granted, or depth cap hit |
| The instruction file was in the prompt | the `system_prompt` label lists files: `fork-instructions.md`, `memory-instructions.md` | missing file, or its `requires:` not met           |
| The skill was loaded                   | a `load_skills` node naming it, or the skill index in `request`                         | binding in `agents.yaml` (`skills:`)               |
| Memory was already recalled for it     | a `memory_recall` node before the call; `recall 0 nodes`                                | memory content, not behaviour                      |
| The context still held what it needed  | no `compaction` before the node, or the item is not `hidden by` one                     | compaction, not instructions                       |

```sh
zen inspect node n9 --part tools --dir <run-dir> | grep -xE 'fork|memory_search|memory_grep'
```

Only when every row passes is the question "which instruction stopped you".

## 2. Pick the node where the decision was made

The replay ends at the chosen node: the model sees everything up to and
including that call's own answer, and **nothing after it**. So ask the call that
made the choice, not the one where the consequence showed up.

| Missing behaviour               | Ask the `llm_call` that...                                                          |
| ------------------------------- | ----------------------------------------------------------------------------------- |
| never searched memory           | issued the first tool call of the task (usually the first `llm` after `user input`) |
| ran independent work in series  | issued the **first** of the sequential calls - it already had the whole plan        |
| never loaded / followed a skill | chose the substitute action (the `python -c`, the hand-rolled grep)                 |
| handed off too early            | carries `calls transfer_to_<name>`                                                  |
| gave up / answered too early    | the last `llm` before `final output`                                                |
| repeated a failed call          | the one right after the first `ERROR` result                                        |

If the choice repeated (four serial searches), ask **once**, not per step. Ask
the first call when the question is why it started that way - it already had
the whole plan. Ask the last call of the sequence when the question is about
the sequence as a whole - its replay holds every step. Never ask a middle one:
that gets "I was continuing the pattern I had started", which names no
instruction.

## 3. Formulate the question

### What the replayed model can see

The model you are asking sees **only its own raw context** at that call: the
system prompt, the messages up to that point, the tool descriptions, and the
answer it gave - its text and its tool calls. That is all. So:

- **No node ids, no graph words.** `n7`, `llm_call`, `tool_result`, "branch
  n12" are your index, not its world. Name what it did by its content: "you
  ran `grep -rn invoice /workspace/src`", "your first tool call was
  `read_file` on `src/export.ts`".
- **Refer to earlier steps by what they were**, as it saw them in its
  messages: "after `memory_search` returned the export node", "after the
  third `run_command` failed with exit code 1".
- **Describe anything after the call yourself, in plain words.** The replay
  ends at that call; it cannot see what followed. "You then searched three
  more topics one after another" is something it can only learn from you.

### What the preamble already does

`ask` puts a preamble in front of the replayed system prompt, and it already
makes the model do the following:

- cite every reason as `[<kind>: <name> › <heading or parameter>] "<verbatim quote>"`,
  where kind is system prompt, skill, tool description or message
- trace the decision: the options it could see, which one it took, and which
  text tipped it
- say which instruction it followed, which it missed, which two conflicted, and
  any exception it judged to apply
- write "no instruction — my own default" instead of making up a source
- use the answer format the question asks for

**Do not restate any of that in the question.** Asking again for verbatim
quotes or sources adds a second, differently worded copy of the rule, and the
model follows whichever it read last.

### The three parts

The question supplies only what the preamble cannot know. Leave a part out and
the answer drifts to a generic apology.

1. **What it did, by content.** The action as it appears in its own answer,
   stated as a fact, not an accusation.
2. **Why not the better action - asked directly.** "Why didn't you use
   `memory_search` to look up the invoice export first?" Name the action
   concretely - the tool as it appears in its tool list, and the arguments or
   branches it could have used - and say it was available. Never ask "did you
   consider...": its own answer already shows it did not take that path, and
   the question invites a yes that explains nothing.
3. **A fixed answer shape.** So answers can be compared across calls and
   runs, and so an answer without a citation is visibly empty. The shape uses
   the preamble's citation form.

Write the question to a file with your file-editing tool, then hand `zen` the
file. The shell never parses the question, so quotes, apostrophes, backticks and
`$` arrive as written. End the file with this shape, verbatim:

```text
<the question>

Answer in this shape:
options: <what you could see at that point, and which one you took>
steered-by: [<kind>: <name> › <heading or parameter>] "<quote>"   (one per line, or: no instruction — my own default)
should-have-applied: [<kind>: <name> › <heading or parameter>] "<quote>"   (or: none found)
exception: [<kind>: <name> › <heading or parameter>] "<quote>"   (or: none)
conflict: <the two citations that pulled in different directions, or: none>
missing: <the sentence that, added where, would have made you do it>
```

```sh
zen inspect ask n9 --question-file .tmp/ask/<run-id>/n9-memory.md --dir <run-dir>
```

- One file per question, at `.tmp/ask/<run-id>/<node>-<topic>.md`. `.tmp/` is
  the project's git-ignored scratch. A tuning loop's brief names its own `ask/`
  folder instead: use that one.
- `--question-file` is the only way the question reaches `zen`. Never a quoted
  argument, a heredoc, `$(cat ...)`, or a Python or Node script around `zen`.
- A retry (section 5, step 1) or a second opinion (step 4) reuses the same
  file: add `--model <ref>` and change nothing else.

### Wording rules

- **Ask why not, directly.** "Why didn't you fork the four lookups?" - not
  "did you consider forking?", not "would forking have been better?".
- **Do not lead.** "Didn't fork-instructions tell you to parallelise?" gets
  "yes, I should have" - agreement, not a cause. Name the action, never the
  instruction you suspect.
- **Do not ask what it should have done.** That produces a lecture on best
  practice written from general knowledge, not from its prompt.
- **One behaviour per question.** Memory and forking in one question get one
  shallow answer each. Ask twice.
- **Name the alternative as an action, not a virtue.** "Why didn't you
  `memory_search` for 'invoice export endpoint'?" - not "why weren't you more
  efficient?".
- **Keep the exception line.** A rule with an escape hatch ("unless...", "only
  when...", "for simple tasks...") is the most common blocker. The preamble asks
  for exceptions, but a model will not volunteer that it granted itself one
  unless an empty `exception:` line is waiting for it.

## 4. Templates

The question bodies below replace `<the question>` in the file of section 3.
Replace every command, tool argument and topic with the run's own. None of them
mentions a node id: the id goes on the command line, never in the question.

### Did not use memory

```text
Your first step for this task was run_command `grep -rn 'export' /workspace/src`.
Why didn't you use memory_search or memory_grep to look up the invoice export
endpoint first? Both are in your tool list, and an earlier run may already have
worked it out. What in your instructions, or missing from them, made the
workspace the first place to look?
```

### Recalled memory, then redid the work

```text
memory_search returned a node describing the invoice export endpoint and where
it is implemented. Your next step was to grep the workspace for the same
endpoint. Why didn't you use what memory returned, or memory_load that node to
read it whole? What made the recalled text not enough?
```

### Did not save what it learned

```text
To answer this you read eleven files and ran four commands, and your answer
names facts a later run would need again. memory_commit is in your tool list.
Why didn't you commit what you worked out before answering?
```

### Did not fork independent research

```text
From this point you researched four things one after another: (A) the auth
flow, (B) the billing schema, (C) the retry policy, (D) the webhook format.
None of the later lookups used an earlier result. Why didn't you call fork once
with a branch for each of A-D? fork is in your tool list.
```

### Did not follow a loaded skill

```text
You called run_command with `python3 -c` to check the output. The skill
run-tests is in your context and says to run `npm test`. Why didn't you run
`npm test`? What made the inline script look acceptable here?
```

### Misused a tool

```text
You called memory_commit three times with a `refs` array naming nodes from an
earlier commit, and each call failed. Why did you expect refs to reach nodes
committed earlier? Which words in the memory_commit description led you there,
or what was missing from it?
```

The same skeleton covers any missing behaviour: **what it did, by content ->
why not the better action, available -> shape.** The preamble does the rest.

## 5. Verify the answer

The answer is testimony. It is useful because it points at a sentence; it is
only a finding once the sentence is confirmed.

1. **Grep each quote in the recorded request** - the text between the double
   quotes of each `[...] "..."` citation.
    ```sh
    zen inspect node n9 --part request --dir <run-dir> | grep -F 'Do not fork a sequence'
    ```
    Reuse a request already retrieved; fetch it once and check all quotes
    against that copy. A match in a project file alone does not prove delivery.
    A quote that is not there is invented - discard the answer, not just the
    quote. Retry only within the caller's budget; otherwise report that
    attribution remains unresolved.
2. **Find every copy.** The blocker often exists twice - once in a house rule,
   once in a skill with a softer tail. Grep the whole request for a distinctive
   phrase of it, then grep the project's `agents/` tree for the file to edit.
3. **Check it is the project's file.** `fork-instructions.md`,
   `memory-instructions.md`, `tools-instructions.md`, `files-instructions.md`,
   `mcp-instructions.md`, `mcp-memory-instructions.md`, `markdown-instructions.md`, `a2ui-instructions.md` and
   the `a2ui` / `a2ui-charts` skills are zen's own copies; load
   **zen-instructions** before changing where that rule lives.
4. **Second opinion only when justified.** A thin answer or `no instruction -
my own default` does not itself justify more replay. In a whole-run audit,
   use a second opinion only after an invented quote, and within the two-call
   total budget: `--model <ref>`, the identical question file.
5. **Reproduce.** After the edit, rerun the case and check the graph: the
   `tools` header row shows `fork x1` or `memory_search x1` where it did not
   before. The answer predicted a fix; the graph confirms it.

## 6. Reading the answer

| Answer says                                                | Means                                       | Fix                                                               |
| ---------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------- |
| `should-have-applied: none found`                          | nothing asked for it                        | add a mechanical rule at the point of decision                    |
| `steered-by: no instruction — my own default`              | the model's habit filled a gap              | add a mechanical rule at the point of decision                    |
| a rule quoted as `should-have-applied`, nothing against it | the rule is there but not reachable in time | move it earlier, or into the skill loaded for that task           |
| a `steered-by` quote that argues against the better action | an instruction argued against it            | narrow or remove the blocker, do not add a counter-rule beside it |
| `conflict:` names two rules                                | two instructions disagree                   | delete one; two copies of a rule is how drift starts              |
| an exception is quoted as applying                         | a self-judged escape hatch                  | remove the hatch or make its condition checkable                  |
| no citation at all, general reasoning only                 | the question was too open, or led           | rewrite with the three parts; do not act on it                    |
