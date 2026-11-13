---
name: zen-mcp
description: 'MCP servers (GitHub, Linear, Notion, ... through the Bifrost gateway) in a Zenera project - the `mcp:*` tool group (`mcp_servers`, `mcp_tools`, `mcp_describe`, `mcp_call`) that the platform plugin provides, where those tools work and where they only refuse, how to grant them in `agents.yaml`, how to install the runtime `mcp_tools` skill and per-workflow skills into `agents/skills`, how an agent discovers, searches and calls a tool, the connect-your-account pause, result limits, and caching tool routes in memory. Load before adding, reviewing or debugging `mcp:*` or any `mcp_*` tool in a project, or a skill or prompt that tells an agent to use an external service through MCP.'
user-invocable: false
---

# MCP tools in a project

External services - GitHub, Linear, Notion, Slack, Sentry and the other MCP
servers in Bifrost's library - reach an agent as **four generic tools** in group
`mcp`. A project does not declare servers, URLs or credentials. It grants the
group and teaches its agents how to use it.

| Tool           | Arguments                     | Returns                                                                            |
| -------------- | ----------------------------- | ---------------------------------------------------------------------------------- |
| `mcp_servers`  | none                          | `{ servers: [{ server, tools }] }`: the servers this run can use, with tool counts |
| `mcp_tools`    | `server`                      | `{ tools: [{ name, description }] }`: one-line descriptions                        |
| `mcp_describe` | `server`, `tool`              | `{ name, description, inputSchema }`: full text and JSON schema                    |
| `mcp_call`     | `server`, `tool`, `arguments` | `{ isError, content, structuredContent? }`, or a connect request                   |

Detail on each reply, the errors and the limits is in
[references/discovery.md](./references/discovery.md).

## 1. Where they come from, and who decides what is in them

- **The tools are the platform's, not the project's.** A plugin
  (`/opt/zenera/plugins/mcp.mjs`) that the host names in `ZEN_PLUGINS` adds
  them to every `zen` process in a Zenera pod. Nothing goes in `agents.yaml`
  except the grant, and nothing goes in `.env`.
- **Which servers exist** is up to the Bifrost admin. **Which of them this
  project may use**, and optionally which of their tools, is set by a project
  editor in the app under _Project settings → MCP servers_. You cannot see or
  change either from the project files. Ask the user which servers are enabled
  before naming one in a skill, or write the skill so it discovers them
  (`mcp_servers`) instead of assuming.
- **Each call acts as the signed-in user.** Most servers use per-user OAuth.
  The first call to a server the user has not connected **pauses the run**. The
  chat shows a Connect / Not now card, and the same call resumes with the result
  once the user connects, or fails with an error if they decline. With an older
  host, the result is `{ auth_required: true, connect_url, message }` instead,
  and the agent must give the user the link and stop. An agent never needs
  `current_user` to use MCP: identity travels with the run.

## 2. Where they work, and where they only refuse

| Run                                                  | MCP                                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------------------ |
| A chat in the Zenera app; the editor's Test tab      | Works, as the signed-in user                                                   |
| `zen run`, `zen meta`, batches, datasets, gym, a job | Tools are present; every call returns _"MCP is not available in this run"_     |
| Code in the sandbox (`run_command`, a skill script)  | Never: the run token is held by the `zen` process and never enters the sandbox |

Consequences you must design for:

- **You cannot exercise MCP from the terminal.** Check behaviour in the Test
  tab. A dataset case or rubric that depends on an MCP result fails for
  reasons unrelated to the change you are testing.
- **A script cannot fetch from a service.** The agent calls `mcp_call`, then
  writes what it needs into `/workspace` with the file tools, and the script
  reads it from there.
- **Without `ZEN_PLUGINS`, `mcp:*` does not resolve.** On a machine without the
  plugin, `zen check` and `zen run` fail with `unknown tool "mcp:*"`. That is the
  environment, not the project: in a Zenera pod the variable is set. Locally,
  point it at a copy of `mcp.mjs` (absolute path) in the real environment.
  `ZEN_PLUGINS` in `.env` is refused.

## 3. Obligations `zen check` does not report

A project that grants `mcp:*` is not finished until all of these hold:

1. **Grant the group only to the agents that act on external services.** Use
   `tools: [mcp:*, ...]`. Grant the group, not a hand-picked subset, because the
   four tools are one procedure and an agent missing `mcp_describe` guesses
   arguments. A router or a summariser does not get it.
