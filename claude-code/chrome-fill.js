// `claudectl account chrome NAME --fill-google`: fill the Google sign-in of
// NAME's isolated Chrome (account-chrome.js) from credentials a password
// manager injected into this process's environment - a wrapper that unlocks
// the vault, runs `claudectl account chrome NAME --fill-google` with one
// item's login in its env, and locks again. The user runs it in their own
// terminal; no Claude session
// ever sees a value.
//
// The rules, each pinned by tests/chrome-fill.test.js:
// - The values are read from the environment once and the variables deleted
//   at once, before Chrome or anything else is spawned, so no child inherits
//   them (/proc/<pid>/environ).
// - Nothing prints a value: not stdout, not stderr, not an error. The log line
//   is "filled <field> from <env key>".
// - A value goes only into a page whose origin is exactly
//   https://accounts.google.com, re-checked right before each insert; any
//   other origin, plain http or a redirect elsewhere is never filled.
// - The user types `yes` first, at a prompt naming the origin and the env
//   keys (never the values). No `yes`, nothing is sent to the page.
// - The values reach the field through CDP Input.insertText: no clipboard, no
//   temp file, no argv, no process title. 2FA stays on the user's phone.
// - Chrome listens for CDP on 127.0.0.1 only, on a random port, for this run;
//   the default profile cannot be debugged at all (Chrome 136+), and this
//   command never opens it.

import {URL} from 'node:url';

const FILL_ORIGIN = 'https://accounts.google.com';
export const ENV_USER = 'CLAUDECTL_LOGIN_USER';
export const ENV_PASS = 'CLAUDECTL_LOGIN_PASSWORD';

const FIELDS = [
  {field: 'email', selector: 'input[type=email]', key: ENV_USER},
  {field: 'password', selector: 'input[type=password][name=Passwd], input[type=password]', key: ENV_PASS},
];

/** Read the injected credentials and delete them from `env` at once. */
export function takeCredentials(env) {
  const user = env[ENV_USER];
  const pass = env[ENV_PASS];
  delete env[ENV_USER];
  delete env[ENV_PASS];
  if (!user || !pass) {
    throw new Error(`--fill-google needs ${ENV_USER} and ${ENV_PASS} injected by a password manager wrapper`);
  }
  return {[ENV_USER]: user, [ENV_PASS]: pass};
}

/** True only for exactly https://accounts.google.com. */
export function allowedOrigin(url) {
  try {
    return new URL(url).origin === FILL_ORIGIN;
  } catch {
    return false;
  }
}

/** A CDP client over Node's WebSocket: {send(method, params), close()}. */
export async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, {once: true});
    ws.addEventListener('error', () => reject(new Error('CDP connection failed')), {once: true});
  });
  let next = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(String(ev.data));
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`CDP ${msg.error.message}`));
    else p.resolve(msg.result);
  });
  return {
    send(method, params = {}) {
      const id = ++next;
      ws.send(JSON.stringify({id, method, params}));
      return new Promise((resolve, reject) => pending.set(id, {resolve, reject}));
    },
    close: () => ws.close(),
  };
}

/** The page targets of a Chrome debugging on 127.0.0.1:`port`. */
export async function cdpTargets(port) {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`);
  return (await r.json()).filter((t) => t.type === 'page');
}

/**
 * Wait for the Google sign-in page and fill what it asks: the email, then the
 * password, each followed by Enter. io: targets(), connect(wsUrl), ask(prompt)
 * -> answer, log(line), sleep(ms), timeoutMs.
 */
export async function fillGoogle(creds, io) {
  const log = io.log;
  const answer = await io.ask(`Fill the Google sign-in at ${FILL_ORIGIN} with ${ENV_USER} and ${ENV_PASS} `
    + '(values never shown)? Type yes: ');
  if (String(answer ?? '').trim() !== 'yes') {
    log('not approved: nothing filled');
    return [];
  }
  const filled = [];
  const deadline = Date.now() + (io.timeoutMs ?? 5 * 60_000);
  log(`waiting for ${FILL_ORIGIN} in that window (click "Continue with Google" on claude.ai)`);
  while (filled.length < FIELDS.length && Date.now() < deadline) {
    const page = (await io.targets()).find((t) => allowedOrigin(t.url));
    if (page) {
      const cdp = await io.connect(page.webSocketDebuggerUrl);
      try {
        for (const f of FIELDS) {
          if (filled.includes(f.field)) continue;
          if (await fillField(cdp, f, creds[f.key])) {
            filled.push(f.field);
            log(`filled ${f.field} from ${f.key}`);
          }
        }
      } finally {
        cdp.close();
      }
    }
    if (filled.length < FIELDS.length) await io.sleep(500);
  }
  if (filled.length < FIELDS.length) log(`stopped after ${filled.join(', ') || 'nothing'}: finish the sign-in by hand`);
  return filled;
}

/** Focus the visible field and insert `value`, only on the allowed origin. */
async function fillField(cdp, {selector}, value) {
  const focus = `(() => {
    if (location.origin !== ${JSON.stringify(FILL_ORIGIN)}) return 'origin';
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((e) => e.offsetParent !== null && !e.disabled && !e.value);
    if (!el) return 'absent';
    el.focus();
    return document.activeElement === el ? 'ok' : 'focus';
  })()`;
  const r = await cdp.send('Runtime.evaluate', {expression: focus, returnByValue: true});
  if (r?.result?.value !== 'ok') return false;
  await cdp.send('Input.insertText', {text: value});
  await cdp.send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13});
  await cdp.send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13});
  return true;
}
