// Casks/claude-usage-panel.rb against the sources it describes: the macOS
// minimum, the bundle id, the launchd agent the app writes, and what the
// header says about the checksum.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs, {readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {run} from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = rel => readFileSync(path.join(here, '..', rel), 'utf8');
const cask = read('Casks/claude-usage-panel.rb');
const header = cask.slice(0, cask.indexOf('cask "'));

// Homebrew's symbol for each macOS major the app could require.
const MACOS = {13: 'ventura', 14: 'sonoma', 15: 'sequoia', 26: 'tahoe'};

test('the cask requires the macOS the app is built for', () => {
    const pkg = read('macos/Package.swift').match(/\.macOS\(\.v(\d+)\)/);
    const plist = read('scripts/install/macos.sh').match(/LSMinimumSystemVersion<\/key><string>(\d+)/);
    assert.ok(pkg && plist, 'minimum found in Package.swift and the Info.plist template');
    assert.equal(pkg[1], plist[1]);
    assert.match(cask, new RegExp(`depends_on macos: ">= :${MACOS[pkg[1]]}"`));
});

test('uninstall quits the app and unloads its session-ping agent', () => {
    const bundleId = read('scripts/install/macos.sh').match(/CFBundleIdentifier<\/key><string>([^<]+)/)[1];
    const label = read('macos/Sources/ClaudeUsageCore/SessionPing.swift').match(/static let label = "([^"]+)"/)[1];
    const uninstall = cask.match(/^ {2}uninstall [\s\S]*?\n\n/m)?.[0] ?? '';
    assert.match(uninstall, new RegExp(`launchctl: "${label.replaceAll('.', '\\.')}"`));
    assert.match(uninstall, new RegExp(`quit: +"${bundleId.replaceAll('.', '\\.')}"`));
    assert.ok(cask.includes(`"~/Library/LaunchAgents/${label}.plist"`), 'zap removes the agent plist');
    assert.ok(cask.includes('"~/.local/state/claude-usage-panel/session-ping.log"'), 'zap removes the ping log');
});

test('zap never removes the shared state dir wholesale', () => {
    // install.sh (checkout-path, installed-version, update-pending) shares it.
    assert.doesNotMatch(cask, /"~\/\.local\/state\/claude-usage-panel\/?"/);
});

test('the header tells the truth about the checksum', () => {
    if (/^ {2}sha256 :no_check$/m.test(cask)) {
        assert.match(header, /unpinned template/);
        assert.match(header, /verifies nothing/);
        assert.doesNotMatch(header, /PREVIOUS release/);
    } else {
        assert.match(cask, /^ {2}sha256 "[0-9a-f]{64}"$/m);
    }
});

// The cask's version line has one parser, scripts/version-sites.sh, shared by
// bump-version and check-versions. A private sed in the release scripts drifts
// from it the day the cask layout changes.
test('make-cask and publish-cask read the cask version through version-sites.sh', () => {
    for (const script of ['scripts/make-cask.sh', 'scripts/publish-cask.sh']) {
        const src = read(script);
        assert.match(src, /version-sites\.sh"/, `${script} sources version-sites.sh`);
        assert.match(src, /version_site_read "\$(cask|CASK)" cask version/, `${script} reads via the helper`);
        assert.doesNotMatch(src, /\^ {2}version/, `${script} has no private cask version regex`);
    }
});

/** A throwaway checkout holding just what make-cask.sh touches. */
function caskRoot(t, versionLine) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-makecask-'));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.mkdirSync(path.join(root, 'Casks'));
    for (const f of ['scripts/make-cask.sh', 'scripts/version-sites.sh', 'package.json']) {
        fs.copyFileSync(path.join(here, '..', f), path.join(root, f));
    }
    const rb = path.join(root, 'Casks', 'claude-usage-panel.rb');
    fs.writeFileSync(rb, cask.replace(/^ {2}version "[^"]*"$/m, versionLine));
    fs.writeFileSync(path.join(root, 'app.zip'), 'not really a zip\n');
    const make = (...args) => run('bash', [path.join(root, 'scripts', 'make-cask.sh'), ...args]);
    return {rb, zip: path.join(root, 'app.zip'), make};
}

test('make-cask pins the version and checksum through the shared writer', (t) => {
    const {rb, zip, make} = caskRoot(t, '  version "0.0.1"');
    const r = make('v9.8.7', zip);
    assert.equal(r.status, 0, r.stderr);
    const out = fs.readFileSync(rb, 'utf8');
    assert.match(out, /^ {2}version "9\.8\.7"$/m);
    assert.match(out, /^ {2}sha256 "[0-9a-f]{64}"$/m);
});

test('make-cask refuses a non-version tag and a version line it cannot rewrite', (t) => {
    const good = caskRoot(t, '  version "0.0.1"');
    const before = fs.readFileSync(good.rb, 'utf8');
    const bad = good.make('nightly', good.zip);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /not a version: nightly/);
    assert.equal(fs.readFileSync(good.rb, 'utf8'), before, 'the cask is left as it was');

    // A layout the shared parser does not know: the old private perl rewrote
    // it anyway, so bump-version and check-versions would then disagree.
    const odd = caskRoot(t, '  version "latest"');
    const r = odd.make('v9.8.7', odd.zip);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /could not write v9\.8\.7/);
});
