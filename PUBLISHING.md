# Publishing / distribution

## Cutting a release

**A release is only ever a commit CI has passed.** The tag is what every
checkout's daily auto-update installs, so a tag on an untested commit ships
untested code to everyone. Fixes and features go to `main` on their own, with
their entry under `CHANGELOG.md` `[Unreleased]`; nothing bumps the version.
A release is a separate step, on demand, batching everything since the last
tag:

```bash
scripts/release.sh             # the version the commits imply, after a y/N
scripts/release.sh 3.6.0       # that version (refused below what they imply)
scripts/release.sh --dry-run   # the plan; changes nothing
```

| Step | What release.sh does | Stops when |
| --- | --- | --- |
| 1 | checks main, clean, equal to `origin/main`, `ci-gate` green on it | any of them is not true |
| 2 | version from the conventional commits since the last tag: `!` / `BREAKING CHANGE` major, `feat` minor, else patch (`scripts/release-version.mjs`) | the given version is below that, or `[Unreleased]` is empty |
| 3 | `bump-version.sh`, commits `chore(release): vX.Y.Z`, pushes main | the push is refused |
| 4 | waits for `ci-gate` on the release commit | red or timed out: left untagged |
| 5 | tags that commit, pushes the tag | the tag did not land |

A red release commit stays untagged: re-run the failed jobs
(`gh run rerun --failed`), then run `scripts/release.sh` again. A HEAD that is
an untagged `chore(release)` commit is resumed at step 4.

Two backstops catch a tag pushed by hand. `release.yml` refuses to build a
Release for a tag whose commit is not `ci-gate` green (re-run it from the
Actions tab once it is). And `auto-update.sh` installs a tag only once its
GitHub Release exists, so a refused tag reaches nobody.

`bump-version.sh` writes `package.json` (`version`), `metadata.json`
(`version-name`), the Homebrew cask example below, and opens a dated
`CHANGELOG.md` section above a fresh `[Unreleased]`. `package.json` is the single
source of truth the macOS bundle reads - never hardcode a version anywhere.

**Pushing the `v*` tag triggers `.github/workflows/release.yml`**, which builds
the GNOME `.shell-extension.zip`, extracts that version's `CHANGELOG.md` section
as the release notes, and creates the GitHub Release with the zip attached. No
manual `gh release create` needed. To (re)release an existing tag, run the
**release** workflow from the Actions tab with the tag as input: a
`workflow_dispatch` re-run builds the tag itself, never the dispatching branch.
The workflow refuses a tag that does not match `package.json`
(`scripts/check-versions.sh --tag`). `plugin/.mcp.json` pins the npx spec to the
release tag, so push the tag right behind the bump commit: until it exists the
plugin names a release nobody can fetch. The macOS
`.app` is built and attached too (`ClaudeUsagePanel-macos.zip`), signed with a
Developer ID and notarized if the secrets below are configured, ad-hoc signed
otherwise - see below.

**The published Release is what ships to existing users.** Every checkout
with the `autoupdate` target installed (`scripts/auto-update.sh`, on by
default) looks once a day for the highest `v*` tag whose GitHub Release exists
and installs it - so a version bump on `main` without a tag, or a tag
release.yml refused, reaches nobody.

## GNOME - extensions.gnome.org (EGO)

A packaged zip is attached to each GitHub release
(`claude-usage-panel@fschmutz.github.io.shell-extension.zip`), or rebuild it from
the repository root:

```bash
uuid=claude-usage-panel@fschmutz.github.io
zip_out="$PWD/$uuid.shell-extension.zip"
tmp=$(mktemp -d)
scripts/pack-gnome.sh "$tmp/$uuid"
(cd "$tmp/$uuid" && zip -rq "$zip_out" .)
```

This is the exact sequence `release.yml` runs. Do not rebuild it with a bare
`gnome-extensions pack`: that packs neither the compiled `locale/` nor the
`scripts/` the extension runs itself (`auto-update.sh` behind the Updates row,
`session-ping.sh` behind session pings), so the zip installs with "Cannot
self-update" and no ping runner.

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
| --- | --- |
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
that zip (`scripts/make-cask.sh`, run right after the upload). Its
`homebrew-tap` job then publishes that pinned cask to `fschmutz/homebrew-tap`
(`scripts/publish-cask.sh`) with a GitHub App installation token that
`actions/create-github-app-token` mints for the job: `contents: write` on that
repo only, valid about an hour, revoked when the job ends. No personal token
to expire or mis-scope. One-time setup, `scripts/setup-tap-app.sh`: it creates
the App from a manifest (one click in the browser), stores its client id as
the `TAP_APP_CLIENT_ID` variable and its private key as the
`TAP_APP_PRIVATE_KEY` secret, opens the install page (pick `homebrew-tap`
only), then runs `.github/workflows/tap-check.yml`, which mints a token with
the stored credentials exactly as the release does. Re-running it reuses the
stored App (`--recreate` makes a new one), and `gh workflow run tap-check.yml`
re-checks the credentials any time without cutting a release. Without
them the job fails, since a release brew users never see is not a success;
it re-runs alone, without rebuilding the app.

```bash
brew install --cask fschmutz/tap/claude-usage-panel
brew upgrade --cask claude-usage-panel
```

`bump-version.sh` owns the `version` line (scripts/version-sites.sh) and
`check-versions.sh` fails if it drifts or if the URL stops matching the asset
name. To regenerate by hand:

```bash
scripts/make-cask.sh v2.1.2                  # downloads that release's zip
scripts/make-cask.sh v2.1.2 /path/to/zip     # or checksums a local one
```

The pinned asset also installs with no tap:
`brew install --cask https://github.com/fschmutz/claude-usage-panel/releases/latest/download/claude-usage-panel.rb`.
Without the Developer ID secrets above
the app is only ad-hoc signed, so Gatekeeper still warns on first launch and
the cask says so in its caveats - a cask cannot notarize anything; notarizing
first is what makes it install cleanly.
