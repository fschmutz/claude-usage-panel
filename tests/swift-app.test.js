// Source guards for the macOS app target (macos/Sources/ClaudeUsagePanel),
// which only compiles on macOS: these read its sources so Linux CI still
// fails when a known-bad shape comes back.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'macos', 'Sources', 'ClaudeUsagePanel');
const sources = readdirSync(dir)
    .filter(f => f.endsWith('.swift'))
    .map(f => ({file: f, text: readFileSync(path.join(dir, f), 'utf8')}));

test('the app sources are found', () => {
    assert.ok(sources.length > 5);
});

// /usr/bin/git on a Mac without the Command Line Tools is the xcode-select
// shim, which opens the "install developer tools" dialog. The release check
// runs hourly in the install shapes that have no checkout (cask, release zip),
// so it reads the ref advertisement over HTTPS (ClaudeUsageCore/ReleaseTags).
test('the app never runs /usr/bin/git', () => {
    for (const {file, text} of sources)
        assert.doesNotMatch(text, /"\/usr\/bin\/git"/, file);
});

// Notification text (API model names, account emails) goes to osascript as
// run-handler arguments (ClaudeUsageCore/NotifyScript), never spliced into the
// AppleScript source where a backslash could end the string literal.
test('no AppleScript notification is built by string interpolation', () => {
    for (const {file, text} of sources)
        assert.doesNotMatch(text, /display notification \\"\\\(/, file);
});
