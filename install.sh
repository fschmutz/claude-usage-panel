#!/usr/bin/env bash
# Unified installer for Claude Usage Panel - one entrypoint for all three
# clients (GNOME extension, macOS menu-bar app, Claude Code status line).
#
#   ./install.sh                    auto-detect this OS and install the sensible set
#   ./install.sh gnome              GNOME Shell extension only
#   ./install.sh statusline         Claude Code status line only
#   ./install.sh mcp                MCP server (get_usage tool in Claude Code + Cursor)
#   ./install.sh macos              build the macOS .app bundle
#   ./install.sh autoupdate         check for a new release once a day and install it
#   ./install.sh sessionping [HH:MM ...] [--days=mon,wed,fri|all]
#                                   ping claude at fixed times so the 5h session
#                                   window opens on schedule (default 05:30, Mon-Fri)
#   ./install.sh gnome statusline   any combination
#   ./install.sh update [target...]        reinstall what's already installed (upgrade)
#   ./install.sh update --pull             git pull --ff-only first, then upgrade
#   ./install.sh --uninstall [target...]   reverse an install (default: all detected)
#   ./install.sh --dry-run [target...]     print the actions without doing them (alias -n)
#   ./install.sh macos --build-only        build the .app but don't install it (used by CI)
#   ./install.sh statusline --segments=context,limits,tokens --tokens=all|fresh
#                                          choose status-line segments + token mode
#   ./install.sh --list             show detected + installed targets
#   ./install.sh -h | --help
#
# Each target guards its own dependencies and is skipped with a clear message
# rather than failing the whole run. Re-running any target is safe (idempotent).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
UUID="claude-usage-panel@fschmutz.github.io"

# ── Single source of truth for the version (used by the macOS bundle). ──────────
version() {
    sed -nE 's/.*"version": *"([^"]+)".*/\1/p' "$ROOT/package.json" | head -1
}

info() { printf '\033[1m%s\033[0m\n' "$*"; }
skip() { printf '  \033[33mskip\033[0m %s\n' "$*"; }
ok() { printf '  \033[32mok\033[0m   %s\n' "$*"; }

# --dry-run: print each mutating action instead of doing it. Read-only probes
# (command -v, gsettings get, uname) always run. `act` wraps a plain command;
# heredoc merges (node/python) are guarded inline with `$DRY`.
DRY=false
PULL=false
BUILD_ONLY=false                    # macos: build the .app but don't install to /Applications (used by CI)
SL_SEGMENTS="context,limits,tokens" # statusline: which segments, left→right
SL_TOKENS="all"                     # statusline: token-total mode (all|fresh)
SP_TIMES=()                         # sessionping: HH:MM args from the command line
SP_DAYS=""                          # sessionping: --days= value from the command line
act() {
    if $DRY; then printf '  would: %s\n' "$*"; else "$@"; fi
}

