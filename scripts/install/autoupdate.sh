# shellcheck shell=bash
# Sourced by install.sh: the daily auto-update target.
#
# Schedules scripts/auto-update.sh once a day. That script is the one with all
# the safety rules (skips a dirty or diverged checkout, only ever fast-forwards,
# reinstalls just the targets already present) - here we only wire the schedule.
AU_UNIT="claude-usage-panel-update"                     # systemd user units
AU_LABEL="io.github.fschmutz.claude-usage-panel.update" # launchd agent
AU_CRON_TAG="# claude-usage-panel auto-update"          # cron marker line

_au_installed() { _sched_installed "$AU_UNIT" "$AU_LABEL" "$AU_CRON_TAG"; }

install_autoupdate() {
    info "Daily auto-update"
    if ! git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        skip_fatal "autoupdate: $ROOT is not a git checkout - nothing to update from"
        return 0
    fi
    local runner="$ROOT/scripts/auto-update.sh"
    act chmod +x "$runner"

    local sched_service
    sched_service="[Unit]
Description=Claude Usage Panel - daily update check
Documentation=https://github.com/fschmutz/claude-usage-panel

[Service]
Type=oneshot
ExecStart=$(_sched_systemd_word "$runner") --quiet"
    # Persistent=true runs a missed check on the next login (laptop was off);
    # RandomizedDelaySec spreads the load off a round hour.
    local sched_timer="[Unit]
Description=Claude Usage Panel - daily update check

[Timer]
OnCalendar=daily
RandomizedDelaySec=4h
Persistent=true

[Install]
WantedBy=timers.target"
    local sched_plist
    sched_plist="<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
<dict>
  <key>Label</key><string>$(_sched_xml_escape "$AU_LABEL")</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$(_sched_xml_escape "$runner")</string>
    <string>--quiet</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>11</integer><key>Minute</key><integer>17</integer></dict>
  <!-- A laptop that is asleep or off at 11:17 misses that slot entirely, which
       on a machine that is rarely awake at a fixed hour means no check for
       weeks. Running at load too turns every login into a candidate; the
       worker's own freshness window (CUP_MIN_CHECK_HOURS) keeps that to one
       real check a day. Same reason systemd gets Persistent=true. -->
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
</dict>
</plist>"
    local sched_cron
    sched_cron="17 11 * * * $(_sched_cron_word "$runner") --quiet  $AU_CRON_TAG"

    # scripts/auto-update.sh sets CUP_UPDATE_RUN when it is the one running
    # `install.sh update` - i.e. this target's own scheduled job is the caller.
    SCHED_NO_RELOAD=false
    # shellcheck disable=SC2034  # read by _sched_install in scheduler.sh
    [ "${CUP_UPDATE_RUN:-}" = 1 ] && SCHED_NO_RELOAD=true
    if ! _sched_install "$AU_UNIT" "$AU_LABEL" "$AU_CRON_TAG" "daily at 11:17" \
        "$sched_service" "$sched_timer" "$sched_plist" "$sched_cron"; then
        skip_fatal "autoupdate: no systemd, launchd or cron found to schedule it"
        return 0
    fi
    if $DRY; then
        ok "dry-run: no changes written"
        return 0
    fi
    echo "  Checks the newest released tag daily and installs it if it's newer."
    echo "  It skips a dirty or diverged checkout, and only reinstalls targets you already have."
    echo "  Now:  $runner --check    Status:  $runner --status"
    echo "  Off:  ./install.sh --uninstall autoupdate"
}

uninstall_autoupdate() {
    info "Daily auto-update"
    _sched_uninstall "$AU_UNIT" "$AU_LABEL" "$AU_CRON_TAG"
    ok "removed (no more daily checks)"
}
