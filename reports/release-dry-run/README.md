# Release dry-run safety

## Problem

Before this fix, a maintainer could lose uncommitted package edits when running `node scripts/release.mjs patch --dry-run`. The script wrote version updates, then restored manifests from the Git index, replacing any newer working-tree edits.

Baseline: `09e1c0ed41a2d2810a452f649cbc2b8e13869dc4`.

In a temporary repository, a package description was changed and staged, then edited again. The baseline command exited with status 0 and produced:

| State                    | Before dry run         | After dry run      |
| ------------------------ | ---------------------- | ------------------ |
| Working-file description | Further unstaged edits | Staged description |
| Staged description       | Staged description     | Staged description |

The newer edit was lost. Even a clean checkout had its manifests rewritten, changing their modification times.

## Change

Prepare package updates in memory. A dry run prints the proposed versions and returns before any writes. A real release writes those prepared manifests and continues through the existing lockfile, commit, and tag steps.

Arguments and validation remain the same. The dry-run completion message now says `no files changed` instead of saying files were restored.

## Reproduce and verify

Checked on macOS 26.4 arm64 with Node 24.22.3, npm 11.19.1, Git 2.49.0, and Vitest 4.1.11. Node 24.1.0 was too old for an existing dependency's engine requirement; no dependency versions were changed to work around it.

```sh
npm install
# The repository's test script requires this file. Preserve it if it already exists.
test -e .env || touch .env
node node_modules/vitest/vitest.mjs run packages/cli/test/workspace-release.test.ts
npm run format:check
npm run typecheck
npm test -- --exclude '**/live-*'
```

The new test file was run before changing the release script: **8 failed, 7 passed**. After the fix: **15 passed**. The failures covered lost edits and modification times; validation and normal-release tests already passed on the baseline.

Repository checks on 2026-11-13:

| Command                             | Result                                          |
| ----------------------------------- | ----------------------------------------------- |
| `npm run format:check`              | Passed                                          |
| `npm run typecheck`                 | Passed, including the workspace build           |
| `npm test -- --exclude '**/live-*'` | 115 files passed; 2,346 tests passed, 2 skipped |

The tests run the release script in temporary Git repositories. They compare file contents and modification times, staged and unstaged diffs, status, HEAD, and tags. A local npm stub records the lockfile-update command and supplies a changed lockfile; dry runs must never invoke it.

The suite covers clean previews of patch, minor, major, and explicit prerelease versions; unstaged, staged, and partially staged edits; private packages and untracked files; invalid or unchanged versions, mismatched package versions, and existing tags; tagged and untagged releases; and refusal to perform a real release on a dirty checkout.

## Limits

These tests verify local release preparation. They do not exercise real npm dependency resolution, registry publication, remote pushes, or hosted GitHub Actions. Publishing retries and recovery after a partially failed real release are separate changes.
