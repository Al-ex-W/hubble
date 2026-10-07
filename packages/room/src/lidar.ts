import type { LidarScan, RoomInfo } from './spec.ts'

/**
 * From raw RPLIDAR C1 rotations to touches on the table.
 *
 * Coordinates: table millimetres, origin at the table's top-left corner seen
 * from above, x to the right, y toward the user (who sits at the bottom
 * edge). The lidar's pose comes from `GET /api/room` (see spec.ts for the
 * assumed shape).
 *
 * Why a baseline and not a height threshold: the C1's beam has a 0–1.5° pitch
 * (datasheet), which over a 1.5 m table moves the plane by up to ~39 mm. A
 * fixed "3 cm above the table" does not exist. Instead we record what an
 * empty table looks like at every angle and call anything clearly closer than
 * that a touch. The same trick ignores TV stands, people beyond the table, and
 * the point where a tilted beam meets the cloth.
 */

export const BIN_DEG = 0.72
const BINS = Math.round(360 / BIN_DEG)
const binOf = (angle: number) => ((Math.round(angle / BIN_DEG) % BINS) + BINS) % BINS

export interface Pose {
  x: number
  y: number
  /** Direction of the lidar's 0°, degrees clockwise (seen from above) from +x. */
  rotation: number
  mirrored?: boolean
}

export const poseFrom = (info: RoomInfo): Pose => ({ ...info.lidar })

/** Per-angle distance of the empty table (mm); 0 = nothing seen at that angle. */
export type Baseline = Float32Array

/**
 * Median per angle over a few seconds of an empty table. Median, not mean, so
 * a person walking past behind the table during recording doesn't move it.
 */
export function buildBaseline(scans: LidarScan[]): Baseline {
  const per: number[][] = Array.from({ length: BINS }, () => [])
  for (const s of scans) for (const p of s.points) if (p.distance > 0) per[binOf(p.angle)].push(p.distance)
  const base = new Float32Array(BINS)
  per.forEach((v, i) => {
    if (v.length < Math.max(2, scans.length / 3)) return
    v.sort((a, b) => a - b)
    base[i] = v[Math.floor(v.length / 2)]
  })
  return base
}

export interface TablePoint {
  x: number
  y: number
  angle: number
  distance: number
}

export function toTable(scan: LidarScan, pose: Pose): TablePoint[] {
  const out: TablePoint[] = []
  for (const p of scan.points) {
    if (!p.distance) continue
    // y-down coordinates: "clockwise seen from above" is increasing angle.
    const a = ((pose.rotation + (pose.mirrored ? -p.angle : p.angle)) * Math.PI) / 180
    out.push({ x: pose.x + Math.cos(a) * p.distance, y: pose.y + Math.sin(a) * p.distance, angle: p.angle, distance: p.distance })
  }
  return out
}

export interface TouchOptions {
  /** How much closer than the empty table a return must be to count. */
  marginMm: number
  /**
   * Two returns belong to the same thing when they are in neighbouring
   * angle bins and their ranges differ by less than this. Measured in range,
   * not in the plane: the C1's ±30 mm noise is along the beam, so returns
   * from one finger can sit ~60 mm apart radially while being 2 mm apart
   * across it. A plane-distance radius split one finger into two touches.
   */
  epsMm: number
  /** Table area to keep (mm), inset from the edges. */
  table: { w: number; h: number; inset: number }
}

// marginMm: the C1's ±30 mm noise plus its 15 mm range steps put an empty-
// table return up to ~45 mm closer than its baseline. A 40 mm margin let the
// keyboard's back edge flicker into a phantom touch (recorded in the
// keyboard integration test); 60 mm clears the noise with room to spare.
export const DEFAULT_TOUCH: TouchOptions = { marginMm: 60, epsMm: 90, table: { w: 1500, h: 1500, inset: 15 } }

