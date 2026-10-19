# shellcheck shell=bash
# Sourced by install.sh: the two Awake targets.
#
#   awake     the recovery backstop + the claudectl CLI + the panel section.
#             This is the safe half: the machine is held awake by a CHILD
#             process (caffeinate / systemd-inhibit), so nothing persistent is
#             changed and nothing can be left behind.
#   awakelid  closed-lid mode, which IS persistent on macOS: the narrow
#             sudoers rule for the four exact pmset commands. A separate,
#             explicit target on purpose - it is the one step that asks for
#             your password, and the one mode that can cook a laptop in a bag.
#
# Both are opt-in (never auto-detected). The panels keep the section off by
# default (awake-enabled / awakeEnabled) and lid mode off inside it
# (awake-lid-enabled / awakeLidEnabled).
AW_UNIT="claude-usage-panel-awake"                     # systemd user units
AW_LABEL="io.github.fschmutz.claude-usage-panel.awake"  # launchd agent
AW_CRON_TAG="# claude-usage-panel awake backstop"       # cron marker line
AW_SUDOERS=/etc/sudoers.d/claude-usage-panel-awake

_awake_installed() { _sched_installed "$AW_UNIT" "$AW_LABEL" "$AW_CRON_TAG"; }

# Installed = the rule is on this machine. A file test, not a sudo call:
# installed_targets runs under a scheduler's PATH and must never prompt.
_awakelid_installed() { [ -f "$AW_SUDOERS" ]; }

