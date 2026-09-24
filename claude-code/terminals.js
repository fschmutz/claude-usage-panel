// Which terminal `claudectl session open` uses, and how it gets one tab per
// session. The "which" is NOT ours to decide: the panels already let the user
// pick the terminal a resume click opens, and a CLI that opened a different
// one would be a second, silent setting. So the answer is theirs, in the same
// order they use:
//
//   Linux  - the GNOME extension's `terminal-command` key (read with dconf),
//            then $TERMINAL, then the desktop's default terminal
//            (`xdg-terminal-exec --print-id`, then x-terminal-emulator),
//            then the first emulator of TERMINALS on PATH - pickTerminal().
//   macOS  - the menu-bar app's `terminalChoice` default (auto / terminal /
//            iterm; auto = iTerm when it is installed).
//
// TERMINALS, terminalArgv and pickTerminal mirror lib/pure/sessions.js 1:1 (parity asserted
// in tests/terminals.test.js), so a session opened from the CLI starts exactly
// like one clicked in the panel.
//
// The "how": few terminals can open N windows of tabs with N commands from
// one command line. gnome-terminal / xfce4-terminal (--window --tab ...) and
// iTerm (AppleScript) can, and get native tabs, one window per saved window
// (windowGroups). Every other terminal gets one tmux session per saved
// window, each attached in a window of that terminal - tabs as tmux windows -
// or, with --windows or without tmux, one window per session.
//
// launchSteps() is pure: it turns rows + a resolved terminal into the exact
// processes to start. openTabs(io).launch() runs them.

import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

import {onPath} from './tools.js';

export const TMUX_SESSION = 'claudectl';
/** The macOS app's bundle id: its UserDefaults domain. */
export const MAC_DEFAULTS_DOMAIN = 'io.github.fschmutz.claude-usage-panel';
/** The GNOME extension's GSettings path, as dconf sees it. */
export const GNOME_TERMINAL_KEY = '/org/gnome/shell/extensions/claude-usage-panel/terminal-command';

