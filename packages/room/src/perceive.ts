import { apply, residual, solveHomography, type H, type Pair } from './calibrate.ts'
import { brightBlobs, decode, rectCorners, type Blob } from './camera.ts'
import type { Keybed } from './devices/minilab3.ts'

/**
 * Turning camera frames into facts the runtime can use: the calibration
 * (camera px → projector px) and the objects on the table, in projector px.
 *
 * Classification is by real proportions and size only, because that is
 * all the demo needs: an A4 page (1:1.41) is the notebook, the MiniLab 3's
 * body (≈ 1:1.61) is the keyboard. Sizes are compared in mm via the surface
 * scale, so a different projector resolution doesn't change the verdicts.
 *
 * UNVERIFIED on our unit: the MiniLab 3's outer size (assumed 355 × 220 mm)
 * and where its keybed sits inside the body (assumed: the near 45 % of its
 * depth, 2–98 % of its width). Measured with a ruler on site; only MINILAB_BODY
 * changes.
 */
export const MINILAB_BODY = { w: 355, h: 220, keybed: { u0: 0.02, u1: 0.98, v0: 0.5, v1: 0.96 } } as const

/** Projected calibration dots: corners and edge midpoints of the lit area, inset. */
export function calibrationDots(width: number, height: number, inset = 0.12): { x: number; y: number }[] {
  const xs = [inset, 0.5, 1 - inset].map((f) => f * width)
  const ys = [inset, 0.5, 1 - inset].map((f) => f * height)
  return ys.flatMap((y) => xs.map((x) => ({ x, y })))
}

/**
 * Pairs camera blobs with the projected dots. The camera looks almost straight
 * down from beside the lens (spec), so the dots keep their grid order: sorting
 * both into rows by y, then by x within a row, matches them without any prior
 * calibration.
 */
export function matchDots(blobs: Blob[], dots: { x: number; y: number }[], cols = 3): Pair[] | null {
  if (blobs.length < dots.length) return null
  const pick = [...blobs].sort((a, b) => b.area - a.area).slice(0, dots.length)
  const rowsOf = <T,>(items: T[], y: (t: T) => number, x: (t: T) => number) => {
    const s = [...items].sort((a, b) => y(a) - y(b))
    const out: T[] = []
    for (let i = 0; i < s.length; i += cols) out.push(...s.slice(i, i + cols).sort((a, b) => x(a) - x(b)))
    return out
  }
  const cam = rowsOf(pick, (b) => b.cy, (b) => b.cx)
  const proj = rowsOf(dots, (p) => p.y, (p) => p.x)
  return cam.map((b, i) => ({ from: { x: b.cx, y: b.cy }, to: proj[i] }))
}

export function calibrateFromFrame(jpegBytes: Uint8Array, dots: { x: number; y: number }[]): { h: H; rms: number } | null {
  const blobs = brightBlobs(decode(jpegBytes)).filter((b) => b.halfShort > 0.5 && b.halfLong / Math.max(b.halfShort, 0.5) < 2.5)
  const pairs = matchDots(blobs, dots)
  if (!pairs) return null
  const h = solveHomography(pairs)
  return { h, rms: residual(h, pairs) }
}

export interface SeenObject {
  kind: 'notebook' | 'keyboard'
  /** Corners in projector px. */
  corners: { x: number; y: number }[]
  box: { x: number; y: number; w: number; h: number }
  keybed?: Keybed
}

export function observe(jpegBytes: Uint8Array, cameraToProjector: H, mmPerPx: number, lowestNote = 48): SeenObject[] {
  const out: SeenObject[] = []
  for (const b of brightBlobs(decode(jpegBytes), { minArea: 400 })) {
    const corners = rectCorners(b).map((p) => apply(cameraToProjector, p))
    const side = (i: number, j: number) => Math.hypot(corners[i].x - corners[j].x, corners[i].y - corners[j].y) * mmPerPx
    const long = Math.max(side(0, 1), side(1, 2))
    const short = Math.min(side(0, 1), side(1, 2))
    const xs = corners.map((c) => c.x)
    const ys = corners.map((c) => c.y)
    const box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
    const near = (v: number, want: number) => Math.abs(v - want) / want < 0.18
    if (near(long, 297) && near(short, 210)) out.push({ kind: 'notebook', corners, box })
    else if (near(long, MINILAB_BODY.w) && near(short, MINILAB_BODY.h)) {
      // Orient: the keybed is the long edge nearest the player (largest y on the table).
      const ordered = [...corners].sort((a, c) => c.y - a.y)
      const [n1, n2] = ordered.slice(0, 2).sort((a, c) => a.x - c.x)
      const [f1, f2] = ordered.slice(2).sort((a, c) => a.x - c.x)
      const k = MINILAB_BODY.keybed
      const lerp = (p: { x: number; y: number }, q: { x: number; y: number }, t: number) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t })
      const across = (v: number) => [lerp(lerp(n1, f1, 1 - v), lerp(n2, f2, 1 - v), k.u0), lerp(lerp(n1, f1, 1 - v), lerp(n2, f2, 1 - v), k.u1)]
      const [nl, nr] = across(k.v1)
      const [fl, fr] = across(k.v0)
      out.push({ kind: 'keyboard', corners, box, keybed: { corners: [nl, nr, fr, fl], lowestNote } })
    }
  }
  return out
}
