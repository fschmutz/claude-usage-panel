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

// A guard about what the CODE does must not be tripped by a comment saying
// what it deliberately does not do. Line comments only: this repo has no block
// comments in Swift, and stripping those properly would need a real lexer.
const code = ({text}) => text.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');

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

// The Claude vault refreshes what it holds; it may not write the credentials
// Claude Code is running on. AccountStore has exactly one credentials write
// (installLogin, via writeLiveCredentials) - a second one anywhere is the bug
// this guards.
test('the account store writes a live login in one place', () => {
    const text = code(sources.find(s => s.file === 'AccountStore.swift'));
    assert.equal((text.match(/try writeLiveCredentials\(/g) ?? []).length, 1);
});
