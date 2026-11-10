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

/**
 * The base image's Dockerfile, for `--build-arg ZEN_VERSION=<a published version>`.
 * packages/sandbox/sandbox-base.Dockerfile is this, kept in step by a test.
 */
export function sandboxBaseDockerfile(): string {
    return `# Generated from sandboxBaseDockerfile() in src/base.ts - edit that, then run
# \`npm run sandbox-base:dockerfile -w packages/sandbox\`. The base every zen project's
# sandbox/Dockerfile starts FROM: ${SANDBOX_BASE_REPO}:<version>.
#
# Python and Node both, because an agent asked to look at a repository does not
# get to choose which one it finds.

FROM docker.io/library/node:24-bookworm-slim AS node
FROM docker.io/library/python:3.14-slim-bookworm

# Copy Node.js runtime and global modules from official Node image
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/include/node /usr/local/include/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules

# Symlink npm and npx executables
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \\
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# Keep the third-party dependencies of @zenera/{cli,engine,neo,rag,view} cached
# when the pinned CLI release changes. Keep in sync with their package.json files.
RUN npm install -g \\
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

# HTTP clients agents' scripts commonly reach for. Global npm packages resolve for require()
# through NODE_PATH; ESM import does not read it (built-in fetch needs nothing).
RUN pip install --no-cache-dir "requests>=2.32,<3" \\
    && npm install -g "axios@^1"
ENV NODE_PATH=/usr/local/lib/node_modules

# The zen of this release, so the tools in the container are the ones the session
# outside it was built by. Declared here: an ARG invalidates the cache of every RUN after it.
ARG ZEN_VERSION
RUN test -n "$ZEN_VERSION" \\
    && npm install -g "@zenera/cli@$ZEN_VERSION" "@zenera/rag@$ZEN_VERSION"

LABEL zenera.sandbox-base=1 zenera.version=$ZEN_VERSION \\
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
