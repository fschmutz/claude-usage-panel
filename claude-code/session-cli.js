// `claudectl session`: the command-line face of claude-code/tabs.js. Snapshot
// every running Claude Code session, list and purge the snapshots, and reopen
// one as tabs of a single terminal window, each in its own directory resuming
// its own session. claudectl.js dispatches here.

import {AUTO_KEEP, AUTO_PREFIX, openTabs, resumePrompt, stampLabel} from './tabs.js';
import {TMUX_SESSION} from './terminals.js';
import {tabsDir} from './paths.js';

export const HELP = `claudectl session - save the running Claude Code sessions, reopen them as tabs

  claudectl session list [--json]            running sessions (* = the one you are in)
  claudectl session save [LABEL] [--exclude-self]
                                             snapshot them (LABEL defaults to the time)
  claudectl session store [--json]           saved snapshots, newest first
  claudectl session show [SNAP] [--json]     what a snapshot holds (default: newest)
  claudectl session open [SNAP] [--only=A,B] [--skip=A,B] [--force] [--dry-run]
                         [--terminal=BIN|iterm|terminal|tmux] [--windows|--tmux]
                         [--prompt=TEXT|--no-prompt]
                                             reopen a snapshot, one tab per session
  claudectl session purge SNAP... | --keep=N | --auto | --all [--yes]
                                             delete snapshots
  claudectl session autosave [--keep=N]      what the schedule runs: save only when
                                             the set changed, keep the newest N autos

SNAP is a label, a unique prefix of one, or its number in \`store\`. \`open\`
skips a session that is still running (--force to try anyway) and one whose
directory or transcript is gone. It opens the terminal the panels use (GNOME
preference \`terminal-command\`, then $TERMINAL, then the first one installed;
macOS: the app's Terminal/iTerm choice). gnome-terminal and iTerm get native
tabs; any other terminal gets one window on a tmux session with a window per
Claude session (--windows: one terminal window each). Each resumed session
gets a first message telling it it was restarted: re-read where it stopped,
re-check git / CI / jobs, re-arm its watchers, report, then carry on
(--prompt=TEXT replaces it, --no-prompt sends none). \`./install.sh cli\` also schedules
\`autosave\` every 30 minutes (keeps ${AUTO_KEEP}, one day).
Snapshots: ${tabsDir()}`;

// Local time, like the labels: 2026-09-23 19:21.
function when(ms) {
  if (!ms) return '?';
  const s = stampLabel(ms);
  return `${s.slice(0, 10)} ${s.slice(11, 13)}:${s.slice(13, 15)}`;
}

function table(out, rows, {mark = null, state = () => ''} = {}) {
  const w = Math.max(4, ...rows.map((r) => r.name.length));
  out(`  ${'#'.padStart(2)}  ${'NAME'.padEnd(w)}  SESSION   ${'STATE'.padEnd(16)}  CWD\n`);
  rows.forEach((r, i) => {
    out(`${r.pid && r.pid === mark ? '*' : ' '} ${String(i + 1).padStart(2)}  ${r.name.padEnd(w)}  ` +
      `${r.session_id.slice(0, 8)}  ${state(r).padEnd(16)}  ${r.cwd}\n`);
  });
}

// --keep=N, strictly: a typo must not turn into slice(NaN), which selects
// every snapshot for deletion.
function wholeNumber(v, min) {
  const n = /^\d+$/.test(String(v)) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < min) throw new Error(`--keep needs a whole number >= ${min}`);
  return n;
}

