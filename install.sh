#!/usr/bin/env bash
# Unified installer for Claude Usage Panel - one entrypoint for every client:
# the GNOME extension, the macOS menu-bar app, the Claude Code status line, the
# MCP server, the claude-account CLI, and the two scheduled jobs.
#
#   ./install.sh                    auto-detect this OS and install the sensible set
#   ./install.sh gnome              GNOME Shell extension only
#   ./install.sh statusline         Claude Code status line only
#   ./install.sh mcp                MCP server (get_usage + account tools in Claude Code + Cursor)
#   ./install.sh accounts           claude-account CLI: save the current login under a
#                                   name (PRO, PERSO…) and switch between them
#   ./install.sh macos              build the macOS .app bundle
#   ./install.sh autoupdate         check for a new release once a day and install it
#   ./install.sh sessionping [HH:MM ...] [--days=mon,wed,fri|all]
#                                   ping claude at fixed times so the 5h session
#                                   window opens on schedule (default 05:30, Mon-Fri)
#   ./install.sh plan [--day HH:MM-HH:MM] [--pings N] [--compare a,b]
#                                   recommend sessionping times for your working
#                                   day, and score the schedule you already have
#   ./install.sh gnome statusline   any combination
#   ./install.sh update [target...]        reinstall what's already installed (upgrade)
#   ./install.sh update --pull             git pull --ff-only first, then upgrade
#   ./install.sh --uninstall [target...]   reverse an install (default: all detected)
#   ./install.sh --dry-run [target...]     print the actions without doing them (alias -n)
#   ./install.sh macos --build-only        build the .app but don't install it (used by CI)
#   ./install.sh statusline --segments=context,limits,tokens,ping[,account,sessions] \
#                           --tokens=all|fresh
#                                          choose status-line segments + token mode
#   ./install.sh --list             show detected + installed targets
#   ./install.sh -h | --help
#
# Each target guards its own dependencies and is skipped with a clear message
# rather than failing the whole run. Re-running any target is safe (idempotent).
#
# The targets live in scripts/install/<target>.sh, one file each, sourced
# below; this file is the argument loop and the dispatch. It always runs from a
# checkout (docs/install clones one first), so the split costs nothing.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
UUID="claude-usage-panel@fschmutz.github.io"

# shellcheck source=scripts/install/ui.sh
. "$ROOT/scripts/install/ui.sh"
# shellcheck source=scripts/install/scheduler.sh
. "$ROOT/scripts/install/scheduler.sh"
# shellcheck source=scripts/install/gnome.sh
. "$ROOT/scripts/install/gnome.sh"
# shellcheck source=scripts/install/node.sh
. "$ROOT/scripts/install/node.sh"
# shellcheck source=scripts/install/macos.sh
. "$ROOT/scripts/install/macos.sh"
# shellcheck source=scripts/install/autoupdate.sh
. "$ROOT/scripts/install/autoupdate.sh"
# shellcheck source=scripts/install/sessionping.sh
. "$ROOT/scripts/install/sessionping.sh"
# shellcheck source=scripts/install/targets.sh
. "$ROOT/scripts/install/targets.sh"

usage() {
    # Print the leading comment block (after the shebang) as help text.
    awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "$0"
}

# `plan` is a read-only helper, not an install target. It has to be handled
# before the argument loop, which would otherwise reject the planner's own
# flags (--day, --pings, --compare) as unknown options.
if [ "${1:-}" = plan ]; then
    shift
    if ! command -v node >/dev/null; then
        echo "install: plan needs node on PATH" >&2
        exit 1
    fi
    exec node "$ROOT/scripts/plan-windows.mjs" "$@"
fi

action=install
targets=()
for arg in "$@"; do
    case "$arg" in
        -h | --help)
            usage
            exit 0
            ;;
        update) action=update ;;
        --uninstall) action=uninstall ;;
        --pull) PULL=true ;;
        --build-only) BUILD_ONLY=true ;;
        --segments=*) SL_SEGMENTS="${arg#*=}" ;;
        --tokens=*) SL_TOKENS="${arg#*=}" ;;
        --days=*) SP_DAYS="${arg#*=}" ;;
        --dry-run | -n) DRY=true ;;
        --list) action=list ;;
        -*)
            echo "Unknown option: $arg" >&2
            usage >&2
            exit 2
            ;;
        *)
            if is_target "$arg"; then
                targets+=("$arg")
            elif [[ "$arg" =~ ^[0-9]{1,2}:[0-9]{2}$ ]]; then
                SP_TIMES+=("$arg") # sessionping ping times
            else
                echo "Unknown target: $arg (want: $ALL_TARGETS)" >&2
                exit 2
            fi
            ;;
    esac
done

# HH:MM times and --days= configure the sessionping target only.
if { [ ${#SP_TIMES[@]} -gt 0 ] || [ -n "$SP_DAYS" ]; } &&
    [ "$action" != update ] &&
    [[ " ${targets[*]-} " != *" sessionping "* ]]; then
    echo "HH:MM times and --days= only apply to the sessionping target" >&2
    echo "  e.g. ./install.sh sessionping 05:30 10:35 --days=mon-fri" >&2
    exit 2
fi

if [ "$action" = list ]; then
    detected="$(detect_targets | paste -sd' ' -)"
    installed="$(installed_targets | paste -sd' ' -)"
    info "Claude Usage Panel - targets (version $(version))"
    echo "  all:        $ALL_TARGETS"
    echo "  detected:   ${detected:-<none>}   (bare ./install.sh installs these)"
    echo "  installed:  ${installed:-<none>}   (./install.sh update reinstalls these)"
    exit 0
fi

# --pull: refresh the checkout before (re)installing, so `update` is one command.
if $PULL; then
    if $DRY; then
        echo "would: git -C \"$ROOT\" pull --ff-only"
        echo
    else
        info "Pulling latest…"
        git -C "$ROOT" pull --ff-only
        echo
    fi
fi

# Default target set: `update` reinstalls what's already installed; install and
# uninstall fall back to what fits this OS. This is the bare `./install.sh`
# path - the one the curl one-liner takes.
if [ ${#targets[@]} -eq 0 ]; then
    if [ "$action" = update ]; then
        _lines_into targets installed_targets
    else
        _lines_into targets detect_targets
    fi
fi

if [ ${#targets[@]} -eq 0 ]; then
    if [ "$action" = update ]; then
        echo "Nothing installed to update. Install first: ./install.sh [target...]" >&2
    else
        echo "No installable target detected. Name one explicitly: $ALL_TARGETS" >&2
    fi
    exit 1
fi

info "==> ${action}: ${targets[*]}$($DRY && echo '  (dry-run)')"
echo
for t in "${targets[@]}"; do
    # `update` is a reinstall in place (install_macos also quits + relaunches).
    if [ "$action" = update ]; then install_"$t"; else "${action}_${t}"; fi
    echo
done
info "Done. Requires an active Claude Code login (~/.claude/.credentials.json)."
