#!/usr/bin/env bash
# One-time setup of the GitHub App the release workflow writes the Homebrew tap
# with (release.yml, job homebrew-tap). No personal token: each release mints
# an installation token for fschmutz/homebrew-tap alone, contents:write, about
# an hour long, revoked when the job ends.
#
#   scripts/setup-tap-app.sh            create the App, store its credentials,
#                                       install it, prove it can write the tap
#
# 1. Opens GitHub's "create App from manifest" page, pre-filled: contents
#    read/write, no webhook, no other permission. You click "Create".
# 2. GitHub redirects to this repo with ?code=... in the URL: paste the code.
# 3. Stores the client id as the TAP_APP_CLIENT_ID variable and the private
#    key as the TAP_APP_PRIVATE_KEY secret of this repo. The key goes straight
#    from GitHub's answer into `gh secret set` through a 0600 temp file that
#    is removed on exit; it is never printed.
# 4. Opens the App's install page: choose "Only select repositories" and
#    pick homebrew-tap.
# 5. Mints an installation token locally with that key, checks it carries
#    contents:write on the tap, and revokes it.
#
# Needs gh (logged in as the tap owner), jq, openssl and curl.
set -euo pipefail

REPO="fschmutz/claude-usage-panel"
TAP_OWNER="fschmutz"
TAP_REPO="homebrew-tap"
APP_NAME="${TAP_APP_NAME:-${TAP_OWNER}-tap-publisher}"
API="https://api.github.com"

die() {
    printf 'setup-tap-app: %s\n' "$*" >&2
    exit 1
}

for tool in gh jq openssl curl; do
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

# ── 1. Create the App from a manifest ──────────────────────────────────────────
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

echo
echo "2. GitHub then lands on github.com/$REPO?code=..."
read -rp "   Paste the code (or the whole URL): " code
code="${code##*code=}"
code="${code%%&*}"
[ -n "$code" ] || die "no code given"

conv="$work/app.json"
gh api -X POST "app-manifests/$code/conversions" >"$conv" ||
    die "GitHub refused the code (it is single-use and expires after an hour)"
client_id="$(jq -r .client_id "$conv")"
slug="$(jq -r .slug "$conv")"
pem="$work/app.pem"
(
    umask 077
    jq -r .pem "$conv" >"$pem"
)
[ -n "$client_id" ] && [ "$client_id" != null ] || die "no client_id in GitHub's answer"

# ── 3. Store the credentials on this repo ──────────────────────────────────────
gh variable set TAP_APP_CLIENT_ID --repo "$REPO" --body "$client_id"
gh secret set TAP_APP_PRIVATE_KEY --repo "$REPO" <"$pem"
echo "3. Stored TAP_APP_CLIENT_ID ($client_id) and TAP_APP_PRIVATE_KEY on $REPO"

# ── 4. Install it on the tap only ──────────────────────────────────────────────
echo
echo "4. Install the App: \"Only select repositories\" -> $TAP_REPO, then Install:"
open_url "https://github.com/apps/$slug/installations/new"
read -rp "   Press Enter once it is installed. " _

# ── 5. Prove it: mint a tap token with the key, check it, revoke it ───────────
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
now="$(date +%s)"
header="$(printf '{"alg":"RS256","typ":"JWT"}' | b64url)"
payload="$(printf '{"iat":%s,"exp":%s,"iss":"%s"}' "$((now - 60))" "$((now + 540))" "$client_id" | b64url)"
signature="$(printf '%s.%s' "$header" "$payload" | openssl dgst -sha256 -sign "$pem" | b64url)"
jwt="$header.$payload.$signature"

# The JWT and the token go to curl on stdin (-H @-), never in argv where ps shows them.
app_call() { # METHOD PATH [JSON]
    printf 'Authorization: Bearer %s\nAccept: application/vnd.github+json\n' "$jwt" |
        curl -fsS -X "$1" -H @- ${3:+-d "$3"} "$API$2"
}
installation="$(app_call GET "/repos/$TAP_OWNER/$TAP_REPO/installation")" ||
    die "the App is not installed on $TAP_OWNER/$TAP_REPO - install it and re-run step 4 by hand"
install_id="$(printf '%s' "$installation" | jq -r .id)"
[ "$(printf '%s' "$installation" | jq -r .repository_selection)" = selected ] ||
    echo "   warning: the App is installed on ALL your repositories - restrict it to $TAP_REPO" >&2

token_json="$(app_call POST "/app/installations/$install_id/access_tokens" \
    "{\"repositories\":[\"$TAP_REPO\"],\"permissions\":{\"contents\":\"write\"}}")" ||
    die "could not mint a token for $TAP_REPO"
[ "$(printf '%s' "$token_json" | jq -r .permissions.contents)" = write ] ||
    die "the minted token has no contents:write on $TAP_REPO"
token="$(printf '%s' "$token_json" | jq -r .token)"
printf 'Authorization: Bearer %s\n' "$token" |
    curl -fsS -X DELETE -H @- "$API/installation/token" >/dev/null || true
echo "5. Verified: a token minted for $TAP_REPO carries contents:write (revoked)."
echo
echo "Done. The next release (or a re-run of its homebrew-tap job) publishes the cask."
