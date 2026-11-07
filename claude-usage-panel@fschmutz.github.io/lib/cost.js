// Optional cost layer: the official usage API does not expose the dollar cost
// of token usage on subscription plans, so we shell out to `ccusage` (which
// computes it from the local ~/.claude/projects/*.jsonl logs).
//
// Only an installed `ccusage` runs. There is no `npx ccusage@latest`
// fallback: that fetched and ran the newest unpinned npm release on every
// poll, inside the session that holds the Claude OAuth token.

import GLib from 'gi://GLib';

import {run} from './proc.js';

const CCUSAGE_ARGS = ['blocks', '--active', '--json'];

/** The ccusage to run: the one on the Shell's PATH, else the locked launcher
 *  `./install.sh cost` writes to ~/.local/bin, which a session's PATH may
 *  not hold (its profile only adds the dir when it existed at login). */
export function ccusageBin() {
    const onPath = GLib.find_program_in_path('ccusage');
    if (onPath)
        return onPath;
    const local = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'ccusage']);
    return GLib.file_test(local, GLib.FileTest.IS_EXECUTABLE) ? local : 'ccusage';
}

/**
 * Run `ccusage blocks --active --json` and resolve the active block cost.
 * @returns {Promise<{costUSD: number, tokens: number} | null>}
 */
export async function fetchActiveCost() {
    const {ok, stdout} = await run([ccusageBin(), ...CCUSAGE_ARGS]);
    if (!ok || !stdout)
        return null;
    let block;
    try {
        block = JSON.parse(stdout)?.blocks?.[0];
    } catch {
        return null;
    }
    if (!block)
        return null;
    return {
        costUSD: Number(block.costUSD) || 0,
        tokens: Number(block.totalTokens) || 0,
    };
}
