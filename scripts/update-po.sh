#!/usr/bin/env bash
# Regenerate po/claude-usage-panel.pot from the GNOME extension sources and
# merge it into every existing translation.
#
#   scripts/update-po.sh            regenerate the template, merge every po
#   scripts/update-po.sh --check    fail if either is out of date (what CI runs)
#
# Translations are compiled by install.sh at install time (msgfmt into
# locale/<lang>/LC_MESSAGES), so there is nothing to build here.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UUID="claude-usage-panel@fschmutz.github.io"
PO_DIR="$ROOT/$UUID/po"
POT="$PO_DIR/claude-usage-panel.pot"
CHECK=false
[ "${1:-}" = "--check" ] && CHECK=true

command -v xgettext >/dev/null || {
    echo "update-po: xgettext not found (apt install gettext)" >&2
    exit 1
}

cd "$ROOT/$UUID"
# Sorted, repo-relative inputs so the template is byte-stable across machines.
mapfile -t sources < <(find . -name '*.js' -not -path './node_modules/*' | sed 's|^\./||' | sort)

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

xgettext --from-code=UTF-8 --language=JavaScript \
    --keyword=_ --keyword=C_:1c,2 --keyword=ngettext:1,2 \
    --package-name="Claude Usage Panel" \
    --copyright-holder="Falco Schmutz" \
    --output="$tmp/template.pot" \
    "${sources[@]}"

# The creation date alone would make every run a diff; keep the committed one.
if [ -f "$POT" ]; then
    date_line="$(grep '^"POT-Creation-Date:' "$POT" || true)"
    # The line ends in a literal \n. sed would expand it in the replacement
    # text and awk -v would expand it in the assignment, either way tearing the
    # header in half - so pass it through the environment, which expands
    # nothing.
    if [ -n "$date_line" ]; then
        POT_DATE="$date_line" awk \
            '/^"POT-Creation-Date:/ { print ENVIRON["POT_DATE"]; next } { print }' \
            "$tmp/template.pot" >"$tmp/dated.pot"
        mv "$tmp/dated.pot" "$tmp/template.pot"
    fi
fi

# The msgids a catalog file declares, one per line, normalized. Comments, line
# references, wrapping and header fields are all deliberately excluded: they
# differ between gettext versions, and a check that compares them is green on
# one machine and red on the CI runner for no real reason.
msgids() {
    msgcat --no-wrap --no-location "$1" | sed -n 's/^msgid //p' | sort
}

status=0
if $CHECK; then
    if ! diff -u <(msgids "$POT") <(msgids "$tmp/template.pot") >/dev/null; then
        echo "update-po: the template is missing strings from the source" >&2
        echo "           (or carries strings the source no longer has)" >&2
        diff -u <(msgids "$POT") <(msgids "$tmp/template.pot") | sed -n '3,$p' >&2
        status=1
    fi
else
    cp "$tmp/template.pot" "$POT"
fi

for po in "$PO_DIR"/*.po; do
    [ -e "$po" ] || continue
    if $CHECK; then
        # msgcmp is the semantic form of "this catalog is current": it fails on
        # a msgid the template has and the catalog lacks, and on one the
        # catalog leaves untranslated.
        msgcmp "$po" "$POT" 2>"$tmp/cmp.err" || {
            echo "update-po: $(basename "$po") is out of date - run scripts/update-po.sh" >&2
            sed 's/^/           /' "$tmp/cmp.err" >&2
            status=1
        }
    else
        # Always merge through --output-file, never --update: the in-place form
        # leaves an already-current file untouched, wrapping included.
        msgmerge --quiet --output-file="$tmp/merged.po" "$po" "$POT"
        cp "$tmp/merged.po" "$po"
    fi
done

exit "$status"
