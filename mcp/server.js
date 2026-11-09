#!/usr/bin/env node
// Claude Usage MCP server: exposes the same plan-usage data as the desktop
// panels through the Model Context Protocol, so any MCP client - Claude Code,
// Cursor, Claude Desktop… - can ask "how much of my plan have I used?" or
// "switch me to PERSO" in-conversation. Zero dependencies, stdio transport.
//
// This file is the transport and the get_usage assembly. Everything else has
// an owner: claude-code/accounts.js reads the live login and fetches usage
// (the one reader for every Node client), claude-code/login-usage.js picks
// which login's usage and how its failure is labelled, the shared contract is
// lib/pure/ (imported as is - the GNOME extension's own copy), claude-code/pace.js
// the sample history, tools.js the tool schemas + renderers + account tool
// calls, sessions.js the session/ping index, warehouse.js the 90-day history
// read.

import {warehouseAccount} from '../claude-usage-panel@fschmutz.github.io/lib/pure/warehouse.js';
import {openStore} from '../claude-code/accounts.js';
import {openCodexStore} from '../claude-code/codex.js';
import {isMain} from '../claude-code/is-main.js';
import {liveLoginUsage} from '../claude-code/login-usage.js';
import {withPace} from '../claude-code/pace.js';
import {historyPath, nowOf, warehousePath} from '../claude-code/paths.js';
import {AWAKE_TOOL, callAwakeTool} from './awake.js';
import {CODEX_TOOLS, callCodexTool} from './codex.js';
import {readLastPing, refreshSessions, renderPing, renderSessions} from './sessions.js';
import {
  ACCOUNT_TOOLS, GET_USAGE_TOOL, callAccountTool, currentAccount,
  renderAccount, renderCards, renderExtraUsage,
} from './tools.js';
import {WAITING_TOOL, getWaiting} from './waiting.js';
import {withTrend} from './warehouse.js';

// Bumped by scripts/bump-version.sh - keep in sync with package.json.
export const VERSION = '3.12.1';

// Newest first; initialize echoes the client's requested version when we
// support it, otherwise answers with our newest (per the MCP spec).
// 2025-11-25 adds only optional capabilities (tasks, icons, URL elicitation,
// sampling tools); a tools-only stdio server declares none of them.
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

/** Everything get_usage returns, for one login, from one `io`. */
export async function getUsage(io = {}) {
  const store = openStore(io);
  // Keep the live login's profile current: Claude Code rotates its tokens as
  // it runs and revokes the ones it replaces, so a profile written only at
  // save time rots while its account is live. Cheap - writes only on a change.
  // Housekeeping: a store it cannot write (read-only or full state dir) must
  // not cost the caller the usage answer.
  try {
    store.syncBack();
  } catch {
    // the profile stays as it was; the next call retries
  }
  const result = await liveLoginUsage(store);
  if (!result.ok) return result;
  const nowMs = nowOf(io);
  // Pace history and warehouse trend are both filed under the live login
  // (warehouseAccount): two logins are two quota pools. The status line keys the
  // shared history file the same way.
  const accountKey = warehouseAccount(store.readLiveAccount());
  const cards = withTrend(
    withPace(result.cards, {nowMs, historyPath: historyPath(io), account: accountKey}),
    {nowMs, warehouse: warehousePath(io), account: accountKey});
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

const toolError = (text) => ({content: [{type: 'text', text}], isError: true});

/**
 * Every tool the server exposes, in tools/list order: its schema and how to
 * call it with the request's arguments and the environment. tools/list is
 * this list's schemas and tools/call one lookup in it, so a tool cannot be
 * listed without being callable, or the other way round.
 */
const TOOLS = [
  {
    schema: GET_USAGE_TOOL,
    call: async (args, io) => {
      const r = await getUsage(io);
      return r.ok
        ? {content: r.content, structuredContent: r.structuredContent}
        : toolError(`${r.code}: ${r.message}`);
    },
  },
  {schema: WAITING_TOOL, call: (args, io) => getWaiting(io)},
  {schema: AWAKE_TOOL, call: (args, io) => callAwakeTool(args, io)},
  ...ACCOUNT_TOOLS.map((schema) => ({
    schema, call: (args, io) => callAccountTool(schema.name, args, openStore(io)),
  })),
  ...CODEX_TOOLS.map((schema) => ({
    schema, call: (args, io) => callCodexTool(schema.name, args, openCodexStore(io), io.nowMs ?? Date.now()),
  })),
];
const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.schema.name, t]));

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
      return {tools: TOOLS.map((t) => t.schema)};
    case 'tools/call': {
      const name = msg.params?.name;
      const tool = TOOL_BY_NAME.get(name);
      if (!tool) throw new RpcError(-32602, `Unknown tool: ${name}`);
      // Whatever a tool throws is a tool error the model can read, never a
      // JSON-RPC -32603 that reads as a broken server.
      try {
        return await tool.call(msg.params?.arguments, io);
      } catch (e) {
        return toolError(e.message);
      }
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
      // JSON-RPC 2.0: a request is an object. `null` would throw on `.id` below,
      // outside any catch, and take the server down with it.
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
        reply(null, {error: {code: -32600, message: 'Invalid request'}});
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

// Run when executed directly - by path, or through the npm/npx bin shim's
// symlink (is-main.js compares real paths).
if (isMain(import.meta.url)) {
  main();
}
