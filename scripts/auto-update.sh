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
# fast-forwarded TO THAT TAG (not to the branch tip, which carries unreleased
# commits) and `install.sh update` reinstalls exactly the targets that are
# already installed (never adds new ones).
#
# What it compares is the DEPLOYED version - what the clients run, from
# $STATE_DIR/installed-version, which install.sh writes on every successful
# run - and never the checkout's package.json. The two drift apart after a
# manual pull, an interrupted reinstall or an install that dropped a target,
# and comparing the checkout meant every one of those states read as "up to
# date" while the clients stayed behind for good. A reinstall that was owed but
# did not finish is recorded in $STATE_DIR/update-pending and retried.
#
# A scheduled run (--quiet) also skips when the last successful check is less
# than CUP_MIN_CHECK_HOURS old, which is what lets the job fire at login and at
# resume as well as daily: a laptop that was off at the scheduled minute still
# gets its check, without one per login.
#
# It refuses to touch a checkout it does not own: a dirty worktree, a detached
# HEAD, a branch with no upstream, or a missing remote each make it skip with a
# message instead of moving anyone's work. Nothing here rebases, stashes or
# force-pushes; the git writes are `merge --ff-only`, and one reset: when the
# upstream history itself was rewritten (a force-push to purge data from it),
# a checkout that holds NOTHING of its own - clean tree, and every commit it
# has was already on the upstream it had fetched - follows the new history
# instead of being stranded on the old one forever. Any local commit and it
# skips, as for any other divergence.
#
# Exit codes: 0 = up to date / updated / skipped, 10 = update available
# (--check only), 1 = error, 2 = usage.
set -euo pipefail

SELF_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/claude-usage-panel"

# A directory is the checkout only if it has both halves: the manifest this
# script reads the version from, and a git worktree it can fast-forward.
is_checkout() {
    [ -n "${1:-}" ] && [ -f "$1/package.json" ] &&
        git -C "$1" rev-parse --is-inside-work-tree >/dev/null 2>&1
}

