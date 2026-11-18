import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrepareOptions } from './contract.ts';
import type { Runner } from './process.ts';

// ---------------------------------------------------------------------------
// The sandbox base image
//
// What every project's sandbox/Dockerfile used to install itself — Python,
// Node, the third-party packages zen's tools need, and @zenera/cli and
// @zenera/rag at the version that wrote the file — built once per release and
// published as ghcr.io/zenera-ai/zenera-sandbox:<version> (CI, RELEASE.md).
// A project's Dockerfile starts `FROM` it and adds only its own needs, so a
// new project pulls a few layers instead of running npm for minutes.
//
// When the image cannot be pulled (offline, air-gapped, not public yet, a
// version not released), the build makes it here from the same Dockerfile and
// tags it as the name the project asked for — slower, never broken.
// ---------------------------------------------------------------------------

export const SANDBOX_BASE_REPO = 'ghcr.io/zenera-ai/zenera-sandbox';

/** `FROM [--platform=…] ghcr.io/zenera-ai/zenera-sandbox:<version>`: the version is the tag. */
const BASE_FROM =
    /^\s*FROM\s+(?:--platform=\S+\s+)?ghcr\.io\/zenera-ai\/zenera-sandbox:([^\s@]+)/gim;

const REAL_EXECUTABLE = `-c 'import os, sys; print(os.path.realpath(sys.executable))'`;

/**
 * Shell that fails unless `python` and `python3` are both on PATH and are one interpreter:
 * a script's `#!/usr/bin/env python` must run where `python3 -m pip install` put its packages.
 * Every image zen builds passes it (the base, a project's sandbox image, an agent image).
 */
export const SAME_PYTHON_CHECK =
    `p3="$(python3 ${REAL_EXECUTABLE})" && test -n "$p3" ` +
    `&& test "$(python ${REAL_EXECUTABLE})" = "$p3"`;

/** Debian packages, npm packages and PyPI files resolve as they were at this moment. */
export const SANDBOX_BASE_SNAPSHOT = '2026-11-18T20:45:00Z';

/** `name:tag@digest`: the digest of the multi-platform index, so amd64 and arm64 both resolve. */
export const SANDBOX_BASE_IMAGES = {
    node: 'docker.io/library/node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54',
    python: 'docker.io/library/python:3.14-slim-bookworm@sha256:3fe1a0b6c2d6b2ebb572906cdabeca75aeb558c0c17db5ffefbcf8094871c32b',
} as const;

function debianSnapshot(iso: string): string {
    return iso.replace(/[-:]/g, '').replace(/\.\d+/, '');
}

const ZEN_PUBLISHED_AT = [
    `node -e 'const v = process.argv[1];`,
    `const view = (...a) => JSON.parse(require("child_process").execFileSync("npm", ["view", ...a, "--json"], { encoding: "utf8" }) || "{}");`,
    `const zen = new Set(["@zenera/cli", "@zenera/rag"]);`,
    `for (const p of zen) for (const d of Object.keys(view(p + "@" + v, "dependencies"))) if (d.startsWith("@zenera/")) zen.add(d);`,
    `const at = [...zen].map((p) => view(p, "time")[v]);`,
    `if (!at.every(Boolean)) throw new Error("not on npm: " + v);`,
    `console.log(at.sort().at(-1));' "$ZEN_VERSION"`,
].join(' \\\n        ');

/**
 * The base image's Dockerfile, for `--build-arg ZEN_VERSION=<a published version>`.
 * packages/sandbox/sandbox-base.Dockerfile is this, kept in step by a test.
 */
