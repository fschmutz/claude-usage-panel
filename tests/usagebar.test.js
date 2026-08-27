// linux/usage-bar.mjs - the waybar / tmux / polybar surface. Driven through
// CUP_TEST_USAGE_JSON so the suite never touches the network.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BAR = path.join(here, '..', 'linux', 'usage-bar.mjs');

const CARDS = JSON.stringify({
    ok: true,
    cards: [
        {key: 'session', label: 'Current session', group: 'session', percent: 16, severity: 'normal', resetsAt: null, active: true},
        {key: 'weekly_all', label: 'Weekly · all models', group: 'weekly', percent: 91, severity: 'critical', resetsAt: null, active: false},
    ],
});

const run = (args, usage = CARDS) =>
    execFileSync('node', [BAR, ...args], {
        encoding: 'utf8',
        env: {...process.env, CUP_TEST_USAGE_JSON: usage},
    }).trim();

test('text format shows the session limit by default', () => {
    assert.equal(run([]), 'S 16%');
});

test('--limit weekly selects the weekly card', () => {
    assert.equal(run(['--limit', 'weekly']), 'W 91%');
});

test('--limit all shows every card', () => {
    assert.equal(run(['--limit', 'all']), 'S 16% · W 91%');
});

test('waybar format emits the fields waybar consumes', () => {
    const o = JSON.parse(run(['--format', 'waybar', '--limit', 'all']));
    assert.equal(o.text, 'S 16% · W 91%');
    // waybar styles on class and can draw a bar from percentage; both must be
    // the WORST card, not the first one.
    assert.equal(o.class, 'critical');
    assert.equal(o.percentage, 91);
    assert.match(o.tooltip, /Current session/);
});

test('tmux format carries per-severity colour tags', () => {
    const out = run(['--format', 'tmux', '--limit', 'all']);
    assert.match(out, /#\[fg=colour245\]S 16%#\[default\]/);
    assert.match(out, /#\[fg=colour203\]W 91%#\[default\]/);
});

// A status bar must never print a stack trace or block on a bad response.
// A real HTTP 429 is what surfaced this path.
test('an endpoint error degrades quietly, never non-zero', () => {
    const bad = JSON.stringify({ok: false, code: 'http_error', message: 'HTTP 429'});
    assert.equal(run([], bad), '--');
    const o = JSON.parse(run(['--format', 'waybar'], bad));
    assert.equal(o.text, '--');
    assert.equal(o.class, 'off');
});

test('no matching limit degrades quietly too', () => {
    const empty = JSON.stringify({ok: true, cards: []});
    assert.equal(run([], empty), '--');
});
