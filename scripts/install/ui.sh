# shellcheck shell=bash
# Sourced by install.sh: output helpers, the --dry-run switch, the options the
# argument loop fills in, and the small utilities every target shares.

# ── Single source of truth for the version (used by the macOS bundle). ──────────
version() {
    sed -nE 's/.*"version": *"([^"]+)".*/\1/p' "$ROOT/package.json" | head -1
}

info() { printf '\033[1m%s\033[0m\n' "$*"; }
skip() { printf '  \033[33mskip\033[0m %s\n' "$*"; }
ok() { printf '  \033[32mok\033[0m   %s\n' "$*"; }

# --dry-run: print each mutating action instead of doing it. Read-only probes
# (command -v, gsettings get, uname) always run. `act` wraps a plain command;
# anything more involved is guarded inline with `$DRY`.
DRY=false
# The option state: install.sh's argument loop writes these, the target files
# sourced next to this one read them. shellcheck checks one file at a time and
# cannot see who sources whom, so each cross-file read looks unused - hence a
# named exemption per line rather than a blanket one for the file.
# shellcheck disable=SC2034  # read by install.sh
PULL=false
# shellcheck disable=SC2034  # read by macos.sh (CI builds with it)
BUILD_ONLY=false
# shellcheck disable=SC2034  # read by node.sh
SL_SEGMENTS="context,limits,tokens,ping"
# shellcheck disable=SC2034  # read by node.sh
SL_TOKENS="all"
# shellcheck disable=SC2034  # read by sessionping.sh
SP_TIMES=()
# shellcheck disable=SC2034  # read by sessionping.sh
SP_DAYS=""

act() {
    if $DRY; then printf '  would: %s\n' "$*"; else "$@"; fi
}

# Append each non-empty output line of a command to the named array. Written
# this way, and not with mapfile, because the stock macOS bash is 3.2, where
# mapfile does not exist - a mapfile in the bare install path once failed on
# every Mac that had not installed a newer bash.
_lines_into() { # ARRAY_NAME COMMAND [ARGS...]
    local __name="$1" __line
    shift
    while IFS= read -r __line; do
        if [ -n "$__line" ]; then
            eval "$__name+=(\"\$__line\")"
        fi
    done < <("$@")
}

# One JSON editor for every settings/config merge (get | set | set-string |
# delete | encode - see scripts/json-edit.mjs). Node is a prerequisite of every
# target that needs it, checked by that target before its first call.
_json() {
    node "$ROOT/scripts/json-edit.mjs" "$@"
}

# The status-line command is OURS when it points at either the installed tree
# or the pre-1.11 loose copy - the one place this test is spelled out.
# shellcheck disable=SC2034  # read by node.sh (both the install and the uninstall path)
SL_OURS_RE='claude-usage-panel/claude-code/statusline\.js|claude-usage-statusline\.mjs'
