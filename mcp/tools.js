// The MCP tools: their schemas, the markdown renderers behind the text
// content, and the account tool calls. server.js owns the transport and the
// get_usage assembly; everything that describes or renders a tool lives here.

import {NAME_RE, accountSummary} from '../claude-code/accounts-contract.js';
import {poolNote} from '../claude-code/normalize.js';
import {resetHint} from '../claude-code/stamps.js';

// One markdown line per limit: label, percent, severity, reset countdown, and -
// when history supports a projection - the burn rate and whether it runs out
// before the reset.
export function renderCards(cards, now = Date.now()) {
  if (!cards.length) return 'No plan limits reported by the usage endpoint.';
  return cards.map(c => {
    const reset = resetHint(c.resetsAt, now);
    const parts = [`**${c.label}** - ${c.percent}%`];
    if (c.severity !== 'normal') parts.push(c.severity.toUpperCase());
    if (reset) parts.push(`resets in ${reset}`);
    const note = poolNote(c);
    if (note) parts.push(note);
    if (c.vsClock?.state === 'ahead') {
      parts.push(
        `⏱ ${c.vsClock.elapsedPercent}% of the window gone - ` +
        `${c.vsClock.deltaPoints} pts ahead of the clock`);
    }
    if (c.trend) {
      parts.push(
        c.trend.lastWeekPeak === null
          ? `peak ${c.trend.thisWeekPeak}% this week`
          : `peak ${c.trend.thisWeekPeak}% this week vs ${c.trend.lastWeekPeak}% last`);
    }
    if (c.pace) {
      parts.push(c.pace.exhaustsBeforeReset
        ? `↗ ${c.pace.pctPerHour}%/h - ON PACE TO RUN OUT ${Math.abs(c.pace.marginHours)}h before reset (~${c.pace.projectedFullAt})`
        : `↗ ${c.pace.pctPerHour}%/h - lasts past reset`);
    }
    return `- ${parts.join(' · ')}`;
  }).join('\n');
}


// One line for prepaid credit spend, when the account has any enabled.
export function renderExtraUsage(extra) {
  if (!extra) return '';
  const parts = [`**Extra usage** - ${extra.detail}`, `${extra.percent}% of the cap`];
  if (extra.severity !== 'normal') parts.push(extra.severity.toUpperCase());
  return `- ${parts.join(' · ')}`;
}

