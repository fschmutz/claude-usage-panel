// The reset countdown as the terminal clients print it: "3h06m" / "4d2h",
// the compact label of the status line, the MCP server, the CLI and
// linux/usage-bar.mjs. The split itself (whole seconds floored, then days /
// hours / minutes) is lib/pure/usage.js resetParts, the same one the GNOME
// "Resets in 3h 06m" is built on; tests/fixtures/resets.json pins both
// labels, and Swift ResetCountdown against the same file. The ping stamps
// live in lib/pure/pings.js.

import {compactResets} from '../claude-usage-panel@fschmutz.github.io/lib/pure/usage.js';

// The split and the label are lib/pure/usage.js compactResets, shared with the
// panels' account rows; this name stays for the terminal clients.
export const resetHint = compactResets;
