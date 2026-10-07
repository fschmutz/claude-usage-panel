// scripts/setup-tap-app.sh end to end against a stubbed gh: the App manifest
// conversion, the variable and the secret it stores, the resume path when an
// App is already stored, and the tap-check run that proves the credentials in
// CI. No browser opens and nothing reaches GitHub.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {run, stubbedHome} from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'setup-tap-app.sh');
const hasJq = ['/usr/bin', '/bin', '/usr/local/bin', '/opt/homebrew/bin']
    .some((d) => fs.existsSync(path.join(d, 'jq')));
const PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIfake\n-----END RSA PRIVATE KEY-----\n';

function stub(home, name, body) {
    const f = path.join(home, 'bin', name);
    fs.writeFileSync(f, `#!/bin/sh\n${body}`);
    fs.chmodSync(f, 0o755);
}

// gh as GitHub would answer: `stored` is the TAP_APP_CLIENT_ID already on the
// repo ('' = none), `checkWorkflow` whether tap-check.yml is on main, `checkOk`
// how its run ends. Run ids go 10 -> 11 once `workflow run` was called.
function world(t, {stored = '', checkWorkflow = true, checkOk = true} = {}) {
    const home = stubbedHome(t, {prefix: 'cup-tapapp-'});
    fs.writeFileSync(path.join(home, 'conv.json'), JSON.stringify({
        id: 42, slug: 'fschmutz-tap-publisher', client_id: 'Iv23new', pem: PEM,
    }));
    stub(home, 'gh', `echo "gh $*" >>"$HOME/gh.log"
case "$1 $2" in
    "auth status") exit 0 ;;
    "variable get") [ -n "${stored}" ] && echo "${stored}" && exit 0; exit 1 ;;
    "api -X") cat "$HOME/conv.json" ;;
    "secret set") cat >"$HOME/secret.txt" ;;
    "workflow view") ${checkWorkflow ? 'exit 0' : 'exit 1'} ;;
    "workflow run") touch "$HOME/dispatched" ;;
    "run list") if [ -f "$HOME/dispatched" ]; then echo 11; else echo 10; fi ;;
    "run watch") ${checkOk ? 'exit 0' : 'exit 1'} ;;
esac
`);
    stub(home, 'xdg-open', 'exit 0\n');
    stub(home, 'open', 'exit 0\n');
    return home;
}

// stderr folded into stdout: run() drops stderr when the script exits 0
const go = (home, input = 'https://github.com/fschmutz/claude-usage-panel?code=abc123&state=x\n\n', ...args) =>
    run('bash', ['-c', 'bash "$0" "$@" 2>&1', SCRIPT, ...args], {
        input,
        env: {
            ...process.env, HOME: home, TMPDIR: home, TAP_CHECK_POLL_SECONDS: '0',
            PATH: `${path.join(home, 'bin')}:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin`,
        },
    });
const read = (home, f) => fs.readFileSync(path.join(home, f), 'utf8');

test('setup-tap-app: creates the App, stores its credentials, proves them with tap-check', {skip: !hasJq}, (t) => {
    const home = world(t);
    const r = go(home);
    assert.equal(r.status, 0, r.stdout);
    const gh = read(home, 'gh.log');
    assert.match(gh, /gh api -X POST app-manifests\/abc123\/conversions/, 'the code is cut out of the pasted URL');
    assert.match(gh, /gh variable set TAP_APP_CLIENT_ID --repo fschmutz\/claude-usage-panel --body Iv23new/);
    assert.equal(read(home, 'secret.txt').trim(), PEM.trim(), 'the key reaches the secret unchanged');
    assert.doesNotMatch(r.stdout, /PRIVATE KEY/, 'the key is never printed');
    assert.match(gh, /gh workflow run tap-check\.yml --repo fschmutz\/claude-usage-panel/);
    assert.match(gh, /gh run watch 11 --repo fschmutz\/claude-usage-panel --exit-status/, 'watches the run it started, not the last one');
    assert.match(r.stdout, /Verified: the stored App mints a token that reaches homebrew-tap/);
    assert.deepEqual(fs.readdirSync(home).filter((f) => f.startsWith('cup-tap-app.')), [], 'no key left behind');
});

test('setup-tap-app: an App already stored is reused - no second create, straight to install', {skip: !hasJq}, (t) => {
    const home = world(t, {stored: 'Iv23old'});
    const r = go(home, '\n');
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /App already stored on fschmutz\/claude-usage-panel \(client id Iv23old\) - reusing it/);
    const gh = read(home, 'gh.log');
    assert.doesNotMatch(gh, /app-manifests|variable set|secret set/);
    assert.match(r.stdout, /apps\/fschmutz-tap-publisher\/installations\/new/);
    assert.match(gh, /gh run watch 11 /);
});

test('setup-tap-app: --recreate makes a new App even when one is stored', {skip: !hasJq}, (t) => {
    const home = world(t, {stored: 'Iv23old'});
    const r = go(home, undefined, '--recreate');
    assert.equal(r.status, 0, r.stdout);
    assert.match(read(home, 'gh.log'), /gh variable set TAP_APP_CLIENT_ID --repo \S+ --body Iv23new/);
});

test('setup-tap-app: a failing tap-check fails the setup and says why', {skip: !hasJq}, (t) => {
    const home = world(t, {stored: 'Iv23old', checkOk: false});
    const r = go(home, '\n');
    assert.equal(r.status, 1);
    assert.match(r.stdout, /tap-check\.yml failed: the App is not installed on homebrew-tap or lacks contents:write/);
});

test('setup-tap-app: before tap-check.yml is merged it says how to run it later', {skip: !hasJq}, (t) => {
    const home = world(t, {stored: 'Iv23old', checkWorkflow: false});
    const r = go(home, '\n');
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /not on the default branch yet - after the merge run:\n\s+gh workflow run tap-check\.yml/);
    assert.doesNotMatch(read(home, 'gh.log'), /workflow run/);
});

test('setup-tap-app: no code pasted stops before anything is stored', {skip: !hasJq}, (t) => {
    const home = world(t);
    const r = go(home, '\n');
    assert.equal(r.status, 1);
    assert.match(r.stdout, /no code given/);
    assert.doesNotMatch(read(home, 'gh.log'), /secret set|variable set/);
});
