// scripts/auto-update.sh trusts exactly one thing: the verified release tag.
// It fetches that one tag (never `--tags --force`, which followed any tag
// re-pointed upstream), never falls back to the branch tip when the tag
// cannot be had, refuses a tag whose object id moved since it was known, and
// with an allowed-signers file in its state dir requires an SSH signature by
// one of its keys. Plus the macOS notification, whose text travels as argv.
//
// Offline: the remote is a local bare repo, the keys are made on the spot.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {run} from './helpers.js';
import {SCRIPT, env, makeCheckout, runScript} from './update-world.js';

const stateDir = (c) => path.join(c.dir, 'state', 'claude-usage-panel');
const installs = (c) => {
    try {
        return fs.readFileSync(path.join(c.dir, 'install-calls.log'), 'utf8').trim().split('\n');
    } catch {
        return [];
    }
};

/** Cut v<version> upstream on a new commit; `sign` signs the tag with a key. */
function cut(c, version, {sign} = {}) {
    const pkg = path.join(c.seed, 'package.json');
    const cur = JSON.parse(fs.readFileSync(pkg, 'utf8')).version;
    fs.writeFileSync(pkg, fs.readFileSync(pkg, 'utf8').replace(cur, version));
    c.git(c.seed, 'commit', '-qam', `chore(release): v${version}`);
    const tag = sign
        ? ['-c', 'gpg.format=ssh', '-c', `user.signingkey=${sign}`, 'tag', '-s', '-m', `v${version}`, `v${version}`]
        : ['tag', `v${version}`];
    c.git(c.seed, ...tag);
    c.git(c.seed, 'push', '-q', 'origin', 'main', '--tags');
    return c.git(c.seed, 'rev-parse', `v${version}`).trim();
}

/** Re-point v<version> upstream at a new commit, as a hostile push would. */
function movetag(c, version) {
    fs.writeFileSync(path.join(c.seed, 'evil.txt'), 'not the release\n');
    c.git(c.seed, 'add', '-A');
    c.git(c.seed, 'commit', '-qm', 'evil');
    c.git(c.seed, 'tag', '-f', `v${version}`);
    c.git(c.seed, 'push', '-q', 'origin', 'main');
    c.git(c.seed, 'push', '-q', '--force', 'origin', `refs/tags/v${version}`);
}