export const shellQuote = (s) => `'${String(s ?? '').replace(/'/g, `'\\''`)}'`;

// Mirrors TERMINALS in lib/pure/sessions.js: same entries, same order.
export const TERMINALS = [
  {bin: 'ghostty', desktop: ['com.mitchellh.ghostty.desktop'],
    argv: (d, c) => [`--working-directory=${d}`, '-e', 'bash', '-lc', c]},
  {bin: 'kitty', desktop: ['kitty.desktop'], argv: (d, c) => ['--directory', d, 'bash', '-lc', c]},
  {bin: 'wezterm', desktop: ['org.wezfurlong.wezterm.desktop'],
    argv: (d, c) => ['start', '--cwd', d, '--', 'bash', '-lc', c]},
  {bin: 'alacritty', desktop: ['Alacritty.desktop'],
    argv: (d, c) => ['--working-directory', d, '-e', 'bash', '-lc', c]},
  {bin: 'foot', desktop: ['foot.desktop', 'footclient.desktop'], argv: (d, c) => ['-D', d, 'bash', '-lc', c]},
  {bin: 'gnome-terminal', desktop: ['org.gnome.Terminal.desktop'],
    argv: (d, c) => [`--working-directory=${d}`, '--', 'bash', '-lc', c]},
  {bin: 'konsole', desktop: ['org.kde.konsole.desktop'], argv: (d, c) => ['--workdir', d, '-e', 'bash', '-lc', c]},
  {bin: 'tilix', desktop: ['com.gexperts.Tilix.desktop'], argv: (d, c) => ['-w', d, '-e', 'bash', '-lc', c]},
  {bin: 'xfce4-terminal', desktop: ['xfce4-terminal.desktop'],
    argv: (d, c) => [`--working-directory=${d}`, '-x', 'bash', '-lc', c]},
  {bin: 'x-terminal-emulator', desktop: [], argv: (d, c) => ['-e', 'bash', '-lc', `cd ${shellQuote(d)} && ${c}`]},
  {bin: 'xterm', desktop: ['xterm.desktop', 'debian-xterm.desktop'],
    argv: (d, c) => ['-e', 'bash', '-lc', `cd ${shellQuote(d)} && ${c}`]},
  {bin: 'xdg-terminal-exec', desktop: [], argv: (d, c) => [`--dir=${d}`, '--', 'bash', '-lc', c]},
];

/** Mirrors terminalForDesktopId in lib/pure/sessions.js. */
export function terminalForDesktopId(id) {
  const bare = String(id ?? '').trim().split(':')[0];
  return TERMINALS.find((t) => t.desktop.includes(bare))?.bin ?? null;
}

/** Mirrors terminalForAlternative in lib/pure/sessions.js. */
export function terminalForAlternative(target) {
  const name = String(target ?? '').split('/').pop().replace(/\.wrapper$/, '');
  return TERMINALS.find((t) => t.bin === name && t.bin !== 'x-terminal-emulator')?.bin ?? null;
}

/** Mirrors pickTerminal in lib/pure/sessions.js: the user's choice, then
 *  $TERMINAL, then the desktop's default, then the first known installed. */
export function pickTerminal({configured, envTerminal, desktopId, alternative}, installed) {
  if (configured) return configured;
  if (envTerminal && installed(envTerminal)) return envTerminal;
  if (desktopId) {
    const bin = terminalForDesktopId(desktopId);
    if (bin && installed(bin)) return bin;
    if (installed('xdg-terminal-exec')) return 'xdg-terminal-exec';
  }
  const alt = terminalForAlternative(alternative);
  if (alt && installed(alt)) return alt;
  return TERMINALS.find((t) => installed(t.bin))?.bin ?? null;
}

/** Mirrors terminalArgv in lib/pure/sessions.js. */
export function terminalArgv(bin, cwd, command) {
  if (!bin) return null;
  const dir = cwd || '.';
  const known = TERMINALS.find((t) => t.bin === bin || bin.endsWith(`/${t.bin}`));
  const tail = known
    ? known.argv(dir, command)
    : ['-e', 'bash', '-lc', `cd ${shellQuote(dir)} && ${command}`];
  return [bin, ...tail];
}

/** What one tab runs: resume the session under its name - with `prompt` as
 *  its first message when given - then stay on an interactive shell in its
 *  directory (the panels' interactiveResume form). */
export function sessionCommand(row, prompt = '') {
  const first = prompt ? ` ${shellQuote(prompt)}` : '';
  return `claude --name ${shellQuote(row.name)} --resume ${shellQuote(row.session_id)}${first}; exec "$SHELL" -i`;
}

const base = (bin) => path.basename(String(bin ?? ''));

/**
 * Rows split into the terminal windows they came from: rows sharing a
 * `window` (claude-code/layout.js) form one group, in order of first
 * appearance. Rows without one - an old snapshot, a terminal that cannot be
 * located - share one window of their own, as before placement existed.
 */
export function windowGroups(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = r.window === undefined || r.window === null ? '\0unplaced' : `w:${r.window}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.values()];
}

/** The i-th fallback tmux session name: claudectl, claudectl-2, … */
export const tmuxSessionName = (i) => (i ? `${TMUX_SESSION}-${i + 1}` : TMUX_SESSION);

// What a saved tmux name must look like to be reused: it reaches a shell
// line (`tmux attach -t NAME`), and a snapshot is a file anyone can edit.
const TMUX_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * One tmux session name per window group. A group saved from tmux gets its
 * own session name back (`tmux:work` -> work) unless `taken` (the sessions
 * the server already runs) holds it; every other group gets the first free
 * claudectl, claudectl-2, …
 */
export function tmuxSessionNames(groups, taken = []) {
  const used = new Set(taken);
  const saved = groups.map((g) => {
    const w = String(g[0].window ?? '');
    const name = w.startsWith('tmux:') ? w.slice(5) : '';
    if (!TMUX_NAME_RE.test(name) || used.has(name)) return null;
    used.add(name);
    return name;
  });
  let n = 0;
  return saved.map((name) => {
    if (name) return name;
    while (used.has(tmuxSessionName(n))) n++;
    const pick = tmuxSessionName(n);
    used.add(pick);
    return pick;
  });
}

// The per-tab flags of the terminals that open several windows of native
// tabs from one command line; `--window` / `--tab` and the command are
// shared. gnome-terminal: `--command` is the only per-tab command form (a
// trailing `--` is one command for the whole invocation), still honoured
// with a deprecation note on stderr. xfce4-terminal: `-e` per tab.
const TAB_FLAGS = {
  'gnome-terminal': (r, cmd) => ['--title', r.name, '--working-directory', r.cwd, '--command', cmd],
  'xfce4-terminal': (r, cmd) => ['-T', r.name, `--working-directory=${r.cwd}`, '-e', cmd],
};

