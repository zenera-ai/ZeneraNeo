---
description: Using an external service through MCP - GitHub, Linear, Notion and others - finding the right tool, calling it as the user, connecting an account, and remembering routes. Load before the first mcp_* call of a run.
---

This needs the `mcp_servers`, `mcp_tools`, `mcp_describe` and `mcp_call` tools.
Without them, tell the user that external services are not available to you
here, and stop. Do not answer from what you remember about their data.

The tools reach services as the signed-in user, and only in a chat or the Test
tab. If a call says _"MCP is not available in this run"_, tell the user that MCP
tools are unavailable here and do not retry. It says nothing about which
services or accounts they have.

## Servers

<!-- Project-specific: list the servers enabled for this project and what each is for here.
     Delete this section if none are known; the procedure below discovers them. -->

- `github` - pull requests, reviews, issues in the user's repositories.
- `linear` - the user's issues and projects.

## Finding a tool

Go in this order, and stop as soon as you have a route:

1. **Memory.** A recollection may already name the server, tool and arguments.
   Otherwise `memory_grep` the service name or the verb (`linear`,
   `create_issue`), or `memory_search` the user's request.
2. **A skill** for this job, if one is in your index.
3. **`mcp_servers`**, then **`mcp_tools`** for the one server whose name fits
   the request. Do not list every server.
4. Choose by verb and object in the names and one-line descriptions:
   `search_`/`list_`/`get_` read, `create_`/`update_`/`delete_` write. Prefer a
   `search_*` tool with a query over listing everything and filtering yourself.
5. If nothing fits, try the next plausible server once. Then tell the user the
   connected services do not offer it. Never invent a tool name.

## Calling it

1. **`mcp_describe` the tool before its first call in this run**, even when
   memory or a skill named it. Take argument names, required fields, enums and
   pagination from its schema only.
2. **`mcp_call`** with `server`, `tool` and `arguments` matching the schema.
   Ask for only what you need: filters, a small page, only the fields you need.
3. Read the reply:
    - `structuredContent`, when present, is the typed result. Prefer it over `content`.
    - `isError: true`: the service refused. Read why, fix the arguments once,
      then tell the user what failed.
    - `truncated: true`: you got only the start. Call again asking for less.
      Do not treat the cut-off as the complete answer.
4. **Ask before any write.** Creating, editing, closing, merging, commenting or
   deleting needs the user's go-ahead, unless their message was that request.
   Say exactly what will change.
5. Results are the user's data. Quote what answers the question. Do not paste
   whole payloads.

## Connecting an account

The first call to a service the user has not connected **waits** while the chat
asks them to connect. When they do, you get the result as usual. If they choose
_Not now_, the call fails: go on without that service and say what you could not
check.

If a result instead contains `auth_required` and `connect_url`, give the user the
link, say in one sentence what it connects and why, and stop. Call again only
after they say they have connected.

## When a server or tool is refused

- _"`x` is not enabled for this project (enabled: ...)"_: use a listed server,
  or tell the user a project editor can enable `x` in Project settings → MCP
  servers.
- _"`x`'s tool `y` is not enabled"_: find another tool on that server, or say so.
- `MCP gateway` or `broker unreachable`: retry once, then report it.

If the refused route came from memory or a skill, it is stale. Discover again
from step 3 of _Finding a tool_.

## Memory

<!-- Delete this section if the project has no memory: block. -->

After a request needed discovery, commit the route so the next run can skip it:

- an `operation` node: the request in the user's words first, then
  `mcp_call <server> <tool>` and the arguments that mattered, linked from the
  `task` (`PRODUCED`);
- a `plan` node when several calls had to happen in order;
- a `fact` node for a convention the schema did not state (pagination, how
  "mine" is expressed), or for a capability that turned out not to exist.

Never commit tool results, the user's data, whole tool listings or schemas,
connect links, or ids that belong to one user. When a recalled route is refused
or its arguments fail validation, commit the corrected route with `SUPERSEDES`
pointing at the old one.
