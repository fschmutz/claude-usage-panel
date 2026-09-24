#!/usr/bin/env bash
# Session ping for Claude Usage Panel - starts the 5-hour Claude Code session
# window at scheduled times instead of at your first real message of the day,
# so working hours cover more full windows.
#
#   scripts/session-ping.sh              ping now (skips on non-configured days)
#   scripts/session-ping.sh --force      ping now whatever the day is
#   scripts/session-ping.sh --days=1,2,5 only ping when today is listed (1 = Mon ... 7 = Sun)
#   scripts/session-ping.sh --status     configured schedule, last ping, log path
#   scripts/session-ping.sh --schedule   the installed schedule, machine-readable:
#                                        line 1 the HH:MM times, line 2 the --days= list
#                                        (what install.sh reads back on a bare reinstall)
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

SCRIPT_NAME=session-ping
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/claude-usage-panel"
LOG="$STATE_DIR/session-ping.log"
LOCK="$STATE_DIR/session-ping.lock"
PING_TIMEOUT=120

# Same names as the sessionping target in install.sh - used here only to read
# the installed schedule back for --status.
SP_UNIT="claude-usage-panel-sessionping"
SP_LABEL="io.github.fschmutz.claude-usage-panel.sessionping"
SP_CRON_TAG="# claude-usage-panel session-ping"

QUIET=false
FORCE=false
MODE=run # run | status | schedule
DAYS="1,2,3,4,5"

# log / say / die / usage / trim_log / take_lock - shared with auto-update.sh.
# Every copy of this script travels with lib.sh (install.sh gnome and macos,
# the GNOME zip); a lone copy is a broken install, so say so instead of failing
# on the first `say`.
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh" 2>/dev/null || {
    echo "session-ping: lib.sh missing next to $0 - reinstall (./install.sh update)" >&2
    exit 1
}

# `sort -V` is not POSIX and BSD sort only grew it recently; fall back to a
# lexical reverse sort where it is missing (one installed version is the
# common case, and the fallback still puts the newest first for same-width
# version numbers).
version_sort_desc() {
    if printf '' | sort -V >/dev/null 2>&1; then
        sort -Vr
    else
        sort -r
    fi
}

# Node version managers install the CLI under a per-version prefix that no
# scheduler has on PATH - which is exactly where `npm i -g
# @anthropic-ai/claude-code` lands when node comes from nvm, the most common
# way to get the CLI on Linux. Print one candidate bin dir per line, newest
# version first so a node upgrade does not strand the ping on an old install.
node_manager_bins() {
    local spec root sub version path
    for spec in "${NVM_DIR:-$HOME/.nvm}/versions/node|bin" \
        "${FNM_DIR:-$HOME/.local/share/fnm}/node-versions|installation/bin" \
        "${ASDF_DATA_DIR:-$HOME/.asdf}/installs/nodejs|bin"; do
        root="${spec%|*}"
        sub="${spec#*|}"
        if [ -d "$root" ]; then
            # A glob, not `ls`: a version directory with a space or a newline in
            # its name would be split into two bogus candidates (SC2012).
            for path in "$root"/*; do
                [ -d "$path" ] || continue
                printf '%s\n' "${path##*/}"
            done | version_sort_desc | while IFS= read -r version; do
                printf '%s/%s/%s\n' "$root" "$version" "$sub"
            done
        fi
    done
    # volta shims every tool from one flat dir, no per-version prefix.
    printf '%s\n' "${VOLTA_HOME:-$HOME/.volta}/bin"
}

# Schedulers run with a minimal PATH; probe the usual claude locations first.
# Prints the absolute path, or nothing if the CLI is not installed.
# SP_TEST_CLAUDE_PATHS is a unit-test hook: it replaces the probed locations so
# tests never resolve (and ping) a real claude install.
resolve_claude() {
    local probe dir
    probe="$HOME/.local/bin:$HOME/.claude/local:/opt/homebrew/bin:/usr/local/bin"
    while IFS= read -r dir; do
        if [ -n "$dir" ]; then
            probe="$probe:$dir"
        fi
    done <<<"$(node_manager_bins)"
    PATH="${SP_TEST_CLAUDE_PATHS-$probe}:$PATH" command -v claude || true
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
        --schedule) MODE=schedule ;;
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

# The installed schedule, for install.sh: it must read back what a previous
# install (or the panels' preferences) wrote, and this script is the one
# reader of the three scheduler formats. Two lines, either may be empty.
if [ "$MODE" = schedule ]; then
    printf '%s\n' "$(current_times | paste -sd' ' -)"
    printf '%s\n' "$(current_days)"
    exit 0
fi

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

# Created only past the read-only --status and --schedule branches: neither
# may leave anything behind in a HOME that has never pinged (see lib.sh).
mkdir -p "$STATE_DIR"

# ── One run at a time ───────────────────────────────────────────────────────────
# A ping is short, so a lock older than 15 minutes is stale.
if ! take_lock 15; then
    say "another ping is in progress - skipping"
    exit 0
fi

# ── Day guard ───────────────────────────────────────────────────────────────────
# SP_TEST_WEEKDAY is a unit-test hook, same idea as auto-update's --version-compare.
today="${SP_TEST_WEEKDAY:-$(date +%u)}"
if ! $FORCE && [[ ",$DAYS," != *",$today,"* ]]; then
    say "skip: not a configured day (today=$today, days=$DAYS)"
    exit 0
fi

# ── Ping ────────────────────────────────────────────────────────────────────────
CLAUDE="$(resolve_claude)"
if [ -z "$CLAUDE" ]; then
    say "skip: claude CLI not found on PATH - install it or adjust PATH"
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
    exit 1
fi