/** argv for one of TAB_FLAGS' terminals: a --window per window group, a
 *  --tab per further row of it. */
export function tabsArgv(terminal, rows, prompt = '') {
  const flags = TAB_FLAGS[base(terminal)];
  return windowGroups(rows).flatMap((group) => group.flatMap((r, i) => [
    i ? '--tab' : '--window', ...flags(r, `bash -lc ${shellQuote(sessionCommand(r, prompt))}`),
  ]));
}

/** tmux calls building one detached session, one window per row. */
export function tmuxCalls(rows, session = TMUX_SESSION, prompt = '') {
  return rows.map((r, i) => [
    ...(i ? ['new-window', '-t', session] : ['new-session', '-d', '-s', session]),
    '-n', r.name, '-c', r.cwd, `bash -lc ${shellQuote(sessionCommand(r, prompt))}`,
  ]);
}

// AppleScript string literal of a shell line.
const asString = (s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** AppleScript for macOS opening `windows`, each a list of shell lines.
 *  iTerm: a window each, a tab per further line. Terminal.app has no tab
 *  verb outside UI scripting, so every line gets a window of its own. */
export function appleScript(app, windows) {
  if (app === 'iterm') {
    const body = windows.flatMap((cmds) => cmds.map((c, i) => (i
      ? `  tell w to create tab with default profile\n  tell current session of w to write text ${asString(c)}`
      : `  set w to (create window with default profile)\n  tell current session of w to write text ${asString(c)}`)));
    return `tell application "iTerm"\n  activate\n${body.join('\n')}\nend tell`;
  }
  const body = windows.flat().map((c) => `  do script ${asString(c)}`);
  return `tell application "Terminal"\n  activate\n${body.join('\n')}\nend tell`;
}

/**
 * The processes that open `rows`, window group by window group. Pure.
 * @param terminal a Linux terminal binary, 'iterm' / 'terminal' on macOS, or
 *   'tmux' (detached tmux sessions only - over ssh, say)
 * @param opts.hasTmux tmux is installed; opts.windows forces a window per
 *   session; opts.tmux forces the tmux layout even where native tabs exist;
 *   opts.tmuxTaken the tmux sessions that already exist (tmuxSessionNames)
 * @returns {{how: 'tabs'|'tmux'|'windows'|'tmux-only', windows: number,
 *   tmuxSessions: string[], steps: {cmd, args, detach}[]}}
 */
export function launchSteps(rows, terminal, {
  platform = 'linux', hasTmux = false, windows = false, tmux = false, prompt = '', tmuxTaken = [],
} = {}) {
  const groups = windowGroups(rows);
  const tmuxSessions = tmuxSessionNames(groups, tmuxTaken);
  const attach = tmuxSessions.map((name) => `tmux attach -t ${name}`);
  const tmuxSteps = groups.flatMap((g, i) => tmuxCalls(g, tmuxSessions[i], prompt))
    .map((args) => ({cmd: 'tmux', args, detach: false}));
  // `windows` is what the user sees open: one per group, or one per row
  const result = (how, steps, perRow = false) => ({
    how, steps, windows: perRow ? rows.length : groups.length,
    tmuxSessions: how.startsWith('tmux') ? tmuxSessions : [],
  });
  if (terminal === 'tmux') return result('tmux-only', tmuxSteps);
  const useTmux = !windows && hasTmux;
  const nativeTabs = !windows && !tmux;
  if (platform === 'darwin') {
    const app = terminal === 'iterm' ? 'iterm' : 'terminal';
    const osa = (w) => ({cmd: 'osascript', args: ['-e', appleScript(app, w)], detach: false});
    const lines = (g) => g.map((r) => `cd ${shellQuote(r.cwd)} && ${sessionCommand(r, prompt)}`);
    if (app === 'iterm' && nativeTabs) return result('tabs', [osa(groups.map(lines))]);
    if (useTmux) return result('tmux', [...tmuxSteps, osa(attach.map((l) => [l]))]);
    return result('windows', [osa(rows.map((r) => lines([r])))], true);
  }
  if (TAB_FLAGS[base(terminal)] && nativeTabs) {
    return result('tabs', [{cmd: terminal, args: tabsArgv(terminal, rows, prompt), detach: true}]);
  }
  const spawn = (argv) => ({cmd: argv[0], args: argv.slice(1), detach: true});
  if (useTmux) return result('tmux', [...tmuxSteps, ...groups.map((g, i) => spawn(terminalArgv(terminal, g[0].cwd, attach[i])))]);
  return result('windows', rows.map((r) => spawn(terminalArgv(terminal, r.cwd, sessionCommand(r, prompt)))), true);
}

// What Claude Code sets in the environment of the commands a session runs,
// naming THAT session: its id, pid, messaging socket + token, "you are my
// child". A terminal inherits its launcher's environment (gnome-terminal
// forwards it to the tab), so a `claudectl session open` typed in a Claude
// shell handed all of it to every resumed session: each believed it was a
// child of the caller, never registered in ~/.claude/sessions, and was
// invisible to its peers. Families by prefix, so a new SESSION_* or
// MESSAGING_* variable is covered too; user configuration
// (CLAUDE_CONFIG_DIR, CLAUDE_CODE_USE_BEDROCK, …) is not in these families.
const SESSION_ENV =
  /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_(CHILD_SESSION|SESSION_[A-Z0-9_]+|MESSAGING_[A-Z0-9_]+|ENTRYPOINT|EXECPATH))$/;

