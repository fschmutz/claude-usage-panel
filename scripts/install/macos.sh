# shellcheck shell=bash
# Sourced by install.sh: the macOS menu-bar app target.

install_macos() {
    info "macOS app"
    if [ "$(uname -s)" != "Darwin" ]; then
        skip_fatal "macos: only builds on macOS (uname is $(uname -s))"
        return 0
    fi
    if ! command -v swift >/dev/null; then
        skip_fatal "macos: Swift toolchain not found"
        return 0
    fi
    local app="ClaudeUsagePanel"
    local bundle="$ROOT/macos/$app.app"
    local installed_note="the app already installed keeps running"
    local ver
    ver="$(version)"
    if $DRY; then
        echo "  would: swift build -c release + assemble $bundle (v$ver)"
        echo "  would: quit a running instance, ad-hoc codesign, cp -R to /Applications/$app.app, open it"
        ok "dry-run: no build performed"
        return 0
    fi
    if ! (
        cd "$ROOT/macos" || exit 1
        swift build -c release
        local bin
        bin="$(swift build -c release --show-bin-path)/$app"
        rm -rf "$bundle"
        mkdir -p "$bundle/Contents/MacOS" "$bundle/Contents/Resources"
        cp "$bin" "$bundle/Contents/MacOS/$app"
        # The app's Settings can schedule session pings; give the launchd agent
        # a runner that survives without a git checkout - with the lib it sources.
        cp "$ROOT/scripts/session-ping.sh" "$ROOT/scripts/lib.sh" "$bundle/Contents/Resources/"
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
    ); then
        skip_fatal "macos: the build failed - $installed_note"
        return 1
    fi
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
        # Not a skip and not an "ok": the old binary is still what runs. Saying
        # so with a zero exit is what let an update stamp itself as installed
        # while /Applications kept the previous release, indefinitely.
        skip_fatal "macos: could not replace $installed (needs admin) - $installed_note"
        echo "  Install it yourself:  sudo cp -R '$bundle' '$installed' && open '$installed'"
        return 1
    fi
}

uninstall_macos() {
    info "macOS app"
    act rm -rf "$ROOT/macos/ClaudeUsagePanel.app"
    act rm -rf "/Applications/ClaudeUsagePanel.app"
    ok "removed built + installed bundles (source untouched)"
    echo "  If it was set to start at login, remove it in System Settings ▸ General ▸ Login Items."
}
