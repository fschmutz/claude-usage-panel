#!/usr/bin/env bash
# Point Casks/claude-usage-panel.rb at a release: its version and the sha256 of
# the ClaudeUsagePanel-macos.zip attached to it.
#
#   scripts/make-cask.sh                 the version in package.json, zip downloaded from the release
#   scripts/make-cask.sh v2.2.0          that tag
#   scripts/make-cask.sh v2.2.0 path.zip that tag, checksum of a local zip (what CI has just built)
#   scripts/make-cask.sh --check         fail if the file does not match package.json (CI/pre-commit)
#
# The release workflow runs it right after uploading the zip and attaches the
# rewritten .rb to the same release, so `brew install --cask <url to the .rb>`
# works with no tap. Committing the result is optional: the file in the repo is
# the template and the release asset is the pinned one.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CASK="$ROOT/Casks/claude-usage-panel.rb"
ZIP_NAME="ClaudeUsagePanel-macos.zip"

version_of() { sed -nE 's/.*"version": *"([^"]+)".*/\1/p' "$ROOT/package.json" | head -1; }
cask_version() { sed -nE 's/^  version "([^"]+)".*/\1/p' "$CASK" | head -1; }

if [ "${1:-}" = "--check" ]; then
    want="$(version_of)"
    have="$(cask_version)"
    if [ "$have" != "$want" ]; then
        echo "make-cask: Casks/claude-usage-panel.rb is v$have, package.json is v$want" >&2
        echo "           run scripts/bump-version.sh (it owns every version site)" >&2
        exit 1
    fi
    grep -q "releases/download/v#{version}/$ZIP_NAME" "$CASK" || {
        echo "make-cask: the cask url no longer points at $ZIP_NAME" >&2
        exit 1
    }
    exit 0
fi

tag="${1:-v$(version_of)}"
zip="${2:-}"
version="${tag#v}"

tmp=""
if [ -z "$zip" ]; then
    command -v gh >/dev/null || {
        echo "make-cask: need the gh CLI to download the release asset (or pass the zip)" >&2
        exit 1
    }
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    gh release download "$tag" --pattern "$ZIP_NAME" --dir "$tmp" >/dev/null
    zip="$tmp/$ZIP_NAME"
fi
[ -f "$zip" ] || {
    echo "make-cask: no such zip: $zip" >&2
    exit 1
}

# shasum is on macOS and on the GitHub Linux runners; sha256sum is not on macOS.
if command -v shasum >/dev/null; then
    sum="$(shasum -a 256 "$zip" | cut -d' ' -f1)"
else
    sum="$(sha256sum "$zip" | cut -d' ' -f1)"
fi

V="$version" perl -pi -e 's/^(  version ")[^"]*(")/${1}$ENV{V}${2}/' "$CASK"
S="$sum" perl -pi -e 's/^(  sha256 ).*/${1}"$ENV{S}"/' "$CASK"

echo "make-cask: $CASK -> v$version, sha256 $sum"
