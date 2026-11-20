---
name: mcp
description: Using the external services connected to this project (GitHub, Linear, Notion, Jira, Slack and others) through the mcp_* tools - finding the right tool, calling it, paging, and acting safely as the signed-in user. Load before the first call to an external service in a run.
tags: [mcp, integrations]
version: 1.0.0
---

# External services (MCP)

The `mcp_*` tools reach services connected to this project, acting as the
signed-in user. What you see there is that user's data, and what you change
there is changed for real.

## The loop

1. **Pick the server.** `mcp_servers` lists what this project has enabled.
   Choose the one whose name fits the request; do not list every server's
   tools.
2. **Pick the tool.** `mcp_tools` for that server. Choose by verb and object:
   `search_*`, `list_*` and `get_*` read; `create_*`, `update_*` and
   `delete_*` write. Prefer a search with a query over listing everything and
   filtering yourself.
3. **Read its schema.** `mcp_describe` before the first call to a tool in a
   run. Take argument names, required fields, enums and paging from the
   schema, never from memory.
4. **Call it.** `mcp_call` with `server`, `tool` and `arguments`. Ask for only
   what you need: filters, a small page, the fields that answer the question.
5. **Read the result.** Prefer `structuredContent`. `isError: true`: fix the
   arguments once, then report the failure. `truncated: true`: ask for less;
   never present a cut-off result as complete.

## Common requests

- "My open issues / tasks": a search or list tool filtered to the current
  user and an open state. Say which filter you used.
- "Find the page / doc about X": the service's search with the user's words,
  then `get_*` on the best hit before you quote it.
- "Summarise this PR / ticket / thread": fetch it and its comments, then
  summarise; link to it.
- Several services in one answer: query each, then combine, saying which
  facts came from where.

## Writing safely

- Before creating, editing, commenting, closing, merging or deleting, tell the
  user exactly what will change and wait for a yes - unless their message was
  that exact request.
- After a write, report what was done with a link or id the user can open.
- Never repeat a write because the result was unclear; read the state again
  first.

## Accounts and refusals

- If a service is not connected yet, the chat asks the user to connect it; if
  a result instead has `auth_required` and `connect_url`, give the link, say
  in one sentence what it connects, and stop until they say they have.
- "Not enabled for this project": use another listed server, or tell the user
  a project editor can enable it under MCP servers.
- "MCP is not available in this run": say so and do not retry.
- If nothing connected can answer, say so. Never invent a tool name or answer
  from what you remember about the user's data.
