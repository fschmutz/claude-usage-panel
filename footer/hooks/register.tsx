import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { SessionEnv, UsageLimit, UsageSnapshot } from '../types'
import { drawFooter, drawMeters } from './footer.js'
import { clampPercent } from './pure/usage.js'
import { latchCrossings } from './pure/events.js'

const SAMPLE_TTL_MS = 6 * 3600_000
const SAMPLE_MAX = 120

const snapshot = atom({ plugin: 'usage-footer', key: 'snapshot' } as const, null, { shape: 'snapshot-1' })
const clock = atom({ plugin: 'usage-footer', key: 'now' } as const, 0)
const env = atom({ plugin: 'usage-footer', key: 'env' } as const, null, { shape: 'env-1' })
// The permission mode, as the classic hook events carry it: the footer takes
// the width of the engine's mode label off its row.
const mode = atom({ plugin: 'usage-footer', key: 'mode' } as const, null)

type Sample = [number, number]
type Samples = Record<string, Sample[]>
// The name a limit-crossing toast gives each window.
const TITLES: Record<string, string> = { five_hour: 'Session', seven_day: 'Weekly', spend_limit: 'Spend' }

function toLimits(raw: readonly SessionRateLimit[]): UsageLimit[] {
  return raw.map(l => ({ kind: l.kind, percent: l.percentUsed, resetsAt: l.resetsAt }))
}

// Module state: rebuilt from $.store on every session.start (a reload included).
let samples: Samples = {}
const fired = new Map<string, number>()

async function readEnv($: EngineInterface) {
  const [model, cwd] = await Promise.all([$.session.model(), $.session.cwd()])
  let branch: string | undefined
  try {
    const git = await $.process.run(['git', 'branch', '--show-current'], { cwd, timeoutMs: 2000 })
    branch = git.exitCode === 0 ? git.stdout.trim() || undefined : undefined
  } catch {
    branch = undefined
  }
  const project = cwd.split('/').filter(Boolean).pop()
  const next: SessionEnv = { model, project, branch }
  await update($, env, () => next)
}

async function record($: EngineInterface, limits: UsageLimit[], ctx: Partial<UsageSnapshot>) {
  const now = Date.now()
  for (const l of limits) {
    const list = (samples[l.kind] ?? []).filter(([t]) => t > now - SAMPLE_TTL_MS)
    const last = list[list.length - 1]
    if (!last || last[1] !== l.percent || now - last[0] > 5 * 60_000) list.push([now, l.percent])
    samples[l.kind] = list.slice(-SAMPLE_MAX)
  }
  await $.store.set('samples', samples)

  const snap: UsageSnapshot = { at: now, limits, ...ctx }
  await update($, snapshot, () => snap)

  const cards = limits.map(l => ({ key: l.kind, percent: clampPercent(l.percent) }))
  const crossings = latchCrossings(fired, cards) as { card: (typeof cards)[number]; threshold: number }[]
  for (const { card, threshold } of crossings) {
    const title = TITLES[card.key] ?? card.key
    $.ui.toast(threshold >= 100 ? `${title} limit reached` : `${title} limit at ${card.percent}%`)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const stored = await $.store.get('samples')
    samples = stored && typeof stored === 'object' ? (stored as Samples) : {}

    const usage = await $.session.usage()
    await record($, toLimits(usage.rateLimits), {
      contextPercent: usage.context.percent,
      contextTokens: usage.context.tokens,
      contextWindow: usage.context.window,
      costUsd: usage.cost?.usd,
    })
    await readEnv($)
    $.clock.every(30_000, () => void update($, clock, () => Date.now()))
    return result
  })

  on('session.measure', async ($, e, next) => {
    await record($, toLimits(e.rateLimits), {
      contextPercent: e.context.percent,
      contextTokens: e.context.tokens,
      contextWindow: e.context.window,
      costUsd: e.cost?.usd,
    })
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await readEnv($)
    return result
  })

  // Observers only: each passes the event on untouched, and one that fails
  // must never stand in the way of the prompt, the tool or the stop.
  on('classic.UserPromptSubmit', async ($, e, next) => {
    const result = await next(e)
    if (e.permission_mode) await update($, mode, () => e.permission_mode ?? null)
    return result
  }).catch(($, e, next) => next(e))

  on('classic.PostToolUse', async ($, e, next) => {
    const result = await next(e)
    if (e.permission_mode) await update($, mode, () => e.permission_mode ?? null)
    return result
  }).catch(($, e, next) => next(e))

  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    if (e.permission_mode) await update($, mode, () => e.permission_mode ?? null)
    return result
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'PromptHint' }, async ($, e) => {
    const [snap, sessionEnv, permissionMode, tick] = await Promise.all([
      read($, snapshot),
      read($, env),
      read($, mode),
      read($, clock),
    ])
    return drawFooter($, e, snap, sessionEnv, permissionMode, samples, Math.max(tick, Date.now()))
  })

  on('ui.render', { component: 'SessionMode' }, async ($, e) => {
    const [snap, tick] = await Promise.all([read($, snapshot), read($, clock)])
    return drawMeters($, e, snap, samples, Math.max(tick, Date.now()))
  })
}
