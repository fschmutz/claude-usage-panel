// scripts/setup-tap-app.sh end to end against stubs: gh records the variable
// and the secret, curl answers the installation lookup and the token mint.
// openssl is real, so the JWT the script signs is verified here against the
// App's public key. No browser opens and nothing reaches GitHub.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {run, stubbedHome} from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'setup-tap-app.sh');
const hasTools = ['jq', 'openssl'].every((t) => ['/usr/bin', '/bin', '/usr/local/bin', '/opt/homebrew/bin']
    .some((d) => fs.existsSync(path.join(d, t))));

function stub(home, name, body) {
    const f = path.join(home, 'bin', name);
    fs.writeFileSync(f, `#!/bin/sh\n${body}`);
    fs.chmodSync(f, 0o755);
}

function world(t, {selection = 'selected', contents = 'write'} = {}) {
    const home = stubbedHome(t, {prefix: 'cup-tapapp-'});
    const {privateKey, publicKey} = crypto.generateKeyPairSync('rsa', {modulusLength: 2048});
    const conv = {
        id: 42, slug: 'fschmutz-tap-publisher', client_id: 'Iv23abc',
        pem: privateKey.export({type: 'pkcs1', format: 'pem'}),
    };
    fs.writeFileSync(path.join(home, 'conv.json'), JSON.stringify(conv));
    stub(home, 'gh', `echo "gh $*" >>"$HOME/gh.log"
case "$1 $2" in
    "auth status") exit 0 ;;
    "api -X") cat "$HOME/conv.json" ;;
    "secret set") cat >"$HOME/secret.txt" ;;
esac
`);
    // headers arrive on stdin (-H @-): kept apart from argv to prove the split
    stub(home, 'curl', `echo "curl $*" >>"$HOME/curl-argv.log"
cat >>"$HOME/curl-headers.log"
case "$*" in
    *"/repos/fschmutz/homebrew-tap/installation"*) echo '{"id":7,"repository_selection":"${selection}"}' ;;
    *"/app/installations/7/access_tokens"*) echo '{"token":"ghs_minted","permissions":{"contents":"${contents}"}}' ;;
esac
`);
    stub(home, 'xdg-open', 'exit 0\n');
    stub(home, 'open', 'exit 0\n');
    return {home, conv, publicKey};
}

// stderr folded into stdout: run() drops stderr when the script exits 0
const go = (home, input = 'https://github.com/fschmutz/claude-usage-panel?code=abc123&state=x\n\n') =>
    run('bash', ['-c', 'bash "$0" 2>&1', SCRIPT], {
        input,
        env: {...process.env, HOME: home, TMPDIR: home, PATH: `${path.join(home, 'bin')}:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin`},
    });
const read = (home, f) => fs.readFileSync(path.join(home, f), 'utf8');

test('setup-tap-app: stores the App credentials and proves a tap token with contents:write', {skip: !hasTools}, (t) => {
    const {home, conv, publicKey} = world(t);
    const r = go(home);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Verified: a token minted for homebrew-tap carries contents:write/);
    const gh = read(home, 'gh.log');
    assert.match(gh, /gh api -X POST app-manifests\/abc123\/conversions/, 'the code is cut out of the pasted URL');
    assert.match(gh, /gh variable set TAP_APP_CLIENT_ID --repo fschmutz\/claude-usage-panel --body Iv23abc/);
    assert.match(gh, /gh secret set TAP_APP_PRIVATE_KEY --repo fschmutz\/claude-usage-panel/);
    assert.equal(read(home, 'secret.txt').trim(), conv.pem.trim(), 'the key reaches the secret unchanged');
    assert.doesNotMatch(r.stdout, /PRIVATE KEY/, 'the key is never printed');

    // The mint asks for the tap alone, contents:write, and is revoked after.
    const argv = read(home, 'curl-argv.log');
    assert.match(argv, /POST -H @- -d \{"repositories":\["homebrew-tap"\],"permissions":\{"contents":"write"\}\}/);
    assert.match(argv, /-X DELETE -H @- https:\/\/api\.github\.com\/installation\/token/);
    assert.doesNotMatch(argv, /Bearer|ghs_/, 'no JWT or token in argv');

    // The JWT is RS256, signed by the App key, issued to its client id.
    const jwt = read(home, 'curl-headers.log').match(/Authorization: Bearer (\S+)/)[1];
    const [h, p, s] = jwt.split('.');
    assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url')));
    const claims = JSON.parse(Buffer.from(p, 'base64url'));
    assert.equal(claims.iss, 'Iv23abc');
    assert.ok(claims.exp - claims.iat <= 600, 'GitHub refuses a JWT longer than 10 minutes');
    // Nothing of the key is left behind.
    assert.deepEqual(fs.readdirSync(home).filter((f) => f.startsWith('cup-tap-app.')), []);
});

test('setup-tap-app: an App installed everywhere is flagged, a read-only token fails', {skip: !hasTools}, (t) => {
    const all = world(t, {selection: 'all'});
    const r = go(all.home);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /installed on ALL your repositories - restrict it to homebrew-tap/);

    const ro = world(t, {contents: 'read'});
    const bad = go(ro.home);
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /no contents:write on homebrew-tap/);
});

test('setup-tap-app: no code pasted stops before anything is stored', {skip: !hasTools}, (t) => {
    const {home} = world(t);
    const r = go(home, '\n');
    assert.equal(r.status, 1);
    assert.doesNotMatch(fs.existsSync(path.join(home, 'gh.log')) ? read(home, 'gh.log') : '', /secret set|variable set/);
});
