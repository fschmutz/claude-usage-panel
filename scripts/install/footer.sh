# shellcheck shell=bash
# Sourced by install.sh: the Claude Code footer - the usage-footer plugin
# (footer/), a mod that draws the line under the prompt. Opt-in, and a target
# of its own: the Node status line (node.sh) stays installable next to it.
#
# The plugin comes from a directory marketplace this installer owns, under its
# own name: <state dir>/footer-marketplace, a generated marketplace.json and a
# `footer` link to this checkout's footer/. Claude Code reads a directory
# marketplace's plugin in place, so the auto-update that moves the checkout to
# a new tag moves the footer with it. The name is NOT `claude-usage-panel`:
# that is the public GitHub marketplace, and `marketplace add` of a directory
# under an existing name silently repoints it - and every plugin installed
# from it - at that directory.
#
# Rules every path below keeps:
#   - install before remove: the status line goes only after the plugin is
#     installed AND enabled in settings.json, and only on an explicit
#     `./install.sh footer` - `update` reinstalls what is there and never
#     swaps one for the other;
#   - a settings.json that is a symlink (dotfiles) is never edited: both the
#     JSON editor and `claude plugin install` would write the linked file;
#   - a marketplace of our name that points elsewhere is left alone;
#   - one footer: installed from the public marketplace by hand, it counts as
#     the footer and no second copy is installed next to it;
#   - `update` of an installed footer only refreshes the marketplace folder
#     and its link: no claude CLI, no settings edit, so a scheduler's PATH or
#     a settings.json that became a symlink cannot fail every daily update;
#   - every step's exit status is checked, a failure is a skip_fatal.
FOOTER_MARKETPLACE="claude-usage-panel-local"
FOOTER_PLUGIN="usage-footer@$FOOTER_MARKETPLACE"
# The same plugin from the public GitHub marketplace (the manual install).
FOOTER_PUBLIC_PLUGIN="usage-footer@claude-usage-panel"

_footer_marketplace_dir() { echo "$(_state_dir)/footer-marketplace"; }

# Read from settings.json with grep: installed_targets must answer under a
# scheduler's PATH, with neither node nor the claude CLI on it.
_footer_enabled() { # PLUGIN-ID
    [ -f "$CLAUDE_SETTINGS" ] && grep -Eq "\"$1\"[[:space:]]*:[[:space:]]*true" "$CLAUDE_SETTINGS"
}
# Ours, or the public marketplace's: either is the footer.
_footer_installed() {
    _footer_enabled "$FOOTER_PLUGIN" || _footer_enabled "$FOOTER_PUBLIC_PLUGIN"
}

# The claude CLI: PATH first, then the directories the scheduled workers search
# (scripts/lib.sh scheduler_bin_dirs: ~/.local/bin, version managers,
# Homebrew). lib.sh is read in a subshell: its log/die/usage must not replace
# install.sh's own.
_footer_claude() {
    local c
    if c="$(command -v claude 2>/dev/null)" && [ -n "$c" ]; then
        echo "$c"
        return 0
    fi
    c="$(
        # shellcheck source=scripts/lib.sh
        . "$ROOT/scripts/lib.sh" && scheduler_bin_dir_for claude
    )" || return 1
    echo "$c/claude"
}

# The marketplace folder: its marketplace.json and the `footer` link to this
# checkout. Rewritten on every install and update, so a moved checkout is
# followed.
_footer_write_marketplace() { # DIR
    mkdir -p "$1/.claude-plugin" &&
        printf '%s\n' "{\"name\": \"$FOOTER_MARKETPLACE\", \"owner\": {\"name\": \"claude-usage-panel install.sh\"}, \"plugins\": [{\"name\": \"usage-footer\", \"source\": \"./footer\", \"description\": \"The line under the Claude Code prompt, from this checkout.\"}]}" \
            >"$1/.claude-plugin/marketplace.json" &&
        ln -sfn "$ROOT/footer" "$1/footer"
}

# Where the marketplace named $FOOTER_MARKETPLACE points today: its path, or
# nothing when there is none. Exit 1 when the list cannot be read.
_footer_marketplace_path() { # CLAUDE
    local out
    out="$("$1" plugin marketplace list --json 2>/dev/null)" || return 1
    printf '%s' "$out" | node -e '
        let s = "";
        process.stdin.on("data", (d) => (s += d)).on("end", () => {
            let list;
            try { list = JSON.parse(s); } catch { process.exit(1); }
            if (!Array.isArray(list)) process.exit(1);
            const m = list.find((x) => x && x.name === process.argv[1]);
            if (m) process.stdout.write(String(m.path || m.installLocation || "?"));
        });' "$FOOTER_MARKETPLACE"
}