export function sandboxBaseDockerfile(): string {
    const at = SANDBOX_BASE_SNAPSHOT;
    const debian = debianSnapshot(at);
    const python = SANDBOX_BASE_IMAGES.python;
    return `# Generated from sandboxBaseDockerfile() in src/base.ts - edit that, then run
# \`npm run sandbox-base:dockerfile -w packages/sandbox\`. The base every zen project's
# sandbox/Dockerfile starts FROM: ${SANDBOX_BASE_REPO}:<version>.
#
# Python and Node both, because an agent asked to look at a repository does not
# get to choose which one it finds.

FROM ${SANDBOX_BASE_IMAGES.node} AS node
FROM ${python}

# Command-line tools agents reach for first: fetching, JSON, searching, archives.
RUN printf 'deb [check-valid-until=no signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] http://snapshot.debian.org/archive/%s %s main\\n' \\
        debian/${debian} bookworm \\
        debian/${debian} bookworm-updates \\
        debian-security/${debian} bookworm-security \\
        > /tmp/snapshot.list \\
    && snapshot='-o Dir::Etc::SourceList=/tmp/snapshot.list -o Dir::Etc::SourceParts=/nonexistent' \\
    && apt-get update $snapshot \\
    && apt-get install -y --no-install-recommends $snapshot ca-certificates curl jq ripgrep unzip \\
    && rm -rf /var/lib/apt/lists/* /tmp/snapshot.list

# Copy Node.js runtime and global modules from official Node image
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/include/node /usr/local/include/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules

# Symlink npm and npx executables
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \\
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# Keep the third-party dependencies of @zenera/{cli,engine,neo,rag,view} cached
# when the pinned CLI release changes. Keep in sync with their package.json files.
RUN npm install -g --before=${at} \\
    "@anthropic-ai/sdk@^0.120.0" \\
    "@apidevtools/swagger-parser@^12.0.0" \\
    "@google/genai@^2.30.0" \\
    "@inkjs/ui@^2.0.0" \\
    "@lancedb/lancedb@^0.38.0" \\
    "@openrouter/sdk@^1.4.25" \\
    "@types/hast@^3.0.5" \\
    "google-auth-library@^10.0.0" \\
    "graphology@^0.26.0" \\
    "ink@^7.1.1" \\
    "lowlight@^3.3.0" \\
    "mermaid@^12.2.0" \\
    "openai@^6.0.0" \\
    "react@^19.2.8" \\
    "rehype-sanitize@^6.0.0" \\
    "rehype-slug@^6.0.0" \\
    "remark-frontmatter@^5.0.0" \\
    "remark-gfm@^4.0.1" \\
    "remark-parse@^11.0.0" \\
    "remark-rehype@^11.1.2" \\
    "unified@^11.0.5" \\
    "yaml@^2.9.1" \\
    "yauzl@^3.4.0" \\
    "yazl@^3.3.1" \\
    "zod@^4.6.7"

# Libraries agents' scripts commonly reach for: HTTP clients, JSON Schema validation, YAML,
# dates, HTML. \`python\` and \`python3\` must be one interpreter, the one pip installs into.
# Global npm packages resolve for require() through NODE_PATH; ESM import does not read it
# (built-in fetch needs nothing).
RUN pip install --no-cache-dir --uploaded-prior-to=${at} \\
        "requests>=2.32,<3" \\
        "jsonschema>=4,<5" \\
        "pyyaml>=6,<7" \\
        "python-dateutil>=2.9,<3" \\
        "beautifulsoup4>=4.12,<5" \\
    && ${SAME_PYTHON_CHECK} \\
    && python -c "import bs4, dateutil, jsonschema, requests, yaml" \\
    && npm install -g --before=${at} "axios@^1"
ENV NODE_PATH=/usr/local/lib/node_modules

# The zen of this release, so the tools in the container are the ones the session
# outside it was built by. Declared here: an ARG invalidates the cache of every RUN after it.
ARG ZEN_VERSION
RUN test -n "$ZEN_VERSION" \\
    && published="$(${ZEN_PUBLISHED_AT})" \\
    && npm install -g --before="$published" "@zenera/cli@$ZEN_VERSION" "@zenera/rag@$ZEN_VERSION"

LABEL zenera.sandbox-base=1 zenera.version=$ZEN_VERSION zenera.snapshot=${at} \\
      org.opencontainers.image.base.name=${python.split('@')[0]} \\
      org.opencontainers.image.base.digest=${python.split('@')[1]} \\
      org.opencontainers.image.source=https://github.com/zenera-ai/ZeneraNeo
`;
}

/** The base images a Dockerfile starts FROM, as `{ image, version }`. */
export function sandboxBasesOf(dockerfile: string): { image: string; version: string }[] {
    const found = new Map<string, string>();
    for (const match of dockerfile.matchAll(BASE_FROM)) {
        const version = match[1]!;
        found.set(`${SANDBOX_BASE_REPO}:${version}`, version);
    }
    return [...found].map(([image, version]) => ({ image, version }));
}

const PULL_MS = 600_000;
const BUILD_MS = 1_800_000;

/**
 * Puts every zenera base image the Dockerfile names on the engine: present, pulled, or — when
 * the pull fails — built here and tagged as that name, so the project's own build finds it.
 * A base that cannot be built either is left to the project's build to report.
 */
export async function ensureSandboxBases(
    engine: string,
    run: Runner,
    dockerfilePath: string,
    opts: PrepareOptions = {},
): Promise<void> {
    let text: string;
    try {
        text = readFileSync(dockerfilePath, 'utf8');
    } catch {
        return;
    }
    const say = (line: string): void => opts.onProgress?.(line);
    for (const { image, version } of sandboxBasesOf(text)) {
        const present = await run(engine, ['image', 'exists', image], { timeoutMs: 30_000 });
        if (present.code === 0) {
            continue;
        }
        say(`pulling the sandbox base ${image}`);
        const pulled = await run(engine, ['pull', image], {
            timeoutMs: PULL_MS,
            signal: opts.signal,
        });
        if (pulled.code === 0) {
            continue;
        }
        const why = (pulled.stderr.trim() || `exit ${pulled.code}`).split('\n').at(-1)!;
        say(`  could not pull it (${why.slice(0, 200)})`);
        say(`  building it here instead (several minutes, once)`);
        const ctx = mkdtempSync(join(tmpdir(), 'zen-sandbox-base-'));
        try {
            writeFileSync(join(ctx, 'Dockerfile'), sandboxBaseDockerfile());
            const built = await run(
                engine,
                [
                    'build',
                    '--tag',
                    image,
                    '--build-arg',
                    `ZEN_VERSION=${version}`,
                    '--file',
                    join(ctx, 'Dockerfile'),
                    ctx,
                ],
                { timeoutMs: BUILD_MS, signal: opts.signal },
            );
            if (built.code !== 0) {
                say(`  building the base failed too; the project's build will say why`);
            }
        } finally {
            rmSync(ctx, { recursive: true, force: true });
        }
    }
}
