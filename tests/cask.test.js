// Casks/claude-usage-panel.rb against the sources it describes: the macOS
// minimum, the bundle id, the launchd agent the app writes, and what the
// header says about the checksum.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

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
