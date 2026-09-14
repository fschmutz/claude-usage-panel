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
        skip "autoupdate: $ROOT is not a git checkout - nothing to update from"
        return 0
    fi
    local runner="$ROOT/scripts/auto-update.sh"
    act chmod +x "$runner"

    local sched_service="[Unit]
Description=Claude Usage Panel - daily update check
Documentation=https://github.com/fschmutz/claude-usage-panel

[Service]
Type=oneshot
ExecStart=$runner --quiet"
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
  <key>RunAtLoad</key><false/>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
</dict>
</plist>"
    local sched_cron="17 11 * * * $runner --quiet  $AU_CRON_TAG"

    if ! _sched_install "$AU_UNIT" "$AU_LABEL" "$AU_CRON_TAG" "daily at 11:17" \
        "$sched_service" "$sched_timer" "$sched_plist" "$sched_cron"; then
        skip "autoupdate: no systemd, launchd or cron found to schedule it"
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
