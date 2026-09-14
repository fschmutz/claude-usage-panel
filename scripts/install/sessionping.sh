# shellcheck shell=bash
# Sourced by install.sh: the scheduled session-ping target.
#
# Schedules scripts/session-ping.sh at fixed local times so the 5-hour Claude
# Code session window opens on schedule instead of at the first real message of
# the day. Opt-in only (never auto-detected): every ping spends one haiku turn.
SP_UNIT="claude-usage-panel-sessionping"                     # systemd user units
SP_LABEL="io.github.fschmutz.claude-usage-panel.sessionping" # launchd agent
SP_CRON_TAG="# claude-usage-panel session-ping"              # cron marker line

_sp_installed() { _sched_installed "$SP_UNIT" "$SP_LABEL" "$SP_CRON_TAG"; }

# mon,wed,... / mon-fri / all / an already-numeric list → sorted unique 1..7
# list in `date +%u` numbering (1 = Monday). Prints nothing on invalid input.
_sp_normalize_days() {
    local spec d n list=""
    spec="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
    case "$spec" in
        "" | mon-fri)
            echo "1,2,3,4,5"
            return 0
            ;;
        all)
            echo "1,2,3,4,5,6,7"
            return 0
            ;;
    esac
    # Validate before the unquoted split below - a glob character in the spec
    # must not expand against the current directory.
    [[ "$spec" =~ ^[a-z0-9]+(,[a-z0-9]+)*$ ]] || return 1
    for d in ${spec//,/ }; do
        case "$d" in
            mon | 1) n=1 ;;
            tue | 2) n=2 ;;
            wed | 3) n=3 ;;
            thu | 4) n=4 ;;
            fri | 5) n=5 ;;
            sat | 6) n=6 ;;
            sun | 7) n=7 ;;
            *) return 1 ;;
        esac
        list="$list$n"$'\n'
    done
    printf '%s' "$list" | sort -u | paste -sd, -
}

install_sessionping() {
    info "Scheduled session pings"
    local runner="$ROOT/scripts/session-ping.sh"
    local times=() norm=() t h m days spec current

    # What is already scheduled, read back by the worker itself (it is the one
    # reader of the three scheduler formats): line 1 times, line 2 days. Lets
    # `update` and a bare reinstall preserve a custom schedule instead of
    # resetting to the default.
    current="$(bash "$runner" --schedule 2>/dev/null || true)"

    # Times: command line, else whatever is already scheduled, else the default.
    if [ ${#SP_TIMES[@]} -gt 0 ]; then
        times=("${SP_TIMES[@]}")
    else
        _lines_into times printf '%s\n' "$(printf '%s\n' "$current" | sed -n 1p | tr ' ' '\n')"
        [ ${#times[@]} -gt 0 ] || times=("05:30")
    fi
    for t in "${times[@]}"; do
        if [[ "$t" =~ ^([01]?[0-9]|2[0-3]):([0-5][0-9])$ ]]; then
            norm+=("$(printf '%02d:%s' "$((10#${t%%:*}))" "${t#*:}")")
        else
            echo "sessionping: invalid time '$t' (want HH:MM, 00:00-23:59)" >&2
            exit 2
        fi
    done
    times=("${norm[@]}")

    # Days: command line, else the list baked into the current schedule.
    spec="${SP_DAYS:-$(printf '%s\n' "$current" | sed -n 2p)}"
    if ! days="$(_sp_normalize_days "$spec")" || [ -z "$days" ]; then
        echo "sessionping: invalid --days '$spec' (want e.g. mon,wed,fri or mon-fri or all)" >&2
        exit 2
    fi

    echo "  schedule: at ${times[*]} on days $days (1 = Monday)"
    if ! command -v claude >/dev/null; then
        skip "claude CLI not found on PATH - pings will no-op until it is installed"
    fi
    act chmod +x "$runner"

    local entries="" intervals="" cron="" line
    for t in "${times[@]}"; do
        entries+="OnCalendar=*-*-* $t:00"$'\n'
        h="$((10#${t%%:*}))"
        m="$((10#${t#*:}))"
        intervals+="    <dict><key>Hour</key><integer>$h</integer><key>Minute</key><integer>$m</integer></dict>"$'\n'
        line="$m $h * * * $runner --quiet --days=$days  $SP_CRON_TAG"
        cron="${cron:+$cron$'\n'}$line"
    done
    local sched_service="[Unit]
Description=Claude Usage Panel - session-window ping
Documentation=https://github.com/fschmutz/claude-usage-panel

[Service]
Type=oneshot
ExecStart=$runner --quiet --days=$days"
    # Exact times are the point: no RandomizedDelaySec, and no catch-up on
    # wake (Persistent) - a late ping would only shift the window.
    local sched_timer="[Unit]
Description=Claude Usage Panel - session-window ping

[Timer]
${entries}Persistent=false

[Install]
WantedBy=timers.target"
    local sched_plist
    sched_plist="<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
<dict>
  <key>Label</key><string>$(_sched_xml_escape "$SP_LABEL")</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$(_sched_xml_escape "$runner")</string>
    <string>--quiet</string>
    <string>--days=$days</string>
  </array>
  <key>StartCalendarInterval</key>
  <array>
${intervals}  </array>
  <key>RunAtLoad</key><false/>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
</dict>
</plist>"
    local sched_cron="$cron"

    if ! _sched_install "$SP_UNIT" "$SP_LABEL" "$SP_CRON_TAG" "at ${times[*]}" \
        "$sched_service" "$sched_timer" "$sched_plist" "$sched_cron"; then
        skip "sessionping: no systemd, launchd or cron found to schedule it"
        return 0
    fi
    if $DRY; then
        ok "dry-run: no changes written"
        return 0
    fi
    echo "  Each ping is one haiku turn; it opens the 5h session window at that time."
    echo "  Change it any time: ./install.sh sessionping HH:MM [HH:MM ...] [--days=...]"
    echo "  Now:  $runner --force    Status:  $runner --status"
    echo "  Off:  ./install.sh --uninstall sessionping"
}

uninstall_sessionping() {
    info "Scheduled session pings"
    _sched_uninstall "$SP_UNIT" "$SP_LABEL" "$SP_CRON_TAG"
    ok "removed (no more session pings)"
}
