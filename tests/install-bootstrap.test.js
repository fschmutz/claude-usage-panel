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
        '#!/usr/bin/env bash\ngit -C "$(dirname "$0")" rev-parse HEAD >"$HOME/installed-from"\nprintf "%s\\n" "$@" >"$HOME/installed-args"\n');
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
    const bootstrap = (extra = {}, script = BOOTSTRAP, args = []) => {
        fs.mkdirSync(path.join(dir, 'home'), {recursive: true});
        // stderr folded into stdout: run() keeps stderr only on a failure.
        return run('bash', ['-c', 'exec bash "$0" "$@" 2>&1', script, ...args], {
            env: {
                ...GIT_ENV,
                HOME: path.join(dir, 'home'),
                CLAUDE_USAGE_PANEL_REPO: origin,
                CLAUDE_USAGE_PANEL_HOME: checkout,
                ...extra,
            },
        });
    };
    /** A stand-in for the GitHub Release lookup: `published` answer 0,
     *  `unknown` 2, any other version 1 (tagged, no Release). */
    const probe = ({published = [], unknown = []}) => {
        const file = path.join(dir, 'probe.sh');
        fs.writeFileSync(file, `#!/bin/sh
case " ${published.join(' ')} " in *" $1 "*) exit 0 ;; esac
case " ${unknown.join(' ')} " in *" $1 "*) exit 2 ;; esac
exit 1
`, {mode: 0o755});
        return {CUP_RELEASE_PROBE: file};
    };
    const installedFrom = () => fs.readFileSync(path.join(dir, 'home', 'installed-from'), 'utf8').trim();
    return {dir, release, bootstrap, probe, installedFrom, checkout, git};
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

// ── A tag is a release only once its GitHub Release exists ─────────────────────
test('a tag without a published Release is skipped for the newest released one', (t) => {
    const r = remote(t);
    const v19 = r.release('1.9.0', 'v1.9.0');
    r.release('1.10.0', 'v1.10.0'); // tagged, release.yml refused it
    const out = r.bootstrap(r.probe({published: ['1.9.0']}));
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.match(out.stdout, /v1\.10\.0 is tagged but has no published release - skipped/);
    assert.match(out.stdout, /Installing release v1\.9\.0/);
    assert.equal(r.installedFrom(), v19);
});

test('GitHub unreachable: the highest tag is installed, and it says so', (t) => {
    const r = remote(t);
    r.release('1.9.0', 'v1.9.0');
    const v110 = r.release('1.10.0', 'v1.10.0');
    const out = r.bootstrap(r.probe({unknown: ['1.10.0', '1.9.0']}));
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.match(out.stdout, /Could not confirm a published release .* v1\.10\.0, unconfirmed/);
    assert.equal(r.installedFrom(), v110);
});

test('tags but no published Release yet: nothing is installed, main neither', (t) => {
    const r = remote(t);
    r.release('1.9.0', 'v1.9.0');
    r.release('1.9.0'); // unreleased main
    const out = r.bootstrap(r.probe({}));
    assert.equal(out.status, 1, out.stdout + out.stderr);
    assert.match(out.stdout, /no tagged version has a published release yet/);
    assert.equal(fs.existsSync(path.join(r.dir, 'home', 'installed-from')), false);
});

test('docs/install and scripts/lib.sh carry the same release probe, byte for byte', () => {
    const block = (file) => {
        const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
        const m = /^# >>> release_published[\s\S]*^# <<< release_published$/m.exec(src);
        assert.ok(m, `${file} has no release_published block`);
        return m[0];
    };
    assert.equal(block('docs/install'), block('scripts/lib.sh'));
});

// curl | bash runs what arrived so far: a download cut anywhere must run
// nothing. Everything lives in main(), called on the last line, which ends in
// a marker main() requires: `main` alone would install, minus the arguments.
test('a truncated download runs nothing, wherever it was cut', (t) => {
    const r = remote(t);
    r.release('1.0.0', 'v1.0.0');
    const src = fs.readFileSync(BOOTSTRAP, 'utf8');
    const cut = path.join(r.dir, 'cut');
    const cuts = [];
    for (let i = src.indexOf('\n'); i !== -1 && i < src.length - 1; i = src.indexOf('\n', i + 1)) cuts.push(i + 1);
    // every byte of the last line (dropping only its newline leaves the whole
    // program)
    const last = src.lastIndexOf('\n', src.length - 2) + 1;
    for (let at = last + 1; at < src.length - 1; at++) cuts.push(at);
    for (const at of cuts) {
        fs.writeFileSync(cut, src.slice(0, at));
        r.bootstrap({}, cut);
        assert.equal(fs.existsSync(r.checkout), false, `cut at byte ${at} cloned`);
    }
    const whole = r.bootstrap({}, BOOTSTRAP, ['statusline', 'mcp']);
    assert.equal(whole.status, 0, whole.stdout);
    assert.equal(fs.readFileSync(path.join(r.dir, 'home', 'installed-args'), 'utf8'), 'statusline\nmcp\n',
        'the user\'s arguments reach install.sh, the marker does not');
});
