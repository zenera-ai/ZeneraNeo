# How a run finds and calls MCP tools

This file describes what a running agent sees, so you can write skills and
prompts that match it. The agent-facing version of the procedure is
[runtime-skill.md](./runtime-skill.md).

Every call is checked against the project's server selection and made as the
signed-in user. Nothing about this is configurable from the project.

## 1. `mcp_servers` - what this run can use

No arguments.

```json
{
    "servers": [
        { "server": "github", "tools": 41 },
        { "server": "linear", "tools": 23 }
    ]
}
```

The servers enabled for the project, and for each the number of tools the
project allows. This is the authority: a server not listed is refused by every
other call. It is cheap. Call it once per run, before naming a server that
memory or a skill did not supply.

## 2. `mcp_tools` - one server's tools

`{ "server": "linear" }`

```json
{ "tools": [{ "name": "list_issues", "description": "List issues in the user's workspace..." }] }
```

The name and the **first line** of each description (up to 200 characters). Only
tools the project allows are listed. The list is kept for the rest of the
run, so a second call in the same run is cheap. Across runs nothing is kept
unless memory keeps it.

## 3. Searching for a tool

There is no search endpoint. Searching is the agent reading `mcp_tools` output,
so the cost is the size of the listings it pulls into context. The procedure
that keeps that small:

1. **Memory first**, if the project has it. Auto-recall often surfaces a stored
   route before any call. Otherwise use `memory_grep` with the service or verb
   (`linear`, `create_issue`) for an exact hit, or `memory_search` with the
   user's question.
2. **A workflow skill** that names the tool. If one matches, use its route.
3. **`mcp_servers`**, then `mcp_tools` **only for the servers whose name fits
   the request**: GitHub for pull requests, Linear for issues. Do not list
   every server.
4. **Match on verb and object** in the names and one-line descriptions:
   `list_`/`search_`/`get_` to read, `create_`/`update_`/`delete_` to write,
   followed by the object (`issue`, `pull_request`, `page`). Prefer a `search_*`
   tool with a query argument over `list_*` and filtering in the model.
5. **Describe only the chosen tool**, never every candidate.
6. If nothing fits after one server's list, try the next plausible server.
   After that, tell the user the enabled servers do not offer it. Do not invent
   a tool name.

## 4. `mcp_describe` - read before calling

`{ "server": "linear", "tool": "list_issues" }`

```json
{
    "name": "list_issues",
    "description": "...full text...",
    "inputSchema": { "type": "object", "properties": {}, "required": [] }
}
```

Required before the first call of a tool in a run. The schema is the only source
for argument names, enums, pagination fields and which fields are required. A
skill or memory naming an argument shape is a hint, and the schema decides.

## 5. `mcp_call` - the call

`{ "server": "linear", "tool": "list_issues", "arguments": { "limit": 25 } }`

| Reply                                                    | Meaning and what the agent does                                                                                            |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `{ isError: false, content: [...], structuredContent? }` | Success. Prefer `structuredContent` when present: it is the typed result                                                   |
| `{ isError: true, content: [...] }`                      | The upstream tool failed: bad argument, not found, permission. Read the text, fix arguments once, then report              |
| `{ ..., truncated: true, note }`                         | The result exceeded 60,000 characters and was cut. Call again asking for less: a filter, fewer fields, a smaller page size |
| Run pauses, then the result                              | The user had not connected the service. They connected from the card, and the call ran                                     |
| Error after a pause                                      | The user chose _Not now_. Continue without that service and say what is missing                                            |
| `{ auth_required: true, server, connect_url, message }`  | Older host. Give the user `connect_url` as a link, say what it is for, stop. Retry when they say they have connected       |

**Calls take up to 120 seconds** before they time out. A slow upstream
looks like a long tool call, not a hang.

## 6. Errors

These are thrown, and reach the model as an error result:

| Message                                                    | Means                                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------------------- |
| `MCP is not available in this run: ...`                    | Not a chat or Test-tab run. Say MCP is unavailable here; do not retry     |
| `<server> is not enabled for this project (enabled: a, b)` | Use a listed server, or tell the user an editor must enable it            |
| `<server>'s tool <tool> is not enabled for this project`   | The server is on, but this tool is excluded. Find another route or say so |
| `MCP gateway: ...`                                         | The service failed. Retry once, then report                               |
| `MCP broker unreachable: ...`                              | MCP is briefly unavailable. Retry once, then report                       |

A refusal of a server or tool that **memory or a skill named** means the route is
stale. Re-discover from step 1, and if memory is on, supersede the old route
(see [memory-cache.md](./memory-cache.md)).

## 7. Writes

Every allowed tool can be called, whether it reads or writes.
Whether an agent may change something upstream is decided by the project:

- in the prompt or skill (_"ask before creating, editing or deleting anything"_),
- or by taking `mcp_call` away from agents that must only look (`-mcp_call`),
- or by the project editor excluding the write tools in Project settings.
