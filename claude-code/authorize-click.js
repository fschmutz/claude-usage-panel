// The Authorize click of `claudectl account login`, done through Chrome's
// DevTools port instead of by hand. NAME's Chrome is started with
// --remote-debugging-port=0 (`account chrome --devtools`); this finds the
// page carrying OUR authorize request (its `state`), and drives it:
//
//   loading -> authorize page -> window focused -> Authorize enabled -> click
//           -> localhost callback (the CLI ends the login by itself)
//              or a code page (the code goes to the CLI's stdin, never printed)
//
// Why the focus step: claude.ai's consent page keeps Authorize disabled until
// its window has held focus for 700 ms, and disables it again on blur (an
// anti-clickjacking guard; measured live 2026-11-22). A window a background
// process opens on GNOME Wayland gets no focus, so the button stayed greyed
// and the first click only focused the window. Page.bringToFront gives it
// focus the way a click on the window does; nothing else on the page is
// touched, and no check of the page is bypassed.
//
// Every failure names its step: page not loaded, signed out, button missing,
// Authorize stayed disabled, click with no redirect (with the page's
// notice), bot check (hCaptcha held the click without showing a challenge),
// callback refused. A visible hCaptcha challenge after the click is
// never touched: it is for a human, so it is handed over ({manual}) and the
// CLI keeps waiting for the callback. Measured live 2026-11-22, it opens on
// every click made through DevTools (navigator.webdriver is true there).
// No URL query is ever put in a message: it carries the state, and on a code
// page the code itself.

import {URL} from 'node:url';

import {connect as cdpConnect, devtoolsPort, pageTargets} from './cdp.js';

const TIMEOUTS = {port: 20_000, load: 60_000, button: 20_000, redirect: 30_000, poll: 400};
const BUTTON_LABEL = /^(Authorize|Allow|Approve)$/i;

/** What the page shows, read in one evaluate. Never logged as is: `href`
 *  carries the query. */
const PROBE = `(() => {
  const b = [...document.querySelectorAll('button')].find((x) => ${BUTTON_LABEL}.test((x.innerText || '').trim()));
  const r = b && b.getBoundingClientRect();
  const notes = [...document.querySelectorAll('[role=alert],[role=status]')]
    .map((e) => (e.innerText || '').trim()).filter(Boolean).join(' | ');
  // hCaptcha's challenge frame: sized once it engages; 'shown' when a human
  // can see it, 'held' when it sits sized but transparent
  const frame = [...document.querySelectorAll('iframe')].find((f) => /hcaptcha/.test(f.src)
    && /frame=challenge/.test(f.src) && f.getBoundingClientRect().width > 300);
  const challenge = !frame ? null : (!frame.checkVisibility
    || frame.checkVisibility({opacityProperty: true, visibilityProperty: true})) ? 'shown' : 'held';
  return {href: location.href, focus: document.hasFocus(), challenge,
    button: b ? {disabled: b.disabled || b.getAttribute('aria-disabled') === 'true',
      busy: b.getAttribute('aria-busy') === 'true', x: r.x + r.width / 2, y: r.y + r.height / 2,
      visible: r.width > 0 && r.height > 0} : null,
    notes, text: (document.body && document.body.innerText || '').slice(0, 600)};
})()`;

const SCROLL = `(() => {
  const b = [...document.querySelectorAll('button')].find((x) => ${BUTTON_LABEL}.test((x.innerText || '').trim()));
  if (b) b.scrollIntoView({block: 'center'});
  return !!b;
})()`;

function parse(href) {
  try {
    return new URL(href);
  } catch {
    return null;
  }
}

/** claude.ai and claude.com (platform.claude.com among them), over https:
 *  the only origins a consent or a code page is ever read on. The state
 *  alone binds the page to our request, not to Anthropic: a page anywhere
 *  that carried it in its URL and an Authorize button would be clicked. */
function anthropicPage(u) {
  return u.protocol === 'https:' && ['claude.ai', 'claude.com'].some((h) => u.hostname === h
    || u.hostname.endsWith(`.${h}`));
}

/** Where a page stands, from one probe: loading | signed-out | no-button |
 *  disabled | ready | callback | code | error-page. `code` only for a code
 *  page answering OUR state; `code` and the consent steps only on
 *  claude.ai / claude.com. */