# ── GNOME Shell extension ──────────────────────────────────────────────────────
install_gnome() {
    info "GNOME extension"
    if ! command -v glib-compile-schemas >/dev/null; then
        skip "gnome: glib-compile-schemas not found (not a GNOME desktop?)"
        return 0
    fi
    local src="$ROOT/$UUID"
    local dest="$HOME/.local/share/gnome-shell/extensions/$UUID"
    act rm -rf "$dest"
    act mkdir -p "$dest"
    act cp -r "$src/." "$dest/"
    act glib-compile-schemas "$dest/schemas/"

    # Compile translations (po/*.po → locale/<lang>/LC_MESSAGES/<domain>.mo).
    if command -v msgfmt >/dev/null && [ -d "$src/po" ]; then
        for po in "$src"/po/*.po; do
            [ -e "$po" ] || continue
            local lang mo_dir
            lang="$(basename "$po" .po)"
            mo_dir="$dest/locale/$lang/LC_MESSAGES"
            act mkdir -p "$mo_dir"
            act msgfmt "$po" -o "$mo_dir/claude-usage-panel.mo"
        done
    fi

    # A global kill switch disables ALL user extensions; clear it if set.
    if [ "$(gsettings get org.gnome.shell disable-user-extensions 2>/dev/null)" = "true" ]; then
        act gsettings set org.gnome.shell disable-user-extensions false
        ok "cleared global 'disable-user-extensions' switch"
    fi
    if $DRY; then
        echo "  would: enable $UUID (via gnome-extensions, or register for next login)"
    elif gnome-extensions enable "$UUID" 2>/dev/null; then
        ok "enabled via gnome-extensions"
    else
        _gnome_enabled_key add
        ok "registered in enabled-extensions for next login"
    fi
    if $DRY; then
        ok "dry-run: no changes written"
        return 0
    fi
    ok "installed to $dest"
    echo "  Log out and back in (Wayland loads new extensions only at login)."
}

uninstall_gnome() {
    info "GNOME extension"
    if command -v gnome-extensions >/dev/null; then
        act gnome-extensions disable "$UUID" 2>/dev/null || true
    fi
    _gnome_enabled_key remove 2>/dev/null || true
    act rm -rf "$HOME/.local/share/gnome-shell/extensions/$UUID"
    ok "removed"
}

# Add/remove the UUID from org.gnome.shell enabled-extensions. $1 = add|remove.
_gnome_enabled_key() {
    command -v gsettings >/dev/null || return 0
    if $DRY; then
        echo "  would: $1 $UUID in org.gnome.shell enabled-extensions"
        return 0
    fi
    python3 - "$1" "$UUID" <<'PY'
import subprocess, sys, ast
action, uuid = sys.argv[1], sys.argv[2]
key = ["org.gnome.shell", "enabled-extensions"]
cur = subprocess.run(["gsettings", "get", *key], capture_output=True, text=True).stdout.strip()
try:
    items = ast.literal_eval(cur) if cur and cur != "@as []" else []
except (ValueError, SyntaxError):
    items = []
if action == "add" and uuid not in items:
    items.append(uuid)
elif action == "remove" and uuid in items:
    items.remove(uuid)
else:
    sys.exit(0)
subprocess.run(["gsettings", "set", *key,
                "[" + ", ".join("'%s'" % i for i in items) + "]"], check=True)
PY
}

# ── Claude Code status line ─────────────────────────────────────────────────────
install_statusline() {
    info "Claude Code status line"
    if ! command -v node >/dev/null; then
        skip "statusline: Node.js not found on PATH"
        return 0
    fi
    local src="$ROOT/claude-code/statusline.js"
    local dest_dir="$HOME/.claude"
    # .mjs so Node always treats it as ESM regardless of any nearby package.json.
    local dest="$dest_dir/claude-usage-statusline.mjs"
    local prev="$dest_dir/claude-usage-statusline.prev.json"
    act mkdir -p "$dest_dir"
    act cp "$src" "$dest"
    act chmod +x "$dest"

    # Which segments to render and the token-total mode are baked into the
    # installed command from --segments= / --tokens= (defaults below). Kept
    # non-interactive by design: pipe-safe, re-runnable, no tty handling.
    local command="node \"$dest\" --segments=$SL_SEGMENTS --tokens=$SL_TOKENS"

    if $DRY; then
        echo "  would: merge statusLine → $command into $dest_dir/settings.json"
        echo "  would: back up any existing (foreign) statusLine to $prev for --uninstall to restore"
        ok "dry-run: no changes written"
        return 0
    fi
    # Merge the statusLine key with Node so an existing settings.json is never
    # corrupted; all other keys are preserved. If we replace a FOREIGN status
    # line (someone's own), stash it in $prev so --uninstall can put it back.
    COMMAND="$command" PREV="$prev" node - "$dest_dir/settings.json" <<'JS'
const fs = require('fs');
const path = process.argv[2];
let settings = {};
try { settings = JSON.parse(fs.readFileSync(path, 'utf8')); } catch { /* fresh */ }
const existing = settings.statusLine;
const ours = existing && /claude-usage-statusline\.mjs/.test(existing.command || '');
if (existing && !ours) {
  fs.writeFileSync(process.env.PREV, JSON.stringify(existing, null, 2) + '\n');
  console.log('  backed up your previous statusLine → restored on `--uninstall statusline`');
}
settings.statusLine = {type: 'command', command: process.env.COMMAND};
fs.writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
JS
    ok "installed to $dest (segments: $SL_SEGMENTS, tokens: $SL_TOKENS)"
    echo "  Customize: re-run with --segments=context,limits,tokens and --tokens=all|fresh."
    echo "  Open a Claude Code session or run /statusline to see it."
}

