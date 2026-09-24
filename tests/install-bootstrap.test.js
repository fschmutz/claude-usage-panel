// docs/install - the curl | bash one-liner - lands on the newest RELEASED tag,
// never on whatever the default branch has grown since. It used to clone main
// and exec its install.sh, so every new user ran unreleased commits stamped
// with the previous release's version, and the daily update called that
// "up to date".
//
// Offline: the "GitHub" remote is a local bare repo, and install.sh in it is a
// stand-in that records the checkout it was run from.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {run} from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOOTSTRAP = path.join(ROOT, 'docs', 'install');

// The developer's global git config (a push-confirm hook, a template) must
// not reach into the throwaway repos.
const GIT_ENV = {...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null'};

function remote(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-boot-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    const origin = path.join(dir, 'origin.git');
    const seed = path.join(dir, 'seed');
    const git = (cwd, ...args) =>
        execFileSync('git', ['-C', cwd, ...args], {stdio: 'pipe', encoding: 'utf8', env: GIT_ENV}).trim();
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], {stdio: 'pipe', env: GIT_ENV});
    execFileSync('git', ['init', '-q', '-b', 'main', seed], {stdio: 'pipe', env: GIT_ENV});
    git(seed, 'config', 'user.email', 'test@example.com');
    git(seed, 'config', 'user.name', 'test');
    git(seed, 'remote', 'add', 'origin', origin);
    fs.writeFileSync(path.join(seed, 'install.sh'),
        '#!/usr/bin/env bash\ngit -C "$(dirname "$0")" rev-parse HEAD >"$HOME/installed-from"\n');
    fs.chmodSync(path.join(seed, 'install.sh'), 0o755);

    /** A commit on main, tagged when `tag` is given, pushed to the remote. */
    const release = (label, tag) => {
        fs.writeFileSync(path.join(seed, 'package.json'), JSON.stringify({version: label}) + '\n');
        fs.appendFileSync(path.join(seed, 'commits'), `${label}\n`); // never an empty commit
        git(seed, 'add', '-A');
        git(seed, 'commit', '-qm', label);
        if (tag) git(seed, 'tag', tag);
        git(seed, 'push', '-q', 'origin', 'main', '--tags');
        return git(seed, 'rev-parse', 'HEAD');
    };
    const checkout = path.join(dir, 'home', 'checkout');
    const bootstrap = () => {
        fs.mkdirSync(path.join(dir, 'home'), {recursive: true});
        return run('bash', [BOOTSTRAP], {
            env: {
                ...GIT_ENV,
                HOME: path.join(dir, 'home'),
                CLAUDE_USAGE_PANEL_REPO: origin,
                CLAUDE_USAGE_PANEL_HOME: checkout,
            },
        });
    };
    const installedFrom = () => fs.readFileSync(path.join(dir, 'home', 'installed-from'), 'utf8').trim();
    return {release, bootstrap, installedFrom, checkout, git};
}

test('a fresh install lands on the newest release tag, not on main', (t) => {
    const r = remote(t);
    r.release('1.9.0', 'v1.9.0');
    const v110 = r.release('1.10.0', 'v1.10.0'); // numeric order: 1.10 > 1.9
    r.release('1.10.0', 'v1.11.0-rc1'); // prereleases never qualify
    r.release('1.10.0'); // unreleased work on main

    const out = r.bootstrap();
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.match(out.stdout, /Installing release v1\.10\.0/);
    assert.equal(r.installedFrom(), v110);
    // On a branch that tracks origin: auto-update.sh refuses a detached HEAD
    // and fast-forwards the branch to each later tag.
    assert.equal(r.git(r.checkout, 'symbolic-ref', '--short', 'HEAD'), 'main');
    assert.equal(r.git(r.checkout, 'rev-parse', '--abbrev-ref', '@{u}'), 'origin/main');
});

test('a re-run fast-forwards to a newer tag, and never moves a checkout backwards', (t) => {
    const r = remote(t);
    r.release('1.0.0', 'v1.0.0');
    assert.equal(r.bootstrap().status, 0);
    r.release('1.0.0'); // unreleased
    const v11 = r.release('1.1.0', 'v1.1.0');
    r.release('1.1.0'); // unreleased again

    const out = r.bootstrap();
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.equal(r.installedFrom(), v11);

    // A checkout already past the newest tag (it once tracked main) is left
    // exactly where it is.
    r.git(r.checkout, 'merge', '--ff-only', '-q', 'origin/main');
    const ahead = r.git(r.checkout, 'rev-parse', 'HEAD');
    const again = r.bootstrap();
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.match(again.stdout, /already at or past release v1\.1\.0/);
    assert.equal(r.installedFrom(), ahead);
});

test('a repository with no release yet installs its default branch', (t) => {
    const r = remote(t);
    const tip = r.release('0.1.0');
    const out = r.bootstrap();
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.match(out.stdout, /No release tag found/);
    assert.equal(r.installedFrom(), tip);
});
