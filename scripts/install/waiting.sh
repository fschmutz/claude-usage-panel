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

# Show the section in every panel this machine has; a missing panel is fine.
_waiting_toggle() { # true|false
    local schemas="$HOME/.local/share/gnome-shell/extensions/$UUID/schemas"
    if [ -d "$schemas" ] && command -v gsettings >/dev/null; then
        act gsettings --schemadir "$schemas" set org.gnome.shell.extensions.claude-usage-panel waiting-enabled "$1"
    fi
    if [ "$(uname -s)" = Darwin ]; then
        act defaults write io.github.fschmutz.claude-usage-panel waitingEnabled -bool "$1"
    fi
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
    [ "${action:-install}" = update ] || _waiting_toggle true
    $DRY || ok "hooks in $CLAUDE_SETTINGS, section on (next poll)"
}

uninstall_waiting() {
    info "Waiting on you (Claude Code hooks)"
    _waiting_toggle false
    _remove_waiting_hooks
    _prune_node_tree
    $DRY || ok "hooks removed, section off"
}
