#!/usr/bin/env bash
# Session ping for Claude Usage Panel - starts the 5-hour Claude Code session
# window at scheduled times instead of at your first real message of the day,
# so working hours cover more full windows.
#
#   scripts/session-ping.sh              ping now (skips on non-configured days)
#   scripts/session-ping.sh --force      ping now whatever the day is
#   scripts/session-ping.sh --days=1,2,5 only ping when today is listed (1 = Mon ... 7 = Sun)
#   scripts/session-ping.sh --status     configured schedule, last ping, log path
#   scripts/session-ping.sh --quiet      log only, no stdout (this is what the timer runs)
#
# Scheduled at fixed times by `./install.sh sessionping [HH:MM ...] [--days=...]`
# - a systemd user timer on Linux, a launchd agent on macOS, cron lines as
# fallback. The schedule invokes this script with --days= baked in; run by hand
# without it the default is Mon-Fri.
#
# The ping shells out to the `claude` CLI (print mode, haiku model, one turn)
# rather than POSTing to the API with the stored OAuth token: clients never
# write the token, and at early-morning ping times it is often expired - the
# CLI is the one place allowed to refresh it. It deliberately does not check
# whether a window is already open: a ping inside an active window is harmless
# (the window is anchored at its first message).
#
# Exit codes: 0 = pinged or skipped, 1 = error, 2 = usage.
set -euo pipefail

STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/claude-usage-panel"
LOG="$STATE_DIR/session-ping.log"
LOG_MAX_LINES=500
LOCK="$STATE_DIR/session-ping.lock"
PING_TIMEOUT=120

# Same names as the sessionping target in install.sh - used here only to read
# the installed schedule back for --status.
SP_UNIT="claude-usage-panel-sessionping"
SP_LABEL="io.github.fschmutz.claude-usage-panel.sessionping"
SP_CRON_TAG="# claude-usage-panel session-ping"

QUIET=false
FORCE=false
MODE=run # run | status
DAYS="1,2,3,4,5"

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
    printf 'session-ping: %s\n' "$*" >&2
    log "ERROR $*"
    exit 1
}

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

# Schedulers run with a minimal PATH; probe the usual claude locations first.
# Prints the absolute path, or nothing if the CLI is not installed.
# SP_TEST_CLAUDE_PATHS is a unit-test hook: it replaces the probed locations so
# tests never resolve (and ping) a real claude install.
resolve_claude() {
    PATH="${SP_TEST_CLAUDE_PATHS-$HOME/.local/bin:$HOME/.claude/local:/opt/homebrew/bin:/usr/local/bin}:$PATH" \
        command -v claude || true
}

# Read the installed schedule back from whichever scheduler artifact exists
# (systemd timer, launchd plist, crontab lines). Prints HH:MM lines / nothing.
current_times() {
    local timer plist
    timer="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$SP_UNIT.timer"
    plist="$HOME/Library/LaunchAgents/$SP_LABEL.plist"
    if [ -f "$timer" ]; then
        sed -n 's/^OnCalendar=\*-\*-\* \([0-9][0-9]:[0-9][0-9]\):00$/\1/p' "$timer"
    elif [ -f "$plist" ]; then
        sed -n 's/.*<key>Hour<\/key><integer>\([0-9]*\)<\/integer><key>Minute<\/key><integer>\([0-9]*\)<\/integer>.*/\1 \2/p' \
            "$plist" | awk '{printf "%02d:%02d\n", $1, $2}'
    elif command -v crontab >/dev/null; then
        crontab -l 2>/dev/null | grep -F "$SP_CRON_TAG" |
            awk '{printf "%02d:%02d\n", $2, $1}'
    fi
    return 0
}

# The --days= list baked into the installed schedule, if any.
current_days() {
    local timer plist
    timer="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$SP_UNIT.service"
    plist="$HOME/Library/LaunchAgents/$SP_LABEL.plist"
    if [ -f "$timer" ]; then
        grep -o -- '--days=[0-9,]*' "$timer" | head -1 | cut -d= -f2
    elif [ -f "$plist" ]; then
        grep -o -- '--days=[0-9,]*' "$plist" | head -1 | cut -d= -f2
    elif command -v crontab >/dev/null; then
        crontab -l 2>/dev/null | grep -F "$SP_CRON_TAG" |
            grep -o -- '--days=[0-9,]*' | head -1 | cut -d= -f2
    fi
    return 0
}

