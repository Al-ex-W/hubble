import { describe, expect, it } from 'vitest'
import { TAKES, durationMs } from './takes.ts'

// Schema-derived checks of the take protocol itself; no lidar data involved.
describe('guided lidar takes', () => {
  // Break caught: a take that can't finish inside one hardware window would be
  // cut at :20 by the device pool, leaving an unlabelled half-take.
  it('every take fits comfortably in a window (≤ 2 min)', () => {
    for (const take of Object.values(TAKES)) expect(durationMs(take), take.id).toBeLessThanOrEqual(120_000)
  })

  // Break caught: the tap census and the tap test assume 3 taps on each of the
  // nine marks; a dropped mark would silently shrink the corpus.
  it('R4 asks for exactly three taps on each of the nine marks', () => {
    const taps = TAKES.R4.cues.filter((c) => c.action === 'tap')
    expect(taps).toHaveLength(27)
    for (let mark = 1; mark <= 9; mark++) expect(taps.filter((c) => c.mark === mark), `mark ${mark}`).toHaveLength(3)
  })

  // Break caught: cues out of order would make the recorder sleep negative
  // time and fire two prompts at once, so the person can't follow the rhythm.
  it('cues are strictly increasing in time, start with a clap and end with end', () => {
    for (const take of Object.values(TAKES)) {
      take.cues.forEach((c, i) => i && expect(c.atMs, `${take.id} #${i}`).toBeGreaterThan(take.cues[i - 1].atMs))
      expect(take.cues[0].action, take.id).toBe('clap')
      expect(take.cues.at(-1)!.action, take.id).toBe('end')
    }
  })
})
