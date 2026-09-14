#!/usr/bin/env node
// One usage line for a Linux status bar: waybar, tmux, polybar, i3blocks, or
// anything that can run a command and print its stdout.
//
//   node linux/usage-bar.mjs                 plain text  "S 26% · W 24%"
//   node linux/usage-bar.mjs --format waybar JSON for waybar's custom module
//   node linux/usage-bar.mjs --format tmux   with #[fg=colour] severity tags
//   node linux/usage-bar.mjs --limit weekly  pick which limit to show
//
// GNOME gets an extension and macOS a menu-bar app; everyone else on Linux had
// nothing. This reads the live login through the same account store the MCP
// server uses - same endpoint, same normalization, same official `limits[]`
// numbers - so there is no second copy of the contract to keep in sync.
import {openStore} from '../claude-code/accounts.js';
import {resetHint} from '../claude-code/stamps.js';
import {flag} from '../scripts/lib/argv.mjs';

const argv = process.argv.slice(2);

if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(
        'usage-bar: one Claude usage line for a Linux status bar\n\n' +
            '  --format text|waybar|tmux   output shape (default text)\n' +
            '  --limit session|weekly|all  which limit (default session)\n',
    );
    process.exit(0);
}

const format = flag(argv, '--format', 'text');
const which = flag(argv, '--limit', 'session');

// Severity → colour, shared by both coloured formats.
const COLOURS = {normal: 'colour245', warning: 'colour214', critical: 'colour203'};

// `active` marks the window currently counting down, not "worth showing" - a
// weekly limit is active:false yet is exactly what a status bar wants. Filter by
// group only.
const pick = (cards) => {
    if (which === 'all') return cards;
    const want = which === 'weekly' ? 'weekly' : 'session';
    return cards.filter((c) => c.group === want);
};

const short = (c) => (c.group === 'weekly' ? 'W' : 'S');

// A status bar must never show a stack trace, and must never block the bar's
// render loop on a network hiccup. Any failure degrades to a quiet marker.
const fail = (msg) => {
    if (format === 'waybar') {
        process.stdout.write(
            JSON.stringify({text: '--', tooltip: `Claude usage unavailable: ${msg}`, class: 'off'}) +
                '\n',
        );
    } else {
        process.stdout.write('--\n');
    }
    process.exit(0);
};

// fetchLiveUsage already normalizes: it returns {ok, cards, raw}.
// CUP_TEST_USAGE_JSON is a unit-test hook, same idea as CUP_TEST_SCHEDULER in
// install.sh: it replaces the network call so tests never hit the endpoint
// (and never burn rate limit - a real HTTP 429 is what proved the fail-soft
// path below).
let result;
try {
    result = process.env.CUP_TEST_USAGE_JSON
        ? JSON.parse(process.env.CUP_TEST_USAGE_JSON)
        : await openStore().fetchLiveUsage();
} catch (e) {
    fail(e?.message ?? 'unknown error');
}
if (!result?.ok) fail('usage endpoint returned an error');

const cards = pick(result.cards ?? []);
if (!cards.length) fail('no matching limit');

const worst = cards.reduce((a, b) => (b.percent > a.percent ? b : a));

if (format === 'waybar') {
    process.stdout.write(
        JSON.stringify({
            text: cards.map((c) => `${short(c)} ${c.percent}%`).join(' · '),
            tooltip: cards
                .map((c) => `${c.label}: ${c.percent}%  ${resetHint(c.resetsAt)}`)
                .join('\n'),
            // waybar styles on class; severity is already computed for us.
            class: worst.severity,
            percentage: worst.percent,
        }) + '\n',
    );
} else if (format === 'tmux') {
    process.stdout.write(
        cards
            .map((c) => `#[fg=${COLOURS[c.severity] ?? COLOURS.normal}]${short(c)} ${c.percent}%#[default]`)
            .join(' ') + '\n',
    );
} else {
    process.stdout.write(cards.map((c) => `${short(c)} ${c.percent}%`).join(' · ') + '\n');
}
