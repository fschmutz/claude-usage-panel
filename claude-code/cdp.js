// The smallest Chrome DevTools Protocol client `account login` needs: the
// port a Chrome started with --remote-debugging-port=0 wrote into its
// user-data-dir, its page targets, and one WebSocket per page. Loopback only.
// Node's own fetch and WebSocket (global since Node 22); no dependency.

import fs from 'node:fs';
import path from 'node:path';

/** The port in <user-data-dir>/DevToolsActivePort, or null. Chrome rewrites
 *  the file on every start with a port; one written before `sinceMs` (an
 *  earlier run: its port may belong to anything now) is null. */
export function devtoolsPort(userDataDir, sinceMs = 0) {
  try {
    const file = path.join(userDataDir, 'DevToolsActivePort');
    if (fs.statSync(file).mtimeMs < sinceMs - 1000) return null;
    const port = Number(fs.readFileSync(file, 'utf8').split('\n')[0]);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  } catch {
    return null;
  }
}

/** The page targets on that port ([] when nothing answers). */
export async function pageTargets(port, {fetch: f = globalThis.fetch, timeoutMs = 2000} = {}) {
  try {
    const r = await f(`http://127.0.0.1:${port}/json/list`, {signal: AbortSignal.timeout(timeoutMs)});
    if (!r.ok) return [];
    const list = await r.json();
    return Array.isArray(list) ? list.filter((t) => t?.type === 'page' && typeof t.webSocketDebuggerUrl === 'string') : [];
  } catch {
    return [];
  }
}

/** The browser-level endpoint (to close the browser), or null. */
export async function browserEndpoint(port, {fetch: f = globalThis.fetch, timeoutMs = 2000} = {}) {
  try {
    const r = await f(`http://127.0.0.1:${port}/json/version`, {signal: AbortSignal.timeout(timeoutMs)});
    const v = r.ok ? await r.json() : null;
    return typeof v?.webSocketDebuggerUrl === 'string' ? v.webSocketDebuggerUrl : null;
  } catch {
    return null;
  }
}

/**
 * Open a CDP session on a ws:// endpoint: {send(method, params) -> result,
 * evaluate(expression) -> value, close()}. A protocol error rejects with its
 * message; a closed socket rejects every pending call.
 */
export async function connect(wsUrl, {WebSocket: WS = globalThis.WebSocket, timeoutMs = 5000, callMs = 10_000} = {}) {
  if (typeof WS !== 'function') throw new Error('this Node has no WebSocket (Node 22 or later needed)');
  const ws = new WS(wsUrl);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      ws.close();
      reject(new Error('DevTools did not answer'));
    }, timeoutMs);
    ws.onopen = () => {
      clearTimeout(t);
      resolve();
    };
    ws.onerror = () => {
      clearTimeout(t);
      ws.close();
      reject(new Error('DevTools refused the connection'));
    };
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    let d;
    try {
      d = JSON.parse(typeof m.data === 'string' ? m.data : String(m.data));
    } catch {
      return;
    }
    const p = pending.get(d.id);
    if (!p) return;
    pending.delete(d.id);
    if (d.error) p.reject(new Error(d.error.message ?? 'DevTools error'));
    else p.resolve(d.result ?? {});
  };
  ws.onclose = () => {
    for (const p of pending.values()) p.reject(new Error('DevTools connection closed'));
    pending.clear();
  };
  // every call has a deadline: a renderer that never answers must not hang the login
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    id += 1;
    const n = id;
    const t = setTimeout(() => {
      pending.delete(n);
      reject(new Error(`DevTools did not answer ${method}`));
    }, callMs);
    const settle = (fn) => (v) => {
      clearTimeout(t);
      fn(v);
    };
    pending.set(n, {resolve: settle(resolve), reject: settle(reject)});
    ws.send(JSON.stringify({id: n, method, params}));
  });
  return {
    send,
    async evaluate(expression) {
      const r = await send('Runtime.evaluate', {expression, returnByValue: true});
      if (r.exceptionDetails) throw new Error('page script failed');
      return r.result?.value;
    },
    close() {
      try {
        ws.close();
      } catch {
        // already closed
      }
    },
  };
}
