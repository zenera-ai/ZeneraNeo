---
name: add-mcp
description: Give this project's agents external services (GitHub, Linear, Notion, ...) through the MCP tools.
argument-hint: '[which services, and what the agents should do with them]'
disable-model-invocation: true
---

Add MCP to this project: grant the `mcp:*` tools, say which services are used
here, and add a skill for each recurring job. How to use the tools needs no
work: zen's house rules `agents/mcp-instructions.md` (and, with memory,
`agents/mcp-memory-instructions.md`) reach every agent granted the group.

Load the `zen-mcp` skill first. It holds the rules this command follows. Also
load `zen-instructions` before writing the policy file in step 3. If any agent
will hand MCP data to code it runs, also load `zen-code-python`.

1. **Ask** which servers are enabled for this project in Project settings → MCP
   servers, whether any is limited to some tools, and what jobs the agents
   should do, if I have not already said. The project files cannot answer this.
2. **Pick the agents** that act on external services. Add `mcp:*` to their
   `tools:` in `agents.yaml` with a short comment saying which services they use,
   and `-mcp_call` for any that must only look
   (`zen-mcp` → `references/install.md` §2).
3. **Name the servers.** If I confirmed any, write
   `agents/mcp-policy-instructions.md` with `requires: [tools:mcp]` and one line
   per server on what it is for here (`references/install.md` §3). Skip it if
   none were confirmed. Never edit `agents/mcp-instructions.md` or
   `agents/mcp-memory-instructions.md`.
4. **Add a workflow skill** under `agents/skills/<job>/SKILL.md` for each
   recurring job from step 1: prerequisite first, then server, tool, argument
   shape, what to ask before writing, and what to do when the route is refused
   (`references/install.md` §4). Bind each one in `skills.allow` of the agents
   from step 2 if they have an allow list.
5. **Add a prompt line** to each agent from step 2 saying when to reach for the
   services.
6. Run `zen check`. If it reports `mcp.uninstructed` or
   `mcp-memory.uninstructed`, run `zen check --fix`, which writes the house
   rules back. If it reports `unknown tool "mcp:*"`, this is not a Zenera
   environment. Say so instead of removing the grant.
7. Tell me to try it in the Test tab: the first request per service shows a
   connect card. A terminal `zen run` cannot call MCP.

Report the agents changed, the files and skills added, and what `zen check` said.
