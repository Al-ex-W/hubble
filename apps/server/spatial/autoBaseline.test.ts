import { describe, expect, it } from 'vitest'
import type { LidarFrame } from '@hubble/room'
import { createAutoBaseline } from './autoBaseline.ts'

// Synthetic: a ring of returns at 1000 mm, one per degree; `bump` moves a
// sector closer (an object or hand moving). Real takes can't drive the timing.
const frame = (bump = 0): LidarFrame => ({
  sourceSession: 's', seq: 0, sourceTimeMs: 0, receivedAtMonoMs: 0, acquisitionAgeMs: null,
  points: Array.from({ length: 360 }, (_, a) => ({ angle: a, distance: a < 30 ? 1000 - bump : 1000, quality: 40 })),
})

describe('automatic lidar baseline', () => {
  // Catches: no first take, or one taken before 5 s of receiving.
  it('takes the first baseline 5 s after receiving starts', () => {
    const a = createAutoBaseline()
    a.frame(frame(), 0, false)
    expect(a.shouldTake(4900, false, false)).toBe(false)
    expect(a.shouldTake(5000, false, false)).toBe(true)
  })
  // Catches: a take with a finger down (that spot would go blind).
  it('never takes while a touch is down', () => {
    const a = createAutoBaseline()
    a.frame(frame(), 0, true)
    expect(a.shouldTake(6000, false, true)).toBe(false)
  })
  // Catches: re-takes while things move, or never re-taking once still.
  it('re-takes after 20 s still, and movement restarts the clock', () => {
    const a = createAutoBaseline()
    a.frame(frame(), 0, false)
    a.took(5000)
    for (let t = 5100; t <= 15_000; t += 100) a.frame(frame(), t, false)
    a.frame(frame(200), 15_100, false) // the MiniLab moves
    for (let t = 15_200; t <= 35_000; t += 100) a.frame(frame(200), t, false)
    expect(a.shouldTake(35_000, true, false)).toBe(false) // still only since 15.2 s
    for (let t = 35_100; t <= 35_300; t += 100) a.frame(frame(200), t, false)
    expect(a.shouldTake(35_300, true, false)).toBe(true)
  })
})
