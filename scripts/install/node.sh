# shellcheck shell=bash
# Sourced by install.sh: the Node clients - status line, MCP server (the
# claudectl CLI is scripts/install/cli.sh) - and the one installed tree they
# share.
#
# The status line, the MCP server and the claudectl CLI are ES modules
# that import each other by relative path (mcp/server.js -> ../claude-code/…).
# They are installed as ONE tree that mirrors the checkout's layout, so every
# import resolves exactly as it does in the repo - no per-file renaming, no
# runtime path probing. The tree's package.json marks the files as ESM.
NODE_TREE="$HOME/.claude/claude-usage-panel"
SL_DEST="$NODE_TREE/claude-code/statusline.js"
MCP_DEST="$NODE_TREE/mcp/server.js"
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
CURSOR_MCP="$HOME/.cursor/mcp.json"

_install_node_tree() {
    act mkdir -p "$NODE_TREE/mcp" "$NODE_TREE/claude-code"
    act cp "$ROOT"/mcp/*.js "$NODE_TREE/mcp/"
    act cp "$ROOT"/claude-code/*.js "$NODE_TREE/claude-code/"
    # A module renamed or dropped in the checkout (claude-account.js became
    # account-cli.js in 2.0) must not linger in the tree as a stale copy.
    local dir f
    for dir in mcp claude-code; do
        for f in "$NODE_TREE/$dir"/*.js; do
            [ -e "$f" ] || continue
            [ -e "$ROOT/$dir/$(basename "$f")" ] || act rm -f "$f"
        done
    done
    if $DRY; then
        echo "  would: write $NODE_TREE/package.json ({\"type\": \"module\"})"
    else
        printf '{"type": "module", "private": true}\n' >"$NODE_TREE/package.json"
    fi
    # Pre-1.11 installs were loose .mjs copies next to settings.json.
    act rm -f "$HOME/.claude/claude-usage-statusline.mjs" "$HOME/.claude/claude-usage-mcp.mjs" \
        "$HOME/.claude/claude-usage-accounts.mjs"
}

# Drop the tree once nothing installed uses it any more.
_prune_node_tree() {
    [ -d "$NODE_TREE" ] || return 0
    _cli_installed && return 0 # scripts/install/cli.sh
    _statusline_installed && return 0
    _mcp_installed && return 0
    act rm -rf "$NODE_TREE"
}

# Both of these answer "is this target on this machine", and both are asked by
# `update` to build its target set - which is why neither may depend on node or
# on the claude CLI being on the caller's PATH. Under a scheduler's PATH they
# used to answer "not installed" for clients that were installed, so the update
# quietly skipped them and then recorded itself as complete. A grep of the file
# the installer writes says the same thing without any tool at all.
_statusline_installed() {
    [ -f "$CLAUDE_SETTINGS" ] && grep -Eq "$SL_OURS_RE" "$CLAUDE_SETTINGS"
}

_mcp_installed() {
    command -v claude >/dev/null && claude mcp get claude-usage >/dev/null 2>&1 && return 0
    # The registration the `claude` CLI writes, read directly. Same for Cursor.
    local f
    for f in "$HOME/.claude.json" "$CURSOR_MCP"; do
        [ -f "$f" ] || continue
        grep -q '"claude-usage"' "$f" && return 0
    done
    return 1
}

# The value of --segments= / --tokens= in the status line already installed, or
# $2 when there is none. Read with grep, not the JSON editor: this runs where
# node may not be on PATH (see _statusline_installed).
_sl_installed_flag() { # NAME DEFAULT
    local found=""
    if [ -f "$CLAUDE_SETTINGS" ] && grep -Eq "$SL_OURS_RE" "$CLAUDE_SETTINGS"; then
        found="$(grep -o -- "--$1=[A-Za-z,]*" "$CLAUDE_SETTINGS" | head -1)"
        found="${found#--"$1"=}"
    fi
    printf '%s' "${found:-$2}"
}

# ── Claude Code status line ─────────────────────────────────────────────────────
install_statusline() {
    info "Claude Code status line"
    if ! command -v node >/dev/null; then
        skip_fatal "statusline: Node.js not found on PATH"
        return 0
    fi
    local dest="$SL_DEST"
    local prev="$HOME/.claude/claude-usage-statusline.prev.json"
    _install_node_tree

    # Which segments to render and the token-total mode are baked into the
    # installed command from --segments= / --tokens= (defaults in ui.sh). Kept
    # non-interactive by design: pipe-safe, re-runnable, no tty handling.
    # Flags this run did not set are inherited from the installed command, so a
    # reinstall - which is what every update is - keeps the user's choice.
    $SL_SEGMENTS_SET || SL_SEGMENTS="$(_sl_installed_flag segments "$SL_SEGMENTS")"
    $SL_TOKENS_SET || SL_TOKENS="$(_sl_installed_flag tokens "$SL_TOKENS")"
    local command="node \"$dest\" --segments=$SL_SEGMENTS --tokens=$SL_TOKENS"

    if $DRY; then
        echo "  would: merge statusLine → $command into $CLAUDE_SETTINGS"
        echo "  would: back up any existing (foreign) statusLine to $prev for --uninstall to restore"
        ok "dry-run: no changes written"
        return 0
    fi
    # Merge only the statusLine key; every other key is preserved. If we
    # replace a FOREIGN status line (someone's own), stash it in $prev so
    # --uninstall can put it back.
    local existing
    existing="$(_json get "$CLAUDE_SETTINGS" statusLine)"
    if [ -n "$existing" ] && ! printf '%s' "$existing" | grep -Eq "$SL_OURS_RE"; then
        printf '%s\n' "$existing" >"$prev"
        echo "  backed up your previous statusLine → restored on \`--uninstall statusline\`"
    fi
    _json set "$CLAUDE_SETTINGS" statusLine \
        "{\"type\": \"command\", \"command\": $(_json encode "$command")}"
    ok "installed to $dest (segments: $SL_SEGMENTS, tokens: $SL_TOKENS)"
    echo "  Customize: re-run with --segments=context,limits,tokens,ping,account,sessions and --tokens=all|fresh."
    echo "  Open a Claude Code session or run /statusline to see it."
}

uninstall_statusline() {
    info "Claude Code status line"
    local prev="$HOME/.claude/claude-usage-statusline.prev.json"
    if $DRY; then
        echo "  would: drop our statusLine from $CLAUDE_SETTINGS, restoring $prev if present"
        ok "dry-run: no changes written"
        return 0
    fi
    # Remove only OUR statusLine entry; if we had backed up a foreign one at
    # install time, restore it instead of leaving none.
    if _statusline_installed; then
        if [ -f "$prev" ] && _json set "$CLAUDE_SETTINGS" statusLine "$(cat "$prev")" 2>/dev/null; then
            echo "  restored your previous statusLine"
        else
            _json delete "$CLAUDE_SETTINGS" statusLine
            echo "  removed our statusLine"
        fi
    fi
    act rm -f "$prev"
    _prune_node_tree
    ok "removed"
}

# ── MCP server (Claude Code + Cursor) ──────────────────────────────────────────
install_mcp() {
    info "MCP server (get_usage tool for Claude Code + Cursor)"
    if ! command -v node >/dev/null; then
        skip_fatal "mcp: Node.js not found on PATH"
        return 0
    fi
    local dest="$MCP_DEST"
    _install_node_tree

    # Claude Code: register at user scope via the official CLI. Remove-then-add
    # keeps the call idempotent (add fails if the name already exists).
    if command -v claude >/dev/null; then
        if $DRY; then
            echo "  would: claude mcp add --scope user --transport stdio claude-usage -- node $dest"
        else
            claude mcp remove --scope user claude-usage >/dev/null 2>&1 || true
            claude mcp add --scope user --transport stdio claude-usage -- node "$dest" >/dev/null
            ok "registered in Claude Code (user scope)"
        fi
    else
        skip "claude CLI not found - register manually: claude mcp add claude-usage -- node \"$dest\""
    fi

    # Cursor: merge our entry into ~/.cursor/mcp.json without touching others.
    if [ -d "$HOME/.cursor" ]; then
        if $DRY; then
            echo "  would: merge claude-usage → node $dest into $CURSOR_MCP"
        else
            _json set "$CURSOR_MCP" mcpServers.claude-usage \
                "{\"command\": \"node\", \"args\": [$(_json encode "$dest")]}"
            ok "registered in Cursor (~/.cursor/mcp.json)"
        fi
    else
        skip "Cursor not detected (no ~/.cursor) - skipped its mcp.json"
    fi

    if $DRY; then
        ok "dry-run: no changes written"
        return 0
    fi
    ok "installed to $dest - ask 'how much of my plan have I used?' in either app"
    echo "  Saved accounts show up as list_accounts / save_account / switch_account tools."
}

uninstall_mcp() {
    info "MCP server"
    if command -v claude >/dev/null; then
        if $DRY; then
            echo "  would: claude mcp remove --scope user claude-usage"
        else
            claude mcp remove --scope user claude-usage >/dev/null 2>&1 || true
        fi
    fi
    if [ -f "$CURSOR_MCP" ]; then
        if $DRY; then
            echo "  would: drop claude-usage from $CURSOR_MCP"
        elif command -v node >/dev/null; then
            _json delete "$CURSOR_MCP" mcpServers.claude-usage
        fi
    fi
    _prune_node_tree
    ok "removed"
}