# ── Args ────────────────────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
    case "$1" in
        -h | --help)
            usage
            exit 0
            ;;
        --force) FORCE=true ;;
        --status) MODE=status ;;
        --quiet | -q) QUIET=true ;;
        --days=*)
            DAYS="${1#*=}"
            if ! [[ "$DAYS" =~ ^[1-7](,[1-7])*$ ]]; then
                echo "--days wants a comma-separated list of 1..7 (1 = Monday), got: $DAYS" >&2
                exit 2
            fi
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

if [ "$MODE" = status ]; then
    times="$(current_times | paste -sd' ' -)"
    days="$(current_days)"
    printf 'schedule:   %s\n' "${times:-not installed (./install.sh sessionping)}"
    printf 'days:       %s   (1 = Monday ... 7 = Sunday)\n' "${days:-$DAYS}"
    printf 'claude:     %s\n' "$(resolve_claude || true)"
    if [ -f "$STATE_DIR/last-ping" ]; then
        printf 'last ping:  %s\n' "$(cat "$STATE_DIR/last-ping")"
    else
        printf 'last ping:  never\n'
    fi
    printf 'log:        %s\n' "$LOG"
    exit 0
fi

# ── One run at a time ───────────────────────────────────────────────────────────
# mkdir is the portable atomic lock (flock is not on macOS). A ping is short,
# so a lock older than 15 minutes is stale - a previous run was killed mid-flight.
if ! mkdir "$LOCK" 2>/dev/null; then
    if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +15 2>/dev/null)" ]; then
        rm -rf "$LOCK"
        mkdir "$LOCK" 2>/dev/null || die "could not take the lock at $LOCK"
    else
        say "another ping is in progress - skipping"
        exit 0
    fi
fi
trap 'rm -rf "$LOCK"' EXIT

# ── Day guard ───────────────────────────────────────────────────────────────────
# SP_TEST_WEEKDAY is a unit-test hook, same idea as auto-update's --version-compare.
today="${SP_TEST_WEEKDAY:-$(date +%u)}"
if ! $FORCE && [[ ",$DAYS," != *",$today,"* ]]; then
    say "skip: not a configured day (today=$today, days=$DAYS)"
    trim_log
    exit 0
fi

# ── Ping ────────────────────────────────────────────────────────────────────────
CLAUDE="$(resolve_claude)"
if [ -z "$CLAUDE" ]; then
    say "skip: claude CLI not found on PATH - install it or adjust PATH"
    trim_log
    exit 0
fi

# Run from a neutral empty directory so no project CLAUDE.md or project MCP
# servers are picked up. One haiku turn is the cheapest request that still
# opens the 5h window. No --strict-mcp-config: claude rejects it outright when
# an enterprise MCP config is present.
mkdir -p "$STATE_DIR/ping-cwd"
(cd "$STATE_DIR/ping-cwd" &&
    exec "$CLAUDE" -p "ping" --model haiku --max-turns 1 \
        --output-format text) >/dev/null 2>&1 &
ping_pid=$!
# stdio fully detached: an inherited pipe would keep the caller waiting on the
# orphaned sleep for the full timeout even after a fast successful ping.
(
    sleep "$PING_TIMEOUT"
    kill "$ping_pid" 2>/dev/null
) </dev/null >/dev/null 2>&1 &
watchdog_pid=$!
disown "$watchdog_pid" # no job-control noise when it gets killed below

if wait "$ping_pid"; then
    kill "$watchdog_pid" 2>/dev/null || true
    now="$(date '+%Y-%m-%dT%H:%M:%S%z')"
    echo "$now" >"$STATE_DIR/last-ping"
    say "pinged (model haiku) at $now - session window is open"
else
    kill "$watchdog_pid" 2>/dev/null || true
    say "error: the claude ping failed or timed out after ${PING_TIMEOUT}s - see $LOG"
    trim_log
    exit 1
fi

trim_log
