# shellcheck shell=bash
# Shared plumbing for the scheduled workers (auto-update.sh, session-ping.sh):
# logging, the one-run-at-a-time lock, log trimming, --help. Sourced, never
# executed. The workers are copied out of the checkout (beside the GNOME
# extension, into the macOS app's Resources), so this file travels with them:
# every copy step that ships a worker ships lib.sh next to it.
#
# The sourcing script sets, before `source`:
#   SCRIPT_NAME    prefix for error messages ("auto-update")
#   STATE_DIR      where the log lives
#   LOG            the log file
#   LOCK           the lock directory (see take_lock)
#   LOG_MAX_LINES  trim the log to this many lines on exit (default 500)
#   QUIET          true = say() logs only (default false)
#
# Nothing here writes to stdout except say(); nothing creates STATE_DIR until
# the first log line, so a read-only invocation (--status, --schedule) leaves
# an empty HOME empty.

: "${LOG_MAX_LINES:=500}"
: "${QUIET:=false}"

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
    printf '%s: %s\n' "$SCRIPT_NAME" "$*" >&2
    log "ERROR $*"
    exit 1
}

# The leading comment block of the calling script (after the shebang) is its
# help text. $0 is the caller: functions run in the sourcing shell.
usage() {
    awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "$0"
}

trim_log() {
    [ -f "$LOG" ] || return 0
    local lines
    lines="$(wc -l <"$LOG" 2>/dev/null || echo 0)"
    if [ "$lines" -gt "$LOG_MAX_LINES" ]; then
        tail -n "$LOG_MAX_LINES" "$LOG" >"$LOG.tmp" && mv "$LOG.tmp" "$LOG"
    fi
}

# Every exit path trims the log - no per-exit calls to forget.
trap 'trim_log' EXIT

# One run at a time, on $LOCK. mkdir is the portable atomic lock (flock is
# not on macOS). A lock older than $1 minutes is stale - a previous run was
# killed mid-flight - and is reclaimed. Returns 1 when another run holds a
# fresh lock; the caller decides what to say (and must not remove it). On
# success the lock is released on exit, whatever the exit.
take_lock() {
    local stale_minutes="$1"
    if ! mkdir "$LOCK" 2>/dev/null; then
        if [ -n "$(find "$LOCK" -maxdepth 0 -mmin "+$stale_minutes" 2>/dev/null)" ]; then
            rm -rf "$LOCK"
            mkdir "$LOCK" 2>/dev/null || die "could not take the lock at $LOCK"
        else
            return 1
        fi
    fi
    trap 'rm -rf "$LOCK"; trim_log' EXIT
}
