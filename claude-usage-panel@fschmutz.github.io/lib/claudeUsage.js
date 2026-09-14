// Data layer: query the official usage endpoint with the live Claude Code
// token (lib/claudeFiles.js - the one reader the account store uses too), or
// with a saved account's token. Read-only: nothing here writes.

import Soup from 'gi://Soup';

import {readAccessToken} from './claudeFiles.js';
import {parseBody, send} from './http.js';
import {normalizeUsage, normalizeExtraUsage} from './pure.js';

const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA_HEADER = 'oauth-2025-04-20';

/**
 * Fetch usage from the endpoint. `token` defaults to the live login's; a
 * saved account's token (lib/accounts.js) reads that account's usage instead.
 * @returns {Promise<{ok: true, cards: object[], extraUsage: ?object, raw: object}
 *                   | {ok: false, code: string, message: string}>}
 */
export async function fetchUsage(session, token = readAccessToken()) {
    if (!token) {
        return {
            ok: false,
            code: 'no_token',
            message: 'No Claude credentials found. Sign in with Claude Code.',
        };
    }
    const message = Soup.Message.new('GET', USAGE_ENDPOINT);
    message.request_headers.append('authorization', `Bearer ${token}`);
    message.request_headers.append('anthropic-beta', OAUTH_BETA_HEADER);

    let status, bytes;
    try {
        ({status, bytes} = await send(session, message));
    } catch (e) {
        return {ok: false, code: 'network_error', message: e.message};
    }
    if (status === 401 || status === 403) {
        return {
            ok: false,
            code: 'auth_expired',
            message: 'Claude session expired. Run any Claude Code command to refresh.',
        };
    }
    if (status < 200 || status >= 300)
        return {ok: false, code: 'http_error', message: `HTTP ${status}`};
    try {
        const raw = parseBody(bytes);
        return {ok: true, cards: normalizeUsage(raw), extraUsage: normalizeExtraUsage(raw), raw};
    } catch (e) {
        return {ok: false, code: 'parse_error', message: e.message};
    }
}
