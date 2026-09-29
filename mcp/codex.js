// The Codex MCP tools: saved OpenAI Codex logins and the only usage figures
// this project is willing to report for them. A sibling of the Claude account
// tools in tools.js, never a replacement - these read a different file, write
// a different store, and cannot reach a Claude login.
//
// The usage tool exists to give an honest answer to a question a model will
// otherwise guess at. OpenAI publishes no plan-limit endpoint, so there is
// nothing to poll; what the Codex CLI records in its own session transcript is
// the rate limits the API returned with a turn, and that is reported as an
// estimate, stamped with when it was captured, or not at all.

import {NAME_RE} from '../claude-usage-panel@fschmutz.github.io/lib/pure/accounts.js';
import {codexIdentity} from '../claude-usage-panel@fschmutz.github.io/lib/pure/codex.js';
import {resetHint} from '../claude-code/stamps.js';

const CODEX_LIMIT_ITEM = {
  type: 'object',
  properties: {
    key: {type: 'string'},
    label: {type: 'string', description: 'e.g. "5h limit", "Weekly limit"'},
    group: {type: 'string', enum: ['session', 'weekly']},
    percent: {type: 'integer', minimum: 0, maximum: 100},
    resetsAt: {type: ['string', 'null']},
    provenance: {
      type: 'string',
      const: 'estimated',
      description:
        'ALWAYS estimated: recorded by the codex CLI when the API last told ' +
        'it, not read now. Never present it as a live reading.',
    },
    capturedAt: {type: 'string', description: 'when the codex CLI recorded it'},
  },
  required: ['key', 'label', 'group', 'percent', 'provenance', 'capturedAt'],
};

export const CODEX_TOOLS = [
  {
    name: 'list_codex_accounts',
    title: 'Saved OpenAI Codex logins',
    description:
      'The OpenAI Codex (ChatGPT) logins saved under a name, which one is ' +
      'active, and whether each stored login is still usable. Reads the ' +
      'auth.json the codex CLI wrote under $CODEX_HOME (else ~/.codex) and ' +
      'the saved copies of it; nothing is uploaded and no token is minted. ' +
      'Separate from list_accounts, which is for Claude Code logins.',
    inputSchema: {type: 'object', properties: {}, additionalProperties: false},
    outputSchema: {
      type: 'object',
      properties: {
        active: {
          type: ['string', 'null'],
          description: 'name of the active Codex login, null if unsaved',
        },
        accounts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: {type: 'string'},
              email: {type: ['string', 'null']},
              plan: {type: ['string', 'null'], description: 'e.g. plus, pro, business'},
              planLabel: {type: 'string'},
              active: {type: 'boolean'},
              tokenState: {
                type: 'string', enum: ['valid', 'stale', 'expired'],
                description:
                  'expired = `codex login` is needed on that account. Nothing ' +
                  'here refreshes a Codex token; the codex CLI owns that grant.',
              },
            },
            required: ['name', 'active', 'tokenState'],
          },
        },
      },
      required: ['active', 'accounts'],
    },
    annotations: {readOnlyHint: true, openWorldHint: false},
  },
  {
    name: 'save_codex_account',
    title: 'Save the current Codex login under a name',
    description:
      'Save the OpenAI Codex login the codex CLI holds right now as a named ' +
      'account, so it can be switched back to later. Names: letters, digits, ' +
      '. _ - (e.g. PLUS). Refuses to reuse a name that belongs to another ' +
      'account, or to save the same account twice, unless `force` is true.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {type: 'string', pattern: NAME_RE.source},
        force: {type: 'boolean', default: false},
      },
      required: ['name'],
      additionalProperties: false,
    },
    // `force` overwrites a profile that holds a different login: destructive.
    annotations: {
      readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false,
    },
  },
  {
    name: 'switch_codex_account',
    title: 'Switch the Codex CLI to a saved login',
    description:
      'Make a saved Codex login the current one: the current login is written ' +
      'back to its own saved profile first, then the target auth.json replaces ' +
      'it. Only that one file changes - config, history and sessions stay - and ' +
      'a Codex process already running keeps the old login until it restarts. ' +
      'Refuses when the current login was never saved, rather than losing it.',
    inputSchema: {
      type: 'object',
      properties: {name: {type: 'string', pattern: NAME_RE.source}},
      required: ['name'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        from: {type: ['string', 'null']},
        to: {type: 'string'},
        changed: {type: 'boolean', description: 'false when it already was the active login'},
        tokenState: {type: 'string', enum: ['valid', 'stale', 'expired']},
      },
      required: ['to', 'changed', 'tokenState'],
    },
    annotations: {
      readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    },
  },
  {
    name: 'get_codex_usage',
    title: 'Codex rate limits, as last recorded',
    description:
      'The most recent OpenAI Codex rate limits available on this machine. ' +
      'IMPORTANT: OpenAI publishes no plan-usage endpoint, so these are NOT ' +
      'read live. They are the figures the codex CLI recorded when the API ' +
      'last returned them, and every one carries `capturedAt` and ' +
      '`provenance: "estimated"`. When nothing usable was recorded the answer ' +
      'is `unavailable` with a reason - never a guess. For Claude Code usage, ' +
      'which IS read live from the official endpoint, use get_usage.',
    inputSchema: {type: 'object', properties: {}, additionalProperties: false},
    outputSchema: {
      type: 'object',
      properties: {
        available: {type: 'boolean'},
        limits: {type: 'array', items: CODEX_LIMIT_ITEM},
        capturedAt: {type: ['string', 'null']},
        reason: {
          type: ['string', 'null'],
          enum: ['no_sessions', 'no_snapshot', 'stale', null],
          description: 'why there are no figures; null when there are',
        },
      },
      required: ['available', 'limits'],
    },
    annotations: {readOnlyHint: true, openWorldHint: false},
  },
];

