import { cropPixels, type Rect, type Roi } from '../../shared/hands/roi.ts'
import type { Point } from './coordinates.ts'

/**
 * Which part of the room camera to stream so the hand tracker sees the
 * keyboard and the hands over it, and little else (#84). Pure: the spatial
 * service hands it the keyboard's projector box, its own inverse camera map
 * and the calibrated frame, so the decision has one owner and no I/O.
 *
 * Margin: 15 % of the keyboard's camera-space box on every side. MediaPipe
 * finds a hand from the whole hand (wrist and palm included), and a finger
 * pinching over the top row puts the wrist well beyond the keys. 15 % is
 * about a key row and a half at the keyboard's size, covering the hand of
 * someone reaching in from the near edge. A larger margin costs a few fps;
 * a smaller one loses the hand at the edges, which is the worse failure.
 *
 * Fractions are rounded OUTWARD to 4 decimals (origin down, far edge up),
 * so the request is short and never smaller than the box. The browser maps
 * landmarks with cropPixels() of these exact fractions, which is the
 * rectangle the Pi crops, so the rounding can't make them disagree.
 */
export const ROI_MARGIN = 0.15

export interface CameraRoi {
  roi: Roi
  /** The rectangle the Pi will actually send, in full-frame px. */
  crop: Rect
  frame: { width: number; height: number; geometry: string }
}

const down = (v: number) => Math.floor(v * 1e4) / 1e4
const up = (v: number) => Math.ceil(v * 1e4) / 1e4
const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

export function keyboardRoi(
  box: { x: number; y: number; w: number; h: number } | null,
  projectorToCamera: (p: Point) => Point | null,
  frame: { width: number; height: number; geometry: string } | null,
  margin = ROI_MARGIN,
): CameraRoi | null {
  if (!box || !frame) return null
  // A homography maps a rectangle to a general quadrilateral (the camera is
  // tilted and rotated 180°), so map all four corners and bound them.
  const corners = [
    { x: box.x, y: box.y },
    { x: box.x + box.w, y: box.y },
    { x: box.x + box.w, y: box.y + box.h },
    { x: box.x, y: box.y + box.h },
  ].map(projectorToCamera)
  if (corners.some((c) => !c)) return null
  const xs = corners.map((c) => c!.x)
  const ys = corners.map((c) => c!.y)
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const mx = (x1 - x0) * margin
  const my = (y1 - y0) * margin
  const left = clamp01(down((x0 - mx) / frame.width))
  const top = clamp01(down((y0 - my) / frame.height))
  const right = clamp01(up((x1 + mx) / frame.width))
  const bottom = clamp01(up((y1 + my) / frame.height))
  // Off-frame keyboard (or a degenerate map): nothing to crop to. Full
  // frame is the safe answer, never an empty or inverted request.
  if (right <= left || bottom <= top) return null
  const roi = { x: left, y: top, w: up(right - left), h: up(bottom - top) }
  // w/h rounding may push x+w past 1 by 1e-4; the Pi clamps that, and each
  // value alone stays within 0..1, which is all it checks.
  roi.w = Math.min(1, roi.w)
  roi.h = Math.min(1, roi.h)
  try {
    return { roi, crop: cropPixels(roi, frame.width, frame.height), frame }
  } catch {
    return null
  }
}
