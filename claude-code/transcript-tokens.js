// Token totals for one Claude Code session transcript (a JSONL, one message
// per line), for the status line's "∑ N tok" segment. Two layers: the pure
// fold (turnTokens, transcriptTokens) and an incremental on-disk cache
// (transcriptTotals), because Claude Code re-runs the status line on every
// refresh and a long transcript is tens of MB.
//
// turnTokens is the per-turn rule every port shares (mcp/sessions.js,
// lib/pure/sessions.js, Sessions.swift, tests/fixtures/sessions.json): what one
// assistant turn billed, cache reads excluded. The status line's `all` figure
// adds the cache reads back on top of it.

import {Buffer} from 'node:buffer';
import fs from 'node:fs';

import {tokensCachePath} from './paths.js';

/** Tokens billed for one assistant turn - cache READS excluded, they bill at a
 *  fraction and would rank every long session first. */
export function turnTokens(usage) {
  if (!usage) return 0;
  return (Number(usage.input_tokens) || 0) +
    (Number(usage.output_tokens) || 0) +
    (Number(usage.cache_creation_input_tokens) || 0);
}

// Fold the complete JSONL lines of `text` into `acc` ({all, fresh, ids}),
// deduping by message id against `ids` (mutated). Unparseable lines (a partial
// last line while Claude Code is writing) are skipped.
function foldTokens(text, acc) {
  for (const line of text.split('\n')) {
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const u = o?.message?.usage;
    if (!u) continue;
    const id = o.message?.id;
    if (id) {
      if (acc.ids.has(id)) continue;
      acc.ids.add(id);
    }
    const turn = turnTokens(u);
    acc.fresh += turn;
    acc.all += turn + (Number(u.cache_read_input_tokens) || 0);
  }
  return acc;
}

/**
 * Every token each assistant turn consumed, in one pass over the session
 * transcript (a JSONL, one message per line): `all` counts prompt, cache
 * writes, cache reads and completion; `fresh` leaves the cache reads out.
 * Deduped by message id so a replayed line isn't counted twice. Cache reads
 * dominate a long session, so `all` is the true throughput.
 */
export function transcriptTokens(jsonlText) {
  const {all, fresh} = foldTokens(jsonlText, {all: 0, fresh: 0, ids: new Set()});
  return {all, fresh};
}

/** The old two-call shape, for callers that want one figure. */
export function sumTranscriptTokens(jsonlText, includeCacheRead = true) {
  const t = transcriptTokens(jsonlText);
  return includeCacheRead ? t.all : t.fresh;
}

// How many transcripts the token cache remembers (parallel sessions each keep
// their own entry), and how many trailing message ids each entry keeps for
// dedupe across an incremental read. Claude Code writes the lines of one
// message back to back, so a short tail catches every replay.
const TOKENS_CACHE_ENTRIES = 16;
const TOKENS_SEEN_TAIL = 64;
const TOKENS_CACHE_VERSION = 2;

function readBytes(p, start, end) {
  const fd = fs.openSync(p, 'r');
  try {
    const buf = Buffer.alloc(Math.max(0, end - start));
    let got = 0;
    while (got < buf.length) {
      const n = fs.readSync(fd, buf, got, buf.length - got, start + got);
      if (!n) break;
      got += n;
    }
    return buf.subarray(0, got);
  } finally {
    fs.closeSync(fd);
  }
}

function readTokensCache(cachePath) {
  try {
    const c = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (c?.version === TOKENS_CACHE_VERSION && c.entries && typeof c.entries === 'object') return c.entries;
  } catch {
    // no cache, unreadable, or the pre-v2 single-slot shape - start empty.
  }
  return {};
}

function writeTokensCache(cachePath, entries) {
  const keep = Object.entries(entries)
    .sort((a, b) => (b[1].usedAt ?? 0) - (a[1].usedAt ?? 0))
    .slice(0, TOKENS_CACHE_ENTRIES);
  const tmp = `${cachePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({version: TOKENS_CACHE_VERSION, entries: Object.fromEntries(keep)}),
      {mode: 0o600});
    fs.renameSync(tmp, cachePath); // atomic: a parallel session never reads half a file
  } catch {
    // A read-only tmp dir just means no cache; not fatal.
    try {
      fs.rmSync(tmp, {force: true});
    } catch {
      // nothing to clean up
    }
  }
}

// {all, fresh} token totals for a transcript. Claude Code re-invokes the
// status line on every refresh and a long transcript is tens of MB, so the totals
// are cached on disk per transcript path (the last TOKENS_CACHE_ENTRIES
// transcripts, so parallel sessions do not evict each other) together with the
// byte offset of the last complete line folded in. An unchanged file is served
// without a read; a grown one is read only past that offset; a shrunk or
// replaced one (size below the offset, other inode) is folded from scratch. A
// trailing line without its newline yet is counted in the result but not in the
// cached state, so it is re-read, not double-counted, once it completes.
// Returns null when the transcript isn't on disk yet. statFile/readFrom/
// cachePath/nowMs are injectable for tests.
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
    return {all: e.all + e.tailAll, fresh: e.fresh + e.tailFresh};
  }
  if (!e || e.ino !== ino || size < e.offset) e = {offset: 0, all: 0, fresh: 0, ids: []};
  let chunk;
  try {
    chunk = readFrom(p, e.offset, size);
  } catch {
    return null;
  }
  const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const cut = buf.lastIndexOf(0x0a) + 1; // bytes up to and including the last newline
  const acc = foldTokens(buf.subarray(0, cut).toString('utf8'), {all: e.all, fresh: e.fresh, ids: new Set(e.ids)});
  const tail = foldTokens(buf.subarray(cut).toString('utf8'), {all: 0, fresh: 0, ids: new Set(acc.ids)});
  entries[p] = {
    size, mtimeMs: st.mtimeMs, ino, offset: e.offset + cut,
    all: acc.all, fresh: acc.fresh, tailAll: tail.all, tailFresh: tail.fresh,
    ids: [...acc.ids].slice(-TOKENS_SEEN_TAIL), usedAt: nowMs,
  };
  writeTokensCache(cachePath, entries);
  return {all: acc.all + tail.all, fresh: acc.fresh + tail.fresh};
}