uninstall_statusline() {
    info "Claude Code status line"
    local dest_dir="$HOME/.claude"
    local prev="$dest_dir/claude-usage-statusline.prev.json"
    act rm -f "$dest_dir/claude-usage-statusline.mjs"
    if $DRY; then
        echo "  would: drop our statusLine from $dest_dir/settings.json, restoring $prev if present"
        ok "dry-run: no changes written"
        return 0
    fi
    # Remove only OUR statusLine entry; if we had backed up a foreign one at
    # install time, restore it instead of leaving none.
    if command -v node >/dev/null && [ -f "$dest_dir/settings.json" ]; then
        PREV="$prev" node - "$dest_dir/settings.json" <<'JS'
const fs = require('fs');
const path = process.argv[2];
let s; try { s = JSON.parse(fs.readFileSync(path, 'utf8')); } catch { process.exit(0); }
if (s.statusLine && /claude-usage-statusline\.mjs/.test(s.statusLine.command || '')) {
  let restored = false;
  try { s.statusLine = JSON.parse(fs.readFileSync(process.env.PREV, 'utf8')); restored = true; }
  catch { delete s.statusLine; }
  fs.writeFileSync(path, JSON.stringify(s, null, 2) + '\n');
  console.log(restored ? '  restored your previous statusLine' : '  removed our statusLine');
}
JS
    fi
    act rm -f "$prev"
    ok "removed"
}

# ── MCP server (Claude Code + Cursor) ──────────────────────────────────────────
install_mcp() {
    info "MCP server (get_usage tool for Claude Code + Cursor)"
    if ! command -v node >/dev/null; then
        skip "mcp: Node.js not found on PATH"
        return 0
    fi
    local src="$ROOT/mcp/server.js"
    # .mjs so Node always treats it as ESM regardless of any nearby package.json.
    local dest="$HOME/.claude/claude-usage-mcp.mjs"
    act mkdir -p "$HOME/.claude"
    act cp "$src" "$dest"
    act chmod +x "$dest"

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
            echo "  would: merge claude-usage → node $dest into $HOME/.cursor/mcp.json"
        else
            DEST="$dest" node - "$HOME/.cursor/mcp.json" <<'JS'
const fs = require('fs');
const path = process.argv[2];
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path, 'utf8')); } catch { /* fresh */ }
cfg.mcpServers = cfg.mcpServers || {};
cfg.mcpServers['claude-usage'] = {command: 'node', args: [process.env.DEST]};
fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
JS
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
}

uninstall_mcp() {
    info "MCP server"
    local dest="$HOME/.claude/claude-usage-mcp.mjs"
    if command -v claude >/dev/null; then
        if $DRY; then
            echo "  would: claude mcp remove --scope user claude-usage"
        else
            claude mcp remove --scope user claude-usage >/dev/null 2>&1 || true
        fi
    fi
    if [ -f "$HOME/.cursor/mcp.json" ]; then
        if $DRY; then
            echo "  would: drop claude-usage from $HOME/.cursor/mcp.json"
        elif command -v node >/dev/null; then
            node - "$HOME/.cursor/mcp.json" <<'JS'
const fs = require('fs');
const path = process.argv[2];
let cfg;
try { cfg = JSON.parse(fs.readFileSync(path, 'utf8')); } catch { process.exit(0); }
if (cfg.mcpServers && cfg.mcpServers['claude-usage']) {
  delete cfg.mcpServers['claude-usage'];
  fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
}
JS
        fi
    fi
    act rm -f "$dest"
    ok "removed"
}

