# Installing MCP in a target project

Edits in this order, followed by `zen check` and a Test-tab run. Every path
is relative to the project root, the directory with `agents.yaml`.

## 1. Find out what is enabled

The project files do not say which MCP servers the project may use. That is set
in the app (_Project settings → MCP servers_), and the editor cannot read it.
Ask the user:

- which servers are enabled (as named there: `github`, `linear`, `notion`, ...),
- whether any server is limited to some of its tools,
- which jobs the agents should do with them.

If they do not know, grant the tools and stop at step 3: the house rules
discover servers at run time, so the project works whatever is enabled later.

## 2. Grant the tools in `agents.yaml`

Add the group to each agent that acts on an external service, and to no other:

```yaml
agents:
    - name: assistant
      tools: [files:*, mcp:*] # mcp: GitHub and Linear as the signed-in user
      skills:
          allow: [linear_triage, house_style]
```

- **Grant `mcp:*`, not single tools.** `mcp_servers`, `mcp_tools`,
  `mcp_describe` and `mcp_call` are one procedure. `mcp:mcp_call` alone leaves
  the agent guessing arguments.
- **Take `mcp_call` away for read-only reviewers**: `tools: [mcp:*, -mcp_call]`
  lets an agent see what exists without acting on it. MCP cannot tell a read
  from a write, so this is the only way to keep an agent from changing
  anything upstream.
- **Handoffs.** A router that only routes does not get `mcp:*`. Hand off to the
  agent that has it, and say so in that agent's `description:`.

## 3. The house rules

Nothing to copy. The grant is what delivers them: `agents/mcp-instructions.md`
(`requires: [tools:mcp]`) reaches every agent granted the group, and
`agents/mcp-memory-instructions.md` (`requires: [tools:mcp, memory]`) those that
also have memory. Both are zen's copies, scaffolded into every project.

- If either is missing - a project scaffolded by an older `zen` - run
  `zen check --fix`. `zen check` reports it as `mcp.uninstructed` or
  `mcp-memory.uninstructed`.
- Never edit them. Project-specific text goes in a file beside them,
  `agents/mcp-policy-instructions.md`:

```markdown
---
requires: [tools:mcp]
---

# Services in this project

- `github` - pull requests, reviews and issues in the user's repositories.
- `linear` - the user's issues and projects.
```

List only servers the user confirmed. Leave the file out if none were: the
agent discovers them. Copy the `requires:` line - without it the file reaches
every agent.

- A project that still has the older `agents/skills/mcp_tools/` skill: delete
  it and its `allow`/`preload` entries. The house rules replace it.

### Skills from somewhere else

`skills:` at the top of `agents.yaml` accepts a list, so a team can keep shared
MCP skills in one directory and use them in several projects:

```yaml
skills:
    - agents/skills
    - ../shared/mcp-skills # github_review, linear_triage
```

With several directories the catalog is mounted at `/skills/<folder>` per
directory, not at `/skills`. Check the path a skill writes for its own files
(§3.4.1 in `copilot-instructions.md`). A directory outside the project is not
packaged into a release, so copy the skills in before `zen server build`.

## 4. Workflow skills

A recurring job gets its own skill, so the agent goes straight to the right tool
instead of discovering it every time. One folder per job:

```
agents/skills/linear_triage/SKILL.md
```

```markdown
---
description: Triage the user's open Linear issues - list, group by state and priority, propose next steps.
---

Needs the `mcp_*` tools. Without them, say MCP is not
available here and stop.

1. `mcp_call` server `linear`, tool `list_issues`, arguments
   `{ "assignee": "me", "state": "open", "limit": 50 }`.
   Before the first call in a run, `mcp_describe` it to confirm the arguments.
2. Group by state, then priority. Do not fetch each issue again: the list has
   what triage needs.
3. Propose next steps. Change nothing in Linear unless the user asks.

If `linear` or `list_issues` is refused as not enabled, tell the user which one
and that a project editor enables it in Project settings → MCP servers. Do not
try a different server.
```

The server, tool and arguments above are an illustration. Write the ones the
user confirmed, and leave argument details to `mcp_describe` when unsure.

Rules for these skills:

- **State the prerequisite first** (the `mcp_*` tools) and what to do without
  it. The catalog is readable by every agent, including ones not granted the
  skill.
- **Name the tool and argument shape, but still describe once per run.** Tools
  change upstream, and one `mcp_describe` is cheap insurance.
- **Writes need consent.** Any step that creates, updates or deletes something
  upstream (a comment, an issue, a merge) asks the user first, unless the user's
  request was itself that write.
- **No user-specific ids.** A team id, repo or workspace belongs to one user.
  The skill tells the agent how to find it (`list_teams`, or memory), not the
  value itself.
- **Do not restate the house rules.** Discovery, the connect pause and
  truncation are already in every MCP agent's prompt.
- **Bind it** in `skills.allow` of the agents that hold `mcp:*`.

## 5. A prompt line

In `agents/prompts/<name>.md` of each agent from step 2, one line saying when to
reach for the services - for example _"For anything about the user's issues,
pull requests or tickets, use the MCP tools."_ A grant the prompt never
mentions is used at the model's discretion.

## 6. Check

```sh
zen check
```

- `unknown tool "mcp:*"` means this is not a Zenera environment. Keep the grant
  and check the project in Zenera.
- `mcp.uninstructed` or `mcp-memory.uninstructed`: run `zen check --fix`.
- `skills.allow` / `preload` naming something absent means the folder name and
  the binding differ.

Then open the editor's **Test tab** and ask for something that needs the server.
Expect one connect card the first time per service; after that, the answer. A
`zen run` from the terminal only proves the project loads: every MCP call there
returns _"MCP is not available in this run"_.
