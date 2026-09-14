// Timestamps as the clients show them: the session-ping stamp parser and the
// "05:30" / "yesterday 05:30" / "Tue 05:30" formatting behind every ping line,
// plus the "3h06m" / "4d2h" reset countdown. Pure. Mirrors lib/pure.js on
// GNOME and Swift's SessionPing; tests/fixtures/sessions.json pins the stamps.
//
// The ping stamp's offset has no colon (+0200), which Date.parse only accepts
// through a legacy path, so it is parsed explicitly. localDay / formatClock
// are deliberately LOCAL: the panel shows the user's wall clock.

const STAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

export function parseStamp(text) {
  const m = STAMP_RE.exec(String(text ?? '').trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, sec, zone] = m;
  if (!zone) {
    return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec))
      .getTime();
  }
  let offsetMin = 0;
  if (zone !== 'Z') {
    const digits = zone.slice(1).replace(':', '');
    offsetMin = (zone[0] === '-' ? -1 : 1) *
      (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2)));
  }
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec)) -
    offsetMin * 60_000;
}

export function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-` +
    `${String(d.getDate()).padStart(2, '0')}`;
}

export function formatClock(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function formatLastPing(text, nowMs) {
  const at = parseStamp(text);
  if (at === null) return '';
  const clock = formatClock(at);
  const day = localDay(at);
  if (day === localDay(nowMs)) return clock;
  if (day === localDay(nowMs - 86_400_000)) return `yesterday ${clock}`;
  if (nowMs - at < 6 * 86_400_000) return `${DAY_NAMES[(new Date(at).getDay() + 6) % 7]} ${clock}`;
  return `${day} ${clock}`;
}

// "3h06m" / "4d2h" - the two most significant units; '' when past or absent.
export function resetHint(resetsAt, nowMs = Date.now()) {
  if (!resetsAt) return '';
  const ms = new Date(resetsAt).getTime() - nowMs;
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const mins = Math.round(ms / 60_000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  return `${m}m`;
}