# ── macOS .app bundle ───────────────────────────────────────────────────────────
install_macos() {
    info "macOS app"
    if [ "$(uname -s)" != "Darwin" ]; then
        skip "macos: only builds on macOS (uname is $(uname -s))"
        return 0
    fi
    if ! command -v swift >/dev/null; then
        skip "macos: Swift toolchain not found"
        return 0
    fi
    local app="ClaudeUsagePanel"
    local bundle="$ROOT/macos/$app.app"
    local ver
    ver="$(version)"
    if $DRY; then
        echo "  would: swift build -c release + assemble $bundle (v$ver)"
        echo "  would: quit a running instance, ad-hoc codesign, cp -R to /Applications/$app.app, open it"
        ok "dry-run: no build performed"
        return 0
    fi
    (
        cd "$ROOT/macos"
        swift build -c release
        local bin
        bin="$(swift build -c release --show-bin-path)/$app"
        rm -rf "$bundle"
        mkdir -p "$bundle/Contents/MacOS" "$bundle/Contents/Resources"
        cp "$bin" "$bundle/Contents/MacOS/$app"
        # The app's Settings can schedule session pings; give the launchd agent
        # a runner that survives without a git checkout.
        cp "$ROOT/scripts/session-ping.sh" "$bundle/Contents/Resources/session-ping.sh"
        chmod +x "$bundle/Contents/Resources/session-ping.sh"
        cat >"$bundle/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Claude Usage Panel</string>
  <key>CFBundleDisplayName</key><string>Claude Usage Panel</string>
  <key>CFBundleIdentifier</key><string>io.github.fschmutz.claude-usage-panel</string>
  <key>CFBundleVersion</key><string>$ver</string>
  <key>CFBundleShortVersionString</key><string>$ver</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>$app</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST
    )
    # Ad-hoc sign so "Start at login" (SMAppService) and Gatekeeper accept the
    # bundle for personal use; a Developer ID is only needed to distribute it
    # (see PUBLISHING.md). The signature is preserved by the copy below.
    codesign --deep --force --sign - "$bundle" >/dev/null 2>&1 || true
    ok "built $bundle (v$ver)"

    # CI builds the bundle only (to zip as a release asset) - no /Applications.
    if $BUILD_ONLY; then
        ok "build-only: skipped /Applications install"
        return 0
    fi

    # Make it perpetual: install into /Applications and launch it. On first run
    # the app registers itself as a login item (toggle in Settings ▸ Start at login).
    # Quit any running instance first so we replace (not copy over) a busy bundle
    # and so `open` relaunches the NEW binary - this is what makes upgrades take.
    osascript -e 'quit app "Claude Usage Panel"' >/dev/null 2>&1 || true
    local installed="/Applications/$app.app"
    if rm -rf "$installed" 2>/dev/null && cp -R "$bundle" "$installed" 2>/dev/null; then
        open "$installed" 2>/dev/null || true
        ok "installed to $installed and launched"
        echo "  Starts at login by default - toggle it in Settings ▸ Start at login."
    else
        echo "  Could not write /Applications (needs admin). Install it yourself:"
        echo "    sudo cp -R '$bundle' '$installed' && open '$installed'"
    fi
}

uninstall_macos() {
    info "macOS app"
    act rm -rf "$ROOT/macos/ClaudeUsagePanel.app"
    act rm -rf "/Applications/ClaudeUsagePanel.app"
    ok "removed built + installed bundles (source untouched)"
    echo "  If it was set to start at login, remove it in System Settings ▸ General ▸ Login Items."
}

# ── Daily auto-update ───────────────────────────────────────────────────────────
# Schedules scripts/auto-update.sh once a day. That script is the one with all
# the safety rules (skips a dirty or diverged checkout, only ever fast-forwards,
# reinstalls just the targets already present) - here we only wire the schedule.
AU_UNIT="claude-usage-panel-update"                     # systemd user units
AU_LABEL="io.github.fschmutz.claude-usage-panel.update" # launchd agent
AU_CRON_TAG="# claude-usage-panel auto-update"          # cron marker line

_au_systemd_dir() { echo "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"; }
_au_plist() { echo "$HOME/Library/LaunchAgents/$AU_LABEL.plist"; }

# Which daily scheduler this machine offers: launchd | systemd | cron | none.
# Shared by the autoupdate and sessionping targets. CUP_TEST_SCHEDULER is a
# unit-test hook: it forces a branch so tests can exercise one deterministically
# (with the scheduler binary stubbed on PATH).
_au_scheduler() {
    if [ -n "${CUP_TEST_SCHEDULER:-}" ]; then
        echo "$CUP_TEST_SCHEDULER"
        return 0
    fi
    if [ "$(uname -s)" = "Darwin" ] && command -v launchctl >/dev/null; then
        echo launchd
    elif command -v systemctl >/dev/null && [ -d /run/systemd/system ]; then
        echo systemd
    elif command -v crontab >/dev/null; then
        echo cron
    else
        echo none
    fi
}

