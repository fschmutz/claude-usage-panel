#!/usr/bin/env bash
# Smoke-test the shell entrypoints under bash 3.2 - the version macOS still
# ships as /bin/bash, and the one the launchd agents actually invoke.
#
# CI runs the rest of the shell suite on ubuntu (bash 5), where several bash
# 3.2 traps are invisible. The one that motivated this: expanding "${arr[@]}"
# on an EMPTY array aborts under `set -u` in 3.2 but is fine in 4.4+, so a
# guard that reads correctly on Linux dies on a stock Mac.
#
#   scripts/bash32-smoke.sh          run it (expects to BE bash 3.2)
#
# Run it the way CI does, from a checkout root:
#   docker run --rm -v "$PWD:/repo:ro" -e HOME=/tmp bash:3.2 bash /repo/scripts/bash32-smoke.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail=0

case "${BASH_VERSION:-}" in
    3.2*) echo "bash $BASH_VERSION - the macOS /bin/bash version" ;;
    *) echo "WARNING: this is bash ${BASH_VERSION:-unknown}, not 3.2 - traps will be missed" ;;
esac

# 1. Parse every shell script. Catches syntax that only exists in bash 4+
#    (mapfile, declare -A, ${x^^}, &>>) without running anything.
echo
echo "== syntax (bash -n) =="
while IFS= read -r f; do
    if bash -n "$f" 2>/dev/null; then
        printf '  ok    %s\n' "${f#"$ROOT"/}"
    else
        printf '  FAIL  %s\n' "${f#"$ROOT"/}"
        bash -n "$f" || true
        fail=1
    fi
done <<EOT
$(find "$ROOT" -name '*.sh' -not -path '*/node_modules/*' | sort)
EOT

# 2. Actually run every target install.sh advertises, in --dry-run. This is
#    what catches the runtime traps that `bash -n` cannot see. The target list
#    is read from --list rather than hardcoded, so a new target is covered the
#    day it lands.
echo
echo "== install.sh --dry-run, every advertised target =="
# Capture first, then parse. Piping install.sh straight into an awk that
# `exit`s on the first match closes the pipe while install.sh is still
# writing, and under `set -o pipefail` that SIGPIPE (141) fails the job -
# a race that passes locally and fails on a CI runner.
list_out="$(bash "$ROOT/install.sh" --list)"
targets="$(printf '%s\n' "$list_out" | awk -F: '/^ *all:/ {print $2}')"
[ -n "$targets" ] || { echo "  FAIL  could not read the target list from --list"; exit 1; }

for t in $targets; do
    if bash "$ROOT/install.sh" --dry-run "$t" >/dev/null 2>&1; then
        printf '  ok    install.sh --dry-run %s\n' "$t"
    else
        printf '  FAIL  install.sh --dry-run %s\n' "$t"
        bash "$ROOT/install.sh" --dry-run "$t" 2>&1 | tail -5
        fail=1
    fi
    if bash "$ROOT/install.sh" --dry-run --uninstall "$t" >/dev/null 2>&1; then
        printf '  ok    install.sh --dry-run --uninstall %s\n' "$t"
    else
        printf '  FAIL  install.sh --dry-run --uninstall %s\n' "$t"
        bash "$ROOT/install.sh" --dry-run --uninstall "$t" 2>&1 | tail -5
        fail=1
    fi
done

# 3. The bare, no-target path - the one `curl … | bash` takes. It is a
#    DIFFERENT code path from a named target (it has to derive the target list
#    itself), and skipping it is how a bash-4-only `mapfile` shipped and broke
#    `./install.sh` on every stock Mac with exit 127.
#    "No installable target detected" is a legitimate outcome in a container
#    with no GNOME and no macOS; a crash is not. Distinguish them by exit code:
#    1 is the honest "nothing to do here", 127/2 are bugs.
echo
echo "== bare install.sh (no target named) =="
for bare in "--dry-run" "--dry-run update"; do
    # `|| rc=$?` and not a bare `rc=$?`: under `set -e` a non-zero exit aborts
    # the script before the next line ever runs, and 1 is an EXPECTED outcome
    # here (nothing installable in a container).
    rc=0
    # shellcheck disable=SC2086 # deliberate word-splitting of the flag pair
    bash "$ROOT/install.sh" $bare >/dev/null 2>&1 || rc=$?
    if [ "$rc" -eq 0 ] || [ "$rc" -eq 1 ]; then
        printf '  ok    install.sh %s (exit %s)\n' "$bare" "$rc"
    else
        printf '  FAIL  install.sh %s exited %s\n' "$bare" "$rc"
        # shellcheck disable=SC2086
        bash "$ROOT/install.sh" $bare 2>&1 | tail -5
        fail=1
    fi
done

# 4. The always-safe read-only entrypoints.
echo
echo "== read-only entrypoints =="
for cmd in "--list" "-h"; do
    if bash "$ROOT/install.sh" "$cmd" >/dev/null 2>&1; then
        printf '  ok    install.sh %s\n' "$cmd"
    else
        printf '  FAIL  install.sh %s\n' "$cmd"
        fail=1
    fi
done

echo
if [ "$fail" -eq 0 ]; then
    echo "bash 3.2 smoke: PASS"
else
    echo "bash 3.2 smoke: FAIL"
fi
exit "$fail"
