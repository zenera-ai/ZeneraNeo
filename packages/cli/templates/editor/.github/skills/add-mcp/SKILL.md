---
name: add-mcp
description: Give this project's agents external services (GitHub, Linear, Notion, ...) through the MCP tools.
argument-hint: '[which services, and what the agents should do with them]'
disable-model-invocation: true
---

Add MCP to this project: grant the `mcp:*` tools, install the runtime skill that
teaches agents to use them, and add a skill for each recurring job.

Load the `zen-mcp` skill first. It holds the rules and the files this command
copies. If the project has a `memory:` block, also load `zen-memory`. If any
agent will hand MCP data to code it runs, also load `zen-code-python`.

1. **Ask** which servers are enabled for this project in Project settings → MCP
   servers, whether any is limited to some tools, and what jobs the agents
   should do, if I have not already said. The project files cannot answer this.
2. **Pick the agents** that act on external services. Add `mcp:*` to their
   `tools:` in `agents.yaml` with a short comment saying which services they use,
   and `-mcp_call` for any that must only look
   (`zen-mcp` → `references/install.md` §2).
3. **Install the runtime skill.** Copy
   `.github/skills/zen-mcp/references/runtime-skill.md` to
   `agents/skills/mcp_tools/SKILL.md`. Fill in its _Servers_ section with the
   confirmed servers, or delete the section. Delete its _Memory_ section if
   there is no `memory:` block. Remove the `<!-- ... -->` editor notes.
4. **Bind it.** For each agent from step 2, add `mcp_tools` to `skills.allow`
   if the agent has an allow list, and to `preload` if MCP is its main job.
5. **Add a workflow skill** under `agents/skills/<job>/SKILL.md` for each
   recurring job from step 1: prerequisite first, then server, tool, argument
   shape, what to ask before writing, and what to do when the route is refused
   (`references/install.md` §4). Bind each one like `mcp_tools`.
6. **Add a prompt line** to each agent from step 2 saying when to reach for the
   services and to load `mcp_tools` first, unless it is preloaded.
7. Run `zen check`. If it reports `unknown tool "mcp:*"`, this is not a Zenera
   environment. Say so instead of removing the grant.
8. Tell me to try it in the Test tab: the first request per service shows a
   connect card. A terminal `zen run` cannot call MCP.

Report the agents changed, the skills added, and what `zen check` said.
