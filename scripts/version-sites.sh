# shellcheck shell=bash
# Every place the project version is written, in one list - sourced by
# scripts/bump-version.sh (writes them) and scripts/check-versions.sh (reads
# them and compares against package.json, the source of truth). A new site is
# one line here and is then bumped and checked for free.
#
# Entry format: FILE|KIND|KEY
#   json     "KEY": "x.y.z"            (first such key in the file)
#   jsconst  export const KEY = 'x.y.z';
#   cask       version "x.y.z"         (the Homebrew cask example, 2-space indent)

VERSION_SITES=(
    "package.json|json|version"
    "claude-usage-panel@fschmutz.github.io/metadata.json|json|version-name"
    "plugin/.claude-plugin/plugin.json|json|version"
    ".claude-plugin/marketplace.json|json|version"
    "mcp/server.js|jsconst|VERSION"
    "PUBLISHING.md|cask|version"
)

# Print the version at one site (empty when the pattern is not found).
version_site_read() { # FILE KIND KEY
    case "$2" in
        json) sed -nE 's/.*"'"$3"'": *"([^"]+)".*/\1/p' "$1" | head -1 ;;
        jsconst) sed -nE "s/^export const $3 = '([^']+)';.*/\1/p" "$1" | head -1 ;;
        cask) sed -nE 's/^  '"$3"' "([0-9]+\.[0-9]+\.[0-9]+)".*/\1/p' "$1" | head -1 ;;
    esac
}

# Rewrite the version at one site in place, touching nothing else in the file.
version_site_write() { # FILE KIND KEY NEW
    case "$2" in
        json) V="$4" perl -pi -e 's/("'"$3"'"\s*:\s*")\d+\.\d+\.\d+(")/${1}$ENV{V}${2}/' "$1" ;;
        jsconst) V="$4" perl -pi -e "s/(^export const $3 = ')\\d+\\.\\d+\\.\\d+(';)/\${1}\$ENV{V}\${2}/" "$1" ;;
        cask) V="$4" perl -pi -e 's/^(  '"$3"' ")\d+\.\d+\.\d+(")/${1}$ENV{V}${2}/' "$1" ;;
    esac
}
