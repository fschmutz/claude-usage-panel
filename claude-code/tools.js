// Finding and querying the command-line tools `claudectl session` drives
// (tmux, kitty, wezterm, ps, osascript) from whatever PATH it was started
// with. The scheduled autosave (launchd / systemd) and the macOS app run with
// a PATH that lacks Homebrew and sometimes /usr/local/bin, so a bare PATH
// lookup there misses a tmux that every interactive shell finds.

import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

/** Where the tools live when PATH does not list them: Homebrew first. */
export const TOOL_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];

/** PATH with every `dirs` entry it lacks appended, PATH order first. */
export function toolPath(envPath = '', dirs = TOOL_DIRS) {
  const have = String(envPath ?? '').split(':').filter(Boolean);
  return [...have, ...dirs.filter((d) => !have.includes(d))].join(':');
}

/** io.env (else process.env) with PATH widened by io.toolDirs (else
 *  TOOL_DIRS): the environment every tool lookup and query runs in. */
export function toolEnv(io = {}) {
  const env = io.env ?? process.env;
  return {...env, PATH: toolPath(env.PATH, io.toolDirs ?? TOOL_DIRS)};
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
