# Release recovery runbook

This is a proposed operator procedure. It supplements the current `RELEASE.md`; it does not replace the repository's existing commands or authorize publishing from a personal machine.

## 1. Identify the failed release

Record the workflow run URL, tag, run attempt, and exact failing job. Confirm the source identity:

```bash
git fetch --tags origin
git rev-parse "vX.Y.Z^{commit}"
git show -s --format='%H %T %s' "vX.Y.Z^{commit}"
```

Compare the peeled tag commit with the release manifest. If it differs, stop. Never move a tag that CI has consumed.

## 2. Classify the stage

- **Validation failed before publication:** fix the cause in the workflow or source. Re-run the same release only after confirming the tag still points to the intended commit.
- **npm publication is partial or ambiguous:** reconcile every expected package version against npm. Do not assume that a failed step means the registry did not accept the publish.
- **npm packages verified, image job failed:** retry the image stage only. Do not re-publish packages.
- **GitHub Release creation failed:** reconcile/create release metadata for the same tag; package publication is already complete.

## 3. Reconcile npm packages

For each package from `node scripts/release.mjs workspaces --paths`, in the returned dependency order:

```bash
npm view '@zenera/neo@X.Y.Z' version --json
```

Interpret results carefully:

- Exact version returned: fetch metadata and compare with the expected release artifact before marking it verified.
- Confirmed exact-version not-found response: eligible for publication, provided all validation passed and the release lock is held.
- 401/403/429/5xx/timeout/DNS/other transport error: **not** proof of absence. Stop and resolve registry access/health first.
- Version exists but metadata differs: stop and escalate. Do not overwrite an immutable npm version.

The current workflow's simple `npm view ... || npm publish` branch should be hardened in an implementation so only confirmed not-found permits publishing.

## 4. Retry policy

Use the repository's documented `workflow_dispatch` path with the original tag, and dispatch from `main` when the purpose is to run a corrected workflow against the immutable tagged source tree. Confirm the workflow checks out the requested tag for package contents while using the dispatch ref for the workflow definition. The existing `RELEASE.md` documents this distinction.

A future workflow implementation should expose separate recovery targets:

- `packages`: reconcile and publish only missing package artifacts.
- `images`: reconcile and build/push only missing image artifacts.
- `all`: reconcile packages first, then images.

Do not add a manual “force publish” switch. Force should never bypass identity, immutability, or registry reconciliation checks.

## 5. Image recovery

Before building an image, verify all npm versions declared as dependencies for that image. The current release workflow already waits for relevant npm packages, but a simple success check should be upgraded to verify expected metadata and distinguish not-yet-visible from registry errors.

After push, inspect the image manifest list and record its digest and platform set (`linux/amd64`, `linux/arm64`). If the image exists and matches, mark it verified and skip it on retry. If it exists but differs from the expected build, block for operator review; do not overwrite a release tag casually.

## 6. Bad published version

npm versions are immutable. If a package is defective:

1. Stop the remaining rollout if the defect affects the release's safety or compatibility.
2. Assess blast radius and dependent packages/images.
3. Have an authorized maintainer deprecate the bad version with a clear reason.
4. Cut a corrected patch release; do not move or reuse the consumed tag/version.
5. Update the release record with incident reference, deprecation status, corrected version, and decision owner.

Unpublishing is exceptional, constrained by npm policy and dependent usage, and must be a deliberate maintainer decision—not the normal rollback mechanism.

## 7. Completion checklist

- [ ] Tag still resolves to the expected immutable commit.
- [ ] Release lock is held by this run and no stale run can publish.
- [ ] Every npm package is confirmed and verified at the expected version.
- [ ] GitHub Release entry exists for the same tag.
- [ ] Every required image is verified by digest and platforms.
- [ ] Manifest says `COMPLETE` only after all checks pass.
- [ ] Logs contain enough sanitized evidence for another operator to explain the recovery.
