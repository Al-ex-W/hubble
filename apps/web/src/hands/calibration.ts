import { buildLayout, type Layout, WIDGET } from '@hubble/stage/swipe'
import { fromPoints, invert, type H } from './homography.ts'
import type { Pt } from './types.ts'

/**
 * Camera pixels → keyboard mm, the frame the gestures and the decoder work in.
 * Two ways to get it, one output:
 *
 * - **printout** (the bench): the user taps four printed key-cap corners in
 *   the camera image. Corners of caps, not of the board: the board's corners
 *   are empty paper, a cap's corner is a crisp printed point on every sheet.
 *   A print at any scale maps straight to keyboard mm (the decoder's frame);
 *   only speeds need the print's scale, which the gesture machine applies.
 * - **room** (on site): the room's saved camera → projector homography,
 *   composed with where the keyboard is projected (`at`, the widget's
 *   top-left in table mm, from the runtime's keyboard surface box; see
 *   swipe/tableKeyboard.ts keyboardAtMm). Built and tested (`fromRoom`), but
 *   not wired: HandPanel uses the printout path only. Kept on purpose for when
 *   the camera map is trusted on site; that map is the spatial service's
 *   (#59), so read it from there rather than re-deriving it here.
 */
export type { H }

/** The four key-cap corners the user taps, in this order, in keyboard mm. */
export function keyboardCorners(layout: Layout = buildLayout()): { name: string; mm: Pt }[] {
  const g = WIDGET.capGap
  const key = (id: string) => {
    const k = layout.keys.find((x) => x.id === id)
    if (!k) throw new Error(`layout has no ${id} key`)
    return k
  }
  const q = key('q')
  const p = key('p')
  const send = key('send')
  const space = key('space')
  return [
    { name: 'Q key, top-left corner', mm: { x: q.x + g, y: q.y + g } },
    { name: 'P key, top-right corner', mm: { x: p.x + p.w - g, y: p.y + g } },
    { name: 'SEND key, bottom-right corner', mm: { x: send.x + send.w - g, y: send.y + send.h - g } },
    { name: 'SPACE key, bottom-left corner', mm: { x: space.x + g, y: space.y + space.h - g } },
  ]
}

/** Image px of the 4 tapped corners (in keyboardCorners order) → camera px to keyboard mm. */
export function fromPrintout(taps: Pt[]): H {
  return fromPoints(taps, keyboardCorners().map((c) => c.mm))
}

/**
 * Keyboard mm → projector (table) px for a keyboard projected with its
 * widget's top-left at `at` (table mm from the lit area's top-left): the
 * placement of the runtime's keyboard surface, so a stroke and the drawing
 * agree. Note stage's tableFromKeyboardMm does the same job by scaling the
 * box; the two agree only while the box is the keyboard's physical size
 * (there is no resize op today). A resize must make this read the box too.
 */
export function keyboardToTable(at: { xMm: number; yMm: number }, mmPerPx: number): H {
  const k = 1 / mmPerPx
  return [k, 0, at.xMm * k, 0, k, (at.yMm + WIDGET.keysY) * k, 0, 0, 1]
}

const mul = (a: H, b: H): H => {
  const r = new Array(9).fill(0) as number[]
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j]! += a[i * 3 + k]! * b[k * 3 + j]!
  return r
}

/** Camera px → keyboard mm through the room's saved camera → projector map and the keyboard's placement. */
export function fromRoom(cameraToProjector: H, at: { xMm: number; yMm: number }, mmPerPx: number): H {
  return mul(invert(keyboardToTable(at, mmPerPx)), cameraToProjector)
}
