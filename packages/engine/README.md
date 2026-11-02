# @zenera/engine

**Runs a [`@zenera/neo`](../neo/README.md) project the way `zen run` does - for any host, not only the terminal.**

> Part of [ZeneraNeo](https://github.com/zenera-ai/ZeneraNeo). `zen` is built on it; a server
> embedding agent projects uses the same code.

`@zenera/neo` is the runtime. This package is the wiring around it that makes a project folder
runnable on a machine: the keyring and the project's `.env`, the sandbox (image, mounts, forwarded
credentials), a session directory that persists the conversation, and the record every turn leaves
behind (`state.json`, `report.html`, run metadata).

It never prints and never prompts. Warnings go to the `Logger` you pass, errors are `EngineError`s
with a code, and installing a container engine is a `preflight` the host supplies.

Pass `user` to say who the run is acting for. The agent gets it from the `current_user` tool, and code in
the sandbox gets it from `ZEN_USER_*` or the `zenera` library. See
[docs/identity.md](../../docs/identity.md).

Pass `plugins` to bring tools of your own. Each `ZenPlugin` is asked for its tools once, when the
engine opens, with the run's `user`, project and session, so a tool can hold what this run needs.
Config selects plugin tools like built-in ones (`tools: [mcp:*]`). A name or group that clashes with
a built-in tool, or with another plugin, is refused. The engine calls `close` when it closes, or when
it fails to open after the plugin was asked:

```ts
import { openEngine, tool, type ZenPlugin } from '@zenera/engine';

const lookup: ZenPlugin = {
    name: 'lookup',
    tools: ({ user }) => [
        tool<{ q: string }>({
            name: 'lookup_search',
            group: 'lookup',
            description: 'Searches the directory as the signed-in user.',
            parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
            execute: ({ q }) => search(q, user?.id),
        }),
    ],
};
const engine = await openEngine({ project, session, user, plugins: [lookup] });
```

## Use

```ts
import { createSessionAt, openEngine, runEngine } from '@zenera/engine';

const session = createSessionAt(
    '/data/users/u1/sessions/t1',
    '/data/users/u1/sessions/t1/workspace',
);
const engine = await openEngine({
    project: { dir: '/project', name: 'acme' },
    session,
    memoryDir: '/data/users/u1/memory',
    user: { id: 'u1', email: 'ann@acme.com', role: 'editor', source: 'host' },
    logger: { warn: (m) => console.warn(m) },
});
try {
    const outcome = await runEngine(engine, 'What changed?', (event) => {
        if (event.type === 'text_delta') process.stdout.write(event.delta);
    });
    console.log(outcome.text);
} finally {
    await engine.close();
}
```

## License

[MIT](LICENSE).