# The .sh path in one line of an installed schedule: a systemd ExecStart= line,
# one <string> of a launchd ProgramArguments array, or a crontab line. The
# installer quotes a path that is not made of plain characters
# (_sched_systemd_word / _sched_cron_word in scripts/install/scheduler.sh) and
# XML-escapes it in a plist, so each form is unquoted the way it was written;
# splitting on blanks, as this once did, lost every checkout under a folder
# with a space in its name.
runner_in() {
    local line="$1" word
    case "$line" in
        *'<string>'*'</string>'*)
            word="${line#*<string>}"
            word="${word%%</string>*}"
            word="$(printf '%s' "$word" | sed -e 's/&lt;/</g' -e 's/&gt;/>/g' -e 's/&amp;/\&/g')"
            ;;
        ExecStart=*)
            word="$(printf '%s' "$line" | sed -e 's/^ExecStart=[-@+!:]*//')"
            if [ "${word#\"}" != "$word" ]; then
                # sed -E, not \| in a basic regex: BSD sed (macOS) has no \|.
                word="$(printf '%s' "$word" |
                    sed -E -e 's/^"(([^"\\]|\\.)*)".*/\1/' \
                        -e 's/%%/%/g' -e 's/\$\$/$/g' -e 's/\\"/"/g' -e 's/\\\\/\\/g')"
            else
                word="${word%%[[:blank:]]*}"
            fi
            ;;
        *)
            # crontab: the command starts after the five time fields.
            word="$(printf '%s' "$line" |
                sed -e 's/^[[:blank:]]*\([^[:blank:]]\{1,\}[[:blank:]]\{1,\}\)\{5\}//')"
            if [ "${word#\'}" != "$word" ]; then
                word="$(printf '%s' "$word" |
                    sed -E -e "s/^'(([^']|'\\\\'')*)'.*/\\1/" \
                        -e "s/'\\\\''/'/g" -e 's/\\%/%/g')"
            else
                word="${word%%[[:blank:]]*}"
            fi
            ;;
    esac
    case "$word" in
        /*.sh) printf '%s\n' "$word" ;;
    esac
}

# Every place an installed schedule records the path of the real checkout, in
# the order the macOS app tries them. `install.sh gnome` copies this script
# beside the GNOME extension so prefs.js can run it, and that copy has no
# package.json and no git above it - resolving ROOT from $0 alone made every
# run there die on `sed: can't read .../package.json`, which the Updates row
# read as "no checkout at all".
scheduled_runners() {
    local cfg="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
    local agents="$HOME/Library/LaunchAgents"
    local f
    for f in "$cfg/claude-usage-panel-update.service" \
        "$cfg/claude-usage-panel-sessionping.service"; do
        [ -f "$f" ] || continue
        grep -h '^ExecStart=' "$f" 2>/dev/null || true
    done
    for f in "$agents/io.github.fschmutz.claude-usage-panel.update.plist" \
        "$agents/io.github.fschmutz.claude-usage-panel.sessionping.plist"; do
        [ -f "$f" ] || continue
        grep -h '<string>' "$f" 2>/dev/null || true
    done
    crontab -l 2>/dev/null | grep -F 'claude-usage-panel' || true
}

resolve_root() {
    if is_checkout "$SELF_ROOT"; then
        printf '%s' "$SELF_ROOT"
        return 0
    fi
    local line runner candidate
    # The pointer install.sh drops on every successful run. It is the only
    # source that works for an install with no scheduled job at all - a zip
    # install, or `./install.sh --uninstall autoupdate` - which otherwise left
    # the extension's copy and the macOS app with no checkout to look at.
    if [ -f "$STATE_DIR/checkout-path" ]; then
        candidate="$(cat "$STATE_DIR/checkout-path" 2>/dev/null || true)"
        if is_checkout "$candidate"; then
            printf '%s' "$candidate"
            return 0
        fi
    fi
    while IFS= read -r line; do
        runner="$(runner_in "$line")"
        [ -n "$runner" ] || continue
        candidate="$(cd "$(dirname "$runner")/.." 2>/dev/null && pwd)" || continue
        if is_checkout "$candidate"; then
            printf '%s' "$candidate"
            return 0
        fi
    done < <(scheduled_runners)
    # Nothing found: keep $0's own root so the "not a git checkout" message
    # names the directory the user is actually looking at.
    printf '%s' "$SELF_ROOT"
}

ROOT="$(resolve_root)"
SCRIPT_NAME=auto-update
LOG="$STATE_DIR/auto-update.log"
LOCK="$STATE_DIR/update.lock"

QUIET=false
FORCE=false
MODE=run # run | check | status
JSON=false

# A scheduled run that finds the network down (the timer fires at resume or at
# login before DNS is up) retries inside the same run instead of waiting a full
# day. Overridable so the tests do not sleep.
: "${CUP_RETRY_TRIES:=3}"
: "${CUP_RETRY_SLEEP:=60}"
# How long a successful check is good for. Scheduled runs (--quiet) skip inside
# that window, which is what makes it safe to also run the job at load/boot:
# a laptop that is off at the scheduled minute checks when it comes back,
# without checking again on every login.
: "${CUP_MIN_CHECK_HOURS:=20}"

# log / say / die / usage / trim_log / take_lock - shared with session-ping.sh.
# Every copy of this script travels with lib.sh (install.sh gnome, the GNOME
# zip); a lone copy is a broken install, so say so instead of failing on the
# first `say`.
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh" 2>/dev/null || {
    echo "auto-update: lib.sh missing next to $0 - reinstall (./install.sh update)" >&2
    exit 1
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
    # No manifest when this is the installed copy and no checkout was found;
    # an empty version is a valid answer, a `sed: can't read` is not.
    [ -f "$ROOT/package.json" ] || return 0
    sed -nE 's/.*"version": *"([^"]+)".*/\1/p' "$ROOT/package.json" | head -1
}

# What the INSTALLED clients are actually running, which is not the same thing
# as the checkout version. A manual `git pull` moves the checkout forward while
# the GNOME extension, status line and MCP server stay on the old release; this
# script then compared checkout to latest, saw a match and never reinstalled -
# reporting "up to date" while the panel ran a version behind, indefinitely.
# Stamped after every successful reinstall; unknown before the first one.
deployed_version() {
    [ -f "$STATE_DIR/installed-version" ] && cat "$STATE_DIR/installed-version" && return 0
    # No stamp yet (an install from before install.sh started stamping): fall
    # back to a client that records its own version on disk - the GNOME
    # extension's metadata, or the macOS bundle's Info.plist.
    local meta="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions"
    meta="$meta/claude-usage-panel@fschmutz.github.io/metadata.json"
    if [ -f "$meta" ]; then
        sed -nE 's/.*"version-name": *"([^"]+)".*/\1/p' "$meta" | head -1
        return 0
    fi
    local plist="/Applications/ClaudeUsagePanel.app/Contents/Info.plist"
    [ -f "$plist" ] || return 0
    # Both the XML and the binary form answer to PlistBuddy/defaults; the app is
    # written with the XML one, so a plain grep of the following <string> works
    # and needs no macOS-only tool (this function also runs under the tests).
    sed -nE -e '/CFBundleShortVersionString/{n;s@.*<string>([^<]+)</string>.*@\1@p;}' "$plist" | head -1
}

