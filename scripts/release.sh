#!/usr/bin/env bash
# Cut a release, and only on a commit CI has passed. The tag is what every
# checkout's daily auto-update installs, so a tag on an untested commit ships
# untested code to everyone; this script never creates one.
#
#   scripts/release.sh             the version the commits imply, after a y/N
#   scripts/release.sh 3.6.0       that version (refused below what they imply)
#   scripts/release.sh --dry-run   the plan; changes nothing
#
# 1. main, clean, equal to origin/main, and `ci-gate` green on that commit:
#    release what CI already passed, never what it has not seen.
# 2. The version: from the conventional commits since the last tag
#    (scripts/release-version.mjs: breaking = major, feat = minor, else patch).
#    A version lower than they imply is refused; CHANGELOG [Unreleased] must
#    not be empty.
# 3. bump-version.sh, the chore(release) commit, push main.
# 4. Wait for `ci-gate` on the release commit. Red: stop, untagged. Re-run the
#    failed jobs, then run this again: a HEAD that is an untagged release
#    commit is resumed from here.
# 5. Tag it and push the tag; release.yml publishes the Release (and itself
#    refuses a tag whose commit is not ci-gate green).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Overridable for the tests (a local bare remote, a stubbed gh); the push
# verb is push-confirm everywhere else.
read -r -a PUSH <<<"${CUP_PUSH:-git push-confirm}"
GH="${CUP_GH:-gh}"
POLL="${CUP_CI_POLL:-15}"
TIMEOUT="${CUP_CI_TIMEOUT:-1800}"

die() {
    echo "release: $*" >&2
    exit 1
}
say() { echo "release: $*"; }

usage() {
    sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
}

DRY=false
WANT=""
for a in "$@"; do
    case "$a" in
        --dry-run) DRY=true ;;
        -h | --help) usage ;;
        [0-9]*.[0-9]*.[0-9]*)
            [[ "$a" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "not a version: $a"
            WANT="$a"
            ;;
        *) die "unknown argument: $a (scripts/release.sh --help)" ;;
    esac
done

# 1, 0 or -1: X.Y.Z $1 against $2.
vcmp() {
    local IFS=.
    local -a a b
    read -r -a a <<<"$1"
    read -r -a b <<<"$2"
    local i
    for i in 0 1 2; do
        if ((10#${a[i]} > 10#${b[i]})); then
            echo 1
            return
        fi
        if ((10#${a[i]} < 10#${b[i]})); then
            echo -1
            return
        fi
    done
    echo 0
}

SLUG="$("$GH" repo view --json nameWithOwner --jq .nameWithOwner)" || die "gh cannot read this repository (gh auth status)"

# ci-gate's state on a commit: completed:success, completed:failure,
# in_progress:, queued:, or none (no run yet).
ci_state() {
    "$GH" api "repos/$SLUG/commits/$1/check-runs?check_name=ci-gate" \
        --jq '[.check_runs[] | select(.app.slug == "github-actions") | .status + ":" + (.conclusion // "")] | first // "none"'
}

wait_green() {
    local sha="$1" waited=0 state
    while :; do
        state="$(ci_state "$sha")" || die "cannot read ci-gate for $sha"
        case "$state" in
            completed:success) return 0 ;;
            completed:*) die "ci-gate on ${sha:0:7} is ${state#completed:}: left untagged. Re-run the failed jobs (gh run rerun --failed), then run release.sh again" ;;
        esac
        [ "$waited" -lt "$TIMEOUT" ] || die "ci-gate on ${sha:0:7} still ${state%%:*} after ${TIMEOUT}s: left untagged, run release.sh again later"
        if [ $((waited % 60)) -eq 0 ]; then say "waiting for ci-gate on ${sha:0:7} (${state%%:*})"; fi
        sleep "$POLL"
        waited=$((waited + (POLL > 0 ? POLL : 1)))
    done
}

[ "$(git rev-parse --abbrev-ref HEAD)" = main ] || die "not on main"
[ -z "$(git status --porcelain)" ] || die "the working tree is not clean"
git fetch --quiet --tags origin main || die "git fetch failed"

LAST="$(git tag --list 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | head -1)"
LAST="${LAST#v}"
[ -n "$LAST" ] || die "no vX.Y.Z tag to release after"

HEAD_SUBJECT="$(git log -1 --format=%s)"
RESUME=false
if [[ "$HEAD_SUBJECT" =~ ^chore\(release\):\ v([0-9]+\.[0-9]+\.[0-9]+)$ ]] &&
    ! git rev-parse -q --verify "refs/tags/v${BASH_REMATCH[1]}" >/dev/null; then
    V="${BASH_REMATCH[1]}"
    RESUME=true
    say "resuming v$V: the release commit is on HEAD, untagged"
else
    [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] ||
        die "HEAD is not origin/main: push the work first and let CI pass on it"
    state="$(ci_state "$(git rev-parse HEAD)")" || die "cannot read ci-gate for HEAD"
    [ "$state" = completed:success ] ||
        die "ci-gate on HEAD is '$state', not green: release only what CI passed"
    next="$(git log --format='%s%n%b%n--END--' "v$LAST..HEAD" | node scripts/release-version.mjs "$LAST")" ||
        die "nothing to release since v$LAST"
    IMPLIED="${next%% *}"
    V="${WANT:-$IMPLIED}"
    [ "$(vcmp "$V" "$LAST")" = 1 ] || die "v$V is not above the last release v$LAST"
    [ "$(vcmp "$V" "$IMPLIED")" != -1 ] || die "v$V is below what the commits since v$LAST imply (v$IMPLIED, ${next#* })"
    awk '/^## \[Unreleased\]/{f=1;next} /^## \[/{f=0} f&&NF{n++} END{exit !n}' CHANGELOG.md ||
        die "CHANGELOG.md [Unreleased] is empty: say what this release changes"
    say "v$LAST -> v$V (${next#* }); HEAD ${HEAD_SUBJECT}"
    if $DRY; then
        say "dry-run: would bump, commit chore(release): v$V, push main, wait for ci-gate, tag v$V, push the tag"
        exit 0
    fi
    if [ -z "$WANT" ]; then
        [ -r /dev/tty ] || die "no terminal to confirm on: name the version (scripts/release.sh $V)"
        read -r -p "release v$V? [y/N] " ok </dev/tty
        [ "$ok" = y ] || die "aborted"
    fi
    scripts/bump-version.sh "$V" >/dev/null
    git add -A
    git commit --quiet -m "chore(release): v$V"
fi
$DRY && {
    say "dry-run: would push, wait for ci-gate, tag v$V"
    exit 0
}

SHA="$(git rev-parse HEAD)"
if [ "$(git ls-remote origin refs/heads/main | cut -f1)" != "$SHA" ]; then
    "${PUSH[@]}" origin main
fi
[ "$(git ls-remote origin refs/heads/main | cut -f1)" = "$SHA" ] || die "main on origin is not ${SHA:0:7}: the push did not land"
$RESUME || say "release commit ${SHA:0:7} pushed"
wait_green "$SHA"
git tag "v$V" "$SHA"
"${PUSH[@]}" origin "v$V"
[ "$(git ls-remote origin "refs/tags/v$V" | cut -f1)" = "$SHA" ] || die "the tag v$V did not land on origin"
say "v$V tagged on green ${SHA:0:7}; release.yml publishes it (gh run list --workflow release.yml)"
