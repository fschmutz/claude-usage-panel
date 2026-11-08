// Today's sessions and the last session ping for the MCP server.
// scripts/session-ping.sh writes its last successful ping under the state
// dir; the panels and the status line read the same file. The session index
// is likewise shared with the desktop clients - one machine, one set of
// transcripts, one incremental index - so whichever client runs keeps it warm
// for the others. The folding, ranking and resume rules are
// lib/pure/sessions.js, the one JavaScript copy GNOME's lib/sessionIndex.js
// uses too (tests/fixtures/sessions.json); this file is the Node I/O around it.

import fs from 'node:fs';
import path from 'node:path';

import {formatLastPing, localDay, parseStamp} from '../claude-usage-panel@fschmutz.github.io/lib/pure/pings.js';
import {
  foldSessionLine, indexMtime, newSessionAcc, pruneByDay, rankSessions, resumeCommand,
} from '../claude-usage-panel@fschmutz.github.io/lib/pure/sessions.js';
import {foldAppended} from '../claude-code/jsonl-tail.js';
import {lastPingPath, nowOf, projectsDir, sessionIndexPath} from '../claude-code/paths.js';
import {writeAtomic} from '../claude-code/private-fs.js';

const INDEX_VERSION = 1;
const SESSION_BUDGET_BYTES = 16 << 20; // per call: a cold index warms over a few
const SESSION_LIMIT = 5;

function readIndex(indexPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    if (parsed?.version !== INDEX_VERSION || typeof parsed.files !== 'object') {
      return {version: INDEX_VERSION, files: {}};
    }
    return parsed;
  } catch {
    return {version: INDEX_VERSION, files: {}};
  }
}

// Transcripts touched in the last two days, the only ones that can carry tokens
// spent today.
function sessionCandidates(projectsDir, nowMs) {
  const cutoff = nowMs - 2 * 86_400_000;
  const out = [];
  let projects;
  try {
    projects = fs.readdirSync(projectsDir, {withFileTypes: true});
  } catch {
    return out;
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const dir = path.join(projectsDir, project.name);
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of files) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      try {
        const st = fs.statSync(file);
        if (st.mtimeMs >= cutoff) out.push({path: file, size: st.size, mtimeMs: indexMtime(st.mtimeMs)});
      } catch {
        // vanished between readdir and stat
      }
    }
  }
  return out;
}

// Fold the appended tail of one transcript, at most `budget` bytes of it.
// Files are append-only, so this only ever reads the bytes added since the
// last call - which is what makes indexing hundreds of megabytes of
// transcripts affordable to repeat. jsonl-tail.js cuts the window at its last
// newline (shared with the status line's transcript totals); what follows is
// read again next time, never folded half-written.
function foldTail(file, entry, budget, nowMs) {
  const start = entry.offset ?? 0;
  const day = localDay(nowMs);
  let consumed = 0;
  try {
    ({consumed} = foldAppended(file.path, {
      start, end: Math.min(file.size, start + budget),
      fold: (line) => foldSessionLine(line, entry, day),
    }));
  } catch {
    consumed = 0; // unreadable right now: the next call retries
  }
  entry.offset = start + consumed;
  entry.byDay = pruneByDay(entry.byDay, nowMs);
  return consumed;
}

// Atomic, like the GNOME port's saveIndex: every client reads this file, and a
// torn read (or a crash mid-write) would hand them all an empty index to
// re-fold from scratch. writeAtomic's temp name carries the pid - several MCP
// servers can run at once.
function writeIndex(indexPath, index) {
  try {
    writeAtomic(indexPath, JSON.stringify(index));
  } catch {
    // A read-only cache dir means no cache, not a broken tool call.
  }
}

/**
 * Update the shared session index and return today's sessions, biggest token
 * spender first. Never throws: a missing ~/.claude/projects just yields [].
 * `io` picks the home / env (see paths.js) and may override `projects`,
 * `indexPath`, `limit`, `budgetBytes` directly.
 */
export function refreshSessions(io = {}) {
  const nowMs = nowOf(io);
  const limit = io.limit ?? SESSION_LIMIT;
  const indexPath = io.indexPath ?? sessionIndexPath(io);
  const index = readIndex(indexPath);
  const files = sessionCandidates(io.projects ?? projectsDir(io), nowMs);
  let budget = io.budgetBytes ?? SESSION_BUDGET_BYTES;
  let dirty = false;

  for (const file of files) {
    let entry = index.files[file.path];
    // Shrunk below what we already folded: the file was replaced, not appended
    // to. Start it over rather than folding from a stale offset.
    if (!entry || (entry.offset ?? 0) > file.size) {
      entry = Object.assign(newSessionAcc(), {offset: 0});
    }
    index.files[file.path] = entry;
    if (entry.size === file.size && entry.mtimeMs === file.mtimeMs) continue;
    if (budget <= 0) continue;
    budget -= foldTail(file, entry, budget, nowMs);
    dirty = true;
    if (entry.offset >= file.size) {
      entry.size = file.size;
      entry.mtimeMs = file.mtimeMs;
    }
  }

  const live = new Set(files.map((f) => f.path));
  for (const p of Object.keys(index.files)) {
    if (!live.has(p)) {
      delete index.files[p];
      dirty = true;
    }
  }
  if (dirty) writeIndex(indexPath, index);
  // The tool prints the command itself, so each row carries it.
  return rankSessions(Object.values(index.files), {nowMs, limit})
    .map((e) => ({...e, resumeCommand: resumeCommand(e)}));
}

/** The last scheduled ping, or null when pings were never set up. */
export function readLastPing(io = {}) {
  const nowMs = nowOf(io);
  let raw;
  try {
    raw = fs.readFileSync(io.pingPath ?? lastPingPath(io), 'utf8').trim();
  } catch {
    return null;
  }
  const at = parseStamp(raw);
  if (at === null) return null;
  return {at: new Date(at).toISOString(), label: formatLastPing(raw, nowMs)};
}

export function renderPing(lastPing) {
  return lastPing ? `Last scheduled session ping: ${lastPing.label}` : '';
}

// Tokens here are reconstructed from the local transcripts, unlike the limit
// percentages above - say so, the same way the panels label them "est.".
export function renderSessions(sessions) {
  if (!sessions?.length) return '';
  return ["Today's sessions by tokens spent (est., local transcripts):"]
    .concat(sessions.map(s =>
      `- **${s.label}** - ${s.tokens} tokens${s.when ? `, last turn ${s.when}` : ''} · ` +
      `resume: \`${s.resumeCommand}\``))
    .join('\n');
}