stamp_deployed_version() {
    mkdir -p "$STATE_DIR" 2>/dev/null || return 0
    printf '%s\n' "$1" >"$STATE_DIR/installed-version" 2>/dev/null || true
    rm -f "$STATE_DIR/update-pending" 2>/dev/null || true
}

# A reinstall that is owed. Written before `install.sh update` runs and cleared
# only when it succeeds, so an install that failed - or a run that was killed
# between the fast-forward and the reinstall - is still owed on the next run.
# Without it the checkout already carries the new version, and every comparison
# that could notice ("checkout vs latest", "deployed vs latest", both) says up
# to date while the clients sit on the old release for good.
pending_version() {
    [ -f "$STATE_DIR/update-pending" ] && cat "$STATE_DIR/update-pending"
    return 0
}

mark_update_pending() {
    mkdir -p "$STATE_DIR" 2>/dev/null || return 0
    printf '%s\n' "$1" >"$STATE_DIR/update-pending" 2>/dev/null || true
}

# Highest released vX.Y.Z tag on the remote. Prints nothing when the lookup
# found none - and then REMOTE_ERROR says whether that was a failure (auth, DNS,
# a dead URL, no ssh-agent) or a reachable remote that has cut no release yet.
# Swallowing both into one empty string is what reported every one of them as
# "offline?" for two months, so nobody ever saw the real error.
# Both results are globals, not stdout: a `$(...)` would run the lookup in a
# subshell and the error would die with it, which is exactly how every failure
# came back as an empty string in the first place.
LATEST_REMOTE=""
REMOTE_ERROR=""
lookup_remote() {
    local ref tag best="" out status=0
    LATEST_REMOTE=""
    REMOTE_ERROR=""
    out="$(git -C "$ROOT" ls-remote --tags --refs origin 'v*' 2>&1)" || status=$?
    if [ "$status" -ne 0 ]; then
        # One line: the first fatal/error git printed ("Repository not found",
        # "Permission denied (publickey)", "Could not resolve host"). Not the
        # last line - that is the tail of git's advice paragraph, which says
        # nothing about what went wrong.
        REMOTE_ERROR="$(printf '%s' "$out" | grep -m1 -E '^(fatal|error|ssh|remote):' || true)"
        [ -n "$REMOTE_ERROR" ] || REMOTE_ERROR="$(printf '%s' "$out" | grep -m1 -v '^$' || true)"
        REMOTE_ERROR="${REMOTE_ERROR:-git ls-remote failed with status $status}"
        return 0
    fi
    while read -r _ ref; do
        tag="${ref#refs/tags/}"
        tag="${tag#v}"
        [[ "$tag" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || continue
        if [ -z "$best" ] || [ "$(version_compare "$tag" "$best")" = "1" ]; then
            best="$tag"
        fi
    done <<<"$out"
    LATEST_REMOTE="$best"
    [ -n "$best" ] || REMOTE_ERROR="the remote has no vX.Y.Z release tag"
}

# The same lookup, but a scheduled run gives the network a few chances: the
# timer fires on resume and at login, both of which routinely beat DNS.
lookup_remote_retrying() {
    local try=1
    while :; do
        lookup_remote
        [ -z "$LATEST_REMOTE" ] || return 0
        # A remote we reached that simply has no release tag is a final answer.
        case "$REMOTE_ERROR" in *'no vX.Y.Z release tag') return 0 ;; esac
        [ "$try" -lt "$CUP_RETRY_TRIES" ] || return 0
        log "remote unreachable ($REMOTE_ERROR) - retry $try/$((CUP_RETRY_TRIES - 1)) in ${CUP_RETRY_SLEEP}s"
        sleep "$CUP_RETRY_SLEEP"
        try=$((try + 1))
    done
}

# Everything the Node clients need is invisible to a scheduler: launchd and
# systemd hand the job a minimal PATH, so `command -v node` fails and the
# status line, the MCP server and claudectl were dropped from every update
# while the run still reported success. Put the usual version-manager shims
# back on PATH before the installer looks.
ensure_node_on_path() {
    command -v node >/dev/null && return 0
    local dir
    for dir in "$HOME/.volta/bin" "$HOME/.local/share/fnm/aliases/default/bin" \
        "$HOME/.asdf/shims" "$HOME/.local/bin" /opt/homebrew/bin /usr/local/bin \
        "$HOME/.nvm/current/bin"; do
        [ -x "$dir/node" ] || continue
        PATH="$dir:$PATH"
        export PATH
        log "added $dir to PATH for the reinstall (node is not on the scheduler's PATH)"
        return 0
    done
    # nvm keeps one directory per version and no stable symlink: take the
    # highest version, not the alphabetically last one (v9 sorts after v10).
    # shellcheck disable=SC2012  # version directories, not user filenames
    dir="$(ls -d "$HOME/.nvm/versions/node"/*/bin 2>/dev/null | sort -V | tail -1)"
    if [ -n "$dir" ] && [ -x "$dir/node" ]; then
        PATH="$dir:$PATH"
        export PATH
        log "added $dir to PATH for the reinstall (node is not on the scheduler's PATH)"
    fi
    command -v node >/dev/null
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

# Diverged from the upstream it last fetched: the run will refuse to merge, and
# the UIs used to show a cheerful "Update available" with a button that did
# nothing at all. Read-only - no fetch - so it reports on what the checkout
# already knows.
divergence_reason() {
    local upstream
    upstream="$(git -C "$ROOT" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)" ||
        return 0
    git -C "$ROOT" merge-base --is-ancestor HEAD "$upstream" 2>/dev/null && return 0
    echo "this checkout has commits $upstream does not - update it by hand"
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

# Minimal JSON string escaping - values here are paths and versions.
json_escape() {
    printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

if [ "$MODE" = status ]; then
    installed="$(local_version)"
    deployed="$(deployed_version)"
    [ -n "$deployed" ] || deployed="$installed"
    lookup_remote
    latest="$LATEST_REMOTE"
    last_check="never"
    [ -f "$STATE_DIR/last-check" ] && last_check="$(cat "$STATE_DIR/last-check")"

    # Why a scheduled run would decline to act - the part that was invisible
    # before: auto-update logs its reason and waits, so a user with a dirty or
    # diverged checkout saw "up to date" forever with no hint why.
    # repo_is_updatable prints nothing when the checkout is fine, so the
    # capture is the reason or empty.
    blocked_reason="$(repo_is_updatable)" || true
    [ -n "$blocked_reason" ] || blocked_reason="$(divergence_reason)"
    # A lookup that failed is not "up to date": say which failure it was.
    remote_error="$REMOTE_ERROR"

    # What the RUNNING GNOME Shell loaded, which the extension stamps at
    # enable(). New code on disk does not reach a running shell, so an update
    # that installed perfectly still needs a log out - and until this was
    # reported, every surface said "Up to date" while the old code ran.
    loaded_version=""
    [ -f "$STATE_DIR/loaded-version" ] && loaded_version="$(cat "$STATE_DIR/loaded-version")"
    reload_needed=false
    if [ -n "$loaded_version" ] && [ -n "$deployed" ] &&
        [ "$(version_compare "$deployed" "$loaded_version")" = 1 ]; then
        reload_needed=true
    fi

    # Compare against what is DEPLOYED, not what the checkout says. Those drift
    # apart the moment someone runs `git pull` by hand, and comparing the
    # checkout is what made this report "up to date" while the clients were a
    # release behind.
    update_available=false
    if [ -n "$latest" ] && [ "$(version_compare "$latest" "$deployed")" = 1 ]; then
        update_available=true
    fi
    # Checkout ahead of the clients: the code is here, it just was never
    # installed. `./install.sh update` fixes it; the daily run will not, because
    # it only reinstalls after a fast-forward it performed itself.
    clients_stale=false
    if [ "$(version_compare "$installed" "$deployed")" = 1 ] || [ -n "$(pending_version)" ]; then
        clients_stale=true
    fi

    if $JSON; then
        printf '{\n'
        printf '  "checkout": "%s",\n' "$(json_escape "$ROOT")"
        printf '  "installed": "%s",\n' "$(json_escape "$deployed")"
        printf '  "checkout_version": "%s",\n' "$(json_escape "$installed")"
        printf '  "latest": "%s",\n' "$(json_escape "$latest")"
        printf '  "updateAvailable": %s,\n' "$update_available"
        printf '  "clientsStale": %s,\n' "$clients_stale"
        printf '  "blocked": %s,\n' "$([ -n "$blocked_reason" ] && echo true || echo false)"
        printf '  "blockedReason": "%s",\n' "$(json_escape "$blocked_reason")"
        printf '  "remoteError": "%s",\n' "$(json_escape "$remote_error")"
        printf '  "loadedVersion": "%s",\n' "$(json_escape "$loaded_version")"
        printf '  "reloadNeeded": %s,\n' "$reload_needed"
        printf '  "lastCheck": "%s",\n' "$(json_escape "$last_check")"
        printf '  "log": "%s"\n' "$(json_escape "$LOG")"
        printf '}\n'
        exit 0
    fi

    printf 'checkout:   %s\n' "$ROOT"
    printf 'installed:  %s\n' "$deployed"
    [ "$installed" != "$deployed" ] && printf 'checkout:   %s  (code is newer than what is installed)\n' "$installed"
    printf 'latest:     %s\n' "$latest"
    printf 'update:     %s\n' "$($update_available && echo "available" || echo "up to date")"
    $clients_stale && printf 'action:     run ./install.sh update - the clients are behind the checkout\n'
    $reload_needed && printf 'action:     log out and back in - the shell still runs %s\n' "$loaded_version"
    [ -n "$blocked_reason" ] && printf 'blocked:    %s\n' "$blocked_reason"
    [ -n "$remote_error" ] && printf 'remote:     %s\n' "$remote_error"
    printf 'last check: %s\n' "$last_check"
    printf 'log:        %s\n' "$LOG"
    exit 0
fi

# Created only now, past the read-only --status branch above: a status query
# on a machine that has never run an update must leave its HOME as it found
# it (see scripts/lib.sh). The lock below is a mkdir inside this directory.
mkdir -p "$STATE_DIR"

# ── One run at a time ───────────────────────────────────────────────────────────
# A lock older than 6h is stale - a previous run was killed mid-flight.
if ! take_lock 360; then
    say "another update run is in progress - skipping"
    exit 0
fi

# ── Check ───────────────────────────────────────────────────────────────────────
# A scheduled run inside the freshness window is a no-op. That is what lets the
# job also fire at load/boot (a laptop that was off at the scheduled minute
# still gets its daily check) without checking on every single login.
if $QUIET && [ "$MODE" = run ] && ! $FORCE && [ -f "$STATE_DIR/last-check-epoch" ]; then
    last_epoch="$(cat "$STATE_DIR/last-check-epoch" 2>/dev/null || echo 0)"
    [ -n "${last_epoch//[!0-9]/}" ] || last_epoch=0
    age=$(($(date +%s) - ${last_epoch:-0}))
    if [ "$age" -ge 0 ] && [ "$age" -lt $((CUP_MIN_CHECK_HOURS * 3600)) ]; then
        log "skip: checked $((age / 60)) min ago (min interval ${CUP_MIN_CHECK_HOURS}h)"
        exit 0
    fi
fi

if ! reason="$(repo_is_updatable)"; then
    say "skip: $reason"
    exit 0
fi

have="$(local_version)"
[ -n "$have" ] || die "could not read the version from $ROOT/package.json"
# What the CLIENTS run. The checkout is not it: a manual pull, an interrupted
# reinstall or an installer that dropped a target all leave the two apart, and
# comparing the checkout is what made a stranded install report "up to date"
# forever and never retry.
deployed="$(deployed_version)"
[ -n "$deployed" ] || deployed="$have"

if $QUIET; then
    lookup_remote_retrying
else
    lookup_remote
fi
latest="$LATEST_REMOTE"
if [ -z "$latest" ]; then
    # Not a check: nothing was compared, so the timestamp must not move or the
    # freshness window above would swallow tomorrow's real check.
    say "skip: $REMOTE_ERROR - will retry"
    exit 0
fi
date '+%Y-%m-%dT%H:%M:%S%z' >"$STATE_DIR/last-check"
date +%s >"$STATE_DIR/last-check-epoch"

pending="$(pending_version)"
if [ "$(version_compare "$latest" "$deployed")" != "1" ] && [ -z "$pending" ] && ! $FORCE; then
    say "up to date (v$deployed, latest v$latest)"
    exit 0
fi

if [ "$MODE" = check ]; then
    if [ -n "$pending" ] && [ "$(version_compare "$latest" "$deployed")" != "1" ]; then
        say "reinstall owed: v$pending was fetched but never installed"
    else
        say "update available: v$deployed → v$latest"
    fi
    exit 10
fi

# ── Update ──────────────────────────────────────────────────────────────────────
say "updating v$deployed → v$latest"
upstream="$(git -C "$ROOT" rev-parse --abbrev-ref --symbolic-full-name '@{u}')"
# What this checkout last saw of its upstream, BEFORE the fetch moves it.
seen="$(git -C "$ROOT" rev-parse --verify --quiet "$upstream" || true)"
# --force for the tags only: a rewritten history re-points release tags that
# already exist here, and without it the fetch refuses them and dies. Tags are
# the upstream's to name; nothing local lives in them.
git -C "$ROOT" fetch --quiet --tags --force origin || die "git fetch failed"

# Move to the TAG, not to the branch tip. The version that was compared is the
# newest release; fast-forwarding to origin/main instead installs whatever was
# merged since it, under the release's version number.
target="v$latest"
git -C "$ROOT" rev-parse --verify --quiet "refs/tags/$target" >/dev/null ||
    target="$upstream"

# The checkout may already hold the release and only the clients be behind (a
# manual pull, or a reinstall that failed last time). Then there is nothing to
# fast-forward - go straight to the reinstall, which is the part that was
# missing.
if git -C "$ROOT" merge-base --is-ancestor "$target" HEAD 2>/dev/null; then
    say "the checkout already holds v$latest - reinstalling the clients (on v$deployed)"
# --ff-only: if the branch has diverged this refuses rather than merging or
# rewriting anything, and the run ends here with the checkout untouched -
# unless the upstream was rewritten under a checkout with nothing of its own.
elif ! git -C "$ROOT" merge --ff-only --quiet "$target" 2>>"$LOG"; then
    if [ -n "$seen" ] &&
        git -C "$ROOT" merge-base --is-ancestor HEAD "$seen" &&
        ! git -C "$ROOT" merge-base --is-ancestor "$seen" "$upstream"; then
        # repo_is_updatable already proved the tree clean; HEAD is contained
        # in what upstream used to be, so no commit here is lost.
        say "the upstream history was rewritten - following it (no local commits, clean tree)"
        git -C "$ROOT" reset --hard --quiet "$target" || die "could not follow the rewritten $upstream"
    else
        say "skip: $target is not a fast-forward from here - update by hand"
        exit 0
    fi
else
    say "fast-forwarded to $target"
fi

now="$(local_version)"
say "reinstalling the targets already installed (v$now)"
mark_update_pending "$now"

# The scheduler's PATH has no node on it, and without node the Node clients
# drop out of the install set silently. Put it back before asking.
ensure_node_on_path ||
    log "no node found on PATH or in the usual version-manager locations"

# `install.sh update` reinstalls only what `--list` reports as installed, so
# this never adds a client the user chose not to have. CUP_UPDATE_RUN tells the
# scheduler layer it is running inside the job it would otherwise restart.
if CUP_UPDATE_RUN=1 "$ROOT/install.sh" update >>"$LOG" 2>&1; then
    stamp_deployed_version "$now"
    say "updated to v$now"
    # Installed is not running: the shell keeps the extension it loaded until
    # the next login, and an MCP server keeps its code until Claude Code is
    # restarted. Say both, or the next reading of "did the fix land?" is wrong.
    notify "Claude Usage Panel updated" \
        "Now on v$now. GNOME: log out and back in. MCP: restart Claude Code."
else
    # No stamp: the deployed version stays where it was, so the next run sees
    # the clients are still behind and tries again instead of declaring
    # victory over a half-installed tree.
    say "install.sh update failed at v$now - see $LOG (will retry on the next run)"
    notify "Claude Usage Panel update failed" "Fetched v$now but the reinstall failed. See $LOG"
    exit 1
fi
