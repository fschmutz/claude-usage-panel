import type { ElementTable, EngineInterface, RenderElement, RenderInput } from 'claude-code'

import type { SessionEnv, UsageLimit, UsageSnapshot } from '../types'
import { GAUGE_COLORS, clampPercent, compactResets } from './pure/usage.js'
import { clockPace, forecast } from './pure/pace.js'

type Sample = [number, number]
type Tone = keyof typeof GAUGE_COLORS

// A run of text and how it is painted. Both halves of the footer are lists of
// runs, so their widths are known before drawing.
type Run = { text: string; color?: string; bg?: string; bold?: boolean; dim?: boolean }
type Density = { bar: number; resets: boolean; cost: boolean }
type Detail = { project: boolean; branch: boolean }

// The meters sit in the engine's right-hand slot (SessionMode), which Claude
// Code itself pins to the right edge; their density depends on the terminal's
// width alone, so the left half can compute what is left for it.
const METER_DENSITIES: [number, Density][] = [
  [190, { bar: 12, resets: true, cost: true }],
  [160, { bar: 10, resets: true, cost: true }],
  [130, { bar: 8, resets: false, cost: true }],
  [100, { bar: 5, resets: false, cost: false }],
  [0, { bar: 0, resets: false, cost: false }],
]
const DETAILS: Detail[] = [
  { project: true, branch: true },
  { project: true, branch: false },
  { project: false, branch: false },
]

export function meterDensity(columns: number): Density {
  const hit = METER_DENSITIES.find(([min]) => columns >= min)
  return (hit ?? METER_DENSITIES[METER_DENSITIES.length - 1])?.[1] as Density
}

const LABEL: Record<string, string> = { context: 'context', five_hour: 'session', seven_day: 'week', spend_limit: 'spend' }
const GROUP: Record<string, string> = { five_hour: 'session', seven_day: 'weekly' }
const TRACK = '#3b4252'
const SEP: Run = { text: '   ' }

// Claude Code draws its permission mode left of this line, outside any hook
// ("⏵⏵ auto mode on · "). Its width is taken off the row so the meters end
// flush with the edge instead of being cut. The label per mode is the one the
// engine prints; an unknown mode reserves the longest.
const MODE_LABEL: Record<string, string> = {
  auto: '⏵⏵ auto mode on',
  acceptEdits: '⏵⏵ accept edits on',
  plan: '⏸ plan mode on',
  bypassPermissions: '⏵⏵ bypass permissions on',
  dontAsk: "⏵⏵ don't ask on",
}

export function enginePrefixWidth(hint: string, mode: string | null): number {
  if (!/shift\+tab to cycle/i.test(hint) || mode === 'default') return 0
  const label = (mode && MODE_LABEL[mode]) ?? MODE_LABEL.bypassPermissions ?? ''
  return [...label].length + 3
}

function toneOf(percent: number, isRunningDry: boolean): Tone {
  if (percent >= 90) return 'critical'
  if (percent >= 75 || isRunningDry) return 'warning'
  return 'normal'
}

function width(runs: readonly Run[]): number {
  return runs.reduce((n, r) => n + [...r.text].length, 0)
}

// A thin rule: the used part in the tone's color, the rest a muted track of
// the same weight, so even 7% reads as a bar. `tick` marks where the clock
// stands in the window: a bar past it burns faster than time.
function bar(percent: number, cells: number, color: string, tick: number | null): Run[] {
  const pct = clampPercent(percent)
  const used = pct > 0 ? Math.max(1, Math.round((pct / 100) * cells)) : 0
  const out: { ch: string; color: string; bold?: boolean }[] = []
  for (let i = 0; i < cells; i++) out.push({ ch: '━', color: i < used ? color : TRACK })
  if (tick !== null && cells > 0) {
    const at = Math.min(cells - 1, Math.max(0, Math.round((tick / 100) * (cells - 1))))
    out[at] = { ch: '┃', color: 'text', bold: true }
  }
  const runs: Run[] = []
  for (const c of out) {
    const last = runs[runs.length - 1]
    if (last && last.color === c.color && last.bold === c.bold) last.text += c.ch
    else runs.push({ text: c.ch, color: c.color, bold: c.bold })
  }
  return runs
}

