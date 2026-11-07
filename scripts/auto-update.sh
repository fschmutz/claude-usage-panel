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
# What it compares is the DEPLOYED version - $STATE_DIR/installed-version,
# written by install.sh on every successful run - never the checkout's
# package.json: a manual pull, an interrupted reinstall or a dropped target
# all leave the two apart, and comparing the checkout read "up to date" while
# the clients stayed behind for good. An owed reinstall is retried.
#
# A scheduled run (--quiet) also skips when the last successful check is less
# than CUP_MIN_CHECK_HOURS old, which is what lets the job fire at login and at
# resume as well as daily: a laptop that was off at the scheduled minute still
# gets its check, without one per login.
#
# It refuses to touch a checkout it does not own: a dirty worktree, a detached
# HEAD, a branch with no upstream, or a missing remote each make it skip. The
# git writes are `merge --ff-only` to the release tag, and one reset, to that
# same tag only: when the upstream history was rewritten, a checkout holding
# NOTHING of its own (clean tree, every commit already on the upstream it had
# fetched) follows it instead of being stranded. A missing tag is a skip, never
# a fallback to the branch tip; a tag that moved is refused (see "Release tag
# trust" below).
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
# (scripts/install/scheduler.sh) and XML-escapes it in a plist, so each form
# is unquoted the way it was written, never split on blanks.
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
# the order the macOS app tries them: the copy `install.sh gnome` puts beside
# the extension has no package.json and no git above it.
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
    # The pointer install.sh drops on every successful run: the only source
    # for an install with no scheduled job (a zip, or autoupdate uninstalled).
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

# A scheduled run that finds the network down (resume, login before DNS)
# retries inside the same run. Overridable so the tests do not sleep.
: "${CUP_RETRY_TRIES:=3}"
: "${CUP_RETRY_SLEEP:=60}"
# How long a successful check is good for: scheduled runs (--quiet) skip
# inside it, so the job can also fire at load/boot without a check per login.
: "${CUP_MIN_CHECK_HOURS:=20}"

