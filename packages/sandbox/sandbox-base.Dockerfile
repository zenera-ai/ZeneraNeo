# Generated from sandboxBaseDockerfile() in src/base.ts - edit that, then run
# `npm run sandbox-base:dockerfile -w packages/sandbox`. The base every zen project's
# sandbox/Dockerfile starts FROM: ghcr.io/zenera-ai/zenera-sandbox:<version>.
#
# Python and Node both, because an agent asked to look at a repository does not
# get to choose which one it finds.

FROM docker.io/library/node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS node
FROM docker.io/library/python:3.14-slim-bookworm@sha256:3fe1a0b6c2d6b2ebb572906cdabeca75aeb558c0c17db5ffefbcf8094871c32b

# Command-line tools agents reach for first: fetching, JSON, searching, archives.
RUN printf 'deb [check-valid-until=no signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] http://snapshot.debian.org/archive/%s %s main\n' \
        debian/20261118T204500Z bookworm \
        debian/20261118T204500Z bookworm-updates \
        debian-security/20261118T204500Z bookworm-security \
        > /tmp/snapshot.list \
    && snapshot='-o Dir::Etc::SourceList=/tmp/snapshot.list -o Dir::Etc::SourceParts=/nonexistent' \
    && apt-get update $snapshot \
    && apt-get install -y --no-install-recommends $snapshot ca-certificates curl jq ripgrep unzip \
    && rm -rf /var/lib/apt/lists/* /tmp/snapshot.list

# Copy Node.js runtime and global modules from official Node image
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/include/node /usr/local/include/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules

# Symlink npm and npx executables
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# Keep the third-party dependencies of @zenera/{cli,engine,neo,rag,view} cached
# when the pinned CLI release changes. Keep in sync with their package.json files.
RUN npm install -g --before=2026-11-18T20:45:00Z \
    "@anthropic-ai/sdk@^0.120.0" \
    "@apidevtools/swagger-parser@^12.0.0" \
    "@google/genai@^2.30.0" \
    "@inkjs/ui@^2.0.0" \
    "@lancedb/lancedb@^0.38.0" \
    "@openrouter/sdk@^1.4.25" \
    "@types/hast@^3.0.5" \
    "google-auth-library@^10.0.0" \
    "graphology@^0.26.0" \
    "ink@^7.1.1" \
    "lowlight@^3.3.0" \
    "mermaid@^12.2.0" \
    "openai@^6.0.0" \
    "react@^19.2.8" \
    "rehype-sanitize@^6.0.0" \
    "rehype-slug@^6.0.0" \
    "remark-frontmatter@^5.0.0" \
    "remark-gfm@^4.0.1" \
    "remark-parse@^11.0.0" \
    "remark-rehype@^11.1.2" \
    "unified@^11.0.5" \
    "yaml@^2.9.1" \
    "yauzl@^3.4.0" \
    "yazl@^3.3.1" \
    "zod@^4.6.7"

# Libraries agents' scripts commonly reach for: HTTP clients, JSON Schema validation, YAML,
# dates, HTML. `python` and `python3` must be one interpreter, the one pip installs into.
# Global npm packages resolve for require() through NODE_PATH; ESM import does not read it
# (built-in fetch needs nothing).
RUN pip install --no-cache-dir --uploaded-prior-to=2026-11-18T20:45:00Z \
        "requests>=2.32,<3" \
        "jsonschema>=4,<5" \
        "pyyaml>=6,<7" \
        "python-dateutil>=2.9,<3" \
        "beautifulsoup4>=4.12,<5" \
    && p3="$(python3 -c 'import os, sys; print(os.path.realpath(sys.executable))')" && test -n "$p3" && test "$(python -c 'import os, sys; print(os.path.realpath(sys.executable))')" = "$p3" \
    && python -c "import bs4, dateutil, jsonschema, requests, yaml" \
    && npm install -g --before=2026-11-18T20:45:00Z "axios@^1"
ENV NODE_PATH=/usr/local/lib/node_modules

# The zen of this release, so the tools in the container are the ones the session
# outside it was built by. Declared here: an ARG invalidates the cache of every RUN after it.
ARG ZEN_VERSION
RUN test -n "$ZEN_VERSION" \
    && published="$(node -e 'const v = process.argv[1]; \
        const view = (...a) => JSON.parse(require("child_process").execFileSync("npm", ["view", ...a, "--json"], { encoding: "utf8" }) || "{}"); \
        const zen = new Set(["@zenera/cli", "@zenera/rag"]); \
        for (const p of zen) for (const d of Object.keys(view(p + "@" + v, "dependencies"))) if (d.startsWith("@zenera/")) zen.add(d); \
        const at = [...zen].map((p) => view(p, "time")[v]); \
        if (!at.every(Boolean)) throw new Error("not on npm: " + v); \
        console.log(at.sort().at(-1));' "$ZEN_VERSION")" \
    && npm install -g --before="$published" "@zenera/cli@$ZEN_VERSION" "@zenera/rag@$ZEN_VERSION"

# What this build installed, with versions, to compare two builds of one version:
# node scripts/sandbox-base-diff.mjs <image> <image>
RUN mkdir -p /usr/local/share/zenera \
    && { echo '[runtime]' && node --version && python --version && echo '[dpkg]' && dpkg-query -W -f '${Package} ${Version} ${Architecture}\n' | LC_ALL=C sort && echo '[pip]' && python -m pip freeze --all --disable-pip-version-check | LC_ALL=C sort && echo '[npm]' && npm ls -g --all --parseable --long 2> /dev/null | sed -n 's|^/usr/local/lib/node_modules/||p' | LC_ALL=C sort; } > /usr/local/share/zenera/sandbox-base.txt

LABEL zenera.sandbox-base=1 zenera.version=$ZEN_VERSION zenera.snapshot=2026-11-18T20:45:00Z \
      org.opencontainers.image.base.name=docker.io/library/python:3.14-slim-bookworm \
      org.opencontainers.image.base.digest=sha256:3fe1a0b6c2d6b2ebb572906cdabeca75aeb558c0c17db5ffefbcf8094871c32b \
      org.opencontainers.image.source=https://github.com/zenera-ai/ZeneraNeo