function meter(key: string, percent: number, tone: Tone, d: Density, tick: number | null = null): Run[] {
  const color = GAUGE_COLORS[tone]
  const runs: Run[] = [{ text: `${LABEL[key] ?? key} `, dim: true }]
  if (d.bar > 0) runs.push(...bar(percent, d.bar, color, tick), { text: ' ' })
  runs.push({ text: `${clampPercent(percent)}%`.padStart(4), color, bold: true })
  return runs
}

/** "claude-opus-5-5" → "Opus 5.5"; anything else as given. */
export function modelName(id: string): string {
  const m = /claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/i.exec(id)
  if (!m || !m[1] || !m[2]) return id
  const family = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase()
  return `${family} ${m[2]}${m[3] ? `.${m[3]}` : ''}${/\[1m\]/i.test(id) ? ' 1M' : ''}`
}

function identity(env: SessionEnv | null, d: Detail): Run[] {
  const runs: Run[] = [
    { text: '● ', color: 'claude' },
    { text: env?.model ? modelName(env.model) : 'Claude', bold: true },
  ]
  if (d.project && env?.project) runs.push({ text: '  ' }, { text: env.project })
  if (d.branch && env?.branch) runs.push({ text: ' ' }, { text: `⎇ ${env.branch}`, color: 'suggestion' })
  return runs
}

function limitMeter(l: UsageLimit, samples: Record<string, Sample[]>, now: number, d: Density): Run[] {
  const pct = clampPercent(l.percent)
  const fc = forecast(samples[l.kind] ?? [], l.resetsAt ?? null, now)
  const isRunningDry = fc?.exhaustsBeforeReset === true
  const tone = toneOf(pct, isRunningDry)
  const group = GROUP[l.kind]
  const pace = group && l.resetsAt ? clockPace({ group, resetsAt: l.resetsAt, percent: pct }, now) : null
  const runs = meter(l.kind, pct, tone, d, pace?.elapsedPercent ?? null)
  const reset = l.resetsAt ? compactResets(l.resetsAt, now) : ''
  if (d.resets && reset) runs.push({ text: ` ↻${reset}`, dim: true })
  if (isRunningDry) runs.push({ text: ' ▲', color: GAUGE_COLORS[tone], bold: true })
  return runs
}

function contextPercent(snap: UsageSnapshot | null): number | null {
  if (typeof snap?.contextPercent === 'number') return snap.contextPercent
  if (typeof snap?.contextTokens === 'number' && snap.contextWindow) return (snap.contextTokens / snap.contextWindow) * 100
  return null
}

function meters(snap: UsageSnapshot | null, samples: Record<string, Sample[]>, now: number, d: Density): Run[] {
  const groups: Run[][] = []
  const ctx = contextPercent(snap)
  if (ctx !== null) groups.push(meter('context', ctx, toneOf(ctx, false), d))
  // Only the windows the session reports: a plan without a 5h limit (Ultra)
  // has no session meter at all, never an empty one.
  for (const l of snap?.limits ?? []) groups.push(limitMeter(l, samples, now, d))
  if (d.cost && typeof snap?.costUsd === 'number' && snap.costUsd >= 0.005) {
    groups.push([{ text: `$${snap.costUsd.toFixed(2)}`, dim: true }])
  }
  return groups.flatMap((g, i) => (i === 0 ? g : [SEP, ...g]))
}

// The engine's hint line, one string ("(shift+tab to cycle) · ← 5 agents"),
// recast as pills. The keys it names stay bound, so only the words move. A
// piece this does not know is kept as written, dim: nothing Claude Code wanted
// said is lost.
const MODE_COLORS: Record<string, string> = {
  plan: 'planMode',
  auto: 'autoAccept',
  'accept edits': 'autoAccept',
  'bypass permissions': 'error',
}

