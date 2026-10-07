import type { OverlayShape } from '@hubble/stage'
import { decode, residual, solveHomography, type Gray, type H, type Pair } from '@hubble/room'
import { validTransform } from './spatial/coordinates.ts'

/**
 * Camera → projector calibration, rebuilt on site (7 Oct) because the
 * projected keyboard and the lit piano keys both stand on it: a fingertip
 * in camera px means nothing on the table without this map.
 *
 * What the old one (perceive.ts calibrateFromFrame) assumed, and the room
 * broke:
 * - All 9 dots lit at once, paired by sorting both sets into rows and
 *   columns. That needs the camera to keep the grid's orientation. The real
 *   camera sees the table rotated 180° (the organisers' test chart: projector
 *   (0,0) is the camera's bottom-right), so every dot paired with its mirror:
 *   a consistent, confident, wrong map.
 * - Dots found as "bright blobs" above the mean. The real table is white
 *   (the spec says black cloth), so a white dot on it barely stands out.
 *
 * So: one dot at a time, each found as the difference against a frame with
 * no dot. With a single dot lit there is nothing to pair, whatever the
 * camera's rotation or mirroring; the difference cancels the table, the room
 * light and everything else projected. Cost: one camera frame per dot (about
 * 1-3 s each over today's wifi), which is fine for a calibration run once at
 * boot and saved.
 *
 * Coordinates: the dots are drawn on the /table page's overlay layer in
 * table px (the page's own Surface), so the map is camera px → table px and
 * however the Pi scales the page onto its 1920×1200 screen is absorbed.
 */

export interface Dot {
  x: number
  y: number
}

export interface Seen {
  /** Camera px (full resolution). */
  x: number
  y: number
  /** Brightest difference (0-255): how clearly the dot stood out. */
  peak: number
  /** Camera px² above half the peak: a dot is small; a hand or a lamp change is not. */
  area: number
}

// Below this the dot did not show (projector off, page not on the projector,
// camera looking elsewhere): calling it a dot would fit noise.
const MIN_PEAK = 25
// Downsampled px around the peak where the dot's light is summed. A 22 px
// table-px dot is ~10-20 camera px across at 1080p.
const WINDOW = 24

/** Where one projected dot is: the light in `on` that is not in `off`. */
export function findDot(off: Gray, on: Gray, step = 2): Seen | null {
  if (off.width !== on.width || off.height !== on.height) return null
  // Downsample (step×step means) so a 1080p frame is cheap and single-pixel
  // sensor noise is averaged out before the peak search.
  const w = Math.floor(off.width / step)
  const h = Math.floor(off.height / step)
  const diff = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0
      for (let dy = 0; dy < step; dy++) {
        const row = (y * step + dy) * off.width + x * step
        for (let dx = 0; dx < step; dx++) s += on.data[row + dx]! - off.data[row + dx]!
      }
      diff[y * w + x] = Math.max(0, s / (step * step))
    }
  }
  // 3×3 box blur, then the peak: one hot pixel must not win over a dot.
  let best = -1
  let bi = 0
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let s = 0
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += diff[(y + dy) * w + x + dx]!
      if (s > best) {
        best = s
        bi = y * w + x
      }
    }
  }
  const peak = best / 9
  if (peak < MIN_PEAK) return null
  const px = bi % w
  const py = Math.floor(bi / w)
  const thr = peak / 2
  let sx = 0
  let sy = 0
  let sw = 0
  let n = 0
  for (let y = Math.max(0, py - WINDOW); y < Math.min(h, py + WINDOW); y++) {
    for (let x = Math.max(0, px - WINDOW); x < Math.min(w, px + WINDOW); x++) {
      const v = diff[y * w + x]!
      if (v < thr) continue
      sx += x * v
      sy += y * v
      sw += v
      n++
    }
  }
  // Centre of the pixel block, in full-resolution camera px.
  return { x: (sx / sw + 0.5) * step, y: (sy / sw + 0.5) * step, peak: Math.round(peak), area: n * step * step }
}

export interface Fit {
  h: H
  /** Reprojection error of the dots kept, table px. */
  rms: number
  used: number
  dropped: Dot[]
}

// Table px. A good fit on a flat table is a few px; one dot far off (a hand
// over it, a reflection) is dropped and the rest refit, keeping at least 6.
const GOOD_RMS = 6
const MIN_DOTS = 6

