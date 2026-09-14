#!/usr/bin/env node
// One JSON editor for install.sh: read, set or delete one dotted path in a
// JSON file, atomically, creating the file when it does not exist and leaving
// every other key exactly as it was. Replaces the inline node heredocs that
// used to do this six times over (settings.json statusLine, ~/.cursor/mcp.json).
//
//   json-edit.mjs get FILE PATH            print the value as JSON, nothing when absent
//   json-edit.mjs set FILE PATH JSON       set the value (JSON literal)
//   json-edit.mjs set-string FILE PATH RAW set a plain string (no quoting needed)
//   json-edit.mjs delete FILE PATH         drop the key (no write when absent)
//   json-edit.mjs encode RAW               print RAW as a JSON string literal
//
// PATH is dotted (mcpServers.claude-usage.args); intermediate objects are
// created on set. A file that exists but is not a JSON object is an error
// (exit 1) rather than silently replaced.

import fs from 'node:fs';
import path from 'node:path';

const [op, file, keyPath, value] = process.argv.slice(2);

function fail(msg) {
  process.stderr.write(`json-edit: ${msg}\n`);
  process.exit(op ? 1 : 2);
}

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
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) fail(`${file} is not a JSON object`);
  return obj;
}

function save(obj) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

const keys = () => keyPath.split('.').filter(Boolean);

function get(obj) {
  let cur = obj;
  for (const k of keys()) {
    if (!cur || typeof cur !== 'object' || !(k in cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

function set(obj, v) {
  const ks = keys();
  let cur = obj;
  for (const k of ks.slice(0, -1)) {
    if (!cur[k] || typeof cur[k] !== 'object' || Array.isArray(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[ks[ks.length - 1]] = v;
}

function del(obj) {
  const ks = keys();
  let cur = obj;
  for (const k of ks.slice(0, -1)) {
    if (!cur || typeof cur !== 'object' || !(k in cur)) return false;
    cur = cur[k];
  }
  const last = ks[ks.length - 1];
  if (!cur || typeof cur !== 'object' || !(last in cur)) return false;
  delete cur[last];
  return true;
}

switch (op) {
  case 'encode':
    process.stdout.write(`${JSON.stringify(file ?? '')}\n`);
    break;
  case 'get': {
    if (!file || !keyPath) fail('get needs FILE PATH');
    const v = get(load());
    if (v !== undefined) process.stdout.write(`${JSON.stringify(v)}\n`);
    break;
  }
  case 'set':
  case 'set-string': {
    if (!file || !keyPath || value === undefined) fail(`${op} needs FILE PATH VALUE`);
    let v = value;
    if (op === 'set') {
      try {
        v = JSON.parse(value);
      } catch {
        fail(`not valid JSON: ${value}`);
      }
    }
    const obj = load();
    set(obj, v);
    save(obj);
    break;
  }
  case 'delete': {
    if (!file || !keyPath) fail('delete needs FILE PATH');
    const obj = load();
    if (del(obj)) save(obj);
    break;
  }
  default:
    fail('usage: json-edit.mjs get|set|set-string|delete FILE PATH [VALUE] | encode RAW');
}
