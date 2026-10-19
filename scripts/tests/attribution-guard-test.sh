#!/usr/bin/env bash
#
# attribution-guard-test.sh — the fixtures scripts/attribution-guard.sh has to
# get right, and the ones it has to leave alone.
#
# Plain bash on purpose: bats would be a dependency for one script, and this
# runs in CI on a runner that has nothing installed but jq and gh.
#
# Each case feeds the guard a recorded `gh api …/commits` payload and a pull
# request body file, then asserts the exit status and one line of the output.
# The pairs that matter are the ones that look alike: a `Co-authored-by:`
# trailer naming the owner passes while one naming anybody else fails, and a
# commit about a database cursor passes while an agent footer fails.
#
#   scripts/tests/attribution-guard-test.sh
#
# Exit 0 when every case holds, 1 otherwise.
#
set -uo pipefail

cd "$(dirname "$0")/../.." || exit 1

readonly GUARD="scripts/attribution-guard.sh"
readonly FIXTURES="scripts/tests/fixtures"

passed=0
failed=0
case_allow=""

indent() {
  local line
  while IFS= read -r line || [ -n "${line}" ]; do
    printf '     | %s\n' "${line}"
  done <<<"$1"
}

# run_case NAME WANT_STATUS WANT_TEXT -- ARGS…  (WANT_TEXT empty: any output)
run_case() {
  local name="$1" want_status="$2" want_text="$3" output status
  shift 3
  output="$(GITHUB_ACTIONS=false ATTRIBUTION_ALLOW="${case_allow}" "${GUARD}" "$@" 2>&1)"
  status=$?
  case_allow=""

  if [ "${status}" -ne "${want_status}" ]; then
    failed=$((failed + 1))
    echo "FAIL ${name}: exit ${status}, expected ${want_status}"
    indent "${output}"
    return
  fi
  if [ -n "${want_text}" ]; then
    case "${output}" in
      *"${want_text}"*) ;;
      *)
        failed=$((failed + 1))
        echo "FAIL ${name}: output does not mention \"${want_text}\""
        indent "${output}"
        return
        ;;
    esac
  fi
  passed=$((passed + 1))
  echo "ok   ${name}"
}

# --- identity -----------------------------------------------------------------

run_case "clean commits and a clean body pass" 0 "no foreign attribution" \
  --commits-file "${FIXTURES}/commits-clean.json" \
  --body-file "${FIXTURES}/body-clean.md"

run_case "an author nobody vouched for fails" 1 "author <somebody@example.com>" \
  --commits-file "${FIXTURES}/commits-foreign-author.json" --commits-only

run_case "an agent as committer fails" 1 "committer <cursoragent@cursor.com>" \
  --commits-file "${FIXTURES}/commits-foreign-committer.json" --commits-only

run_case "a GitHub web merge passes" 0 "no foreign attribution" \
  --commits-file "${FIXTURES}/commits-web-merge.json" \
  --body-file "${FIXTURES}/body-clean.md"

run_case "dependabot and github-actions pass" 0 "no foreign attribution" \
  --commits-file "${FIXTURES}/commits-bot-author.json" \
  --body-file "${FIXTURES}/body-clean.md"

# The name beside the address is its own check: the address here is the
# owner's and is on the list, and the commit still fails.
run_case "a tool as the author name fails" 1 "author name \"Cursor Agent\" reads as a tool" \
  --commits-file "${FIXTURES}/commits-tool-name.json" --commits-only

run_case "a tool as the committer name fails" 1 "committer name \"Claude\" reads as a tool" \
  --commits-file "${FIXTURES}/commits-tool-name.json" --commits-only

run_case "a human whose name collides fails by default" 1 "author name \"Jean-Claude Dubois\" reads as a tool" \
  --commits-file "${FIXTURES}/commits-human-name.json" --commits-only

case_allow="jc.dubois@scalemenow.example,name:Jean-Claude Dubois"
run_case "a name: entry exempts that human" 0 "no foreign attribution" \
  --commits-file "${FIXTURES}/commits-human-name.json" \
  --body-file "${FIXTURES}/body-clean.md"

# --- the allow file is missing, empty, or unreadable ---------------------------

# Failing open on a deleted allow file would make the guard worth nothing, so
# the built-in owner carries the run and the warning says what happened.
run_case "a missing allow file warns and falls back to the owner" 0 "is missing" \
  --allow-file "${FIXTURES}/no-such-allow-file.txt" \
  --commits-file "${FIXTURES}/commits-clean.json" --commits-only

run_case "a missing allow file still fails a foreign author" 1 "author <somebody@example.com>" \
  --allow-file "${FIXTURES}/no-such-allow-file.txt" \
  --commits-file "${FIXTURES}/commits-foreign-author.json" --commits-only

