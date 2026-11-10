# Generated from agentRuntimeDockerfile() in src/container.ts - edit that, then run
# `npm run agent-runtime:dockerfile -w packages/cli`. zen's prebuilt agent runtime: what every
# agent image copies into /opt/zenera. Build with --build-arg ZEN_VERSION=<a published version>.
FROM docker.io/library/node:24-trixie-slim AS runtime
ARG ZEN_VERSION
RUN test -n "$ZEN_VERSION" \
 && mkdir -p /opt/zenera/app /opt/zenera/bin && cd /opt/zenera/app \
 && printf '{"name":"zenera-runtime","private":true}\n' > package.json \
 && npm pkg set "dependencies.@zenera/cli=$ZEN_VERSION" "overrides.@zenera/sandbox=$ZEN_VERSION" "overrides.@zenera/neo=$ZEN_VERSION" "overrides.@zenera/view=$ZEN_VERSION" "overrides.@zenera/engine=$ZEN_VERSION" "overrides.@zenera/server=$ZEN_VERSION" \
 && npm install --omit=dev --ignore-scripts --no-audit --no-fund \
 && cp "$(command -v node)" /opt/zenera/bin/node \
 && test "$(/opt/zenera/bin/node /opt/zenera/app/node_modules/@zenera/cli/dist/main.js --version)" = "$ZEN_VERSION"

FROM docker.io/library/alpine:3.22 AS bwrap
ARG BWRAP_VERSION=0.13.1
RUN apk add --no-cache build-base meson ninja pkgconf libcap-dev libcap-static linux-headers curl xz
RUN mkdir -p /src && curl -fsSL https://github.com/containers/bubblewrap/releases/download/v${BWRAP_VERSION}/bubblewrap-${BWRAP_VERSION}.tar.xz \
    | tar -xJ -C /src --strip-components=1
RUN cd /src && meson setup build --buildtype=release --prefer-static --default-library=static \
        -Dc_link_args=-static -Dselinux=disabled -Dman=disabled -Dtests=false \
        -Dbash_completion=disabled -Dzsh_completion=disabled \
 && ninja -C build bwrap && strip build/bwrap

FROM scratch
ARG ZEN_VERSION
COPY --from=runtime /opt/zenera /opt/zenera
COPY --from=bwrap /src/build/bwrap /opt/zenera/bin/bwrap
LABEL zenera.agent-runtime=1 zenera.version=$ZEN_VERSION \
      org.opencontainers.image.source=https://github.com/zenera-ai/ZeneraNeo
