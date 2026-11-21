// `claudectl account chrome [NAME] --check`: does Claude-in-Chrome answer
// NAME, and why not. The verdict is a real probe, never a guess from files:
// `claude -p --chrome` as NAME (directly for the current login, through
// `account exec` for any other) asked to call tabs_context_mcp once, read as
// stream-json so the tool's own result decides, never the model's prose. The
// init line's `mcp_servers: connected` and the deferred-tool `tool_reference`
// result say nothing about the extension, so neither counts.
//
// Every saved account is probed, one after the other (an exec run points the
// main Chrome's native-host manifest at its own dir until it ends, so two at
// once would fight over it), which tells which saved account, if any, the
// extensions answer. A probe that connects proves SOME Chrome answers that
// account: it is the main one for certain only when that account's own
// isolated Chrome is not running with the extension.
//
// The reasons printed for NOT CONNECTED are read from the filesystem (the
// live native host, each manifest, the extension's folder, the claude.ai
// cookie, Chrome's SingletonLock); "signed in to another account" is the
// inference left once those are fine, and says so.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn as nodeSpawn} from 'node:child_process';

import {EXTENSION_ID, openAccountChrome} from './account-chrome.js';
import {BROWSER_DIRS, NATIVE_HOST, openAccountExec} from './account-exec.js';
import {openStore} from './accounts.js';
import {claudeBinary} from './tools.js';

export const PROBE_TOOL = 'mcp__claude-in-chrome__tabs_context_mcp';
export const PROBE_PROMPT = `Call ${PROBE_TOOL} once, then stop.`;
const PROBE_TIMEOUT_MS = 120_000;

/** The probe's command line: no user settings, hooks or session file. */
export function probeArgv(claude) {
  return [claude, '-p', '--chrome', `--allowedTools=${PROBE_TOOL}`, '--output-format', 'stream-json',
    '--verbose', '--setting-sources', 'project', '--no-session-persistence', '--model', 'haiku'];
}

const textOf = (content) => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n') : '');
const firstLine = (s) => s.trim().split('\n')[0].slice(0, 200);

/**
 * The probe's verdict from its stream-json output: {verdict: 'connected' |
 * 'not-connected' | 'inconclusive', detail}. Only the tool_result paired
 * with a tabs_context_mcp tool_use counts.
 */
export function probeVerdict(stream) {
  const ids = new Set();
  let result = null;
  let final = null;
  for (const line of String(stream).split('\n')) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const content = Array.isArray(msg?.message?.content) ? msg.message.content : [];
    if (msg?.type === 'assistant') {
      for (const c of content) if (c?.type === 'tool_use' && c.name === PROBE_TOOL) ids.add(c.id);
    } else if (msg?.type === 'user') {
      for (const c of content) {
        if (c?.type === 'tool_result' && ids.has(c.tool_use_id) && !result) result = c;
      }
    } else if (msg?.type === 'result') {
      final = msg;
    }
  }
  if (result) {
    const text = textOf(result.content);
    if (/not connected/i.test(text)) return {verdict: 'not-connected', detail: firstLine(text)};
    if (result.is_error) return {verdict: 'not-connected', detail: firstLine(text) || 'the tool failed'};
    return {verdict: 'connected', detail: firstLine(text)};
  }
  const why = typeof final?.result === 'string' && final.result.trim() ? firstLine(final.result)
    : final?.subtype ?? 'no output';
  return {verdict: 'inconclusive', detail: `the probe never called ${PROBE_TOOL} (${why})`};
}

/**
 * io: the store's io plus spawn, claudeBin, probeTimeoutMs, tmpdir.
 */
