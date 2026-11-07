# shellcheck shell=bash
# Sourced by install.sh: the waiting target (opt-in).
#
# "Waiting on you" needs Claude Code hooks: the PreToolUse / PostToolUse ones
# start `node` on every tool call of every session, so nothing installs them
# but this target. It installs the Node tree the hook runs from, merges the
# hooks into ~/.claude/settings.json (hooks-edit.mjs, other hooks untouched)
# and turns the section on in whichever panel is installed. The panels keep it
# off by default (waiting-enabled / waitingEnabled).

# Installed = our hook command is in settings.json. A grep, not node:
# installed_targets runs under a scheduler's PATH (scripts/install/targets.sh).
_waiting_installed() {
    [ -f "$CLAUDE_SETTINGS" ] && grep -qF "$HOOK_DEST" "$CLAUDE_SETTINGS"
}

install_waiting() {
    info "Waiting on you (Claude Code hooks)"
    if ! command -v node >/dev/null; then
        skip_fatal "waiting: Node.js not found on PATH - the hooks run node"
        return 0
    fi
    _install_node_tree
    _install_waiting_hooks
    # A reinstall keeps the user's own choice: only a first install turns it on.
    [ "${action:-install}" = update ] || _panel_setting waiting-enabled waitingEnabled true
    $DRY || ok "hooks in $CLAUDE_SETTINGS, section on (next poll)"
}

uninstall_waiting() {
    info "Waiting on you (Claude Code hooks)"
    _panel_setting waiting-enabled waitingEnabled false
    _remove_waiting_hooks
    _prune_node_tree
    $DRY || ok "hooks removed, section off"
}
