// Claude Code's own two files, read the one way every consumer agrees on: the
// live credentials and the `oauthAccount` block of ~/.claude.json. The usage
// fetch and the account store both go through here, so "which login is live"
// has exactly one answer (and honors CLAUDE_CONFIG_DIR, via lib/paths.js).

import {readJSON} from './fs.js';
import {claudeConfigPath, credentialsPath} from './paths.js';

/** The credentials blob Claude Code holds now, or null when there is none. */
export function readLiveCredentials() {
    const json = readJSON(credentialsPath());
    const oauth = json?.claudeAiOauth;
    return oauth && typeof oauth === 'object' && typeof oauth.accessToken === 'string'
        ? json : null;
}

/** The live OAuth access token, or null. */
export function readAccessToken() {
    return readLiveCredentials()?.claudeAiOauth.accessToken ?? null;
}

/** The `oauthAccount` block of ~/.claude.json, or null. */
export function readLiveAccount() {
    const acct = readJSON(claudeConfigPath())?.oauthAccount;
    return acct && typeof acct === 'object' ? acct : null;
}
