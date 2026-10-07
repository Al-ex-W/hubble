import { describe, expect, it } from 'vitest'
import { createStageParser } from '@hubble/stage'
import { listRecordings, loadRecording } from '@hubble/stage/testing'
import { axisTicks } from './Plot.tsx'

/** Every Plot x range the model has really written (label: recording). */
const recordedRanges = listRecordings().flatMap((name) => {
  const p = createStageParser()
  return [...p.push(loadRecording(name).text), ...p.end()]
    .filter((e) => e.type === 'piece' && e.tag === 'Plot')
    .map((e) => (e.type === 'piece' ? [Number(e.attrs.xmin ?? -5), Number(e.attrs.xmax ?? 5)] : []) as [number, number])
})

describe('axisTicks', () => {
  it('ticks every recorded plot range at round values, ends included', () => {
    expect(recordedRanges.length).toBeGreaterThan(0)
    for (const [lo, hi] of recordedRanges) {
      const t = axisTicks(lo, hi)
      expect(t.length).toBeGreaterThanOrEqual(2)
      expect(t.length).toBeLessThanOrEqual(21)
      expect(t[0]).toBeGreaterThanOrEqual(lo - 1e-9)
      expect(t.at(-1)!).toBeLessThanOrEqual(hi + 1e-9)
    }
    // scene-quadratic-graph: xmin={-1} xmax={6}
    expect(axisTicks(-1, 6)).toEqual([-1, 0, 1, 2, 3, 4, 5, 6])
  })

  it('stays bounded on a tiny range the model is allowed to write', () => {
    // Break caught (#17): `v <= xmax + 1e-9; v += step` with a step near
    // 1e-13 is thousands of ticks, and at xmax=1e-20 it is ~5×10¹¹ loop
    // iterations, which froze Chromium. xmin/xmax pass the catalog (±1000).
    expect(axisTicks(0, 1e-12).length).toBeLessThanOrEqual(21)
    expect(axisTicks(0, 1e-20).length).toBeLessThanOrEqual(21)
    expect(axisTicks(1000, 1000 + 1e-12).length).toBeLessThanOrEqual(21)
  })

  it('returns nothing for an empty or inverted range instead of looping', () => {
    expect(axisTicks(3, 3)).toEqual([])
    expect(axisTicks(5, -5)).toEqual([])
  })
})
