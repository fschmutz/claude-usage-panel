#!/usr/bin/env bash
# Fail when a private name - an internal project, a customer, a work address -
# is about to land in this PUBLIC repository.
#
#   scripts/check-private-names.sh FILE...           files (the pre-commit hook)
#   scripts/check-private-names.sh --message-file F  a commit message (commit-msg hook)
#   scripts/check-private-names.sh --all             tree + every commit's diff,
#                                                    message, author and committer (CI)
#
# The names themselves can not live here: a list of customers committed to a
# public repo would be the very leak it guards against. They live outside it,
# one extended regex per line (# comments, blank lines ignored), matched
# case-insensitively:
#
#   $CUP_PRIVATE_NAMES_FILE, else ${XDG_CONFIG_HOME:-~/.config}/claude-usage-panel/private-names.txt
#
# CI writes that file from the PRIVATE_NAMES secret. With no list the check is
# skipped - a contributor has none - unless CUP_PRIVATE_NAMES_REQUIRED=1, which
# CI sets on this repository so a missing secret fails instead of passing.
#
# A finding prints WHERE (file:line, commit id), never WHAT: CI logs are public.
set -euo pipefail

list="${CUP_PRIVATE_NAMES_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/claude-usage-panel/private-names.txt}"
if [ ! -s "$list" ]; then
    if [ "${CUP_PRIVATE_NAMES_REQUIRED:-0}" = 1 ]; then
        echo "private-names: no list at $list - required here (set the PRIVATE_NAMES secret)" >&2
        exit 1
    fi
    echo "private-names: no list at $list - skipped (only the maintainer has one)"
    exit 0
fi

# One alternation of every non-comment line.
pattern="$(grep -v -E '^[[:space:]]*(#|$)' "$list" | paste -sd'|' -)"
[ -n "$pattern" ] || {
    echo "private-names: $list has no patterns" >&2
    exit 1
}

found=0
hit() {
    echo "private-names: $1"
    found=1
}

# Files: report file:line only.
scan_files() {
    local f n
    for f in "$@"; do
        [ -f "$f" ] || continue
        while read -r n; do
            hit "$f:$n contains a private name"
        done < <(grep -I -n -i -E "$pattern" "$f" 2>/dev/null | cut -d: -f1 || true)
    done
}

case "${1:-}" in
    --message-file)
        [ -f "${2:-}" ] || {
            echo "usage: $0 --message-file FILE" >&2
            exit 2
        }
        # comment lines are git's own template, not the message
        if grep -v '^#' "$2" | grep -q -i -E "$pattern"; then
            hit "the commit message contains a private name"
        fi
        ;;
    --all)
        # not mapfile: bash 3.2 (macOS /bin/bash) has none
        while IFS= read -r f; do
            scan_files "$f"
        done < <(git ls-files)
        # every commit whose diff adds or removes a match
        while read -r sha; do
            hit "commit $sha: its diff contains a private name"
        done < <(git log --all -i -G "$pattern" --format=%h)
        while read -r sha; do
            hit "commit $sha: its message contains a private name"
        done < <(git log --all -i -E --grep="$pattern" --format=%h)
        while read -r sha who; do
            if printf '%s\n' "$who" | grep -q -i -E "$pattern"; then
                hit "commit $sha: its author or committer contains a private name"
            fi
        done < <(git log --all --format='%h %an <%ae> %cn <%ce>')
        ;;
    -h | --help)
        sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'
        exit 0
        ;;
    *)
        scan_files "$@"
        ;;
esac

if [ "$found" = 1 ]; then
    echo "private-names: replace them with neutral placeholders (my-app, example.com, ...)" >&2
    exit 1
fi
