#!/usr/bin/env bash
# One-time setup of the GitHub App the release workflow writes the Homebrew tap
# with (release.yml, job homebrew-tap). No personal token: each release mints
# an installation token for fschmutz/homebrew-tap alone, contents:write, about
# an hour long, revoked when the job ends.
#
#   scripts/setup-tap-app.sh            create the App (or reuse the one already
#                                       stored), install it, prove it in CI
#   scripts/setup-tap-app.sh --recreate create a new App even if one is stored
#
# 1. Unless TAP_APP_CLIENT_ID is already set on this repo: opens GitHub's
#    "create App from manifest" page, pre-filled (contents read/write, no
#    webhook, nothing else); you click "Create" and paste back the code GitHub
#    redirects with. The client id becomes the TAP_APP_CLIENT_ID variable and
#    the private key the TAP_APP_PRIVATE_KEY secret, piped from GitHub's
#    answer through a 0600 temp file removed on exit; it is never printed.
# 2. Opens the App's install page: "Only select repositories" -> homebrew-tap.
# 3. Runs .github/workflows/tap-check.yml, which mints a token with the STORED
#    credentials exactly as release.yml does and reads the tap with it.
#
# Re-running is safe: an App already stored is reused, so a run interrupted
# after step 1 resumes at the install page.
set -euo pipefail

REPO="fschmutz/claude-usage-panel"
TAP_REPO="homebrew-tap"
APP_NAME="${TAP_APP_NAME:-fschmutz-tap-publisher}"
CHECK_WORKFLOW="tap-check.yml"

die() {
    printf 'setup-tap-app: %s\n' "$*" >&2
    exit 1
}

recreate=false
case "${1:-}" in
    "") ;;
    --recreate) recreate=true ;;
    *) die "usage: scripts/setup-tap-app.sh [--recreate]" ;;
esac

for tool in gh jq; do
    command -v "$tool" >/dev/null || die "$tool not found on PATH"
done
gh auth status >/dev/null 2>&1 || die "gh is not logged in (gh auth login)"

work="$(mktemp -d "${TMPDIR:-/tmp}/cup-tap-app.XXXXXX")"
chmod 700 "$work"
trap 'rm -rf "$work"' EXIT

open_url() {
    if command -v xdg-open >/dev/null; then
        xdg-open "$1" >/dev/null 2>&1 &
    elif command -v open >/dev/null; then
        open "$1"
    fi
    printf '  %s\n' "$1"
}

# ── 1. Create the App from a manifest, unless one is already stored ───────────
slug="$APP_NAME"
client_id="$(gh variable get TAP_APP_CLIENT_ID --repo "$REPO" 2>/dev/null || true)"
if [ -n "$client_id" ] && ! $recreate; then
    echo "1. App already stored on $REPO (client id $client_id) - reusing it."
else
    manifest="$(jq -cn --arg name "$APP_NAME" --arg url "https://github.com/$REPO" '{
        name: $name,
        url: $url,
        description: "Publishes the claude-usage-panel cask to the Homebrew tap from release.yml.",
        public: false,
        redirect_url: $url,
        hook_attributes: {url: $url, active: false},
        default_permissions: {contents: "write"},
        default_events: []
    }')"
    form="$work/create-app.html"
    {
        printf '<!doctype html><meta charset="utf-8"><title>Create %s</title>\n' "$APP_NAME"
        printf '<form id="f" method="post" action="https://github.com/settings/apps/new">\n'
        printf '<input type="hidden" name="manifest" value="%s">\n' "$(printf '%s' "$manifest" | sed 's/&/\&amp;/g; s/"/\&quot;/g')"
        printf '</form><script>document.getElementById("f").submit()</script>\n'
    } >"$form"
    echo "1. Creating the App \"$APP_NAME\" - click \"Create GitHub App\" in the browser:"
    open_url "file://$form"
    echo "   GitHub then lands on github.com/$REPO?code=..."
    read -rp "   Paste the code (or the whole URL): " code
    code="${code##*code=}"
    code="${code%%&*}"
    [ -n "$code" ] || die "no code given"

    conv="$work/app.json"
    gh api -X POST "app-manifests/$code/conversions" >"$conv" ||
        die "GitHub refused the code (it is single-use and expires after an hour)"
    client_id="$(jq -r .client_id "$conv")"
    slug="$(jq -r .slug "$conv")"
    [ -n "$client_id" ] && [ "$client_id" != null ] || die "no client_id in GitHub's answer"
    (
        umask 077
        jq -r .pem "$conv" >"$work/app.pem"
    )
    gh variable set TAP_APP_CLIENT_ID --repo "$REPO" --body "$client_id"
    gh secret set TAP_APP_PRIVATE_KEY --repo "$REPO" <"$work/app.pem"
    echo "   Stored TAP_APP_CLIENT_ID ($client_id) and TAP_APP_PRIVATE_KEY on $REPO"
fi

# ── 2. Install it on the tap only ──────────────────────────────────────────────
echo
echo "2. Install the App: \"Only select repositories\" -> $TAP_REPO, then Install"
echo "   (already installed: GitHub shows its settings - check $TAP_REPO is selected):"
open_url "https://github.com/apps/$slug/installations/new"
read -rp "   Press Enter once it is installed. " _

# ── 3. Prove the stored credentials in CI, the way release.yml uses them ──────
echo
echo "3. Running $CHECK_WORKFLOW with the stored credentials..."
if ! gh workflow view "$CHECK_WORKFLOW" --repo "$REPO" >/dev/null 2>&1; then
    echo "   $CHECK_WORKFLOW is not on the default branch yet - after the merge run:"
    echo "   gh workflow run $CHECK_WORKFLOW --repo $REPO && gh run watch --repo $REPO"
    exit 0
fi
before="$(gh run list --repo "$REPO" --workflow "$CHECK_WORKFLOW" --limit 1 --json databaseId --jq '.[0].databaseId // 0')"
gh workflow run "$CHECK_WORKFLOW" --repo "$REPO"
run_id="$before"
for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep "${TAP_CHECK_POLL_SECONDS:-3}"
    run_id="$(gh run list --repo "$REPO" --workflow "$CHECK_WORKFLOW" --limit 1 --json databaseId --jq '.[0].databaseId // 0')"
    [ "$run_id" != "$before" ] && break
done
[ "$run_id" != "$before" ] || die "the $CHECK_WORKFLOW run did not start"
gh run watch "$run_id" --repo "$REPO" --exit-status >/dev/null ||
    die "$CHECK_WORKFLOW failed: the App is not installed on $TAP_REPO or lacks contents:write - gh run view $run_id --repo $REPO --log-failed"
echo "   Verified: the stored App mints a token that reaches $TAP_REPO."
echo
echo "Done. The next release publishes the cask on its own."
