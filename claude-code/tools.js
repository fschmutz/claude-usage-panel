// Finding and querying the command-line tools `claudectl session` drives
// (tmux, kitty, wezterm, ps, osascript) from whatever PATH it was started
// with. The scheduled autosave (launchd / systemd) and the macOS app run with
// a PATH that lacks Homebrew and sometimes /usr/local/bin, so a bare PATH
// lookup there misses a tmux that every interactive shell finds.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

function isDir(f, p) {
  try {
    return f.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Subdirectory names of `dir`, highest version first ("v22.9.0" and
 *  "22.9.0" alike, v10 above v9): the numeric keys of `_versions_desc` in
 *  scripts/lib.sh, ties in byte order of the same sort line. */
function versionsDesc(dir, f = fs) {
  let names;
  try {
    // A glob's view: no dot entries, symlinks followed (`[ -d ]`).
    names = f.readdirSync(dir).filter((n) => !n.startsWith('.') && isDir(f, `${dir}/${n}`));
  } catch {
    return [];
  }
  const num = (s) => Number(/^\s*(\d+)/.exec(s ?? '')?.[1] ?? 0);
  const line = (n) => `${n.replace(/^v/, '')}\t${n}`;
  const keys = (n) => line(n).split('.').slice(0, 3).map(num);
  return names.sort((a, b) => {
    const ka = keys(a);
    const kb = keys(b);
    for (let i = 0; i < 3; i++) {
      if ((ka[i] ?? 0) !== (kb[i] ?? 0)) return (kb[i] ?? 0) - (ka[i] ?? 0);
    }
    const la = line(a);
    const lb = line(b);
    return la < lb ? -1 : la > lb ? 1 : 0;
  });
}

/**
 * Where node and the claude CLI live when a scheduler's PATH does not list
 * them, in the order scripts/lib.sh `scheduler_bin_dirs` searches (the Node
 * copy; tests/fixtures/scheduler-path.json pins both): user bins, each
 * version manager's stable pointer, the system package dirs, then each
 * manager's per-version dirs, highest version first.
 */
export function schedulerDirs({env = process.env, fs: f = fs} = {}) {
  const home = env.HOME ?? os.homedir();
  const nvm = env.NVM_DIR || `${home}/.nvm`;
  const fnm = env.FNM_DIR || `${home}/.local/share/fnm`;
  const asdf = env.ASDF_DATA_DIR || `${home}/.asdf`;
  const sys = env.CUP_TEST_SYSTEM_BINS ?? '/opt/homebrew/bin:/usr/local/bin';
  return [
    `${home}/.local/bin`, `${home}/.claude/local`, `${env.VOLTA_HOME || `${home}/.volta`}/bin`,
    `${fnm}/aliases/default/bin`, `${asdf}/shims`, `${nvm}/current/bin`,
    ...(sys ? sys.split(':') : []),
    ...versionsDesc(`${fnm}/node-versions`, f).map((v) => `${fnm}/node-versions/${v}/installation/bin`),
    ...versionsDesc(`${asdf}/installs/nodejs`, f).map((v) => `${asdf}/installs/nodejs/${v}/bin`),
    ...versionsDesc(`${nvm}/versions/node`, f).map((v) => `${nvm}/versions/node/${v}/bin`),
  ];
}

/** Where the tools live when PATH does not list them: the scheduler search
 *  above, then the base system dirs. */
const BASE_DIRS = ['/usr/bin', '/bin'];

/** PATH with every `dirs` entry it lacks appended, PATH order first. */
export function toolPath(envPath = '', dirs = BASE_DIRS) {
  const have = String(envPath ?? '').split(':').filter(Boolean);
  return [...have, ...[...new Set(dirs)].filter((d) => !have.includes(d))].join(':');
}

/** io.env (else process.env) with PATH widened by io.toolDirs (else
 *  schedulerDirs + /usr/bin + /bin): the environment every tool lookup and
 *  query runs in. */
export function toolEnv(io = {}) {
  const env = io.env ?? process.env;
  return {...env, PATH: toolPath(env.PATH, io.toolDirs ?? [...schedulerDirs({env}), ...BASE_DIRS])};
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

/** stdout of a read-only query, '' when it fails or is missing: a query
 *  only ever informs, it never aborts the command that asked. */
export function query(io, env, cmd, args) {
  try {
    return String((io.exec ?? execFileSync)(cmd, args,
      {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000, env}));
  } catch {
    return '';
  }
}
