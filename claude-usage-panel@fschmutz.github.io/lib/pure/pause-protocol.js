// Pure logic - no GJS/gi imports, so it is unit-testable under plain `node`.
// Re-exported by lib/pure.js; import from there (the Node clients import
// this file directly).
//
// The words a paused or resumed Claude Code session receives: the PAUSE and
// RESUME protocols, who sent the request, and the approval rule a resumed
// session keeps. Prose only - the request shape, the delivery rules and the
// row state are ./pause.js. Node-only: the menu-bar app never delivers.

import {parsePauseRequest} from './pause.js';
import {shellQuote} from './sessions.js';

// The protocol texts. The source of truth is this file; PAUSE_PROTOCOL steps
// 3c, 4b and 5 name the checkpoint path, the leftovers command and the
// report command of the request.
function pauseProtocol({checkpoint, report, leftovers, leftoversNote, verdictFile, reasonFile, requestId}) {
    const cp = shellQuote(checkpoint);
    return `PAUSE PROTOCOL
${leftoversNote}Run it before anything else. The protocol is the same for a 5-minute break and
for a shutdown: everything stops, and everything needed to resume is written to disk.
You may not say it is safe to close until the gate in step 4 passes.

Scope: only the jobs this session launched and the repos it touched. The user may send
the same pause to several sessions in parallel. Never stop, stash, reset or edit
anything owned by another session.

1. INVENTORY - be over-inclusive. A job you list that turns out to be already dead
   costs nothing. A job you miss is the failure this protocol exists to prevent.
   Go through your own history and list every launch that has no terminal
   completed/failed/killed/stopped notification after it:
   a. Harness jobs: background shell commands, monitors, subagents (background,
      forked, named teammates), workflow runs and their child agents, /loop and
      scheduled wake-ups, session cron jobs, git worktrees you entered or created,
      browser-automation tabs and recordings, requests sent to other sessions that
      are still awaiting a reply.
   b. Processes you started: dev servers, watchers, test runners, headless browsers,
      containers, ssh / SSM / port-forward / tunnel sessions, database sessions,
      especially any with an open transaction.
   c. External work in flight: CI runs, deploys, cloud builds, migrations. Do NOT
      cancel these. Record the id and how to check the result.
   d. Persistent by design: cloud routines and remote triggers. Leave them running
      and record them.
   e. Repo state: rebase / merge / cherry-pick / bisect in progress, staged or
      unstaged edits, unpushed commits, stashes you created, lock files you hold.
   f. Things that expire while away: tokens, leases, approvals, OTP or sudo
      windows, pending scheduled actions.

2. STOP - in this order:
   a. Every agent and workflow child: tell it to commit only work that passes the
      repo's gates, write a stop report (done / half-done files / next step), and
      stop. Wait for each report, up to ~3 min.
   b. Then force-stop every id from 1a that is not yet terminal, the ones that
      answered included. If the stop call says "not found", the job is already
      dead: record it as such.
   c. For each workflow, record its run id, the agent or stage it was cut in (its
      writes may be half-applied) and the exact resume call. Copy its script next
      to the checkpoint (same directory, <run id>.js): the stored script sits under
      the project dir of the cwd it was launched from, which a reopened session
      may not be allowed to read.
   d. Kill the processes from 1b. Roll back open DB transactions: never leave one
      open, never commit one just to pause.
   e. Cancel pending wake-ups, loops and session crons, and record how to re-create
      each one.

3. SAVE - nothing that matters may live only in your context, in /tmp or in a
   scratch dir: those die with the session or a reboot.
   a. Leave half-done edits in the working tree. No stash, no reset, no revert.
      Commit only what passes the gates.
   b. Move work out of /tmp and the scratch dir to a durable directory, then
      re-point every path that names the old place (scripts, constants, workflow
      args) to the new one. A copy that scripts do not use is not saved: the
      resumed session must never re-create /tmp paths or symlinks.
   c. Overwrite ONE checkpoint file, at this fixed path (create its directory if
      needed); the next session reads it first:
      ${checkpoint}
      It must be enough to resume with no other context:
      - goal (one line) and definition of done
      - done: with commit SHAs
      - stopped mid: each half-done task split into done part + remaining part,
        with the files involved
      - every job from step 1: kind, id, state (stopped / already dead / external /
        persistent), resume or re-arm command
      - repo state per repo: branch, HEAD, ahead/behind, dirty files, op in progress
      - pending user actions and open questions, with options and a recommendation
      - next steps in order, each with its first command
      - tried and failed, and why
      - the smoke check to run first on resume
      - what expires, and when

4. GATE - verify; do not assume:
   a. Re-list harness jobs (task list, cron list, agent list) and force-stop every
      subagent, workflow and background task still listed, one shown as completed
      or dead included: a status label is not proof. "Not found" means it is gone.
   b. Run this; it lists every process still carrying this session's id that is
      not the harness's own (Bash jobs, their children, anything orphaned):
      ${leftovers}
      It must list nothing. Kill what it lists (they are yours), then run it again.
   c. Re-check what it cannot see: containers you started, ports you opened.
      Each must be gone.
   d. Read the checkpoint back. It must exist and contain every job id from step 1.
   e. Anything still alive must be either stopped now or named with a reason
      (external / persistent by design).

5. REPLY - first record the verdict, so the user's panel and claudectl see it:
      ${report} --verdict SAFE --checkpoint ${cp}
   or, when something is still running: write what is still running and why to
   ${reasonFile} with your file-writing tool (no shell quoting to get wrong), then:
      ${report} --verdict NOT_SAFE --checkpoint ${cp} --reason-file ${shellQuote(reasonFile)}
   If that command cannot run, write this JSON to ${verdictFile} instead
   (mode 0600; at = epoch milliseconds now; reason only for NOT_SAFE):
      {"requestId": "${requestId}", "at": <ms>, "verdict": "SAFE" or "NOT_SAFE", "reason": "...", "checkpoint": "${checkpoint}"}
   Then line 1 of your reply is exactly one of:
   SAFE TO CLOSE
   NOT SAFE: <what is still running and why>
   Then one short table: item | state | on return. Then the checkpoint path. Nothing else.`;
}

