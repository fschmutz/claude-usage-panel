// Data layer: query the official usage endpoint with the live Claude Code
// token (lib/claudeFiles.js - the one reader the account store uses too), or
// with a saved account's token. Read-only: nothing here writes.

import Soup from 'gi://Soup';

import Gettext from 'gettext';

import {readAccessToken} from './claudeFiles.js';
import {parseBody, send} from './http.js';
import {usageFailure, normalizeUsage, normalizeExtraUsage} from './pure.js';

// The prefs process loads this file too (through lib/accounts.js), and it
// cannot import the Shell's extension.js, so the catalog is named directly -
// the domain metadata.json declares, bound in both processes at enable.
const {gettext: _} = Gettext.domain('claude-usage-panel');

const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA_HEADER = 'oauth-2025-04-20';

/** The raw Retry-After header of an answered message, or null. */
function retryAfterHeader(message) {
    try {
        return message.get_response_headers()?.get_one('Retry-After') ?? null;
    } catch {
        return null;
    }
}

/**
 * Fetch usage from the endpoint. `token` defaults to the live login's; a
 * saved account's token (lib/accounts.js) reads that account's usage instead.
 * @returns {Promise<{ok: true, cards: object[], extraUsage: ?object, raw: object}
 *                   | {ok: false, code: string, message: string}>}
 */
export async function fetchUsage(session, token = readAccessToken(), {label = null} = {}) {
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
        // The request never completed (offline, DNS, timeout): retryable, so
        // the last good reading stays up (isRetryableFailure).
        return {ok: false, code: 'network_error', signInAgain: false, retryable: true, message: e.message};
    }
    if (status < 200 || status >= 300) {
        let body = null;
        try {
            body = parseBody(bytes);
        } catch {
            // no JSON body - the status alone is the message
        }
        const failure = usageFailure(status, body, {label, retryAfter: retryAfterHeader(message)});
        // One shared rule for what the status MEANS (usageFailure), but the
        // sentence the panel shows is translated - the contract's English
        // default belongs to the terminal clients.
        return failure.signInAgain && !label
            ? {
                ...failure,
                message: _('Claude session expired. Run any Claude Code command to refresh.'),
            }
            : failure;
    }
    try {
        const raw = parseBody(bytes);
        return {ok: true, cards: normalizeUsage(raw), extraUsage: normalizeExtraUsage(raw), raw};
    } catch (e) {
        return {ok: false, code: 'parse_error', message: e.message};
    }
}
