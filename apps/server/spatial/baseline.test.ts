import { describe, expect, it } from 'vitest'
import type { LidarFrame } from '@hubble/room'
import { buildBaseline, foreground } from './baseline.ts'
import { wireFrames, withFinger } from './lidarFixtures.ts'

/*
 * The empty-table baseline (#89). Fixture: H41's real wire take (recording;
 * unannotated room, see lidarFixtures.ts) and mechanical mutations of it.
 *
 * Census of that take (2026-10-07, this branch): every return closer than
 * 1.5 m belongs to two static objects, at 57–59° and 285–297°, 4–9 returns in
 * every rotation. Something moves at ~1.56 m around 14–23°. So "no foreground
 * under 1.5 m" is an oracle that comes from the recording, not from the code.
 */
const frames = wireFrames()
const learn = frames.slice(0, 30)
const later = frames.slice(30)

describe('lidar baseline', () => {
  // Break caught: a shrinking or swapped corpus passing silently.
  it('the wire corpus is the recorded one', () => {
    expect(frames).toHaveLength(116)
    expect(frames.reduce((n, f) => n + f.points.length, 0)).toBe(59044)
  })

  // Break caught: a baseline from 1–2 rotations, where one person walking
  // past behind the table moves a bin's median; or one stitched across a
  // reconnect, which may be a moved lidar.
  it('refuses too few rotations, or rotations from two socket sessions', () => {
    expect(buildBaseline(learn.slice(0, 29)).ok).toBe(false)
    const mixed = [...learn.slice(0, 15), ...wireFrames('other').slice(15, 30)]
    expect(buildBaseline(mixed)).toMatchObject({ ok: false, reason: expect.stringMatching(/reconnected/) })
  })

  // Break caught: comparing a return only with its own bin. The real angles
  // jitter 0.54–0.86° around the 0.72° bins, so at a static object's edge a
  // return lands in the far neighbour's bin and looks metres closer: 46 such
  // phantoms in this take without the neighbour check. Also catches a zero
  // margin (static noise leaks through).
  it('a static room gives no foreground under 1.5 m over 86 later rotations', () => {
    const b = buildBaseline(learn)
    if (!b.ok) throw new Error(b.reason)
    const near = later.flatMap((f) => foreground(f.points, b.baseline)).filter((p) => p.distance < 1500)
    expect(near).toEqual([])
  })

  // Break caught: a margin so wide (or a coverage rule so strict) that a real
  // fingertip in front of the static object is hidden. Mutation: a finger
  // 120 mm in front of the static object at ~58° (oracle: injected geometry).
  it('a finger in front of a static object is foreground', () => {
    const b = buildBaseline(learn)
    if (!b.ok) throw new Error(b.reason)
    const a = (58 * Math.PI) / 180
    const at = { x: 1070 * Math.cos(a), y: 1070 * Math.sin(a) }
    const fg = foreground(withFinger(later[0], at).points, b.baseline).filter((p) => p.distance < 1500)
    expect(fg.length).toBeGreaterThanOrEqual(1)
    for (const p of fg) expect(Math.abs(p.distance - 1070)).toBeLessThan(2)
  })

  // Break caught: treating open bins (the empty beam saw nothing) as "always
  // background", which would make the table blind wherever the beam faces
  // the open room. A finger there is new; the table polygon, not the
  // baseline, decides whether it is on the table.
  it('a finger in an open bin is foreground', () => {
    const b = buildBaseline(learn)
    if (!b.ok) throw new Error(b.reason)
    const open = b.baseline.bins.findIndex((x, i) => x.coverage === 0 && i > 300 && i < 400)
    expect(open).toBeGreaterThan(0)
    const a = ((open + 0.5) * 0.72 * Math.PI) / 180
    const fg = foreground(withFinger(later[0], { x: 600 * Math.cos(a), y: 600 * Math.sin(a) }).points, b.baseline)
    expect(fg.some((p) => Math.abs(p.distance - 600) < 2)).toBe(true)
  })

  it('survives the degenerate captures that arrive from the wire', () => {
    // Break caught: a NaN angle in one rotation threw out of buildBaseline or
    // foreground (per[NaN]/bins[NaN] undefined), and Express 4 does not catch
    // the async rejection, so the /api/spatial/baseline request hung forever.
    // Also: a zero-frame capture (minRotations 0) threw on frames[0].
    // Oracle: these calls return, and the corrupt return never becomes a touch.
    expect(buildBaseline([])).toMatchObject({ ok: false })
    expect(buildBaseline([], 0)).toMatchObject({ ok: false })

    const emptyDistances: LidarFrame[] = Array.from({ length: 30 }, (_, i) => ({
      sourceSession: 'wire',
      seq: i,
      sourceTimeMs: i,
      receivedAtMonoMs: i * 100,
      acquisitionAgeMs: null,
      points: [{ angle: 12, distance: 0, quality: 0 }],
    }))
    const zero = buildBaseline(emptyDistances)
    expect(zero.ok).toBe(true)
    if (zero.ok) expect(zero.baseline.bins.every((x) => x.coverage === 0 && x.medianMm === 0)).toBe(true)

    const withNaN = structuredClone(learn)
    withNaN[0]!.points = [...withNaN[0]!.points, { angle: NaN, distance: 800, quality: 10 }]
    const b = buildBaseline(withNaN)
    expect(b.ok).toBe(true)
    if (b.ok) {
      const fg = foreground([{ angle: NaN, distance: 400, quality: 10 }, { angle: 58, distance: 400, quality: 10 }], b.baseline)
      expect(fg.every((p) => Number.isFinite(p.angle))).toBe(true)
      expect(fg.some((p) => Number.isNaN(p.angle))).toBe(false)
    }
  })
})

