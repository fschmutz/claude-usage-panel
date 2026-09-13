// The Node port of the shared normalization contract: what a raw payload from
// the usage endpoint becomes for every Node client (the MCP server, the
// claude-account CLI). Mirrors lib/pure.js (GNOME) and Model.swift (macOS);
// tests/fixtures/normalize.json + tests/parity.test.js keep the three in step.
// No I/O, no Node built-ins - a pure module.

const KIND_LABELS = {
  session: 'Current session',
  weekly_all: 'Weekly · all models',
  weekly_scoped: 'Weekly',
  weekly_oauth_apps: 'Weekly · apps',
};
const KIND_ORDER = ['session', 'weekly_all', 'weekly_scoped', 'weekly_oauth_apps'];

export function clampPercent(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

// Which pool a limit draws from. The API sends `group` ("session" / "weekly");
// payloads that predate it are grouped by the kind prefix instead.
function groupOf(kind, group) {
  if (group) return group;
  return String(kind).startsWith('weekly') ? 'weekly' : String(kind);
}

// A label for a kind we have no entry for - the endpoint keeps adding them.
// Mirrors pure.js kindLabel().
export function kindLabel(kind) {
  const known = KIND_LABELS[kind];
  if (known) return known;
  const k = String(kind ?? '');
  const words = (w) => w.replace(/_/g, ' ').trim();
  if (k.startsWith('weekly_')) return `Weekly · ${words(k.slice(7))}`;
  if (k.startsWith('session_')) return `Session · ${words(k.slice(8))}`;
  return words(k) || 'Limit';
}

// Prepaid credits already charged this cycle. Not a limits[] entry - no window,
// no reset - and reported only while the account has it enabled. Mirrors
// pure.js normalizeExtraUsage(); tests/fixtures/extra-usage.json pins both.
function money(obj) {
  const minor = Number(obj?.amount_minor);
  if (!Number.isFinite(minor)) return null;
  const exp = Number(obj?.exponent);
  return minor / 10 ** (Number.isFinite(exp) ? exp : 2);
}

export function formatMoney(amount, currency = 'USD') {
  if (!Number.isFinite(amount)) return '';
  const n = amount.toFixed(2);
  return currency === 'USD' ? `$${n}` : `${n} ${currency}`;
}

export function normalizeExtraUsage(payload) {
  const spend = payload?.spend;
  if (!spend || spend.enabled !== true) return null;
  const used = money(spend.used);
  if (used === null) return null;
  const limit = money(spend.limit);
  const currency = spend.used?.currency ?? spend.limit?.currency ?? 'USD';
  return {
    key: 'extra_usage',
    label: 'Extra usage',
    percent: clampPercent(spend.percent),
    severity: spend.severity ?? 'normal',
    usedAmount: used,
    limitAmount: limit,
    currency,
    detail:
      limit !== null
        ? `${formatMoney(used, currency)} of ${formatMoney(limit, currency)}`
        : formatMoney(used, currency),
  };
}

function normalizeLimit(entry) {
  let label = kindLabel(entry.kind);
  const model = entry.scope?.model?.display_name;
  if (model) label = `${label} · ${model}`;
  return {
    key: entry.kind + (model ? `:${model}` : ''),
    label,
    group: groupOf(entry.kind, entry.group),
    scoped: Boolean(model),
    percent: clampPercent(entry.percent),
    severity: entry.severity ?? 'normal',
    resetsAt: entry.resets_at ?? null,
    active: Boolean(entry.is_active),
  };
}

// A scoped (per-model) limit is a sub-cap ON its group's pooled limit, not a
// pool of its own: Fable usage counts toward `weekly_all` and shares its reset.
// The API leaves the scoped `resets_at` null until that model is used in the
// window, so borrow the pooled reset.
function inheritPooledResets(cards) {
  for (const card of cards) {
    if (!card.scoped || card.resetsAt) continue;
    const pooled = cards.find((o) => !o.scoped && o.group === card.group && o.resetsAt);
    if (pooled) card.resetsAt = pooled.resetsAt;
  }
  return cards;
}

// Extract normalized limit cards from the raw usage payload. Prefers the modern
// `limits[]` array; falls back to legacy five_hour / seven_day fields.
export function normalizeUsage(payload) {
  if (Array.isArray(payload?.limits) && payload.limits.length) {
    return inheritPooledResets(payload.limits.map(normalizeLimit)).sort((a, b) => {
      const ai = KIND_ORDER.indexOf(a.key.split(':')[0]);
      const bi = KIND_ORDER.indexOf(b.key.split(':')[0]);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    });
  }
  const cards = [];
  if (Number.isFinite(Number(payload?.five_hour?.utilization))) {
    cards.push({
      key: 'session', label: KIND_LABELS.session,
      group: 'session', scoped: false,
      percent: clampPercent(payload.five_hour.utilization),
      severity: 'normal', resetsAt: payload.five_hour.resets_at ?? null, active: true,
    });
  }
  if (Number.isFinite(Number(payload?.seven_day?.utilization))) {
    cards.push({
      key: 'weekly_all', label: KIND_LABELS.weekly_all,
      group: 'weekly', scoped: false,
      percent: clampPercent(payload.seven_day.utilization),
      severity: 'normal', resetsAt: payload.seven_day.resets_at ?? null, active: false,
    });
  }
  return cards;
}

// Note for a scoped (per-model) card: its percent is a *share* of the weekly
// pool (on Max, up to 50 % of the weekly allowance may go to Fable), never
// extra headroom - every Fable token also moves `weekly_all`.
export function poolNote(card) {
  return card?.scoped && card.group === 'weekly' ? 'share of the weekly all-models limit' : '';
}