export const GET_USAGE_TOOL = {
  name: 'get_usage',
  title: 'Claude plan usage',
  description:
    'Current Claude plan usage: session, weekly, and per-model limits - ' +
    'percent used, severity, and reset time for each, from the official ' +
    'Anthropic usage endpoint (same numbers as /usage). A per-model limit ' +
    '(scoped:true, e.g. Fable) caps a share of the weekly all-models pool and ' +
    'draws from it - it is not extra quota. When enough local history exists, ' +
    'each limit also carries a `pace` projection: %/hour burn rate, the ' +
    'projected 100% instant, and whether that lands before the reset. Every ' +
    'limit with a reset also carries `vsClock`: how much of its window has ' +
    'gone and whether usage is running ahead of that clock. `extraUsage` ' +
    'reports prepaid credits charged beyond the plan, when the account has ' +
    'them enabled. Also ' +
    'reports `lastPing` (when a scheduled session ping last opened a 5-hour ' +
    'window) and `sessions`: today\'s local Claude Code sessions ranked by the ' +
    'tokens they spent, each with the shell command that resumes it. `account` ' +
    'names the saved account these numbers belong to (see list_accounts), ' +
    'null when the current login was never saved.',
  inputSchema: {type: 'object', properties: {}, additionalProperties: false},
  outputSchema: {
    type: 'object',
    properties: {
      account: {
        type: ['object', 'null'],
        description: 'the saved account the current login is; null when not saved',
        properties: {
          name: {type: 'string'},
          email: {type: ['string', 'null']},
          plan: {type: ['string', 'null']},
        },
        required: ['name'],
      },
      limits: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            key: {type: 'string'},
            label: {type: 'string'},
            group: {type: 'string', description: 'pool this limit draws from: session | weekly'},
            scoped: {
              type: 'boolean',
              description: 'per-model sub-cap of the group pool, not a pool of its own',
            },
            percent: {type: 'integer', minimum: 0, maximum: 100},
            severity: {type: 'string', enum: ['normal', 'warning', 'critical']},
            resetsAt: {type: ['string', 'null']},
            active: {type: 'boolean'},
            vsClock: {
              type: 'object',
              description:
                'usage measured against the window it lives in (5 h session, ' +
                '7 d weekly); needs no history, so it is always present when ' +
                'the limit has a reset time',
              properties: {
                elapsedPercent: {
                  type: 'integer',
                  description: 'how much of the window has already gone, 0-100',
                },
                deltaPoints: {
                  type: 'integer',
                  description: 'percent − elapsed; positive = burning faster than the clock',
                },
                state: {type: 'string', enum: ['ahead', 'even', 'behind']},
              },
            },
            trend: {
              type: 'object',
              description:
                'peak of this limit over the last 7 days against the 7 before ' +
                'it, from the 90-day local history the desktop panels record; ' +
                'absent when there is no history for it',
              properties: {
                thisWeekPeak: {type: 'integer'},
                lastWeekPeak: {
                  type: ['integer', 'null'],
                  description: 'null on a fresh install - nothing to compare against yet',
                },
                deltaPoints: {type: ['integer', 'null']},
              },
            },
            pace: {
              type: 'object',
              description:
                'burn-rate projection from local sample history; absent when ' +
                'idle or too little history',
              properties: {
                pctPerHour: {type: 'number'},
                projectedFullAt: {type: 'string', description: 'instant the limit hits 100%'},
                exhaustsBeforeReset: {
                  type: 'boolean',
                  description: 'true when projected to run out BEFORE the reset',
                },
                marginHours: {
                  type: ['number', 'null'],
                  description: 'projectedFullAt − reset in hours; negative = runs out early',
                },
              },
              required: ['pctPerHour', 'projectedFullAt', 'exhaustsBeforeReset'],
            },
          },
          required: ['key', 'label', 'group', 'scoped', 'percent', 'severity'],
        },
      },
      extraUsage: {
        type: ['object', 'null'],
        description:
          'prepaid credits charged this cycle beyond the plan; null unless the ' +
          'account has extra usage enabled. Money, not a window - it has no reset.',
        properties: {
          percent: {type: 'integer', minimum: 0, maximum: 100},
          severity: {type: 'string', enum: ['normal', 'warning', 'critical']},
          usedAmount: {type: 'number'},
          limitAmount: {type: ['number', 'null'], description: 'cap, when the account has one'},
          currency: {type: 'string'},
          detail: {type: 'string', description: 'e.g. "$12.40 of $50.00"'},
        },
        required: ['percent', 'severity', 'usedAmount', 'currency', 'detail'],
      },
      lastPing: {
        type: ['object', 'null'],
        description:
          'last successful scheduled session ping (install.sh sessionping); ' +
          'null when pings were never scheduled',
        properties: {
          at: {type: 'string', description: 'ISO 8601 instant'},
          label: {type: 'string', description: 'short local form, e.g. "05:30"'},
        },
        required: ['at', 'label'],
      },
      sessions: {
        type: 'array',
        description:
          "today's local Claude Code sessions, biggest token spender first. " +
          'Token counts are ESTIMATED from the local transcripts (cache reads ' +
          'excluded), not reported by the API.',
        items: {
          type: 'object',
          properties: {
            sessionId: {type: 'string'},
            label: {type: 'string', description: 'session title, else project directory'},
            cwd: {type: 'string'},
            tokens: {type: 'integer', description: 'estimated tokens spent today'},
            when: {type: 'string', description: 'local HH:MM of its last turn'},
            resumeCommand: {type: 'string', description: 'shell command that resumes it'},
          },
          required: ['sessionId', 'label', 'cwd', 'tokens', 'resumeCommand'],
        },
      },
    },
    required: ['limits'],
  },
  annotations: {readOnlyHint: true, openWorldHint: true},
};

const ACCOUNT_LIMIT_ITEM = GET_USAGE_TOOL.outputSchema.properties.limits.items;