export function hintPills(hint: string): Run[][] {
  const pills: Run[][] = []
  for (const raw of hint.split(' · ')) {
    const piece = raw.replace(/\s*\(shift\+tab to cycle\)/i, '').trim()
    if (piece === '' || /^\? for shortcuts$/i.test(piece)) continue
    const mode = /^(\S*[⏵⏸»]\S*)?\s*(.+?) mode on$/i.exec(piece)
    if (mode && mode[2]) {
      const name = mode[2].toLowerCase()
      pills.push([{ text: `${mode[1] ?? '⏵⏵'} ${name}`, color: MODE_COLORS[name] ?? 'warning', bold: true }])
      continue
    }
    const agents = /^←\s*(\d+)\s+(.+)$/.exec(piece)
    if (agents && agents[1] && agents[2]) {
      pills.push([{ text: `${agents[1]} ${agents[2]} ←`, dim: true }])
      continue
    }
    const esc = /^esc to (.+)$/i.exec(piece)
    if (esc && esc[1]) {
      pills.push([{ text: 'esc', bold: true }, { text: ` to ${esc[1]}`, dim: true }])
      continue
    }
    pills.push([{ text: piece, dim: true }])
  }
  return pills
}

function joinPills(pills: Run[][]): Run[] {
  return pills.flatMap((p, i) => (i === 0 ? p : [{ text: '  ·  ', color: 'subtle' }, ...p]))
}

function line(Text: ElementTable['Text'], runs: readonly Run[]): RenderElement {
  return (
    <Text wrap="truncate-end">
      {runs.map(r => (
        <Text color={r.color} backgroundColor={r.bg} bold={r.bold} dimColor={r.dim}>
          {r.text}
        </Text>
      ))}
    </Text>
  )
}

/**
 * The right half of the footer, drawn in the engine's mode slot so it stays
 * flush with the right edge whatever Claude Code draws on the left: the
 * engine's own mode labels (if any), then context, each plan window, cost.
 */
export function drawMeters(
  $: EngineInterface,
  e: RenderInput<'SessionMode'>,
  snap: UsageSnapshot | null,
  samples: Record<string, Sample[]>,
  now: number,
): RenderElement {
  const { Box, Text } = $.ui.resolve(e)
  const runs = meters(snap, samples, now, meterDensity(e.viewport?.columns ?? 100))
  const modes: Run[] = e.props.modes.length ? [{ text: e.props.modes.join(' & '), dim: true }, SEP] : []
  return <Box>{line(Text, [...modes, ...runs])}</Box>
}

/**
 * The left half of the footer, in place of the engine's hint line: identity
 * (model, project, branch) and the engine's own status (agents, esc to
 * interrupt), dropping the branch then the project when the row is short.
 */
export function drawFooter(
  $: EngineInterface,
  e: RenderInput<'PromptHint'>,
  snap: UsageSnapshot | null,
  env: SessionEnv | null,
  mode: string | null,
  samples: Record<string, Sample[]>,
  now: number,
): RenderElement {
  const { Box, Text } = $.ui.resolve(e)
  const columns = e.viewport?.columns ?? 100
  const hint = [e.props.hint, e.props.tail].filter(Boolean).join(' · ')
  const right = width(meters(snap, samples, now, meterDensity(columns)))
  const room = columns - 1 - enginePrefixWidth(hint, mode) - right - 3
  const status = joinPills(hintPills(hint))
  const withStatus = (runs: Run[]) => (status.length ? [...runs, { text: '   ' }, ...status] : runs)

  let left = withStatus(identity(env, DETAILS[DETAILS.length - 1] as Detail))
  for (const d of DETAILS) {
    const candidate = withStatus(identity(env, d))
    if (width(candidate) <= room) {
      left = candidate
      break
    }
  }
  return <Box>{line(Text, left)}</Box>
}
