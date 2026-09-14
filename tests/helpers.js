// Shared test scaffolding: run a command without throwing on a non-zero exit
// (the shell scripts use exit codes as their API), and build a throwaway HOME
// so no test ever reads or writes the developer's real ~/.claude.
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** {status, stdout, stderr} for any exit code; stderr is captured, not leaked
 *  into the runner's own output. */
export function run(cmd, args, opts = {}) {
    try {
        const stdout = execFileSync(cmd, args, {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            ...opts,
        });
        return {status: 0, stdout, stderr: ''};
    } catch (e) {
        return {status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? ''};
    }
}

/**
 * A fresh HOME under the OS tmp dir, removed when the test ends when `t` is
 * given. Returns the io shape the Node clients take (homedir, env, platform,
 * tmpdir all pointing inside the sandbox) with `home` alongside.
 */
export function sandboxHome(t, {prefix = 'cup-'} = {}) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    if (t) t.after(() => fs.rmSync(home, {recursive: true, force: true}));
    return {home, homedir: home, env: {}, platform: 'linux', tmpdir: home};
}

/** Write a live Claude Code login into a sandbox HOME. */
export function writeLiveLogin(home, credentials, oauthAccount, extraConfig = {}) {
    fs.mkdirSync(path.join(home, '.claude'), {recursive: true});
    fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify(credentials));
    if (oauthAccount) {
        fs.writeFileSync(path.join(home, '.claude.json'),
            JSON.stringify({oauthAccount, ...extraConfig}));
    }
}
