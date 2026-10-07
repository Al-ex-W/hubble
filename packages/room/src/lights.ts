import type { LightCommand } from './spec.ts'

/**
 * Light moods within the Hue bridge's limits: about 10 light commands per
 * second in total and about 1 scene/group command per second (Hue's own
 * guidance; newer firmware answers 429 past it). The room spec's "10 per
 * second" is the ceiling, not a target.
 *
 * Commands are coalesced per light: if a light gets three changes before its
 * turn, only the latest is sent. Moods are about where the light ends up, not
 * the path, so dropping intermediate states loses nothing.
 */
export interface Sender {
  light(id: string, cmd: LightCommand): Promise<{ ok: boolean; reason?: string; retryAfterMs?: number } | unknown>
  scene(name: string): Promise<{ ok: boolean; reason?: string; retryAfterMs?: number } | unknown>
}

type Outcome = { ok: boolean; reason?: string; retryAfterMs?: number }
const outcome = (r: unknown): Outcome => (r && typeof r === 'object' && 'ok' in r ? (r as Outcome) : { ok: true })

export function createLightPlayer(send: Sender, opts: { lightsPerSecond?: number; scenesPerSecond?: number; now?: () => number } = {}) {
  const lightGap = 1000 / (opts.lightsPerSecond ?? 8)
  const sceneGap = 1000 / (opts.scenesPerSecond ?? 0.9)
  const now = opts.now ?? Date.now
  const pending = new Map<string, LightCommand>()
  let pendingScene: string | null = null
  let lastLight = -Infinity
  let lastScene = -Infinity
  let backoffUntil = 0

  return {
    set(id: string, cmd: LightCommand) {
      pending.set(id, { ...pending.get(id), ...cmd })
    },
    setScene(name: string) {
      pendingScene = name
    },
    /** A 429 or a failure: pause all writes for a moment. */
    backoff(ms = 1500) {
      backoffUntil = now() + ms
    },
    /** Call often (e.g. every 25 ms); sends at most what the limits allow. */
    async tick() {
      const t = now()
      if (t < backoffUntil) return
      if (pendingScene && t - lastScene >= sceneGap) {
        const s = pendingScene
        pendingScene = null
        lastScene = t
        const r = outcome(await send.scene(s))
        // A refused scene stays wanted: put it back unless a newer one arrived.
        if (!r.ok) {
          pendingScene ??= s
          if (r.reason === 'rate-limited') backoffUntil = now() + (r.retryAfterMs ?? 1500)
        }
        return
      }
      if (pending.size && t - lastLight >= lightGap) {
        const [id, cmd] = pending.entries().next().value as [string, LightCommand]
        pending.delete(id)
        lastLight = t
        const r = outcome(await send.light(id, cmd))
        if (!r.ok) {
          // Keep the desired state (merged under anything newer) and back off on 429.
          pending.set(id, { ...cmd, ...pending.get(id) })
          if (r.reason === 'rate-limited') backoffUntil = now() + (r.retryAfterMs ?? 1500)
        }
      }
    },
    pendingCount: () => pending.size + (pendingScene ? 1 : 0),
  }
}

/** Mood per runtime mode, as light commands. Colours match the stage's palette. */
export const MOODS: Record<string, LightCommand> = {
  idle: { on: true, bri: 60, color: '#28465a' },
  listening: { on: true, bri: 140, color: '#6cf0ff' },
  thinking: { on: true, bri: 110, color: '#7a6cff' },
  answering: { on: true, bri: 170, color: '#ffd36c' },
}
