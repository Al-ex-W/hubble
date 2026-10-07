import { describe, expect, it } from 'vitest'
import { createSpatialService } from './service.ts'
import { Observation } from './observations.ts'

/**
 * Several camera sources in the one spatial owner (#91). Label:
 * schema-derived (observations shaped by observations.ts, timed by an
 * injected clock). Oracle: plain arithmetic of the two maps below, which
 * differ on purpose so a finger mapped with the wrong source's map lands
 * visibly elsewhere.
 */
const ROOM = { h: [1, 0, 0, 0, 1, 0, 0, 0, 1], width: 1920, height: 1080, geometry: 'room:full-frame' }
// The iPad's map: camera px × 1.5 + (10, 20) table px.
const IPAD = { h: [1.5, 0, 10, 0, 1.5, 20, 0, 0, 1], width: 1280, height: 720, geometry: 'ipad:1280x720' }

const room = (seq: number, t: number) => ({ session: 'room-tab', seq, capturedAt: t, geometry: ROOM.geometry, width: 1920, height: 1080, hands: [{ index: { x: 100, y: 100 } }] })
const ipad = (seq: number, t: number) => ({ source: 'ipad' as const, session: 'ipad-page', seq, capturedAt: t, geometry: IPAD.geometry, width: 1280, height: 720, hands: [{ index: { x: 100, y: 100 } }] })

function setup() {
  let t = 1000
  const s = createSpatialService({ now: () => t })
  s.calibration.setCamera(ROOM)
  s.calibration.setCamera(IPAD, 'ipad')
  return { s, at: (ms: number) => (t = ms) }
}

describe('camera sources', () => {
  it('maps each source with its own camera map', () => {
    // Break caught: one map for every source. The iPad's pixel (100,100)
    // read with the room's map lands at (100,100) instead of (160,170).
    const { s, at } = setup()
    at(1000)
    expect(s.observe(ipad(1, 1))).toBe(true)
    const f = s.snapshot().camera
    expect(f.source).toBe('ipad')
    expect(f.state).toBe('receiving')
    expect(f.fingers[0]!.projector).toEqual({ x: 160, y: 170 })
    s.stop()
  })

  it('lets the iPad and the room camera stream at once, and reads the faster one', () => {
    // Break caught (1): one lease for all sources. The room tab's lease
    // would refuse the iPad's frames (a different session) and the faster
    // camera could never be used. Break caught (2): no rate selection.
    const { s, at } = setup()
    let t = 1000
    let r = 0
    let i = 0
    // The room camera speaks first, so "the first source seen" and "the
    // fastest source" differ: only a real rate comparison picks the iPad.
    at(t)
    expect(s.observe(room(++r, t))).toBe(true)
    for (let k = 1; k < 30; k++) {
      t += 33
      at(t)
      expect(s.observe(ipad(++i, t))).toBe(true)
      if (k % 6 === 0) expect(s.observe(room(++r, t))).toBe(true)
    }
    const f = s.snapshot().camera
    expect(f.source).toBe('ipad')
    expect(f.sources.find((x) => x.id === 'ipad')!.fps).toBeGreaterThan(20)
    expect(f.sources.find((x) => x.id === 'room')!.fps).toBeLessThan(8)
    s.stop()
  })

  it('falls back to the room camera when the iPad goes quiet', () => {
    // Break caught: a selection that sticks to a dead source; typing would
    // stop although the room camera is still streaming.
    const { s, at } = setup()
    let t = 1000
    for (let k = 1; k <= 10; k++) {
      t += 33
      at(t)
      s.observe(ipad(k, t))
      s.observe(room(k, t))
    }
    for (let k = 11; k <= 30; k++) {
      t += 100
      at(t)
      s.observe(room(k, t))
    }
    expect(s.snapshot().camera.source).toBe('room')
    expect(s.snapshot().camera.state).toBe('receiving')
    s.stop()
  })

  it('does not switch between two sources of about the same rate', () => {
    // Break caught: flapping. Each switch changes the frame's session, which
    // keyboardInput treats as a discontinuity and cancels the press.
    const { s, at } = setup()
    let t = 1000
    const seen = new Set<string | null>()
    // Room every 50 ms exactly; the iPad alternately 40 and 60 ms apart,
    // so its measured rate swings just above and below the room's.
    for (let k = 1; k <= 40; k++) {
      t += 50
      at(t)
      s.observe(room(k, t))
      at(t + (k % 2 ? 5 : -5))
      s.observe(ipad(k, t + (k % 2 ? 5 : -5)))
      at(t)
      if (k > 5) seen.add(s.snapshot().camera.source)
    }
    expect(seen.size).toBe(1)
    s.stop()
  })

  it('switches at 25 % more fps, not before (13 vs 10 fps switches, 12 vs 10 does not)', () => {
    // Break caught (review of #95, finding 7): the threshold written as
    // 0.75 × the interval, which demands 33⅓ % more fps; 13 fps then never
    // took over from 10 fps although the doc and the plan say 25 %. Oracle:
    // the rates themselves (1000/13 = 76.9 ms < 100/1.25 = 80 ms < 83.3 ms).
    const pick = (ipadFps: number) => {
      const { s, at } = setup()
      // The room alone from 1000 ms at 10 fps, so it is the selected source
      // when the iPad joins at 1550 ms. Both run until 4000 ms.
      const events: { t: number; src: 'room' | 'ipad' }[] = []
      for (let t = 1000; t < 4000; t += 100) events.push({ t, src: 'room' })
      for (let t = 1550; t < 4000; t += 1000 / ipadFps) events.push({ t, src: 'ipad' })
      events.sort((x, y) => x.t - y.t)
      let r = 0
      let i = 0
      for (const e of events) {
        at(e.t)
        expect(e.src === 'room' ? s.observe(room(++r, e.t)) : s.observe(ipad(++i, e.t))).toBe(true)
      }
      const source = s.snapshot().camera.source
      s.stop()
      return source
    }
    expect(pick(13)).toBe('ipad')
    expect(pick(12)).toBe('room')
  })

  it('never reads a source that has no map of its own', () => {
    // Break caught: falling back to the room's map for an uncalibrated iPad.
    let t = 1000
    const s = createSpatialService({ now: () => t })
    s.calibration.setCamera(ROOM)
    s.observe(ipad(1, 1))
    expect(s.snapshot().camera.state).toBe('uncalibrated')
    expect(s.snapshot().camera.fingers[0]!.projector).toBeNull()
    t += 10
    s.observe(room(1, t))
    expect(s.snapshot().camera.source).toBe('room')
    s.stop()
  })

  it('accepts only the known sources on the wire', () => {
    // Break caught: an open source key. Each source keeps a map forever, so
    // any client on the room Wi-Fi could grow the registry without bound.
    expect(Observation.safeParse(ipad(1, 1)).success).toBe(true)
    expect(Observation.safeParse(room(1, 1)).success).toBe(true)
    expect(Observation.safeParse({ ...ipad(1, 1), source: 'phone' }).success).toBe(false)
  })
})