export function openChromeCheck(io = {}) {
  const store = openStore(io);
  const chrome = openAccountChrome(io);
  const exec = openAccountExec(io);
  const env = io.env ?? process.env;
  const platform = io.platform ?? process.platform;
  const home = io.homedir ?? os.homedir();
  const spawn = (...a) => (io.spawn ?? nodeSpawn)(...a);
  const timeoutMs = io.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  const cwd = io.tmpdir ?? os.tmpdir(); // no project CLAUDE.md, no project settings

  /** Feed the prompt, collect stdout, stop at the deadline. */
  function watch(child, timer) {
    let out = '';
    child.stdout?.on('data', (d) => {
      out += d;
    });
    child.stdin?.end(`${PROBE_PROMPT}\n`);
    timer.ref = setTimeout(() => {
      timer.hit = true;
      child.kill?.('SIGTERM');
    }, timeoutMs);
    return () => out;
  }

  /** One probe as `name`: {verdict, detail}. Never throws. */
  async function probe(name) {
    const argv = probeArgv(claudeBinary(io));
    const stdio = ['pipe', 'pipe', 'pipe'];
    const timer = {};
    let read = () => '';
    try {
      if (store.liveAccountName() === name) {
        await new Promise((resolve, reject) => {
          const child = spawn(argv[0], argv.slice(1), {stdio, cwd, env});
          read = watch(child, timer);
          child.on('error', reject);
          child.on('exit', resolve);
        });
      } else {
        await exec.exec(name, argv, {stdio, cwd, onSpawn: (child) => {
          read = watch(child, timer);
        }});
      }
    } catch (e) {
      return {verdict: 'inconclusive', detail: `the probe could not run: ${e.message}`};
    } finally {
      clearTimeout(timer.ref);
    }
    if (timer.hit) return {verdict: 'inconclusive', detail: `the probe timed out after ${Math.round(timeoutMs / 1000)} s`};
    return probeVerdict(read());
  }

  /** A manifest's host path, or null when absent or unreadable. */
  function manifestHost(file) {
    try {
      const m = JSON.parse(fs.readFileSync(file, 'utf8'));
      return typeof m?.path === 'string' ? m.path : null;
    } catch {
      return null;
    }
  }

  /** The user's main Google Chrome: its manifest, which of its profiles hold
   *  the extension (by their Chrome names), whether it runs. */
  function mainChrome() {
    const rel = (BROWSER_DIRS[platform] ?? [])[0];
    if (!rel) return null;
    const dir = path.join(home, rel);
    let names = {};
    try {
      names = JSON.parse(fs.readFileSync(path.join(dir, 'Local State'), 'utf8'))?.profile?.info_cache ?? {};
    } catch {
      // no Local State: folder names only
    }
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      // no main Chrome at all
    }
    const profiles = entries.filter((e) => chrome.hasExtension(path.join(dir, e)))
      .map((e) => (typeof names[e]?.name === 'string' ? `${e} (${names[e].name})` : e));
    const manifest = path.join(dir, 'NativeMessagingHosts', NATIVE_HOST);
    return {dir, manifest, host: manifestHost(manifest), profiles, running: chrome.running(dir)};
  }

  /** Why `name` is not answered, from what the files say. */
  function reasons(name, own, main, others) {
    const out = [];
    const host = chrome.liveHost();
    if (!fs.existsSync(host)) out.push(`native host missing: ${host} (run \`claude\` once and type /chrome)`);
    if (!own.extension) out.push(`${name}'s own Chrome: extension missing (\`claudectl account chrome ${name}\` opens its Web Store page)`);
    if (own.signedIn === false) out.push(`${name}'s own Chrome: not signed in to claude.ai`);
    if (own.extension && own.extensionSignedIn === false) {
      out.push(`${name}'s own Chrome: the extension itself is not signed in (\`claudectl account chrome ${name}\` opens its page: Sign in, Authorize)`);
    }
    if (!own.running) out.push(`${name}'s own Chrome: not running (\`claudectl account chrome ${name}\` starts it; it does not come back by itself after a reboot)`);
    if (!own.manifest) out.push(`${name}'s own Chrome: no native-host manifest yet (launch it once)`);
    if (main) {
      if (!main.host) out.push(`main Chrome: no native-host manifest at ${main.manifest}`);
      else if (!fs.existsSync(main.host)) out.push(`main Chrome: its manifest names a missing host ${main.host}`);
      if (!main.profiles.length) out.push('main Chrome: extension not installed in any profile');
      else if (!main.running) out.push('main Chrome: not running');
      else if (others.length) out.push(`the extension answers ${others.join(', ')}: signed in to that claude.ai account (inferred)`);
      else out.push('main Chrome: its extension answers none of the saved accounts: signed in to an unsaved claude.ai account or signed out (inferred)');
    }
    return out;
  }

  /**
   * The full check for NAME (default: the current login): {name, connected,
   * verdict, detail, own, main, probes: [{name, verdict, detail, where}],
   * reasons}. `onProbe(name)` is called before each probe (progress).
   */
  async function check(name, {onProbe = () => {}} = {}) {
    const profile = chrome.resolve(name);
    const dir = chrome.profileDir(profile.name);
    const own = {...chrome.state(profile.name),
      manifest: manifestHost(path.join(dir, 'NativeMessagingHosts', NATIVE_HOST)) !== null};
    const order = [profile.name, ...store.listProfiles().map((p) => p.name).filter((n) => n !== profile.name)];
    const probes = [];
    for (const n of order) {
      onProbe(n);
      const r = await probe(n);
      let where = null;
      if (r.verdict === 'connected') {
        const s = chrome.state(n);
        where = s.running && s.extension ? `main Chrome or ${n}'s own Chrome` : 'main Chrome';
      }
      probes.push({name: n, ...r, where});
    }
    // read after the probes: an exec run points the main manifest at its own dir until it ends
    const main = mainChrome();
    const mine = probes[0];
    const others = probes.slice(1).filter((p) => p.verdict === 'connected').map((p) => p.name);
    return {
      name: profile.name, connected: mine.verdict === 'connected', verdict: mine.verdict, detail: mine.detail,
      extensionId: EXTENSION_ID, own, main, probes,
      reasons: mine.verdict === 'connected' ? [] : reasons(profile.name, own, main, others),
    };
  }

  return {probe, check, mainChrome};
}
