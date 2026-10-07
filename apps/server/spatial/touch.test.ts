import { describe, expect, it } from 'vitest'
import type { LidarFrame } from '@hubble/room'
import { buildBaseline, foreground } from './baseline.ts'
import { clusters, createTracker, DEFAULT_TRACKER, type TouchEvent } from './touch.ts'
import { insideTable, sensorToTable, tableToSensor, wireFrames, withFinger, withObject } from './lidarFixtures.ts'
import type { Point } from './coordinates.ts'

/*
 * Clusters and tracks (#89). Fixture: the real wire take (recording) with
 * fingers put in by mechanical mutation (lidarFixtures.ts), under a
 * schema-derived pose (lidar 30 mm behind the middle of the back edge).
 * Oracles: the injected positions and the instructed sequence, never the
 * tracker's own helpers. PROVISIONAL corpus: replaced by the on-site guided
 * takes (R4 taps, R5 drag, R6 palm) when the room is ours again.
 */
const frames = wireFrames()
const base = buildBaseline(frames.slice(0, 30))
if (!base.ok) throw new Error(base.reason)
const later = frames.slice(30)

function run(rotations: LidarFrame[], opts = DEFAULT_TRACKER) {
  const tracker = createTracker(opts)
  const events: (TouchEvent & { rotation: number })[] = []
  rotations.forEach((f, rotation) => {
    const found = clusters(foreground(f.points, base.ok ? base.baseline : (null as never)), sensorToTable, insideTable)
    for (const e of tracker.update(f.sourceSession, found)) events.push({ ...e, rotation })
  })
  return events
}
const finger = (f: LidarFrame, table: Point) => withFinger(f, tableToSensor(table))

describe('lidar touch tracking', () => {
  // Break caught: anything in the static room (its objects, the mover at
  // 1.56 m, open bins toward the room) becoming a touch on the table.
  it('the static wire take gives no touch events at all', () => {
    expect(run(later)).toEqual([])
  })

  // Break caught: the ripple waiting for confirmation (Ruling 2), a tap
  // ending on the first dropped rotation, or a position far from the finger.
  it('a tap: candidate on its first rotation, down on the second, up after two misses', () => {
    const at = { x: 775, y: 400 }
    const rotations = later.slice(0, 7).map((f, i) => (i < 3 ? finger(f, at) : f))
    const events = run(rotations)
    expect(events.map((e) => `${e.rotation}:${e.type}`)).toEqual(['0:candidate', '1:down', '2:move', '4:up'])
    expect(new Set(events.map((e) => e.id)).size).toBe(1)
    for (const e of events) expect(Math.hypot(e.table.x - at.x, e.table.y - at.y)).toBeLessThan(15)
  })

  // Break caught: dropping the span filter, so a flat palm (80 mm across
  // the beam) or a forearm ripples like a finger.
  it('a palm-wide object is not a touch; a finger at the same spot is', () => {
    const at = tableToSensor({ x: 600, y: 500 })
    expect(run(later.slice(0, 4).map((f) => withObject(f, at, 80)))).toEqual([])
    expect(run(later.slice(0, 4).map((f) => withObject(f, at, 15))).length).toBeGreaterThan(0)
  })

  // Break caught: the old 70 mm gate. A swipe at 120 mm per rotation (a
  // brisk word on the keyboard) became a new touch every rotation.
  it('a swipe moving 120 mm per rotation stays one touch', () => {
    const rotations = later.slice(0, 7).map((f, i) => finger(f, { x: 400 + 120 * i, y: 500 }))
    const events = run(rotations)
    expect(new Set(events.map((e) => e.id)).size).toBe(1)
    expect(events.filter((e) => e.type === 'candidate')).toHaveLength(1)
  })

  // Break caught: matching around the last position instead of the
  // predicted one. A swipe that speeds up (100 then 200 mm per rotation, a
  // flick at the end of a word) leaves a fixed 150 mm gate on the third
  // rotation; the predicted position stays within it. (Mutant that survived
  // the 120 mm test above: no prediction.)
  it('an accelerating swipe stays one touch because the gate follows the prediction', () => {
    const xs = [300, 400, 600, 800, 1000]
    const events = run(later.slice(0, xs.length).map((f, i) => finger(f, { x: xs[i], y: 500 })))
    expect(new Set(events.map((e) => e.id)).size).toBe(1)
  })

  // Break caught: a one-rotation blip (noise, a hand passing through the
  // beam) ending as 'up'. Consumers read 'up' as "a touch completed", which
  // for the keyboard is a tap; a never-confirmed track must end as 'cancel'.
  it('a one-rotation blip ends as cancel, never up', () => {
    const rotations = later.slice(0, 4).map((f, i) => (i === 0 ? finger(f, { x: 900, y: 300 }) : f))
    expect(run(rotations).map((e) => `${e.rotation}:${e.type}`)).toEqual(['0:candidate', '2:cancel'])
  })

  // Break caught: lifting a held finger on one dropped rotation (far-edge
  // returns miss single rotations on the real C1).
  it('one missed rotation does not end a held touch', () => {
    const at = { x: 700, y: 600 }
    const rotations = later.slice(0, 6).map((f, i) => (i === 2 ? f : finger(f, at)))
    const events = run(rotations)
    expect(events.filter((e) => e.type === 'up' || e.type === 'cancel')).toEqual([])
    expect(new Set(events.map((e) => e.id)).size).toBe(1)
  })

  // Break caught: stitching a path across a socket reconnect (a reconnect may
  // be a moved lidar or a gap of seconds): it must cancel, never "up".
  it('a new socket session mid-hold cancels the touch, with no up', () => {
    const at = { x: 775, y: 400 }
    const first = later.slice(0, 3).map((f) => finger(f, at))
    const second = wireFrames('reconnected').slice(33, 36).map((f) => finger(f, at))
    const events = run([...first, ...second])
    expect(events.map((e) => e.type)).toEqual(['candidate', 'down', 'move', 'cancel', 'candidate', 'down', 'move'])
    expect(events.find((e) => e.type === 'cancel')!.id).toBe(events[0].id)
    expect(events.at(-1)!.id).not.toBe(events[0].id)
  })

  // Break caught: no seam join. Real rotations start near 358° (this take),
  // so a finger straight along 0° is split into two runs at opposite ends of
  // the sorted rotation: two touches for one finger.
  it('a finger on the 0°/360° seam is one cluster', () => {
    const f = withFinger(later[0], { x: 800, y: 0 })
    const onFinger = f.points.filter((p) => p.distance === 800)
    // Precondition (from the recording's real angles): returns on both sides.
    expect(onFinger.some((p) => p.angle > 350) && onFinger.some((p) => p.angle < 10)).toBe(true)
    const found = clusters(onFinger, (s) => s, () => true)
    expect(found).toHaveLength(1)
  })
})