# Show (or hide) the Awake section in every panel this machine has; a missing
# panel is fine. KEY is the GSettings key, VALUE true|false.
_awake_toggle() { # KEY DEFAULTS_KEY true|false
    local schemas="$HOME/.local/share/gnome-shell/extensions/$UUID/schemas"
    if [ -d "$schemas" ] && command -v gsettings >/dev/null &&
        grep -qs "$1" "$schemas"/*.xml; then
        act gsettings --schemadir "$schemas" set org.gnome.shell.extensions.claude-usage-panel "$1" "$3"
    fi
    if [ "$(uname -s)" = Darwin ]; then
        act defaults write io.github.fschmutz.claude-usage-panel "$2" -bool "$3"
    fi
}

# Whether `sudo -n` already grants all four commands, asked WITHOUT running
# any of them: `sudo -n -l <command>` answers from the policy alone, so
# nothing about this machine's power state changes.
_awake_rule_effective() {
    local argv
    for argv in \
        "-a disablesleep 1" "-a disablesleep 0" \
        "-b lowpowermode 1" "-b lowpowermode 0"; do
        # shellcheck disable=SC2086  # the argv is deliberately word-split
        sudo -n -l /usr/bin/pmset $argv >/dev/null 2>&1 || return 1
    done
    return 0
}

install_awake() {
    info "Awake: keep this machine awake while Claude Code works"
    if ! command -v node >/dev/null; then
        skip_fatal "awake: Node.js not found on PATH - the holder and claudectl run node"
        return 0
    fi
    _cli_installed || install_cli
    _install_node_tree
    local runner="$ROOT/scripts/awake-backstop.sh"
    act chmod +x "$runner"

    # The backstop runs every minute, like Insomnia's recovery agent: the one
    # thing that must still work when the panel is gone.
    local sched_service sched_timer sched_plist sched_cron
    sched_service="[Unit]
Description=Claude Usage Panel - awake recovery backstop
Documentation=https://github.com/fschmutz/claude-usage-panel

[Service]
Type=oneshot
ExecStart=$(_sched_systemd_word "$runner") --quiet"
    sched_timer="[Unit]
Description=Claude Usage Panel - awake recovery backstop

[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
AccuracySec=15s
Persistent=false

[Install]
WantedBy=timers.target"
    sched_plist="<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
<dict>
  <key>Label</key><string>$(_sched_xml_escape "$AW_LABEL")</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$(_sched_xml_escape "$runner")</string>
    <string>--quiet</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>60</integer>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
</dict>
</plist>"
    sched_cron="* * * * * $(_sched_cron_word "$runner") --quiet  $AW_CRON_TAG"

    if ! _sched_install "$AW_UNIT" "$AW_LABEL" "$AW_CRON_TAG" "every minute" \
        "$sched_service" "$sched_timer" "$sched_plist" "$sched_cron"; then
        skip_fatal "awake: no systemd, launchd or cron found to run the recovery backstop"
        return 0
    fi
    # A reinstall keeps the user's own choice: only a first install turns it on.
    [ "${action:-install}" = update ] || _awake_toggle awake-enabled awakeEnabled true
    if $DRY; then
        ok "dry-run: no changes written"
        return 0
    fi
    ok "installed"
    echo "  Start:   claudectl awake on --for 2h   |   claudectl awake on --while-sessions"
    echo "  Status:  claudectl awake status        |   Stop: claudectl awake off"
    echo "  Backstop: $runner --status"
    echo "  Closed-lid mode is a separate, explicit step: ./install.sh awakelid"
}

uninstall_awake() {
    info "Awake: keep this machine awake while Claude Code works"
    _awake_toggle awake-enabled awakeEnabled false
    # End any session first: removing the backstop while something is held
    # would take away the one thing that could still release it.
    if ! $DRY && command -v node >/dev/null && [ -x "$HOME/.local/bin/claudectl" ]; then
        "$HOME/.local/bin/claudectl" awake off >/dev/null 2>&1 || true
    fi
    _sched_uninstall "$AW_UNIT" "$AW_LABEL" "$AW_CRON_TAG"
    _prune_node_tree
    ok "removed (nothing is holding this machine awake any more)"
}

install_awakelid() {
    info "Awake: closed-lid mode (EXPERIMENTAL)"
    echo "  A machine that cannot sleep with the lid shut must stay on a hard,"
    echo "  ventilated surface - never in a closed bag. See wiki/Awake.md."
    _awake_installed || install_awake
    if [ "$(uname -s)" != Darwin ]; then
        # Linux needs no root and no file: systemd-inhibit takes a
        # handle-lid-switch inhibitor as your own user whenever polkit allows
        # it (the default on a local seat).
        if ! command -v systemd-inhibit >/dev/null; then
            skip_fatal "awakelid: systemd-inhibit not found - closed-lid mode needs systemd-logind"
            return 0
        fi
        echo "  Linux: a logind inhibitor (--what=handle-lid-switch), taken as you."
        echo "  No root, no file, nothing to undo: it goes away with the holder."
        echo "  If polkit refuses it, see wiki/Awake.md (org.freedesktop.login1.inhibit-handle-lid-switch)."
        [ "${action:-install}" = update ] || _awake_toggle awake-lid-enabled awakeLidEnabled true
        $DRY || ok "closed-lid mode available: claudectl awake on --for 2h --lid"
        return 0
    fi

    # macOS: the ONLY privileged step this project has. Four exact commands,
    # nothing else, for this user alone - the shape Insomnia's installer uses.
    # The user is asked of the system, never read from $USER: a scheduler
    # (the daily update) or `env -i` may not set it, and under `set -u` an
    # unset USER killed the target before it said anything.
    local me
    me="$(id -un)"
    if $DRY; then
        echo "  would: write $AW_SUDOERS (four pmset commands for $me, validated with visudo -c)"
        echo "  would: verify 'sudo -n -l /usr/bin/pmset …' grants all four"
        ok "dry-run: no changes written"
        return 0
    fi
    local tmp
    tmp="$(mktemp)"
    node -e '
      import("'"$ROOT"'/claude-usage-panel@fschmutz.github.io/lib/pure/awake.js")
        .then((m) => process.stdout.write(m.awakeSudoersBody(process.argv[1])));
    ' "$me" >"$tmp" || {
        rm -f "$tmp"
        skip_fatal "awakelid: could not render the sudoers rule (node failed)"
        return 0
    }
    echo "  Writing $AW_SUDOERS (asks for your password once)"
    if sudo visudo -cf "$tmp" >/dev/null; then
        sudo install -m 0440 -o root -g wheel "$tmp" "$AW_SUDOERS"
    else
        rm -f "$tmp"
        skip_fatal "awakelid: the sudoers file failed visudo validation - nothing was written"
        return 0
    fi
    rm -f "$tmp"
    # Proven, not assumed: without the rule in force no session can undo
    # pmset, and the backstop would have nothing to recover with.
    if _awake_rule_effective; then
        ok "sudoers rule verified"
    else
        skip_fatal "awakelid: 'sudo -n pmset' is still not permitted - check $AW_SUDOERS"
        return 0
    fi
    [ "${action:-install}" = update ] || _awake_toggle awake-lid-enabled awakeLidEnabled true
    ok "closed-lid mode available: claudectl awake on --for 2h --lid"
}

uninstall_awakelid() {
    info "Awake: closed-lid mode (EXPERIMENTAL)"
    _awake_toggle awake-lid-enabled awakeLidEnabled false
    if [ "$(uname -s)" = Darwin ] && [ -f "$AW_SUDOERS" ]; then
        # Give sleep back before the rule that allows it goes away.
        if ! $DRY && [ -x "$HOME/.local/bin/claudectl" ]; then
            "$HOME/.local/bin/claudectl" awake recover --force >/dev/null 2>&1 || true
        fi
        if $DRY; then
            echo "  would: sudo rm -f $AW_SUDOERS"
        else
            sudo rm -f "$AW_SUDOERS" || {
                skip_fatal "awakelid: could not remove $AW_SUDOERS - remove it by hand"
                return 0
            }
        fi
    fi
    ok "removed (closed-lid mode is off; the awake target itself is untouched)"
}