# The steps for someone whose settings.json we will not edit.
_footer_manual_steps() {
    echo "  To install the footer by hand (Claude Code edits the file the link points to):"
    echo "    claude plugin marketplace add fschmutz/claude-usage-panel"
    echo "    claude plugin install $FOOTER_PUBLIC_PLUGIN --scope user"
    echo "  then, to replace the status line with it, drop the \"statusLine\" key from that file."
}

# Drop the Node status line's entry, putting back a foreign one it had
# replaced. Every edit is checked: a failure is a skip_fatal and returns 1,
# never a "removed" line over an entry that is still there.
_footer_drop_statusline() {
    local prev="$HOME/.claude/claude-usage-statusline.prev.json"
    # node is on PATH: install_footer refuses to start without it.
    if [ -f "$prev" ]; then
        if ! _json set "$CLAUDE_SETTINGS" statusLine "$(cat "$prev")"; then
            skip_fatal "footer: installed, but restoring your previous statusLine into $CLAUDE_SETTINGS failed - the status line stays"
            return 1
        fi
        echo "  status line replaced, your previous statusLine restored"
    else
        if ! _json delete "$CLAUDE_SETTINGS" statusLine; then
            skip_fatal "footer: installed, but removing the status line from $CLAUDE_SETTINGS failed - it stays"
            return 1
        fi
        echo "  status line removed: the footer replaces it"
    fi
    if ! rm -f "$prev"; then
        skip_fatal "footer: could not remove $prev"
        return 1
    fi
    _prune_node_tree
}

# `update` of an installed footer: the plugin loads in place through the link,
# so refreshing the folder is the whole reinstall. Nothing here needs the
# claude CLI or writes settings.json.
_footer_refresh() {
    if ! _footer_enabled "$FOOTER_PLUGIN"; then
        ok "installed from the claude-usage-panel marketplace - Claude Code keeps it current"
        return 0
    fi
    local dir
    dir="$(_footer_marketplace_dir)"
    if $DRY; then
        echo "  would: refresh $dir (footer -> $ROOT/footer)"
        ok "dry-run: no changes written"
        return 0
    fi
    if ! _footer_write_marketplace "$dir"; then
        skip_fatal "footer: could not refresh the marketplace at $dir"
        return 0
    fi
    ok "up to date - loads from $ROOT/footer"
}

install_footer() {
    info "Claude Code footer (usage-footer plugin)"
    # shellcheck disable=SC2154  # action: install.sh's argument loop sets it (install|update|uninstall)
    if [ "$action" = update ] && _footer_installed; then
        _footer_refresh
        return 0
    fi
    if [ -L "$CLAUDE_SETTINGS" ]; then
        skip_fatal "footer: $CLAUDE_SETTINGS is a symlink - not editing a file managed elsewhere, nothing was changed"
        _footer_manual_steps
        return 0
    fi
    local claude
    if ! claude="$(_footer_claude)"; then
        skip_fatal "footer: claude CLI not found on PATH"
        return 0
    fi
    if ! command -v node >/dev/null; then
        skip_fatal "footer: Node.js not found on PATH"
        return 0
    fi
    local replace=false
    [ "$action" = install ] && _statusline_installed && replace=true
    # Installed from the public marketplace already: that is the footer, and a
    # second copy would draw the line twice.
    if _footer_enabled "$FOOTER_PUBLIC_PLUGIN" && ! _footer_enabled "$FOOTER_PLUGIN"; then
        ok "already installed from the claude-usage-panel marketplace - no second copy"
        if $replace; then
            if $DRY; then
                echo "  would: drop the status line from $CLAUDE_SETTINGS"
            else
                _footer_drop_statusline || return 0
            fi
        fi
        return 0
    fi
    local dir current
    dir="$(_footer_marketplace_dir)"
    if ! current="$(_footer_marketplace_path "$claude")"; then
        skip_fatal "footer: could not read the Claude Code marketplaces (claude plugin marketplace list --json) - nothing was changed"
        return 0
    fi
    if [ -n "$current" ] && [ "$current" != "$dir" ]; then
        skip_fatal "footer: a marketplace named $FOOTER_MARKETPLACE already points at $current - left as it is, nothing installed"
        return 0
    fi
    if $DRY; then
        echo "  would: write $dir (marketplace $FOOTER_MARKETPLACE, footer -> $ROOT/footer)"
        [ -n "$current" ] || echo "  would: claude plugin marketplace add $dir"
        echo "  would: claude plugin install $FOOTER_PLUGIN --scope user"
        $replace && echo "  would: then drop the status line from $CLAUDE_SETTINGS"
        ok "dry-run: no changes written"
        return 0
    fi

    # 1. the marketplace, ours alone
    if ! _footer_write_marketplace "$dir"; then
        skip_fatal "footer: could not write the marketplace at $dir - nothing was installed"
        return 0
    fi
    if [ -z "$current" ]; then
        if ! "$claude" plugin marketplace add "$dir" >/dev/null; then
            skip_fatal "footer: claude plugin marketplace add $dir failed - nothing was installed"
            return 0
        fi
        # What uninstall_footer may remove: only a marketplace this added.
        : >"$dir/.added-by-install"
    fi
    # 2. the plugin
    if ! "$claude" plugin install "$FOOTER_PLUGIN" --scope user >/dev/null; then
        skip_fatal "footer: claude plugin install $FOOTER_PLUGIN failed - nothing else was changed"
        return 0
    fi
    # 3. proof it is on: what installed_targets will read next time
    if ! _footer_installed; then
        skip_fatal "footer: $FOOTER_PLUGIN is not enabled in $CLAUDE_SETTINGS after the install - nothing else was changed"
        return 0
    fi
    ok "installed - loads from $ROOT/footer; open a new Claude Code session to see it"
    # 4. only now, and only when asked for by name, the status line goes
    if $replace; then
        _footer_drop_statusline || return 0
    fi
    return 0
}

