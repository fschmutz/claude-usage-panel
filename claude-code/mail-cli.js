// `claudectl session send | inbox | peers`: messages between running Claude
// Code sessions, across logins (sessions started by `claudectl account exec`
// included). session-cli.js dispatches here; the store is mail.js, the
// delivery the pause waiter (pause-hook.js).

import {cleanPauseText} from '../claude-usage-panel@fschmutz.github.io/lib/pure/pause.js';
import {openMail} from './mail.js';
import {openPause} from './pause.js';
import {matchSession} from './tabs.js';

export const MAIL_COMMANDS = new Set(['send', 'inbox', 'peers']);

export const MAIL_HELP = `
  claudectl session peers [--json]           every running session a message can reach,
                                             with the login it runs as
  claudectl session send #|NAME|PID|ID -- TEXT...
                                             queue TEXT for that session; its waiter
                                             wakes it with the message
  claudectl session inbox [ID] [--json]      messages still waiting (default: this
                                             session's; --all: every session's)`;

export const MAIL_DETAILS = {
  peers: `The sessions of every login: the live one's registry, then each config
dir \`claudectl account exec\` made. ACCOUNT is the saved login the session runs
as (blank when the live login matches no saved name). # numbers this list for
\`send\`.`,
  send: `Queues TEXT (up to 16 KB) for the session and returns at once. The
session's pause waiter (\`./install.sh pause\`; a session started by
\`account exec\` gets it too) wakes it with the message, idle or busy, exactly
once; the message names the sender and how to reply. A session with no live
waiter gets it when its next turn ends. The receiving session reads it as
another session's words, never as the user's approval. Everything after -- is
the text, flags included.`,
  inbox: `What is queued and not yet handed over: this session's (the one the
command runs in), the session ID names, or with --all every session's.`,
};

/** A table cell: control characters blanked, at most `n` characters. */
const cell = (s, n) => {
  const t = cleanPauseText(String(s ?? ''), Infinity) ?? '';
  return t.length > n ? `${t.slice(0, n - 1)}~` : t;
};

export async function runMail(cmd, argv, io = {}) {
  const out = io.stdout ?? ((s) => process.stdout.write(s));
  const env = io.env ?? process.env;
  const mail = openMail(io);
  const sep = argv.indexOf('--');
  const head = sep === -1 ? argv : argv.slice(0, sep);
  const flags = new Set(head.filter((a) => a.startsWith('--')));
  const args = head.filter((a) => !a.startsWith('--'));
  switch (cmd) {
    case 'peers': {
      const rows = mail.peers();
      if (flags.has('--json')) {
        out(`${JSON.stringify(rows, null, 2)}\n`);
        return 0;
      }
      if (!rows.length) {
        out('no running session\n');
        return 0;
      }
      const self = env.CLAUDE_CODE_SESSION_ID;
      out(`${'#'.padEnd(4)}${'NAME'.padEnd(26)}${'ACCOUNT'.padEnd(16)}${'PID'.padEnd(9)}SESSION\n`);
      rows.forEach((r, i) => {
        const mark = r.session_id === self ? '*' : ' ';
        out(`${`${i + 1}${mark}`.padEnd(4)}${cell(r.name, 25).padEnd(26)}${cell(r.account ?? '', 15).padEnd(16)}`
          + `${String(r.pid).padEnd(9)}${r.session_id}\n`);
      });
      return 0;
    }
    case 'send': {
      if (args.length !== 1 || sep === -1) throw new Error('usage: claudectl session send #|NAME|PID|ID -- TEXT...');
      const to = matchSession(mail.peers(), args[0], {numbered: true});
      const message = mail.send(to.session_id, argv.slice(sep + 1).join(' '));
      const live = openPause(io).waiterLive(to.session_id);
      out(`queued for ${to.name}${to.account ? ` (${to.account})` : ''}: ${live
        ? 'its waiter delivers it now'
        : 'no live waiter, it gets it when its next turn ends'} [${message.id}]\n`);
      return 0;
    }
    default: {
      const sid = flags.has('--all') ? null : (args[0] ?? env.CLAUDE_CODE_SESSION_ID);
      if (!flags.has('--all') && !sid) throw new Error('inbox needs a session ID, or --all, outside a session');
      const ids = sid ? [sid] : mail.peers().map((p) => p.session_id);
      const rows = ids.flatMap((id) => mail.pending(id));
      if (flags.has('--json')) {
        out(`${JSON.stringify(rows, null, 2)}\n`);
        return 0;
      }
      if (!rows.length) out('nothing waiting\n');
      for (const m of rows) {
        out(`${new Date(m.at).toISOString()} ${m.to} from ${cell(m.from?.name ?? m.from?.sessionId ?? '?', 30)}: `
          + `${cell(m.text.replace(/\n/g, ' '), 200)}\n`);
      }
      return 0;
    }
  }
}
