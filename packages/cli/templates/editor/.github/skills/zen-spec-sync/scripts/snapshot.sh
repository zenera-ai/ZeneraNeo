#!/usr/bin/env bash
#
# The committed record of what the last completed /spec-sync-project pass applied.
#
#   snapshot.sh status    full | incremental | tampered, and what differs
#   snapshot.sh diff      the difference the next pass has to work
#   snapshot.sh record    write a history entry, without moving the baseline
#   snapshot.sh commit    move the baseline on, once the pass has finished
#
# Run it from anywhere; it finds the project root from its own location, which
# `zen init` and `zen open` fix. The baseline is written last and only last —
# see .github/skills/zen-spec-sync/SKILL.md for why that is the whole point.

set -eu
cd "$(dirname "$0")/../../../.."

STATE=.spec-sync
BASE="$STATE/baseline"
HISTORY="$STATE/history"
MANIFEST="$BASE/manifest.txt"
SCRATCH=.tmp/spec-sync

# The intent: what the project is meant to be, and what was asked back about it.
INTENT="SPECIFICATION.md SPECIFICATION-FEEDBACK.md"

# The implementation: the wiring, and every instruction, prompt and skill file
# under agents/. One of those edited since the last pass is a change the pass
# has to account for, the same as a changed requirement is.
WIRING=agents.yaml
TREE=agents

# The history entry this baseline belongs to, hashed like the rest of it.
APPLIED=applied.txt

if [ ! -f "$WIRING" ] && [ ! -f SPECIFICATION.md ]; then
    echo "snapshot.sh: no agents.yaml or SPECIFICATION.md in $PWD" >&2
    exit 2
fi

# Git cannot carry an empty directory, so these are made rather than expected.
mkdir -p "$BASE" "$HISTORY"

# Every path the record covers, on the working-tree side.
present() {
    {
        for file in $INTENT $WIRING; do
            if [ -f "$file" ]; then echo "$file"; fi
        done
        if [ -d "$TREE" ]; then find "$TREE" -type f ! -name .DS_Store; fi
    } | sort -u
}

# The same, from both sides, so a file added or deleted since the last pass is
# a difference rather than a path nobody walks.
scope() {
    {
        present
        for file in $INTENT $WIRING; do
            if [ -f "$BASE/$file" ]; then echo "$file"; fi
        done
        if [ -d "$BASE/$TREE" ]; then
            (cd "$BASE" && find "$TREE" -type f ! -name .DS_Store)
        fi
    } | sort -u
}

# A file that is not there counts as an empty one, so adding or deleting it
# reads as a difference rather than as an error.
side() {
    if [ -f "$1" ]; then echo "$1"; else echo /dev/null; fi
}

differs() {
    ! cmp -s "$(side "$BASE/$1")" "$(side "$1")"
}

owned() {
    case "$1" in
        agents/a2ui-instructions.md|agents/skills/a2ui/SKILL.md|agents/skills/a2ui_charts/SKILL.md|agents/files-instructions.md|agents/fork-instructions.md|agents/markdown-instructions.md|agents/mcp-instructions.md|agents/mcp-memory-instructions.md|agents/memory-instructions.md|agents/tools-instructions.md) return 0 ;;
        *) return 1 ;;
    esac
}

# Which baseline files no longer hash to what the manifest says they do.
# `FAILED` covers a changed file; `FAILED open or read` covers a missing one.
broken() {
    (cd "$BASE" && shasum -a 256 -c manifest.txt 2>/dev/null || true) |
        sed -n 's/: FAILED.*$//p'
}

