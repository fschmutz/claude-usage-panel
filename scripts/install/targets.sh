# shellcheck shell=bash
# Sourced by install.sh: what can be installed here, what already is.

ALL_TARGETS="gnome statusline mcp cli macos autoupdate sessionping"

# Print the targets that make sense for this machine, one per line.
detect_targets() {
    case "$(uname -s)" in
        Darwin) echo macos ;;
        Linux)
            if command -v gnome-extensions >/dev/null ||
                [[ "${XDG_CURRENT_DESKTOP:-}" == *GNOME* ]]; then
                echo gnome
            fi
            ;;
    esac
    command -v node >/dev/null && echo statusline
    if command -v node >/dev/null &&
        { command -v claude >/dev/null || [ -d "$HOME/.cursor" ]; }; then
        echo mcp
    fi
    command -v node >/dev/null && echo cli
    # Staying current is the default, but only where it can work: a git checkout
    # to pull from and something to run a daily job. Opt out any time with
    # `./install.sh --uninstall autoupdate`.
    if git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 &&
        [ "$(_sched_scheduler)" != none ]; then
        echo autoupdate
    fi
    return 0
}

# Print the targets currently installed on this machine, one per line. Drives
# `update` (reinstall only what's actually there) and `--list`.
installed_targets() {
    [ -d "$HOME/.local/share/gnome-shell/extensions/$UUID" ] && echo gnome
    _statusline_installed && echo statusline
    _mcp_installed && echo mcp
    _cli_installed && echo cli
    [ -d "/Applications/ClaudeUsagePanel.app" ] && echo macos
    _au_installed && echo autoupdate
    _sp_installed && echo sessionping
    return 0
}

# Targets renamed into `cli`, still accepted on the command line.
target_alias() {
    case "$1" in
        accounts | tabs) echo cli ;;
        *) echo "$1" ;;
    esac
}

is_target() {
    local t
    for t in $ALL_TARGETS; do [ "$t" = "$1" ] && return 0; done
    return 1
}
