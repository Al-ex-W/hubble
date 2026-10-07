import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import type { Trace } from '../../shared/hands/types.ts'
import { createSurfaceManager } from '../surfaces.ts'
import { createSpatialService } from './service.ts'
import type { HandObservation } from './observations.ts'

// Recording: actual joints, unchanged. The affine calibration and lifecycle
// changes below are schema-derived probes; they assert geometry/ownership,
// never camera accuracy or physical contact. Arithmetic is independent of H.
const trace = JSON.parse(readFileSync(new URL('../../web/src/hands/fixtures/IMG_3537.trace.json', import.meta.url), 'utf8')) as Trace
function observation(): HandObservation {
  const h = trace.frames[50]!.hands[0]!
  const p = (i: number) => ({ x: h.lm[i]![0], y: h.lm[i]![1] })
  return { session: 'recorded', seq: 50, capturedAt: trace.frames[50]!.t, geometry: 'take', width: 1920, height: 1080,
    hands: [{ index: p(8), pinch: { thumb: p(4), wrist: p(0), middle: p(9) } }] }
}
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(f => f()); vi.useRealTimers() })
function setup() {
  let time = 0
  const spatial = createSpatialService({ now: () => time })
  cleanups.push(() => spatial.stop())
  const surfaces = createSurfaceManager({ publish: () => {} })
  spatial.followSurfaces(surfaces)
  const calibration = { h: [2, 0, 10, 0, 2, 20, 0, 0, 1], width: 1920, height: 1080, geometry: 'take' }
  spatial.calibration.setCamera(calibration)
  return { spatial, surfaces, calibration, advance(ms: number) { time += ms } }
}

it('publishes the same independent index/pen mapping and revision that a reader receives', () => {
  // Break: keeping a separate camera-only event leaks different geometry than
  // GET; mapping the index as the pen shifts a closed pinch across key edges.
  const s = setup()
  const seen: ReturnType<typeof s.spatial.snapshot>[] = []
  s.spatial.subscribe(frame => seen.push(frame))
  s.surfaces.openKeyboard({ x: 0, y: 0, w: 1900, h: 1100 }, {})
  const raw = observation()
  expect(trace.frames).toHaveLength(330)
  expect(s.spatial.observe(raw)).toBe(true)
  const frame = s.spatial.snapshot()
  expect(frame).toEqual(seen.at(-1))
  expect(frame.schema).toBe('SpatialFrame/v2')
  const hand = frame.camera.fingers[0]!
  expect(hand.projector).toEqual({ x: raw.hands[0]!.index.x * 2 + 10, y: raw.hands[0]!.index.y * 2 + 20 })
  expect(hand.pen?.projector).toEqual({ x: raw.hands[0]!.index.x + raw.hands[0]!.pinch!.thumb.x + 10, y: raw.hands[0]!.index.y + raw.hands[0]!.pinch!.thumb.y + 20 })
  expect(hand.contact).toBe('unknown')
  expect(hand.heightMm).toBeNull()
  expect(frame.camera.calibrationRevision).toBe(frame.calibration.revision)
  const count = seen.length
  expect(s.spatial.observe(raw)).toBe(false)
  expect(seen).toHaveLength(count)
  // A feature can annotate its copy without changing raw inputs or another
  // subscriber. Mutating the input after POST likewise cannot rewrite history.
  raw.hands[0]!.index.x = -999
  frame.camera.fingers[0]!.projector!.x = -888
  expect(s.spatial.snapshot()).toEqual(seen.at(-1))
})

