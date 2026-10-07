import type { Pt } from './types.ts'

export interface Features {
  t: number
  present: boolean
  /** Pen point in keyboard mm. */
  pen: Pt | null
  /** Thumb–index tip distance over palm length (wrist → middle knuckle): scale-free, so near and far hands read the same. */
  pinch: number | null
  openPalm: boolean
  /** Palm centre in keyboard mm, for the wake hold. */
  palm: Pt | null
  hands: number
}

/** Ratios remain in raw image coordinates. Mapping before measuring would let
 * perspective warp change the recorded pinch threshold at each table position. */
export function pinchRatioOf(index: Pt, thumb: Pt, wrist: Pt, middle: Pt): number {
  return Math.hypot(thumb.x - index.x, thumb.y - index.y) / Math.max(1e-6, Math.hypot(wrist.x - middle.x, wrist.y - middle.y))
}