# The stamps sort chronologically by name, which is the point of the format —
# an mtime would make a fast pass look like no pass at all.
newest() {
    ls "$HISTORY"/*.md 2>/dev/null | sort | tail -1 || true
}

status() {
    if [ ! -f "$MANIFEST" ]; then
        echo "mode: full"
        echo "reason: no baseline, so no pass has ever completed here"
        return 0
    fi
    failed="$(broken)"
    if [ -n "$failed" ]; then
        echo "mode: tampered"
        while IFS= read -r file; do
            if [ -n "$file" ]; then echo "unsound: $BASE/$file"; fi
        done <<EOF
$failed
EOF
        echo "reason: the baseline does not match its own manifest"
        return 0
    fi
    echo "mode: incremental"
    if [ -f "$BASE/$APPLIED" ]; then
        echo "applied: $(cat "$BASE/$APPLIED")"
    fi
    while IFS= read -r file; do
        if [ -n "$file" ] && differs "$file"; then
            if owned "$file"; then
                echo "maintenance: $file"
            else
                echo "changed: $file"
            fi
        fi
    done <<EOF
$(scope)
EOF
}

show_diff() {
    while IFS= read -r file; do
        if [ -n "$file" ] && differs "$file"; then
            diff -u -L "baseline/$file" -L "$file" \
                "$(side "$BASE/$file")" "$(side "$file")" || true
        fi
    done <<EOF
$(scope)
EOF
}

record() {
    mode=""
    scope_text=""
    changed_text=""
    feedback_text=""
    open_text=""
    checks_text=""
    while [ "$#" -gt 0 ]; do
        if [ "$#" -lt 2 ] || [ -z "$2" ]; then
            echo "snapshot.sh record: every option needs a non-empty value" >&2
            return 2
        fi
        case "$1" in
            --mode)
                case "$2" in
                    full|incremental) mode="$2" ;;
                    *) echo "snapshot.sh record: mode must be full or incremental" >&2; return 2 ;;
                esac
                ;;
            --scope) scope_text="$scope_text- $2
" ;;
            --changed) changed_text="$changed_text- $2
" ;;
            --feedback) feedback_text="$feedback_text- $2
" ;;
            --still-open) open_text="$open_text- $2
" ;;
            --checks) checks_text="$checks_text- $2
" ;;
            *) echo "snapshot.sh record: unknown option $1" >&2; return 2 ;;
        esac
        shift 2
    done
    if [ -z "$mode" ] || [ -z "$scope_text" ] || [ -z "$changed_text" ] ||
        [ -z "$feedback_text" ] || [ -z "$open_text" ] || [ -z "$checks_text" ]; then
        echo "usage: snapshot.sh record --mode full|incremental --scope <text> --changed <text> --feedback <text> --still-open <text> --checks <text> (repeat sections as needed; use 'None' explicitly)" >&2
        return 2
    fi
    if [ ! -f SPECIFICATION.md ]; then
        echo "snapshot.sh record: SPECIFICATION.md is missing" >&2
        return 1
    fi
    spec_sum="$(shasum -a 256 SPECIFICATION.md)"
    spec_sha="${spec_sum%% *}"
    stamp="$(date -u +%Y-%m-%dT%H%M%SZ)"
    entry="$HISTORY/$stamp.md"
    draft="$(mktemp "$HISTORY/.record.XXXXXX")"
    trap 'rm -f "$draft"' EXIT
    {
        printf '# Sync pass %s\n\n' "$stamp"
        printf -- '- **Mode** - %s\n- **Spec sha** - %s\n' "$mode" "$spec_sha"
        printf '\n## Scope\n\n%s' "$scope_text"
        printf '\n## Changed\n\n%s' "$changed_text"
        printf '\n## Feedback\n\n%s' "$feedback_text"
        printf '\n## Still open\n\n%s' "$open_text"
        printf '\n## Checks\n\n%s' "$checks_text"
    } >"$draft"
    # Linking refuses to replace an existing entry, even within the same second.
    if ! ln "$draft" "$entry"; then
        echo "snapshot.sh record: could not create $entry; no entry was overwritten" >&2
        return 1
    fi
    rm -f "$draft"
    trap - EXIT
    echo "history: $entry"
    echo "baseline: unchanged (run snapshot.sh commit only after verification)"
}

commit() {
    entry="$(newest)"
    if [ -z "$entry" ]; then
        echo "snapshot.sh: write $HISTORY/<stamp>.md before moving the baseline" >&2
        exit 1
    fi
    stamp="$(basename "$entry" .md)"
    if [ -f "$BASE/$APPLIED" ] && [ "$stamp" = "$(cat "$BASE/$APPLIED")" ]; then
        echo "snapshot.sh: the baseline already names $stamp — this pass wrote no entry" >&2
        exit 1
    fi

    staged="$(present)"
    rm -rf "$SCRATCH"
    mkdir -p "$SCRATCH"
    echo "$stamp" >"$SCRATCH/$APPLIED"
    : >"$SCRATCH/manifest.txt"
    while IFS= read -r file; do
        if [ -n "$file" ]; then
            mkdir -p "$SCRATCH/$(dirname "$file")"
            cp "$file" "$SCRATCH/$file"
        fi
    done <<EOF
$staged
EOF
    while IFS= read -r file; do
        if [ -n "$file" ]; then
            (cd "$SCRATCH" && shasum -a 256 "$file") >>"$SCRATCH/manifest.txt"
        fi
    done <<EOF
$APPLIED
$staged
EOF

    while IFS= read -r file; do
        if [ -n "$file" ]; then
            mkdir -p "$BASE/$(dirname "$file")"
            mv "$SCRATCH/$file" "$BASE/$file"
        fi
    done <<EOF
$APPLIED
$staged
EOF
    # Everything in scope that still exists has just been staged, so a baseline
    # file with no working copy is one this pass deleted.
    while IFS= read -r file; do
        if [ -n "$file" ] && [ "$file" != "$APPLIED" ] && [ ! -f "$file" ]; then
            rm -f "$BASE/$file"
        fi
    done <<EOF
$(cd "$BASE" && find . -type f ! -name manifest.txt | sed 's|^\./||')
EOF
    find "$BASE" -mindepth 1 -type d -empty -delete
    # Last, so an interrupted commit leaves a baseline that reports itself as
    # tampered rather than one that claims a pass it never finished.
    mv "$SCRATCH/manifest.txt" "$MANIFEST"
    rm -rf "$SCRATCH"

    echo "applied: $stamp"
    echo "recorded: $(printf '%s\n' "$staged" | sed '/^$/d' | wc -l | tr -d ' ') files"
}

case "${1:-status}" in
    status) status ;;
    diff) show_diff ;;
    record) shift; record "$@" ;;
    commit) commit ;;
    *)
        echo "usage: snapshot.sh [status|diff|record|commit]" >&2
        exit 2
        ;;
esac
