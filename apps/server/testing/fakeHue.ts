import type { HueWriteOptions, HueWriter, StripCommand } from '../voiceLights.ts'

/**
 * An in-process stand-in for the Hue path, for tests and for rehearsing the
 * voice-light driver with no network at all. Label: SYNTHETIC. It records what
 * the driver sent and can be told to fail or hang, so the guards (deadline,
 * back-off) are exercised without a bridge. It is NOT the Hue simulator
 * (aixia/room/sim/hue_bridge.py, Docker) and says nothing about real timing.
 *
 * Lives in testing/ because the architecture test skips that directory, and
 * because it opens no connection (it is a recorder), which is the point.
 */
export interface FakeWrite { id: string; cmd: StripCommand; at: number; transitionMs: number; aborted: boolean }

export function createFakeHue(now: () => number = Date.now) {
  const writes: FakeWrite[] = []
  let mode: 'ok' | 'fail' | 'hang' = 'ok'
  const writer: HueWriter = {
    light(id: string, cmd: StripCommand, opts: HueWriteOptions) {
      const w: FakeWrite = { id, cmd, at: now(), transitionMs: opts.transitionMs, aborted: false }
      writes.push(w)
      if (mode === 'fail') return Promise.reject(new Error('fake bridge error'))
      if (mode === 'hang') {
        // Never settles on its own; only the driver's deadline can free the strip.
        return new Promise<never>((_, reject) => opts.signal.addEventListener('abort', () => { w.aborted = true; reject(new Error('aborted')) }))
      }
      return Promise.resolve()
    },
  }
  return { writer, writes, mode: (m: 'ok' | 'fail' | 'hang') => { mode = m } }
}