# Write a unit/plist from stdin, honouring --dry-run (stdin is always consumed).
# Shared by the autoupdate and sessionping targets.
_au_write() {
    local path="$1"
    if $DRY; then
        cat >/dev/null
        echo "  would: write $path"
        return 0
    fi
    mkdir -p "$(dirname "$path")"
    cat >"$path"
}

_au_installed() {
    [ -f "$(_au_systemd_dir)/$AU_UNIT.timer" ] && return 0
    [ -f "$(_au_plist)" ] && return 0
    if command -v crontab >/dev/null && crontab -l 2>/dev/null | grep -qF "$AU_CRON_TAG"; then
        return 0
    fi
    return 1
}

install_autoupdate() {
    info "Daily auto-update"
    if ! git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        skip "autoupdate: $ROOT is not a git checkout - nothing to update from"
        return 0
    fi
    local runner="$ROOT/scripts/auto-update.sh"
    act chmod +x "$runner"

    case "$(_au_scheduler)" in
        systemd)
            local dir
            dir="$(_au_systemd_dir)"
            _au_write "$dir/$AU_UNIT.service" <<EOF
[Unit]
Description=Claude Usage Panel - daily update check
Documentation=https://github.com/fschmutz/claude-usage-panel

[Service]
Type=oneshot
ExecStart=$runner --quiet
EOF
            # Persistent=true runs a missed check on the next login (laptop was
            # off); RandomizedDelaySec spreads the load off a round hour.
            _au_write "$dir/$AU_UNIT.timer" <<EOF
[Unit]
Description=Claude Usage Panel - daily update check

[Timer]
OnCalendar=daily
RandomizedDelaySec=4h
Persistent=true

[Install]
WantedBy=timers.target
EOF
            act systemctl --user daemon-reload
            act systemctl --user enable --now "$AU_UNIT.timer"
            $DRY || ok "systemd user timer enabled (systemctl --user list-timers | grep $AU_UNIT)"
            ;;
        launchd)
            local plist
            plist="$(_au_plist)"
            _au_write "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$AU_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$runner</string>
    <string>--quiet</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>11</integer><key>Minute</key><integer>17</integer></dict>
  <key>RunAtLoad</key><false/>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
</dict>
</plist>
EOF
            if $DRY; then
                echo "  would: launchctl bootstrap gui/$(id -u) $plist"
            else
                launchctl bootout "gui/$(id -u)/$AU_LABEL" >/dev/null 2>&1 || true
                launchctl bootstrap "gui/$(id -u)" "$plist" >/dev/null 2>&1 ||
                    launchctl load -w "$plist" >/dev/null 2>&1 || true
            fi
            $DRY || ok "launchd agent loaded (daily at 11:17)"
            ;;
        cron)
            local line="17 11 * * * $runner --quiet  $AU_CRON_TAG"
            if $DRY; then
                echo "  would: add crontab line: $line"
            else
                # Drop any previous line of ours, then append - idempotent.
                {
                    crontab -l 2>/dev/null | grep -vF "$AU_CRON_TAG" || true
                    echo "$line"
                } | crontab -
            fi
            $DRY || ok "cron entry added (daily at 11:17)"
            ;;
        *)
            skip "autoupdate: no systemd, launchd or cron found to schedule it"
            return 0
            ;;
    esac

    if $DRY; then
        ok "dry-run: no changes written"
        return 0
    fi
    echo "  Checks the newest released tag daily and installs it if it's newer."
    echo "  It skips a dirty or diverged checkout, and only reinstalls targets you already have."
    echo "  Now:  $runner --check    Status:  $runner --status"
    echo "  Off:  ./install.sh --uninstall autoupdate"
}