it('publishes move-away-and-back, invalid calibration, silence and shutdown without a new camera sample', async () => {
  // Break: polling only at the next camera packet misses transient target
  // changes and leaves a stopped hand visible to subscribers indefinitely.
  vi.useFakeTimers()
  const s = setup()
  const frames: ReturnType<typeof s.spatial.snapshot>[] = []
  s.spatial.subscribe(frame => frames.push(frame))
  s.surfaces.openKeyboard({ x: 10, y: 10, w: 100, h: 100 }, {})
  s.spatial.observe(observation())
  s.surfaces.move('keyboard', { dx: 20, dy: 0 })
  s.surfaces.move('keyboard', { dx: -20, dy: 0 })
  expect(frames.slice(-2).map(f => f.surfaces[0]!.box.x)).toEqual([30, 10])
  s.spatial.calibration.setCamera({ ...s.calibration, h: [1, 0, 10, 0, 1, 20, 0, 0, 1] })
  expect(frames.at(-1)!.camera.fingers).toEqual([])
  expect(frames.at(-1)!.calibration.revision).toBe(2)
  s.spatial.observe({ ...observation(), seq: 51, capturedAt: 1800 })
  s.advance(501)
  await vi.advanceTimersByTimeAsync(50)
  expect(frames.at(-1)!.camera.state).toBe('stale')
  expect(frames.at(-1)!.camera.fingers).toEqual([])
  s.spatial.stop()
  expect(frames.at(-1)!.state).toBe('stopped')
  expect(vi.getTimerCount()).toBe(0)
  const count = frames.length
  s.spatial.calibration.setCamera(s.calibration)
  s.surfaces.close('keyboard')
  await vi.advanceTimersByTimeAsync(1000)
  expect(frames).toHaveLength(count)
})

it('does not divide by zero when an answer has an anchor but no layout yet', () => {
  // Schema-derived runtime state: an answer starts as a zero-area surface.
  // Stage includes its exact border in hits, but there is no normalized point
  // within that box. Otherwise HTTP serializes NaN differently from subscribers.
  const s = setup()
  s.surfaces.openLaid('empty', 'launcher', { x: 10, y: 20, w: 0, h: 0 }, {})
  s.spatial.observe({ ...observation(), hands: [{ index: { x: 0, y: 0 } }] })
  const local = s.spatial.snapshot().camera.fingers[0]!.surface
  expect(local?.id).toBe('empty')
  expect(local?.localPx).toEqual({ x: 0, y: 0 })
  expect(local?.normalized).toBeNull()
})

it('keeps reentrant changes ordered and isolates subscriber mutation', () => {
  // Contract probe: a consumer may synchronously move a surface or commit a
  // draft. Recursive fan-out used to be camera-only; a merged frame stream
  // must not deliver new revision N+1 and then stale N to later observers.
  const s = setup()
  const orders: number[] = []
  let moved = false
  s.surfaces.openKeyboard({ x: 10, y: 10, w: 100, h: 100 }, {})
  s.spatial.subscribe(frame => {
    if (frame.camera.frame && !moved) { moved = true; s.surfaces.move('keyboard', { dx: 20, dy: 0 }) }
    frame.surfaces[0]!.box.x = -999
  })
  s.spatial.subscribe(frame => {
    orders.push(frame.seq)
    expect(frame.surfaces[0]!.box.x).toBeGreaterThan(0)
  })
  s.spatial.observe(observation())
  expect(orders.length).toBeGreaterThanOrEqual(3)
  expect(orders.every((n, i) => !i || n > orders[i - 1]!)).toBe(true)
  expect(s.spatial.snapshot().surfaces[0]!.box.x).toBe(30)
})

it('does not replay an old publication to a listener installed during fan-out and still delivers nested shutdown', () => {
  // Contract probe: one feature may attach a diagnostic subscriber or stop the
  // service in response to input. Iterating a live Set visits newly installed
  // listeners twice; clearing it inside stop loses shutdown for later readers.
  const s = setup()
  const seen: ReturnType<typeof s.spatial.snapshot>[] = []
  let installed = false
  s.spatial.subscribe(frame => {
    if (frame.camera.frame && !installed) {
      installed = true
      s.spatial.subscribe(f => seen.push(f))
      s.spatial.stop()
    }
  })
  s.spatial.observe(observation())
  expect(seen).toHaveLength(2)
  expect(seen.map(f => f.state)).toEqual(['running', 'stopped'])
  expect(seen[1]!.seq).toBeGreaterThan(seen[0]!.seq)
})
