// Optional cost layer: the official usage API does not expose the dollar cost
// of token usage on subscription plans, so we shell out to `ccusage` (which
// computes it from the local ~/.claude/projects/*.jsonl logs).

import {run} from './proc.js';

const CANDIDATES = [
    ['ccusage', 'blocks', '--active', '--json'],
    ['npx', '-y', 'ccusage@latest', 'blocks', '--active', '--json'],
];

/**
 * Run `ccusage blocks --active --json` and resolve the active block cost.
 * Tries a globally installed `ccusage` first, then falls back to `npx`.
 * @returns {Promise<{costUSD: number, tokens: number} | null>}
 */
export async function fetchActiveCost() {
    for (const argv of CANDIDATES) {
        const {ok, stdout} = await run(argv);
        if (!ok || !stdout)
            continue;
        let block;
        try {
            block = JSON.parse(stdout)?.blocks?.[0];
        } catch {
            continue;
        }
        if (!block)
            return null;
        return {
            costUSD: Number(block.costUSD) || 0,
            tokens: Number(block.totalTokens) || 0,
        };
    }
    return null;
}
