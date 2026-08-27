# Publishing / distribution

## Cutting a release

Bump the version everywhere from one command, commit, then tag:

```bash
scripts/bump-version.sh 1.4.0
git add -A && git commit -m "chore(release): v1.4.0"
git tag v1.4.0 && git push-confirm && git push-confirm --tags
```

`bump-version.sh` writes `package.json` (`version`), `metadata.json`
(`version-name`), the Homebrew cask example below, and opens a dated
`CHANGELOG.md` section above a fresh `[Unreleased]`. `package.json` is the single
source of truth the macOS bundle reads - never hardcode a version anywhere.

**Pushing the `v*` tag triggers `.github/workflows/release.yml`**, which builds
the GNOME `.shell-extension.zip`, extracts that version's `CHANGELOG.md` section
as the release notes, and creates the GitHub Release with the zip attached. No
manual `gh release create` needed. To (re)release an existing tag, run the
**release** workflow from the Actions tab with the tag as input. The macOS `.app`
is not auto-attached yet (needs Developer ID signing / notarization - see below).

**The tag is also what ships the release to existing users.** Every checkout with
the `autoupdate` target installed (`scripts/auto-update.sh`, on by default) polls
for the highest released `v*` tag once a day and installs it - so a version bump
merged to `main` without a pushed tag reaches nobody. Push the tag, then the
release is live for humans and for the daily updater alike.

## GNOME - extensions.gnome.org (EGO)

A packaged zip is attached to each GitHub release
(`claude-usage-panel@fschmutz.github.io.shell-extension.zip`), or rebuild it:

```bash
cd claude-usage-panel@fschmutz.github.io
gnome-extensions pack . \
  --extra-source=lib --extra-source=icons \
  --schema=schemas/org.gnome.shell.extensions.claude-usage-panel.gschema.xml \
  --force -o ..
```

Submit:

1. Sign in at <https://extensions.gnome.org/upload/> (Google/GitHub).
2. Upload the `.shell-extension.zip`.
3. Wait for reviewer approval (manual, usually a few days). Once approved it's
   installable via the GNOME Extensions app / <https://extensions.gnome.org>.

Notes for the reviewer: the extension reads `~/.claude/.credentials.json`
(read-only) and makes one HTTPS request per refresh to `api.anthropic.com`; the
optional Cursor section calls `api.cursor.com` only when enabled with a key.

## macOS - .app bundle

```bash
./install.sh macos              # produces macos/ClaudeUsagePanel.app
open macos/ClaudeUsagePanel.app
```

The bundle version is read from `package.json`, so bump it there (see the
release checklist) before building.

The bundle is a menu-bar agent (`LSUIElement`), no Dock icon.

### Signing & notarization (for distribution)

Local/personal use needs only an ad-hoc signature:

```bash
codesign --deep --force --sign - ClaudeUsagePanel.app
```

To distribute to others without Gatekeeper warnings you need an Apple Developer
account:

```bash
# 1. Sign with your Developer ID
codesign --deep --force --options runtime \
  --sign "Developer ID Application: Your Name (TEAMID)" ClaudeUsagePanel.app

# 2. Zip and notarize
ditto -c -k --keepParent ClaudeUsagePanel.app ClaudeUsagePanel.zip
xcrun notarytool submit ClaudeUsagePanel.zip \
  --apple-id you@example.com --team-id TEAMID --password APP_SPECIFIC_PW --wait

# 3. Staple the ticket
xcrun stapler staple ClaudeUsagePanel.app
```

## macOS - Homebrew cask (optional)

Once a signed `.app` (or zip) is attached to a GitHub release, a cask can install
it. Template - put it in a tap (`homebrew-tap/Casks/claude-usage-panel.rb`) and
fill in the release URL + sha256:

```ruby
cask "claude-usage-panel" do
  version "1.8.0"
  sha256 "REPLACE_WITH_SHA256"

  url "https://github.com/fschmutz/claude-usage-panel/releases/download/v#{version}/ClaudeUsagePanel.zip"
  name "Claude Usage Panel"
  desc "Menu-bar panel for Claude Code plan usage"
  homepage "https://github.com/fschmutz/claude-usage-panel"

  app "ClaudeUsagePanel.app"

  zap trash: [
    "~/Library/Preferences/io.github.fschmutz.claude-usage-panel.plist",
  ]
end
```

Install: `brew install --cask <yourtap>/claude-usage-panel`.
