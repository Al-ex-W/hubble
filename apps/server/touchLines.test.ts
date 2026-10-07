import { expect, it } from 'vitest'
import { touchLineFor } from './touchLines.ts'
import type { SpatialTouchEvent } from './spatial/service.ts'

// Schema-derived tracker events (the shapes touch.ts emits); oracle: the
// plan's Ruling 2 (ripple on the first sighting, once per touch).
const ev = (type: SpatialTouchEvent['type'], projector: { x: number; y: number } | null = { x: 10, y: 20 }): SpatialTouchEvent =>
  ({ type, id: 7, table: { x: 1, y: 2 }, spanMm: 12, projector, sourceSession: 's' })

// Break caught: waiting for confirmation (ripple ~100 ms late), or a second
// ripple when the touch confirms.
it('one display down per touch, on its first sighting', () => {
  const lines = (['candidate', 'down', 'move', 'up'] as const).map((t) => touchLineFor(ev(t)))
  expect(lines.map((l) => l?.phase ?? null)).toEqual(['down', null, 'move', 'up'])
  expect(lines[0]).toEqual({ kind: 'touch', id: 7, phase: 'down', p: { x: 10, y: 20 } })
})

// Break caught: a ripple at the page's corner when the map is missing.
it('nothing without a projector position', () => {
  expect(touchLineFor(ev('candidate', null))).toBeNull()
})
