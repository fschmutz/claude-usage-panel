# shellcheck shell=bash
# Sourced by install.sh: the one scheduler layer under the autoupdate and
# sessionping targets. Each target builds its own unit / plist / cron bodies
# and hands them to _sched_install; the systemd-vs-launchd-vs-cron choice, the
# writes, the activation, the dry-run narration and the uninstall live here
# once. Each job passes its four bodies (systemd service + timer, launchd
# plist, cron lines) as arguments, and they are written with one trailing
# newline exactly, so
# what lands on disk is byte-identical to the heredocs that used to write it -
# the Swift side pins the sessionping plist shape.

_sched_systemd_dir() { echo "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"; }
_sched_plist() { echo "$HOME/Library/LaunchAgents/$1.plist"; } # LABEL

# Which daily scheduler this machine offers: launchd | systemd | cron | none.
# CUP_TEST_SCHEDULER is a unit-test hook: it forces a branch so tests can
# exercise one deterministically (with the scheduler binary stubbed on PATH).
_sched_scheduler() {
    if [ -n "${CUP_TEST_SCHEDULER:-}" ]; then
        echo "$CUP_TEST_SCHEDULER"
        return 0
    fi
    if [ "$(uname -s)" = "Darwin" ] && command -v launchctl >/dev/null; then
        echo launchd
    elif command -v systemctl >/dev/null && [ -d /run/systemd/system ]; then
        echo systemd
    elif command -v crontab >/dev/null; then
        echo cron
    else
        echo none
    fi
}

# Write a unit/plist body, honouring --dry-run.
_sched_write() { # PATH BODY
    if $DRY; then
        echo "  would: write $1"
        return 0
    fi
    mkdir -p "$(dirname "$1")"
    printf '%s\n' "$2" >"$1"
}

# XML-escape a value going into a launchd plist. An install path may legally
# contain &, < or > - a "Dev & Ops" folder is enough - and interpolating one
# raw produces a plist launchd refuses to load, surfacing only as the
# unhelpful "could not load the agent". Mirrored by SessionPingAgent.xmlEscape
# (macos/Sources/ClaudeUsageCore) so the two writers of the sessionping plist
# stay byte-identical: the same three characters, & first so the
# substitutions cannot chain. Nothing has to unescape - the readers here only
# ever match integers and the --days= list, and the Swift side parses through
# PropertyListSerialization.
#
# not ${s//&/&amp;}: bash 5.2 reads & in a substitution replacement as the
# matched text (bash 3.2, the stock macOS one, does not), so the same
# expansion escapes differently depending on the shell. sed's \& is POSIX and
# means the same thing everywhere.
_sched_xml_escape() {
    printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

# Is a schedule with these names installed, on any of the three schedulers?
_sched_installed() { # UNIT LABEL TAG
    [ -f "$(_sched_systemd_dir)/$1.timer" ] && return 0
    [ -f "$(_sched_plist "$2")" ] && return 0
    if command -v crontab >/dev/null && crontab -l 2>/dev/null | grep -qF "$3"; then
        return 0
    fi
    return 1
}

# Install the schedule on whatever this machine offers. Returns 1 when there is
# no scheduler at all; the caller says what that means for its target.
# Set by a target whose own scheduled job is the one running this install (the
# daily update reinstalls the autoupdate target from inside the job). Only the
# launchd branch cares: see the comment there.
# shellcheck disable=SC2034  # set by scripts/install/autoupdate.sh
SCHED_NO_RELOAD=false

_sched_install() { # UNIT LABEL TAG WHEN SERVICE TIMER PLIST CRON
    local unit="$1" label="$2" tag="$3" when="$4"
    local service="$5" timer="$6" plist_body="$7" cron_body="$8" dir plist line
    case "$(_sched_scheduler)" in
        systemd)
            dir="$(_sched_systemd_dir)"
            _sched_write "$dir/$unit.service" "$service"
            _sched_write "$dir/$unit.timer" "$timer"
            act systemctl --user daemon-reload
            act systemctl --user enable --now "$unit.timer"
            $DRY || ok "systemd user timer enabled (systemctl --user list-timers | grep $unit)"
            ;;
        launchd)
            plist="$(_sched_plist "$label")"
            local loaded=false unchanged=false
            launchctl list "$label" >/dev/null 2>&1 && loaded=true
            if [ -f "$plist" ] && [ "$(cat "$plist" 2>/dev/null)" = "$plist_body" ]; then
                unchanged=true
            fi
            _sched_write "$plist" "$plist_body"
            if $DRY; then
                echo "  would: launchctl bootstrap gui/$(id -u) $plist"
            elif $loaded && $unchanged; then
                # Nothing to reload, and reloading is not free: see below.
                ok "launchd agent already loaded, unchanged ($when)"
            elif $loaded && ${SCHED_NO_RELOAD:-false}; then
                # This code is running INSIDE that agent's job. `launchctl
                # bootout` on it SIGTERMs the job's own process group, so the
                # bootstrap on the next line never runs, the agent stays
                # unloaded until the next login, and everything after this
                # point in the update - the remaining targets, the version
                # stamp, the notification - never happens either. The new
                # plist is on disk; launchd reads it when the job next loads.
                ok "launchd agent rewritten - the new schedule applies at the next login ($when)"
            else
                launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
                launchctl bootstrap "gui/$(id -u)" "$plist" >/dev/null 2>&1 ||
                    launchctl load -w "$plist" >/dev/null 2>&1 || true
                ok "launchd agent loaded ($when)"
            fi
            ;;
        cron)
            if $DRY; then
                while IFS= read -r line; do
                    if [ -n "$line" ]; then echo "  would: add crontab line: $line"; fi
                done <<<"$cron_body"
            else
                # Drop any previous lines of ours, then append - idempotent.
                {
                    crontab -l 2>/dev/null | grep -vF "$tag" || true
                    printf '%s\n' "$cron_body"
                } | crontab -
                ok "cron entries added ($when)"
            fi
            ;;
        *)
            return 1
            ;;
    esac
}

# Remove all three wirings regardless of what this machine currently offers,
# so a schedule left by an earlier setup can't survive an uninstall.
_sched_uninstall() { # UNIT LABEL TAG
    local unit="$1" label="$2" tag="$3" dir
    dir="$(_sched_systemd_dir)"
    if command -v systemctl >/dev/null; then
        if $DRY; then
            echo "  would: systemctl --user disable --now $unit.timer"
        else
            systemctl --user disable --now "$unit.timer" >/dev/null 2>&1 || true
        fi
    fi
    act rm -f "$dir/$unit.timer" "$dir/$unit.service"
    if command -v systemctl >/dev/null && ! $DRY; then
        systemctl --user daemon-reload >/dev/null 2>&1 || true
    fi
    if command -v launchctl >/dev/null; then
        if $DRY; then
            echo "  would: launchctl bootout gui/$(id -u)/$label"
        else
            launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
        fi
    fi
    act rm -f "$(_sched_plist "$label")"
    if command -v crontab >/dev/null; then
        if $DRY; then
            echo "  would: drop the '$tag' lines from your crontab"
        elif crontab -l 2>/dev/null | grep -qF "$tag"; then
            # `|| true`: grep -v selecting zero lines (ours were the only
            # entries) must not kill the uninstall under pipefail.
            { crontab -l 2>/dev/null | grep -vF "$tag" || true; } | crontab -
        fi
    fi
}