uninstall_autoupdate() {
    info "Daily auto-update"
    # Remove all three wirings regardless of what this machine currently offers,
    # so a schedule left by an earlier setup can't survive an uninstall.
    if command -v systemctl >/dev/null; then
        act systemctl --user disable --now "$AU_UNIT.timer" >/dev/null 2>&1 || true
    fi
    act rm -f "$(_au_systemd_dir)/$AU_UNIT.timer" "$(_au_systemd_dir)/$AU_UNIT.service"
    if command -v systemctl >/dev/null; then
        act systemctl --user daemon-reload >/dev/null 2>&1 || true
    fi
    if command -v launchctl >/dev/null; then
        if $DRY; then
            echo "  would: launchctl bootout gui/$(id -u)/$AU_LABEL"
        else
            launchctl bootout "gui/$(id -u)/$AU_LABEL" >/dev/null 2>&1 || true
        fi
    fi
    act rm -f "$(_au_plist)"
    if command -v crontab >/dev/null; then
        if $DRY; then
            echo "  would: drop the '$AU_CRON_TAG' line from your crontab"
        elif crontab -l 2>/dev/null | grep -qF "$AU_CRON_TAG"; then
            # `|| true`: grep -v selecting zero lines (ours was the only
            # entry) must not kill the uninstall under pipefail.
            { crontab -l 2>/dev/null | grep -vF "$AU_CRON_TAG" || true; } | crontab -
        fi
    fi
    ok "removed (no more daily checks)"
}

# ── Scheduled session pings ─────────────────────────────────────────────────────
# Schedules scripts/session-ping.sh at fixed local times so the 5-hour Claude
# Code session window opens on schedule instead of at the first real message of
# the day. Opt-in only (never auto-detected): every ping spends one haiku turn.
SP_UNIT="claude-usage-panel-sessionping"                     # systemd user units
SP_LABEL="io.github.fschmutz.claude-usage-panel.sessionping" # launchd agent
SP_CRON_TAG="# claude-usage-panel session-ping"              # cron marker line

_sp_plist() { echo "$HOME/Library/LaunchAgents/$SP_LABEL.plist"; }

_sp_installed() {
    [ -f "$(_au_systemd_dir)/$SP_UNIT.timer" ] && return 0
    [ -f "$(_sp_plist)" ] && return 0
    if command -v crontab >/dev/null && crontab -l 2>/dev/null | grep -qF "$SP_CRON_TAG"; then
        return 0
    fi
    return 1
}

# Times already scheduled (HH:MM, one per line) - lets `update` and a bare
# reinstall preserve a custom schedule instead of resetting to the default.
# scripts/session-ping.sh --status duplicates this read; keep the formats in sync.
_sp_current_times() {
    if [ -f "$(_au_systemd_dir)/$SP_UNIT.timer" ]; then
        sed -n 's/^OnCalendar=\*-\*-\* \([0-9][0-9]:[0-9][0-9]\):00$/\1/p' \
            "$(_au_systemd_dir)/$SP_UNIT.timer"
    elif [ -f "$(_sp_plist)" ]; then
        sed -n 's/.*<key>Hour<\/key><integer>\([0-9]*\)<\/integer><key>Minute<\/key><integer>\([0-9]*\)<\/integer>.*/\1 \2/p' \
            "$(_sp_plist)" | awk '{printf "%02d:%02d\n", $1, $2}'
    elif command -v crontab >/dev/null; then
        crontab -l 2>/dev/null | grep -F "$SP_CRON_TAG" |
            awk '{printf "%02d:%02d\n", $2, $1}'
    fi
    return 0
}

# The --days= list baked into the current schedule, if any.
_sp_current_days() {
    local f
    for f in "$(_au_systemd_dir)/$SP_UNIT.service" "$(_sp_plist)"; do
        if [ -f "$f" ]; then
            grep -o -- '--days=[0-9,]*' "$f" | head -1 | cut -d= -f2
            return 0
        fi
    done
    if command -v crontab >/dev/null; then
        crontab -l 2>/dev/null | grep -F "$SP_CRON_TAG" |
            grep -o -- '--days=[0-9,]*' | head -1 | cut -d= -f2
    fi
    return 0
}

# mon,wed,... / mon-fri / all / an already-numeric list → sorted unique 1..7
# list in `date +%u` numbering (1 = Monday). Prints nothing on invalid input.
_sp_normalize_days() {
    local spec d n list=""
    spec="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
    case "$spec" in
        "" | mon-fri)
            echo "1,2,3,4,5"
            return 0
            ;;
        all)
            echo "1,2,3,4,5,6,7"
            return 0
            ;;
    esac
    # Validate before the unquoted split below - a glob character in the spec
    # must not expand against the current directory.
    [[ "$spec" =~ ^[a-z0-9]+(,[a-z0-9]+)*$ ]] || return 1
    for d in ${spec//,/ }; do
        case "$d" in
            mon | 1) n=1 ;;
            tue | 2) n=2 ;;
            wed | 3) n=3 ;;
            thu | 4) n=4 ;;
            fri | 5) n=5 ;;
            sat | 6) n=6 ;;
            sun | 7) n=7 ;;
            *) return 1 ;;
        esac
        list="$list$n"$'\n'
    done
    printf '%s' "$list" | sort -u | paste -sd, -
}

