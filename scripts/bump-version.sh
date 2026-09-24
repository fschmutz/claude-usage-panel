#!/usr/bin/env bash
# Bump the project version in every place that carries it, from a single source
# of truth, so they can never drift. The places are listed once, in
# scripts/version-sites.sh (package.json, the GNOME metadata, the plugin and
# marketplace manifests, the MCP server's VERSION const, the Homebrew cask,
# the plugin's npx spec pinned to the release tag);
# CHANGELOG.md gets a dated section above a fresh [Unreleased].
#
# Usage:  scripts/bump-version.sh 1.4.0
# It only edits files - review the diff, then commit. Nothing is pushed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# shellcheck source=version-sites.sh
. "$ROOT/scripts/version-sites.sh"

V="${1:-}"
if ! [[ "$V" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Usage: scripts/bump-version.sh <major.minor.patch>   e.g. 1.4.0" >&2
    exit 2
fi
DATE="$(date +%F)"

for site in "${VERSION_SITES[@]}"; do
    IFS='|' read -r file kind key <<<"$site"
    version_site_write "$file" "$kind" "$key" "$V"
    echo "  $file → $V"
done

# CHANGELOG: turn the top [Unreleased] into a dated release, above a fresh one.
V="$V" DATE="$DATE" perl -pi -e '
  if (!$seen && /^## \[Unreleased\]/) {
    $_ .= "\n## [$ENV{V}] - $ENV{DATE}\n";
    $seen = 1;
  }' CHANGELOG.md
echo "  CHANGELOG.md → ## [$V] - $DATE (with a fresh [Unreleased])"

echo
echo "Bumped to $V. Review the diff, then commit + tag (the tag push triggers"
echo "the release workflow, which builds the zip and creates the GitHub Release)."
echo "Push the tag right behind the commit: plugin/.mcp.json now names v$V, and"
echo "the plugin cannot install until that tag exists on origin:"
echo "  git -C \"$ROOT\" add -A && git -C \"$ROOT\" commit -m \"chore(release): v$V\""
echo "  git -C \"$ROOT\" tag v$V && git -C \"$ROOT\" push-confirm && git -C \"$ROOT\" push-confirm --tags"
