---
requires: [tools:mcp, memory]
---

# External services and memory

These rules are for agents that have both the `mcp_*` tools and a memory store.

Before discovering a tool, look for a route you have already found:
`memory_grep` the service name or the verb (`linear`, `create_issue`), or
`memory_search` the user's request.

After a request needed discovery, and your memory access lets you write,
commit the route so the next run can skip it:

- an `operation` node: the request in the user's words first, then
  `mcp_call <server> <tool>` and the arguments that mattered, linked from the
  `task` (`PRODUCED`);
- a `plan` node when several calls had to happen in order;
- a `fact` node for a convention the schema did not state (pagination, how
  "mine" is expressed), or for a capability that turned out not to exist.

Never commit tool results, the user's data, whole tool listings or schemas,
connect links, or ids that belong to one user.

A recalled route is a hint, not the truth: still `mcp_describe` before the first
call. When it is refused or its arguments fail validation, commit the corrected
route with `SUPERSEDES` pointing at the old one.
