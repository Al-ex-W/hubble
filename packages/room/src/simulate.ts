import { BIN_DEG, type Pose } from './lidar.ts'
import type { LidarScan } from './spec.ts'

/**
 * A synthetic RPLIDAR C1, for the room emulator and for tests until real
 * scans are recorded on site (label: synthetic). It models what the
 * datasheet says matters: 0.72° steps, ±30 mm range noise, 15 mm resolution,
 * 0.05 m minimum range, a 0–1.5° beam pitch (the plane rises with distance,
 * so a low object far away is missed and the cloth is hit where the plane
 * dips into it), and occlusion (each ray reports only its nearest hit).
 */

export interface SimShape {
  /** Table mm. Circles for fingers/cups, rectangles for books, stands, people. */
  kind: 'circle' | 'rect'
  x: number
  y: number
  r?: number
  w?: number
  h?: number
  /** Height of the thing above the cloth, mm (a finger pressing ~10, a book ~25, a keyboard ~30). */
  heightMm: number
}

export interface SimOptions {
  pose: Pose
  /** Beam height above the cloth at the lidar, mm (spec: about 30). */
  beamMm?: number
  /** Beam pitch, degrees: positive tilts up away from the lidar. */
  pitchDeg?: number
  noiseMm?: number
  maxRangeMm?: number
  /** Seeded so tests are deterministic. */
  seed?: number
}

function rng(seed: number) {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return ((s >>> 0) % 1_000_000) / 1_000_000
  }
}

function rayHit(ox: number, oy: number, dx: number, dy: number, s: SimShape): number | null {
  if (s.kind === 'circle') {
    const fx = ox - s.x
    const fy = oy - s.y
    const b = fx * dx + fy * dy
    const c = fx * fx + fy * fy - (s.r ?? 8) ** 2
    const disc = b * b - c
    if (disc < 0) return null
    const t = -b - Math.sqrt(disc)
    return t > 0 ? t : null
  }
  // Slab test against an axis-aligned rectangle.
  const x0 = s.x
  const x1 = s.x + (s.w ?? 0)
  const y0 = s.y
  const y1 = s.y + (s.h ?? 0)
  let tmin = -Infinity
  let tmax = Infinity
  for (const [o, d, lo, hi] of [
    [ox, dx, x0, x1],
    [oy, dy, y0, y1],
  ]) {
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return null
    } else {
      const t1 = (lo - o) / d
      const t2 = (hi - o) / d
      tmin = Math.max(tmin, Math.min(t1, t2))
      tmax = Math.min(tmax, Math.max(t1, t2))
    }
  }
  return tmax >= Math.max(tmin, 0) && tmin > 0 ? tmin : null
}

export function simulateScan(shapes: SimShape[], o: SimOptions, t = Date.now()): LidarScan {
  const rand = rng(o.seed ?? 7)
  const beam = o.beamMm ?? 30
  const pitch = ((o.pitchDeg ?? 0) * Math.PI) / 180
  const noise = o.noiseMm ?? 30
  const maxR = o.maxRangeMm ?? 6000
  const points: LidarScan['points'] = []
  for (let a = 0; a < 360; a += BIN_DEG) {
    const rad = ((o.pose.rotation + (o.pose.mirrored ? -a : a)) * Math.PI) / 180
    const dx = Math.cos(rad)
    const dy = Math.sin(rad)
    let best = Infinity
    for (const s of shapes) {
      const d = rayHit(o.pose.x, o.pose.y, dx, dy, s)
      if (d === null || d < 50 || d > maxR) continue
      // Is the beam below the top of the shape at that distance?
      const beamAt = beam + Math.tan(pitch) * d
      if (beamAt > s.heightMm || beamAt < 0) continue
      best = Math.min(best, d)
    }
    // A downward pitch eventually meets the cloth itself.
    if (pitch < 0) {
      const floor = beam / Math.tan(-pitch)
      if (floor > 50 && floor < best) best = floor
    }
    if (best === Infinity) {
      points.push({ angle: +a.toFixed(2), distance: 0, quality: 0 })
      continue
    }
    // ±noise, uniform-ish, then the C1's 15 mm range resolution.
    const d = Math.round((best + (rand() * 2 - 1) * noise) / 15) * 15
    points.push({ angle: +a.toFixed(2), distance: Math.max(50, d), quality: 47 })
  }
  return { t, points }
}
