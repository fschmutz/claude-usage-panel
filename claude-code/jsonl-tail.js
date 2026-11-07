// The one incremental JSONL reader of the Node clients: the status line's
// transcript totals (transcript-tokens.js) and the shared session index
// (mcp/sessions.js) both read Claude Code transcripts through it, each with
// its own fold. Transcripts are append-only, so a caller keeps a byte offset
// and only ever reads what was added since.
//
// The window is cut at its last newline and only complete lines are folded:
// a window can end mid-line (and mid-UTF-8 sequence), and decoding that tail
// would both corrupt a character and risk folding a half-written turn. What
// follows the last newline is handed back as `partial`, uncommitted, for a
// caller that wants a provisional figure; the next read starts before it.

import {Buffer} from 'node:buffer';
import fs from 'node:fs';

// A newline-less run this long is not a line (lib/sessionIndex.js CARRY_MAX,
// Sessions.swift): it is consumed, so the offset moves on instead of re-reading
// it on every call; the rest of that "line" then fails to parse, like any
// fragment.
const CARRY_MAX = 1 << 20;

/** Bytes [start, end) of a file, as a Buffer (shorter when the file is). */
export function readBytes(p, start, end) {
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

/**
 * Fold every complete line of `p` in [start, end) through `fold(line)`.
 * @returns {{consumed: number, partial: string}} bytes the caller may add to
 *   its offset, and the text after the last newline (not folded).
 * Throws when the file cannot be read; the caller decides what that means.
 */
export function foldAppended(p, {start = 0, end, fold, readFrom = readBytes}) {
  if (end <= start) return {consumed: 0, partial: ''};
  const chunk = readFrom(p, start, end);
  const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const cut = buf.lastIndexOf(0x0a) + 1; // up to and including the last newline
  if (!cut) {
    return buf.length >= CARRY_MAX
      ? {consumed: buf.length, partial: ''}
      : {consumed: 0, partial: buf.toString('utf8')};
  }
  for (const line of buf.subarray(0, cut).toString('utf8').split('\n')) fold(line);
  return {consumed: cut, partial: buf.subarray(cut).toString('utf8')};
}
