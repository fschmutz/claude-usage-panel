#!/usr/bin/env bash
# Bump the project version in every place that carries it, from a single source
# of truth, so they can never drift. The places are listed once, in
# scripts/version-sites.sh (package.json, the GNOME metadata, the plugin and
# marketplace manifests, the MCP server's VERSION const, the Homebrew cask,
# the plugin's npx spec pinned to the release tag);
# CHANGELOG.md gets a dated section above a fresh [Unreleased].
#
# Usage:  scripts/bump-version.sh 1.4.0
# It only edits files; nothing is committed or pushed. Releases go through
# scripts/release.sh, which calls this.
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
echo "Bumped to $V. This only edits files: scripts/release.sh is what commits,"
echo "pushes, waits for ci-gate on the release commit and only then tags it."
