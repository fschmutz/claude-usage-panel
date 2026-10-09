// `claudectl session`: the command-line face of claude-code/tabs.js. Snapshot
// every running Claude Code session, list and purge the snapshots, and reopen
// one in the same windows and tabs, each in its own directory resuming its
// own session. claudectl.js dispatches here.

import os from 'node:os';
import path from 'node:path';

import {AUTO_SNAPSHOT_PREFIX} from '../claude-usage-panel@fschmutz.github.io/lib/pure/snapshots.js';
import {AUTO_KEEP, describeLaunch, matchSession, openTabs, resumePrompt, stampLabel} from './tabs.js';
import {tabsDir} from './paths.js';
import {openPause} from './pause.js';
import {PAUSE_COMMANDS, PAUSE_DETAILS, PAUSE_HELP, runPause} from './pause-cli.js';
import {focusSession} from './waiting.js';
import {recordTabs, terminalWindows} from './gnome-terminal.js';
import {windowGroups} from './terminals.js';

export const HELP = `claudectl session - save the running Claude Code sessions, reopen them as laid out

  claudectl session list [--json]            running sessions (* = the one you are in)
  claudectl session focus [#|NAME|PID|ID]    raise that session's terminal tab;
                                             no argument: pick from the list
  claudectl session save [LABEL] [--exclude-self]
                                             snapshot them (LABEL defaults to the time)
  claudectl session store [--json]           saved snapshots, newest first
  claudectl session show [SNAP] [--json]     what a snapshot holds (default: newest)
  claudectl session open [SNAP] [--only=A,B] [--skip=A,B] [--force] [--dry-run]
                         [--terminal=BIN|iterm|terminal|tmux] [--windows|--tmux]
                         [--prompt=TEXT|--no-prompt]
                                             reopen a snapshot, same windows and tabs;
                                             no SNAP at a terminal: pick one
  claudectl session purge SNAP... | --keep=N | --auto | --all [--yes]
                                             delete snapshots
  claudectl session autosave [--keep=N] [--force]
                                             what the schedule runs: save only when
                                             the set changed, keep the newest N autos;
                                             --force saves now, even an empty set
${PAUSE_HELP}

SNAP is a label, a unique prefix of one, or its number in \`store\`.
Each command has its own page: claudectl session <command> --help
Snapshots: ${tabsDir()}`;

/** One paragraph per command, after its synopsis in `<command> --help`. */
export const DETAILS = {
  list: `The interactive sessions in Claude Code's registry whose process is
really running. * marks the session you type it in. STATE is the session's
own status, or why it cannot be saved. A \`?\` line is a claude process with
no session id: it cannot be saved or reopened.`,
  focus: `Brings the session's terminal window to the front with its tab selected.
#, a name, a pid, or a session id or its prefix; a name two sessions share is
refused (pass the pid). With no argument at a terminal it prints the list and
asks which. Works for tmux, kitty, WezTerm, iTerm and Terminal.app tabs, and
for gnome-terminal tabs that \`claudectl session open\` opened: it records
which window holds which sessions in tab order, and the GNOME extension
raises the window. A tab dragged to another position, a window opened by
hand or from before gnome-terminal restarted is refused, never guessed.`,
  save: `LABEL defaults to the local time (2026-09-23_192140). A labelled snapshot
is never pruned by autosave: save one before a reboot you care about.
--exclude-self leaves out the session you type it in.`,
  store: `Newest first and numbered: the number is a SNAP for show, open and purge.
Columns: label, saved at, how many sessions, their names.`,
  show: `Every session of the snapshot, and whether it is running now or why it
cannot be reopened (its directory or transcript is gone).`,
  open: `With no SNAP, typed at a terminal, it lists the 10 newest snapshots and
asks which (Enter = the newest); without a terminal (the panels' Reopen, a
script) it takes the newest. It skips a session that is still running
(--force to try anyway) and one whose directory or transcript is gone;
--only / --skip narrow it by name.

It opens the terminal the panels use (GNOME preference \`terminal-command\`,
then $TERMINAL, then the desktop's default terminal, then the first one
installed; macOS: the app's Terminal/iTerm choice), laid out as saved: the
same windows, the same tabs in order. iTerm, gnome-terminal and
xfce4-terminal get native tabs; any other terminal gets one tmux session per
saved window (claudectl, claudectl-2, ...), each in a window of its own, or
without tmux one window per session (--windows forces that). --dry-run prints
the commands and runs nothing.

Each resumed session gets a first message telling it it was restarted:
re-read where it stopped, re-check git / CI / jobs, re-arm its watchers,
report, then carry on (--prompt=TEXT replaces it, --no-prompt sends none). A
session paused with a checkpoint gets the resume protocol and its checkpoint
path instead.`,
  purge: `Asks before deleting unless --yes. SNAP... names them; --keep=N keeps the
newest N of all snapshots; --auto removes every \`auto-\` one; --all removes
everything.`,
  autosave: `What \`./install.sh cli\` schedules every 30 minutes. It writes an
\`auto-\` snapshot only when the set of running sessions changed since the last
one, and keeps the newest ${AUTO_KEEP} autos: a count, not an age, so they cover a day
or several. Labelled snapshots are never pruned. It exits 1 when a running
claude cannot be identified, so the schedule goes red instead of skipping it.`,
  ...PAUSE_DETAILS,
};

