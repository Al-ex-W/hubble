import { describe, expect, it } from 'vitest'
import type { SurfacesLine, TableSurface } from '@hubble/stage'
import { answerSurfaceFor, applySurfacesLine, ownsPress } from './surfaces.ts'

/** Label: schema-derived (SurfacesLine / TableSurface values written to the type). */
const line = (rev: number, ids: string[]): SurfacesLine => ({ kind: 'surfaces', rev, surfaces: ids.map((id) => ({ id }) as TableSurface) })
const answer = (renderId: string, offset = { x: 5, y: 6 }): TableSurface => ({ id: 'answer', kind: 'answer', box: { x: 0, y: 0, w: 10, h: 10 }, z: 1, focused: true, instance: 0, pinned: false, state: { renderId, offset } })

describe('applySurfacesLine', () => {
  it('drops a line older than the one already shown', () => {
    // Break caught: a reconnect replay arriving after a live update rolls the table back.
    const shown = applySurfacesLine(line(4, ['a']), line(5, ['a', 'b']))
    expect(applySurfacesLine(shown, line(4, ['a'])).rev).toBe(5)
  })
  it('accepts anything on a fresh connection (a restarted server counts from 1)', () => {
    expect(applySurfacesLine(null, line(1, ['x'])).rev).toBe(1)
  })
})

describe('answerSurfaceFor', () => {
  it('applies the move only to the render it was made on', () => {
    expect(answerSurfaceFor([answer('r1')], 'r1', true).offset).toEqual({ x: 5, y: 6 })
    // Break caught: the bench showing an older run drawn shifted by the new answer's move.
    expect(answerSurfaceFor([answer('r1')], 'r0', true).offset).toBeUndefined()
  })
  it('still draws an answer before any surface set has arrived', () => {
    // Break caught: the math act going blank because a surfaces line was late or missing.
    const { set } = answerSurfaceFor(null, 'r1', true)
    expect(set.map((s) => s.kind)).toEqual(['answer'])
    expect(answerSurfaceFor(null, undefined, false).set).toEqual([])
  })
  it('draws no answer once a received set says it was closed', () => {
    // Review #38 finding 1: the fallback invented an answer after an
    // authoritative close, so the displays kept drawing it.
    expect(answerSurfaceFor([], 'r1', true).set).toEqual([])
  })
})

describe('ownsPress (#33)', () => {
  // Label: schema-derived. Oracle: plain rectangle maths.
  const s = (kind: TableSurface['kind']): TableSurface => ({ id: kind, kind, box: { x: 100, y: 100, w: 50, h: 40 }, z: 1, focused: false, instance: 0, pinned: false, state: {} })
  it('a launcher owns presses inside its box, edges included; other kinds do not, yet', () => {
    // Break caught: a press on an answer or asset taken from the keyboard
    // (only the launcher reads hand presses so far), or one on the launcher's
    // edge typing a key.
    expect(ownsPress([s('launcher')], { x: 100, y: 140 })).toBe(true)
    expect(ownsPress([s('launcher')], { x: 151, y: 120 })).toBe(false)
    expect(ownsPress([s('answer'), s('asset')], { x: 120, y: 120 })).toBe(false)
    expect(ownsPress(null, { x: 120, y: 120 })).toBe(false)
  })
})
