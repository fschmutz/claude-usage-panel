#!/usr/bin/env bash
# Copy the lib/pure modules the usage-footer plugin imports into
# footer/hooks/pure/, byte for byte.
#
# A Claude Code plugin may only import files inside its own folder, so the
# footer cannot reach claude-usage-panel@fschmutz.github.io/lib/pure/ the way
# the Node clients do. lib/pure stays the one source of truth: these copies are
# generated, never edited, and `--check` (pre-commit + CI) fails the moment one
# drifts from its source or the set no longer matches what the footer imports.
#
#   scripts/sync-footer-pure.sh          rewrite the copies
#   scripts/sync-footer-pure.sh --check  exit 1 on any drift, write nothing
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/claude-usage-panel@fschmutz.github.io/lib/pure"
DEST="$ROOT/footer/hooks/pure"
CHECK=0
[ "${1:-}" = "--check" ] && CHECK=1

# The modules a file imports from its own folder: `from './x.js'`.
local_imports() {
    sed -nE "s/.*from '\.\/pure\/([a-z-]+)\.js'.*/\1/p; s/.*from '\.\/([a-z-]+)\.js'.*/\1/p" "$1"
}

# Every lib/pure module the footer needs: what its hooks import from ./pure/,
# then what those import, until nothing new turns up.
needed=""
queue="$(cat "$ROOT"/footer/hooks/*.tsx | sed -nE "s/.*from '\.\/pure\/([a-z-]+)\.js'.*/\1/p" | sort -u)"
while [ -n "$queue" ]; do
    next=""
    for m in $queue; do
        case " $needed " in *" $m "*) continue ;; esac
        [ -f "$SRC/$m.js" ] || {
            echo "sync-footer-pure: footer imports pure/$m.js, which lib/pure does not have" >&2
            exit 1
        }
        needed="$needed $m"
        next="$next $(local_imports "$SRC/$m.js" | tr '\n' ' ')"
    done
    queue="$(echo "$next" | tr ' ' '\n' | sed '/^$/d' | sort -u | tr '\n' ' ')"
    queue="${queue% }"
done

drift=0
for m in $needed; do
    if [ "$CHECK" = 1 ]; then
        if ! cmp -s "$SRC/$m.js" "$DEST/$m.js"; then
            echo "sync-footer-pure: footer/hooks/pure/$m.js differs from lib/pure/$m.js" >&2
            drift=1
        fi
    else
        mkdir -p "$DEST"
        cp "$SRC/$m.js" "$DEST/$m.js"
    fi
done

# A copy the footer no longer needs is stale, not harmless: remove or flag it.
for f in "$DEST"/*.js; do
    [ -e "$f" ] || continue
    m="$(basename "$f" .js)"
    case " $needed " in *" $m "*) continue ;; esac
    if [ "$CHECK" = 1 ]; then
        echo "sync-footer-pure: footer/hooks/pure/$m.js is not imported by the footer" >&2
        drift=1
    else
        rm -f "$f"
    fi
done

if [ "$drift" = 1 ]; then
    echo "sync-footer-pure: run scripts/sync-footer-pure.sh and commit the result" >&2
    exit 1
fi