run_case "a comment-only allow file falls back to the owner" 0 "falling back to the built-in default" \
  --allow-file "${FIXTURES}/allow-comments-only.txt" \
  --commits-file "${FIXTURES}/commits-clean.json" --commits-only

# chmod 000 means nothing to root, so this one only runs where it can.
if [ "$(id -u)" -ne 0 ]; then
  unreadable="$(mktemp)"
  printf '%s\n' "fschmutz@premaccess.com" >"${unreadable}"
  chmod 000 "${unreadable}"
  run_case "an unreadable allow file warns and falls back" 0 "is not readable" \
    --allow-file "${unreadable}" \
    --commits-file "${FIXTURES}/commits-clean.json" --commits-only
  rm -f "${unreadable}"
else
  echo "skip an unreadable allow file warns and falls back (running as root)"
fi

# --- the allow-list is configurable -------------------------------------------

run_case "an address off the list fails" 1 "author <deputy@scalemenow.example>" \
  --commits-file "${FIXTURES}/commits-env-allowed.json" --commits-only

case_allow="deputy@scalemenow.example"
run_case "ATTRIBUTION_ALLOW adds an address" 0 "no foreign attribution" \
  --commits-file "${FIXTURES}/commits-env-allowed.json" \
  --body-file "${FIXTURES}/body-clean.md"

# --- commit messages ----------------------------------------------------------

run_case "a trailer naming someone else fails" 1 "Co-authored-by: <somebody@example.com>" \
  --commits-file "${FIXTURES}/commits-foreign-trailer.json" --commits-only

run_case "a trailer naming the owner passes" 0 "no foreign attribution" \
  --commits-file "${FIXTURES}/commits-owner-trailer.json" \
  --body-file "${FIXTURES}/body-clean.md"

run_case "a trailer naming an agent fails" 1 "Co-authored-by: <cursoragent@cursor.com>" \
  --commits-file "${FIXTURES}/commits-agent-trailer.json" --commits-only

run_case "an agent footer in a commit message fails" 1 "link to an assistant product page" \
  --commits-file "${FIXTURES}/commits-agent-footer.json" --commits-only

# The footer rules overlap — the usual footer trips four of them at once — so
# these two carry nothing but the rule they are named after. Delete the rule
# and the case goes red instead of being covered by a neighbour.
run_case "a robot emoji on its own fails" 1 "robot-emoji attribution footer" \
  --commits-file "${FIXTURES}/commits-robot-emoji.json" --commits-only

run_case "\"Generated with\" plus a tool name on its own fails" 1 "\"generated with\" assistant footer" \
  --commits-file "${FIXTURES}/commits-generated-with.json" --commits-only

# The false-positive case, and the reason the patterns are footer-shaped: a
# database cursor, a fixture generated with Playwright, and a cursor.com URL
# that is not an agent run.
run_case "ordinary prose about a cursor passes" 0 "no foreign attribution" \
  --commits-file "${FIXTURES}/commits-ordinary-prose.json" \
  --body-file "${FIXTURES}/body-clean.md"

# A commit message that names the tools mid-sentence — which is what a commit
# changing this guard looks like — is prose, not a footer.
run_case "a message that names tools mid-sentence passes" 0 "no foreign attribution" \
  --commits-file "${FIXTURES}/commits-prose-names-a-tool.json" \
  --body-file "${FIXTURES}/body-clean.md"

# --- the pull request title and body ------------------------------------------

run_case "a clean title and body pass" 0 "no foreign attribution" \
  --commits-file "${FIXTURES}/commits-clean.json" \
  --title-file "${FIXTURES}/title-clean.txt" \
  --body-file "${FIXTURES}/body-clean.md"

run_case "an agent in the title fails" 1 "PR title: agent attribution" \
  --commits-file "${FIXTURES}/commits-clean.json" \
  --title-file "${FIXTURES}/title-agent.txt" \
  --body-file "${FIXTURES}/body-clean.md"

run_case "the agent body markers fail" 1 "PR body: Cursor agent pull request body marker" \
  --commits-file "${FIXTURES}/commits-clean.json" \
  --body-file "${FIXTURES}/body-markers.md"

run_case "an \"Open in …\" footer fails" 1 "PR body:" \
  --commits-file "${FIXTURES}/commits-clean.json" \
  --body-file "${FIXTURES}/body-agent-footer.md"

run_case "a \"Generated with\" footer fails" 1 "PR body:" \
  --commits-file "${FIXTURES}/commits-clean.json" \
  --body-file "${FIXTURES}/body-generated-with.md"

# --- refusals -----------------------------------------------------------------

run_case "a pull request with no commits is an error" 2 "no commits" \
  --commits-file "${FIXTURES}/commits-empty.json" --commits-only

run_case "an unknown argument is an error" 2 "unknown argument" --nonsense

echo
echo "attribution-guard-test: ${passed} passed, ${failed} failed"
[ "${failed}" -eq 0 ]
