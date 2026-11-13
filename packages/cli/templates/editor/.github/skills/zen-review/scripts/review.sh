#!/usr/bin/env bash
#
# Every check a review can make without judgement, in the order it makes them.
#
#   review.sh fast           seconds, offline: `zen check --no-models --no-sandbox`,
#                            the path sweep, the setup dry run, the sandbox hint
#   review.sh slow [--fix]   minutes: the full `zen check` alone - sandbox image
#                            build and model probes - saved as a receipt
#   review.sh                both halves in one blocking go
#   review.sh check [full|no-sandbox|fast] [--fix]   check and save a receipt
#   review.sh --skip-check [full|no-sandbox|fast]   verify and reuse that receipt
#
# What it prints is findings, each with the command that addresses it. What it
# cannot see - whether an agent has one job, whether a description is a
# condition, whether a fact belongs in a skill - is the judgement half of the
# zen-review skill.
#
# Every step runs even when an earlier one fails: a review that stops at the
# first problem is one somebody has to run twice. The exit code is 1 if
# anything wants attention, 0 if nothing does.
#
# Run it from anywhere; it finds the project root from its own location.

set -u
cd "$(dirname "$0")/../../../.."

SKILLS=.github/skills
CHECK_FLAGS=""
REUSE=0
RECEIPT="$SKILLS/zen-review/scripts/check-receipt.mjs"

if [ "${1:-}" = check ]; then
    shift
    if [ "${1:-}" = --fix ]; then
        set -- full "$@"
    fi
    exec node "$RECEIPT" run "$@"
fi
if [ "${1:-}" = slow ]; then
    shift
    if [ "$#" -gt 1 ] || { [ "$#" -eq 1 ] && [ "$1" != --fix ]; }; then
        echo "usage: review.sh slow [--fix]" >&2
        exit 2
    fi
    echo "review.sh slow: building the sandbox image and probing every model - this can take several minutes" >&2
    printf '\n--- zen check %s(sandbox build + model probes) ---\n' "${1:+$1 }"
    exec node "$RECEIPT" run full "$@"
fi
if [ "${1:-}" = --skip-check ]; then
    REUSE=1
    shift
fi

case "${1:-full}" in
    full) ;;
    no-sandbox) CHECK_FLAGS="--no-sandbox" ;;
    fast) CHECK_FLAGS="--no-models --no-sandbox" ;;
    *)
        echo "usage: review.sh [fast|slow [--fix]|full] | [check|--skip-check] [full|no-sandbox|fast] [--fix (check only)]" >&2
        exit 2
        ;;
esac
if [ "$#" -gt 1 ]; then
    echo "review.sh: unexpected arguments" >&2
    exit 2
fi

SUMMARY=""
WORST=0

# Records one step's verdict for the summary, and remembers the worst of them.
verdict() {
    SUMMARY="$SUMMARY$1: $2
"
    if [ "$3" -ne 0 ]; then
        WORST=1
    fi
}

step() {
    printf '\n--- %s ---\n' "$1"
}

CHECK_CMD="zen check${CHECK_FLAGS:+ $CHECK_FLAGS}"
step "$CHECK_CMD"
if [ "$REUSE" -eq 1 ]; then
    node "$RECEIPT" verify "${1:-full}"
    rc=$?
    verdict "$CHECK_CMD" "receipt exit $rc" "$rc"
elif command -v zen >/dev/null 2>&1; then
    # Unquoted on purpose: empty means no flags rather than one empty argument.
    # shellcheck disable=SC2086
    zen check $CHECK_FLAGS
    rc=$?
    if [ "$rc" -eq 0 ]; then
        verdict "$CHECK_CMD" 'ok' 0
    else
        verdict "$CHECK_CMD" "exit $rc - nothing below matters until this passes" 1
    fi
else
    echo "zen is not on PATH - install it, or run check-paths.sh alone"
    verdict "$CHECK_CMD" 'not run' 1
fi

step 'paths (check-paths.sh)'
"$SKILLS/zen-review/scripts/check-paths.sh"
rc=$?
if [ "$rc" -eq 0 ]; then
    verdict 'paths' 'ok' 0
else
    verdict 'paths' 'candidates to explain or fix' 1
fi

step 'setup (scripts/_setup.sh --check)'
if [ -f scripts/_setup.sh ]; then
    bash scripts/_setup.sh --check
    rc=$?
    if [ "$rc" -eq 0 ]; then
        verdict 'setup' 'ok' 0
    else
        verdict 'setup' 'not done - run scripts/_setup.sh to build what is missing (indexes, generated files)' 1
    fi
else
    echo "no scripts/_setup.sh - this project builds nothing before it runs"
    verdict 'setup' 'not applicable' 0
fi

step 'sandbox (changes since the last commit)'
if [ -d sandbox ] && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    changed="$(git status --porcelain -- sandbox 2>/dev/null)"
    if [ -n "$changed" ]; then
        printf '%s\n' "$changed"
        # A hint, not a failure: the files may be fine, the image is what is behind.
        verdict 'sandbox' 'sandbox/ changed - run review.sh slow to prove it builds, then zen sandbox pull to rebuild the image runs use' 0
    else
        echo "sandbox/ unchanged since the last commit"
        verdict 'sandbox' 'unchanged' 0
    fi
else
    echo "no sandbox/ under version control - nothing to compare"
    verdict 'sandbox' 'not applicable' 0
fi

step 'summary'
printf '%s' "$SUMMARY"
exit "$WORST"
