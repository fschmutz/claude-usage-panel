#!/usr/bin/env bash
# Assemble the installable GNOME extension into a directory: the extension
# sources (without the po/ sources), the compiled GSettings schema, compiled
# translations under locale/, and the worker scripts the extension runs itself
# (auto-update.sh for the Updates row, session-ping.sh for the ping schedule,
# plus the lib.sh both source). One layout for both consumers: install.sh
# gnome populates ~/.local/share/gnome-shell/extensions/<uuid> with it, and the
# release workflow zips it as the GitHub release asset.
#
#   scripts/pack-gnome.sh <outdir>      outdir is created; an existing one is reused
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UUID="claude-usage-panel@fschmutz.github.io"
out="${1:-}"
if [ -z "$out" ]; then
    echo "usage: scripts/pack-gnome.sh <outdir>" >&2
    exit 2
fi
command -v glib-compile-schemas >/dev/null || {
    echo "pack-gnome: glib-compile-schemas not found (libglib2.0-bin)" >&2
    exit 1
}

src="$ROOT/$UUID"
mkdir -p "$out"
# The sources, minus po/ (compiled below) and anything a dev left behind.
(cd "$src" && find . -type f ! -path './po/*' ! -path './node_modules/*' ! -path './locale/*' -print0) |
    (cd "$src" && cpio -pdm0 --quiet "$out")
glib-compile-schemas "$out/schemas/"

# Translations: po/<lang>.po -> locale/<lang>/LC_MESSAGES/claude-usage-panel.mo.
if command -v msgfmt >/dev/null; then
    for po in "$src"/po/*.po; do
        [ -e "$po" ] || continue
        lang="$(basename "$po" .po)"
        mkdir -p "$out/locale/$lang/LC_MESSAGES"
        msgfmt "$po" -o "$out/locale/$lang/LC_MESSAGES/claude-usage-panel.mo"
    done
fi

# The worker scripts and their shared lib travel together (they source it).
mkdir -p "$out/scripts"
for f in auto-update.sh session-ping.sh lib.sh; do
    cp "$ROOT/scripts/$f" "$out/scripts/$f"
done
chmod +x "$out/scripts/auto-update.sh" "$out/scripts/session-ping.sh"
