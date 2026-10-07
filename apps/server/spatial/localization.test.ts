import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { runCalibration } from '../calibration.ts'
import { createSpatialService } from './service.ts'
import { createCalibration } from './calibration.ts'
import { fit, inverse, map } from './coordinates.ts'
import { createSurfaceManager } from '../surfaces.ts'

const dir = new URL('../fixtures/calibration-2026-10-07/', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('manifest.json', dir), 'utf8'))

// Schema-derived plane targets; independent rectangle arithmetic is the oracle.
// They test coordinate algebra, NEVER claim measured physical registration.
const corners = [
  { x: 0, y: 0 },
  { x: 1000, y: 0 },
  { x: 1000, y: 500 },
  { x: 0, y: 500 },
]
const checks = [
  { x: 250, y: 125 },
  { x: 750, y: 375 },
]
const tablePairs = (ps: typeof corners) => ps.map((from) => ({ from, to: { x: from.x * 2 + 10, y: from.y * 2 + 20 } }))
const lidarPairs = (ps: typeof corners) => ps.map((from) => ({ from, to: { x: from.x + 50, y: from.y + 100 } }))
const registration = {
  table: tablePairs(corners),
  tableCheck: tablePairs(checks),
  lidar: lidarPairs(corners),
  lidarCheck: lidarPairs(checks),
  maxProjectorErrorPx: 1,
  maxTableErrorMm: 1,
}

describe('one shared spatial coordinate owner', () => {
  it('uses the real rotated room calibration to locate a projected surface', async () => {
    // The original paired-by-row algorithm mirrored the table. This replay
    // uses recorded camera pixels and the independently projected grid target.
    const queue = manifest.frames.map((name: string) => new Uint8Array(readFileSync(new URL(`${name}.jpg`, dir))))
    const run = await runCalibration({ frame: async () => queue.shift()!, overlay: () => {}, dots: manifest.dots, settleMs: 0 })
    expect(run.ok).toBe(true)
    const spatial = createSpatialService()
    spatial.calibration.setCamera({ h: run.h!, width: 1920, height: 1080, geometry: 'room:full-frame' })
    const surfaces = createSurfaceManager({ publish: () => {} })
    surfaces.openKeyboard({ x: 180, y: 95, w: 30, h: 30 }, {})
    spatial.followSurfaces(surfaces)
    const seen = run.dots[0].seen!
    expect(spatial.observe({ session: 'recording', seq: 1, capturedAt: 0, geometry: 'room:full-frame', width: 1920, height: 1080, hands: [{ index: seen }] })).toBe(true)
    const finger = spatial.snapshot().camera.fingers[0]
    expect(finger.surfaceId).toBe('keyboard')
    expect(Math.hypot(finger.projector!.x - 192, finger.projector!.y - 108)).toBeLessThan(10)
    expect(finger.heightMm).toBeNull()
    expect(finger.contact).toBe('unknown')
    expect(spatial.snapshot().touchEnabled).toBe(false)
    spatial.stop()
  })
  it('maps lidar and projector into the same measured plane and rejects bad check targets', () => {
    // A wrong inverse/origin moves the laser away from the camera. Expected
    // positions here are plain independently specified affine arithmetic.
    const cal = createCalibration()
    cal.register(registration)
    expect(cal.lidarToTable({ x: 200, y: 100 })!.x).toBeCloseTo(250)
    expect(cal.projectorToTable({ x: 510, y: 420 })!.y).toBeCloseTo(200)
    expect(cal.tableToProjector({ x: 250, y: 200 })!.x).toBeCloseTo(510)
    const before = cal.snapshot()
    expect(() => cal.register({ ...registration, tableCheck: tablePairs(checks).map((p) => ({ ...p, to: { x: p.to.x + 100, y: p.to.y } })) })).toThrow()
    expect(cal.snapshot()).toEqual(before)
    expect(inverse([0, 0, 0, 0, 0, 0, 0, 0, 0])).toBeNull()
    expect(map([1, 0, 0, 0, 1, 0, 0, 0, 0], { x: 1, y: 2 })).toBeNull()
    expect(() => fit(Array(4).fill({ from: { x: 0, y: 0 }, to: { x: 0, y: 0 } }), tablePairs(checks), 1)).toThrow()
  })
  it('rejects competing producers and clears evidence on silence, crop or calibration changes', () => {
    // Schema-derived lifecycle mutation of a valid observation. Otherwise a
    // stopped tab leaves a finger over a key indefinitely or a new crop types
    // at the old location. These are diagnostic lifecycle tests, not touches.
    let now = 0
    const s = createSpatialService({ now: () => now })
    const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1]
    s.calibration.setCamera({ h: identity, width: 1920, height: 1080, geometry: 'room:full-frame' })
    const f = { session: 'a', seq: 1, capturedAt: 1, geometry: 'room:full-frame', width: 1920, height: 1080, hands: [{ index: { x: 192, y: 108 } }] }
    expect(s.observe(f)).toBe(true)
    expect(s.observe({ ...f, session: 'b', seq: 2, capturedAt: 2 })).toBe(false)
    expect(s.observe(f)).toBe(false)
    now = 501
    expect(s.snapshot().camera.fingers).toEqual([])
    expect(s.observe({ ...f, seq: 2, capturedAt: 2, geometry: 'cropped' })).toBe(true)
    expect(s.snapshot().camera.fingers[0].projector).toBeNull()
    s.calibration.setCamera({ h: [1, 0, 1, 0, 1, 0, 0, 0, 1], width: 1920, height: 1080, geometry: 'room:full-frame' })
    expect(s.snapshot().camera.fingers).toEqual([])
    s.stop()
  })
})


it('does not let a feature mutate another feature’s spatial snapshot', () => {
  // Schema-derived ownership boundary. A consumer sorting/editing a returned
  // frame must not corrupt the next consumer's raw camera evidence.
  const service = createSpatialService()
  service.observe({session:'one',seq:1,capturedAt:1,geometry:'room:full-frame',width:1920,height:1080,hands:[{index:{x:12,y:34}}]})
  service.snapshot().camera.frame!.hands[0].index.x = 999
  service.snapshot().camera.fingers[0].camera.x = 888
  expect(service.snapshot().camera.frame!.hands[0].index.x).toBe(12)
  service.stop()
  expect(service.observe({session:'late',seq:2,capturedAt:2,geometry:'room:full-frame',width:1920,height:1080,hands:[]})).toBe(false)
})
