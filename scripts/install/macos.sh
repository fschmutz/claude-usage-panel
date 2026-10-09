# shellcheck shell=bash
# Sourced by install.sh: the macOS menu-bar app target.
#
# Two ways to get the bundle: build it from this checkout (`swift build`), or
# --prebuilt, which downloads the release's ClaudeUsagePanel-macos.zip and
# checks it against the sha256 the release's cask pins. --prebuilt is chosen
# on its own when there is no Swift toolchain: the Command Line Tools need an
# admin to install, the zip needs nobody. `update` keeps the choice
# (<state dir>/macos-prebuilt).
#
# Where it goes: --appdir=DIR, else wherever it is already installed, else
# /Applications when this account can write there, else ~/Applications (a
# standard, non-admin account). Nothing here ever needs sudo.

MAC_APP="ClaudeUsagePanel"

# /Applications, overridable so the tests never touch the real one.
mac_system_apps() { printf '%s\n' "${CUP_TEST_SYSTEM_APPS:-/Applications}"; }

# Every place an install can live, in the order they are looked at.
mac_app_dirs() {
    mac_system_apps
    printf '%s\n' "$HOME/Applications"
}

# The installed bundle's path, or nothing.
mac_installed_app() {
    local d
    while IFS= read -r d; do
        [ -d "$d/$MAC_APP.app" ] && printf '%s\n' "$d/$MAC_APP.app" && return 0
    done < <(mac_app_dirs)
    return 0
}

# Where this run installs to (see the header).
mac_target_dir() {
    if [ -n "$APPDIR" ]; then
        printf '%s\n' "${APPDIR%/}"
        return 0
    fi
    # an existing install this account can replace wins; then any existing
    # one (an admin's copy: the run fails and says how to install per user)
    local d first="" sys
    while IFS= read -r d; do
        [ -d "$d/$MAC_APP.app" ] || continue
        if [ -w "$d" ]; then
            printf '%s\n' "$d"
            return 0
        fi
        [ -n "$first" ] || first="$d"
    done < <(mac_app_dirs)
    if [ -n "$first" ]; then
        printf '%s\n' "$first"
        return 0
    fi
    sys="$(mac_system_apps)"
    if [ -w "$sys" ]; then printf '%s\n' "$sys"; else printf '%s\n' "$HOME/Applications"; fi
}

# Build $1 (the bundle path) from source. 0 only when it holds an executable.
mac_build_bundle() {
    local bundle="$1" ver="$2"
    # Every step carries its own `|| exit 1`. `set -e` cannot do it here: bash
    # ignores errexit inside a command whose status is being tested (this
    # `if !`), even after an explicit `set -e` in the subshell. The status was
    # then the last command's - the Info.plist heredoc - so a failed `swift
    # build` reported "built" with no binary in the bundle, and the release
    # zip or /Applications got the empty app. The -x check after it is the
    # outcome itself: no executable, no build, whatever the steps said.
    if ! (
        cd "$ROOT/macos" || exit 1
        swift build -c release || exit 1
        bin_dir="$(swift build -c release --show-bin-path)" || exit 1
        rm -rf "$bundle" || exit 1
        mkdir -p "$bundle/Contents/MacOS" "$bundle/Contents/Resources" || exit 1
        cp "$bin_dir/$MAC_APP" "$bundle/Contents/MacOS/$MAC_APP" || exit 1
        # The app's Settings can schedule session pings; give the launchd agent
        # a runner that survives without a git checkout - with the lib it sources.
        cp "$ROOT/scripts/session-ping.sh" "$ROOT/scripts/lib.sh" \
            "$bundle/Contents/Resources/" || exit 1
        chmod +x "$bundle/Contents/Resources/session-ping.sh" || exit 1
        cat >"$bundle/Contents/Info.plist" <<PLIST || exit 1
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
  <key>CFBundleExecutable</key><string>$MAC_APP</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST
    ) || [ ! -x "$bundle/Contents/MacOS/$MAC_APP" ]; then
        return 1
    fi
    # Ad-hoc sign so "Start at login" (SMAppService) and Gatekeeper accept the
    # bundle for personal use; a Developer ID is only needed to distribute it
    # (see PUBLISHING.md). The signature is preserved by the copy below.
    codesign --deep --force --sign - "$bundle" >/dev/null 2>&1 || true
}

sha256_of() {
    # shasum is on macOS; sha256sum is not
    if command -v shasum >/dev/null; then shasum -a 256 "$1" | cut -d' ' -f1; else sha256sum "$1" | cut -d' ' -f1; fi
}

