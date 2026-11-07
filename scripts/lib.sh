# shellcheck shell=bash
# Shared plumbing for the scheduled workers (auto-update.sh, session-ping.sh):
# logging, the one-run-at-a-time lock, log trimming, --help, the node/claude
# search under a scheduler's PATH, the GitHub Release probe. Sourced, never
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

# ── Finding node and claude under a scheduler's PATH ─────────────────────────
# launchd, systemd and cron hand a job a minimal PATH, while node and the
# claude CLI usually live under a version manager. Both workers (the
# reinstall's node, the ping's claude) search this ONE list, in order:
# user-level bins, each manager's stable pointer (volta's shims, fnm's
# `default` alias, asdf's shims, nvm's `current` link), the system package
# dirs, then each manager's per-version dirs, highest version first, so a
# node upgrade does not strand a job on an old install. claude-code/tools.js
# `schedulerDirs` is the Node copy; tests/fixtures/scheduler-path.json pins
# both to the same answer for every manager layout.

# Subdirectory names of $1, highest version first ("v22.9.0" and "22.9.0"
# alike, v10 above v9). Numeric keys, not `sort -V`, which old macOS lacks.
_versions_desc() {
    local path name
    for path in "$1"/*; do
        [ -d "$path" ] || continue
        name="${path##*/}"
        printf '%s\t%s\n' "${name#v}" "$name"
    done | LC_ALL=C sort -t. -k1,1nr -k2,2nr -k3,3nr | cut -f2
}

# Every candidate bin dir, one per line, existing or not (PATH skips the
# missing ones). CUP_TEST_SYSTEM_BINS replaces the system dirs (the tests).
scheduler_bin_dirs() {
    local nvm="${NVM_DIR:-$HOME/.nvm}" fnm="${FNM_DIR:-$HOME/.local/share/fnm}"
    local asdf="${ASDF_DATA_DIR:-$HOME/.asdf}" v
    local sys="${CUP_TEST_SYSTEM_BINS-/opt/homebrew/bin:/usr/local/bin}"
    printf '%s\n' "$HOME/.local/bin" "$HOME/.claude/local" \
        "${VOLTA_HOME:-$HOME/.volta}/bin" "$fnm/aliases/default/bin" \
        "$asdf/shims" "$nvm/current/bin"
    [ -z "$sys" ] || printf '%s\n' "$sys" | tr ':' '\n'
    _versions_desc "$fnm/node-versions" | while IFS= read -r v; do
        printf '%s\n' "$fnm/node-versions/$v/installation/bin"
    done
    _versions_desc "$asdf/installs/nodejs" | while IFS= read -r v; do
        printf '%s\n' "$asdf/installs/nodejs/$v/bin"
    done
    _versions_desc "$nvm/versions/node" | while IFS= read -r v; do
        printf '%s\n' "$nvm/versions/node/$v/bin"
    done
}

# The list as a PATH fragment.
scheduler_path() {
    scheduler_bin_dirs | paste -sd: -
}

# The first candidate dir holding an executable $1; status 1 when none does.
scheduler_bin_dir_for() {
    local dir
    while IFS= read -r dir; do
        if [ -x "$dir/$1" ] && [ ! -d "$dir/$1" ]; then
            printf '%s\n' "$dir"
            return 0
        fi
    done <<<"$(scheduler_bin_dirs)"
    return 1
}

# ── Is a release tag a published GitHub Release? ─────────────────────────────
# >>> release_published - byte-identical in docs/install, which cannot source
# this file before it has a checkout; tests/install-bootstrap.test.js pins it.
# A tag counts once its GitHub Release exists: release.yml publishes one only
# for a commit whose ci-gate is green. $1 the origin URL, $2 the version
# without "v". 0 published, 1 not (yet), 2 cannot tell. CUP_RELEASE_PROBE
# replaces the lookup (the tests). An origin not on GitHub has no Releases:
# there the tag is the release. The REST API, not the html page, which
# renders a bare tag with 200 too; a rate limit (403/429) is "cannot tell".
release_published() {
    local url="$1" tag="$2" slug code
    if [ -n "${CUP_RELEASE_PROBE:-}" ]; then
        "$CUP_RELEASE_PROBE" "$tag" && return 0 || return $?
    fi
    case "$url" in
        *github.com[:/]*)
            slug="${url#*github.com[:/]}"
            slug="${slug%.git}"
            ;;
        *) return 0 ;;
    esac
    command -v curl >/dev/null 2>&1 || return 2
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 \
        -H 'Accept: application/vnd.github+json' \
        "https://api.github.com/repos/$slug/releases/tags/v$tag" 2>/dev/null)" || return 2
    case "$code" in
        200) return 0 ;;
        404) return 1 ;;
        *) return 2 ;;
    esac
}
# <<< release_published
