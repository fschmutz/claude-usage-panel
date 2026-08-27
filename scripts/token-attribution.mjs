#!/usr/bin/env node
// Where did the tokens actually go?
//
//   node scripts/token-attribution.mjs                    this project, 7 days
//   node scripts/token-attribution.mjs --days 30 --all    every project
//   node scripts/token-attribution.mjs --json             machine-readable
//
// Totals tell you that you spent a lot. They never tell you on WHAT, which is
// the only version of this that changes behaviour. Each assistant turn is
// attributed to the work it was doing, by the tools it called:
//
//   exploration    reading and searching - Read, Grep, Glob, WebFetch
//   implementation writing - Edit, Write, NotebookEdit
//   verification   running things - Bash, tests
//   rework         editing a file this session has already edited
//   correction     the turn right after a tool call that errored
//   conversation   no tools at all
//
// Every number here is ESTIMATED: it is reconstructed from local session logs,
// not reported by Anthropic. The panel's limit percentages are the official
// ones; these are not, and the output says so.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const EXPLORE = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'NotebookRead']);
const IMPLEMENT = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
const VERIFY = new Set(['Bash', 'BashOutput', 'KillShell']);

export const BUCKETS = [
    'exploration',
    'implementation',
    'verification',
    'rework',
    'correction',
    'conversation',
];

/** Tokens billed for one assistant turn. Cache reads are excluded: they are
 *  charged at a fraction and counting them at face value inflates long sessions
 *  into meaninglessness. Cache CREATION is real write cost, so it stays. */
export function turnTokens(usage) {
    if (!usage) return 0;
    return (
        (usage.input_tokens ?? 0) +
        (usage.output_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0)
    );
}

/** Classify one assistant turn. `state` carries what earlier turns did, which
 *  is what makes rework and correction detectable at all. */
export function classifyTurn(tools, state) {
    if (state.lastTurnErrored) return 'correction';
    if (!tools.length) return 'conversation';

    const edited = tools.filter((t) => IMPLEMENT.has(t.name));
    for (const e of edited) {
        const file = e.input?.file_path ?? e.input?.notebook_path;
        if (file && state.editedFiles.has(file)) return 'rework';
    }
    if (edited.length) return 'implementation';
    if (tools.some((t) => EXPLORE.has(t.name))) return 'exploration';
    if (tools.some((t) => VERIFY.has(t.name))) return 'verification';
    return 'conversation';
}

/** Fold one session file into the totals. Exported for tests.
 *
 *  A logical turn is NOT one line. Claude Code writes each assistant block as
 *  its own entry - `thinking`, then `text`, then `tool_use` - so classifying
 *  line-by-line put every thinking and text block into `conversation` and
 *  reported 58% "conversation, 0% exploration" on real sessions. A turn is the
 *  run of consecutive assistant entries between two user entries, and it is
 *  classified by the tools used anywhere in that run.
 */
export function attributeSession(lines, totals) {
    const state = {editedFiles: new Set(), lastTurnErrored: false};
    let pendingTools = [];
    let pendingTokens = 0;
    let pendingOpen = false;

    const flush = () => {
        if (!pendingOpen) return;
        const bucket = classifyTurn(pendingTools, state);
        totals[bucket] = (totals[bucket] ?? 0) + pendingTokens;
        for (const t of pendingTools) {
            if (!IMPLEMENT.has(t.name)) continue;
            const file = t.input?.file_path ?? t.input?.notebook_path;
            if (file) state.editedFiles.add(file);
        }
        state.lastTurnErrored = false;
        pendingTools = [];
        pendingTokens = 0;
        pendingOpen = false;
    };

    for (const line of lines) {
        let e;
        try {
            e = JSON.parse(line);
        } catch {
            continue; // a partially-written last line is normal on a live session
        }
        if (e.type === 'user') {
            flush();
            // A tool result carrying an error means the next assistant turn is
            // spent recovering, not making progress.
            const content = e.message?.content;
            state.lastTurnErrored = Array.isArray(content)
                ? content.some((c) => c.type === 'tool_result' && c.is_error)
                : false;
            continue;
        }
        if (e.type !== 'assistant') continue;

        pendingOpen = true;
        pendingTokens += turnTokens(e.message?.usage);
        const content = Array.isArray(e.message?.content) ? e.message.content : [];
        for (const c of content) if (c.type === 'tool_use') pendingTools.push(c);
    }
    flush();
    return totals;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
// Guarded so importing this module (tests) does not run the report and exit.
function main() {
    const argv = process.argv.slice(2);
    const flag = (n, f = null) => {
        const i = argv.indexOf(n);
        return i >= 0 && argv[i + 1] ? argv[i + 1] : f;
    };
    if (argv.includes('-h') || argv.includes('--help')) {
        process.stdout.write(
            'token-attribution: where your Claude Code tokens went\n\n' +
                '  --days N     look back N days (default 7)\n' +
                '  --all        every project, not just this directory\n' +
                '  --project P  a specific project directory\n' +
                '  --json       machine-readable\n',
        );
        process.exit(0);
    }

    const days = Number(flag('--days', '7'));
    if (!Number.isFinite(days) || days <= 0) {
        process.stderr.write('token-attribution: --days wants a positive number\n');
        process.exit(2);
    }

    const root = path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(root)) {
        process.stderr.write(`token-attribution: no session logs at ${root}\n`);
        process.exit(1);
    }
    const slug = (p) => p.replace(/\//g, '-');
    const wanted = argv.includes('--all')
        ? null
        : slug(flag('--project', process.cwd()));

    const cutoff = Date.now() - days * 86400_000;
    const files = [];
    for (const dir of fs.readdirSync(root)) {
        if (wanted && dir !== wanted) continue;
        const full = path.join(root, dir);
        if (!fs.statSync(full).isDirectory()) continue;
        for (const f of fs.readdirSync(full)) {
            if (!f.endsWith('.jsonl')) continue;
            const fp = path.join(full, f);
            if (fs.statSync(fp).mtimeMs >= cutoff) files.push(fp);
        }
    }

    const totals = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
    for (const f of files) {
        try {
            attributeSession(fs.readFileSync(f, 'utf8').split('\n'), totals);
        } catch {
            continue; // an unreadable session must not sink the report
        }
    }

    const grand = Object.values(totals).reduce((a, b) => a + b, 0);
    if (argv.includes('--json')) {
        process.stdout.write(
            JSON.stringify(
                {provenance: 'estimated', days, sessions: files.length, total: grand, buckets: totals},
                null,
                2,
            ) + '\n',
        );
        process.exit(0);
    }

    if (!grand) {
        process.stdout.write(
            `No session activity in the last ${days} days` +
                (wanted ? ' for this project (try --all).\n' : '.\n'),
        );
        process.exit(0);
    }

    const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`);
    process.stdout.write(
        `Where your tokens went - last ${days} days, ${files.length} session(s)  [estimated]\n\n`,
    );
    for (const [b, v] of Object.entries(totals).sort((a, b2) => b2[1] - a[1])) {
        const pct = Math.round((v / grand) * 100);
        process.stdout.write(
            `  ${b.padEnd(15)}${'█'.repeat(Math.round(pct / 3)).padEnd(34)}${String(pct).padStart(3)}%  ${fmt(v)}\n`,
        );
    }
    process.stdout.write(`\n  ${'total'.padEnd(15)}${''.padEnd(34)}       ${fmt(grand)}\n`);
    process.stdout.write(
        '\n  Estimated from local session logs, not reported by Anthropic.\n',
    );

}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
