#!/usr/bin/env bash
#
# The one command that initialises this project.
#
#   scripts/_setup.sh            do whatever is not done yet
#   scripts/_setup.sh --force    do all of it again
#   scripts/_setup.sh --check    say what is not done, and do none of it
#
# Anything that has to be in place before a run — an index built, a document
# fetched, a file generated — is a script in this directory rather than a
# paragraph somebody is meant to follow. The leading underscore is what
# separates the runner from the steps it runs.
#
# Each step is `scripts/<name>.sh`, named below in the order they depend on
# each other. A step:
#
#   - starts `set -eu` and `cd "$(dirname "$0")/.."`, so it works from anywhere
#   - takes no arguments, and reads $FORCE to know whether to redo finished work
#   - exits 0 when it did the work, 3 when there was nothing to do, non-zero
#     when it failed
#   - under $CHECK, does none of the work: it runs the same "already done" test,
#     exits 3 when the answer is yes, and otherwise says what is missing and
#     exits 4. A check must not assume an earlier step has run — a missing
#     prerequisite is a 4 of its own, not a hard failure, or one unbuilt thing
#     hides the rest of the list
#   - writes under .tmp/ and moves the result into place, so an interrupted run
#     never leaves half an artefact behind
#
# A step decides it has nothing to do by testing for something that SURVIVES A
# CLONE. Files that are git-ignored do not: a vector index commits its manifest
# and ignores `lance/`, so `[ -f .../manifest.json ]` is true on a fresh
# checkout that cannot search at all, and every step reports `skipped` until the
# first search fails for a reason nobody connects to setup. Ask the tool instead
# of guessing at files — `zen rag docs ready` answers exactly that question.
#
# That test is the whole of `--check`, which is why this is one script and not
# two: the steps already know what "done" means, and a second script asking the
# same question would be a second answer to keep in step with this one.
#
# Running this twice has to be safe, and the second run is what proves it: every
# step should report `skipped`.

set -eu
cd "$(dirname "$0")/.."

FORCE=0
CHECK=0
case "${1:-}" in
    '') ;;
    --force) FORCE=1 ;;
    --check) CHECK=1 ;;
    *)
        echo "usage: scripts/_setup.sh [--force|--check]" >&2
        exit 2
        ;;
esac
export FORCE CHECK

LOGS=.tmp/logs

# The steps, in order. Nothing here yet — a project with nothing to build
# before it runs is a project with no steps, and that is a real answer.
#
# An example of what one looks like, for when there is something to build:
#
#   STEPS="docs_index"
#
# with scripts/docs_index.sh holding
#
#   set -eu
#   cd "$(dirname "$0")/.."
#   OUT=assets/docs-db
#
#   if [ "${FORCE:-0}" = 0 ] && zen rag docs ready --dir "$OUT" --quiet; then
#       echo "$OUT is already built"
#       exit 3
#   fi
#   if [ "${CHECK:-0}" = 1 ]; then
#       # Without --quiet it names what is missing and the command that fixes
#       # it; `|| true` because not-ready is the exit code we came for.
#       zen rag docs ready --dir "$OUT" || true
#       exit 4
#   fi
#   # Committed index, git-ignored vectors: re-embed from the copies the index
#   # already holds rather than indexing the documents over again.
#   if [ "${FORCE:-0}" = 0 ] && [ -f "$OUT/manifest.json" ]; then
#       zen rag docs restore --dir "$OUT"
#       exit 0
#   fi
#   rm -rf .tmp/docs-db
#   zen rag docs index assets/docs \
#       --embedding openai/text-embedding-3-small --out .tmp/docs-db
#   rm -rf "$OUT"
#   mv .tmp/docs-db "$OUT"
#
STEPS=""

if [ -z "$STEPS" ]; then
    echo "nothing to set up — this project builds nothing before it runs"
    exit 0
fi

mkdir -p "$LOGS"
summary=""
failed=0
pending=0

for name in $STEPS; do
    # A dry run keeps its own log: overwriting the build's would lose the
    # record of the build to a question about it.
    if [ "$CHECK" = 1 ]; then
        log="$LOGS/check-$name.log"
    else
        log="$LOGS/setup-$name.log"
    fi
    echo
    echo "-- $name  $(date '+%H:%M:%S')  ($log)"

    # Watched rather than waited on: the output goes to the screen and to its
    # own log at once, so a long step can be followed from either.
    set +e
    "scripts/$name.sh" 2>&1 | tee "$log"
    code=${PIPESTATUS[0]}
    set -e

    case "$code" in
        0) word=ok ;;
        3) word=skipped ;;
        4)
            word="needs setup"
            pending=1
            ;;
        *)
            word="failed ($code)"
            failed=1
            ;;
    esac
    summary="${summary}  ${name}: ${word}
"
    # Later steps depend on earlier ones, so a failure stops rather than
    # producing a second failure that is only a consequence of the first.
    # `needs setup` does not stop it: the point of asking is the whole list.
    if [ "$failed" = 1 ]; then
        break
    fi
done

echo
if [ "$CHECK" = 1 ]; then
    echo "setup check:"
else
    echo "setup:"
fi
printf '%s' "$summary"
if [ "$failed" = 1 ] || [ "$pending" = 1 ]; then
    exit 1
fi
exit 0