// What Claude Code sets for its tool shells ON TOP of the session identity:
// a no-op git editor (a tool cannot answer one), an agent marker, and two
// tool-behaviour switches. None is in the claude process's own environment,
// so none is user configuration - but every name is one a user may well set
// themselves, so each is dropped only under a Claude shell (CLAUDECODE set)
// AND only with the exact value Claude injects. Left in, the `exec "$SHELL"
// -i` each reopened tab ends on opened `true` as the editor of every plain
// `git commit` and told tools the human was an agent.
const INJECTED_ENV = {
  GIT_EDITOR: (v) => v === 'true',
  AI_AGENT: (v) => /^claude-code/.test(v),
  COREPACK_ENABLE_AUTO_PIN: (v) => v === '0',
  NoDefaultCurrentDirectoryInExePath: (v) => v === '1',
};

/** `env` without the calling Claude session's own variables. */
export function sessionFreeEnv(env) {
  const underClaude = Boolean(env.CLAUDECODE);
  return Object.fromEntries(Object.entries(env).filter(([k, v]) =>
    !SESSION_ENV.test(k) && !(underClaude && INJECTED_ENV[k]?.(String(v)))));
}

// dconf prints a GVariant: 'ghostty' (quoted), or nothing when unset.
function parseGVariantString(text) {
  const t = String(text ?? '').trim();
  const m = /^'(.*)'$/s.exec(t);
  return (m ? m[1].replace(/\\'/g, '\'') : t).trim();
}

/**
 * The terminal the panels would open, from the user's own setting.
 * io: platform, env, exec (execFileSync), itermApp, alternativePath. Returns a Linux
 * binary, 'iterm' / 'terminal' on macOS, or null when nothing is found.
 */
export function resolveTerminal(io = {}) {
  const platform = io.platform ?? process.platform;
  const env = io.env ?? process.env;
  const read = (cmd, args) => {
    try {
      return String((io.exec ?? execFileSync)(cmd, args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}));
    } catch {
      return '';
    }
  };
  if (platform === 'darwin') {
    const choice = read('defaults', ['read', MAC_DEFAULTS_DOMAIN, 'terminalChoice']).trim();
    if (choice === 'iterm' || choice === 'terminal') return choice;
    const itermApp = io.itermApp ?? '/Applications/iTerm.app';
    return fs.existsSync(itermApp) ? 'iterm' : 'terminal';
  }
  const installed = (bin) => onPath(bin, env.PATH);
  let alternative = null;
  try {
    alternative = fs.readlinkSync(io.alternativePath ?? '/etc/alternatives/x-terminal-emulator');
  } catch {
    alternative = null;
  }
  return pickTerminal({
    configured: parseGVariantString(read('dconf', ['read', GNOME_TERMINAL_KEY])),
    envTerminal: env.TERMINAL,
    desktopId: installed('xdg-terminal-exec') ? read('xdg-terminal-exec', ['--print-id']).trim() || null : null,
    alternative,
  }, installed);
}
