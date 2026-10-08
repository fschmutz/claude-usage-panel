#!/usr/bin/env node
// Merge or drop this project's Claude Code waiting hooks in settings.json
// without touching anyone else's. install.sh calls:
//
//   hooks-edit.mjs add    FILE COMMAND
//   hooks-edit.mjs remove FILE COMMAND
//
// COMMAND is the exact `node "…/waiting-hook.js"` line we write. A matcher
// group that already contains that command is left alone; we never inject
// into a group the user wrote.

import fs from 'node:fs';
import path from 'node:path';

// The one list of events the hook handles (lib/pure/waiting.js, pinned by
// tests/fixtures/waiting.json): a second copy here drifted the day it grew.
import {WAITING_HOOK_EVENTS as EVENTS} from '../../claude-usage-panel@fschmutz.github.io/lib/pure/waiting.js';

const [op, file, command] = process.argv.slice(2);

function fail(msg) {
  process.stderr.write(`hooks-edit: ${msg}\n`);
  process.exit(1);
}

if ((op !== 'add' && op !== 'remove') || !file || !command)
  fail('usage: hooks-edit.mjs add|remove FILE COMMAND');

function load() {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    fail(`${file} is not valid JSON`);
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj))
    fail(`${file} is not a JSON object`);
  return obj;
}

function realTarget(p) {
  for (let hops = 0; hops < 40; hops++) {
    let st;
    try {
      st = fs.lstatSync(p);
    } catch (e) {
      if (e.code === 'ENOENT') return p;
      throw e;
    }
    if (!st.isSymbolicLink()) return p;
    p = path.resolve(path.dirname(p), fs.readlinkSync(p));
  }
  fail(`${file}: too many levels of symbolic links`);
}

function save(obj) {
  const target = realTarget(file);
  fs.mkdirSync(path.dirname(target), {recursive: true});
  let mode = 0o600;
  try {
    mode = fs.statSync(target).mode & 0o777;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, {mode});
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, target);
}

function ours(entry) {
  return entry?.type === 'command' && String(entry.command ?? '') === command;
}

function add(obj) {
  if (!obj.hooks || typeof obj.hooks !== 'object' || Array.isArray(obj.hooks))
    obj.hooks = {};
  const hook = {type: 'command', command};
  for (const event of EVENTS) {
    const groups = Array.isArray(obj.hooks[event]) ? obj.hooks[event] : [];
    const has = groups.some((g) => Array.isArray(g?.hooks) && g.hooks.some(ours));
    if (!has)
      groups.push({hooks: [hook]});
    obj.hooks[event] = groups;
  }
}

function remove(obj) {
  const hooks = obj.hooks;
  if (!hooks || typeof hooks !== 'object')
    return;
  for (const event of EVENTS) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    const kept = [];
    for (const g of groups) {
      if (!g || typeof g !== 'object') {
        kept.push(g);
        continue;
      }
      const inner = Array.isArray(g.hooks) ? g.hooks.filter((h) => !ours(h)) : g.hooks;
      if (Array.isArray(inner) && inner.length === 0 && Object.keys(g).every((k) => k === 'hooks' || k === 'matcher'))
        continue;
      kept.push(Array.isArray(g.hooks) ? {...g, hooks: inner} : g);
    }
    if (kept.length)
      hooks[event] = kept;
    else
      delete hooks[event];
  }
  if (!Object.keys(hooks).length)
    delete obj.hooks;
}

const obj = load();
if (op === 'add')
  add(obj);
else
  remove(obj);
save(obj);
