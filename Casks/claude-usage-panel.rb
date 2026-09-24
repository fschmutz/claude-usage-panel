# Homebrew cask for the macOS menu-bar app. Ships as a release asset next to
# ClaudeUsagePanel-macos.zip, so it installs with no tap:
#
#   brew install --cask https://github.com/fschmutz/claude-usage-panel/releases/latest/download/claude-usage-panel.rb
#
# `version` is kept current by scripts/bump-version.sh (see
# scripts/version-sites.sh) and `sha256` by scripts/make-cask.sh, which the
# release workflow runs against the zip it just uploaded - the checksum in this
# file is therefore the PREVIOUS release's until that step rewrites it, and
# `brew` verifies it either way.
cask "claude-usage-panel" do
  version "2.2.0"
  sha256 :no_check

  url "https://github.com/fschmutz/claude-usage-panel/releases/download/v#{version}/ClaudeUsagePanel-macos.zip"
  name "Claude Usage Panel"
  desc "Menu-bar panel for Claude Code plan usage"
  homepage "https://github.com/fschmutz/claude-usage-panel"

  app "ClaudeUsagePanel.app"

  # The app is ad-hoc signed until the Developer ID secrets are configured
  # (PUBLISHING.md), so Gatekeeper quarantines it on first launch. A cask
  # cannot notarize anything; it can at least say how to open it.
  caveats <<~CAVEATS
    This build is ad-hoc signed, not notarized. On first launch:
      right-click ClaudeUsagePanel.app in /Applications and choose Open.

    It reads the Claude Code OAuth token from your login Keychain, read-only,
    and never writes it.
  CAVEATS

  zap trash: [
    "~/Library/Preferences/io.github.fschmutz.claude-usage-panel.plist",
    "~/Library/Application Support/claude-usage-panel",
    "~/Library/Caches/claude-usage-panel",
  ]
end
