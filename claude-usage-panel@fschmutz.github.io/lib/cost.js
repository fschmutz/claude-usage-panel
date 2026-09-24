// Optional cost layer: the official usage API does not expose the dollar cost
// of token usage on subscription plans, so we shell out to `ccusage` (which
// computes it from the local ~/.claude/projects/*.jsonl logs).
//
// Only an installed `ccusage` runs. There is no `npx ccusage@latest`
// fallback: that fetched and ran the newest unpinned npm release on every
// poll, inside the session that holds the Claude OAuth token.

import {run} from './proc.js';

export const CCUSAGE_ARGV = ['ccusage', 'blocks', '--active', '--json'];

/**
 * Run `ccusage blocks --active --json` and resolve the active block cost.
 * @returns {Promise<{costUSD: number, tokens: number} | null>}
 */
export async function fetchActiveCost() {
    const {ok, stdout} = await run(CCUSAGE_ARGV);
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
