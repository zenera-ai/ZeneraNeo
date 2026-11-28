# Release flow

This traces the default `npm run release -- <version>` path from a clean checkout to published npm packages and container images. It reflects `scripts/release.mjs`, `.github/workflows/release.yml`, and the root `package.json` as of this change.

```mermaid
flowchart TD
    A[Engineer runs npm run release -- patch] --> B[package.json invokes node scripts/release.mjs patch]
    B --> C{Preflight checks pass?}
    C -- No --> X[Exit without a release]
    C -- Yes --> D[Discover non-private packages and topologically sort internal dependencies]
    D --> E[Verify all publishable packages share one current version]
    E --> F[Calculate next version and reject an existing tag]
    F --> G[Update package versions and internal dependency ranges]
    G --> H[npm install --package-lock-only]
    H --> I[Commit release: vX.Y.Z]
    I --> J[Create annotated tag vX.Y.Z]
    J --> K[Engineer pushes the tag]
    K --> L[GitHub Release workflow checks out the tag]
    L --> M[Install Node, npm, and dependencies]
    M --> N[Verify tag matches package versions and internal ranges]
    N --> O[Run formatting, type checks, offline tests, and pack dry-runs]
    O --> P[For each package in dependency order]
    P --> Q{Version already on npm?}
    Q -- Yes --> R[Skip package]
    Q -- No --> S[Publish package to npm]
    R --> T{More packages?}
    S --> T
    T -- Yes --> P
    T -- No --> U[Create GitHub release]
    U --> V[Wait for npm tarballs to become downloadable]
    V --> W{Image version already exists?}
    W -- Yes --> Y[Skip image]
    W -- No --> Z[Build and push multi-architecture images]
```

## Failure cases

| Failure | What would be visible | Why it stops or remains recoverable |
| --- | --- | --- |
| The working tree is dirty before the version bump. | The local command exits with `release: the working tree is dirty — commit or stash first`; no package manifests, commit, or tag are created. | `release.mjs` checks `git status --porcelain` before writing files, preventing unrelated changes from entering the release commit. |
| A tag does not match the package versions or an internal dependency range. | The workflow fails at **The tag must match the versions in the tree** with a message naming the mismatched package or dependency. No publish step runs. | Verification happens before tests, packing, or publishing, so the inconsistent tag cannot reach npm. |
| Publishing succeeds for some packages and then a later package fails. | The **Publish to npm** log shows earlier `npm publish` commands succeeding and the failing package's npm error; the GitHub release and image jobs do not complete. | A rerun is safe: the loop checks `npm view name@version`, prints `already published` for completed packages, and resumes in dependency order at the first missing package. |

## Scope

This documents the normal tagged release and the observable behavior of three failure modes. It does not model manual publishing, first publication of a new npm package, `workflow_dispatch`, or every image-build failure branch; those paths do not change the main route from the release command to a published package.
