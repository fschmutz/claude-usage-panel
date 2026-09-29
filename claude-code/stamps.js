// The reset countdown as the terminal clients print it: "3h06m" / "4d2h",
// the compact label of the status line, the MCP server, the CLI and
// linux/usage-bar.mjs. The split itself (whole seconds floored, then days /
// hours / minutes) is lib/pure/usage.js resetParts, the same one the GNOME
// "Resets in 3h 06m" is built on; tests/fixtures/resets.json pins both
// labels, and Swift ResetCountdown against the same file. The ping stamps
// live in lib/pure/pings.js.

import {resetParts} from '../claude-usage-panel@fschmutz.github.io/lib/pure/usage.js';

// The two most significant units; '' when past, absent or unparseable.
// Flooring (never rounding to the nearest minute) keeps the status line from
// running a minute ahead of the panel and 23h59m40s from reading "1d0h".
export function resetHint(resetsAt, nowMs = Date.now()) {
  const r = resetParts(resetsAt, nowMs);
  if (!r || r.past || !Number.isFinite(r.m)) return '';
  if (r.d > 0) return `${r.d}d${r.h}h`;
  if (r.h > 0) return `${r.h}h${String(r.m).padStart(2, '0')}m`;
  return `${r.m}m`;
}
