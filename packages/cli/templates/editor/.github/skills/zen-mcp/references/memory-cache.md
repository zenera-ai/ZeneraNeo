# Caching MCP tools in memory

Discovery costs round trips and context: `mcp_servers`, then a tool listing that
may be thousands of tokens, then `mcp_describe`. The tool list is kept for one
run only. Memory is what lets the next run skip discovery. The
principle is the same as memory in front of a `zen rag` index (`zen-memory`
skill): **keep the route, not the source.**

Applies only to a project with a `memory:` block and agents with `read-write`
access. Without memory, a workflow skill naming the route does the same job, as
authored text.

## What to commit

| Commit                                                                                                 | Kind        | Because                                            |
| ------------------------------------------------------------------------------------------------------ | ----------- | -------------------------------------------------- |
| The question, then the route that answered it: server, tool, argument shape                            | `operation` | Recall removes the listing and the search entirely |
| A sequence of calls that was necessary (find the team, then list its issues)                           | `plan`      | No listing shows an order                          |
| A convention the schema does not state: pagination style, an id format, which argument filters by "me" | `fact`      | Re-deriving it costs a failed call each run        |
| That a capability does **not** exist on the enabled servers                                            | `fact`      | Proving a negative twice is waste                  |

Node text: **put the human phrasing first and the identifiers second**, and name
the server, because the next request arrives as a sentence, not a tool name:

```
How to list my open Linear issues: mcp_call linear list_issues
{ assignee: "me", state: "open", limit: 50 }. Paginate with `cursor` from the
reply. Checked against mcp_describe on 2026-11.
```

Link the `operation` to the `task` that asked (`PRODUCED`), and to any `fact`
it depended on (`INFORMED`).

## What never to commit

- **Tool results.** Issues, pull requests, messages and pages are the user's
  data. Memory lives with the project and every user of the
  project can recall it. Whatever an audience mask allows, the data goes stale
  upstream the moment it is written.
- **Whole tool listings or schemas.** The project editor or the administrator
  can change them at any time, and `mcp_describe` returns the current one in a
  single call. Commit the route and the one or two arguments that mattered, not
  `inputSchema`.
- **Connect URLs or anything from `auth_required`.** They are
  per flow, per user, and expire.
- **User-specific ids** (a team, repo, workspace) in a node with audience `*`.
  Commit how to find them (`list_teams` filtered by name), not the value.

## Trust: a recalled route is a shortcut, not authority

A recalled route skips `mcp_servers` and `mcp_tools`, never `mcp_describe`
before the first call of that tool in a run. Then:

1. If the server or tool is refused as not enabled, or the call fails on
   argument validation, the route is stale.
2. Re-discover (discovery.md §3).
3. Commit the new route as an `operation` with `SUPERSEDES` pointing at the old
   node. Do not edit or forget the old one.
4. If the capability is gone entirely, commit that as a `fact` that supersedes
   the route.

`zen memory ls --kind operation` is the review list for routes.

## Where this policy is written

- In the runtime skill `mcp_tools` ([runtime-skill.md](./runtime-skill.md),
  section _Memory_). It is read at the moment the agent uses the tools, so it is
  the right place. Delete that section when the project has no `memory:`.
- Project-specific additions (for example, a team or audience that holds MCP
  routes) go in `agents/memory-policy-instructions.md`, never in
  `agents/memory-instructions.md` (zen's own copy, see `zen-memory`).
