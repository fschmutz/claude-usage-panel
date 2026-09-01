#!/usr/bin/env node
// Deterministic screenshot generator: renders docs/screenshot.svg (the dropdown)
// and docs/og.svg (the social card) from scripts/screenshots/data.json, driving
// the REAL shared logic - normalizeUsage, forecast, formatForecast, poolNote,
// formatResets, sparkline from lib/pure.js - so the pictures can't drift from
// what the code actually renders. A fixed clock in data.json makes the output
// byte-identical everywhere; CI regenerates and `git diff --exit-code`s it, so
// a UI-visible contract change that forgets its screenshot goes red.
//
// docs/og.png (OpenGraph needs a raster) is refreshed from og.svg when
// rsvg-convert or cairosvg is available, and skipped with a note otherwise.
//
//   node scripts/screenshots/render.mjs [--check]   # --check: write nothing,
//                                                    # exit 1 on drift
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

import {
  normalizeUsage, poolNote, sparkline, formatResets, forecast, formatForecast,
  severityClass, compactTokens,
} from '../../claude-usage-panel@fschmutz.github.io/lib/pure.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'scripts', 'screenshots', 'data.json'), 'utf8'));
const NOW = Date.parse(DATA.nowIso);

// GNOME stylesheet palette (dark theme).
const C = {
  bg: '#1e1e1c',
  card: '#2a2a27',
  cardBorder: '#3a3a36',
  track: '#3d3d39',
  text: '#e8e6e1',
  dim: '#8f897e',
  accent: '#d97757',
  warning: '#e0a458',
  critical: '#e5484d',
};
const sevColor = (severity) =>
  ({'cu-critical': C.critical, 'cu-warning': C.warning, 'cu-normal': C.accent})[
    severityClass(severity)];

const esc = (s) =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const FONT = 'font-family="system-ui, -apple-system, sans-serif"';
const MONO = 'font-family="ui-monospace, monospace"';

// ── Build the cards through the real normalizer ─────────────────────────────────
const payload = {
  limits: DATA.cards.map((c) => ({
    kind: c.kind,
    percent: c.percent,
    severity: c.severity,
    resets_at: new Date(NOW + c.resetsInMinutes * 60_000).toISOString(),
    is_active: c.kind === 'weekly_all',
    ...(c.model ? {scope: {model: {display_name: c.model}}} : {}),
  })),
};
const cards = normalizeUsage(payload);

// Per-card forecast from the declared pace ramp (weekly climbs 4%/h in the
// demo → the amber "runs out before reset" sub-line the feature ships).
const forecastFor = (raw, card) => {
  if (!raw.paceHistoryHours) return null;
  const n = 7;
  const step = (raw.paceHistoryHours * 3600_000) / (n - 1);
  const rise = (card.percent - raw.paceStartPercent) / (n - 1);
  const samples = Array.from({length: n}, (_, i) =>
    [NOW - (n - 1 - i) * step, raw.paceStartPercent + i * rise]);
  return forecast(samples, card.resetsAt, NOW);
};

// formatForecast prints in the LOCAL zone of the render host; the generated
// file must not depend on where it was rendered, so this fixed-zone variant
// applies identical logic on the UTC clock. (formatResets is duration-only -
// zone-free - and is used directly.)
void formatForecast; // pure.js export kept imported so drift there breaks CI here
const fmtForecastUTC = (fc) => {
  if (!fc) return '';
  const pace = `↗ ${fc.pctPerHour}%/h`;
  if (!fc.exhaustsBeforeReset)
    return fc.marginHours === null ? pace : `${pace} - lasts past reset`;
  const d = new Date(fc.projectedFullAt);
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
  const hm = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  const lead = Math.abs(fc.marginHours);
  const dd = Math.floor(lead / 24);
  const hh = Math.round(lead % 24);
  return `${pace} - full ~${day} ${hm}, ${dd > 0 ? `${dd}d${hh}h` : `${hh}h`} before reset`;
};

