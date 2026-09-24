# shellcheck shell=bash
# Sourced by install.sh: the claudectl target (aliases: accounts, tabs).
#
# A shim on PATH in front of claude-code/claudectl.js (installed with the
# shared Node tree): `claudectl account use PERSO`, `claudectl session open`.
# The saved logins and the session snapshots live under the panel's state dir
# (0600); see the wiki pages Accounts and Tabs. Plus a schedule that runs
# `claudectl session autosave` every 30 minutes, so the running sessions are
# always in a snapshot less than half an hour old - a crash or a reboot loses
# nothing. autosave only writes when the set of sessions changed and keeps the
# newest 48 autos (one day).
CLI_BIN="$HOME/.local/bin/claudectl"
CLI_JS="$NODE_TREE/claude-code/claudectl.js"
CLI_UNIT="claude-usage-panel-autosave"                     # systemd user units
CLI_LABEL="io.github.fschmutz.claude-usage-panel.autosave" # launchd agent
CLI_CRON_TAG="# claude-usage-panel session autosave"       # cron marker line
# Before 2.0 the accounts CLI was its own binary. Its shim is ours to remove
# (recognised by the marker line we wrote in it), never a file we did not write.
CLI_LEGACY_BIN="$HOME/.local/bin/claude-account"
CLI_SHIM_MARK="# claude-usage-panel:"

_cli_installed() {
    [ -x "$CLI_BIN" ] && return 0
    # a pre-2.0 install: report it so `update` migrates it to claudectl
    [ -f "$CLI_LEGACY_BIN" ] && grep -qF "$CLI_SHIM_MARK" "$CLI_LEGACY_BIN"
}

_cli_drop_legacy() {
    if [ -f "$CLI_LEGACY_BIN" ] && grep -qF "$CLI_SHIM_MARK" "$CLI_LEGACY_BIN"; then
        act rm -f "$CLI_LEGACY_BIN"
    fi
}

install_cli() {
    info "claudectl CLI (account + session, autosave every 30 min)"
    if ! command -v node >/dev/null; then
        skip_fatal "cli: Node.js not found on PATH"
        return 0
    fi
    _install_node_tree
    _cli_drop_legacy
    act mkdir -p "$(dirname "$CLI_BIN")"
    # Schedulers and GUI apps (the macOS app's Reopen, the GNOME preferences)
    # run with a minimal PATH that rarely holds a volta/nvm node: the job
    # calls the node found now by its absolute path, and the shim falls back
    # to it when `node` is not on the caller's PATH.
    local node_bin
    node_bin="$(command -v node)"
    if $DRY; then
        echo "  would: write $CLI_BIN (exec node $CLI_JS)"
    else
        # rm first: a symlink left at this path would be written through.
        rm -f "$CLI_BIN"
        # shellcheck disable=SC2016 # the $(...) and "$@" are the generated shim's, expanded when it runs
        printf '#!/bin/sh\n%s claudectl\nNODE="$(command -v node 2>/dev/null)" || NODE="%s"\nexec "$NODE" "%s" "$@"\n' \
            "$CLI_SHIM_MARK" "$node_bin" "$CLI_JS" >"$CLI_BIN"
        chmod +x "$CLI_BIN"
        ok "installed $CLI_BIN"
    fi

    local sched_service="[Unit]
Description=Claude Usage Panel - snapshot running Claude Code sessions
Documentation=https://github.com/fschmutz/claude-usage-panel/wiki/Tabs

[Service]
Type=oneshot
ExecStart=\"$node_bin\" \"$CLI_JS\" session autosave"
    local sched_timer="[Unit]
Description=Claude Usage Panel - snapshot running Claude Code sessions every 30 min

[Timer]
OnCalendar=*:0/30
Persistent=true

[Install]
WantedBy=timers.target"
    local sched_plist
    sched_plist="<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
<dict>
  <key>Label</key><string>$(_sched_xml_escape "$CLI_LABEL")</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(_sched_xml_escape "$node_bin")</string>
    <string>$(_sched_xml_escape "$CLI_JS")</string>
    <string>session</string>
    <string>autosave</string>
  </array>
  <key>StartInterval</key><integer>1800</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
</dict>
</plist>"
    local sched_cron="*/30 * * * * \"$node_bin\" \"$CLI_JS\" session autosave >/dev/null 2>&1  $CLI_CRON_TAG"

    if ! _sched_install "$CLI_UNIT" "$CLI_LABEL" "$CLI_CRON_TAG" "every 30 min" \
        "$sched_service" "$sched_timer" "$sched_plist" "$sched_cron"; then
        skip_fatal "cli: no systemd, launchd or cron found - autosave is not scheduled (claudectl session save by hand)"
    fi
    if $DRY; then
        ok "dry-run: no changes written"
        return 0
    fi
    case ":$PATH:" in
        *":$(dirname "$CLI_BIN"):"*) ;;
        *) echo "  $(dirname "$CLI_BIN") is not on your PATH - add it, or call the full path." ;;
    esac
    echo "  Save the login you are on now:  claudectl account save PRO"
    echo "  Log in to the other one (claude auth login), then:  claudectl account save PERSO"
    echo "  Switch any time:  claudectl account use PERSO   (running sessions keep the old login)"
    echo "  After a reboot, every session back as tabs of one window:  claudectl session open"
}

uninstall_cli() {
    info "claudectl CLI (account + session, autosave)"
    _sched_uninstall "$CLI_UNIT" "$CLI_LABEL" "$CLI_CRON_TAG"
    act rm -f "$CLI_BIN"
    _cli_drop_legacy
    _prune_node_tree
    ok "removed the CLI and the schedule; saved logins and snapshots are kept (delete to forget them):"
    echo "  Linux:  \${XDG_STATE_HOME:-\$HOME/.local/state}/claude-usage-panel/{accounts,tabs}"
    echo "  macOS:  \$HOME/Library/Application Support/claude-usage-panel/{accounts,tabs}"
}
