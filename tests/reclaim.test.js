// Dev-cache reclaim: the catalog, the plan rules and the move. Everything runs
// against a throwaway HOME with a fake trash, and the assertions that matter
// are the ones about what does NOT happen - scanning writes nothing, a run
// without a confirmation moves nothing, history is kept unless it is named and
// asked for, and what does move is still on disk afterwards.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {main as claudectl} from '../claude-code/claudectl.js';
import {openReclaim} from '../claude-code/reclaim.js';
import {
  formatBytes, reclaimCatalog, reclaimDefaultIds, reclaimIds, reclaimPlan,
} from '../claude-code/reclaim-contract.js';
import * as pure from '../claude-usage-panel@fschmutz.github.io/lib/pure.js';

const NOW = Date.parse('2026-09-13T11:46:40Z');

function world() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-reclaim-'));
  const io = {homedir: home, platform: 'linux', env: {}, nowMs: NOW};
  const fill = (rel, bytes) => {
    const dir = path.join(home, rel);
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(dir, 'blob'), 'x'.repeat(bytes));
    return dir;
  };
  return {home, io, fill, r: openReclaim(io)};
}

// ── the contract, in both JS ports ──────────────────────────────────────────────

for (const [portName, port] of [['pure/reclaim.js', pure], ['reclaim-contract.js', {
  formatBytes, reclaimCatalog, reclaimDefaultIds, reclaimIds, reclaimPlan,
}]]) {
  test(`${portName} - the catalog is the same fixed list in both ports`, () => {
    assert.deepEqual(port.reclaimIds(), [
      'claude-shell-snapshots', 'claude-statsig', 'claude-todos', 'claude-downloads',
      'claude-projects', 'panel-session-index',
      'cursor-cache', 'cursor-cached-data', 'cursor-code-cache', 'cursor-gpu-cache',
      'cursor-logs', 'codex-logs', 'codex-sessions',
    ]);
    // A default run never reaches for anything nothing regenerates.
    assert.deepEqual(
      port.reclaimIds().filter((id) => !port.reclaimDefaultIds().includes(id)),
      ['claude-projects', 'codex-sessions']);
  });

  test(`${portName} - every path is expanded, and per-platform entries follow the platform`, () => {
    const dirs = {
      home: '/h', claudeHome: '/h/.claude', codexHome: '/h/.codex',
      xdgCache: '/h/.cache', xdgConfig: '/h/.config',
    };
    const linux = port.reclaimCatalog(dirs, 'linux');
    const mac = port.reclaimCatalog(dirs, 'darwin');
    assert.equal(linux.length, port.reclaimIds().length);
    assert.equal(mac.length, port.reclaimIds().length);
    for (const e of [...linux, ...mac]) assert.doesNotMatch(e.path, /\{/, e.id);
    const pathOf = (list, id) => list.find((e) => e.id === id).path;
    assert.equal(pathOf(linux, 'cursor-cache'), '/h/.config/Cursor/Cache');
    assert.equal(pathOf(mac, 'cursor-cache'), '/h/Library/Application Support/Cursor/Cache');
    assert.equal(pathOf(linux, 'claude-projects'), '/h/.claude/projects');
  });

  test(`${portName} - the plan refuses what it should, and says why`, () => {
    const scanned = [
      {id: 'claude-statsig', kind: 'cache', path: '/a', bytes: 100},
      {id: 'cursor-logs', kind: 'logs', path: '/b', bytes: 0},
      {id: 'claude-projects', kind: 'history', path: '/c', bytes: 900},
    ];
    const plain = port.reclaimPlan(scanned, ['claude-statsig', 'cursor-logs', 'claude-projects', 'nope']);
    assert.deepEqual(plain.targets.map((t) => t.id), ['claude-statsig']);
    assert.equal(plain.totalBytes, 100);
    assert.deepEqual(plain.refused, [
      {id: 'cursor-logs', why: 'empty'},
      {id: 'claude-projects', why: 'history'},
      {id: 'nope', why: 'unknown'},
    ]);
    // History moves only when it is named AND asked for out loud.
    const asked = port.reclaimPlan(scanned, ['claude-projects'], {includeHistory: true});
    assert.deepEqual(asked.targets.map((t) => t.id), ['claude-projects']);
    // …and never by a default run, even then.
    assert.deepEqual(
      port.reclaimPlan(scanned, null, {includeHistory: true}).targets.map((t) => t.id),
      ['claude-statsig']);
  });

  test(`${portName} - sizes read the same in both ports`, () => {
    assert.equal(port.formatBytes(0), '0 B');
    assert.equal(port.formatBytes(999), '999 B');
    assert.equal(port.formatBytes(1024), '1.0 KB');
    assert.equal(port.formatBytes(1536), '1.5 KB');
    assert.equal(port.formatBytes(1024 ** 3 * 1.44), '1.4 GB');
    assert.equal(port.formatBytes(-1), '-');
    assert.equal(port.formatBytes('nope'), '-');
  });
}

// ── the I/O ─────────────────────────────────────────────────────────────────────

test('scanning writes nothing at all - not even the directories it looks for', () => {
  const {home, r} = world();
  const before = fs.readdirSync(home);
  const scanned = r.scan();
  assert.deepEqual(fs.readdirSync(home), before);
  assert.equal(scanned.every((e) => e.exists === false), true);
  assert.equal(scanned.every((e) => e.human === '0 B'), true);
});

test('a scan measures a whole tree, and never follows a symlink out of it', () => {
  const {home, io, fill, r} = world();
  fill('.claude/statsig', 2048);
  const big = fill('elsewhere', 100_000);
  fs.symlinkSync(big, path.join(home, '.claude', 'statsig', 'link'));
  const statsig = r.scan().find((e) => e.id === 'claude-statsig');
  assert.equal(statsig.exists, true);
  // 2048 bytes of blob plus the link's own entry - not the 100 kB it points at.
  assert.ok(statsig.bytes >= 2048 && statsig.bytes < 10_000, `${statsig.bytes}`);
  assert.equal(openReclaim(io).scan().find((e) => e.id === 'cursor-cache').exists, false);
});

test('reclaim refuses to run without an explicit confirmation', () => {
  const {fill, r} = world();
  fill('.claude/statsig', 100);
  assert.throws(() => r.reclaim(null), /needs an explicit confirmation/);
  assert.equal(r.scan().find((e) => e.id === 'claude-statsig').exists, true);
});

test('a confirmed run moves the caches to the trash - and they are still there', () => {
  const {home, fill, r} = world();
  fill('.claude/statsig', 100);
  fill('.claude/todos', 50);
  const projects = fill('.claude/projects', 5000);

  const result = r.reclaim(null, {confirm: true});
  assert.deepEqual(result.moved.map((m) => m.id).sort(), ['claude-statsig', 'claude-todos']);
  assert.equal(result.failed.length, 0);
  // Gone from where they were...
  assert.equal(fs.existsSync(path.join(home, '.claude', 'statsig')), false);
  // ...and recoverable from where they went.
  for (const m of result.moved) assert.equal(fs.existsSync(m.trashedTo), true);
  // The freedesktop record is what makes the desktop's "put back" work.
  const info = path.join(home, '.local/share/Trash/info/statsig.trashinfo');
  assert.match(fs.readFileSync(info, 'utf8'), /^\[Trash Info\]\nPath=.*statsig\nDeletionDate=/);
  // History was never even a candidate: a default run does not consider it,
  // so it is not something that had to be refused.
  assert.equal(fs.existsSync(projects), true);
  assert.equal(result.moved.some((m) => m.id === 'claude-projects'), false);
});

test('two runs of the same cache do not collide in the trash', () => {
  const {home, fill, r} = world();
  fill('.claude/statsig', 100);
  r.reclaim(['claude-statsig'], {confirm: true});
  fill('.claude/statsig', 100);
  const second = r.reclaim(['claude-statsig'], {confirm: true});
  assert.equal(path.basename(second.moved[0].trashedTo), 'statsig.2');
  assert.deepEqual(
    fs.readdirSync(path.join(home, '.local/share/Trash/files')).sort(), ['statsig', 'statsig.2']);
});

test('history moves only when it is named and asked for, and the run is written down', () => {
  const {home, fill, r} = world();
  fill('.claude/projects', 4096);
  assert.deepEqual(r.reclaim(['claude-projects'], {confirm: true}).moved, []);
  assert.equal(fs.existsSync(path.join(home, '.claude', 'projects')), true);

  const asked = r.reclaim(['claude-projects'], {confirm: true, includeHistory: true});
  assert.deepEqual(asked.moved.map((m) => m.id), ['claude-projects']);
  const log = r.readLog();
  assert.equal(log.length, 1, 'the run that moved nothing wrote no log line');
  assert.equal(log[0].at, new Date(NOW).toISOString());
  assert.equal(log[0].moved[0].from, path.join(home, '.claude', 'projects'));
  assert.equal(log[0].moved[0].trashedTo, asked.moved[0].trashedTo);
});

// ── the CLI group ───────────────────────────────────────────────────────────────

async function run(io, ...argv) {
  let text = '';
  const code = await claudectl(argv, {...io, stdout: (s) => (text += s)});
  return {code, text};
}

test('claudectl cache list writes nothing and says what everything costs', async () => {
  const {home, io, fill} = world();
  fill('.claude/statsig', 4096);
  const before = fs.readdirSync(path.join(home, '.claude'));
  const {code, text} = await run(io, 'cache', 'list');
  assert.equal(code, 0);
  assert.match(text, /claude-statsig\s+4\.\d KB\s+cache\s+Claude Code · Feature-flag cache/);
  assert.match(text, /- cursor-cache\s+absent/);
  assert.deepEqual(fs.readdirSync(path.join(home, '.claude')), before);
});

test('claudectl cache reclaim prints the plan and stops without --yes', async () => {
  const {home, io, fill} = world();
  fill('.claude/statsig', 4096);
  fill('.claude/projects', 8192);
  const dry = await run(io, 'cache', 'reclaim');
  assert.match(dry.text, /would trash\s+claude-statsig/);
  // The plan says what it is leaving alone, and how much that is.
  assert.match(dry.text, /keep\s+claude-projects\s+8\.\d KB\s+your own history/);
  assert.match(dry.text, /re-run with --yes to move them\. Nothing has been touched\./);
  assert.equal(fs.existsSync(path.join(home, '.claude', 'statsig')), true);

  const done = await run(io, 'cache', 'reclaim', '--yes');
  assert.match(done.text, /trashed\s+claude-statsig/);
  assert.match(done.text, /reclaimed\. Recover it from the trash/);
  assert.equal(fs.existsSync(path.join(home, '.claude', 'statsig')), false);
  assert.match((await run(io, 'cache', 'log')).text, /claude-statsig/);
});

test('the claudectl root help names the cache group', async () => {
  const {io} = world();
  assert.match((await run(io, 'help')).text, /claudectl cache \.\.\./);
  assert.match((await run(io, 'cache', 'help')).text, /Nothing here deletes/);
});
