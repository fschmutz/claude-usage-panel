// The auto-update test world, shared by tests/autoupdate.test.js and
// tests/autoupdate-trust.test.js: a throwaway checkout of a local bare
// "origin" (so the real `git ls-remote` / `fetch` / `merge --ff-only` paths
// run offline), the sandboxed env, and the worker runner.
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {run} from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SCRIPT = path.join(ROOT, 'scripts', 'auto-update.sh');
export const LIB = path.join(ROOT, 'scripts', 'lib.sh');

// Every git in here runs with the developer's own global and system config
// switched off. A machine-wide `core.hooksPath` (a pre-push confirm guard, for
// one) otherwise reaches into these throwaway repos and fails the seed push,
// so the suite would pass in CI and on a fresh clone while going red on the
// one machine that has the guard installed.
export const GIT_ENV = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
};

// ── A throwaway checkout wired to a local bare "origin" ─────────────────────────
// Layout mirrors the real repo closely enough for the script: package.json at
// the root, scripts/auto-update.sh, and an install.sh it can invoke.
export function makeCheckout(t, {localVersion, tags}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-au-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    const origin = path.join(dir, 'origin.git');
    const work = path.join(dir, 'work');
    const seed = path.join(dir, 'seed');
    const git = (cwd, ...args) =>
        execFileSync('git', ['-C', cwd, ...args], {stdio: 'pipe', encoding: 'utf8', env: GIT_ENV});

    execFileSync('git', ['init', '--bare', '-b', 'main', origin], {stdio: 'pipe', env: GIT_ENV});
    execFileSync('git', ['init', '-b', 'main', seed], {stdio: 'pipe', env: GIT_ENV});
    git(seed, 'config', 'user.email', 'test@example.com');
    git(seed, 'config', 'user.name', 'test');

    const writeRepo = (root, version) => {
        fs.mkdirSync(path.join(root, 'scripts'), {recursive: true});
        fs.writeFileSync(
            path.join(root, 'package.json'),
            JSON.stringify({name: 'claude-usage-panel', version}, null, 2) + '\n',
        );
        // The worker sources lib.sh from its own directory, so the copy
        // travels with it - exactly as install.sh gnome / pack-gnome.sh ship it.
        fs.copyFileSync(SCRIPT, path.join(root, 'scripts', 'auto-update.sh'));
        fs.copyFileSync(LIB, path.join(root, 'scripts', 'lib.sh'));
        fs.chmodSync(path.join(root, 'scripts', 'auto-update.sh'), 0o755);
        // Stand-in for the real installer: records that it ran, and fails when
        // $HOME/install-exit says so (a partial install - no node on the
        // scheduler's PATH, /Applications not writable). Both the log and the
        // switch live outside the checkout, so neither can dirty the worktree,
        // which the worker would then refuse to touch.
        fs.writeFileSync(
            path.join(root, 'install.sh'),
            '#!/usr/bin/env bash\necho "install.sh $*" >>"$HOME/install-calls.log"\n'
                + 'exit "$(cat "$HOME/install-exit" 2>/dev/null || echo 0)"\n',
        );
        fs.chmodSync(path.join(root, 'install.sh'), 0o755);
    };

    writeRepo(seed, localVersion);
    git(seed, 'add', '-A');
    git(seed, 'commit', '-qm', 'seed');
    git(seed, 'remote', 'add', 'origin', origin);
    git(seed, 'push', '-q', 'origin', 'main');
    for (const tag of tags ?? []) {
        git(seed, 'tag', tag);
    }
    if (tags?.length) git(seed, 'push', '-q', 'origin', '--tags');

    execFileSync('git', ['clone', '-q', origin, work], {stdio: 'pipe', env: GIT_ENV});
    return {dir, origin, work, seed, git};
}

// The script keeps its state under XDG_STATE_HOME - point it at the sandbox so
// tests never touch the real ~/.local/state.
export const env = (dir) => ({
    ...GIT_ENV,
    XDG_STATE_HOME: path.join(dir, 'state'),
    // Sandboxed too: the script reads the installed systemd unit from here to
    // find the checkout, and must not see the developer's real one.
    XDG_CONFIG_HOME: path.join(dir, 'config'),
    HOME: dir,
});

export const runScript = (c, args) =>
    run('bash', [path.join(c.work, 'scripts', 'auto-update.sh'), ...args], {
        env: env(c.dir),
        cwd: c.work,
    });
