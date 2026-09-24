// Shared scaffolding for the accounts-*.test.js files: the fixture, a
// throwaway HOME holding a live login, and a fake /usr/bin/security. Nothing
// here touches the real ~/.claude, state dir or Keychain.
import {Buffer} from 'node:buffer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {openStore} from '../claude-code/accounts.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIX = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'accounts.json'), 'utf8'));
export const NOW = FIX.now;
export const sha256Hex = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

export const creds = (tag, extra = {}) => ({claudeAiOauth: {
    accessToken: `at-${tag}`, refreshToken: `rt-${tag}`,
    expiresAt: NOW + 3_600_000, refreshTokenExpiresAt: NOW + 30 * 86_400_000,
    subscriptionType: 'max', ...extra,
}});
export const account = (tag) => ({accountUuid: `u-${tag}`, emailAddress: `${tag}@example.com`});

/** A fake HOME with a live login (or none) and an io context bound to it. */
export function world({live = 'pro', extraConfig = {}} = {}) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-accounts-'));
    fs.mkdirSync(path.join(home, '.claude'));
    if (live) {
        fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify(creds(live)));
        fs.writeFileSync(path.join(home, '.claude.json'),
            JSON.stringify({numStartups: 3, oauthAccount: account(live), ...extraConfig}));
    }
    const calls = [];
    const io = {
        homedir: home, platform: 'linux', env: {}, nowMs: NOW,
        exec: () => 'ps output with no claude in it\n',
        fetchImpl: async (url, init) => {
            calls.push({url, init});
            return {ok: true, status: 200, json: async () => ({
                access_token: 'at-fresh', refresh_token: 'rt-fresh', expires_in: 28800, scope: 'user:inference',
            })};
        },
    };
    return {home, io, calls, s: openStore(io)};
}

/**
 * /usr/bin/security as the store drives it: reads on argv, the write as a
 * `security -i` stdin line. Like the real tool, -i exits 0 even when its
 * command fails. Every argv is recorded, to prove no token ever sits in one.
 */
export function fakeSecurity(keychain, {denied = () => false, acct = 'me'} = {}) {
    const argvs = [];
    const exec = (cmd, args, opts = {}) => {
        if (cmd !== '/usr/bin/security') return '';
        argvs.push(args.join(' '));
        if (args[0] === '-i') {
            const m = /^add-generic-password -U -a "([^"]*)" -s "([^"]*)" -X ([0-9a-f]+)\n$/.exec(opts.input ?? '');
            if (m && !denied()) keychain.set(m[2], Buffer.from(m[3], 'hex').toString('utf8'));
            return '';
        }
        const service = args[args.indexOf('-s') + 1];
        if (!keychain.has(service)) throw new Error('not found');
        return args.includes('-w') ? `${keychain.get(service)}\n` : `"acct"<blob>="${acct}"\n`;
    };
    return {exec, argvs};
}