/** The approval rule a resumed session keeps. One copy: claude-code/tabs.js
 *  resumePrompt ends with it, and so does a delivered resume request. */
export const PAUSE_RESUME_GUARD = 'Same rules as before: nothing destructive, outward-facing or still ' +
    'waiting on the user\'s answer without asking the user first.';

function resumeProtocol(checkpoint, exists, leftovers = null) {
    const where = exists
        ? `Your checkpoint: ${checkpoint}`
        : `No checkpoint was found at ${checkpoint}: re-read the end of this conversation instead.`;
    const sweep = leftovers
        ? `\n   Then run: ${leftovers}\n` +
          '   Whatever it lists outlived the pause: stop it, unless the checkpoint names it as\n' +
          '   persistent by design; then adopt it instead of starting a second copy.'
        : '';
    return `RESUME PROTOCOL
${where}
1. Read the checkpoint before anything else. Background shells, monitors, agents and
   workflows do NOT survive a restart: treat each one as dead unless a fresh check
   proves otherwise.${sweep}
2. For any action that was cut off mid-flight, check whether it took effect before
   redoing it (commit landed? file written? deploy started?).
3. Run the recorded smoke check on the dirty trees before any new work.
4. Re-arm: resume each workflow from its run id (resumeFromRunId keeps every
   finished agent's result). When its scriptPath is refused, pass the saved script
   inline (\`script\`) with the same run id and the durable paths as args. Start a
   fresh run only when the resume itself fails, and say why. Restart the needed
   monitors and watchers, re-check the external runs.
5. Continue the next steps without asking again. Report only what needs the user.`;
}

/** The RESUME PROTOCOL block a reopened session gets (claude-code/tabs.js
 *  resumePrompt) when it has a pending checkpoint; `leftovers` is the
 *  command that lists what the session left running, when known. */
export function resumeProtocolText(checkpoint, leftovers = null) {
    return resumeProtocol(checkpoint, true, leftovers);
}

const ORIGIN = {cli: 'typed `claudectl session pause`', gnome: 'clicked Pause in the GNOME panel', macos: 'clicked Pause in the menu-bar app'};

/** Who sent it, as far as claudectl can tell. The store is writable by any
 *  process of the user, so this is a claim, never proof: a request sent from
 *  inside a Claude Code session says so and asks for the user's go-ahead. */
function pauseHeader(r, sentAt, held) {
    const tag = `[claudectl ${r.kind} request ${r.id}]`;
    if (r.from === 'session') {
        const who = r.origin ? `Claude Code session ${r.origin.slice(0, 8)}` : 'another Claude Code session';
        const ask = r.kind === 'pause'
            ? 'Before stopping anything, ask the user whether they want this session paused; run the protocol below only if they say so.'
            : 'Before resuming any work, ask the user whether they want it resumed; run the protocol below only if they say so.';
        return `${tag} Sent at ${sentAt} from inside ${who}, not typed by the user. ${ask}${held}`;
    }
    const origin = r.kind === 'resume'
        ? ORIGIN[r.from].replace('pause', 'resume').replace('Pause', 'Resume')
        : ORIGIN[r.from];
    return `${tag} The user ${origin} at ${sentAt}; the claudectl pause hook installed with ` +
        `./install.sh pause delivered it.${held} ` +
        (r.kind === 'pause' ? 'Run the protocol below now, before anything else.' : 'Run the protocol below now.');
}

/**
 * What a session receives: who sent it (pauseHeader), then the protocol;
 * a resume ends with PAUSE_RESUME_GUARD. `via` = 'pretooluse' adds that the
 * held-back tool call was deliberate. Fields: request, sentAt ("14:05"),
 * checkpoint (absolute path), checkpointExists, report (the report command
 * up to --verdict), leftovers (the command listing what the session left
 * running) and leftoversNote (pure/leftovers.js leftoversNote of what it
 * listed at delivery, '' for nothing),
 * verdictFile, reasonFile (where a NOT_SAFE reason is written, so it never
 * passes through shell quoting).
 */
export function pauseDeliveryText({request, sentAt, checkpoint, checkpointExists = false, report, leftovers, leftoversNote = '', verdictFile, reasonFile, via}) {
    const r = parsePauseRequest(request);
    if (!r)
        return '';
    const held = via === 'pretooluse'
        ? ' The tool call you just tried was held back on purpose to hand you this; it is not an error.'
        : '';
    const body = r.kind === 'pause'
        ? pauseProtocol({checkpoint, report, leftovers, leftoversNote, verdictFile, reasonFile, requestId: r.id})
        : `${resumeProtocol(checkpoint, checkpointExists, leftovers)}\n${PAUSE_RESUME_GUARD}`;
    return `${pauseHeader(r, sentAt, held)}\n\n${body}\n`;
}