install_sessionping() {
    info "Scheduled session pings"
    local runner="$ROOT/scripts/session-ping.sh"
    local times=() norm=() t h m days spec

    # Times: command line, else whatever is already scheduled, else the default.
    if [ ${#SP_TIMES[@]} -gt 0 ]; then
        times=("${SP_TIMES[@]}")
    else
        # not mapfile: the stock macOS bash is 3.2
        while IFS= read -r t; do [ -n "$t" ] && times+=("$t"); done < <(_sp_current_times)
        [ ${#times[@]} -gt 0 ] || times=("05:30")
    fi
    for t in "${times[@]}"; do
        if [[ "$t" =~ ^([01]?[0-9]|2[0-3]):([0-5][0-9])$ ]]; then
            norm+=("$(printf '%02d:%s' "$((10#${t%%:*}))" "${t#*:}")")
        else
            echo "sessionping: invalid time '$t' (want HH:MM, 00:00-23:59)" >&2
            exit 2
        fi
    done
    times=("${norm[@]}")

    # Days: command line, else the list baked into the current schedule.
    spec="${SP_DAYS:-$(_sp_current_days)}"
    if ! days="$(_sp_normalize_days "$spec")" || [ -z "$days" ]; then
        echo "sessionping: invalid --days '$spec' (want e.g. mon,wed,fri or mon-fri or all)" >&2
        exit 2
    fi

    echo "  schedule: at ${times[*]} on days $days (1 = Monday)"
    if ! command -v claude >/dev/null; then
        skip "claude CLI not found on PATH - pings will no-op until it is installed"
    fi
    act chmod +x "$runner"

    case "$(_au_scheduler)" in
        systemd)
            local dir entries=""
            dir="$(_au_systemd_dir)"
            _au_write "$dir/$SP_UNIT.service" <<EOF
[Unit]
Description=Claude Usage Panel - session-window ping
Documentation=https://github.com/fschmutz/claude-usage-panel

[Service]
Type=oneshot
ExecStart=$runner --quiet --days=$days
EOF
            for t in "${times[@]}"; do
                entries+="OnCalendar=*-*-* $t:00"$'\n'
            done
            # Exact times are the point: no RandomizedDelaySec, and no catch-up
            # on wake (Persistent) - a late ping would only shift the window.
            _au_write "$dir/$SP_UNIT.timer" <<EOF
[Unit]
Description=Claude Usage Panel - session-window ping

[Timer]
${entries}Persistent=false

[Install]
WantedBy=timers.target
EOF
            act systemctl --user daemon-reload
            act systemctl --user enable --now "$SP_UNIT.timer"
            $DRY || ok "systemd user timer enabled (systemctl --user list-timers | grep $SP_UNIT)"
            ;;
        launchd)
            local plist intervals=""
            plist="$(_sp_plist)"
            for t in "${times[@]}"; do
                h="$((10#${t%%:*}))"
                m="$((10#${t#*:}))"
                intervals+="    <dict><key>Hour</key><integer>$h</integer><key>Minute</key><integer>$m</integer></dict>"$'\n'
            done
            _au_write "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$SP_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$runner</string>
    <string>--quiet</string>
    <string>--days=$days</string>
  </array>
  <key>StartCalendarInterval</key>
  <array>
${intervals}  </array>
  <key>RunAtLoad</key><false/>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
</dict>
</plist>
EOF
            if $DRY; then
                echo "  would: launchctl bootstrap gui/$(id -u) $plist"
            else
                launchctl bootout "gui/$(id -u)/$SP_LABEL" >/dev/null 2>&1 || true
                launchctl bootstrap "gui/$(id -u)" "$plist" >/dev/null 2>&1 ||
                    launchctl load -w "$plist" >/dev/null 2>&1 || true
            fi
            $DRY || ok "launchd agent loaded (at ${times[*]})"
            ;;
        cron)
            local line newlines=""
            for t in "${times[@]}"; do
                line="$((10#${t#*:})) $((10#${t%%:*})) * * * $runner --quiet --days=$days  $SP_CRON_TAG"
                if $DRY; then
                    echo "  would: add crontab line: $line"
                else
                    newlines+="$line"$'\n'
                fi
            done
            if ! $DRY; then
                # Drop any previous lines of ours, then append - idempotent.
                {
                    crontab -l 2>/dev/null | grep -vF "$SP_CRON_TAG" || true
                    printf '%s' "$newlines"
                } | crontab -
            fi
            $DRY || ok "cron entries added (at ${times[*]})"
            ;;
        *)
            skip "sessionping: no systemd, launchd or cron found to schedule it"
            return 0
            ;;
    esac

    if $DRY; then
        ok "dry-run: no changes written"
        return 0
    fi
    echo "  Each ping is one haiku turn; it opens the 5h session window at that time."
    echo "  Change it any time: ./install.sh sessionping HH:MM [HH:MM ...] [--days=...]"
    echo "  Now:  $runner --force    Status:  $runner --status"
    echo "  Off:  ./install.sh --uninstall sessionping"
}

uninstall_sessionping() {
    info "Scheduled session pings"
    # Remove all three wirings regardless of what this machine currently offers,
    # so a schedule left by an earlier setup can't survive an uninstall.
    if command -v systemctl >/dev/null; then
        act systemctl --user disable --now "$SP_UNIT.timer" >/dev/null 2>&1 || true
    fi
    act rm -f "$(_au_systemd_dir)/$SP_UNIT.timer" "$(_au_systemd_dir)/$SP_UNIT.service"
    if command -v systemctl >/dev/null; then
        act systemctl --user daemon-reload >/dev/null 2>&1 || true
    fi
    if command -v launchctl >/dev/null; then
        if $DRY; then
            echo "  would: launchctl bootout gui/$(id -u)/$SP_LABEL"
        else
            launchctl bootout "gui/$(id -u)/$SP_LABEL" >/dev/null 2>&1 || true
        fi
    fi
    act rm -f "$(_sp_plist)"
    if command -v crontab >/dev/null; then
        if $DRY; then
            echo "  would: drop the '$SP_CRON_TAG' lines from your crontab"
        elif crontab -l 2>/dev/null | grep -qF "$SP_CRON_TAG"; then
            # `|| true`: grep -v selecting zero lines (ours were the only
            # entries) must not kill the uninstall under pipefail.
            { crontab -l 2>/dev/null | grep -vF "$SP_CRON_TAG" || true; } | crontab -
        fi
    fi
    ok "removed (no more session pings)"
}

# ── Target resolution ───────────────────────────────────────────────────────────
ALL_TARGETS="gnome statusline mcp macos autoupdate sessionping"

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
    # Staying current is the default, but only where it can work: a git checkout
    # to pull from and something to run a daily job. Opt out any time with
    # `./install.sh --uninstall autoupdate`.
    if git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 &&
        [ "$(_au_scheduler)" != none ]; then
        echo autoupdate
    fi
    return 0
}

# Print the targets currently installed on this machine, one per line. Drives
# `update` (reinstall only what's actually there) and `--list`.
installed_targets() {
    [ -d "$HOME/.local/share/gnome-shell/extensions/$UUID" ] && echo gnome
    [ -f "$HOME/.claude/claude-usage-statusline.mjs" ] && echo statusline
    [ -f "$HOME/.claude/claude-usage-mcp.mjs" ] && echo mcp
    [ -d "/Applications/ClaudeUsagePanel.app" ] && echo macos
    _au_installed && echo autoupdate
    _sp_installed && echo sessionping
    return 0
}

is_target() {
    local t
    for t in $ALL_TARGETS; do [ "$t" = "$1" ] && return 0; done
    return 1
}

usage() {
    # Print the leading comment block (after the shebang) as help text.
    awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "$0"
}

# ── Main ────────────────────────────────────────────────────────────────────────
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
# uninstall fall back to what fits this OS.
if [ ${#targets[@]} -eq 0 ]; then
    if [ "$action" = update ]; then
        mapfile -t targets < <(installed_targets)
    else
        mapfile -t targets < <(detect_targets)
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
