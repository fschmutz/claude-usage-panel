#!/usr/bin/env bash
# Sign a built ClaudeUsagePanel.app with a Developer ID, notarize it with
# Apple, and staple the ticket - the three manual steps documented in
# PUBLISHING.md, as one idempotent script the release workflow can call.
#
# Usage:  scripts/notarize-macos.sh path/to/ClaudeUsagePanel.app
#
# Needs six env vars, all optional as a group: if any is unset this is a
# no-op (exit 0, ad-hoc-signed bundle untouched) so the release workflow
# stays green with no secrets configured, same as every install.sh target
# guards its own dependencies. Set them all as repo secrets to turn it on:
#   MACOS_CERTIFICATE_P12_BASE64  base64 of the Developer ID Application .p12
#   MACOS_CERTIFICATE_PASSWORD    that .p12's export password
#   MACOS_SIGNING_IDENTITY        "Developer ID Application: Name (TEAMID)"
#   APPLE_ID                      Apple ID email used for notarization
#   APPLE_TEAM_ID                 the TEAMID from the signing identity
#   APPLE_APP_SPECIFIC_PASSWORD   an app-specific password for that Apple ID
set -euo pipefail

BUNDLE="${1:-}"
if [ -z "$BUNDLE" ] || [ ! -d "$BUNDLE" ]; then
    echo "Usage: scripts/notarize-macos.sh path/to/ClaudeUsagePanel.app" >&2
    exit 2
fi

for v in MACOS_CERTIFICATE_P12_BASE64 MACOS_CERTIFICATE_PASSWORD \
    MACOS_SIGNING_IDENTITY APPLE_ID APPLE_TEAM_ID APPLE_APP_SPECIFIC_PASSWORD; do
    if [ -z "${!v:-}" ]; then
        echo "notarize-macos: $v not set - leaving the ad-hoc-signed bundle as-is" >&2
        exit 0
    fi
done

TMP="${TMPDIR:-/tmp}"
KEYCHAIN="$TMP/claude-usage-panel-notarize-$$.keychain-db"
KEYCHAIN_PW="$(openssl rand -base64 32)"
CERT_PATH="$TMP/claude-usage-panel-notarize-$$.p12"

# Bash-3.2-safe: read the existing search list into an array without mapfile
# (the stock macOS bash lacks it - see scripts/install/ui.sh's own note).
ORIGINAL_KEYCHAINS=()
while IFS= read -r line; do
    line="${line#"${line%%[![:space:]]*}"}" # trim leading whitespace
    line="${line%\"}"                       # trim surrounding quotes
    line="${line#\"}"
    if [ -n "$line" ]; then
        ORIGINAL_KEYCHAINS+=("$line")
    fi
done < <(security list-keychains -d user)

cleanup() {
    rm -f "$CERT_PATH"
    if [ "${#ORIGINAL_KEYCHAINS[@]}" -gt 0 ]; then
        security list-keychains -d user -s "${ORIGINAL_KEYCHAINS[@]}" >/dev/null 2>&1 || true
    fi
    security delete-keychain "$KEYCHAIN" >/dev/null 2>&1 || true
}
trap cleanup EXIT

base64 --decode <<<"$MACOS_CERTIFICATE_P12_BASE64" >"$CERT_PATH"

# A dedicated, temporary keychain: CI has no login keychain to import the
# Developer ID cert into, and a throwaway one keeps the cert off disk once
# this run ends either way.
security create-keychain -p "$KEYCHAIN_PW" "$KEYCHAIN"
security set-keychain-settings -lut 21600 "$KEYCHAIN"
security unlock-keychain -p "$KEYCHAIN_PW" "$KEYCHAIN"
security import "$CERT_PATH" -k "$KEYCHAIN" -P "$MACOS_CERTIFICATE_PASSWORD" \
    -T /usr/bin/codesign
security set-key-partition-list -S apple-tool:,apple:,codesign: -s \
    -k "$KEYCHAIN_PW" "$KEYCHAIN" >/dev/null

# Prepend so codesign finds the imported identity without dropping the
# runner's existing keychains from the search list.
security list-keychains -d user -s "$KEYCHAIN" "${ORIGINAL_KEYCHAINS[@]}"

echo "==> Signing with Developer ID"
codesign --deep --force --options runtime --keychain "$KEYCHAIN" \
    --sign "$MACOS_SIGNING_IDENTITY" "$BUNDLE"
codesign --verify --deep --strict "$BUNDLE"

echo "==> Notarizing"
NOTARIZE_ZIP="$TMP/claude-usage-panel-notarize-$$.zip"
ditto -c -k --keepParent "$BUNDLE" "$NOTARIZE_ZIP"
xcrun notarytool submit "$NOTARIZE_ZIP" \
    --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" \
    --password "$APPLE_APP_SPECIFIC_PASSWORD" --wait
rm -f "$NOTARIZE_ZIP"

echo "==> Stapling"
xcrun stapler staple "$BUNDLE"

echo "ok: $BUNDLE is Developer ID signed, notarized, and stapled"
