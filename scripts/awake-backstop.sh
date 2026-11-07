#!/usr/bin/env bash
# Awake backstop: give this machine its sleep back from the recovery journal
# ALONE - no panel, no claudectl, no node, no Swift.
#
#   scripts/awake-backstop.sh --awake-dir DIR            undo what is owed, if it is owed yet
#   scripts/awake-backstop.sh --awake-dir DIR --force    undo it now, whatever the deadline says
#   scripts/awake-backstop.sh --awake-dir DIR --status   what the journal says; changes nothing
#   scripts/awake-backstop.sh --awake-dir DIR --quiet    log only (this is what the timer runs)
#
# DIR is the awake store, `<state dir>/claude-usage-panel/awake`. It is not
# derived here: `./install.sh awake` asks claude-code/paths.js for it (the one
# definition every Node client uses) and bakes it into the schedule, so the
# store this script repairs is the store the holder writes, by construction.
#
# Scheduled by `./install.sh awake` - a launchd agent on macOS, a systemd user
# timer on Linux, cron lines as fallback - and run once by `claudectl awake`
# itself. The idea is Insomnia's (https://github.com/krishhgg/Insomnia, MIT):
# the one thing that must survive a crashed app is the undo, so the undo is a
# shell script that reads a JSON file and runs `sudo -n pmset`.
#
# What it undoes, from the journal's own flags, in this order:
#   sleepDisabled  ->  sudo -n pmset -a disablesleep 0
#   lowPower       ->  sudo -n pmset -b lowpowermode 0
# Both are macOS-only, because they are the only PERSISTENT changes this
# feature makes. On Linux the idle/sleep and lid inhibitors are child
# processes of the holder, so the kernel releases them when the holder exits
# and there is nothing here to undo - the journal stays clean and every run
# is a no-op.
#
# Every run is one transaction under <awake dir>/.hold.lock, the same O_EXCL
# lock file the holder takes, so no undo can run beside a change. A run that
# cannot take the lock does NOTHING and exits 75; the timer retries a minute
# later.
#
# It refuses to touch a journal whose session is still running: only once the
# deadline has been past for the grace window (2 minutes) is the machine the
# backstop's to repair. A flag is cleared only after its undo succeeded, so a
# failed run leaves the claim standing and the next run retries it.
#
# Exit codes: 0 = nothing owed or everything undone, 1 = an undo failed,
# 2 = usage, 75 = the lock was busy (try again).
set -euo pipefail

SCRIPT_NAME=awake-backstop

# AWAKE_BACKSTOP_GRACE_MS in lib/pure/awake.js (2 minutes); tests/awake-install.test.js
# runs this script just inside and just past that window. undo_one's two
# commands are held to lib/pure/awake-power.js AWAKE_SUDO_COMMANDS the same way.
GRACE_SECONDS=120
# A lock whose holder is gone, or that has sat untouched this long, is taken
# over: LOCK_STALE_MS in claude-code/awake.js.
LOCK_STALE_SECONDS=60
SUDO=/usr/bin/sudo
PMSET=/usr/bin/pmset
# Test hook (tests/awake-install.test.js): a directory holding a fake `sudo`
# and `pmset`, so the suite drives this script's real decision path without a
# privileged command existing anywhere. Named, like CUP_TEST_SCHEDULER in
# install.sh, so it is obvious in a diff and never set in production; the
# defaults above stay absolute paths that no PATH can redirect.
if [ -n "${CUP_TEST_PMSET_DIR:-}" ]; then
    SUDO="$CUP_TEST_PMSET_DIR/sudo"
    PMSET="$CUP_TEST_PMSET_DIR/pmset"
fi

QUIET=false
FORCE=false
MODE=run # run | status
AWAKE_DIR=""
# Set for real once --awake-dir is known; lib.sh's EXIT trap reads it before.
LOG=""

# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh" 2>/dev/null || {
    echo "awake-backstop: lib.sh missing next to $0 - reinstall (./install.sh update)" >&2
    exit 1
}

while [ $# -gt 0 ]; do
    case "$1" in
        --force) FORCE=true ;;
        --status) MODE=status ;;
        --quiet) QUIET=true ;;
        --awake-dir=*) AWAKE_DIR="${1#--awake-dir=}" ;;
        --awake-dir)
            [ $# -ge 2 ] || {
                printf '%s: --awake-dir needs a directory\n' "$SCRIPT_NAME" >&2
                exit 2
            }
            AWAKE_DIR="$2"
            shift
            ;;
        -h | --help)
            usage
            exit 0
            ;;
        *)
            printf '%s: unknown option %s\n' "$SCRIPT_NAME" "$1" >&2
            usage >&2
            exit 2
            ;;
    esac
    shift
