# shellcheck shell=bash
# Sourced by install.sh: the Node clients - the MCP server (the claudectl CLI
# is scripts/install/cli.sh) - and the one installed tree they share.
#
# The MCP server, the claudectl CLI and the hooks are ES modules
# that import each other by relative path (mcp/server.js -> ../claude-code/…),
# and the shared contract straight from the GNOME extension's pure modules
# (claude-code/*.js -> ../claude-usage-panel@fschmutz.github.io/lib/pure/…).
# They are installed as ONE tree that mirrors the checkout's layout, so every
# import resolves exactly as it does in the repo - no per-file renaming, no
# runtime path probing. The tree's package.json marks the files as ESM.
NODE_TREE="$HOME/.claude/claude-usage-panel"
# Checkout-relative dirs copied into the tree: every *.js of each, nothing else.
NODE_TREE_DIRS="mcp claude-code claude-usage-panel@fschmutz.github.io/lib/pure"
MCP_DEST="$NODE_TREE/mcp/server.js"
HOOK_DEST="$NODE_TREE/claude-code/waiting-hook.js"
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
CURSOR_MCP="$HOME/.cursor/mcp.json"

_install_node_tree() {
    local dir f
    for dir in $NODE_TREE_DIRS; do
        act mkdir -p "$NODE_TREE/$dir"
        act cp "$ROOT/$dir"/*.js "$NODE_TREE/$dir/"
    done
    # A module renamed or dropped in the checkout (claude-account.js became
    # account-cli.js in 2.0; the claude-code/ contract copies gave way to
    # lib/pure imports) must not linger in the tree as a stale copy.
    for dir in $NODE_TREE_DIRS; do
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

# Claude Code hooks that mark a live session as waiting on you (the opt-in
# waiting target, scripts/install/waiting.sh). A settings.json merge: other
# hooks stay, re-run is safe.
_waiting_hook_command() {
    printf 'node "%s"' "$HOOK_DEST"
}

_install_waiting_hooks() {
    local command
    command="$(_waiting_hook_command)"
    if $DRY; then
        echo "  would: merge waiting hooks → $command into $CLAUDE_SETTINGS"
        return 0
    fi
    node "$ROOT/scripts/install/hooks-edit.mjs" add "$CLAUDE_SETTINGS" "$command"
    echo "  waiting hooks (Notification / Stop / …) → $CLAUDE_SETTINGS"
}

_remove_waiting_hooks() {
    _waiting_installed || return 0
    if ! command -v node >/dev/null; then
        skip_fatal "waiting: Node.js not found on PATH - the hooks stay in $CLAUDE_SETTINGS"
        return 0
    fi
    if $DRY; then
        echo "  would: drop waiting hooks from $CLAUDE_SETTINGS"
        return 0
    fi
    node "$ROOT/scripts/install/hooks-edit.mjs" remove "$CLAUDE_SETTINGS" "$(_waiting_hook_command)"
}

# Drop the tree once nothing installed uses it any more.
_prune_node_tree() {
    [ -d "$NODE_TREE" ] || return 0
    _cli_installed && return 0 # scripts/install/cli.sh
    _mcp_installed && return 0
    _waiting_installed && return 0 # scripts/install/waiting.sh: the hook runs from it
    _pause_installed && return 0   # scripts/install/pause.sh: same
    _awake_installed && return 0   # scripts/install/awake.sh: the holder runs from it
    act rm -rf "$NODE_TREE"
}

# This answers "is this target on this machine", and is asked by `update` to
# build its target set - which is why it may not depend on node or on the
# claude CLI being on the caller's PATH. Under a scheduler's PATH it used to
# answer "not installed" for a client that was installed, so the update
# quietly skipped it and then recorded itself as complete. A grep of the file
# the installer writes says the same thing without any tool at all.
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

# ── MCP server (Claude Code + Cursor) ──────────────────────────────────────────
install_mcp() {
    info "MCP server (get_usage + waiting tools for Claude Code + Cursor)"
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
    echo "  Saved accounts show up as list_accounts / save_account / switch_account / rename_account tools."
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
    if [ -f "$CURSOR_MCP" ] && grep -q '"claude-usage"' "$CURSOR_MCP"; then
        if $DRY; then
            echo "  would: drop claude-usage from $CURSOR_MCP"
        elif command -v node >/dev/null; then
            _json delete "$CURSOR_MCP" mcpServers.claude-usage
        else
            # Not an "ok removed": the entry is still there, and --list keeps
            # reporting the target as installed.
            skip_fatal "mcp: Node.js not found on PATH - remove \"claude-usage\" from mcpServers in $CURSOR_MCP by hand (or re-run with node on PATH)"
            return 0
        fi
    fi
    _prune_node_tree
    ok "removed"
}