export function authorizeStep(probe, state) {
  if (!probe || typeof probe.href !== 'string') return 'loading';
  if (probe.href.startsWith('chrome-error://')) return 'error-page';
  const u = parse(probe.href);
  if (!u) return 'loading';
  if (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return 'callback';
  if (!anthropicPage(u)) return 'loading';
  if (/\/oauth\/code\/callback\/?$/.test(u.pathname) && u.searchParams.get('code')
    && u.searchParams.get('state') === state) return 'code';
  if (/^\/(login|magic-link)(\/|$)/.test(u.pathname)) return 'signed-out';
  // claude.com/cai/oauth/authorize only redirects to the consent page
  if (/\/oauth\/authorize\/?$/.test(u.pathname) && !u.pathname.startsWith('/cai/')) {
    if (!probe.button?.visible) return 'no-button';
    return probe.button.disabled || probe.button.busy ? 'disabled' : 'ready';
  }
  return 'loading';
}

/** The one-time code a code page carries, as the CLI's prompt takes it. */
export function pastedCode(href) {
  const u = parse(href);
  return u ? `${u.searchParams.get('code')}#${u.searchParams.get('state')}` : null;
}

/** origin + path: safe to print. */
export function where(href) {
  if (typeof href !== 'string') return 'nowhere';
  if (href.startsWith('chrome-error://')) return 'a Chrome error page';
  const u = parse(href);
  return u ? `${u.origin}${u.pathname}` : 'an unreadable URL';
}

/** A line of what the page says, for a failure: its notices, else the start
 *  of its text. Nothing from a page whose URL carries a code. */
export function pageSays(probe) {
  if (!probe || (/[?&]code=[^&]/.test(probe.href ?? '') && !/\/oauth\/authorize/.test(probe.href ?? ''))) return '';
  const said = (probe.notes || probe.text || '').replace(/\s+/g, ' ').trim();
  return said ? `: "${said.slice(0, 240)}"` : '';
}

const stepError = (msg) => Object.assign(new Error(msg), {step: true});
/** A failure after the click: the consent may still land, so the caller
 *  gives the CLI a grace period before stopping it. */
const afterClick = (msg) => Object.assign(stepError(msg), {afterClick: true});

/**
 * Click Authorize for the request `authorizeUrl` in the Chrome whose
 * user-data-dir is `profileDir`. Resolves {via: 'callback' | 'code'} once the
 * redirect left the page, or {manual: reason} when that Chrome has no
 * DevTools port answering for our page (it was already open without one: the
 * caller waits for a human click). Throws a step error otherwise. `stopped()`
 * true ends it early (the CLI exited): resolves {stopped: true}. `onCode` gets
 * the one-time code of a code page.
 */
export async function clickAuthorize({profileDir, authorizeUrl, stopped = () => false, onCode = () => {},
  io = {}, timeouts = {}, since = 0}) {
  const t = {...TIMEOUTS, ...timeouts};
  const dev = {port: devtoolsPort, targets: pageTargets, connect: cdpConnect, ...io.devtools};
  const now = io.clock ?? Date.now;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const state = parse(authorizeUrl)?.searchParams.get('state');
  if (!state) throw stepError('the CLI gave an authorize URL with no state');

  // 1. the DevTools port and OUR page on it
  let target = null;
  for (const end = now() + t.port; !target; await sleep(t.poll)) {
    if (stopped()) return {stopped: true};
    const port = dev.port(profileDir, since); // a port file older than this run is not trusted
    if (port) target = (await dev.targets(port)).find((x) => typeof x.url === 'string' && x.url.includes(state));
    if (!target && now() > end) {
      return {manual: `${port ? 'its DevTools port shows no page for this request'
        : 'its Chrome has no DevTools port of this run (it was already open)'} - click inside that window, then Authorize`};
    }
  }
  const page = await dev.connect(target.webSocketDebuggerUrl);
  try {
    return await drive(page);
  } finally {
    page.close();
  }

  async function drive(p) {
    let last = null;
    let step = 'loading';
    const probe = async () => {
      try {
        last = await p.evaluate(PROBE);
      } catch {
        last = null; // a navigation in flight
      }
      step = authorizeStep(last, state);
      return step;
    };
    // 2. the authorize page, loaded and signed in
    for (const end = now() + t.load; ; await sleep(t.poll)) {
      if (stopped()) return {stopped: true};
      await probe();
      if (step === 'signed-out') {
        throw stepError(`signed out: the page went to ${where(last.href)} - sign in to claude.ai in its Chrome ` +
          'first (the emailed link), then retry');
      }
      if (step === 'error-page') throw stepError(`page not loaded: Chrome shows an error page${pageSays(last)}`);
      if (['no-button', 'disabled', 'ready'].includes(step)) break;
      if (step === 'callback' || step === 'code') break; // an earlier consent answered by itself
      if (now() > end) throw stepError(`page not loaded within ${t.load / 1000}s (last at ${where(last?.href)})`);
    }
    // 3. focus, then Authorize enabled
    let lastFront = 0;
    for (const end = now() + t.button; step !== 'ready' && step !== 'callback' && step !== 'code';
      await sleep(t.poll)) {
      if (stopped()) return {stopped: true};
      if (last && !last.focus && now() - lastFront > 2000) {
        lastFront = now();
        await p.send('Page.bringToFront').catch(() => {});
      }
      await probe();
      if (step === 'signed-out') throw stepError(`signed out: the page went to ${where(last.href)}`);
      if (now() > end) {
        if (step === 'no-button') throw stepError(`button missing: no Authorize on ${where(last?.href)}${pageSays(last)}`);
        if (step === 'disabled') {
          throw stepError(`Authorize stayed disabled for ${t.button / 1000}s (window focused: ${last?.focus === true})` +
            `${pageSays(last)}`);
        }
        throw stepError(`page not loaded: left the authorize page for ${where(last?.href)}`);
      }
    }
    // 4. click (a real mouse press at the button's centre), then the redirect
    let clicks = 0;
    for (const end = now() + t.redirect; ; await sleep(t.poll)) {
      if (stopped()) return {stopped: true};
      if (step === 'callback') return {via: 'callback'};
      // the CLI's success page (or any page past the consent) once clicked
      if (clicks && last && step === 'loading') return {via: 'callback'};
      if (step === 'code') {
        const code = pastedCode(last.href);
        if (code) onCode(code);
        return {via: 'code'};
      }
      if (clicks && last?.challenge === 'shown') {
        return {manual: 'bot check: claude.ai answered the Authorize click with an hCaptcha challenge ' +
          '(it does on a click made through DevTools) - solve it in that Chrome window; the login ends by itself'};
      }
      if (step === 'error-page') {
        if (clicks) throw afterClick('callback refused: Chrome could not reach the CLI\'s localhost callback');
        throw stepError(`page not loaded: Chrome shows an error page${pageSays(last)}`);
      }
      // one click only: a second could submit the consent twice
      if (step === 'ready' && clicks === 0) {
        await p.evaluate(SCROLL).catch(() => false);
        await probe();
        if (step === 'ready') {
          await click(p, last.button);
          clicks += 1;
        }
      }
      if (now() > end) {
        if (clicks && last?.challenge === 'held') {
          throw afterClick('bot check: claude.ai\'s hCaptcha held the Authorize click without showing a challenge ' +
            '(it engages on a click made through DevTools)');
        }
        if (clicks) {
          throw afterClick(`click with no redirect after ${t.redirect / 1000}s (still on ${where(last?.href)})` +
            `${pageSays(last)}`);
        }
        throw stepError(`Authorize never became clickable${pageSays(last)}`);
      }
      await probe();
    }
  }
}

async function click(p, {x, y}) {
  const at = {x, y, button: 'left', clickCount: 1};
  await p.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x, y});
  await p.send('Input.dispatchMouseEvent', {type: 'mousePressed', ...at});
  await p.send('Input.dispatchMouseEvent', {type: 'mouseReleased', ...at});
}

/** Close a Chrome we started with a DevTools port (the port must not outlive
 *  the login: anything local could drive a signed-in claude.ai through it). */
export async function closeBrowser(endpoint, connect = cdpConnect) {
  if (!endpoint) return false;
  try {
    const b = await connect(endpoint);
    await b.send('Browser.close').catch(() => {});
    b.close();
    return true;
  } catch {
    return false;
  }
}