uninstall_footer() {
    info "Claude Code footer (usage-footer plugin)"
    local dir claude="" id current=""
    dir="$(_footer_marketplace_dir)"
    if ! _footer_installed && [ ! -e "$dir" ]; then
        ok "removed"
        return 0
    fi
    local steps="claude plugin uninstall $FOOTER_PLUGIN (or $FOOTER_PUBLIC_PLUGIN) && claude plugin marketplace remove $FOOTER_MARKETPLACE"
    if [ -L "$CLAUDE_SETTINGS" ]; then
        skip_fatal "footer: $CLAUDE_SETTINGS is a symlink - not editing it; run: $steps"
        return 0
    fi
    if ! claude="$(_footer_claude)"; then
        skip_fatal "footer: claude CLI not found on PATH - run: $steps"
        return 0
    fi
    if ! command -v node >/dev/null; then
        skip_fatal "footer: Node.js not found on PATH (it reads the marketplace list) - run: $steps"
        return 0
    fi
    if [ -e "$dir" ] && ! current="$(_footer_marketplace_path "$claude")"; then
        skip_fatal "footer: could not read the Claude Code marketplaces - run: $steps"
        return 0
    fi
    # The marketplace folder goes only with a marketplace this installer added;
    # one of our name that something else added at it keeps its folder.
    local ours=false keep=false
    [ -f "$dir/.added-by-install" ] && ours=true
    if ! $ours && [ -n "$current" ] && [ "$current" = "$dir" ]; then keep=true; fi
    if $DRY; then
        for id in "$FOOTER_PLUGIN" "$FOOTER_PUBLIC_PLUGIN"; do
            if _footer_enabled "$id"; then echo "  would: claude plugin uninstall $id --scope user"; fi
        done
        if $ours && [ "$current" = "$dir" ]; then echo "  would: claude plugin marketplace remove $FOOTER_MARKETPLACE"; fi
        $keep || echo "  would: delete $dir"
        ok "dry-run: no changes written"
        return 0
    fi
    for id in "$FOOTER_PLUGIN" "$FOOTER_PUBLIC_PLUGIN"; do
        if _footer_enabled "$id" && ! "$claude" plugin uninstall "$id" --scope user >/dev/null; then
            skip_fatal "footer: claude plugin uninstall $id failed"
            return 0
        fi
    done
    # Repointed since (someone else's now): not ours to remove.
    if $ours && [ "$current" = "$dir" ] && ! "$claude" plugin marketplace remove "$FOOTER_MARKETPLACE" >/dev/null; then
        skip_fatal "footer: claude plugin marketplace remove $FOOTER_MARKETPLACE failed"
        return 0
    fi
    if $keep; then
        ok "removed - kept $dir: the $FOOTER_MARKETPLACE marketplace there was not added by this installer"
        return 0
    fi
    if [ -e "$dir" ] && ! rm -rf "$dir"; then
        skip_fatal "footer: could not remove $dir"
        return 0
    fi
    ok "removed"
}
