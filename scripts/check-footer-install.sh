#!/usr/bin/env bash
# Install the footer the way users do (`./install.sh footer`) into a throwaway
# HOME, then ask the real claude CLI whether the plugin LOADS. `claude plugin
# validate footer` checks the source folder only: it cannot see a fault of the
# installed shape, such as a marketplace whose plugin is a link that resolves
# outside it ("Path escapes plugin directory", v3.12.1). No login is needed.
#
#   scripts/check-footer-install.sh [path/to/claude]   (default: claude on PATH)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="${1:-$(command -v claude || true)}"
if [ -z "$CLI" ] || [ ! -x "$CLI" ]; then
    echo "check-footer-install: no claude CLI (pass its path)" >&2
    exit 2
fi
CLI="$(cd "$(dirname "$CLI")" && pwd)/$(basename "$CLI")"

home="$(mktemp -d "${TMPDIR:-/tmp}/cup-footer-load.XXXXXX")"
trap 'rm -rf "$home"' EXIT
mkdir -p "$home/bin" "$home/.claude"
echo '{}' >"$home/.claude/settings.json"
ln -s "$CLI" "$home/bin/claude"

sandbox() {
    env HOME="$home" XDG_STATE_HOME="$home/state" XDG_CONFIG_HOME="$home/.config" \
        XDG_DATA_HOME="$home/.local/share" CLAUDE_CONFIG_DIR="$home/.claude" \
        PATH="$home/bin:$PATH" DISABLE_AUTOUPDATER=1 DISABLE_TELEMETRY=1 "$@"
}

"$CLI" --version
sandbox bash "$ROOT/install.sh" footer
sandbox "$CLI" plugin list --json | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
        const p = JSON.parse(s).find((x) => x.id === "usage-footer@claude-usage-panel-local");
        if (!p) { console.error("usage-footer is not installed"); process.exit(1); }
        if (!p.enabled) { console.error("usage-footer is installed but not enabled"); process.exit(1); }
        if (p.errors && p.errors.length) {
            console.error("usage-footer fails to load:\n  " + p.errors.join("\n  "));
            process.exit(1);
        }
        console.log("usage-footer loads from " + p.readFromFolder);
    });'