test('a release tag that cannot be fetched is a skip, never a fall back to the branch tip', (t) => {
    const c = makeCheckout(t, {localVersion: '1.5.0', tags: ['v1.5.0']});
    cut(c, '1.6.0');
    fs.writeFileSync(path.join(c.seed, 'unreleased.txt'), 'main only\n');
    c.git(c.seed, 'add', '-A');
    c.git(c.seed, 'commit', '-qm', 'feat: unreleased');
    c.git(c.seed, 'push', '-q', 'origin', 'main');
    // A git that lists the tag but cannot fetch it (a flaky link, a tag
    // deleted between the lookup and the fetch).
    const bin = path.join(c.dir, 'gitbin');
    fs.mkdirSync(bin);
    const realGit = ['/usr/bin/git', '/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git'].find(fs.existsSync);
    fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh
case " $* " in *" fetch "*"refs/tags/v1.6.0"*) exit 1 ;; esac
exec ${realGit} "$@"
`, {mode: 0o755});
    const head = c.git(c.work, 'rev-parse', 'HEAD');
    const r = run('bash', [path.join(c.work, 'scripts', 'auto-update.sh')], {
        env: {...env(c.dir), PATH: `${bin}:${process.env.PATH}`}, cwd: c.work,
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /skip: could not fetch v1\.6\.0 from origin/);
    assert.equal(c.git(c.work, 'rev-parse', 'HEAD'), head, 'the checkout did not move to main');
    assert.equal(fs.existsSync(path.join(c.work, 'unreleased.txt')), false);
    assert.deepEqual(installs(c), []);
});

test('a release tag re-pointed upstream is refused against the checkout\'s own tag', (t) => {
    const c = makeCheckout(t, {localVersion: '1.5.0', tags: ['v1.5.0', 'v1.6.0']});
    // The clone holds v1.6.0 on the seed commit; upstream moves it.
    movetag(c, '1.6.0');
    const head = c.git(c.work, 'rev-parse', 'HEAD');
    const r = runScript(c, []);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /REFUSED: v1\.6\.0 on origin is [0-9a-f]+, but this checkout has v1\.6\.0 at [0-9a-f]+ - a release tag was moved/);
    assert.equal(c.git(c.work, 'rev-parse', 'HEAD'), head);
    assert.deepEqual(installs(c), []);
    assert.match(fs.readFileSync(path.join(stateDir(c), 'auto-update.log'), 'utf8'), /REFUSED/);
});

test('a release tag that moved since it was installed is refused, even with the local tag gone', (t) => {
    const c = makeCheckout(t, {localVersion: '1.5.0', tags: ['v1.5.0']});
    const id = cut(c, '1.6.0');
    assert.equal(runScript(c, []).status, 0);
    assert.match(fs.readFileSync(path.join(stateDir(c), 'release-tags'), 'utf8'), new RegExp(`^v1\\.6\\.0 ${id}$`, 'm'));

    movetag(c, '1.6.0');
    c.git(c.work, 'tag', '-d', 'v1.6.0');
    const head = c.git(c.work, 'rev-parse', 'HEAD');
    const r = runScript(c, ['--force']);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`REFUSED: v1\\.6\\.0 on origin is [0-9a-f]+, but ${id} was installed as v1\\.6\\.0`));
    assert.equal(c.git(c.work, 'rev-parse', 'HEAD'), head);
    assert.equal(installs(c).length, 1, 'no second install');
});

// ── Optional signature check ──────────────────────────────────────────────────
const sshKeygen = ['/usr/bin/ssh-keygen', '/bin/ssh-keygen', '/usr/local/bin/ssh-keygen', '/opt/homebrew/bin/ssh-keygen']
    .find(fs.existsSync);

function key(c, name) {
    const file = path.join(c.dir, name);
    execFileSync(sshKeygen, ['-q', '-t', 'ed25519', '-N', '', '-C', name, '-f', file], {stdio: 'pipe'});
    return file;
}

/** The state dir's allowed-signers file, trusting `keyFile`'s public half. */
function allow(c, keyFile) {
    fs.mkdirSync(stateDir(c), {recursive: true});
    const pub = fs.readFileSync(`${keyFile}.pub`, 'utf8').trim().split(' ').slice(0, 2).join(' ');
    fs.writeFileSync(path.join(stateDir(c), 'allowed-signers'), `release@example.com namespaces="git" ${pub}\n`);
}

test('with allowed-signers: a tag signed by an allowed key installs', {skip: !sshKeygen && 'no ssh-keygen'}, (t) => {
    const c = makeCheckout(t, {localVersion: '1.5.0', tags: ['v1.5.0']});
    const k = key(c, 'release');
    allow(c, k);
    cut(c, '1.6.0', {sign: k});
    const r = runScript(c, []);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /updated to v1\.6\.0/);
});

test('with allowed-signers: an unsigned tag, or one signed by another key, is refused', {skip: !sshKeygen && 'no ssh-keygen'}, (t) => {
    const c = makeCheckout(t, {localVersion: '1.5.0', tags: ['v1.5.0']});
    allow(c, key(c, 'release'));
    cut(c, '1.6.0');
    const unsigned = runScript(c, []);
    assert.equal(unsigned.status, 1, unsigned.stdout + unsigned.stderr);
    assert.match(unsigned.stdout, /REFUSED: v1\.6\.0 is not signed by a key in .*allowed-signers/);
    assert.equal(c.git(c.work, 'tag', '-l', 'v1.6.0'), '', 'an unverified tag is not even kept');

    cut(c, '1.7.0', {sign: key(c, 'intruder')});
    const foreign = runScript(c, []);
    assert.equal(foreign.status, 1, foreign.stdout + foreign.stderr);
    assert.match(foreign.stdout, /REFUSED: v1\.7\.0 is not signed/);
    assert.deepEqual(installs(c), []);
});

test('without allowed-signers an unsigned tag installs as before', (t) => {
    const c = makeCheckout(t, {localVersion: '1.5.0', tags: ['v1.5.0']});
    cut(c, '1.6.0');
    assert.equal(fs.existsSync(path.join(stateDir(c), 'allowed-signers')), false);
    const r = runScript(c, []);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /updated to v1\.6\.0/);
});

// ── macOS notification ────────────────────────────────────────────────────────
test('the osascript notification passes its text as argv, never as AppleScript source', (t) => {
    const c = makeCheckout(t, {localVersion: '1.5.0', tags: []});
    const bin = path.join(c.dir, 'osabin');
    fs.mkdirSync(bin);
    const out = path.join(c.dir, 'osascript-argv');
    // PATH holds only this stub: no notify-send, so the macOS branch runs.
    fs.writeFileSync(path.join(bin, 'osascript'), `#!/bin/sh\nprintf '%s\\n' "$@" >"${out}"\n`, {mode: 0o755});
    const fn = /^notify\(\) \{[\s\S]*?^\}$/m.exec(fs.readFileSync(SCRIPT, 'utf8'))[0];
    const body = 'v1" & do shell script "touch /tmp/pwned" & "\\';
    const r = run('bash', ['-c', `${fn}\nnotify "$1" "$2"`, '_', 'Title "x"', body], {env: {PATH: bin}});
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(fs.readFileSync(out, 'utf8').split('\n').slice(0, -1), [
        '-e', 'on run argv',
        '-e', 'display notification (item 2 of argv) with title (item 3 of argv)',
        '-e', 'end run',
        'notify', body, 'Title "x"',
    ]);
});
