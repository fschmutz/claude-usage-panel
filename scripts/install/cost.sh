# shellcheck shell=bash
# Sourced by install.sh: the cost target (opt-in).
#
# The panels' "Session cost" line runs an installed `ccusage` and nothing else
# (no `npx ccusage@latest`: that ran the newest unpinned release on every poll,
# in the session holding the Claude token). This target installs exactly the
# tree locked in .github/ccusage/package-lock.json - ccusage and every package
# under it, each checked against its recorded integrity hash - with `npm ci`
# into a private prefix, then puts a `ccusage` launcher where the panels look.
# Dependabot bumps the lock, `update` reinstalls it, and it turns the cost line
# on in whichever panel is installed. A global `volta install` / `npm i -g`
# (what this did before) resolved the transitive packages afresh on every
# install, so two machines on the same pin could run different code.
COST_PIN_DIR="$ROOT/.github/ccusage"
COST_PIN_FILE="$COST_PIN_DIR/package.json"
COST_LAUNCHER_TAG="# claude-usage-panel cost launcher"

# The pinned version, read without node: installed_targets and the scheduler's
# PATH must never need it.
cost_pinned_version() {
    sed -n 's/^ *"ccusage": *"\([0-9][0-9.]*\)".*/\1/p' "$COST_PIN_FILE"
}

# Installed by us, or by hand: either way `update` keeps it on the pin.
_cost_marker() { echo "$(_state_dir)/cost-installed"; }
_cost_installed() { [ -f "$(_cost_marker)" ]; }

# The private prefix `npm ci` installs into.
_cost_home() { echo "${XDG_DATA_HOME:-$HOME/.local/share}/claude-usage-panel/ccusage"; }

# Where the launcher goes: a dir the panels search. The macOS app's fixed list
# (Shell.toolEnvironment) has ~/.npm-global/bin; gnome-shell's PATH has
# ~/.local/bin on the usual distro profiles.
_cost_bin_dir() {
    if [ "$(uname -s)" = Darwin ]; then echo "$HOME/.npm-global/bin"; else echo "$HOME/.local/bin"; fi
}

# Where the panels look for it: gnome-shell's PATH, and the macOS app's
# fixed list (Shell.toolEnvironment). An nvm global lands on neither.
_cost_reachable() {
    local d
    for d in "$(_cost_bin_dir)" "$HOME/.volta/bin" "$HOME/.npm-global/bin" /opt/homebrew/bin /usr/local/bin /usr/bin; do
        [ -x "$d/ccusage" ] && return 0
    done
    return 1
}

# A word /bin/sh reads back as $1 whatever it holds.
_cost_sh_word() { printf "'%s'" "$(printf '%s' "$1" | sed -e "s/'/'\\\\''/g")"; }

# The launcher: the node that ran the install (an absolute path, so the
# panels' PATH need not hold one) running the locked ccusage.
_cost_write_launcher() { # NODE
    local bin
    bin="$(_cost_bin_dir)"
    if $DRY; then
        echo "  would: write $bin/ccusage"
        return 0
    fi
    mkdir -p "$bin"
    printf '#!/bin/sh\n%s - written by ./install.sh cost, removed by --uninstall cost\nexec %s %s "$@"\n' \
        "$COST_LAUNCHER_TAG" "$(_cost_sh_word "$1")" "$(_cost_sh_word "$(_cost_home)/node_modules/.bin/ccusage")" \
        >"$bin/ccusage.tmp" && chmod 755 "$bin/ccusage.tmp" && mv "$bin/ccusage.tmp" "$bin/ccusage"
}

# The global ccusage an older version of this target installed (volta or
# npm -g): it would shadow the launcher, at the version it was installed at.
_cost_drop_global() {
    if command -v volta >/dev/null && [ -x "$HOME/.volta/bin/ccusage" ]; then
        act volta uninstall ccusage
    elif command -v npm >/dev/null && npm ls -g --depth=0 ccusage >/dev/null 2>&1; then
        act npm uninstall -g ccusage
    fi
}

install_cost() {
    local v node
    v="$(cost_pinned_version)"
    info "Session cost (ccusage $v)"
    if [ -z "$v" ] || [ ! -f "$COST_PIN_DIR/package-lock.json" ]; then
        skip_fatal "cost: no ccusage version locked in $COST_PIN_DIR"
        return 0
    fi
    node="$(command -v node || true)"
    if [ -z "$node" ] || ! command -v npm >/dev/null; then
        skip_fatal "cost: node and npm are not on PATH - install Node.js first"
        return 0
    fi
    _cost_drop_global
    act mkdir -p "$(_cost_home)"
    act cp "$COST_PIN_FILE" "$COST_PIN_DIR/package-lock.json" "$(_cost_home)/"
    # ci: exactly the lock, integrity-checked, or nothing. --ignore-scripts:
    # no transitive install script runs (ccusage's native part ships as
    # optional platform packages and needs none).
    if ! act npm ci --prefix "$(_cost_home)" --omit=dev --ignore-scripts --no-audit --no-fund --silent; then
        skip_fatal "cost: npm ci of the locked ccusage $v failed (offline?)"
        return 0
    fi
    _cost_write_launcher "$node"
    if ! $DRY && ! _cost_reachable; then
        skip_fatal "cost: ccusage installed, but not where the panels look ($(_cost_bin_dir))"
        return 0
    fi
    act mkdir -p "$(_state_dir)"
    act touch "$(_cost_marker)"
    # A reinstall keeps the user's own choice: only a first install turns it on.
    [ "${action:-install}" = update ] || _panel_setting show-cost showCost true
    $DRY || ok "ccusage $v installed (locked tree), cost line on (next poll)"
}

uninstall_cost() {
    local launcher
    launcher="$(_cost_bin_dir)/ccusage"
    info "Session cost (ccusage)"
    _panel_setting show-cost showCost false
    # Only our own launcher: a ccusage someone else put there stays.
    if [ -f "$launcher" ] && grep -qF "$COST_LAUNCHER_TAG" "$launcher"; then
        act rm -f "$launcher"
    fi
    act rm -rf "$(_cost_home)"
    _cost_drop_global
    act rm -f "$(_cost_marker)"
    $DRY || ok "cost line off, ccusage removed"
}
