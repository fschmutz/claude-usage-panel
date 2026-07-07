#!/usr/bin/env bash
# Install the Claude Usage Panel status line into Claude Code: copy the script
# into ~/.claude and merge a `statusLine` entry into ~/.claude/settings.json
# without clobbering any existing settings. Re-running is safe (idempotent).
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)/statusline.js"
DEST_DIR="$HOME/.claude"
# Install with a .mjs extension so Node always treats it as ESM, on every Node
# version, regardless of any package.json next to it.
DEST="$DEST_DIR/claude-usage-statusline.mjs"
SETTINGS="$DEST_DIR/settings.json"

if ! command -v node >/dev/null 2>&1; then
    echo "Node.js is required (Claude Code runs on it). Not found on PATH." >&2
    exit 1
fi
if [ ! -f "$SRC" ]; then
    echo "Script not found: $SRC" >&2
    exit 1
fi

mkdir -p "$DEST_DIR"
cp "$SRC" "$DEST"
chmod +x "$DEST"
echo "Installed status-line script to $DEST"

# Merge the statusLine key into settings.json using Node so we never corrupt
# an existing (possibly hand-edited) file. Preserves all other keys.
COMMAND="node \"$DEST\"" node - "$SETTINGS" <<'JS'
const fs = require('fs');
const path = process.argv[2];
let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(path, 'utf8'));
} catch {
  // Missing or empty file: start fresh.
}
const existing = settings.statusLine;
settings.statusLine = {type: 'command', command: process.env.COMMAND};
fs.mkdirSync(require('os').homedir() + '/.claude', {recursive: true});
fs.writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
if (existing && existing.command !== settings.statusLine.command) {
  console.log('Note: replaced an existing statusLine command:');
  console.log('  ' + (existing.command || JSON.stringify(existing)));
}
JS

echo "Merged statusLine into $SETTINGS"
echo
echo "Done. Open a Claude Code session (or run /statusline) to see it under the input."
echo "Requires an active Claude Code login."
