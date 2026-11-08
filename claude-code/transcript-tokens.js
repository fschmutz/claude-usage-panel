// Token totals for one Claude Code session transcript (a JSONL, one message
// per line), for the status line's "∑ N tok" segment. Two layers: the fold
// (transcriptTokens) and an incremental on-disk cache (transcriptTotals),
// because Claude Code re-runs the status line on every refresh and a long
// transcript is tens of MB.
//
// The fold is lib/pure/sessions.js foldSessionLine, the one every port's
// session index runs (Sessions.swift; tests/fixtures/sessions.json): `fresh`
// is what it books into byDay (cache reads excluded, deduped by message id),
// `all` adds its `cacheRead` back on top. The incremental read is
// jsonl-tail.js, shared with mcp/sessions.js.

import fs from 'node:fs';

import {foldSessionLine, newSessionAcc} from '../claude-usage-panel@fschmutz.github.io/lib/pure/sessions.js';
import {foldAppended, readBytes} from './jsonl-tail.js';
import {tokensCachePath} from './paths.js';
import {writeAtomic} from './private-fs.js';

// byDay key for a usage line with no timestamp. The totals sum every day, so
// the key only has to be one no real day can be.
const UNDATED = 'undated';

const foldLine = (acc) => (line) => foldSessionLine(line, acc, UNDATED);

/** {all, fresh} of a fold accumulator. */
function totalsOf(acc) {
  const fresh = Object.values(acc.byDay).reduce((a, b) => a + b, 0);
  return {all: fresh + (Number(acc.cacheRead) || 0), fresh};
}

/**
 * Every token each assistant turn consumed, in one pass over the session
 * transcript (a JSONL, one message per line): `all` counts prompt, cache
 * writes, cache reads and completion; `fresh` leaves the cache reads out.
 * Deduped by message id so a replayed line isn't counted twice. Cache reads
 * dominate a long session, so `all` is the true throughput.
 */
export function transcriptTokens(jsonlText) {
  const acc = newSessionAcc();
  String(jsonlText).split('\n').forEach(foldLine(acc));
  return totalsOf(acc);
}

// How many transcripts the token cache remembers (parallel sessions each keep
// their own entry). v3: an entry holds the pure fold accumulator.
const TOKENS_CACHE_ENTRIES = 16;
const TOKENS_CACHE_VERSION = 3;

function readTokensCache(cachePath) {
  try {
    const c = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (c?.version === TOKENS_CACHE_VERSION && c.entries && typeof c.entries === 'object') return c.entries;
  } catch {
    // no cache, unreadable, or an older shape - start empty.
  }
  return {};
}

function writeTokensCache(cachePath, entries) {
  const keep = Object.entries(entries)
    .sort((a, b) => (b[1].usedAt ?? 0) - (a[1].usedAt ?? 0))
    .slice(0, TOKENS_CACHE_ENTRIES);
  try {
    // atomic: a parallel session never reads half a file
    writeAtomic(cachePath, JSON.stringify({version: TOKENS_CACHE_VERSION, entries: Object.fromEntries(keep)}));
  } catch {
    // A read-only tmp dir just means no cache; not fatal.
  }
}

// {all, fresh} token totals for a transcript. Claude Code re-invokes the
// status line on every refresh and a long transcript is tens of MB, so the
// fold accumulator is cached on disk per transcript path (the last
// TOKENS_CACHE_ENTRIES transcripts, so parallel sessions do not evict each
// other) together with the byte offset of the last complete line folded in.
// An unchanged file is served without a read; a grown one is read only past
// that offset; a shrunk or replaced one (size below the offset, other inode)
// is folded from scratch. A trailing line without its newline yet is counted
// in the result but not in the cached state, so it is re-read, not
// double-counted, once it completes. Returns null when the transcript isn't
// on disk yet. statFile/readFrom/cachePath/nowMs are injectable for tests.
export function transcriptTotals(p, {
  statFile = fs.statSync,
  readFrom = readBytes,
  cachePath = tokensCachePath(),
  nowMs = Date.now(),
} = {}) {
  let st;
  try {
    st = statFile(p);
  } catch {
    return null; // transcript not on disk yet, or not readable
  }
  const size = Number(st.size) || 0;
  const ino = st.ino ?? null;
  const entries = readTokensCache(cachePath);
  let e = entries[p];
  if (e && e.size === size && e.mtimeMs === st.mtimeMs && e.ino === ino) {
    // Refresh the LRU stamp at most once a minute: a hit stays read-only.
    if (nowMs - (e.usedAt ?? 0) > 60_000) {
      e.usedAt = nowMs;
      writeTokensCache(cachePath, entries);
    }
    return e.totals;
  }
  if (!e || e.ino !== ino || size < e.offset) e = {offset: 0, acc: newSessionAcc()};
  const acc = e.acc;
  let read;
  try {
    read = foldAppended(p, {start: e.offset, end: size, fold: foldLine(acc), readFrom});
  } catch {
    return null;
  }
  // The trailing line counts now, in a copy: the cached state stays at the
  // last newline so the completed line is folded exactly once.
  const provisional = {...acc, byDay: {...acc.byDay}, ids: [...acc.ids]};
  foldLine(provisional)(read.partial);
  const totals = totalsOf(provisional);
  entries[p] = {size, mtimeMs: st.mtimeMs, ino, offset: e.offset + read.consumed, acc, totals, usedAt: nowMs};
  writeTokensCache(cachePath, entries);
  return totals;
}
