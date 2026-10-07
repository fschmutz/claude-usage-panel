# shellcheck shell=bash
# Sourced by install.sh: the cost target (opt-in).
#
# The panels' "Session cost" line runs an installed `ccusage` and nothing else
# (no `npx ccusage@latest`: that ran the newest unpinned release on every poll,
# in the session holding the Claude token). This target installs the version
# pinned in .github/ccusage/package.json - Dependabot bumps it, `update`
# reinstalls it - and turns the cost line on in whichever panel is installed.
COST_PIN_FILE="$ROOT/.github/ccusage/package.json"

# The pinned version, read without node: installed_targets and the scheduler's
# PATH must never need it.
cost_pinned_version() {
    sed -n 's/^ *"ccusage": *"\([0-9][0-9.]*\)".*/\1/p' "$COST_PIN_FILE"
}

# Installed by us, or by hand: either way `update` keeps it on the pin.
_cost_marker() { echo "$(_state_dir)/cost-installed"; }
_cost_installed() { [ -f "$(_cost_marker)" ]; }

# Where the panels look for it: gnome-shell's PATH, and the macOS app's
# fixed list (Shell.toolEnvironment). An nvm global lands on neither.
_cost_reachable() {
    local d
    for d in "$HOME/.volta/bin" "$HOME/.npm-global/bin" /opt/homebrew/bin /usr/local/bin /usr/bin; do
        [ -x "$d/ccusage" ] && return 0
    done
    return 1
}

# Show the cost line in every panel this machine has; a missing panel is fine.
_cost_toggle() { # true|false
    local schemas="$HOME/.local/share/gnome-shell/extensions/$UUID/schemas"
    if [ -d "$schemas" ] && command -v gsettings >/dev/null; then
        act gsettings --schemadir "$schemas" set org.gnome.shell.extensions.claude-usage-panel show-cost "$1"
    fi
    if [ "$(uname -s)" = Darwin ]; then
        act defaults write io.github.fschmutz.claude-usage-panel showCost -bool "$1"
    fi
}

install_cost() {
    local v
    v="$(cost_pinned_version)"
    info "Session cost (ccusage $v)"
    if [ -z "$v" ]; then
        skip_fatal "cost: no ccusage version pinned in $COST_PIN_FILE"
        return 0
    fi
    if command -v volta >/dev/null; then
        act volta install "ccusage@$v"
    elif command -v npm >/dev/null; then
        act npm install -g "ccusage@$v"
    else
        skip_fatal "cost: neither volta nor npm on PATH - install Node.js first"
        return 0
    fi
    if ! $DRY && ! _cost_reachable; then
        skip_fatal "cost: ccusage installed, but not where the panels look ($HOME/.volta/bin, ~/.npm-global/bin, /opt/homebrew/bin, /usr/local/bin) - an nvm global is not on gnome-shell's PATH"
        return 0
    fi
    act mkdir -p "$(_state_dir)"
    act touch "$(_cost_marker)"
    # A reinstall keeps the user's own choice: only a first install turns it on.
    [ "${action:-install}" = update ] || _cost_toggle true
    $DRY || ok "ccusage $v installed, cost line on (next poll)"
}

uninstall_cost() {
    info "Session cost (ccusage)"
    _cost_toggle false
    if command -v volta >/dev/null && [ -x "$HOME/.volta/bin/ccusage" ]; then
        act volta uninstall ccusage
    elif command -v npm >/dev/null && npm ls -g --depth=0 ccusage >/dev/null 2>&1; then
        act npm uninstall -g ccusage
    fi
    act rm -f "$(_cost_marker)"
    $DRY || ok "cost line off, ccusage removed"
}
