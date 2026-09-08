// Data layer: read the local Claude Code OAuth token and query the official
// usage endpoint. Read-only - we never write back to the credentials file.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

import {normalizeUsage, normalizeExtraUsage} from './pure.js';

const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA_HEADER = 'oauth-2025-04-20';
const CREDENTIALS_PATH = `${GLib.get_home_dir()}/.claude/.credentials.json`;

export {normalizeUsage};

/**
 * Read the OAuth access token from ~/.claude/.credentials.json.
 * Returns the token string, or null when missing / unreadable.
 */
export function readAccessToken() {
    try {
        const file = Gio.File.new_for_path(CREDENTIALS_PATH);
        const [ok, contents] = file.load_contents(null);
        if (!ok)
            return null;

        const decoder = new TextDecoder('utf-8');
        const json = JSON.parse(decoder.decode(contents));
        const oauth = json.claudeAiOauth ?? json;
        return oauth.accessToken ?? oauth.access_token ?? oauth.token ?? null;
    } catch {
        return null;
    }
}

/**
 * Fetch usage from the endpoint.
 * @returns {Promise<{ok: true, cards: object[], raw: object}
 *                   | {ok: false, code: string, message: string}>}
 */
export function fetchUsage(session) {
    return new Promise(resolve => {
        const token = readAccessToken();
        if (!token) {
            resolve({
                ok: false,
                code: 'no_token',
                message: 'No Claude credentials found. Sign in with Claude Code.',
            });
            return;
        }

        const message = Soup.Message.new('GET', USAGE_ENDPOINT);
        message.request_headers.append('authorization', `Bearer ${token}`);
        message.request_headers.append('anthropic-beta', OAUTH_BETA_HEADER);

        session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (self, result) => {
            try {
                const bytes = self.send_and_read_finish(result);
                const status = message.get_status();
                if (status === 401 || status === 403) {
                    resolve({
                        ok: false,
                        code: 'auth_expired',
                        message: 'Claude session expired. Run any Claude Code command to refresh.',
                    });
                    return;
                }
                if (status < 200 || status >= 300) {
                    resolve({ok: false, code: 'http_error', message: `HTTP ${status}`});
                    return;
                }

                const decoder = new TextDecoder('utf-8');
                const raw = JSON.parse(decoder.decode(bytes.get_data()));
                resolve({ok: true, cards: normalizeUsage(raw),
                    extraUsage: normalizeExtraUsage(raw), raw});
            } catch (e) {
                resolve({ok: false, code: 'parse_error', message: e.message});
            }
        });
    });
}
