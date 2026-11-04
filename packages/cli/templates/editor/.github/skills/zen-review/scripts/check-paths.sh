#!/usr/bin/env bash
#
# Every path-shaped token a running agent would be told to open, minus the ones
# that exist. The §2.5 sweep, as a script rather than a command to retype.
#
#   check-paths.sh          each candidate, with the file and line it is on
#   check-paths.sh raw      the tokens alone, unfiltered — the sweep itself
#
# A running agent sees three paths: /workspace, /assets and /skills.
# Everything else printed here is either noise this script has not learned yet
# or an instruction to open a file that is not there. There is no third case,
# which is why this exits non-zero whenever it prints one: the list is meant to
# be emptied or explained, not skimmed.
#
# Run it from anywhere; it finds the project root from its own location.

set -eu
cd "$(dirname "$0")/../../../.."

# What a path looks like in prose. §2.5 of the copilot instructions describes
# the sweep and sends you here for it, so this is the only copy of the pattern.
# Every segment after the first is taken too: matched one segment at a time,
# `/skills/house_style/examples.md` comes back as a mount that resolves *and* a
# stray `/examples.md`, and that fragment is noise on every run of every project.
TOKEN='[~.]?/?[A-Za-z0-9_.-]*(/[A-Za-z0-9_.*-]+)+'

# The three mounts, and only those: a token under one of them is a path that
# resolves.
MOUNTS='^/(workspace|assets|skills)(/|$)'

# English that happens to contain a slash, and the placeholder paths of a
# worked example. Add to this rather than teaching a reviewer to skip the same
# line every run.
NOISE='^(and/or|he/she|his/her|input/output|read/write|w/o|n/a|N/A|24/7|km/h)$|^(path|foo)/'

# A url, stripped before tokenising rather than filtered after it — the token
# regex reads `https://acme.dev/docs` as `//acme.dev` *and* `/docs`, and the
# second half is indistinguishable from a real absolute path once it is alone.
#
# A meta agent command, `zen meta run /spec-edit`, goes the same way: its
# `/<name>` is a command (a skill), not a file the running agent is told to open.
strip_urls() {
    sed -E -e 's#[a-zA-Z][a-zA-Z0-9+.-]*://[^][ )"'"'"'`>]*##g' \
        -e 's#(zen meta run( [A-Za-z0-9_.-]+)?) /[A-Za-z0-9_-]+#\1#g' "$1"
}

# The three trees §2.5 names, prose only: a skill's own script is code the
# sandbox runs, not text rendered into a prompt, and its paths are its own.
#
# The four copies `zen` ships (files-, fork-, memory-, tools-instructions.md)
# are left out on purpose. They are full of worked examples, so they fail this
# sweep by design, and the project cannot edit them anyway: `zen check` reports
# any byte that differs as `rules.stale`.
files() {
    {
        if [ -d agents/prompts ]; then find agents/prompts -type f -name '*.md'; fi
        if [ -d agents/skills ]; then find agents/skills -type f -name '*.md'; fi
        for file in agents/*instructions.md; do
            if [ -f "$file" ]; then echo "$file"; fi
        done
    } | grep -Ev '^agents/(files|fork|memory|tools)-instructions\.md$' | sort -u
}

# Every token in those files, urls removed first, and a sentence's full stop
# trimmed off the end — no path ends in a dot, and `/workspace.` would
# otherwise read as a mount that does not exist.
sweep() {
    while IFS= read -r file; do
        if [ -n "$file" ]; then
            strip_urls "$file"
        fi
    done <<EOF
$(files)
EOF
}

tokens() {
    sweep | grep -Eoh "$TOKEN" | sed 's/\.*$//' | sort -u
}

candidates() {
    tokens | grep -Ev "$MOUNTS" | grep -Ev "$NOISE" || true
}

# Where a token came from, so a finding names a file and a line rather than
# sending someone back to grep for it.
where() {
    while IFS= read -r file; do
        if [ -n "$file" ]; then
            grep -nF -- "$1" "$file" | sed "s|^|    $file:|" | cut -d: -f1,2
        fi
    done <<EOF
$(files)
EOF
}

report() {
    found=0
    while IFS= read -r token; do
        if [ -n "$token" ]; then
            found=$((found + 1))
            echo "path: $token"
            where "$token"
        fi
    done <<EOF
$(candidates)
EOF
    if [ "$found" -eq 0 ]; then
        echo "ok: every path in the three trees is under a mount"
        return 0
    fi
    echo "candidates: $found to explain or fix"
    return 1
}

case "${1:-report}" in
    report) report ;;
    raw) tokens ;;
    *)
        echo "usage: check-paths.sh [report|raw]" >&2
        exit 2
        ;;
esac
