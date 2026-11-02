# Who a run acts for

A run can know which user it is working for: the person the host signed in. That
is not the project's author, and not the owner of the API keys. The host says who
the user is. The agent and the code it runs can read that, but they cannot change it.

- **The model** calls `current_user`.
- **Code in the sandbox** reads the `ZEN_USER_*` variables, or uses the `zenera`
  library for Python and Node.

## Where it comes from

| Host                         | How                                                        | `source` |
| ---------------------------- | ---------------------------------------------------------- | -------- |
| The Zenera app (ZeneraLite)  | the signed-in user, from the token the app signs           | `host`   |
| A server using the engine    | `openEngine({ user: { id, email, name, role } })`          | `host`   |
| `zen run --as ann@acme.com`  | whoever you say, for trying a project                      | `local`  |
| A `zen run` inside a sandbox | inherited from the parent run's `ZEN_USER_*`               | `local`  |
| Plain `zen run`              | nobody: `current_user` says so and the variables are unset | -        |

Only `host` is vouched for. `local` means someone on this machine stated it: use
it to test a project, never as proof of who someone is.

A server that knows a run has no user passes `user: null`. The engine then ignores
any `ZEN_USER_*` in its own environment.

## The model: `current_user`

Every agent has the `current_user` tool, whether or not the project lists it. It takes no
arguments and returns:

```json
{
    "authenticated": true,
    "id": "3f0c…",
    "email": "ann@acme.com",
    "role": "editor",
    "source": "host"
}
```

or `{ "authenticated": false, … }`. Its description is the same for every user, so
chats on a shared project keep sending identical tool schemas, which keeps
provider caching working.

To take it away from an agent, say `-current_user` (or `-identity:*`) in its `tools:`.

## Code in the sandbox

Each command the agent runs gets these variables. Unknown fields are left unset.

| Variable          |                                 |
| ----------------- | ------------------------------- |
| `ZEN_USER_ID`     | stable user id                  |
| `ZEN_USER_EMAIL`  |                                 |
| `ZEN_USER_NAME`   |                                 |
| `ZEN_USER_ROLE`   | the user's role in this project |
| `ZEN_USER_SOURCE` | `host` or `local`               |

```python
import zenera

me = zenera.identity()            # None when no one is signed in
me = zenera.require_identity()    # raises zenera.NoIdentityError instead
print(me.id, me.email, me.role)
```

```js
const { identity, requireIdentity } = require('zenera');
// ES modules: import { identity } from '/home/agent/.node_modules/zenera/index.mjs';
```

Both libraries use only the standard library and are rewritten into the
sandbox's `$HOME` each time the session opens. Python finds them because the
engine puts them first on `PYTHONPATH` (any `PYTHONPATH` the image sets stays
after them). Node's `require` looks in `$HOME/.node_modules` by itself. ES
modules don't, so import them by path.

## Why per command, not per container

A container outlives a run: `persist: true` keeps it between sessions, and
agents share it. A user written into the container's environment would still be
there for the next run, whoever that run belongs to. So the identity is passed
on every `podman exec` instead, including the one that starts a background job.
It is also not part of the container's name, so a different user does not mean a
new container.

The values are plain variables on podman's command line, not secrets. Don't put
tokens there.

## What a project cannot do

`ZEN_USER_*` belongs to the host:

- A project `.env` that sets one is ignored, with a warning.
- `sandbox.env` that forwards one fails to load.
- The engine never forwards one from its own environment into the container.

The only way in is the host's `user`.

## Recorded

The identity is written into each run's `meta.json`, and into the `zen run --json`
envelope as `user`.
