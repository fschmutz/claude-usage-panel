# shellcheck shell=bash
# Every place the project version is written, in one list - sourced by
# scripts/bump-version.sh (writes them) and scripts/check-versions.sh (reads
# them and compares against package.json, the source of truth). A new site is
# one line here and is then bumped and checked for free.
#
# Entry format: FILE|KIND|KEY
#   json     "KEY": "x.y.z"            (first such key in the file)
#   jsconst  export const KEY = 'x.y.z';
#   cask       version "x.y.z"         (the Homebrew cask, 2-space indent)
#   npxref   "KEY#vx.y.z"              (an npx package spec pinned to the release
#                                      tag, so the plugin runs the release its
#                                      manifest names and never main's tip)
#   npxpin   KEY#vx.y.z                (the same spec in prose: EVERY occurrence
#                                      of KEY in the file, quoted or not, carries
#                                      the pin; a bare one reads as a mismatch,
#                                      so a documented install never runs main)

# shellcheck disable=SC2034  # read by bump-version.sh and check-versions.sh, which source this
VERSION_SITES=(
    "package.json|json|version"
    "claude-usage-panel@fschmutz.github.io/metadata.json|json|version-name"
    "plugin/.claude-plugin/plugin.json|json|version"
    ".claude-plugin/marketplace.json|json|version"
    "mcp/server.js|jsconst|VERSION"
    "Casks/claude-usage-panel.rb|cask|version"
    "plugin/.mcp.json|npxref|github:fschmutz/claude-usage-panel"
    "README.md|npxpin|github:fschmutz/claude-usage-panel"
    "mcp/README.md|npxpin|github:fschmutz/claude-usage-panel"
    "docs/index.html|npxpin|github:fschmutz/claude-usage-panel"
    "wiki/Installation.md|npxpin|github:fschmutz/claude-usage-panel"
    "wiki/MCP-Tool.md|npxpin|github:fschmutz/claude-usage-panel"
)

# Print the version at one site (empty when the pattern is not found).
version_site_read() { # FILE KIND KEY
    case "$2" in
        json) sed -nE 's/.*"'"$3"'": *"([^"]+)".*/\1/p' "$1" | head -1 ;;
        jsconst) sed -nE "s/^export const $3 = '([^']+)';.*/\1/p" "$1" | head -1 ;;
        cask) sed -nE 's/^  '"$3"' "([0-9]+\.[0-9]+\.[0-9]+)".*/\1/p' "$1" | head -1 ;;
        npxref) K="$3" perl -ne 'if (/"\Q$ENV{K}\E#v(\d+\.\d+\.\d+)"/) { print "$1\n"; exit }' "$1" ;;
        # One version when every occurrence carries the same pin; otherwise
        # every distinct form found ("bare" for an unpinned one), so the
        # mismatch names what is wrong.
        npxpin) K="$3" perl -0ne '
            my %seen = map { ($_ // "bare") => 1 } /\Q$ENV{K}\E(?:#v(\d+\.\d+\.\d+)|(?![\w#-]))/g;
            my @forms = sort keys %seen;
            print join(",", @forms), "\n" if @forms;
        ' "$1" ;;
    esac
}

# Rewrite the version at one site in place, touching nothing else in the file.
version_site_write() { # FILE KIND KEY NEW
    case "$2" in
        json) V="$4" perl -pi -e 's/("'"$3"'"\s*:\s*")\d+\.\d+\.\d+(")/${1}$ENV{V}${2}/' "$1" ;;
        jsconst) V="$4" perl -pi -e "s/(^export const $3 = ')\\d+\\.\\d+\\.\\d+(';)/\${1}\$ENV{V}\${2}/" "$1" ;;
        cask) V="$4" perl -pi -e 's/^(  '"$3"' ")\d+\.\d+\.\d+(")/${1}$ENV{V}${2}/' "$1" ;;
        npxref) K="$3" V="$4" perl -pi -e 's/("\Q$ENV{K}\E)(?:#v\d+\.\d+\.\d+)?(")/${1}#v$ENV{V}${2}/' "$1" ;;
        npxpin) K="$3" V="$4" perl -pi -e 's/(\Q$ENV{K}\E)(?:#v\d+\.\d+\.\d+|(?![\w#-]))/${1}#v$ENV{V}/g' "$1" ;;
    esac
}