# log / say / die / usage / take_lock / the node search / release_published.
# Every copy of this script travels with lib.sh; a lone copy is a broken install.
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
        if ((10#$x != 10#$y)); then
            if ((10#$x > 10#$y)); then echo 1; else echo -1; fi
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

# What the INSTALLED clients run (not the checkout version, which a manual
# pull moves alone). Stamped after every successful reinstall.
deployed_version() {
    [ -f "$STATE_DIR/installed-version" ] && cat "$STATE_DIR/installed-version" && return 0
    # No stamp yet (an older install): a client's own version on disk.
    local meta="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions"
    meta="$meta/claude-usage-panel@fschmutz.github.io/metadata.json"
    if [ -f "$meta" ]; then
        sed -nE 's/.*"version-name": *"([^"]+)".*/\1/p' "$meta" | head -1
        return 0
    fi
    # /Applications, or ~/Applications for an account without admin
    # (scripts/install/macos.sh)
    local plist="${CUP_TEST_SYSTEM_APPS:-/Applications}/ClaudeUsagePanel.app/Contents/Info.plist"
    [ -f "$plist" ] || plist="$HOME/Applications/ClaudeUsagePanel.app/Contents/Info.plist"
    [ -f "$plist" ] || return 0
    # The app writes the XML form: a sed of the next <string>, no macOS tool.
    sed -nE -e '/CFBundleShortVersionString/{n;s@.*<string>([^<]+)</string>.*@\1@p;}' "$plist" | head -1
}

stamp_deployed_version() {
    mkdir -p "$STATE_DIR" 2>/dev/null || return 0
    printf '%s\n' "$1" >"$STATE_DIR/installed-version" 2>/dev/null || true
    rm -f "$STATE_DIR/update-pending" 2>/dev/null || true
}

# A reinstall that is owed: written before `install.sh update` runs, cleared
# only when it succeeds, so a failed or killed reinstall is retried next run.
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
# Both results are globals, not stdout: a `$(...)` subshell swallowed every
# error into one empty string, reported as "offline?" for two months.
# A tag is installed only once its GitHub Release exists (release_published in
# lib.sh), so a tag pushed by hand on a red commit never reaches anyone.
LATEST_REMOTE=""
REMOTE_ERROR=""
lookup_remote() {
    local ref tag best="" out status=0 tags="" rc url
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
    url="$(git -C "$ROOT" remote get-url origin 2>/dev/null || true)"
    while read -r _ ref; do
        tag="${ref#refs/tags/}"
        tag="${tag#v}"
        [[ "$tag" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || continue
        tags="$tags$tag"$'\n'
    done <<<"$out"
    # Newest first; the first one with a published Release wins.
    for tag in $(printf '%s' "$tags" | sort -t. -k1,1nr -k2,2nr -k3,3nr); do
        rc=0
        release_published "$url" "$tag" || rc=$?
        if [ "$rc" -eq 0 ]; then
            best="$tag"
            break
        fi
        if [ "$rc" -eq 1 ]; then
            log "v$tag is tagged but has no published release (red CI, or still publishing) - skipped"
            continue
        fi
        REMOTE_ERROR="cannot confirm v$tag has a published release on GitHub"
        return 0
    done
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

# Without node on PATH the status line, the MCP server and claudectl dropped
# out of every update while the run still reported success. A scheduler's PATH
# has none: take it from the shared version-manager search (lib.sh).
ensure_node_on_path() {
    command -v node >/dev/null && return 0
    local dir
    dir="$(scheduler_bin_dir_for node)" || return 1
    PATH="$dir:$PATH"
    export PATH
    log "added $dir to PATH for the reinstall (node is not on the scheduler's PATH)"
}

# Desktop notification, best effort - never fail the run over it. On macOS the
# text travels as run-handler arguments, never inside the AppleScript source
# (NotifyScript.swift does the same): a quote or a backslash in it cannot
# change the program. The first argument is a fixed word, so a body starting
# with `-` is not read as an osascript option.
notify() {
    local title="$1" body="$2"
    if command -v notify-send >/dev/null; then
        notify-send -a "Claude Usage Panel" "$title" "$body" >/dev/null 2>&1 || true
    elif command -v osascript >/dev/null; then
        osascript -e 'on run argv' \
            -e 'display notification (item 2 of argv) with title (item 3 of argv)' \
            -e 'end run' notify "$body" "$title" >/dev/null 2>&1 || true
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

# ── Release tag trust ───────────────────────────────────────────────────────────
# Only the one release tag is fetched, never `--tags --force`, which followed
# any tag re-pointed upstream. A release tag is immutable here: its object id
# is recorded in $TAG_RECORD the first time the checkout moves to it, and a
# different id under the same name - on origin against the checkout's own tag
# or against the record - is refused, loudly. With $ALLOWED_SIGNERS present
# (an ssh allowed-signers file, see wiki/Installation.md) the tag must also
# carry an SSH signature by one of its keys; absent, no signature is required.
TAG_RECORD="$STATE_DIR/release-tags"
ALLOWED_SIGNERS="$STATE_DIR/allowed-signers"

recorded_tag_id() {
    [ -f "$TAG_RECORD" ] && awk -v t="$1" '$1 == t {print $2; exit}' "$TAG_RECORD"
    return 0
}

record_tag_id() { # tag id
    [ -z "$(recorded_tag_id "$1")" ] || return 0
    printf '%s %s\n' "$1" "$2" >>"$TAG_RECORD"
}

# Fetch $1 from origin and accept it only if it is the tag already known by
# that name and, when required, signed by an allowed key; then the local tag
# points at exactly what was checked. Prints the reason and returns 1 on any
# refusal ("REFUSED" first when the tag itself is untrustworthy).
fetch_release_tag() {
    local tag="$1" fetched mine known
    if ! git -C "$ROOT" fetch --quiet --no-tags origin "refs/tags/$tag" 2>>"$LOG" ||
        ! fetched="$(git -C "$ROOT" rev-parse --verify --quiet FETCH_HEAD)"; then
        echo "could not fetch $tag from origin - will retry"
        return 1
    fi
    mine="$(git -C "$ROOT" rev-parse --verify --quiet "refs/tags/$tag" || true)"
    known="$(recorded_tag_id "$tag")"
    if [ -n "$mine" ] && [ "$mine" != "$fetched" ]; then
        echo "REFUSED: $tag on origin is $fetched, but this checkout has $tag at $mine - a release tag was moved"
        return 1
    fi
    if [ -n "$known" ] && [ "$known" != "$fetched" ]; then
        echo "REFUSED: $tag on origin is $fetched, but $known was installed as $tag - a release tag was moved"
        return 1
    fi
    # gpg.*program=false: the allowed-signers file is the only trust anchor,
    # so a GPG or X.509 signature (checked against some keyring) never passes.
    if [ -f "$ALLOWED_SIGNERS" ] &&
        ! git -C "$ROOT" -c gpg.ssh.allowedSignersFile="$ALLOWED_SIGNERS" \
            -c gpg.program=false -c gpg.openpgp.program=false -c gpg.x509.program=false \
            verify-tag "$fetched" >>"$LOG" 2>&1; then
        echo "REFUSED: $tag is not signed by a key in $ALLOWED_SIGNERS"
        return 1
    fi
    [ -n "$mine" ] || git -C "$ROOT" update-ref "refs/tags/$tag" "$fetched" "" || {
        echo "could not create the local tag $tag"
        return 1
    }
}

# ── Modes ───────────────────────────────────────────────────────────────────────
parse_args() {
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
}

# Minimal JSON string escaping - values here are paths and versions.
json_escape() {
    printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# --status: read-only, creates nothing (see scripts/lib.sh).
status_report() {
    local installed deployed latest last_check blocked_reason remote_error
    local loaded_version reload_needed update_available clients_stale
    installed="$(local_version)"
    deployed="$(deployed_version)"
    [ -n "$deployed" ] || deployed="$installed"
    lookup_remote
    latest="$LATEST_REMOTE"
    last_check="never"
    [ -f "$STATE_DIR/last-check" ] && last_check="$(cat "$STATE_DIR/last-check")"

    # Why a scheduled run would decline to act: auto-update logs its reason
    # and waits, so a dirty or diverged checkout read "up to date" forever with
    # no hint why. repo_is_updatable prints nothing when the checkout is fine.
    blocked_reason="$(repo_is_updatable)" || true
    [ -n "$blocked_reason" ] || blocked_reason="$(divergence_reason)"
    # A lookup that failed is not "up to date": say which failure it was.
    remote_error="$REMOTE_ERROR"

    # What the RUNNING GNOME Shell loaded, which the extension stamps at
    # enable(). New code on disk does not reach a running shell, so an update
    # that installed perfectly still needs a log out.
    loaded_version=""
    [ -f "$STATE_DIR/loaded-version" ] && loaded_version="$(cat "$STATE_DIR/loaded-version")"
    reload_needed=false
    if [ -n "$loaded_version" ] && [ -n "$deployed" ] &&
        [ "$(version_compare "$deployed" "$loaded_version")" = 1 ]; then
        reload_needed=true
    fi

    # Compare against what is DEPLOYED, not what the checkout says: those
    # drift apart on a manual `git pull`.
    update_available=false
    if [ -n "$latest" ] && [ "$(version_compare "$latest" "$deployed")" = 1 ]; then
        update_available=true
    fi
    # Checkout ahead of the clients: the code is here, it was never installed.
    # `./install.sh update` fixes it; the daily run will not, because it only
    # reinstalls after a fast-forward it performed itself.
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
        return 0
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
}

# The check shared by --check and a run: sets DEPLOYED, LATEST and PENDING, or
# exits (skipped, up to date). A scheduled run inside the freshness window is
# a no-op, which is what lets the job also fire at load and at resume without
# checking on every login.
check_release() {
    local last_epoch age reason have
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
    # What the CLIENTS run, not the checkout (see the header).
    DEPLOYED="$(deployed_version)"
    [ -n "$DEPLOYED" ] || DEPLOYED="$have"
    if $QUIET; then lookup_remote_retrying; else lookup_remote; fi
    LATEST="$LATEST_REMOTE"
    if [ -z "$LATEST" ]; then
        # Not a check: nothing was compared, so the timestamp must not move or
        # the freshness window would swallow tomorrow's real check.
        say "skip: $REMOTE_ERROR - will retry"
        exit 0
    fi
    date '+%Y-%m-%dT%H:%M:%S%z' >"$STATE_DIR/last-check"
    date +%s >"$STATE_DIR/last-check-epoch"
    PENDING="$(pending_version)"
    if [ "$(version_compare "$LATEST" "$DEPLOYED")" != "1" ] && [ -z "$PENDING" ] && ! $FORCE; then
        say "up to date (v$DEPLOYED, latest v$LATEST)"
        exit 0
    fi
}

# --check: the update is available (exit 10).
report_check() {
    if [ -n "$PENDING" ] && [ "$(version_compare "$LATEST" "$DEPLOYED")" != "1" ]; then
        say "reinstall owed: v$PENDING was fetched but never installed"
    else
        say "update available: v$DEPLOYED → v$LATEST"
    fi
    exit 10
}

# Move the checkout to the verified release tag - never to the branch tip,
# which carries unreleased commits under the release's version number, and
# never to anything when the tag cannot be fetched or trusted.
move_to_release() {
    local target="v$LATEST" upstream seen reason
    say "updating v$DEPLOYED → v$LATEST"
    upstream="$(git -C "$ROOT" rev-parse --abbrev-ref --symbolic-full-name '@{u}')"
    # What this checkout last saw of its upstream, BEFORE the fetch moves it.
    seen="$(git -C "$ROOT" rev-parse --verify --quiet "$upstream" || true)"
    git -C "$ROOT" fetch --quiet --no-tags origin || die "git fetch failed"
    if ! reason="$(fetch_release_tag "$target")"; then
        case "$reason" in
            REFUSED*)
                say "$reason - nothing installed; check the repository before trusting it again"
                notify "Claude Usage Panel update refused" "$reason"
                exit 1
                ;;
        esac
        say "skip: $reason"
        exit 0
    fi
    # The checkout may already hold the release and only the clients be behind
    # (a manual pull, a reinstall that failed last time): straight to the
    # reinstall, which is the part that was missing.
    if git -C "$ROOT" merge-base --is-ancestor "$target" HEAD 2>/dev/null; then
        say "the checkout already holds v$LATEST - reinstalling the clients (on v$DEPLOYED)"
    # --ff-only: a diverged branch is refused rather than merged or rewritten,
    # unless the upstream was rewritten under a checkout with nothing of its own.
    elif ! git -C "$ROOT" merge --ff-only --quiet "$target" 2>>"$LOG"; then
        if [ -n "$seen" ] &&
            git -C "$ROOT" merge-base --is-ancestor HEAD "$seen" &&
            ! git -C "$ROOT" merge-base --is-ancestor "$seen" "$upstream"; then
            # repo_is_updatable proved the tree clean; HEAD is contained in what
            # upstream used to be, so no commit here is lost. The reset goes to
            # the verified tag and nowhere else.
            say "the upstream history was rewritten - following it (no local commits, clean tree)"
            git -C "$ROOT" reset --hard --quiet "$target" || die "could not follow the rewritten $upstream"
        else
            say "skip: $target is not a fast-forward from here - update by hand"
            exit 0
        fi
    else
        say "fast-forwarded to $target"
    fi
    record_tag_id "$target" "$(git -C "$ROOT" rev-parse "refs/tags/$target")"
}

# `install.sh update` reinstalls only what `--list` reports as installed, so
# this never adds a client the user chose not to have. CUP_UPDATE_RUN tells
# the scheduler layer it is running inside the job it would otherwise restart.
reinstall() {
    local now
    now="$(local_version)"
    say "reinstalling the targets already installed (v$now)"
    mark_update_pending "$now"
    ensure_node_on_path ||
        log "no node found on PATH or in the usual version-manager locations"
    if CUP_UPDATE_RUN=1 "$ROOT/install.sh" update >>"$LOG" 2>&1; then
        stamp_deployed_version "$now"
        say "updated to v$now"
        # Installed is not running: the shell keeps the extension it loaded
        # until the next login, an MCP server its code until Claude Code
        # restarts. Say both, or "did the fix land?" is answered wrong.
        notify "Claude Usage Panel updated" \
            "Now on v$now. GNOME: log out and back in. MCP: restart Claude Code."
    else
        # No stamp: the next run sees the clients are still behind and tries
        # again instead of declaring victory over a half-installed tree.
        say "install.sh update failed at v$now - see $LOG (will retry on the next run)"
        notify "Claude Usage Panel update failed" "Fetched v$now but the reinstall failed. See $LOG"
        exit 1
    fi
}

main() {
    parse_args "$@"
    if [ "$MODE" = status ]; then
        status_report
        exit 0
    fi
    # Created only past the read-only --status: the lock is a mkdir inside it.
    mkdir -p "$STATE_DIR"
    # A lock older than 6h is stale - a previous run was killed mid-flight.
    if ! take_lock 360; then
        say "another update run is in progress - skipping"
        exit 0
    fi
    check_release
    [ "$MODE" != check ] || report_check
    move_to_release
    reinstall
}

main "$@"
