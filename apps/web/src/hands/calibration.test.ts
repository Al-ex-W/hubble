import { describe, expect, it } from 'vitest'
import { buildLayout } from '@hubble/stage/swipe'
import { fromPrintout, fromRoom, keyboardCorners, keyboardToTable } from './calibration.ts'
import { apply, invert, type H } from './homography.ts'

/** Label: schema-derived (the product layout's own keys, a synthetic camera homography). */
describe('calibration', () => {
  it('the four tapped corners are the printed caps of Q, P, SEND and SPACE, 3 mm inside their cells', () => {
    // Break caught: corners taken from the cells (or a different key), which
    // shifts every stroke by the cap inset or more.
    const l = buildLayout()
    const c = keyboardCorners(l).map((x) => x.mm)
    expect(c).toEqual([
      { x: 3, y: 3 },
      { x: l.width - 3, y: 3 },
      { x: l.width - 3, y: l.height - 3 },
      { x: 66 + 3, y: l.height - 3 },
    ])
  })

  it('a printout calibration maps each tap exactly onto its corner', () => {
    const taps = [{ x: 483.3, y: 496.9 }, { x: 1342.9, y: 502.4 }, { x: 1345.4, y: 829.6 }, { x: 618.3, y: 839.5 }]
    const h = fromPrintout(taps)
    keyboardCorners().forEach((c, i) => {
      const p = apply(h, taps[i]!)
      expect(Math.abs(p.x - c.mm.x)).toBeLessThan(1e-6)
      expect(Math.abs(p.y - c.mm.y)).toBeLessThan(1e-6)
    })
  })

  it('the room path lands a camera point on the keyboard where the projector drew it', () => {
    // Break caught: composing the maps in the wrong order, or ignoring where
    // the keyboard is projected, so the room camera types beside the keys.
    const projToCam: H = [0.4, 0.02, 120, -0.015, 0.41, 60, 0.00001, 0.000002, 1]
    const camToProj = invert(projToCam)
    const at = { xMm: 520, yMm: 380 }
    const mmPerPx = 1500 / 1920
    const kbPoint = { x: 200, y: 90 } // a point on the keys, keyboard mm
    const projected = apply(keyboardToTable(at, mmPerPx), kbPoint) // where the projector drew it
    const seen = apply(projToCam, projected) // where the room camera sees it
    const back = apply(fromRoom(camToProj, at, mmPerPx), seen)
    expect(Math.abs(back.x - kbPoint.x)).toBeLessThan(1e-6)
    expect(Math.abs(back.y - kbPoint.y)).toBeLessThan(1e-6)
  })
})
