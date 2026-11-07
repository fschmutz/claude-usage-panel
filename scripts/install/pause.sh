# shellcheck shell=bash
# Sourced by install.sh: the pause target (opt-in).
#
# `claudectl session pause` reaches every live Claude Code session through
# Claude Code hooks (claude-code/pause-hook.js): SessionStart and Stop start
# a background asyncRewake waiter that wakes an idle session with the
# request, and a PreToolUse backstop hands it to a busy one (node per tool
# call, which is why nothing but this target installs them). It needs the
# claudectl CLI (installed when missing) and the shared Node tree, merges
# the hooks into ~/.claude/settings.json (hooks-edit.mjs, other hooks
# untouched) and turns the panel buttons on. The panels keep them off by
# default (pause-enabled / pauseEnabled).
PAUSE_HOOK_DEST="$NODE_TREE/claude-code/pause-hook.js"

# Installed = our hook command is in settings.json. A grep, not node:
# installed_targets runs under a scheduler's PATH (scripts/install/targets.sh).
_pause_installed() {
    [ -f "$CLAUDE_SETTINGS" ] && grep -qF "$PAUSE_HOOK_DEST" "$CLAUDE_SETTINGS"
}

_pause_hook_command() {
    printf 'node "%s"' "$PAUSE_HOOK_DEST"
}

install_pause() {
    info "Pause / resume every session (Claude Code hooks)"
    if ! command -v node >/dev/null; then
        skip_fatal "pause: Node.js not found on PATH - the hooks run node"
        return 0
    fi
    _cli_installed || install_cli
    _install_node_tree
    local command
    command="$(_pause_hook_command)"
    if $DRY; then
        echo "  would: merge pause hooks (SessionStart / Stop asyncRewake, PreToolUse) → $command into $CLAUDE_SETTINGS"
    else
        node "$ROOT/scripts/install/hooks-edit.mjs" add "$CLAUDE_SETTINGS" "$command" pause
        echo "  pause hooks (SessionStart / Stop / PreToolUse) → $CLAUDE_SETTINGS"
    fi
    # A reinstall keeps the user's own choice: only a first install turns it on.
    [ "${action:-install}" = update ] || _panel_setting pause-enabled pauseEnabled true
    $DRY || ok "sessions started from now on get a waiter; running ones get the request on their next tool call"
}

uninstall_pause() {
    info "Pause / resume every session (Claude Code hooks)"
    _panel_setting pause-enabled pauseEnabled false
    if _pause_installed; then
        if ! command -v node >/dev/null; then
            skip_fatal "pause: Node.js not found on PATH - the hooks stay in $CLAUDE_SETTINGS"
            return 0
        fi
        if $DRY; then
            echo "  would: drop pause hooks from $CLAUDE_SETTINGS"
        else
            node "$ROOT/scripts/install/hooks-edit.mjs" remove "$CLAUDE_SETTINGS" "$(_pause_hook_command)" pause
        fi
    fi
    _prune_node_tree
    $DRY || ok "hooks removed (a waiter still running in an open session exits with it)"
}