export async function main(argv, io = {}) {
  const tabs = openTabs(io);
  const out = io.stdout ?? ((s) => process.stdout.write(s));
  const confirm = io.confirm ?? (() => false);
  const args = argv.filter((a) => !a.startsWith('--'));
  const opts = Object.fromEntries(argv.filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, ...v] = a.slice(2).split('=');
      return [k, v.length ? v.join('=') : true];
    }));
  const list = (v) => (typeof v === 'string' ? v.split(',').filter(Boolean) : []);
  const [cmd, ...rest] = args;
  switch (cmd) {
    case undefined:
    case 'help':
      out(`${HELP}\n`);
      return 0;
    case 'list':
    case 'ls': {
      const live = tabs.liveSessions();
      if (opts.json) {
        out(`${JSON.stringify(live, null, 2)}\n`);
        return 0;
      }
      if (!live.length) {
        out('no running Claude Code session\n');
        return 0;
      }
      table(out, live, {mark: tabs.selfPid(live), state: (r) => tabs.blocker(r) ?? r.status});
      return 0;
    }
    case 'save': {
      const snap = tabs.save(rest[0], {excludeSelf: Boolean(opts['exclude-self'])});
      out(`saved ${snap.sessions.length} sessions as ${snap.label}\n`);
      return 0;
    }
    case 'store':
    case 'snapshots': {
      const all = tabs.snapshots();
      if (opts.json) {
        out(`${JSON.stringify(all.map(({file: _file, ...s}) => s), null, 2)}\n`);
        return 0;
      }
      if (!all.length) {
        out(`no snapshots (${tabsDir(io)})\n`);
        return 0;
      }
      const w = Math.max(5, ...all.map((s) => s.label.length));
      all.forEach((s, i) => {
        out(`${String(i + 1).padStart(3)}  ${s.label.padEnd(w)}  ${when(s.savedAt)}  ` +
          `${String(s.sessions.length).padStart(2)}  ${s.sessions.map((r) => r.name).join(', ')}\n`);
      });
      return 0;
    }
    case 'show': {
      const snap = tabs.resolve(rest[0]);
      if (opts.json) {
        out(`${JSON.stringify(snap.sessions, null, 2)}\n`);
        return 0;
      }
      const running = new Set(tabs.liveSessions().map((r) => r.session_id));
      out(`${snap.label}  saved ${when(snap.savedAt)}\n`);
      table(out, snap.sessions, {state: (r) => (running.has(r.session_id) ? 'running' : (tabs.blocker(r) ?? ''))});
      return 0;
    }
    case 'open':
    case 'restore': {
      const snap = tabs.resolve(rest[0]);
      const {open, skipped} = tabs.plan(snap, {only: list(opts.only), skip: list(opts.skip), force: Boolean(opts.force)});
      for (const {row, why} of skipped) out(`skip ${row.name}: ${why}\n`);
      if (!open.length) {
        out('nothing to open\n');
        return 1;
      }
      const terminal = typeof opts.terminal === 'string' ? opts.terminal : undefined;
      const prompt = opts['no-prompt'] ? ''
        : (typeof opts.prompt === 'string' ? opts.prompt
          : resumePrompt({label: snap.label, savedAt: snap.savedAt, nowMs: io.nowMs ? io.nowMs() : Date.now()}));
      const r = tabs.launch(open, {
        terminal, windows: Boolean(opts.windows), tmux: Boolean(opts.tmux), prompt,
        dryRun: Boolean(opts['dry-run']),
      });
      for (const row of open) out(`open ${row.name.padEnd(20)} ${row.session_id.slice(0, 8)}  ${row.cwd}\n`);
      if (opts['dry-run']) {
        for (const st of r.steps) out(`${st.cmd} ${st.args.map((x) => JSON.stringify(x)).join(' ')}\n`);
      }
      const n = open.length;
      out({
        'tabs': `${n} tabs in one ${r.terminal} window\n`,
        'tmux': `${n} tmux windows (session ${TMUX_SESSION}) in one ${r.terminal} window\n`,
        'windows': `${n} ${r.terminal} windows\n`,
        'tmux-only': `${n} windows in tmux session ${TMUX_SESSION} - tmux attach -t ${TMUX_SESSION}\n`,
      }[r.how]);
      return 0;
    }
    case 'purge': {
      const all = tabs.snapshots();
      let doomed;
      if (opts.all) doomed = all;
      else if (opts.auto) doomed = all.filter((s) => s.label.startsWith(AUTO_PREFIX));
      else if (opts.keep !== undefined) doomed = all.slice(wholeNumber(opts.keep, 0));
      else if (rest.length) doomed = rest.map((ref) => tabs.resolve(ref));
      else throw new Error('purge needs SNAP..., --keep=N, --auto or --all');
      if (!doomed.length) {
        out('nothing to purge\n');
        return 0;
      }
      for (const s of doomed) out(`delete ${s.label}\n`);
      if (!opts.yes && !(await confirm(`delete ${doomed.length} snapshot(s)? [y/N] `))) {
        out('aborted\n');
        return 1;
      }
      out(`purged ${tabs.purge(doomed).length}\n`);
      return 0;
    }
    case 'autosave': {
      const keep = opts.keep !== undefined ? wholeNumber(opts.keep, 1) : AUTO_KEEP;
      const r = tabs.autosave({keep});
      out(`${r.saved ? `saved ${r.saved.label}` : 'no new snapshot'} (${r.reason})` +
        `${r.pruned.length ? `, pruned ${r.pruned.length}` : ''}\n`);
      return 0;
    }
    default:
      throw new Error(`unknown command ${cmd}\n${HELP}`);
  }
}
