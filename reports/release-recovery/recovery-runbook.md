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

- **Validation failed before publication:** if the fix is workflow-only, dispatch from `main` with the original tag after confirming its peeled commit is unchanged. If package source or contents must change, create a new commit and a new version/tag; never reuse a consumed tag for different package bytes.
- **npm publication is partial or ambiguous:** reconcile every expected package version against npm. Do not assume that a failed step means the registry did not accept the publish.
- **npm packages verified, image job failed:** do not re-publish packages. With the current workflow, use GitHub Actions' **Re-run failed jobs** on the failed image job. A purpose-built `images`-only `workflow_dispatch` input is a proposed future improvement, not an existing capability. The repository documents that the product can build either image locally, so classify this as degraded prebuilt-image availability rather than an unpublished npm release.
- **GitHub Release creation failed:** reconcile/create release metadata for the same tag; package publication is already complete. If the source fix is only in the workflow, dispatch from `main` while checking out the unchanged tag for release contents.

## 3. Reconcile npm packages

For each package from `node scripts/release.mjs workspaces --paths`, in the returned dependency order:

```bash
npm view '@zenera/neo@X.Y.Z' version --json
```

Interpret results carefully:

- Exact version returned: fetch metadata and compare npm's `dist.integrity` SRI value with the retained tarball's locally computed SRI using the same algorithm. Separately compare the locally recorded SHA-256 of the exact retained tarball. Do not label npm's SRI value SHA-256.
- Confirmed exact-version not-found response: eligible for publication, provided all validation passed and the release lock is held.
- 401/403/429/5xx/timeout/DNS/other transport error: **not** proof of absence. Stop and resolve registry access/health first.
- Version exists but metadata differs: stop and escalate. Do not overwrite an immutable npm version.

The current workflow's simple `npm view ... || npm publish` branch should be hardened in an implementation so only confirmed not-found permits publishing.

## 4. Reconcile GitHub Release metadata

Before creating a GitHub Release, query it by tag (for example, `gh release view "$TAG"`). If it already exists, verify that it targets the expected tag/commit and reuse it. Create it only when absent. The existing workflow's unconditional `gh release create` step should be made idempotent so a full workflow retry after successful npm/GitHub Release publication but failed image distribution can reach the image jobs.

## 5. Retry policy

Use the repository's documented `workflow_dispatch` path with the original tag, and dispatch from `main` when the purpose is to run a corrected workflow against the immutable tagged source tree. Confirm the workflow checks out the requested tag for package contents while using the dispatch ref for the workflow definition. The existing `RELEASE.md` documents this distinction.

A future workflow implementation should expose separate recovery targets:

- `packages`: reconcile and publish only missing package artifacts.
- `images`: reconcile and build/push only missing image artifacts.
- `all`: reconcile packages first, then images.

Do not add a manual “force publish” switch. Force should never bypass identity, immutability, or registry reconciliation checks.

## 6. Image recovery

Before building an image, verify the complete internal dependency closure that the Dockerfile will install, not only the short top-level `needs` list in the current matrix. For example, the agent runtime installs `@zenera/cli`, whose dependencies include other internal packages such as `@zenera/server`. Poll exact versions until visible. A confirmed 404 can be treated as not-yet-visible during a bounded wait; 401/403/429/5xx/network errors must fail with their own diagnosis rather than being treated as absence. The v1.3.2 logs show why this matters: `npm publish` returned success for `@zenera/server@1.3.2`, but the later image build still received `ETARGET` for that version.

Before push, persist the expected OCI manifest/index digest and source commit/build-input identity for the exact multi-platform artifact being pushed. After push, inspect the image manifest list and record its registry digest and platform set (`linux/amd64`, `linux/arm64`). If the image exists, resolve the version tag to its immutable digest and compare it with the persisted expected digest before marking it verified and skipping it on retry. If a runner loses the push response and no expected digest or immutable artifact was persisted, block for controlled operator investigation rather than treating a matching tag as proof of identity. If an image exists but differs from the expected build, block for operator review; do not overwrite a release tag casually. Apply the same fail-closed distinction to GHCR inspection: authentication, throttling, and network errors are not evidence that an image tag is absent. Because prebuilt images are optional performance optimizations in this repository, an image failure should leave the npm release marked `RELEASED` while the image substate remains `IMAGE_DEGRADED` until recovered.

## 7. Bad published version

npm versions are immutable. If a package is defective:

1. Stop the remaining rollout if the defect affects the release's safety or compatibility.
2. Assess blast radius and dependent packages/images.
3. Have an authorized maintainer deprecate the bad version with a clear reason.
4. Cut a corrected patch release; do not move or reuse the consumed tag/version.
5. Update the release record with incident reference, deprecation status, corrected version, and decision owner.

Unpublishing is exceptional, constrained by npm policy and dependent usage, and must be a deliberate maintainer decision—not the normal rollback mechanism.

## 8. Completion checklist

- [ ] Tag still resolves to the expected immutable commit.
- [ ] Release lock is held by this run and no stale run can publish.
- [ ] Every npm package is confirmed and verified at the expected version.
- [ ] GitHub Release entry exists for the same tag and its ID, URL, and target commit are recorded and verified.
- [ ] For each image, the persisted expected digest/source identity matches the registry digest and platform descriptors.
- [ ] Image status is independently recorded as `IMAGES_VERIFIED` or `IMAGE_DEGRADED`.
- [ ] Manifest says `RELEASED` only after all npm packages and GitHub Release metadata are verified.
- [ ] Logs contain enough sanitized evidence for another operator to explain the recovery.
