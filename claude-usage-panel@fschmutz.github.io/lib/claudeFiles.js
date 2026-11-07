// Claude Code's own two files, read the one way every consumer agrees on: the
// live credentials and the `oauthAccount` block of ~/.claude.json. The usage
// fetch and the account store both go through here, so "which login is live"
// has exactly one answer (and honors CLAUDE_CONFIG_DIR, via lib/paths.js).
// Both reads are async: ~/.claude.json runs to hundreds of KB, and this is
// read on every poll.

import {readJSONAsync} from './fs.js';
import {claudeConfigPath, credentialsPath} from './paths.js';
import {parseCredentials} from './pure.js';

/** The credentials blob Claude Code holds now (legacy flat shapes lifted by
 *  parseCredentials), or null when there is none. */
export async function readLiveCredentials() {
    return parseCredentials(await readJSONAsync(credentialsPath()));
}

/** The `oauthAccount` block of ~/.claude.json, or null. */
export async function readLiveAccount() {
    const acct = (await readJSONAsync(claudeConfigPath()))?.oauthAccount;
    return acct && typeof acct === 'object' ? acct : null;
}
