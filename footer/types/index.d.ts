export type UsageLimit = { kind: string; percent: number; resetsAt?: string }
export type UsageSnapshot = {
  at: number
  limits: UsageLimit[]
  contextPercent?: number
  contextTokens?: number
  contextWindow?: number
  costUsd?: number
}

export type SessionEnv = { model?: string; project?: string; branch?: string }

declare module 'claude-code' {
  interface PluginState {
    'usage-footer': {
      snapshot: Shaped<UsageSnapshot | null>
      now: number
      env: Shaped<SessionEnv | null>
      mode: string | null
    }
  }
}