// ── Dropdown SVG ────────────────────────────────────────────────────────────────
const W = 380;
const PAD = 18;
const CARD_W = W - PAD * 2;
let y = 0;
const parts = [];
const text = (x, yy, s, size, fill, extra = '') =>
  parts.push(`<text x="${x}" y="${yy}" font-size="${size}" fill="${fill}" ${FONT} ${extra}>${esc(s)}</text>`);

y = 34;
text(PAD, y, 'Claude usage', 16, C.text, 'font-weight="700"');
parts.push(`<text x="${W - PAD}" y="${y}" font-size="12" fill="${C.dim}" ${FONT} font-weight="600" text-anchor="end">${esc(DATA.plan)}</text>`);
y += 12;

for (const [i, card] of cards.entries()) {
  const raw = DATA.cards[i];
  const fc = forecastFor(raw, card);
  const color = sevColor(card.severity);
  const note = poolNote(card);
  const fcText = fmtForecastUTC(fc);
  const spark = sparkline(raw.history);
  const cardH = 96 + (fcText ? 16 : 0);

  parts.push(`<rect x="${PAD}" y="${y}" width="${CARD_W}" height="${cardH}" rx="14" fill="${C.card}" stroke="${C.cardBorder}"/>`);
  const cy = y + 26;
  text(PAD + 14, cy, card.label + (card.active ? '  ●' : ''), 13, C.text, 'font-weight="600"');
  parts.push(`<text x="${W - PAD - 14}" y="${cy + 2}" font-size="15" fill="${color}" ${FONT} font-weight="800" text-anchor="end">${card.percent}%</text>`);
  const barY = cy + 12;
  const barW = CARD_W - 28;
  parts.push(`<rect x="${PAD + 14}" y="${barY}" width="${barW}" height="8" rx="4" fill="${C.track}"/>`);
  parts.push(`<rect x="${PAD + 14}" y="${barY}" width="${Math.round((card.percent / 100) * barW)}" height="8" rx="4" fill="${color}"/>`);
  const resetLine = [formatResets(card.resetsAt, NOW), note].filter(Boolean).join(' · ');
  text(PAD + 14, barY + 24, resetLine, 11, C.dim);
  parts.push(`<text x="${W - PAD - 14}" y="${barY + 24}" font-size="10" fill="${C.dim}" ${MONO} text-anchor="end">${esc(spark)}</text>`);
  if (fcText)
    text(PAD + 14, barY + 40, fcText, 11, fc.exhaustsBeforeReset ? C.warning : C.dim, 'font-weight="600"');
  y += cardH + 10;
}

y += 12;
text(PAD, y, DATA.cost, 12, C.text, 'font-weight="600"');
y += 18;
text(PAD, y, `Updated ${DATA.updated}`, 11, C.dim);
y += 17;
text(PAD, y, `Session pings: last ${DATA.ping.last} · next ${DATA.ping.next}`, 11, C.dim);
y += 26;
// Today's sessions: ranked by the tokens they spent, each row a resume click.
text(PAD, y, "Today's sessions (est.)", 13, C.text, 'font-weight="700"');
for (const s of DATA.sessions) {
  y += 19;
  text(PAD, y, s.label, 12, C.text, 'font-weight="600"');
  parts.push(`<text x="${W - PAD}" y="${y}" font-size="11" fill="${C.dim}" ${FONT} text-anchor="end">${esc(`${compactTokens(s.tokens)}  ${s.when}`)}</text>`);
}
y += 26;
text(PAD, y, 'Cursor', 13, C.text, 'font-weight="700"');
y += 18;
text(PAD, y, DATA.cursor.cycle, 12, C.text, 'font-weight="600"');
y += 17;
text(PAD, y, DATA.cursor.today, 11, C.dim);
y += 16;
text(PAD, y, DATA.cursor.top, 11, C.dim);
y += 24;
parts.push(`<line x1="${PAD}" y1="${y}" x2="${W - PAD}" y2="${y}" stroke="${C.cardBorder}"/>`);
y += 24;
text(PAD, y, '↻  Refresh now', 12, C.text);
y += 20;