export const CODEX_TOOL_NAMES = new Set(CODEX_TOOLS.map((t) => t.name));

export function renderCodexAccounts({active, accounts}) {
  if (!accounts.length) {
    return 'No saved Codex logins yet - save_codex_account names the current one.';
  }
  const lines = accounts.map((a) => {
    const parts = [`${a.active ? '● ' : '○ '}**${a.name}**`];
    if (a.email) parts.push(a.email);
    if (a.planLabel) parts.push(a.planLabel);
    if (a.tokenState === 'expired') parts.push('login EXPIRED - run `codex login` on it');
    if (a.tokenState === 'stale') parts.push('token due a refresh (the codex CLI does it)');
    return `- ${parts.join(' · ')}`;
  });
  if (!active) lines.push('- the current Codex login is not one of the saved ones');
  return lines.join('\n');
}

const WHY = {
  no_sessions: 'no Codex sessions on this machine yet, so nothing has recorded a limit',
  no_snapshot: 'the recent Codex sessions carry no rate limits',
  stale: 'the newest recorded reading is old enough that its window has rolled over',
};

export function renderCodexUsage({cards, capturedAt, reason}, now = Date.now()) {
  if (reason) return `Codex usage unavailable: ${WHY[reason] ?? reason}.`;
  const lines = cards.map((c) => {
    const reset = resetHint(c.resetsAt, now);
    return `- **${c.label}** - ${c.percent}%${reset ? ` · resets in ${reset}` : ''}`;
  });
  return [
    ...lines,
    `_Recorded by the codex CLI at ${capturedAt}, not read now - OpenAI exposes ` +
    'no usage endpoint to read._',
  ].join('\n');
}

/** Run one Codex tool; the caller turns a thrown Error into a tool error. */
export function callCodexTool(name, args, store, now = Date.now()) {
  switch (name) {
    case 'list_codex_accounts': {
      const {active, accounts} = store.listAccounts();
      const structured = {active, accounts};
      return {
        content: [{type: 'text', text: renderCodexAccounts(structured)}],
        structuredContent: structured,
      };
    }
    case 'save_codex_account': {
      const p = store.saveCurrent(args?.name, {force: args?.force === true});
      const id = codexIdentity(p.auth);
      return {
        content: [{
          type: 'text',
          text: `Saved the current Codex login as **${p.name}** (${id.email ?? 'unknown account'}).`,
        }],
        structuredContent: {name: p.name, email: id.email, plan: id.plan},
      };
    }
    case 'switch_codex_account': {
      const r = store.switchTo(args?.name);
      const hint = r.tokenState === 'expired'
        ? ` Its stored login has lapsed - run \`codex login\`, then save it again.` : '';
      const text = r.changed
        ? `Switched ${r.from ?? '?'} → **${r.to}**. A running codex process keeps the old ` +
          `login until it restarts.${hint}`
        : `**${r.to}** is already the current Codex login.${hint}`;
      return {content: [{type: 'text', text}], structuredContent: r};
    }
    case 'get_codex_usage': {
      const recorded = store.recordedUsage();
      const structured = {
        available: recorded.reason === null,
        limits: recorded.cards,
        capturedAt: recorded.capturedAt,
        reason: recorded.reason,
      };
      return {
        content: [{type: 'text', text: renderCodexUsage(recorded, now)}],
        structuredContent: structured,
      };
    }
    default:
      throw new Error(`Unknown Codex tool: ${name}`);
  }
}
