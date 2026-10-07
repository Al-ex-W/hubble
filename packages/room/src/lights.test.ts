import { describe, expect, it } from 'vitest'
import { createLightPlayer } from './lights.ts'

/** Label: schema-derived (the Hue bridge's documented limits), no hardware involved. */
describe('createLightPlayer', () => {
  it('never exceeds the Hue limits while a mood changes every frame', async () => {
    let t = 0
    const sent: { kind: 'light' | 'scene'; t: number; id?: string }[] = []
    const p = createLightPlayer(
      { light: async (id) => void sent.push({ kind: 'light', t, id }), scene: async () => void sent.push({ kind: 'scene', t }) },
      { now: () => t },
    )
    const ids = ['spot-1', 'spot-2', 'spot-3', 'strip-tv-1', 'strip-tv-2']
    for (t = 0; t < 10_000; t += 25) {
      // A runtime that flips mood every frame: the worst case.
      ids.forEach((id, i) => p.set(id, { bri: (t / 25 + i) % 254 }))
      if (t % 100 === 0) p.setScene(`s${t}`)
      await p.tick()
    }
    for (let w = 0; w < 10_000; w += 1000) {
      const inWindow = sent.filter((s) => s.t >= w && s.t < w + 1000)
      // Break caught: a 429 storm from the bridge mid-demo.
      expect(inWindow.filter((s) => s.kind === 'light').length).toBeLessThanOrEqual(10)
      expect(inWindow.filter((s) => s.kind === 'scene').length).toBeLessThanOrEqual(1)
    }
    // Coalescing: every light still gets updated, not starved.
    expect(new Set(sent.filter((s) => s.kind === 'light').map((s) => s.id)).size).toBe(ids.length)
  })
})
