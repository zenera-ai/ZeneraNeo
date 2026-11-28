# Generated from sandboxBaseDockerfile() in src/base.ts - edit that, then run
# `npm run sandbox-base:dockerfile -w packages/sandbox`. The base every zen project's
# sandbox/Dockerfile starts FROM: ghcr.io/zenera-ai/zenera-sandbox:<version>.
#
# Python and Node both, because an agent asked to look at a repository does not
# get to choose which one it finds.

FROM docker.io/library/node:24-bookworm-slim AS node
FROM docker.io/library/python:3.14-slim-bookworm

# Command-line tools agents reach for first: fetching, JSON, searching, archives.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl jq ripgrep unzip \
    && rm -rf /var/lib/apt/lists/*

# Copy Node.js runtime and global modules from official Node image
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/include/node /usr/local/include/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules

# Symlink npm and npx executables
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# Keep the third-party dependencies of @zenera/{cli,engine,neo,rag,view} cached
# when the pinned CLI release changes. Keep in sync with their package.json files.
RUN npm install -g \
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

# The html-page skill's build (/skills/html-page/scripts/build.ts): it type-checks a page's
# app.tsx, bundles it with React and the skill's kit, and writes the page as one index.html.
RUN npm install -g \
    "esbuild@^0.28.2" \
    "typescript@^5.9.3" \
    "react@^19.2.8" \
    "react-dom@^19.2.8" \
    "@types/react@^19.2.18" \
    "@types/react-dom@^19.2.3"

# A browser for `zen page` (the html-page skill's check: a page's errors, screenshots, clicks):
# Chromium's headless shell and the libraries it needs, for the Playwright @zenera/browser pins, and
# fonts so text and emoji draw as on a desktop.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN npx -y "playwright-core@1.65.1" install --with-deps --only-shell chromium \
    && apt-get install -y --no-install-recommends \
       fonts-liberation fonts-noto-core fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/* /root/.npm

# Libraries agents' scripts commonly reach for: HTTP clients, JSON Schema validation, YAML,
# dates, HTML. `python` and `python3` must be one interpreter, the one pip installs into.
# Global npm packages resolve for require() through NODE_PATH; ESM import does not read it
# (built-in fetch needs nothing).
RUN pip install --no-cache-dir \
        "requests>=2.32,<3" \
        "jsonschema>=4,<5" \
        "pyyaml>=6,<7" \
        "python-dateutil>=2.9,<3" \
        "beautifulsoup4>=4.12,<5" \
    && p3="$(python3 -c 'import os, sys; print(os.path.realpath(sys.executable))')" && test -n "$p3" && test "$(python -c 'import os, sys; print(os.path.realpath(sys.executable))')" = "$p3" \
    && python -c "import bs4, dateutil, jsonschema, requests, yaml" \
    && npm install -g "axios@^1"
ENV NODE_PATH=/usr/local/lib/node_modules

# The zen of this release, so the tools in the container are the ones the session
# outside it was built by. Declared here: an ARG invalidates the cache of every RUN after it.
ARG ZEN_VERSION
RUN test -n "$ZEN_VERSION" \
    && npm install -g "@zenera/cli@$ZEN_VERSION" "@zenera/rag@$ZEN_VERSION"

LABEL zenera.sandbox-base=1 zenera.version=$ZEN_VERSION \
      org.opencontainers.image.source=https://github.com/zenera-ai/ZeneraNeo