2. **Install the runtime skill.** Copy
   [references/runtime-skill.md](./references/runtime-skill.md) to
   `agents/skills/mcp_tools/SKILL.md` unchanged in substance. It is the only
   thing that teaches a running agent the discover → describe → call order,
   how to search, how to handle the connect pause and truncation, and the memory
   rules. Bind it to every agent holding `mcp:*`: add it to `skills.allow`, and
   to `preload` when MCP is that agent's main job. How to do this:
   [references/install.md](./references/install.md).
3. **One project skill per recurring workflow** that names the server, the tool
   route and the argument shape, for example `agents/skills/linear_triage/`.
   Name only servers the user has confirmed are enabled, and tell the agent to
   fall back to discovery when the named tool is refused. See
   [references/install.md §4](./references/install.md#4-workflow-skills).
4. **A prompt line saying when to reach for it.** For example: _"For anything
   about the user's issues, pull requests or tickets, use the MCP tools - load
   `mcp_tools` first."_ A grant the prompt never mentions is used at the
   model's discretion.
5. **Memory policy for MCP**, if the project has `memory:`: cache routes, never
   results. See [references/memory-cache.md](./references/memory-cache.md). It
   goes in the `mcp_tools` skill (already there) and, for project-specific
   policy, `agents/memory-policy-instructions.md`.
6. **No `mcp_*` in a skill's frontmatter `tools:`.** An agent-level grant of the
   same name wins and is never gated, so the line does nothing except mislead
   the next reader. Gate by binding the skill, not the tool.
7. **No credentials, connect URLs or `ZEN_MCP_*` anywhere in the project.** The
   pod sets them and the project's `.env` cannot override them. A connect URL
   is per flow and expires.

There is no `requires: [mcp]` for house rules. The vocabulary is closed (see
`zen-instructions`), so MCP guidance lives in the skill, not in
`agents/*instructions.md`.

## 4. Review checklist

- [ ] Every agent with `mcp:*` has `mcp_tools` reachable: in `allow`, or the
      catalog is unrestricted. If MCP is its main job, the skill is also in `preload`.
- [ ] `agents/skills/mcp_tools/SKILL.md` exists and still has the discovery,
      search, connect and memory sections from the runtime template.
- [ ] Workflow skills name servers the user confirmed. Each says what to do when
      the server or tool is refused, and none hard-codes an id that belongs to
      one user (a team, repo or workspace of theirs).
- [ ] No prompt, skill or dataset expects MCP to work in `zen run` or a batch.
- [ ] No sandbox script expected to call a service itself.
- [ ] With `memory:`, nothing tells the agent to commit tool results, user
      data or whole tool lists.
- [ ] `zen check` passes in an environment with `ZEN_PLUGINS` set; behaviour
      checked in the Test tab.

## 5. When it goes wrong

| Symptom                                                   | Cause and fix                                                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `unknown tool "mcp:*"` at load                            | No `ZEN_PLUGINS` in this environment - §2. Not a project error in a Zenera pod                         |
| Every call: _"MCP is not available in this run"_          | A terminal, batch or job run. Use the chat or Test tab                                                 |
| `<server> is not enabled for this project (enabled: ...)` | Enable it in Project settings → MCP servers, or change the skill to a listed server                    |
| `<server>'s tool <tool> is not enabled for this project`  | The editor restricted that server's tools. Enable the tool or route around it                          |
| Agent guesses arguments, call fails validation            | It skipped `mcp_describe`. Check the runtime skill is loaded, or preload it                            |
| Result ends with `truncated: true` and a `note`           | Over 60,000 characters. Ask for less: filters, fields, smaller pages - discovery.md §5                 |
| Run sits waiting after a call                             | The user has not connected the service. The card is in the chat; nothing to fix in the project         |
| Agent pastes a link and stops                             | Older host without pause support: `auth_required` + `connect_url`. Correct behaviour                   |
| Agent re-lists every server's tools every turn            | The runtime skill's search procedure is missing, or memory routes are not committed                    |
| Agent acts on a recalled route that no longer exists      | Memory was trusted over the server. The skill must say to re-describe on any refusal - memory-cache.md |

## References

| File                                                         | Read when                                                                        |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| [references/install.md](./references/install.md)             | Adding MCP to a project: `tools:`, skill install and binding, workflow skills    |
| [references/discovery.md](./references/discovery.md)         | How a run finds servers and tools, searches, calls, and reads replies and errors |
| [references/memory-cache.md](./references/memory-cache.md)   | The project has `memory:`, or an agent re-discovers the same tools every run     |
| [references/runtime-skill.md](./references/runtime-skill.md) | The text to copy to `agents/skills/mcp_tools/SKILL.md`                           |
