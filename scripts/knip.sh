#!/usr/bin/env bash
# knip - unused files, exports, dependencies and unlisted imports - run with the
# version pinned in .github/knip/package-lock.json (Dependabot's npm ecosystem
# bumps it). Config: knip.jsonc. The pre-commit `knip` hook calls this, so it
# runs on every commit and in CI's lint job; the install is redone only when
# the installed knip is not the pinned one.
#
#   scripts/knip.sh [knip args...]
set -euo pipefail

cd "$(dirname "$0")/.."
dir=.github/knip
want="$(sed -n 's/^ *"knip": *"\([0-9][0-9.]*\)".*/\1/p' "$dir/package.json")"
[ -n "$want" ] || {
    echo "knip.sh: no knip version pinned in $dir/package.json" >&2
    exit 1
}
have="$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$dir/node_modules/knip/package.json" 2>/dev/null | head -1)"
if [ "$have" != "$want" ]; then
    echo "knip.sh: installing knip $want into $dir/node_modules" >&2
    npm ci --prefix "$dir" --no-audit --no-fund --silent
fi
# A configuration hint (a stale or redundant knip.jsonc entry) is config debt
# and fails like a finding.
exec "$dir/node_modules/.bin/knip" --no-progress \
    --treat-config-hints-as-errors --treat-tag-hints-as-errors "$@"