export const ACCOUNT_TOOLS = [
  {
    name: 'list_accounts',
    title: 'Saved Claude accounts',
    description:
      'The Claude Code logins saved under a name (e.g. PRO, PERSO) with each ' +
      'one\'s plan usage, which one is active, and whether its stored login is ' +
      'still usable. Usage for a non-active account is read with its own stored ' +
      'token (refreshed when needed); nothing is switched.',
    inputSchema: {type: 'object', properties: {}, additionalProperties: false},
    outputSchema: {
      type: 'object',
      properties: {
        active: {type: ['string', 'null'], description: 'name of the active login, null if unsaved'},
        accounts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: {type: 'string'},
              email: {type: ['string', 'null']},
              plan: {type: ['string', 'null'], description: 'e.g. max, pro'},
              tier: {type: ['string', 'null']},
              active: {type: 'boolean'},
              tokenState: {
                type: 'string', enum: ['valid', 'stale', 'expired'],
                description: 'expired = a new `claude auth login` on that account is needed',
              },
              limits: {type: 'array', items: ACCOUNT_LIMIT_ITEM},
              error: {type: ['string', 'null'], description: 'why usage could not be read'},
            },
            required: ['name', 'active', 'tokenState'],
          },
        },
      },
      required: ['active', 'accounts'],
    },
    annotations: {readOnlyHint: true, openWorldHint: true},
  },
  {
    name: 'save_account',
    title: 'Save the current Claude login under a name',
    description:
      'Save the login Claude Code holds right now as a named account, so it can ' +
      'be switched back to later. Names: letters, digits, . _ - (e.g. PRO). ' +
      'Refuses to reuse a name that belongs to another account or to save the ' +
      'same account twice unless `force` is true.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {type: 'string', pattern: NAME_RE.source},
        force: {type: 'boolean', default: false},
      },
      required: ['name'],
      additionalProperties: false,
    },
    annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false},
  },
  {
    name: 'switch_account',
    title: 'Switch Claude Code to a saved account',
    description:
      'Make a saved account the current Claude Code login: the current login ' +
      'is written back to its own saved profile first (or saved under its email ' +
      'if it was never named), then the target credentials replace it. Only the ' +
      'login changes; settings, MCP servers and history stay. Claude Code ' +
      'sessions already running keep the old login until they restart - the ' +
      'result says how many are running, including this one.',
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
        running: {type: 'integer', description: 'Claude Code processes still on the old login'},
        email: {type: ['string', 'null']},
      },
      required: ['to', 'changed', 'running'],
    },
    annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true},
  },
];

// One line: "Account: PRO (pro@example.com, max)".
export function renderAccount(account) {
  if (!account) return '';
  const meta = [account.email, account.plan].filter(Boolean).join(', ');
  return `Account: **${account.name}**${meta ? ` (${meta})` : ''}`;
}

export function renderAccounts({active, accounts}) {
  if (!accounts.length) {
    return 'No saved accounts yet - save_account names the current login.';
  }
  const lines = accounts.map((a) => {
    const parts = [`${a.active ? '● ' : '○ '}**${a.name}**`];
    if (a.email) parts.push(a.email);
    if (a.plan) parts.push(a.plan);
    if (a.tokenState === 'expired') parts.push('login EXPIRED - `claude auth login` on it and save again');
    if (a.error) parts.push(a.error);
    if (a.limits?.length) {
      parts.push(a.limits.map((l) => `${l.label} ${l.percent}%`).join(' · '));
    }
    return `- ${parts.join(' · ')}`;
  });
  if (!active) lines.push('- current login is not one of the saved accounts');
  return lines.join('\n');
}

// The saved account the live login is, as get_usage reports it.
export function currentAccount(store) {
  const name = store.liveAccountName();
  if (!name) return null;
  const {email, plan} = accountSummary(store.readProfile(name));
  return {name, email, plan};
}

/** Run one of the account tools; the caller turns a thrown Error into a tool error. */
export async function callAccountTool(name, args, store) {
  switch (name) {
    case 'list_accounts': {
      const {active, accounts} = await store.listAccounts({usage: true});
      const structured = {
        active,
        accounts: accounts.map(({cards, ...a}) => ({...a, limits: cards ?? []})),
      };
      return {content: [{type: 'text', text: renderAccounts(structured)}], structuredContent: structured};
    }
    case 'save_account': {
      const p = store.saveCurrent(args?.name, {force: args?.force === true});
      const {email, plan} = accountSummary(p);
      return {
        content: [{type: 'text', text: `Saved the current login as **${p.name}** (${email ?? 'unknown email'}).`}],
        structuredContent: {name: p.name, email, plan},
      };
    }
    case 'switch_account': {
      const r = await store.switchTo(args?.name);
      const text = r.changed
        ? `Switched ${r.from ?? '?'} → **${r.to}**${r.email ? ` (${r.email})` : ''}.` +
          (r.running ? ` ${r.running} Claude Code session${r.running > 1 ? 's are' : ' is'} still running on the old login - including this one - and will use ${r.to} once restarted.` : '')
        : `**${r.to}** is already the current login.`;
      return {content: [{type: 'text', text}], structuredContent: r};
    }
    default:
      throw new Error(`Unknown account tool: ${name}`);
  }
}

export const ACCOUNT_TOOL_NAMES = new Set(ACCOUNT_TOOLS.map((t) => t.name));
