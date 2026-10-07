import { pinchRatioOf, type Features } from '../../../shared/hands/features.ts'
export type { Features } from '../../../shared/hands/features.ts'
import { apply, type H } from './homography.ts'
import type { Frame, Hand } from './types.ts'

/**
 * One frame of MediaPipe output reduced to what the gestures need, in
 * keyboard mm. Ported from experiments/hands/src/features.ts (#28).
 *
 * The pen point is the midpoint of the thumb and index tips, which is where
 * the pinch actually is. The index tip alone moves by ~1 cm as the pinch
 * closes, and that jump would land at the start of every stroke.
 *
 * Pinch only: the lab's dwell mode (index tip held still) was measured as a
 * dead end, a resting hand is a dwelling hand (33 false pen-downs in 20 s
 * idle), so it is not carried into the product.
 */


const dist = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1])

export function pinchRatio(h: Hand): number {
  const pt = (i: number) => ({ x: h.lm[i]![0], y: h.lm[i]![1] })
  return pinchRatioOf(pt(8), pt(4), pt(0), pt(9))
}

/**
 * All four fingers straight and the thumb away from the index. "Straight"
 * means the tip is clearly further from the wrist than the middle joint:
 * a curled finger folds its tip back towards the palm.
 */
export function isOpenPalm(h: Hand): boolean {
  const w = h.lm[0]!
  for (const [pip, tip] of [
    [6, 8],
    [10, 12],
    [14, 16],
    [18, 20],
  ] as const) {
    if (dist(w, h.lm[tip]!) < 1.15 * dist(w, h.lm[pip]!)) return false
  }
  return pinchRatio(h) > 0.6
}

/**
 * With two hands in view, the one acting is the one pinching: an idle second
 * hand resting nearby must not steal the pen mid-word.
 */
function primary(hands: Hand[]): Hand | null {
  if (hands.length === 0) return null
  return hands.reduce((best, h) => (pinchRatio(h) < pinchRatio(best) ? h : best))
}

export function features(frame: Frame, cam: H): Features {
  const h = primary(frame.hands)
  if (!h) return { t: frame.t, present: false, pen: null, pinch: null, openPalm: false, palm: null, hands: 0 }
  const toMm = (p: [number, number]) => apply(cam, { x: p[0], y: p[1] })
  const thumb = h.lm[4]!
  const index = h.lm[8]!
  const pen = toMm([(thumb[0] + index[0]) / 2, (thumb[1] + index[1]) / 2])
  // The palm of the open hand when there is one: the wake is that hand's
  // (it carries this position to the launcher, #33), and the primary hand
  // is the pinching one, which with two hands in view is the other hand
  // (review #48). Its speed is then the open hand's, which is what "held
  // still" means.
  const palmHand = frame.hands.find(isOpenPalm) ?? h
  const palmPx = [0, 5, 9, 13, 17].map((i) => palmHand.lm[i]!)
  const palm = toMm([palmPx.reduce((s, p) => s + p[0], 0) / 5, palmPx.reduce((s, p) => s + p[1], 0) / 5])
  return {
    t: frame.t,
    present: true,
    pen,
    pinch: pinchRatio(h),
    openPalm: frame.hands.some(isOpenPalm),
    palm,
    hands: frame.hands.length,
  }
}
