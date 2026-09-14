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
PULL=false
BUILD_ONLY=false                         # macos: build the .app but don't install to /Applications (used by CI)
SL_SEGMENTS="context,limits,tokens,ping" # statusline: which segments, left→right
SL_TOKENS="all"                          # statusline: token-total mode (all|fresh)
SP_TIMES=()                              # sessionping: HH:MM args from the command line
SP_DAYS=""                               # sessionping: --days= value from the command line
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
SL_OURS_RE='claude-usage-panel/claude-code/statusline\.js|claude-usage-statusline\.mjs'
