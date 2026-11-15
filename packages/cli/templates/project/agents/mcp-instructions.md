---
requires: [tools:mcp]
---

# External services (MCP)

These rules are for agents that have the `mcp_servers`, `mcp_tools`,
`mcp_describe` and `mcp_call` tools. Without them, tell the user that external
services are not available to you here, and do not answer from what you
remember about their data.

The tools reach services such as GitHub or Linear as the signed-in user, and
only in a chat or the Test tab. If a call says _"MCP is not available in this
run"_, tell the user MCP tools are unavailable here and do not retry. It says
nothing about which services or accounts they have.

## Finding a tool

Stop as soon as you have a route:

1. A route you already know: a skill for this job, or one you recall.
2. `mcp_servers`, then `mcp_tools` for the one server whose name fits the
   request. Do not list every server.
3. Choose by verb and object: `search_`/`list_`/`get_` read,
   `create_`/`update_`/`delete_` write. Prefer a `search_*` tool with a query
   over listing everything and filtering yourself.
4. If nothing fits, try the next plausible server once, then tell the user the
   connected services do not offer it. Never invent a tool name.

## Calling it

1. `mcp_describe` the tool before its first call in this run, even when a skill
   or memory named it. Take argument names, required fields, enums and
   pagination from its schema only.
2. `mcp_call` with `server`, `tool` and `arguments` matching that schema. Ask for
   only what you need: filters, a small page, only the fields you need.
3. Read the reply. Prefer `structuredContent` over `content`. On `isError: true`,
   fix the arguments once, then tell the user what failed. On `truncated: true`
   you have only the start: call again asking for less, and never treat the
   cut-off as the whole answer.
4. Ask before any write - creating, editing, closing, merging, commenting or
   deleting - unless the user's message was that request. Say exactly what will
   change.
5. Results are the user's data. Quote what answers the question; do not paste
   whole payloads.

## Connecting an account

The first call to a service the user has not connected waits while the chat
asks them to connect. When they do, you get the result as usual. If they choose
_Not now_, the call fails: go on without that service and say what you could
not check.

If a result instead contains `auth_required` and `connect_url`, give the user
the link, say in one sentence what it connects, and stop. Call again only after
they say they have connected.

## When a server or tool is refused

- _"`x` is not enabled for this project"_: use a listed server, or tell the user
  a project editor can enable `x` in Project settings → MCP servers.
- _"`x`'s tool `y` is not enabled"_: use another tool on that server, or say so.
- The service or MCP is unavailable: retry once, then report it.

A refused route that came from a skill or memory is stale. Discover again from
`mcp_servers`.
