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
