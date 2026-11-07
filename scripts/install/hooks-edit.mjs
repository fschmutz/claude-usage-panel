#!/usr/bin/env node
// Merge or drop this project's Claude Code hooks in settings.json without
// touching anyone else's. install.sh calls:
//
//   hooks-edit.mjs add    FILE COMMAND [SET]
//   hooks-edit.mjs remove FILE COMMAND [SET]
//
// SET is `waiting` (default: the waiting-hook.js command on every event of
// WAITING_HOOK_EVENTS) or `pause` (pause-hook.js: `COMMAND wait` on
// SessionStart / Stop as asyncRewake, `COMMAND pretool` on PreToolUse, from
// lib/pure/pause.js pauseHookEntries). A hook is ours when its command is
// COMMAND or starts with `COMMAND `. add replaces ours in place (a changed
// timeout reaches an update), drops ours from events the set no longer
// uses, and never injects into a group the user wrote; remove drops ours
// from every event.

import {JsonFileError, loadObject, saveObject} from '../lib/json-file.mjs';

// The one list of events each set uses (lib/pure, pinned by the fixtures):
// a second copy here drifted the day it grew.
import {WAITING_HOOK_EVENTS} from '../../claude-usage-panel@fschmutz.github.io/lib/pure/waiting.js';
import {pauseHookEntries} from '../../claude-usage-panel@fschmutz.github.io/lib/pure/pause.js';

const [op, file, command, set = 'waiting'] = process.argv.slice(2);

function fail(msg) {
  process.stderr.write(`hooks-edit: ${msg}\n`);
  process.exit(1);
}

if ((op !== 'add' && op !== 'remove') || !file || !command || !['waiting', 'pause'].includes(set))
  fail('usage: hooks-edit.mjs add|remove FILE COMMAND [waiting|pause]');

const ENTRIES = set === 'pause' ? pauseHookEntries(command)
  : WAITING_HOOK_EVENTS.map((event) => ({event, hook: {type: 'command', command}}));

// load / save over scripts/lib/json-file.mjs, shared with json-edit.mjs.
function load() {
  try {
    return loadObject(file);
  } catch (e) {
    if (e instanceof JsonFileError) fail(e.message);
    throw e;
  }
}

function save(obj) {
  try {
    saveObject(file, obj);
  } catch (e) {
    if (e instanceof JsonFileError) fail(e.message);
    throw e;
  }
}

function ours(entry) {
  const cmd = String(entry?.command ?? '');
  return entry?.type === 'command' && (cmd === command || cmd.startsWith(`${command} `));
}

const isGroup = (g) => g && typeof g === 'object' && Array.isArray(g.hooks);

// Drop ours from every event `keep` does not name; a group left empty that
// held nothing but hooks (and a matcher) goes too.
function strip(hooks, keep = () => false) {
  for (const event of Object.keys(hooks)) {
    if (keep(event) || !Array.isArray(hooks[event])) continue;
    const kept = [];
    for (const g of hooks[event]) {
      if (!isGroup(g)) {
        kept.push(g);
        continue;
      }
      const inner = g.hooks.filter((h) => !ours(h));
      if (inner.length === 0 && Object.keys(g).every((k) => k === 'hooks' || k === 'matcher')) continue;
      kept.push({...g, hooks: inner});
    }
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
}

function add(obj) {
  if (!obj.hooks || typeof obj.hooks !== 'object' || Array.isArray(obj.hooks))
    obj.hooks = {};
  const events = new Set(ENTRIES.map((e) => e.event));
  strip(obj.hooks, (event) => events.has(event));
  for (const {event, matcher, hook} of ENTRIES) {
    const groups = Array.isArray(obj.hooks[event]) ? obj.hooks[event] : [];
    let has = false;
    for (const g of groups) {
      if (!isGroup(g)) continue;
      g.hooks = g.hooks.map((h) => {
        if (!ours(h)) return h;
        has = true;
        return {...hook};
      });
    }
    if (!has)
      groups.push(matcher === undefined ? {hooks: [{...hook}]} : {matcher, hooks: [{...hook}]});
    obj.hooks[event] = groups;
  }
}

function remove(obj) {
  const hooks = obj.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks))
    return;
  strip(hooks);
  if (!Object.keys(hooks).length)
    delete obj.hooks;
}

const obj = load();
if (op === 'add')
  add(obj);
else
  remove(obj);
save(obj);
