import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { locateTasks } from './locate.ts'

/**
 * Fixture: fixtures/photos/upgift.jpg, a real phone photo of a Ma3 test page
 * (label: recording), taken at an angle, so the number column drifts from
 * x≈155 at the top to x≈120 at the bottom. Expected rows were measured by
 * hand from the photo (800×1067 px): where each task's number and math sit.
 */
const photo = readFileSync(new URL('../fixtures/photos/upgift.jpg', import.meta.url))
const H = 1067
const MEASURED: [number, number][] = [
  [175, 215], // 1. Förenkla … (3x+24)/(2x+16)
  [255, 535], // 2. Kurvan y = e^2x … with the graph
  [580, 625], // 3. lim x→5
  [715, 765], // 4. |x| = 105
  [815, 855], // 5. x/(x+√5) + 5x/(x−√5)   (the 2/4/0 task)
  [955, 995], // 6. (x+1)/C − C/(x+1) = 4x/(x²−1)
]

describe('locateTasks on a real photographed worksheet', () => {
  it('finds every task where it is on the page', () => {
    const boxes = locateTasks(photo, 6)
    // Break caught: drawing the "which task?" ring on the wrong task, which is
    // what the model's own coordinates did (170 px off between two runs).
    expect(boxes).not.toBeNull()
    boxes!.forEach((b, i) => {
      const [top, bottom] = MEASURED[i]
      expect(b.y * H).toBeLessThanOrEqual(top)
      expect((b.y + b.h) * H).toBeGreaterThanOrEqual(bottom)
      // …and does not reach into the next task.
      if (i < 5) expect((b.y + b.h) * H).toBeLessThan(MEASURED[i + 1][0])
    })
  })

  it('refuses a split it cannot support instead of guessing', () => {
    expect(locateTasks(photo, 9)).toBeNull()
  })
})
