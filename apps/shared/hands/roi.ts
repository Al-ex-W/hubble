/**
 * The room camera's crop (#84): the one owner of "which pixels does
 * `?roi=x,y,w,h` give us, and where are they in the full frame".
 *
 * Why it exists: the Pi's MJPEG over the room Wi-Fi gives about 7 fps for
 * the full 1080p frame and about 45 fps cropped to the keyboard (H28, 7 Oct).
 * Pinch typing needs the second. But the spatial service accepts only
 * full-frame observations (1920x1080, `room:full-frame`): that is the frame
 * the calibration was measured on. So the browser asks for a crop, and maps
 * every landmark back to full-frame pixels before it leaves.
 *
 * The crop rectangle is not the requested one. The Pi crops losslessly on
 * JPEG blocks and snaps the requested fractions OUTWARD to a 16 px grid
 * (third_party/aid-hackathon-room/display/camera.py `LosslessCrop.pixels`,
 * pinned at 995f275). Mapping with the requested rectangle instead would put
 * every landmark up to 15 px off, which is a key's width at the far end of
 * the keyboard. So `cropPixels` mirrors that rule exactly, Python
 * truncation and ceiling division included, and both the server (building
 * the request) and the browser (mapping back) use it.
 *
 * Lossless means a crop pixel IS a full-frame pixel shifted by the crop
 * origin, at the same scale, so mapping back is an offset, never a scale.
 */

/** A crop request, as fractions 0..1 of the frame (the Pi's `?roi=`). */
export interface Roi {
  x: number
  y: number
  w: number
  h: number
}

/** Pixels in the full frame. */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** The Pi's JPEG block size (camera.py `LosslessCrop.BLOCK`). */
export const BLOCK = 16

// Python's int() on a non-negative float truncates; a // b on ints floors;
// -(-a // b) is ceiling division. Written out so the parity with camera.py
// is visible line by line.
const pyInt = (v: number) => Math.trunc(v)
const floorDiv = (a: number, b: number) => Math.floor(a / b)
const ceilDiv = (a: number, b: number) => -Math.floor(-a / b)

/**
 * The pixel rectangle the Pi actually crops for `roi` in a frame of
 * `width` x `height`. Throws on an empty crop, as the Pi answers an error.
 */
export function cropPixels(roi: Roi, width: number, height: number): Rect {
  for (const v of [roi.x, roi.y, roi.w, roi.h]) if (!(v >= 0 && v <= 1)) throw new Error('roi values must be fractions 0..1')
  const x0 = Math.max(0, floorDiv(Math.min(width, pyInt(roi.x * width)), BLOCK) * BLOCK)
  const y0 = Math.max(0, floorDiv(Math.min(height, pyInt(roi.y * height)), BLOCK) * BLOCK)
  const x1 = Math.min(width, ceilDiv(pyInt((roi.x + roi.w) * width), BLOCK) * BLOCK)
  const y1 = Math.min(height, ceilDiv(pyInt((roi.y + roi.h) * height), BLOCK) * BLOCK)
  if (x1 <= x0 || y1 <= y0) throw new Error('roi is empty')
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** The query value the Pi parses: exactly the fractions `cropPixels` was given. */
export function roiParam(roi: Roi): string {
  return [roi.x, roi.y, roi.w, roi.h].join(',')
}

/** A point in the cropped image (its pixels) to the full frame's pixels. */
export function toFullFrame(p: { x: number; y: number }, crop: Rect): { x: number; y: number } {
  return { x: p.x + crop.x, y: p.y + crop.y }
}
