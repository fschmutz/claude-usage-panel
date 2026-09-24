// Data layer: query the official usage endpoint with the live Claude Code
// token (lib/claudeFiles.js - the one reader the account store uses too), or
// with a saved account's token. Read-only: nothing here writes.

import Soup from 'gi://Soup';

import Gettext from 'gettext';

import {readAccessToken} from './claudeFiles.js';
import {parseBody, send} from './http.js';
import {httpFailure, normalizeUsage, normalizeExtraUsage} from './pure.js';

// The prefs process loads this file too (through lib/accounts.js), and it
// cannot import the Shell's extension.js, so the catalog is named directly -
// the domain metadata.json declares, bound in both processes at enable.
const {gettext: _} = Gettext.domain('claude-usage-panel');

const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA_HEADER = 'oauth-2025-04-20';

/**
 * The plan the header shows, from the login's own credentials: the usage
 * endpoint names no plan. `subscriptionType` is the plan ("max" -> "Max"),
 * and a `rateLimitTier` ending in a multiplier ("default_claude_max_20x")
 * says which tier of it ("Max 20x"). '' when the login does not say.
 * @param {?object} oauth the `claudeAiOauth` block of .credentials.json
 */
export function planLabel(oauth) {
    const type = typeof oauth?.subscriptionType === 'string' ? oauth.subscriptionType.trim() : '';
    if (!type)
        return '';
    const plan = type.charAt(0).toUpperCase() + type.slice(1);
    const tier = typeof oauth.rateLimitTier === 'string'
        ? /_(\d+x)$/.exec(oauth.rateLimitTier)?.[1] : null;
    return tier ? `${plan} ${tier}` : plan;
}

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
            message: _('No Claude credentials found. Sign in with Claude Code.'),
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
            message: _('Claude session expired. Run any Claude Code command to refresh.'),
        };
    }
    if (status < 200 || status >= 300) {
        let body = null;
        try {
            body = parseBody(bytes);
        } catch {
            // no JSON body - the status alone is the message
        }
        return httpFailure(status, body);
    }
    try {
        const raw = parseBody(bytes);
        return {ok: true, cards: normalizeUsage(raw), extraUsage: normalizeExtraUsage(raw), raw};
    } catch (e) {
        return {ok: false, code: 'parse_error', message: e.message};
    }
}
