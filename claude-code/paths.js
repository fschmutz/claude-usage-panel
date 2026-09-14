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

/** Durable per-user state: the usage warehouse, saved accounts, the last ping. */
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

/** 90 days of poll samples, one JSONL line per poll that moved. */
export function warehousePath(io) {
  return path.join(stateDir(io), 'history.jsonl');
}

/** scripts/session-ping.sh writes its last successful ping here. */
export function lastPingPath(io) {
  return path.join(stateDir(io), 'last-ping');
}

/** The incremental session index every client keeps warm for the others. */
export function sessionIndexPath(io) {
  return path.join(cacheDir(io), 'sessions.json');
}

/** Rolling 6-hour forecast samples, shared by the status line and the MCP
 *  server. A tmp file on purpose: it is a hint, not a record. */
export function historyPath(io) {
  return path.join(io?.tmpdir ?? os.tmpdir(), 'claude-usage-history.json');
}

/** The status line's per-transcript token totals. Same tmp reasoning. */
export function tokensCachePath(io) {
  return path.join(io?.tmpdir ?? os.tmpdir(), 'claude-usage-statusline-tokens.json');
}
