# Homebrew cask for the macOS menu-bar app. The release workflow publishes it,
# pinned to the release zip's sha256, to the fschmutz/homebrew-tap repo
# (scripts/publish-cask.sh):
#
#   brew install --cask fschmutz/tap/claude-usage-panel
#   brew upgrade --cask claude-usage-panel
#
# `version` is kept current by scripts/bump-version.sh (see
# scripts/version-sites.sh). This committed file is the unpinned template:
# `sha256 :no_check` means brew verifies nothing when installing from it. The
# release workflow runs scripts/make-cask.sh against the zip it just uploaded
# and attaches the result, pinned to that zip's sha256, to the release; that
# asset is the cask to install, and brew verifies its checksum.
cask "claude-usage-panel" do
  version "2.2.0"
  sha256 :no_check

  url "https://github.com/fschmutz/claude-usage-panel/releases/download/v#{version}/ClaudeUsagePanel-macos.zip"
  name "Claude Usage Panel"
  desc "Menu-bar panel for Claude Code plan usage"
  homepage "https://github.com/fschmutz/claude-usage-panel"

  # LSMinimumSystemVersion 13.0 and Package.swift's `.macOS(.v13)`.
  depends_on macos: ">= :ventura"

  app "ClaudeUsagePanel.app"

  # The app's session pings are a launchd agent whose runner can be the
  # session-ping.sh bundled in the .app; left loaded, it would keep firing a
  # script that no longer exists. The label is shared with
  # `install.sh sessionping`, so an uninstall also stops pings scheduled from
  # a checkout.
  uninstall launchctl: "io.github.fschmutz.claude-usage-panel.sessionping",
            quit:      "io.github.fschmutz.claude-usage-panel"

  zap trash: [
    "~/Library/Preferences/io.github.fschmutz.claude-usage-panel.plist",
    "~/Library/Application Support/claude-usage-panel",
    "~/Library/Caches/claude-usage-panel",
    "~/Library/LaunchAgents/io.github.fschmutz.claude-usage-panel.sessionping.plist",
    "~/.local/state/claude-usage-panel/last-ping",
    "~/.local/state/claude-usage-panel/ping-cwd",
    "~/.local/state/claude-usage-panel/session-ping.lock",
    "~/.local/state/claude-usage-panel/session-ping.log",
  ]

  # The app is ad-hoc signed until the Developer ID secrets are configured
  # (PUBLISHING.md), so Gatekeeper quarantines it on first launch. A cask
  # cannot notarize anything; it can at least say how to open it.
  caveats <<~CAVEATS
    This build is ad-hoc signed, not notarized. On first launch:
      right-click ClaudeUsagePanel.app in /Applications and choose Open.

    It reads the Claude Code OAuth token from your login Keychain, read-only,
    and never writes it.
  CAVEATS
end
