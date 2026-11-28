#!/bin/sh
# Runs probe.sh under rootless podman on a machine that only has Docker.
#
# podman v5.8.9 rather than 6.x: the test machine's Docker VM runs cgroups v1, which podman 6
# refuses ("Cgroups v1 not supported"). The design sets isolate=strict explicitly, so it does
# not depend on podman 6 having made that the default.
#
#   sh run-in-docker.sh
#   MUTATE=no-internal sh run-in-docker.sh
set -e
here=$(cd "$(dirname "$0")" && pwd)
exec docker run --rm --privileged -e MUTATE="${MUTATE:-}" -v "$here:/probe:ro" \
    quay.io/podman/stable:v5.8.9 sh /probe/in-container.sh
