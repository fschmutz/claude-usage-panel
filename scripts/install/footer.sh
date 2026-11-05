# shellcheck shell=bash
# Sourced by install.sh: the Claude Code footer - the usage-footer plugin
# (footer/), a mod that draws the line under the prompt - and the retirement
# of the Node status line it replaces.
#
# The plugin is installed from THIS checkout as a directory marketplace, so
# Claude Code reads it in place from footer/: the auto-update that moves the
# checkout to a new tag moves the footer with it, no plugin update needed.
#
# `statusline` is an alias of this target (targets.sh). A machine that still
# has the old statusLine entry reports `footer` as installed, so the next
# `update` - the daily job included - migrates it: the entry goes, the plugin
# comes in.
FOOTER_PLUGIN="usage-footer@claude-usage-panel"

# Read from settings.json with grep: installed_targets must answer under a
# scheduler's PATH, with neither node nor the claude CLI on it.
_footer_installed() {
    [ -f "$CLAUDE_SETTINGS" ] && grep -Eq "\"$FOOTER_PLUGIN\"[[:space:]]*:[[:space:]]*true" "$CLAUDE_SETTINGS"
}

# The retired status line, by the command the old installer wrote.
_statusline_installed() {
    [ -f "$CLAUDE_SETTINGS" ] && grep -Eq "$SL_OURS_RE" "$CLAUDE_SETTINGS"
}

# Drop the old statusLine entry, putting back a foreign one it had replaced.
# Returns 1 (after a skip_fatal) when it is there and cannot be removed.
_remove_legacy_statusline() {
    local prev="$HOME/.claude/claude-usage-statusline.prev.json"
    if _statusline_installed; then
        if ! command -v node >/dev/null; then
            skip_fatal "footer: Node.js not found on PATH - remove the old \"statusLine\" key from $CLAUDE_SETTINGS by hand (or re-run with node on PATH)"
            return 1
        fi
        if $DRY; then
            echo "  would: drop the retired statusLine from $CLAUDE_SETTINGS, restoring $prev if present"
        elif [ -f "$prev" ] && _json set "$CLAUDE_SETTINGS" statusLine "$(cat "$prev")" 2>/dev/null; then
            echo "  retired status line removed, your previous statusLine restored"
        else
            _json delete "$CLAUDE_SETTINGS" statusLine
            echo "  retired status line removed"
        fi
    fi
    act rm -f "$prev"
}

install_footer() {
    info "Claude Code footer (usage-footer plugin)"
    _remove_legacy_statusline || return 0
    if ! command -v claude >/dev/null; then
        # Installed already: it loads in place from the checkout, so there is
        # nothing to redo. Not installed yet: the target was not delivered.
        if _footer_installed; then
            ok "already installed - loads in place from $ROOT/footer"
        else
            skip_fatal "footer: claude CLI not found on PATH"
        fi
        return 0
    fi
    if $DRY; then
        echo "  would: claude plugin marketplace add $ROOT"
        echo "  would: claude plugin install $FOOTER_PLUGIN --scope user"
        ok "dry-run: no changes written"
        return 0
    fi
    claude plugin marketplace add "$ROOT" >/dev/null
    claude plugin install "$FOOTER_PLUGIN" --scope user >/dev/null
    _prune_node_tree
    ok "installed - loads from $ROOT/footer; open a new Claude Code session to see it"
}

uninstall_footer() {
    info "Claude Code footer (usage-footer plugin)"
    _remove_legacy_statusline || return 0
    if _footer_installed; then
        if ! command -v claude >/dev/null; then
            skip_fatal "footer: claude CLI not found on PATH - run: claude plugin uninstall $FOOTER_PLUGIN"
            return 0
        fi
        if $DRY; then
            echo "  would: claude plugin uninstall $FOOTER_PLUGIN"
        else
            claude plugin uninstall "$FOOTER_PLUGIN" >/dev/null
        fi
    fi
    _prune_node_tree
    ok "removed"
}
