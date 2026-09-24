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

# A skip that means THE TARGET WAS NOT INSTALLED - a missing node, no Swift, no
# scheduler - as opposed to an optional extra that was not there (no Cursor to
# register with). On `update` every target in the set is one the machine
# already has, so a skip of this kind is a failed reinstall: install.sh exits
# non-zero at the end, and the caller (scripts/auto-update.sh) then does not
# stamp the new version and retries on its next run. Before this, a scheduled
# update with no node on PATH dropped the status line, the MCP server and the
# CLI, exited 0, and recorded the release as installed.
#
# install.sh runs each target in a subshell of its own (so one target that
# fails hard cannot take the rest of the run down with it), and a variable set
# in a subshell dies with it. The record therefore has exactly one channel:
# INCOMPLETE_LOG, a file install.sh creates before the loop and turns into
# INCOMPLETE after it. With no log there is nowhere the record could survive,
# so skip_fatal fails instead of dropping it.
# shellcheck disable=SC2034  # install.sh fills INCOMPLETE from the log after the target loop
INCOMPLETE=""
INCOMPLETE_LOG=""
skip_fatal() {
    if [ -z "$INCOMPLETE_LOG" ]; then
        echo "install: skip_fatal called with no INCOMPLETE_LOG, the record would be lost: $*" >&2
        return 1
    fi
    printf '  %s\n' "$*" >>"$INCOMPLETE_LOG"
    skip "$*"
}

# Where the update worker keeps its state, and the two facts only the
# installer can record:
#   installed-version  what the CLIENTS now run. Written here, after a
#                      successful run, so a manual `./install.sh update`, the
#                      curl bootstrap and a fresh install all move it - not
#                      only the daily job. When only the daily job wrote it,
#                      every other path left it absent or stale, and the whole
#                      update decision reads it.
#   checkout-path      where this checkout is. The GNOME extension's copy of
#                      auto-update.sh and the macOS app live outside it and
#                      used to find it only through an installed schedule, so
#                      opting out of autoupdate hid the checkout from both.
_state_dir() { echo "${XDG_STATE_HOME:-$HOME/.local/state}/claude-usage-panel"; }

record_install_state() {
    local dir
    dir="$(_state_dir)"
    if $DRY; then
        echo "  would: record $(version) + $ROOT in $dir"
        return 0
    fi
    mkdir -p "$dir" 2>/dev/null || return 0
    printf '%s\n' "$(version)" >"$dir/installed-version" 2>/dev/null || true
    printf '%s\n' "$ROOT" >"$dir/checkout-path" 2>/dev/null || true
    # Whatever reinstall was owed has just been done.
    rm -f "$dir/update-pending" 2>/dev/null || true
}

forget_install_state() {
    local dir
    dir="$(_state_dir)"
    if $DRY; then
        echo "  would: drop the version stamp and checkout pointer in $dir"
        return 0
    fi
    rm -f "$dir/installed-version" "$dir/checkout-path" "$dir/update-pending" \
        2>/dev/null || true
}

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
# Did THIS invocation choose them? If not, a reinstall keeps whatever the
# installed status line already uses: `update` runs with no flags, and
# re-baking the defaults silently reset every customised status line on every
# update.
# shellcheck disable=SC2034  # read by node.sh
SL_SEGMENTS_SET=false
# shellcheck disable=SC2034  # read by node.sh
SL_TOKENS_SET=false
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
