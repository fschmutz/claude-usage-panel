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
// The "how": few terminals can open N tabs with N commands from one command
// line. gnome-terminal (--window --tab ...) and iTerm (AppleScript) can, and
// get native tabs. Every other terminal gets ONE window of that terminal
// attached to a tmux session holding one window per Claude session - still
// one window, tabs as tmux windows - or, with --windows or without tmux, one
// window per session.
//
// launchSteps() is pure: it turns rows + a resolved terminal into the exact
// processes to start. openTabs(io).launch() runs them.

import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

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
  {bin: 'x-terminal-emulator', desktop: [], argv: (d, c) => ['-e', 'bash', '-lc', `cd ${d} && ${c}`]},
  {bin: 'xterm', desktop: ['xterm.desktop', 'debian-xterm.desktop'],
    argv: (d, c) => ['-e', 'bash', '-lc', `cd ${d} && ${c}`]},
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

/** What one tab runs: resume the session under its name, then stay on an
 *  interactive shell in its directory (the panels' interactiveResume form). */
export function sessionCommand(row) {
  return `claude --name ${shellQuote(row.name)} --resume ${shellQuote(row.session_id)}; exec "$SHELL" -i`;
}

const base = (bin) => path.basename(String(bin ?? ''));

/** gnome-terminal argv: one new window, one tab per row. `--command` is the
 *  only per-tab command form (a trailing `--` is one command for the whole
 *  invocation); still honoured, with a deprecation note on stderr. */
export function gnomeTabsArgv(rows) {
  const argv = ['--window'];
  rows.forEach((r, i) => {
    if (i) argv.push('--tab');
    argv.push('--title', r.name, '--working-directory', r.cwd,
      '--command', `bash -lc ${shellQuote(sessionCommand(r))}`);
  });
  return argv;
}

/** tmux calls building one detached session, one window per row. */
export function tmuxCalls(rows, session = TMUX_SESSION) {
  return rows.map((r, i) => [
    ...(i ? ['new-window', '-t', session] : ['new-session', '-d', '-s', session]),
    '-n', r.name, '-c', r.cwd, `bash -lc ${shellQuote(sessionCommand(r))}`,
  ]);
}

// AppleScript string literal of a shell line.
const asString = (s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const macLine = (r) => `cd ${shellQuote(r.cwd)} && ${sessionCommand(r)}`;

/** AppleScript for macOS. iTerm: one window, the first row in it, a tab per
 *  further row (`tabs`), or a window per row. Terminal.app has no tab verb
 *  outside UI scripting, so each `do script` is its own window. `lines`
 *  overrides the per-row shell lines (the tmux attach). */
export function appleScript(app, rows, {tabs = true, lines} = {}) {
  const cmds = lines ?? rows.map(macLine);
  if (app === 'iterm') {
    const body = cmds.map((c, i) => (i && tabs
      ? `  tell w to create tab with default profile\n  tell current session of w to write text ${asString(c)}`
      : `  set w to (create window with default profile)\n  tell current session of w to write text ${asString(c)}`));
    return `tell application "iTerm"\n  activate\n${body.join('\n')}\nend tell`;
  }
  const body = cmds.map((c) => `  do script ${asString(c)}`);
  return `tell application "Terminal"\n  activate\n${body.join('\n')}\nend tell`;
}

/**
 * The processes that open `rows`. Pure.
 * @param terminal a Linux terminal binary, 'iterm' / 'terminal' on macOS, or
 *   'tmux' (a detached tmux session only - over ssh, say)
 * @param opts.hasTmux tmux is installed; opts.windows forces a window per
 *   session; opts.tmux forces the tmux layout even where native tabs exist
 * @returns {{how: 'tabs'|'tmux'|'windows'|'tmux-only', steps: {cmd, args, detach}[]}}
 */
export function launchSteps(rows, terminal, {platform = 'linux', hasTmux = false, windows = false, tmux = false} = {}) {
  const tmuxSteps = tmuxCalls(rows).map((args) => ({cmd: 'tmux', args, detach: false}));
  const attach = `tmux attach -t ${TMUX_SESSION}`;
  if (terminal === 'tmux') return {how: 'tmux-only', steps: tmuxSteps};
  const useTmux = !windows && hasTmux;
  if (platform === 'darwin') {
    const app = terminal === 'iterm' ? 'iterm' : 'terminal';
    const osa = (script) => ({cmd: 'osascript', args: ['-e', script], detach: false});
    if (app === 'iterm' && !windows && !tmux) return {how: 'tabs', steps: [osa(appleScript('iterm', rows))]};
    if (useTmux) return {how: 'tmux', steps: [...tmuxSteps, osa(appleScript(app, [], {lines: [attach]}))]};
    return {how: 'windows', steps: [osa(appleScript(app, rows, {tabs: false}))]};
  }
  if (base(terminal) === 'gnome-terminal' && !windows && !tmux) {
    return {how: 'tabs', steps: [{cmd: terminal, args: gnomeTabsArgv(rows), detach: true}]};
  }
  const spawn = (argv) => ({cmd: argv[0], args: argv.slice(1), detach: true});
  if (useTmux) {
    return {how: 'tmux', steps: [...tmuxSteps, spawn(terminalArgv(terminal, rows[0].cwd, attach))]};
  }
  return {how: 'windows', steps: rows.map((r) => spawn(terminalArgv(terminal, r.cwd, sessionCommand(r))))};
}

/** An executable on PATH (or an absolute/relative path that is one). */
export function onPath(bin, envPath = process.env.PATH ?? '') {
  if (!bin) return false;
  const ok = (p) => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (bin.includes('/')) return ok(bin);
  return envPath.split(':').filter(Boolean).some((d) => ok(path.join(d, bin)));
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
