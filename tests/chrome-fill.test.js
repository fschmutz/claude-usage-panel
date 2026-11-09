// `account chrome --fill-google`: the injected credentials go only into the
// Google sign-in page, only after a typed yes, and are never printed. The CDP
// side is a fake that records every call; no Chrome runs.
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {ENV_PASS, ENV_USER, allowedOrigin, fillGoogle, takeCredentials} from '../claude-code/chrome-fill.js';

const USER = 'someone@example.test';
const PASS = 'pw-SECRET-7f3a';

/** A fake browser: pages by url; each page answers the focus probe per its state. */
function browser(pages) {
  const calls = [];
  const lines = [];
  return {
    calls, lines,
    io: {
      targets: async () => pages.map((p, i) => ({type: 'page', url: p.url, webSocketDebuggerUrl: `ws://fake/${i}`})),
      connect: async (ws) => {
        const page = pages[Number(ws.split('/').pop())];
        return {
          async send(method, params) {
            calls.push({page: page.url, method, params});
            if (method === 'Runtime.evaluate') {
              if (!allowedOrigin(page.url)) return {result: {value: 'origin'}};
              const want = page.fields.shift();
              return {result: {value: want ? 'ok' : 'absent'}};
            }
            return {};
          },
          close() {},
        };
      },
      log: (l) => lines.push(l),
      sleep: async () => {},
      timeoutMs: 50,
    },
  };
}

const inserted = (calls) => calls.filter((c) => c.method === 'Input.insertText');
const everyOutput = (b) => JSON.stringify(b.lines);

test('fill: email then password go into accounts.google.com, after yes; no value is printed', async () => {
  const b = browser([{url: 'https://accounts.google.com/v3/signin/identifier', fields: ['email', 'password']}]);
  const filled = await fillGoogle({[ENV_USER]: USER, [ENV_PASS]: PASS}, {...b.io, ask: async () => 'yes'});
  assert.deepEqual(filled, ['email', 'password']);
  assert.deepEqual(inserted(b.calls).map((c) => c.params.text), [USER, PASS]);
  assert.deepEqual(b.lines.filter((l) => l.startsWith('filled')), [`filled email from ${ENV_USER}`, `filled password from ${ENV_PASS}`]);
  assert.ok(!everyOutput(b).includes(PASS) && !everyOutput(b).includes(USER), 'no value in any line');
});

test('fill: without a typed yes nothing reaches any page', async () => {
  for (const answer of ['', 'y', 'YES ', 'no', null]) {
    const b = browser([{url: 'https://accounts.google.com/', fields: ['email', 'password']}]);
    assert.deepEqual(await fillGoogle({[ENV_USER]: USER, [ENV_PASS]: PASS}, {...b.io, ask: async () => answer}), []);
    assert.equal(b.calls.length, 0, `answer ${JSON.stringify(answer)}`);
  }
});

test('fill: any other origin, plain http or a look-alike host is never filled', async () => {
  const evil = ['http://accounts.google.com/', 'https://accounts.google.com.evil.test/', 'https://evil.test/?accounts.google.com',
    'https://claude.ai/login', 'https://accounts.google.co/'];
  for (const url of evil) assert.equal(allowedOrigin(url), false, url);
  const b = browser(evil.map((url) => ({url, fields: ['email', 'password']})));
  assert.deepEqual(await fillGoogle({[ENV_USER]: USER, [ENV_PASS]: PASS}, {...b.io, ask: async () => 'yes'}), []);
  assert.equal(inserted(b.calls).length, 0);
  assert.match(b.lines.at(-1), /stopped after nothing: finish the sign-in by hand/);
});

test('fill: a page that navigated away between probe and insert is not filled (origin re-read in the probe)', async () => {
  // the probe itself runs in the page and reports 'origin' when it is not Google
  const b = browser([{url: 'https://accounts.google.com/', fields: []}]);
  const page = b.io.connect;
  b.io.connect = async (ws) => {
    const c = await page(ws);
    return {...c, send: async (m, p) => (m === 'Runtime.evaluate' ? {result: {value: 'origin'}} : c.send(m, p))};
  };
  assert.deepEqual(await fillGoogle({[ENV_USER]: USER, [ENV_PASS]: PASS}, {...b.io, ask: async () => 'yes'}), []);
  assert.equal(inserted(b.calls).length, 0);
});

test('credentials: read once, deleted from the environment at once; missing ones are refused without echo', () => {
  const env = {[ENV_USER]: USER, [ENV_PASS]: PASS, OTHER: '1'};
  assert.deepEqual(takeCredentials(env), {[ENV_USER]: USER, [ENV_PASS]: PASS});
  assert.deepEqual(env, {OTHER: '1'}, 'no child spawned after this inherits them');
  const half = {[ENV_USER]: USER};
  assert.throws(() => takeCredentials(half), (e) => !e.message.includes(USER) && /needs CLAUDECTL_LOGIN_USER/.test(e.message));
  assert.deepEqual(half, {}, 'deleted even when refused');
});
