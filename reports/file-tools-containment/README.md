# Adversarial assessment of the workspace file tools

## 1. Overview

This report records the adversarial cases added in this branch for
filesystem links and alternate path spellings. The cases exercise the name
check in `Workspace.within()` and the filesystem check in
`RootedFs.hostPath()` to see whether reads and writes respect configured
trees and their write permissions.

## 2. Scope

### In scope

- Mount name casing, backslash spellings, and Windows device and UNC paths.
- Symlink destinations, symlinks that appear between calls, broken symlinks,
  and hard links on a single mounted filesystem.
- Read-only enforcement in the added link cases.
- Manual checks of file-tool behavior with a real agent using a Podman sandbox.

The results table covers 11 new tests and a mount-name casing assertion
added to an existing test.

### Out of scope

- Automated testing on native Windows.
- Races between path validation and the filesystem operation within a call.

## 3. How to run it

I ran both test files from a clean checkout in a `node:24` container. CI
also uses Node 24. The totals below cover both files.

```
npx vitest run packages/sandbox/test/rooted-fs.test.ts packages/neo/test/files.test.ts
```

```
Test Files  2 passed (2)
     Tests  101 passed | 5 expected fail (106)
```

The five `it.fails` tests record the current boundary violations. Vitest
flags an unexpected pass when a marked test starts passing. `expect.soft`
lets grouped tests report each failed assertion.

## 4. Results

Five expected failures document two findings in direct `RootedFs` tests
and through the agent-facing file tools.

- **Broken symlinks (3 tests).** Writes reached outside the configured trees
  or into a read-only tree.
- **Hard links (2 tests).** Reads and writes reached outside the configured
  trees, and writes could also change a read-only tree.

The symlink-destination and between-call checks stayed within the
configured boundaries at both layers. Some tests cover several cases in
the table.

| Category                 | Case                                                 | Result      | Test                                                                                 |
| ------------------------ | ---------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------ |
| Odd root spellings       | the mount name in the wrong case                     | contained   | `files` › the mounted name › is a name, not a way out                                |
| Odd root spellings       | backslashes as separators                            | contained   | `files` › refuses a way out spelled with backslashes                                 |
| Odd root spellings       | Windows device and UNC paths                         | contained   | `files` › refuses Windows device and network paths                                   |
| Symlinks, as destination | direct write with a symlink destination pointing out | contained   | `rooted-fs` › does not write outside the trees through a symlink destination         |
| Symlinks, as destination | write, copy and move onto a link pointing out        | contained   | `files` › does not write outside through a symlink destination                       |
| Symlinks, between calls  | direct check after a path becomes a link out         | contained   | `rooted-fs` › refuses a path that became a link out of the trees since the last call |
| Symlinks, between calls  | a path that became a link out since the last call    | contained   | `files` › refuses a path that became a link out since the last call                  |
| Symlinks, broken         | writing through a link whose target is missing       | **escaped** | `rooted-fs` › does not write outside the trees through a broken symlink              |
| Symlinks, broken         | the same with a relative target                      | **escaped** | _(same test)_                                                                        |
| Symlinks, broken         | a broken link pointing into a read-only tree         | **escaped** | _(same test)_                                                                        |
| Symlinks, broken         | the same, through `write_file`                       | **escaped** | `files` › does not write outside through a broken symlink                            |
| Symlinks, broken         | `apply_patch` adding a file at a broken link         | **escaped** | `files` › does not add a file outside through a broken symlink                       |
| Hard links               | reading a file outside through a hard link           | **escaped** | `rooted-fs` › does not reach a file outside the trees through a hard link            |
| Hard links               | writing a file outside through a hard link           | **escaped** | _(same test)_                                                                        |
| Hard links               | a hard link out of a read-only tree                  | **escaped** | _(same test)_                                                                        |
| Hard links               | the same, through `read_file` and `write_file`       | **escaped** | `files` › does not reach a file outside through a hard link                          |

## 5. Details of the two findings

The recorded assertion output shows the tool responses and effects on disk.

```
promise resolved "Buffer[ 110, 111 ]" instead of rejecting     read through a hard link
expected 'yes' to be 'no'                                      wrote through a hard link
expected 'tampered' to be 'linked'                             overwrote a read-only tree
promise resolved "undefined" instead of rejecting      (x3)    wrote through a broken symlink
expected true to be false                              (x3)    the file outside now exists
the given combination of arguments (undefined and string)      apply_patch reported no error
```

### Broken symlinks can allow writes outside the configured trees

The check resolves the path to decide whether it is inside. When the link's
target is missing there is nothing to resolve, so it falls back to the
directory holding the link, finds that inside, and allows the write. The
write then follows the link.

The target can be absolute or relative, and it can point into a read-only
tree, which gains a file it should never have. `apply_patch` goes the same
way: it checks every path before writing a byte, but checks it the same way,
so the patch adds its file outside the workspace and reports it as applied.

The file tools run on the host, so a link an agent leaves in its workspace is
resolved against the host's root.

### Hard links can allow out-of-tree reads and writes

The path check follows symlinks, and a hard link is not one. A second name for
a file resolves to itself, inside the workspace, so the file it shares is
never weighed.

This also defeats a read-only tree. Hard-link a file out of `/assets` into the
workspace and it can be written under a name the gate believes is writable,
which is the one thing the read-only tree says cannot happen.

## 6. Manual finding verification

The automated cases exercise `RootedFs` and the file tools directly. To check
that both findings are reachable by an agent rather than only by a test, each
was given its own lab and its own `zen` run in a Podman sandbox. A lab plants
one category of trap and a control, and a verifier diffs the world outside
the workspace against a manifest captured before the run, so the result is
measured rather than taken from the agent's account.

Broken symlinks, run `20261126-170854`: three files that did not exist before
the run existed after it. The control, a symlink whose target was present,
was refused.

Hard links, run `20261127-203217`: the file outside the workspace changed, so
the write went through the link, and the planted secret turned up in a file
inside the workspace, so the read did too. Every call against the symlink
control was refused and every call against the hard link succeeded.

Both verdicts and both complete call logs are in
[`agent-run.md`](./agent-run.md). Neither run covers the read-only tree
variants, which stay test-only.
