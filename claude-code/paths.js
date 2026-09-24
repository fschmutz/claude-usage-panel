// Every file the Node clients read or write, derived from ONE `io` shape:
// {homedir, env, platform, tmpdir} - the same shape openStore(io) and
// handleRequest(msg, io) take, every field optional, defaults the real
// process. Nothing here touches the disk; nothing here is computed at module
// load, so a test binds a throwaway HOME by passing it instead of poking
// process.env.

import os from 'node:os';
import path from 'node:path';

const APP = 'claude-usage-panel';

function env(io) {
  return io?.env ?? process.env;
}
function homedir(io) {
  return io?.homedir ?? os.homedir();
}
function platform(io) {
  return io?.platform ?? process.platform;
}

/** Durable per-user state: the usage warehouse, saved accounts, tab snapshots. */
export function stateDir(io) {
  if (platform(io) === 'darwin') {
    return path.join(homedir(io), 'Library', 'Application Support', APP);
  }
  return path.join(env(io).XDG_STATE_HOME || path.join(homedir(io), '.local', 'state'), APP);
}

/** Rebuildable caches: the session index. */
export function cacheDir(io) {
  if (platform(io) === 'darwin') return path.join(homedir(io), 'Library', 'Caches', APP);
  return path.join(env(io).XDG_CACHE_HOME || path.join(homedir(io), '.cache'), APP);
}

/** Claude Code's own config dir - follows CLAUDE_CONFIG_DIR when set. */
export function claudeDir(io) {
  return env(io).CLAUDE_CONFIG_DIR || path.join(homedir(io), '.claude');
}

/** Where Claude Code keeps the live credentials. */
export function credentialsPath(io) {
  return path.join(claudeDir(io), '.credentials.json');
}

/** ~/.claude.json, which moves into CLAUDE_CONFIG_DIR when that is set. */
export function claudeConfigPath(io) {
  return env(io).CLAUDE_CONFIG_DIR
    ? path.join(env(io).CLAUDE_CONFIG_DIR, '.claude.json')
    : path.join(homedir(io), '.claude.json');
}

/** Claude Code's session transcripts, one directory per project. */
export function projectsDir(io) {
  return path.join(claudeDir(io), 'projects');
}

/** Saved logins, one file per name, plus the usage cache and last-switch stamp. */
export function accountsDir(io) {
  return path.join(stateDir(io), 'accounts');
}

/** Claude Code's live-session registry: one <pid>.json per running session. */
export function sessionRegistryDir(io) {
  return path.join(claudeDir(io), 'sessions');
}

/** `claudectl session` snapshots: one JSON file per saved set of sessions. */
export function tabsDir(io) {
  return path.join(stateDir(io), 'tabs');
}

/** 90 days of poll samples, one JSONL line per poll that moved. */
export function warehousePath(io) {
  return path.join(stateDir(io), 'history.jsonl');
}

/** scripts/session-ping.sh writes its last successful ping here. The script
 *  uses ${XDG_STATE_HOME:-$HOME/.local/state} on EVERY platform, and so do the
 *  GNOME extension and the macOS app, so this must not follow stateDir()'s
 *  Application Support branch on darwin, or a Mac never sees a ping. */
export function lastPingPath(io) {
  return path.join(env(io).XDG_STATE_HOME || path.join(homedir(io), '.local', 'state'), APP, 'last-ping');
}

/** The incremental session index every client keeps warm for the others. */
export function sessionIndexPath(io) {
  return path.join(cacheDir(io), 'sessions.json');
}

/** A directory only this user can write, that exists without anyone creating
 *  it, for the two scratch files below. Never the shared /tmp: a fixed name
 *  there can be pre-created by another local user (writeFileSync's 0600 only
 *  applies on create), who then reads the usage timeline or plants samples.
 *  - io.tmpdir when given (tests bind a sandbox);
 *  - darwin: os.tmpdir(), which is the per-user $TMPDIR under /var/folders;
 *  - $XDG_RUNTIME_DIR: per-user, 0700, tmpfs, cleared at logout;
 *  - else Claude Code's own dir, which exists whenever the status line or the
 *    MCP server can run (they are launched by Claude Code). */
export function scratchDir(io) {
  if (io?.tmpdir) return io.tmpdir;
  if (platform(io) === 'darwin') return os.tmpdir();
  return env(io).XDG_RUNTIME_DIR || claudeDir(io);
}

/** Rolling 6-hour forecast samples, shared by the status line and the MCP
 *  server. Scratch on purpose: it is a hint, not a record. */
export function historyPath(io) {
  return path.join(scratchDir(io), 'claude-usage-history.json');
}

/** The status line's per-transcript token totals. Same scratch reasoning. */
export function tokensCachePath(io) {
  return path.join(scratchDir(io), 'claude-usage-statusline-tokens.json');
}
