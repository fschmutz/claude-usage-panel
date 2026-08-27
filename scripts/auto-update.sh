#!/usr/bin/env bash
# Daily update check for Claude Usage Panel.
#
#   scripts/auto-update.sh              check, and install a newer release if any
#   scripts/auto-update.sh --check      report only, install nothing (exit 10 = update available)
#   scripts/auto-update.sh --status     print local / latest / last check, then exit
#   scripts/auto-update.sh --status --json   same, machine-readable (the UIs parse this)
#   scripts/auto-update.sh --force      re-run the install even if already up to date
#   scripts/auto-update.sh --quiet      log only, no stdout (this is what the timer runs)
#
# Scheduled once a day by `./install.sh autoupdate` - a systemd user timer on
# Linux, a launchd agent on macOS, a cron line as fallback. Safe to run by hand
# at any time; a lock keeps two runs from overlapping.
#
# "Latest version" is the highest `vX.Y.Z` tag on the origin remote - i.e. a cut
# release, not whatever is on main right now. When one exists, the checkout is
# fast-forwarded and `install.sh update` reinstalls exactly the targets that are
# already installed (never adds new ones).
#
# It refuses to touch a checkout it does not own: a dirty worktree, a detached
# HEAD, a branch with no upstream, or a missing remote each make it skip with a
# message instead of moving anyone's work. Nothing here rebases, resets, stashes
# or force-pushes - the only git write is `merge --ff-only`.
#
# Exit codes: 0 = up to date / updated / skipped, 10 = update available
# (--check only), 1 = error, 2 = usage.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/claude-usage-panel"
LOG="$STATE_DIR/auto-update.log"
LOG_MAX_LINES=500
LOCK="$STATE_DIR/update.lock"

QUIET=false
FORCE=false
MODE=run # run | check | status
JSON=false

log() {
    mkdir -p "$STATE_DIR" 2>/dev/null || return 0
    printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >>"$LOG" 2>/dev/null || true
}

# Everything user-facing goes through say(): stdout unless --quiet, always the log.
say() {
    $QUIET || printf '%s\n' "$*"
    log "$*"
}

die() {
    printf 'auto-update: %s\n' "$*" >&2
    log "ERROR $*"
    exit 1
}

usage() {
    awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "$0"
}

