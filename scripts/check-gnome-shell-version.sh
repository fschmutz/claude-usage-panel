#!/usr/bin/env bash
# Fail when GNOME has shipped a stable major that metadata.json does not list.
#
#   scripts/check-gnome-shell-version.sh                  ask the GitHub API
#   scripts/check-gnome-shell-version.sh --refs-file F    read a saved answer
#                                                         (tests, offline runs)
#
# GNOME Shell refuses to load an extension whose `shell-version` does not name
# the running major, so a new release silently disables the panel for every
# user who upgrades until someone adds the number. Nothing in this repo
# changes when that happens, which is why this runs on a weekly schedule (the
# gnome-shell workflow) and not only when metadata.json is edited.
#
# "Stable" is a tag of the form <major>.<minor> (49.0, 49.2). 50.alpha,
# 50.beta and 50.rc are pre-releases and never count: an extension should not
# claim a shell nobody has shipped yet.
#
# The source is GET /repos/GNOME/gnome-shell/git/matching-refs/tags/ (the
# official mirror of gitlab.gnome.org). It returns every tag in one unpaginated
# array, so the answer never depends on page order. Read through `gh api` so
# the runner's token lifts the anonymous rate limit without ever landing in
# argv; plain curl is the fallback when gh is absent.
#
# Exit: 0 metadata.json is current, 1 a newer stable major is out,
#       2 usage error or no answer from upstream (never a silent pass).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
META="${GNOME_SHELL_METADATA:-$ROOT/claude-usage-panel@fschmutz.github.io/metadata.json}"
API_PATH="repos/GNOME/gnome-shell/git/matching-refs/tags/"

usage() {
    echo "Usage: scripts/check-gnome-shell-version.sh [--refs-file FILE]" >&2
    exit 2
}

refs_file=""
case "${1:-}" in
    "") ;;
    --refs-file)
        refs_file="${2:-}"
        [ -n "$refs_file" ] || usage
        ;;
    *) usage ;;
esac

[ -f "$META" ] || {
    echo "check-gnome-shell-version: no metadata.json at $META" >&2
    exit 2
}

# The highest major metadata.json claims. The array is one line or several;
# flattening first makes both shapes the same.
supported="$(tr -d '\n' <"$META" | sed -nE 's/.*"shell-version" *: *\[([^]]*)\].*/\1/p' |
    grep -oE '"[0-9]+(\.[0-9]+)?"' | tr -d '"' | cut -d. -f1 | sort -n | tail -1 || true)"
[ -n "$supported" ] || {
    echo "check-gnome-shell-version: no shell-version in $META" >&2
    exit 2
}

if [ -n "$refs_file" ]; then
    refs="$(cat "$refs_file")"
elif command -v gh >/dev/null; then
    refs="$(gh api "$API_PATH")"
else
    refs="$(curl -fsSL -H 'Accept: application/vnd.github+json' "https://api.github.com/$API_PATH")"
fi

# Stable tags only: refs/tags/<major>.<minor>, nothing after the minor.
latest="$(printf '%s\n' "$refs" | grep -oE '"ref" *: *"refs/tags/[0-9]+\.[0-9]+"' |
    sed -E 's/.*refs\/tags\/([0-9]+)\..*/\1/' | sort -n | tail -1 || true)"
[ -n "$latest" ] || {
    echo "check-gnome-shell-version: no stable gnome-shell tag in the upstream answer" >&2
    exit 2
}

if [ "$latest" -gt "$supported" ]; then
    echo "::error::GNOME Shell $latest is out; metadata.json shell-version stops at $supported." >&2
    echo "  Test the extension on $latest, then add \"$latest\" to shell-version in" >&2
    echo "  claude-usage-panel@fschmutz.github.io/metadata.json." >&2
    exit 1
fi
echo "check-gnome-shell-version: newest stable GNOME Shell is $latest, metadata.json covers up to $supported."
