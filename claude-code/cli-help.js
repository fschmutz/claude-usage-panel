// `--help` / `-h` / `help` at every depth of claudectl, answered before any
// command runs: `claudectl session open --help` must print, never open.
// A command's help is its synopsis lines from the group's HELP (one source,
// so the two cannot drift) plus the group's DETAILS paragraph for it.

const HELP_FLAGS = new Set(['--help', '-h']);

/**
 * Where a help request points, or null when argv is not one. `help` counts
 * only as the first or second word (`claudectl help session`, `claudectl
 * session help open`), so a value like `--reason help` is never taken for it.
 * @returns {{group?: string, cmd?: string} | null}
 */
export function helpRequest(argv) {
  const words = argv.filter((a) => !a.startsWith('-'));
  const helpAt = words.indexOf('help');
  const asked = argv.some((a) => HELP_FLAGS.has(a)) || (helpAt >= 0 && helpAt <= 1);
  if (!asked) return null;
  const [group, cmd] = words.filter((w, i) => !(w === 'help' && i <= 1));
  return {group, cmd};
}

/** The synopsis lines `claudectl <group> <cmd>` has in `help` (its usage and
 *  the continuation lines under it), or null when the group has no such
 *  command. `[cmd]` matches too (`claudectl waiting [list]`). */
export function commandSynopsis(help, group, cmd) {
  const lines = help.split('\n');
  const head = new RegExp(`^\\s*claudectl ${group} \\[?${cmd.replace(/[^\w-]/g, '')}\\]?(\\s|$)`);
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) return null;
  const block = [lines[start]];
  for (const l of lines.slice(start + 1)) {
    if (!l.trim() || /^\s*claudectl /.test(l) || !/^ {3,}/.test(l)) break;
    block.push(l);
  }
  return block.join('\n');
}

/** The help page of one command: synopsis, details, where the rest is. */
export function commandHelp({help, details = {}, aliases = {}}, group, cmd) {
  const name = aliases[cmd] ?? cmd;
  const synopsis = commandSynopsis(help, group, name);
  if (!synopsis) return null;
  const more = details[name] ? `\n\n${details[name].trim()}` : '';
  return `${synopsis}${more}\n\nAll ${group} commands: claudectl ${group} --help`;
}
