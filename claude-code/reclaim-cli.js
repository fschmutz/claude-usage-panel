// `claudectl cache`: the command-line face of claude-code/reclaim.js. Show
// what the known dev caches are costing, and - only when asked, and only after
// the plan has been printed - move the chosen ones to the trash.
//
// Deliberately awkward to do by accident. `list` is the default and writes
// nothing; `reclaim` prints the plan and stops unless --yes is on the command
// line; a `history` entry is refused even when named unless --include-history
// is there too. Everything that does move goes to the trash, so the desktop's
// "put back" is the undo.

import {formatBytes} from './reclaim-contract.js';
import {openReclaim} from './reclaim.js';

export const HELP = `claudectl cache - what the local dev caches cost, and how to get it back

  claudectl cache list [--json]              every known cache, with its size (writes nothing)
  claudectl cache reclaim [ID...] [--yes]    move them to the trash; without --yes, only the plan
  claudectl cache log [--json]               what past runs moved, and where it went

With no IDs, reclaim takes the regenerated caches only - never your own
transcripts. A history entry (claude-projects, codex-sessions) has to be named
AND --include-history given, because nothing regenerates it.

Nothing here deletes: entries are moved to the trash, and the desktop's "put
back" is the undo. Every run is appended to the log below.`;

const helpText = (r) => `${HELP}\n\n  trash:  ${r.trashDir()}\n  log:    ${r.logPath}`;

const WHY = {
  unknown: 'not a known cache',
  history: 'your own history - name it and pass --include-history',
  empty: 'nothing there',
};

export async function main(argv, io = {}) {
  const r = openReclaim(io);
  const out = io.stdout ?? ((s) => process.stdout.write(s));
  const args = argv.filter((a) => !a.startsWith('--'));
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const json = flags.has('--json');
  const [cmd, ...ids] = args;

  switch (cmd) {
    case undefined:
    case 'list': {
      const scanned = r.scan();
      if (json) {
        out(`${JSON.stringify(scanned, null, 2)}\n`);
        return 0;
      }
      let total = 0;
      for (const e of scanned) {
        if (e.exists) total += e.bytes;
        out(`${e.exists ? ' ' : '-'} ${e.id.padEnd(22)} ${(e.exists ? e.human : 'absent').padStart(9)}` +
          `  ${e.kind.padEnd(7)} ${e.tool} · ${e.label}\n`);
      }
      out(`\n  ${formatBytes(total)} in all, of which ` +
        `${formatBytes(scanned.filter((e) => e.kind === 'history' && e.exists)
          .reduce((n, e) => n + e.bytes, 0))} is history nothing regenerates.\n`);
      out('  `claudectl cache reclaim` moves the regenerated ones to the trash.\n');
      return 0;
    }
    case 'reclaim': {
      const chosen = ids.length ? ids : null;
      const includeHistory = flags.has('--include-history');
      const planned = r.plan(chosen, {includeHistory});
      if (json && !flags.has('--yes')) {
        out(`${JSON.stringify(planned, null, 2)}\n`);
        return 0;
      }
      for (const t of planned.targets) out(`  would trash  ${t.id.padEnd(22)} ${t.human.padStart(9)}  ${t.path}\n`);
      for (const skip of planned.refused) out(`  keep         ${skip.id.padEnd(22)} ${WHY[skip.why] ?? skip.why}\n`);
      // A default run does not even consider history, so it never lands in
      // `refused` - say out loud that it is being left, and how much it is.
      if (!chosen) {
        for (const e of planned.scanned.filter((x) => x.kind === 'history' && x.exists)) {
          out(`  keep         ${e.id.padEnd(22)} ${e.human.padStart(9)}  ${WHY.history}\n`);
        }
      }
      if (!planned.targets.length) {
        out('nothing to reclaim\n');
        return 0;
      }
      out(`  ${formatBytes(planned.totalBytes)} would move to ${r.trashDir()}\n`);
      if (!flags.has('--yes')) {
        out('\nre-run with --yes to move them. Nothing has been touched.\n');
        return 0;
      }
      const result = r.reclaim(chosen, {confirm: true, includeHistory});
      if (json) {
        out(`${JSON.stringify(result, null, 2)}\n`);
        return result.failed.length ? 1 : 0;
      }
      for (const m of result.moved) out(`  trashed      ${m.id.padEnd(22)} -> ${m.trashedTo}\n`);
      for (const f of result.failed) out(`  FAILED       ${f.id.padEnd(22)} ${f.error}\n`);
      out(`${formatBytes(result.freedBytes)} reclaimed. Recover it from the trash; ` +
        `the run is in ${r.logPath}\n`);
      return result.failed.length ? 1 : 0;
    }
    case 'log': {
      const runs = r.readLog();
      if (json) {
        out(`${JSON.stringify(runs, null, 2)}\n`);
        return 0;
      }
      if (!runs.length) {
        out('nothing has been reclaimed on this machine\n');
        return 0;
      }
      for (const run of runs) {
        out(`${run.at}  ${formatBytes(run.freedBytes)}\n`);
        for (const m of run.moved) out(`  ${m.id.padEnd(22)} ${m.from}\n    -> ${m.trashedTo}\n`);
      }
      return 0;
    }
    case 'help':
    case '-h':
      out(`${helpText(r)}\n`);
      return 0;
    default:
      throw new Error(`unknown command ${cmd}\n${helpText(r)}`);
  }
}
