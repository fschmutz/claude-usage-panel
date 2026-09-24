#!/usr/bin/env bash
# Publish a release's pinned cask to the Homebrew tap, so that
#   brew install --cask fschmutz/tap/claude-usage-panel
# and `brew upgrade` follow the releases.
#
#   HOMEBREW_TAP_TOKEN=... scripts/publish-cask.sh <version> <cask.rb>
#
# <cask.rb> is the file scripts/make-cask.sh wrote for that release: its
# `version` must be <version> and its sha256 a real checksum, never the
# repo's `:no_check` template. The tap then holds exactly what the release
# page attaches.
#
# Environment:
#   HOMEBREW_TAP_TOKEN  required: a token with contents:write on the tap repo
#   TAP_REPO            default fschmutz/homebrew-tap
#   TAP_BRANCH          default main
#   TAP_URL             default https://github.com/$TAP_REPO.git (tests point
#                       it at a local bare repo)
#
# The token never reaches argv, the tap's .git/config or the log: git gets the
# auth header through GIT_CONFIG_* environment variables scoped to the tap's
# URL, and in GitHub Actions its base64 form is masked before first use.
# Commits "claude-usage-panel <version>" to Casks/claude-usage-panel.rb;
# publishing a cask the tap already holds is a no-op, so a re-run is safe.
set -euo pipefail

# shellcheck source=scripts/version-sites.sh
. "$(cd "$(dirname "$0")" && pwd)/version-sites.sh"

usage() {
    echo "Usage: HOMEBREW_TAP_TOKEN=... scripts/publish-cask.sh <version> <cask.rb>" >&2
    exit 2
}
die() {
    echo "publish-cask: $*" >&2
    exit 1
}

[ $# -eq 2 ] || usage
version="${1#v}"
cask="$2"
printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || die "not a version: $1"
[ -f "$cask" ] || die "no such cask: $cask"
[ -n "${HOMEBREW_TAP_TOKEN:-}" ] || die "HOMEBREW_TAP_TOKEN is not set (repo Settings > Secrets > Actions)"

have="$(version_site_read "$cask" cask version)"
[ "$have" = "$version" ] || die "$cask is version '$have', expected $version"
grep -Eq '^  sha256 "[0-9a-f]{64}"$' "$cask" ||
    die "$cask has no pinned sha256 (the :no_check template?) - run scripts/make-cask.sh first"

TAP_REPO="${TAP_REPO:-fschmutz/homebrew-tap}"
TAP_BRANCH="${TAP_BRANCH:-main}"
TAP_URL="${TAP_URL:-https://github.com/$TAP_REPO.git}"

auth="$(printf 'x-access-token:%s' "$HOMEBREW_TAP_TOKEN" | base64 | tr -d '\n')"
if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    echo "::add-mask::$auth"
fi
# Scoped to the tap URL: the header is sent there and nowhere else.
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0="http.$TAP_URL.extraheader"
export GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $auth"
export GIT_TERMINAL_PROMPT=0

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

git clone --quiet --depth 1 --branch "$TAP_BRANCH" "$TAP_URL" "$work/tap" ||
    die "could not clone branch $TAP_BRANCH of $TAP_REPO"

mkdir -p "$work/tap/Casks"
cp "$cask" "$work/tap/Casks/claude-usage-panel.rb"

cd "$work/tap"
git add Casks/claude-usage-panel.rb
if git diff --cached --quiet; then
    echo "publish-cask: $TAP_REPO already has claude-usage-panel $version"
    exit 0
fi
git -c user.name="github-actions[bot]" \
    -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
    commit --quiet -m "claude-usage-panel $version"
git push --quiet origin "HEAD:$TAP_BRANCH" || die "push to $TAP_REPO $TAP_BRANCH was rejected"
echo "publish-cask: $TAP_REPO $TAP_BRANCH -> claude-usage-panel $version ($(git rev-parse --short HEAD))"