export const ALIASES = {ls: 'list', restore: 'open', snapshots: 'store'};

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

// How many snapshots \`open\` offers when it asks; any number or label from
// \`store\` is still accepted.
const PICK_SHOWN = 10;

function storeTable(out, all) {
  const w = Math.max(5, ...all.map((s) => s.label.length));
  all.forEach((s, i) => {
    out(`${String(i + 1).padStart(3)}  ${s.label.padEnd(w)}  ${when(s.savedAt)}  ` +
      `${String(s.sessions.length).padStart(2)}  ${s.sessions.map((r) => r.name).join(', ')}\n`);
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
  // the answer typed at a terminal; null when there is none to ask in
  const ask = io.ask ?? (async () => null);
  const args = argv.filter((a) => !a.startsWith('--'));
  const opts = Object.fromEntries(argv.filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, ...v] = a.slice(2).split('=');
      return [k, v.length ? v.join('=') : true];
    }));
  const list = (v) => (typeof v === 'string' ? v.split(',').filter(Boolean) : []);
  const [cmd, ...rest] = args;
  // pause & co. parse their own flags (`--reason TEXT` takes a value)
  if (PAUSE_COMMANDS.has(argv[0])) return runPause(argv[0], argv.slice(1), io);
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
      for (const m of tabs.unaccounted()) out(`  ?  claude pid ${m.pid} in ${m.cwd ?? '?'} - no session id, cannot be saved\n`);
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
      storeTable(out, all);
      return 0;
    }
    case 'focus': {
      const live = tabs.liveSessions();
      if (!live.length) {
        out('no running Claude Code session\n');
        return 1;
      }
      let key = rest[0];
      if (key === undefined) {
        table(out, live, {mark: tabs.selfPid(live), state: (r) => tabs.blocker(r) ?? r.status});
        key = await ask('focus which? [#, name or pid] ');
        if (key === null) throw new Error('focus needs #, NAME, PID or a session id (no terminal to ask in)');
        if (!key.trim()) {
          out('aborted\n');
          return 1;
        }
      }
      const row = matchSession(live, key, {numbered: true});
      if (!focusSession(row, io)) {
        throw new Error(`could not raise ${row.name}: tmux, kitty, WezTerm, iTerm and Terminal.app tabs can be ` +
          'raised; a gnome-terminal tab only when `claudectl session open` opened it and the GNOME extension is on');
      }
      out(`focused ${row.name}\n`);
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
      let ref = rest[0];
      const all = ref === undefined ? tabs.snapshots() : [];
      if (all.length > 1) {
        storeTable(out, all.slice(0, PICK_SHOWN));
        const answer = await ask('open which? [1] ');
        if (answer !== null && answer.trim()) ref = answer.trim();
      }
      const snap = tabs.resolve(ref);
      const {open, skipped} = tabs.plan(snap, {only: list(opts.only), skip: list(opts.skip), force: Boolean(opts.force)});
      for (const {row, why} of skipped) out(`skip ${row.name}: ${why}\n`);
      if (!open.length) {
        out('nothing to open\n');
        return 1;
      }
      const terminal = typeof opts.terminal === 'string' ? opts.terminal : undefined;
      // A session paused with a checkpoint (claudectl session pause) gets
      // the resume protocol and its path in its own prompt.
      const pause = openPause(io);
      const generated = !opts['no-prompt'] && typeof opts.prompt !== 'string';
      const checkpoints = new Map(generated
        ? open.map((row) => [row.session_id, pause.pendingCheckpoint(row.session_id)]) : []);
      const nowMs = io.nowMs ? io.nowMs() : Date.now();
      // everyone up after this: the reopened ones and those still running
      const peers = [...open, ...tabs.liveSessions().filter((l) => !open.some((o) => o.session_id === l.session_id))];
      const prompt = opts['no-prompt'] ? ''
        : (typeof opts.prompt === 'string' ? opts.prompt
          : (row) => resumePrompt({
            label: snap.label, savedAt: snap.savedAt, nowMs, peers, homedir: io.homedir ?? os.homedir(),
            checkpoint: checkpoints.get(row.session_id) ?? null,
          }));
      const dryRun = Boolean(opts['dry-run']);
      const how = {terminal, windows: Boolean(opts.windows), tmux: Boolean(opts.tmux), prompt};
      // gnome-terminal cannot list its tabs: note its windows before, to
      // record which new one holds which sessions (what `focus` needs)
      const plan = tabs.launch(open, {...how, dryRun: true});
      const gnomeTabs = !dryRun && plan.how === 'tabs' && path.basename(plan.terminal) === 'gnome-terminal';
      const before = gnomeTabs ? terminalWindows(io) : [];
      const r = dryRun ? plan : tabs.launch(open, how);
      if (gnomeTabs) await recordTabs({before, groups: windowGroups(open), io});
      if (!opts['dry-run']) for (const [id, cp] of checkpoints) if (cp) pause.markResumed(id);
      for (const row of open) out(`open ${row.name.padEnd(20)} ${row.session_id.slice(0, 8)}  ${row.cwd}\n`);
      if (opts['dry-run']) {
        for (const st of r.steps) out(`${st.cmd} ${st.args.map((x) => JSON.stringify(x)).join(' ')}\n`);
      }
      out(`${describeLaunch(r, open.length)}\n`);
      return 0;
    }
    case 'purge': {
      const all = tabs.snapshots();
      let doomed;
      if (opts.all) doomed = all;
      else if (opts.auto) doomed = all.filter((s) => s.label.startsWith(AUTO_SNAPSHOT_PREFIX));
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
      const r = tabs.autosave({keep, force: Boolean(opts.force)});
      out(`${r.saved ? `saved ${r.saved.label}` : 'no new snapshot'} (${r.reason})` +
        `${r.pruned.length ? `, pruned ${r.pruned.length}` : ''}\n`);
      // A session that cannot be saved is a failure, not a footnote: the
      // scheduled run goes red instead of reporting "unchanged".
      for (const m of r.missed) out(`NOT SAVED: claude pid ${m.pid} in ${m.cwd ?? '?'} - no session id (not registered, not started with --resume)\n`);
      return r.missed.length ? 1 : 0;
    }
    default:
      throw new Error(`unknown command ${cmd}\n${HELP}`);
  }
}
