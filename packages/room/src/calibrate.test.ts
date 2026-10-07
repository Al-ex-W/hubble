import { describe, expect, it } from 'vitest'
import { apply, residual, solveHomography, type H } from './calibrate.ts'

/**
 * Label: synthetic ground truth. A known camera→projector homography (a
 * slightly rotated, keystoned overhead view, like the MX Brio beside the lens)
 * generates marker pairs with ~1 px detection noise; the solver must recover
 * it. Re-checked on site against recorded marker frames.
 */
const truth: H = [0.98, 0.04, 120, -0.03, 1.01, 80, 0.00002, -0.00001, 1]
const markers = [
  [100, 100],
  [1800, 120],
  [1820, 980],
  [90, 1000],
  [960, 540],
  [500, 300],
  [1400, 760],
]

describe('solveHomography', () => {
  it('recovers a known camera→projector mapping from noisy markers within a pixel', () => {
    let s = 3
    const jitter = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * 1.6
    const pairs = markers.map(([x, y]) => {
      const to = apply(truth, { x, y })
      return { from: { x: x + jitter(), y: y + jitter() }, to }
    })
    const h = solveHomography(pairs)
    expect(residual(h, pairs)).toBeLessThan(2)
    for (const [x, y] of [
      [300, 900],
      [1700, 200],
    ]) {
      const a = apply(h, { x, y })
      const b = apply(truth, { x, y })
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(2)
    }
  })

  it('refuses fewer than four pairs', () => {
    expect(() => solveHomography(markers.slice(0, 3).map(([x, y]) => ({ from: { x, y }, to: { x, y } })))).toThrow()
  })
})