# The release's bundle for v$2, unpacked under $1. Prints the bundle path; the
# reason on stderr and 1 when the zip cannot be had or does not check out.
mac_fetch_bundle() {
    local dir="$1" ver="$2" base zipver want got
    base="${CUP_RELEASE_BASE:-https://github.com/fschmutz/claude-usage-panel/releases/download}/v$ver"
    if ! curl -fsSL -o "$dir/app.zip" "$base/$MAC_APP-macos.zip" 2>/dev/null; then
        echo "no $MAC_APP-macos.zip in release v$ver" >&2
        return 1
    fi
    # The cask attached to the same release pins the zip's sha256 (make-cask.sh)
    if ! curl -fsSL -o "$dir/cask.rb" "$base/claude-usage-panel.rb" 2>/dev/null; then
        echo "release v$ver has no cask to check the zip against" >&2
        return 1
    fi
    want="$(sed -nE 's/^  sha256 "([0-9a-f]{64})".*/\1/p' "$dir/cask.rb" | head -1)"
    got="$(sha256_of "$dir/app.zip")"
    if [ -z "$want" ] || [ "$want" != "$got" ]; then
        echo "the zip's sha256 ($got) is not the one release v$ver pins (${want:-none})" >&2
        return 1
    fi
    if ! { mkdir -p "$dir/x" && ditto -x -k "$dir/app.zip" "$dir/x" 2>/dev/null; }; then
        echo "could not unpack the zip" >&2
        return 1
    fi
    local bundle="$dir/x/$MAC_APP.app"
    [ -x "$bundle/Contents/MacOS/$MAC_APP" ] || {
        echo "the zip holds no $MAC_APP executable" >&2
        return 1
    }
    zipver="$(sed -nE -e '/CFBundleShortVersionString/{n;s@.*<string>([^<]+)</string>.*@\1@p;}' \
        "$bundle/Contents/Info.plist" | head -1)"
    [ "$zipver" = "$ver" ] || {
        echo "the zip is v${zipver:-?}, not v$ver" >&2
        return 1
    }
    # what a browser download would carry; curl sets none, a copied zip might
    xattr -dr com.apple.quarantine "$bundle" 2>/dev/null || true
    printf '%s\n' "$bundle"
}

install_macos() {
    info "macOS app"
    if [ "$(uname -s)" != "Darwin" ]; then
        skip_fatal "macos: only builds on macOS (uname is $(uname -s))"
        return 0
    fi
    # an update keeps the way the app was installed: a --prebuilt install
    # must not turn into a swift build the day a toolchain shows up
    local how=build marker
    marker="$(_state_dir)/macos-prebuilt"
    if $PREBUILT || ! command -v swift >/dev/null \
        || { [ "${action:-}" = update ] && [ -f "$marker" ]; }; then
        how=prebuilt
    fi
    if [ "$how" = prebuilt ] && $BUILD_ONLY; then
        skip_fatal "macos: --build-only needs the Swift toolchain (it is what makes the release zip)"
        return 1
    fi
    local bundle="$ROOT/macos/$MAC_APP.app"
    local installed_note="the app already installed keeps running"
    local ver dest
    ver="$(version)"
    dest="$(mac_target_dir)"
    if $DRY; then
        if [ "$how" = build ]; then
            echo "  would: swift build -c release + assemble $bundle (v$ver)"
        else
            echo "  would: download the v$ver release zip, check its sha256 against the release's cask, unpack it"
        fi
        echo "  would: quit a running instance, cp -R to $dest/$MAC_APP.app, open it"
        ok "dry-run: nothing installed"
        return 0
    fi
    local tmp=""
    if [ "$how" = build ]; then
        if ! mac_build_bundle "$bundle" "$ver"; then
            skip_fatal "macos: the build failed - $installed_note"
            return 1
        fi
        ok "built $bundle (v$ver)"
    else
        tmp="$(mktemp -d)"
        local why
        if ! bundle="$(mac_fetch_bundle "$tmp" "$ver" 2>"$tmp/why")"; then
            why="$(cat "$tmp/why")"
            rm -rf "$tmp"
            skip_fatal "macos: prebuilt v$ver not installed: $why - $installed_note"
            return 1
        fi
        ok "downloaded the v$ver release zip (sha256 checked)"
    fi

    # CI builds the bundle only (to zip as a release asset) - no install.
    if $BUILD_ONLY; then
        ok "build-only: skipped the install"
        return 0
    fi

    # Make it perpetual: install it and launch it. On first run the app
    # registers itself as a login item (toggle in Settings ▸ Start at login).
    # Quit any running instance first so we replace (not copy over) a busy bundle
    # and so `open` relaunches the NEW binary - this is what makes upgrades take.
    osascript -e 'quit app "Claude Usage Panel"' >/dev/null 2>&1 || true
    local installed="$dest/$MAC_APP.app"
    if mkdir -p "$dest" 2>/dev/null && rm -rf "$installed" 2>/dev/null && cp -R "$bundle" "$installed" 2>/dev/null; then
        [ -n "$tmp" ] && rm -rf "$tmp"
        open "$installed" 2>/dev/null || true
        if [ "$how" = prebuilt ]; then
            mkdir -p "$(dirname "$marker")" && : >"$marker"
        else
            rm -f "$marker"
        fi
        ok "installed to $installed and launched"
        echo "  Starts at login by default - toggle it in Settings ▸ Start at login."
    else
        [ -n "$tmp" ] && rm -rf "$tmp"
        # Not a skip and not an "ok": the old binary is still what runs. Saying
        # so with a zero exit is what let an update stamp itself as installed
        # while the old bundle kept the previous release, indefinitely.
        skip_fatal "macos: could not replace $installed (not writable by $(id -un)) - $installed_note"
        echo "  Install it for this account only:  ./install.sh macos --appdir=\"\$HOME/Applications\""
        return 1
    fi
}

uninstall_macos() {
    info "macOS app"
    act rm -rf "$ROOT/macos/$MAC_APP.app"
    local d
    while IFS= read -r d; do
        [ -d "$d/$MAC_APP.app" ] && act rm -rf "$d/$MAC_APP.app"
    done < <(mac_app_dirs)
    ok "removed built + installed bundles (source untouched)"
    echo "  If it was set to start at login, remove it in System Settings ▸ General ▸ Login Items."
}
