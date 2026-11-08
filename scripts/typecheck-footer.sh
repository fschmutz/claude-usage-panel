#!/usr/bin/env bash
# TypeScript typecheck of the usage-footer plugin (footer/: hooks, contract,
# tests), strict, with the TypeScript pinned in .github/typescript (Dependabot's
# npm ecosystem bumps it). `claude plugin test` transpiles without checking
# types, so this is the only gate that does.
#
# The mod API's declarations ('claude-code', 'claude-code/testing') ship in no
# package: Claude Code writes them itself when it loads a mod - beside it, as
# footer/.claude-plugin/types/ (gitignored) once a session has loaded footer/
# with `claude --plugin-dir footer`, or as the claude-code.d.ts the
# plugin-authoring skill names. Point CLAUDE_CODE_TYPES at that file when the
# folder is not there. No declarations is a failure, never a skip.
#
#   scripts/typecheck-footer.sh
#   CLAUDE_CODE_TYPES=/path/to/claude-code.d.ts scripts/typecheck-footer.sh
set -euo pipefail

cd "$(dirname "$0")/.."
root="$PWD"
dir=.github/typescript
want="$(sed -n 's/^ *"typescript": *"\([0-9][0-9.]*\)".*/\1/p' "$dir/package.json")"
[ -n "$want" ] || {
    echo "typecheck-footer: no typescript version pinned in $dir/package.json" >&2
    exit 1
}
have=""
if [ -f "$dir/node_modules/typescript/package.json" ]; then
    have="$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$dir/node_modules/typescript/package.json" | head -1)"
fi
if [ "$have" != "$want" ]; then
    echo "typecheck-footer: installing typescript $want into $dir/node_modules" >&2
    npm ci --prefix "$dir" --ignore-scripts --no-audit --no-fund --silent
fi

types="${CLAUDE_CODE_TYPES:-}"
if [ -z "$types" ] && [ -d footer/.claude-plugin/types/claude-code ]; then
    types="$root/footer/.claude-plugin/types"
fi
if [ -z "$types" ] || [ ! -e "$types" ]; then
    echo "typecheck-footer: no Claude Code mod API declarations found." >&2
    echo "  Load the footer once (claude --plugin-dir footer) so Claude Code lays footer/.claude-plugin/types/," >&2
    echo "  or set CLAUDE_CODE_TYPES to the claude-code.d.ts it wrote." >&2
    exit 1
fi

# The options the engine's own header gives a hooks module, plus allowJs for
# the plain-JS modules (gauges.js, the generated pure/ copies), unchecked.
work="$(mktemp -d "${TMPDIR:-/tmp}/cup-footer-tsc.XXXXXX")"
trap 'rm -rf "$work"' EXIT
# shellcheck disable=SC2016  # the ${...} below is a JS template literal, not shell
node -e '
const [types, root] = process.argv.slice(1);
process.stdout.write(JSON.stringify({
    compilerOptions: {
        target: "es2023", lib: ["es2023"], types: [],
        module: "esnext", moduleResolution: "bundler",
        strict: true, noUncheckedIndexedAccess: true,
        noEmit: true, skipLibCheck: true, allowJs: true, checkJs: false,
        jsx: "react", jsxFactory: "h", jsxFragmentFactory: "Fragment",
    },
    include: [types, ...["hooks", "types", "tests"].map((d) => `${root}/footer/${d}`)],
}, null, 2));
' "$types" "$root" >"$work/tsconfig.json"
"$dir/node_modules/.bin/tsc" --version
"$dir/node_modules/.bin/tsc" -p "$work/tsconfig.json"
echo "typecheck-footer: footer/ typechecks clean"
