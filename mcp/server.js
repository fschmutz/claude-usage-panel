#!/usr/bin/env node
// Claude Usage MCP server: exposes the same plan-usage data as the desktop
// panels through the Model Context Protocol, so any MCP client - Claude Code,
// Cursor, Claude Desktop… - can ask "how much of my plan have I used?" or
// "switch me to PERSO" in-conversation. Zero dependencies, stdio transport.
//
// This file is the transport and the get_usage assembly. Everything else has
// an owner: claude-code/accounts.js reads the live login and fetches usage
// (the one reader for every Node client), claude-code/normalize.js /
// pace.js / stamps.js are the Node port of the shared contract, tools.js the
// tool schemas + renderers + account tool calls, sessions.js the session/ping
// index, warehouse.js the 90-day history read.

import fs from 'node:fs';
import {pathToFileURL} from 'node:url';

import {openStore} from '../claude-code/accounts.js';
import {withPace} from '../claude-code/pace.js';
import {historyPath, warehousePath} from '../claude-code/paths.js';
import {readLastPing, refreshSessions, renderPing, renderSessions} from './sessions.js';
import {
  ACCOUNT_TOOL_NAMES, ACCOUNT_TOOLS, GET_USAGE_TOOL, callAccountTool, currentAccount,
  renderAccount, renderCards, renderExtraUsage,
} from './tools.js';
import {withTrend} from './warehouse.js';

// Bumped by scripts/bump-version.sh - keep in sync with package.json.
export const VERSION = '1.12.1';

// Newest first; initialize echoes the client's requested version when we
// support it, otherwise answers with our newest (per the MCP spec).
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

/** Everything get_usage returns, for one login, from one `io`. */
export async function getUsage(io = {}) {
  const store = openStore(io);
  const name = store.liveAccountName();
  const result = name ? await store.usageFor(name) : await store.fetchLiveUsage();
  if (!result.ok) return result;
  const nowMs = io.nowMs ?? Date.now();
  const cards = withTrend(
    withPace(result.cards, {nowMs, historyPath: historyPath(io)}),
    {nowMs, warehouse: warehousePath(io)});
  const lastPing = readLastPing(io);
  const sessions = refreshSessions(io);
  const extraUsage = result.extraUsage ?? null;
  const account = currentAccount(store);
  return {
    ok: true,
    content: [{
      type: 'text',
      text: [
        renderAccount(account), renderCards(cards, nowMs), renderExtraUsage(extraUsage),
        renderPing(lastPing), renderSessions(sessions),
      ].filter(Boolean).join('\n\n'),
    }],
    structuredContent: {account, limits: cards, extraUsage, lastPing, sessions},
  };
}

/**
 * One JSON-RPC request. `io` is the environment (homedir, env, platform,
 * tmpdir, nowMs, fetchImpl, exec - all optional, see claude-code/paths.js and
 * openStore); production passes nothing, the tests a sandbox.
 */
export async function handleRequest(msg, io = {}) {
  switch (msg.method) {
    case 'initialize': {
      const requested = msg.params?.protocolVersion;
      const protocolVersion =
        PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0];
      return {
        protocolVersion,
        capabilities: {tools: {listChanged: false}},
        serverInfo: {name: 'claude-usage', title: 'Claude Usage Panel', version: VERSION},
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return {tools: [GET_USAGE_TOOL, ...ACCOUNT_TOOLS]};
    case 'tools/call': {
      const name = msg.params?.name;
      if (ACCOUNT_TOOL_NAMES.has(name)) {
        try {
          return await callAccountTool(name, msg.params?.arguments, openStore(io));
        } catch (e) {
          return {content: [{type: 'text', text: e.message}], isError: true};
        }
      }
      if (name !== 'get_usage') throw new RpcError(-32602, `Unknown tool: ${name}`);
      const result = await getUsage(io);
      if (!result.ok) {
        return {content: [{type: 'text', text: `${result.code}: ${result.message}`}], isError: true};
      }
      return {content: result.content, structuredContent: result.structuredContent};
    }
    default:
      throw new RpcError(-32601, `Method not found: ${msg.method}`);
  }
}

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function reply(id, body) {
  process.stdout.write(`${JSON.stringify({jsonrpc: '2.0', id, ...body})}\n`);
}

export function main() {
  let buffer = '';
  // In-flight request count: on stdin EOF we must let pending async work
  // (a tools/call mid-fetch) answer before exiting, not die mid-request.
  let pending = 0;
  let ended = false;
  const maybeExit = () => {
    if (ended && pending === 0) process.exit(0);
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        reply(null, {error: {code: -32700, message: 'Parse error'}});
        continue;
      }
      // Notifications (no id) expect no response; requests get exactly one.
      const isRequest = msg.id !== undefined && msg.id !== null;
      if (typeof msg.method !== 'string') {
        if (isRequest) reply(msg.id, {error: {code: -32600, message: 'Invalid request'}});
        continue;
      }
      if (!isRequest) continue;
      pending += 1;
      handleRequest(msg)
        .then(result => reply(msg.id, {result}))
        .catch(e => reply(msg.id, {
          error: {code: e instanceof RpcError ? e.code : -32603, message: e.message},
        }))
        .finally(() => {
          pending -= 1;
          maybeExit();
        });
    }
  });
  process.stdin.on('end', () => {
    ended = true;
    maybeExit();
  });
}

// Run when executed directly - including through the npm/npx bin shim, which
// invokes us via a node_modules/.bin symlink, so compare realpaths.
const invokedAs = (() => {
  try {
    return process.argv[1] && pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return null;
  }
})();
if (invokedAs === import.meta.url) {
  main();
}