done

# An absolute path or nothing: a relative one would follow the scheduler's cwd.
case "$AWAKE_DIR" in
    /*) ;;
    *)
        printf '%s: --awake-dir must name the absolute awake store; the installed schedule passes it - reinstall with ./install.sh update\n' \
            "$SCRIPT_NAME" >&2
        exit 2
        ;;
esac
AWAKE_DIR="${AWAKE_DIR%/}"
STATE_DIR="$(dirname "$AWAKE_DIR")"
JOURNAL="$AWAKE_DIR/journal.json"
SESSION="$AWAKE_DIR/session.json"
HOLD_LOCK="$AWAKE_DIR/.hold.lock"
LOG="$STATE_DIR/awake-backstop.log"
# take_lock() in lib.sh wants a directory lock of its own; this script uses the
# holder's file lock instead, so LOCK is only there to satisfy the contract.
# shellcheck disable=SC2034  # read by lib.sh
LOCK="$AWAKE_DIR/.backstop.lock"

# ── reading the journal ─────────────────────────────────────────────────────
# The journal is written by JSON.stringify(x, null, 2) / JSONSerialization, so
# every key sits on its own line as `"key": value`. That is all this needs to
# read, and reading it with grep keeps the backstop free of jq - which is not
# installed everywhere, and whose absence must never be what leaves a Mac
# unable to sleep.

json_bool() { # FILE KEY -> "true" | "false"
    local v
    v="$(grep -o "\"$2\"[[:space:]]*:[[:space:]]*\(true\|false\)" "$1" 2>/dev/null | head -1)"
    case "$v" in
        *true) echo true ;;
        *) echo false ;;
    esac
}

json_number() { # FILE KEY -> the integer part, or 0
    local v
    v="$(grep -o "\"$2\"[[:space:]]*:[[:space:]]*-\{0,1\}[0-9][0-9]*" "$1" 2>/dev/null | head -1)"
    v="${v##*:}"
    v="${v// /}"
    v="${v//$'\t'/}"
    case "$v" in
        '' | *[!0-9-]*) echo 0 ;;
        *) echo "$v" ;;
    esac
}

now_seconds() { date +%s; }

pid_alive() { # PID
    [ "${1:-0}" -gt 0 ] 2>/dev/null || return 1
    kill -0 "$1" 2>/dev/null
}

# ── the lock the holder takes ───────────────────────────────────────────────
# O_EXCL create on the same path claude-code/awake.js uses (`set -C` makes
# `>` fail when the file exists), with the same rules as claude-code/excl-lock.js:
#   - the body is our pid, then a token nobody else writes, and the lock is
#     removed on exit only while that exact body is still there: a run that
#     overran the stale window never removes the lock of whoever took over;
#   - a lock whose pid is gone, or that is older than the stale window, is
#     removed only under the takeover guard (<lock>.takeover, O_EXCL): holding
#     it, the run re-reads the lock and removes it only if it still holds the
#     exact body it judged. Takeovers go one at a time, and a lock created
#     since the judgement is never touched; a guard older than 2 minutes was
#     left by a crash and is cleared for the next round.
HOLD_TOKEN="$$-$(date +%s)-$RANDOM$RANDOM"

hold_body() { printf '%s\n%s\n' "$$" "$HOLD_TOKEN"; }

# shellcheck disable=SC2329  # run by the EXIT trap take_hold_lock sets
release_hold_lock() {
    if [ "$(cat "$HOLD_LOCK" 2>/dev/null)" = "$(hold_body)" ]; then
        rm -f "$HOLD_LOCK"
    fi
}

take_over_stale() { # JUDGED: the lock's content when it was judged stale
    local guard="$HOLD_LOCK.takeover"
    if ! (
        set -C
        : >"$guard"
    ) 2>/dev/null; then
        # another takeover runs; a guard left by a crash is cleared after 2 min
        if [ -n "$(find "$guard" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then
            rm -f "$guard"
        fi
        return 0
    fi
    if [ "$(cat "$HOLD_LOCK" 2>/dev/null)" = "$1" ]; then
        rm -f "$HOLD_LOCK"
    fi
    rm -f "$guard"
}

take_hold_lock() {
    mkdir -p "$AWAKE_DIR" 2>/dev/null || return 1
    local judged held age
    # A few passes: a stale lock is taken over, then the create retried. A lock
    # still there after that has a live holder, and then doing nothing is the
    # right answer.
    for _ in 1 2 3; do
        if (
            set -C
            hold_body >"$HOLD_LOCK"
        ) 2>/dev/null; then
            trap 'release_hold_lock; trim_log' EXIT
            return 0
        fi
        judged="$(cat "$HOLD_LOCK" 2>/dev/null)" || continue # released meanwhile
        held="$(printf '%s\n' "$judged" | head -1)"
        age=""
        [ -n "$(find "$HOLD_LOCK" -maxdepth 0 -mmin "+$((LOCK_STALE_SECONDS / 60))" 2>/dev/null)" ] && age=stale
        # an empty body is a lock being written right now: only age judges it
        if { [ -n "$held" ] && ! pid_alive "$held"; } || [ -n "$age" ]; then
            take_over_stale "$judged"
            continue
        fi
        return 1
    done
    return 1
}

owed() { # -> the flags still set, space separated
    local list=""
    [ -f "$JOURNAL" ] || return 0
    [ "$(json_bool "$JOURNAL" sleepDisabled)" = true ] && list="$list sleepDisabled"
    [ "$(json_bool "$JOURNAL" lowPower)" = true ] && list="$list lowPower"
    printf '%s' "${list# }"
}

# Rewrite the journal with one flag set to false. Done in place with sed, so a
# key this script does not know survives untouched.
clear_flag() { # KEY
    local tmp
    tmp="$JOURNAL.$$.tmp"
    sed "s/\(\"$1\"[[:space:]]*:[[:space:]]*\)true/\1false/" "$JOURNAL" >"$tmp" 2>/dev/null || {
        rm -f "$tmp"
        return 1
    }
    chmod 600 "$tmp" 2>/dev/null || true
    mv "$tmp" "$JOURNAL"
}

undo_one() { # KEY -> 0 when the machine took it back
    case "$1" in
        sleepDisabled) "$SUDO" -n "$PMSET" -a disablesleep 0 >/dev/null 2>&1 ;;
        lowPower) "$SUDO" -n "$PMSET" -b lowpowermode 0 >/dev/null 2>&1 ;;
        *) return 1 ;;
    esac
}

# ── status ──────────────────────────────────────────────────────────────────
if [ "$MODE" = status ]; then
    echo "awake dir:  $AWAKE_DIR"
    if [ -f "$SESSION" ]; then
        echo "session:    ends at $(json_number "$SESSION" endsAt) (epoch ms), owner pid $(json_number "$SESSION" pid)"
    else
        echo "session:    none"
    fi
    if [ -f "$JOURNAL" ]; then
        list="$(owed)"
        echo "journal:    ends at $(json_number "$JOURNAL" endsAt) (epoch ms)"
        echo "owed:       ${list:-nothing}"
    else
        echo "journal:    none"
    fi
    echo "log:        $LOG"
    exit 0
fi

# ── run ─────────────────────────────────────────────────────────────────────
# Nothing owed is the overwhelmingly common case and must cost nothing: no
# lock, no sudo, no log line, no state dir created.
[ -f "$JOURNAL" ] || exit 0
[ -n "$(owed)" ] || exit 0

if ! take_hold_lock; then
    log "lock busy; nothing done"
    exit 75
fi

# Re-read inside the lock: the holder may have finished between the cheap
# check above and here, which is the whole point of taking the lock.
LIST="$(owed)"
if [ -z "$LIST" ]; then
    exit 0
fi

ENDS_MS="$(json_number "$JOURNAL" endsAt)"
DUE_SECONDS=$((ENDS_MS / 1000 + GRACE_SECONDS))
NOW="$(now_seconds)"
if ! $FORCE && [ "$NOW" -lt "$DUE_SECONDS" ]; then
    # The session this journal belongs to is still running (or inside the
    # grace window). Cutting it short is not the backstop's job.
    exit 0
fi

if [ "$(uname -s)" != "Darwin" ]; then
    # Nothing here can be owed on Linux (every change is a child process), so
    # a journal that says otherwise was written by another platform's run or
    # by hand. Say so rather than running pmset that does not exist.
    say "journal claims $LIST, but this is not macOS - nothing to undo here"
    exit 1
fi

FAILED=""
UNDONE=""
for flag in $LIST; do
    if undo_one "$flag" && clear_flag "$flag"; then
        UNDONE="$UNDONE $flag"
    else
        FAILED="$FAILED $flag"
    fi
done

if [ -n "$FAILED" ]; then
    say "could not undo${FAILED} - is the sudoers rule installed? (./install.sh awakelid). Retrying next run."
    exit 1
fi

# Everything is back: the session file is history now.
rm -f "$SESSION"
say "recovered${UNDONE} after an Awake session that ended without releasing it"
exit 0
