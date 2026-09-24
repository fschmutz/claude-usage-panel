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
**release** workflow from the Actions tab with the tag as input. The macOS
`.app` is built and attached too (`ClaudeUsagePanel-macos.zip`), signed with a
Developer ID and notarized if the secrets below are configured, ad-hoc signed
otherwise - see below.

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

Local/personal use needs only an ad-hoc signature, which `install.sh macos`
already applies:

```bash
codesign --deep --force --sign - ClaudeUsagePanel.app
```

To distribute to others without Gatekeeper warnings you need an Apple Developer
account. `scripts/notarize-macos.sh` does the three steps below for you (and is
what `.github/workflows/release.yml`'s `macos-asset` job calls on every
release) - set these six repo secrets (Settings ▸ Secrets and variables ▸
Actions) and it takes over automatically; leave any of them unset and the
release stays ad-hoc signed as before:

| Secret | Value |
|---|---|
| `MACOS_CERTIFICATE_P12_BASE64` | `base64 -i YourCert.p12 \| pbcopy` - the exported Developer ID Application cert |
| `MACOS_CERTIFICATE_PASSWORD` | that `.p12`'s export password |
| `MACOS_SIGNING_IDENTITY` | `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_ID` | the Apple ID email used for notarization |
| `APPLE_TEAM_ID` | the `TEAMID` from the signing identity |
| `APPLE_APP_SPECIFIC_PASSWORD` | an [app-specific password](https://support.apple.com/en-us/102654) for that Apple ID |

To run the same three steps locally instead:

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

## macOS - Homebrew cask

The cask lives in the repo at `Casks/claude-usage-panel.rb`, and the release
workflow attaches it to every release next to the zip, with `sha256` pinned to
that zip (`scripts/make-cask.sh`, run right after the upload). No tap is
needed:

```bash
brew install --cask https://github.com/fschmutz/claude-usage-panel/releases/latest/download/claude-usage-panel.rb
brew upgrade --cask claude-usage-panel
```

`bump-version.sh` owns the `version` line (scripts/version-sites.sh) and
`check-versions.sh` fails if it drifts or if the URL stops matching the asset
name. To regenerate by hand:

```bash
scripts/make-cask.sh v2.1.2                  # downloads that release's zip
scripts/make-cask.sh v2.1.2 /path/to/zip     # or checksums a local one
```

For a tap instead (`brew install --cask <tap>/claude-usage-panel`), copy the
same file into `homebrew-<tap>/Casks/`. Without the Developer ID secrets above
the app is only ad-hoc signed, so Gatekeeper still warns on first launch and
the cask says so in its caveats - a cask cannot notarize anything; notarizing
first is what makes it install cleanly.
