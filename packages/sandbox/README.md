# @zenera/sandbox

Where an agent's commands run, and the files those commands see. One
`Sandbox` per session, shared by every agent in it. Depends on Node alone, so a
host, a sandbox service and the agent inside a container can all build on the
same contract.

```ts
import { podmanSandbox } from '@zenera/sandbox';

const sandbox = podmanSandbox({ root: '/path/to/workspace', key: 'session-1' });
await sandbox.exec('python -V');
const view = sandbox.files({ root: '/path/to/workspace', mount: '/workspace' });
await view.fs!.writeFile(`${view.root}/notes.md`, 'hello');
await sandbox.close();
```

## The contract

- **`Sandbox`** - `prepare` (pull the image, or build it from `build:`),
  `exec`, background jobs (`startJob`, `readJob`, `stopJob`),
  `close` at the end of a turn, and the files: `fs` (an `FsDriver`) and
  `files(view)`, which maps the host's workspace and mounts to the paths `fs`
  finds them at. The invariant: **a file written through `fs` is the file
  `exec` sees under the same name, and the reverse.**
- **`SandboxFactory`** - `(opts: SandboxOptions) => Sandbox`, how a host picks
  where sandboxes run.
- **`FsDriver`** - the filesystem seam, usable without a sandbox. `localFs` is
  this machine's disk; `InMemoryFs` keeps a tree in memory.

## The image

A spec names an `image` to pull, or a `build` (`{ dockerfile, context, args }`)
to build. Getting it there is the sandbox's job, in `prepare()`: podman builds
on this machine, a sandbox service on its own builders. What every backend
shares is the build's identity, `buildIdentity(build)` - the context's files
and the hash of them - so a project names the same image everywhere.
`prepare({ onProgress, slow, force, allowBuild: false })` reports progress,
rebuilds, or refuses to build at all; `start` does whatever of it is still
needed. A failed build is an `ImageBuildError` (`isImageBuildError` checks it
by name, across copies of this package).

## Implementations

- **`PodmanSandbox`** / `podmanSandbox` - a podman container on this machine,
  binding host directories, with `fs = localFs`. `ensurePodmanImage` is its
  image step on its own.
- A sandbox that keeps its files with the container (a sandbox service) serves
  `fs` itself and returns `inSandboxPaths(view, fs)` from `files()`.

## Testing an implementation

`@zenera/sandbox/testing` exports the contract as vitest suites, the same ones
this package runs against its own implementations:

```ts
import { describeFsDriver, describeSandbox } from '@zenera/sandbox/testing';

describeFsDriver('remote fs', () => ({ fs: new RemoteFs(url), root: '/workspace' }));
describeSandbox('remote', () => ({ sandbox: openRemote(opts), root: opts.root }));
```
