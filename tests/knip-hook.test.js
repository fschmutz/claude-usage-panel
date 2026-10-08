// scripts/knip.sh before knip is installed - the first commit on a fresh
// checkout, and every CI run: the install path must run, not die on the
// version probe. npm is a stub, so nothing is downloaded.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {run, stubbedHome} from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A copy of the hook and its pin, with no node_modules, and an npm that fails.
function fresh(t) {
    const home = stubbedHome(t, {prefix: 'cup-knip-'});
    const repo = path.join(home, 'repo');
    fs.mkdirSync(path.join(repo, 'scripts'), {recursive: true});
    fs.mkdirSync(path.join(repo, '.github', 'knip'), {recursive: true});
    fs.copyFileSync(path.join(ROOT, 'scripts', 'knip.sh'), path.join(repo, 'scripts', 'knip.sh'));
    fs.copyFileSync(path.join(ROOT, '.github', 'knip', 'package.json'),
        path.join(repo, '.github', 'knip', 'package.json'));
    fs.writeFileSync(path.join(home, 'bin', 'npm'), '#!/bin/sh\necho "npm $*" >>"$HOME/npm.log"\nexit 1\n');
    fs.chmodSync(path.join(home, 'bin', 'npm'), 0o755);
    const env = ci => ({HOME: home, PATH: `${path.join(home, 'bin')}:/usr/bin:/bin`, ...(ci && {CI: 'true'})});
    // stderr folded into stdout: run() drops stderr when the script exits 0
    const script = path.join(repo, 'scripts', 'knip.sh');
    return {home, sh: ci => run('bash', ['-c', 'bash "$0" 2>&1', script], {env: env(ci)})};
}

test('knip.sh: not installed yet means install it, with lifecycle scripts off', t => {
    const {home, sh} = fresh(t);
    sh(false);
    assert.match(fs.readFileSync(path.join(home, 'npm.log'), 'utf8'),
        /^npm ci --prefix \.github\/knip --ignore-scripts /m);
});

test('knip.sh: an install that fails skips loudly on a workstation and fails in CI', t => {
    const {sh} = fresh(t);
    const local = sh(false);
    assert.equal(local.status, 0);
    assert.match(local.stdout + local.stderr, /could not install knip \S+ \(offline\?\) - knip NOT run here/);
    const ci = sh(true);
    assert.equal(ci.status, 1);
    assert.match(ci.stdout + ci.stderr, /knip\.sh: could not install knip/);
});
