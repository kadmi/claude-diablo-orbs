export type Gauges = {
  /** Context window used, 0–100; null before the first response. */
  contextUsed: number | null
  /** Rate-limit window used, 0–100; null off a subscription. */
  limitUsed: number | null
  /** Which rate-limit window `limitUsed` reads (`five_hour`, `seven_day`, ...). */
  limitKind: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'diablo-orbs': { gauges: Gauges }
  }
}
