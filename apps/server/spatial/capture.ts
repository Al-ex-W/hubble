import type { LidarFrame } from '@hubble/room'
import type { Point } from './coordinates.ts'
import { foreground, type Baseline } from './baseline.ts'
import { clusters } from './touch.ts'

/**
 * Where a held fingertip is, in the lidar's OWN millimetres: the measurement a
 * registration pairs with the projected target the finger is on (#89 plan
 * T4, docs/plans/2026-10-07-lidar-web.md Ruling 1).
 *
 * Why sensor mm and not table mm: this runs BEFORE any registration exists,
 * because it's how the registration gets made. `clusters()` takes the
 * registration as a callback, so passing the identity keeps every other part
 * of the touch pipeline (background subtraction, the span filter that says
 * "finger, not palm") exactly as it is for live touches. Same evidence,
 * different frame: no second copy of the clustering to drift.
 *
 * Pure, so the rulings below are tested on recorded rotations without a
 * socket. The spatial service's captureFinger() feeds it the rotations it
 * collected.
 */

/**
 * Only returns this close to the lidar can be a finger on the table. The
 * projection is 1550 × 970 mm with the lidar near the middle of the back
 * edge, so its farthest corner is ~1.25 m away; 1.6 m leaves room for a
 * different mount and still drops people standing around the table, whose
 * fingers, sleeves and phones would otherwise count as a second finger and
 * refuse every capture. Before registration there is no table polygon to
 * clip with: this range is the only "on the table" test available.
 */
export const CAPTURE_MAX_RANGE_MM = 1600
/** Ruling 1: a finger in at least this share of the rotations, or there's no held finger. */
export const CAPTURE_MIN_HIT_SHARE = 0.6
/** Ruling 1: two clusters in more than this share of rotations is two fingers (or a finger and a hand). */
export const CAPTURE_MAX_MULTI_SHARE = 0.2
/** Ruling 1: the farthest single-finger sample from the median; past this the finger moved, so the point is not one place. */
export const CAPTURE_MAX_SPREAD_MM = 20
/** Fewer rotations than this is not a measurement (1.5 s at 10 Hz is ~15). */
const MIN_ROTATIONS = 5

export type FingerCapture =
  | { ok: true; sensor: Point; rotations: number; hits: number; spreadMm: number }
  | { ok: false; reason: 'no-finger' | 'two-fingers' | 'moving' | 'too-few-rotations'; detail: string; rotations: number }

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

export function measureFinger(frames: LidarFrame[], baseline: Baseline): FingerCapture {
  const rotations = frames.length
  if (rotations < MIN_ROTATIONS) return { ok: false, reason: 'too-few-rotations', detail: `only ${rotations} rotations arrived`, rotations }
  const singles: Point[] = []
  let multi = 0
  for (const f of frames) {
    const found = clusters(foreground(f.points, baseline), (sensor) => sensor, (sensor) => Math.hypot(sensor.x, sensor.y) <= CAPTURE_MAX_RANGE_MM)
    if (found.length === 1) singles.push(found[0]!.sensor)
    else if (found.length > 1) multi++
  }
  if (multi > rotations * CAPTURE_MAX_MULTI_SHARE) return { ok: false, reason: 'two-fingers', detail: `two or more fingers in ${multi} of ${rotations} rotations: one fingertip only`, rotations }
  if (singles.length < rotations * CAPTURE_MIN_HIT_SHARE) return { ok: false, reason: 'no-finger', detail: `a finger in ${singles.length} of ${rotations} rotations: hold one fingertip on the target`, rotations }
  const sensor = { x: median(singles.map((p) => p.x)), y: median(singles.map((p) => p.y)) }
  // Max, not a percentile: Ruling 1 says "refuse if the spread is > 20 mm",
  // and one sample 4 cm away means the finger slid during the capture, which
  // is exactly the case that would put a bad pair into the fit.
  const spreadMm = Math.max(...singles.map((p) => Math.hypot(p.x - sensor.x, p.y - sensor.y)))
  if (spreadMm > CAPTURE_MAX_SPREAD_MM) return { ok: false, reason: 'moving', detail: `the finger moved ${Math.round(spreadMm)} mm: hold it still`, rotations }
  return { ok: true, sensor, rotations, hits: singles.length, spreadMm }
}