export function fitDots(pairs: Pair[]): Fit | null {
  let kept = [...pairs]
  const dropped: Dot[] = []
  if (kept.length < 4) return null
  for (;;) {
    const h = solveHomography(kept)
    // Why: four collinear or duplicate dots give the DLT a singular system, so
    // `solveHomography` returns an all-NaN matrix. `residual` is then NaN, and
    // `rms > GOOD_RMS` is FALSE for NaN, so the loop below would call this a
    // good fit and install a NaN map — every projected key then lands nowhere,
    // and `setCamera` throws out of the route, taking the demo down. Refuse it
    // here, where the shape is known, instead of trusting the error comparison.
    if (!validTransform(h)) return null
    const rms = residual(h, kept)
    if (!Number.isFinite(rms)) return null
    if (rms <= GOOD_RMS || kept.length <= MIN_DOTS) return { h, rms, used: kept.length, dropped }
    // Drop the worst-fitting dot and try again.
    let worst = 0
    let we = -1
    kept.forEach((p, i) => {
      const e = residual(h, [p])
      if (e > we) {
        we = e
        worst = i
      }
    })
    dropped.push(kept[worst]!.to)
    kept = kept.filter((_, i) => i !== worst)
  }
}

/** A 4×3 grid over the lit area: more than 4 so one bad dot can be dropped, spread so the map holds at the edges. */
export function bootDots(width: number, height: number, inset = 0.1): Dot[] {
  const xs = [0, 1 / 3, 2 / 3, 1].map((f) => inset * width + f * (1 - 2 * inset) * width)
  const ys = [0, 0.5, 1].map((f) => inset * height + f * (1 - 2 * inset) * height)
  return ys.flatMap((y) => xs.map((x) => ({ x: Math.round(x), y: Math.round(y) })))
}

export function dotShape(c: Dot, r = 22): OverlayShape {
  return { points: Array.from({ length: 24 }, (_, i) => ({ x: c.x + r * Math.cos((i * Math.PI) / 12), y: c.y + r * Math.sin((i * Math.PI) / 12) })), color: '#ffffff' }
}

export interface CalibrationRun {
  cameraGeometry?: { width: number; height: number }
  ok: boolean
  error?: string
  rms?: number
  h?: H
  /** Per dot: where it was drawn and where the camera saw it (null: not seen). */
  dots: { at: Dot; seen: Seen | null }[]
  dropped?: Dot[]
  ms: number
}

export interface CalibrationDeps {
  /** Draw on the /table page's calibration overlay (empty = nothing). */
  overlay(shapes: OverlayShape[]): void
  /** The room camera's newest frame, as JPEG. */
  frame(): Promise<Uint8Array>
  dots: Dot[]
  /** For the kiosk to paint the dot and the camera to deliver a frame that has it. */
  settleMs?: number
  /** Every camera frame taken, for recording a run as fixtures. */
  record?: (name: string, jpeg: Uint8Array) => void
  log?: (line: string) => void
}

/** Light each dot alone, find it by difference, fit. Leaves the overlay empty. */
export async function runCalibration(d: CalibrationDeps): Promise<CalibrationRun> {
  const t0 = Date.now()
  const settle = d.settleMs ?? 1500
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
  let cameraGeometry: { width:number; height:number } | undefined
  const grab = async (name: string) => {
    const jpg = await d.frame()
    d.record?.(name, jpg)
    const gray = decode(jpg)
    if (cameraGeometry && (gray.width !== cameraGeometry.width || gray.height !== cameraGeometry.height)) throw new Error('camera geometry changed during calibration')
    cameraGeometry = { width:gray.width, height:gray.height }
    return gray
  }
  const out: CalibrationRun['dots'] = []
  try {
    d.overlay([])
    await wait(settle)
    const off = await grab('off')
    for (const [i, at] of d.dots.entries()) {
      d.overlay([dotShape(at)])
      await wait(settle)
      const seen = findDot(off, await grab(`dot-${i}`))
      out.push({ at, seen })
      d.log?.(`dot ${i} (${at.x},${at.y}) → ${seen ? `camera (${seen.x.toFixed(0)},${seen.y.toFixed(0)}) peak ${seen.peak}` : 'not seen'}`)
    }
  } catch (e) {
    return { ok: false, error: `camera: ${e instanceof Error ? e.message : String(e)}`, dots: out, ms: Date.now() - t0 }
  } finally {
    d.overlay([])
  }
  const pairs: Pair[] = out.filter((o) => o.seen).map((o) => ({ from: { x: o.seen!.x, y: o.seen!.y }, to: o.at }))
  if (pairs.length < MIN_DOTS) return { ok: false, error: `only ${pairs.length} of ${d.dots.length} dots seen (is our /table page on the projector?)`, dots: out, ms: Date.now() - t0 }
  // A null fit is the degenerate case fitDots refuses (collinear/duplicate
  // camera points): report it as a failed run, never install it.
  const fit = fitDots(pairs)
  if (!fit) return { ok: false, error: 'the seen dots do not define a plane map (collinear or duplicated); re-run with the table and camera undisturbed', dots: out, ms: Date.now() - t0 }
  if (fit.rms > GOOD_RMS * 2) return { ok: false, error: `dots don't fit one plane (rms ${fit.rms.toFixed(1)} px): something moved during the run`, rms: fit.rms, dots: out, dropped: fit.dropped, ms: Date.now() - t0 }
  return { ok: true, cameraGeometry, rms: fit.rms, h: fit.h, dots: out, dropped: fit.dropped, ms: Date.now() - t0 }
}
