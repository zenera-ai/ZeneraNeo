# Recoverable multi-package releases

## Problem

ZeneraNeo publishes several lockstep-versioned npm workspaces from a Git tag, then builds two multi-platform container images. A release is not an atomic transaction: npm versions are immutable, registry visibility can lag after publication, a job can stop after some packages have been published, and image publication is a downstream operation. Operators need to distinguish a complete release from a partially completed one and resume only the missing work without publishing conflicting versions.

## Current behaviour observed in the repository

The current implementation already has several useful safeguards:

- `scripts/release.mjs` discovers public workspaces and orders them by internal dependency.
- `.github/workflows/release.yml` serializes release workflow runs with the `release` concurrency group and `cancel-in-progress: false`.
- npm workspaces are published sequentially, and the workflow skips a package when `npm view <name>@<version> version` succeeds.
- the image matrix runs after the npm publishing job and skips an image tag that already exists.
- `RELEASE.md` documents retrying a partially published release with the same tag, and dispatching from `main` so a workflow fix can run against the tagged source tree.

These safeguards are valuable, but the overall result is represented mainly by GitHub Actions job status and registry lookups. There is no single durable release record that reconciles intended artifacts, confirmed registry artifacts, and image artifacts. The `npm view` predicate also treats any unsuccessful query as absence unless the shell command is refined: authentication failures, rate limits, network errors, and actual 404s must not all lead to a publish attempt.

## Proposed improvement

Introduce a per-release manifest and a reconciliation-oriented recovery procedure. The manifest is an audit record, not the source of truth for artifact existence. npm and GHCR remain authoritative for whether an exact version or image digest exists. On every run, the release controller should:

1. Validate the exact tag, peeled commit SHA, and package versions before acquiring publishing credentials.
2. Acquire one repository-wide release lock and re-check the tag/commit identity while holding it.
3. Build and validate every package before the first external publication.
4. Create or load a manifest keyed by immutable release identity (`repository`, tag, source commit SHA).
5. Reconcile every expected npm package against the registry. Publish only on a confirmed not-found response; fail closed on auth, rate-limit, server, network, or ambiguous outcomes.
6. After each publish, poll the exact `name@version` until visible, then verify metadata and record the result.
7. Build and push images only after their declared npm dependencies are verified. Verify the pushed manifest list and record its digest.
8. Mark the release `COMPLETE` only when all required npm packages, GitHub Release metadata, and required images are verified.

A re-run starts by reconciling external state. It does not trust only the last recorded status, because the process may have crashed between a successful publish and writing the manifest.

## Proposed manifest

See `release-state-machine.md` for the schema and state transitions. Store one append-only run record per attempt, or retain a monotonic `attempts` history in the manifest. Avoid overwriting evidence of earlier attempts.

## Failure and recovery rules

See `failure-matrix.md` and `recovery-runbook.md`.

## Scope

This contribution is a design and operational review. It does not change the release workflow, publish packages, retag releases, alter npm metadata, or modify GHCR images. A follow-up implementation should be introduced in small pieces with tests around registry response classification and manifest transitions.

## Evidence reviewed

- `RELEASE.md`: current release policy, package bootstrap/trusted-publisher procedure, and documented recovery for partial publication.
- `.github/workflows/release.yml`: tag/dispatch triggers, workflow concurrency, sequential npm publish loop, GitHub Release creation, and image matrix.
- `scripts/release.mjs`: lockstep version validation and dependency ordering.
- GitHub Actions run [`43405142340`](https://github.com/zenera-ai/ZeneraNeo/actions/runs/43405142340), tag `v1.3.2`, created 2026-11-13. The `publish` job succeeded, while both image jobs failed. Logs for the sandbox image show `ETARGET` for `@zenera/server@^1.3.2`; the agent-runtime image log shows the same unavailable version. This is a real downstream distribution failure, not evidence that npm package publication failed.

## What success looks like

A release is safely re-runnable when all of the following hold:

- A retry does not republish any already-published immutable package version.
- A registry timeout never causes a blind second publish.
- Conflicting version metadata or tag identity stops the release before additional side effects.
- Two release attempts cannot publish concurrently under the supported release entry point.
- Successful npm publication is not repeated just because an image build failed.
- The manifest and logs explain what happened, what was verified, and what action is required next.