export interface Blob {
  x: number
  y: number
  /** Points in the cluster: 1 at the far edge (19 mm spacing), several near the lidar. */
  n: number
  /** Width across the beam, mm: a finger is ~15–25, a hand or an object much more. */
  spanMm: number
}

/** One rotation → candidate contact blobs on the table. */
export function blobs(scan: LidarScan, pose: Pose, baseline: Baseline | null, o: TouchOptions = DEFAULT_TOUCH): Blob[] {
  const pts = toTable(scan, pose).filter((p) => {
    if (p.x < o.table.inset || p.y < o.table.inset || p.x > o.table.w - o.table.inset || p.y > o.table.h - o.table.inset) return false
    if (!baseline) return true
    const b = baseline[binOf(p.angle)]
    return b === 0 || p.distance < b - o.marginMm
  })
  // Points arrive sorted by angle, so a cluster is a run of neighbours that
  // stay within eps of each other: linear, no O(n²) search per rotation.
  pts.sort((a, b) => a.angle - b.angle)
  const out: Blob[] = []
  let run: TablePoint[] = []
  const flush = () => {
    if (!run.length) return
    const x = run.reduce((s, p) => s + p.x, 0) / run.length
    const y = run.reduce((s, p) => s + p.y, 0) / run.length
    const first = run[0]
    const last = run[run.length - 1]
    out.push({ x, y, n: run.length, spanMm: Math.hypot(last.x - first.x, last.y - first.y) })
    run = []
  }
  for (const p of pts) {
    const prev = run[run.length - 1]
    // Neighbours: at most one empty bin between them (a dropped return), and a similar range.
    if (prev && (p.angle - prev.angle > BIN_DEG * 2.5 || Math.abs(p.distance - prev.distance) > o.epsMm)) flush()
    run.push(p)
  }
  flush()
  return out
}

export interface Touch {
  id: number
  x: number
  y: number
  phase: 'down' | 'move' | 'up'
  /** Width across the beam; lets consumers tell a finger from a whole hand. */
  spanMm: number
}

/**
 * Tracks blobs across rotations into touches with down/move/up phases.
 * A touch must be seen in 2 consecutive rotations to go down (a single
 * noisy return is not a touch) and missed in 2 to go up (one dropped scan
 * at the far edge must not end a press). At 10 Hz that is 200 ms each way.
 */
export function createTouchTracker(opts: { matchMm?: number; confirm?: number; release?: number } = {}) {
  const match = opts.matchMm ?? 70
  const confirm = opts.confirm ?? 2
  const release = opts.release ?? 2
  let nextId = 1
  let tracks: { id: number; x: number; y: number; seen: number; missed: number; down: boolean; span: number }[] = []

  return {
    update(found: Blob[]): Touch[] {
      const events: Touch[] = []
      const used = new Set<number>()
      for (const t of tracks) {
        let best = -1
        let bestD = match
        found.forEach((b, i) => {
          if (used.has(i)) return
          const d = Math.hypot(b.x - t.x, b.y - t.y)
          if (d < bestD) {
            bestD = d
            best = i
          }
        })
        if (best >= 0) {
          used.add(best)
          const b = found[best]
          t.x = b.x
          t.y = b.y
          t.span = b.spanMm
          t.seen++
          t.missed = 0
          if (!t.down && t.seen >= confirm) {
            t.down = true
            events.push({ id: t.id, x: t.x, y: t.y, phase: 'down', spanMm: t.span })
          } else if (t.down) events.push({ id: t.id, x: t.x, y: t.y, phase: 'move', spanMm: t.span })
        } else {
          t.missed++
        }
      }
      for (const t of tracks) if (t.down && t.missed >= release) events.push({ id: t.id, x: t.x, y: t.y, phase: 'up', spanMm: t.span })
      tracks = tracks.filter((t) => t.missed < release)
      found.forEach((b, i) => {
        if (!used.has(i)) tracks.push({ id: nextId++, x: b.x, y: b.y, seen: 1, missed: 0, down: false, span: b.spanMm })
      })
      return events
    },
  }
}