# Compare two dotted versions; print 1 if $1 > $2, -1 if $1 < $2, else 0. A
# leading "v" and any -prerelease/+build suffix are ignored - only released
# X.Y.Z tags are ever fed to it (see latest_remote_version).
version_compare() {
    local a="${1#v}" b="${2#v}" i x y
    local -a pa pb
    IFS=. read -ra pa <<<"${a%%[-+]*}"
    IFS=. read -ra pb <<<"${b%%[-+]*}"
    for i in 0 1 2; do
        x="${pa[i]:-0}"
        y="${pb[i]:-0}"
        x="${x//[!0-9]/}"
        y="${y//[!0-9]/}"
        x="${x:-0}"
        y="${y:-0}"
        if ((10#$x > 10#$y)); then
            echo 1
            return 0
        fi
        if ((10#$x < 10#$y)); then
            echo -1
            return 0
        fi
    done
    echo 0
}

local_version() {
    sed -nE 's/.*"version": *"([^"]+)".*/\1/p' "$ROOT/package.json" | head -1
}

# Highest released vX.Y.Z tag on the remote. Prints nothing if the remote is
# unreachable or has no version tags - callers treat that as "skip, try tomorrow".
latest_remote_version() {
    local ref tag best=""
    while read -r _ ref; do
        tag="${ref#refs/tags/}"
        tag="${tag#v}"
        [[ "$tag" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || continue
        if [ -z "$best" ] || [ "$(version_compare "$tag" "$best")" = "1" ]; then
            best="$tag"
        fi
    done < <(git -C "$ROOT" ls-remote --tags --refs origin 'v*' 2>/dev/null || true)
    printf '%s' "$best"
}

# Desktop notification, best effort - never fail the run over it.
notify() {
    local title="$1" body="$2"
    if command -v notify-send >/dev/null; then
        notify-send -a "Claude Usage Panel" "$title" "$body" >/dev/null 2>&1 || true
    elif command -v osascript >/dev/null; then
        osascript -e "display notification \"$body\" with title \"$title\"" \
            >/dev/null 2>&1 || true
    fi
}

# Reasons to leave the checkout alone. Prints the reason and returns 1.
repo_is_updatable() {
    if ! git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        echo "not a git checkout ($ROOT) - nothing to pull from"
        return 1
    fi
    if ! git -C "$ROOT" remote get-url origin >/dev/null 2>&1; then
        echo "no 'origin' remote configured"
        return 1
    fi
    if [ -n "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ]; then
        echo "local changes in $ROOT - leaving them alone"
        return 1
    fi
    if ! git -C "$ROOT" symbolic-ref --quiet HEAD >/dev/null 2>&1; then
        echo "detached HEAD in $ROOT - leaving it alone"
        return 1
    fi
    if ! git -C "$ROOT" rev-parse --abbrev-ref --symbolic-full-name '@{u}' \
        >/dev/null 2>&1; then
        echo "current branch tracks no upstream - leaving it alone"
        return 1
    fi
    return 0
}

trim_log() {
    [ -f "$LOG" ] || return 0
    local lines
    lines="$(wc -l <"$LOG" 2>/dev/null || echo 0)"
    if [ "$lines" -gt "$LOG_MAX_LINES" ]; then
        tail -n "$LOG_MAX_LINES" "$LOG" >"$LOG.tmp" && mv "$LOG.tmp" "$LOG"
    fi
}

# ── Args ────────────────────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
    case "$1" in
        -h | --help)
            usage
            exit 0
            ;;
        --check) MODE=check ;;
        --status) MODE=status ;;
        --json) JSON=true ;;
        --force) FORCE=true ;;
        --quiet | -q) QUIET=true ;;
        # Used by the unit tests to assert the ordering rules directly.
        --version-compare)
            [ $# -ge 3 ] || die "--version-compare needs two versions"
            version_compare "$2" "$3"
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            usage >&2
            exit 2
            ;;
    esac
    shift
done

mkdir -p "$STATE_DIR"

# Minimal JSON string escaping - values here are paths and versions.
json_escape() {
    printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

if [ "$MODE" = status ]; then
    installed="$(local_version)"
    latest="$(latest_remote_version || true)"
    last_check="never"
    [ -f "$STATE_DIR/last-check" ] && last_check="$(cat "$STATE_DIR/last-check")"

    # Why a scheduled run would decline to act - the part that was invisible
    # before: auto-update logs its reason and waits, so a user with a dirty or
    # diverged checkout saw "up to date" forever with no hint why.
    blocked_reason=""
    if ! blocked_reason="$(repo_is_updatable)"; then
        :
    else
        blocked_reason=""
    fi

    update_available=false
    if [ -n "$latest" ] && [ "$(version_compare "$latest" "$installed")" = 1 ]; then
        update_available=true
    fi

    if $JSON; then
        printf '{\n'
        printf '  "checkout": "%s",\n' "$(json_escape "$ROOT")"
        printf '  "installed": "%s",\n' "$(json_escape "$installed")"
        printf '  "latest": "%s",\n' "$(json_escape "$latest")"
        printf '  "updateAvailable": %s,\n' "$update_available"
        printf '  "blocked": %s,\n' "$([ -n "$blocked_reason" ] && echo true || echo false)"
        printf '  "blockedReason": "%s",\n' "$(json_escape "$blocked_reason")"
        printf '  "lastCheck": "%s",\n' "$(json_escape "$last_check")"
        printf '  "log": "%s"\n' "$(json_escape "$LOG")"
        printf '}\n'
        exit 0
    fi

    printf 'checkout:   %s\n' "$ROOT"
    printf 'installed:  %s\n' "$installed"
    printf 'latest:     %s\n' "$latest"
    printf 'update:     %s\n' "$($update_available && echo "available" || echo "up to date")"
    [ -n "$blocked_reason" ] && printf 'blocked:    %s\n' "$blocked_reason"
    printf 'last check: %s\n' "$last_check"
    printf 'log:        %s\n' "$LOG"
    exit 0
fi

# ── One run at a time ───────────────────────────────────────────────────────────
# mkdir is the portable atomic lock (flock is not on macOS). A lock older than
# 6h is stale - a previous run was killed mid-flight.
if ! mkdir "$LOCK" 2>/dev/null; then
    if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +360 2>/dev/null)" ]; then
        rm -rf "$LOCK"
        mkdir "$LOCK" 2>/dev/null || die "could not take the lock at $LOCK"
    else
        say "another update run is in progress - skipping"
        exit 0
    fi
fi
trap 'rm -rf "$LOCK"' EXIT

# ── Check ───────────────────────────────────────────────────────────────────────
if ! reason="$(repo_is_updatable)"; then
    say "skip: $reason"
    trim_log
    exit 0
fi

have="$(local_version)"
[ -n "$have" ] || die "could not read the version from $ROOT/package.json"

latest="$(latest_remote_version)"
date '+%Y-%m-%dT%H:%M:%S%z' >"$STATE_DIR/last-check"
if [ -z "$latest" ]; then
    say "skip: could not reach the remote (offline?) - will retry tomorrow"
    trim_log
    exit 0
fi

if [ "$(version_compare "$latest" "$have")" != "1" ] && ! $FORCE; then
    say "up to date (v$have, latest v$latest)"
    trim_log
    exit 0
fi

if [ "$MODE" = check ]; then
    say "update available: v$have → v$latest"
    trim_log
    exit 10
fi

# ── Update ──────────────────────────────────────────────────────────────────────
say "updating v$have → v$latest"
upstream="$(git -C "$ROOT" rev-parse --abbrev-ref --symbolic-full-name '@{u}')"
git -C "$ROOT" fetch --quiet --tags origin || die "git fetch failed"
# --ff-only: if the branch has diverged this refuses rather than merging or
# rewriting anything, and the run ends here with the checkout untouched.
if ! git -C "$ROOT" merge --ff-only --quiet "$upstream" 2>>"$LOG"; then
    say "skip: $upstream is not a fast-forward from here - update by hand"
    trim_log
    exit 0
fi

now="$(local_version)"
say "fast-forwarded to v$now - reinstalling the targets already installed"

# `install.sh update` reinstalls only what `--list` reports as installed, so
# this never adds a client the user chose not to have.
if "$ROOT/install.sh" update >>"$LOG" 2>&1; then
    say "updated to v$now"
    notify "Claude Usage Panel updated" "Now on v$now. GNOME: log out and back in to load it."
else
    say "install.sh update failed after fast-forwarding to v$now - see $LOG"
    notify "Claude Usage Panel update failed" "Fetched v$now but the reinstall failed. See $LOG"
    trim_log
    exit 1
fi

trim_log