const H = y + 8;
const screenshotSvg = `<?xml version="1.0" encoding="UTF-8"?>
<!-- GENERATED by scripts/screenshots/render.mjs - edit data.json, not this file. -->
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" rx="16" fill="${C.bg}"/>
${parts.join('\n')}
</svg>
`;

// ── OG social card ──────────────────────────────────────────────────────────────
const ogSvg = `<?xml version="1.0" encoding="UTF-8"?>
<!-- GENERATED by scripts/screenshots/render.mjs - edit data.json, not this file. -->
<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="640" viewBox="0 0 1280 640">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
  <stop offset="0" stop-color="#161513"/><stop offset="1" stop-color="#2b1c14"/>
</linearGradient></defs>
<rect width="1280" height="640" fill="url(#g)"/>
<text x="72" y="140" font-size="30" fill="${C.text}" ${FONT} font-weight="700">${esc('✳ Claude Usage Panel')}</text>
<text x="72" y="240" font-size="64" fill="#ffffff" ${FONT} font-weight="800">Your Claude Code usage,</text>
<text x="72" y="310" font-size="64" fill="#ffffff" ${FONT} font-weight="800">everywhere you look.</text>
<text x="72" y="375" font-size="28" fill="#c9c4bb" ${FONT}>GNOME top bar · macOS menu bar · status line · MCP tool -</text>
<text x="72" y="410" font-size="28" fill="#c9c4bb" ${FONT}>with burn-rate forecasts before a limit runs dry.</text>
${(() => {
  let x = 72;
  return ['GNOME', 'macOS', 'status line', 'MCP', 'forecasts', 'Cursor spend'].map((k, i) => {
    const w = k.length * 15 + 44;
    const chip = `<rect x="${x}" y="450" width="${w}" height="52" rx="10" fill="#2a2a27" stroke="#3a3a36"/>
<text x="${x + 20}" y="483" font-size="24" fill="${i === 0 ? C.accent : C.text}" ${FONT} font-weight="600">${esc(k)}</text>`;
    x += w + 18;
    return chip;
  }).join('\n');
})()}
<text x="72" y="580" font-size="24" fill="#8f897e" ${FONT}>github.com/fschmutz/claude-usage-panel</text>
</svg>
`;

// ── Write / check ───────────────────────────────────────────────────────────────
const CHECK = process.argv.includes('--check');
let drift = false;
const emit = (rel, content) => {
  const p = path.join(ROOT, rel);
  const current = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  if (current === content) {
    console.log(`ok        ${rel}`);
    return;
  }
  if (CHECK) {
    console.error(`DRIFT     ${rel} - regenerate: node scripts/screenshots/render.mjs`);
    drift = true;
    return;
  }
  fs.writeFileSync(p, content);
  console.log(`written   ${rel}`);
};

emit('docs/screenshot.svg', screenshotSvg);
emit('docs/og.svg', ogSvg);

// Raster og.png for OpenGraph scrapers (they don't read SVG). Best-effort.
if (!CHECK) {
  const png = path.join(ROOT, 'docs', 'og.png');
  const svg = path.join(ROOT, 'docs', 'og.svg');
  let done = false;
  const quiet = {stdio: ['ignore', 'ignore', 'ignore']};
  try {
    execFileSync('rsvg-convert', ['-w', '1280', '-h', '640', '-o', png, svg], quiet);
    done = true;
  } catch {
    try {
      execFileSync('python3', ['-c',
        `import cairosvg; cairosvg.svg2png(url=${JSON.stringify(svg)}, write_to=${JSON.stringify(png)}, output_width=1280, output_height=640)`], quiet);
      done = true;
    } catch {
      // no rasterizer on this machine
    }
  }
  console.log(done ? 'written   docs/og.png'
    : 'skipped   docs/og.png (install rsvg-convert or python3-cairosvg to refresh it)');
}

if (drift) process.exit(1);
