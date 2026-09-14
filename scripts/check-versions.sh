#!/usr/bin/env bash
# Guard against version drift: every site listed in scripts/version-sites.sh
# must carry the version package.json does (the single source of truth), and
# no build path may hardcode a version literal. Runs in pre-commit and CI. A
# site bump-version.sh writes is a site this script checks - same list.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# shellcheck source=version-sites.sh
. "$ROOT/scripts/version-sites.sh"

fail=0
note() {
    echo "  ✗ $1" >&2
    fail=1
}

want="$(version_site_read package.json json version)"
if [ -z "$want" ]; then
    echo "check-versions: could not read version from package.json" >&2
    exit 2
fi

for site in "${VERSION_SITES[@]}"; do
    IFS='|' read -r file kind key <<<"$site"
    have="$(version_site_read "$file" "$kind" "$key")"
    [ "$have" = "$want" ] || note "$file $key is '$have', expected '$want'"
done

# The marketplace entry repeats plugin.json's metadata (the fallback when a
# field is omitted is not documented, so both carry it). Repeated means it can
# drift, so it is checked rather than trusted.
if command -v node >/dev/null; then
    node - <<'JS' || fail=1
const fs = require('fs');
const plugin = JSON.parse(fs.readFileSync('plugin/.claude-plugin/plugin.json', 'utf8'));
const entry = JSON.parse(fs.readFileSync('.claude-plugin/marketplace.json', 'utf8'))
    .plugins.find((p) => p.name === plugin.name);
if (!entry) {
    console.error(`  \u2717 .claude-plugin/marketplace.json has no entry named ${plugin.name}`);
    process.exit(1);
}
let bad = 0;
for (const key of ['description', 'version', 'author', 'homepage', 'repository', 'license', 'keywords']) {
    if (JSON.stringify(entry[key]) !== JSON.stringify(plugin[key])) {
        console.error(`  \u2717 marketplace entry ${key} differs from plugin.json`);
        bad = 1;
    }
}
process.exit(bad);
JS
fi

# The macOS bundle version must come from package.json, never a literal - the
# plist lines must interpolate $ver, not a semver.
if grep -nE 'CFBundle(Short)?Version(String)?</key><string>[0-9]+\.[0-9]+\.[0-9]+<' scripts/install/macos.sh; then
    note "scripts/install/macos.sh hardcodes a bundle version - it must use \$ver from package.json"
fi

if [ "$fail" -ne 0 ]; then
    echo "check-versions: drift detected - run scripts/bump-version.sh <ver> to sync." >&2
    exit 1
fi
echo "check-versions: all version sites match $want"
