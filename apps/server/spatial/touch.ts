import type { Point } from './coordinates.ts'
import { BIN_DEG, type Return } from './baseline.ts'

/**
 * Foreground returns → finger-sized clusters → tracked touches (#89, plan
 * Design: Touch). Pure; the spatial service is its one consumer (AGENTS.md
 * rule 3: lidar touch tracking is "hard part, own module, one consumer").
 *
 * The pipeline is the standard one every lidar touch wall uses (research:
 * LaserWall, Slamtec FrameGrabber, lidar-interactive-wall): background
 * subtraction (baseline.ts), clustering, a span filter, nearest-neighbour
 * tracking with a velocity gate. Every one of them drives position from the
 * lidar alone, which is what this does.
 */

export interface Cluster {
  /** Lidar Cartesian mm (x = d·cos a, y = d·sin a, as the spatial frame's raw returns). */
  sensor: Point
  /** Registered table mm. */
  table: Point
  n: number
  /** Chord between the first and last return, across the beam, mm. */
  spanMm: number
  rangeMm: number
}

export interface ClusterOptions {
  /**
   * Two neighbouring returns belong together when their ranges differ by less
   * than this. Measured along the beam, not in the plane: range is where the
   * noise is (3–6 mm static, research; up to ±30 mm datasheet), while
   * neighbouring returns on one finger are ~15 mm apart across the beam. The
   * old plane-distance radius split one finger into two touches.
   */
  epsMm: number
  /** Returns this many nominal steps apart (one dropped return between) still join. */
  maxGapSteps: number
  /**
   * Wider than this across the beam is not a finger: a palm, a forearm, a
   * person leaning in. Research: a finger is 1–3 tight returns; ~50 mm keeps
   * two returns on a thick thumb pad and rejects a flat hand. PROVISIONAL
   * until R4/R6 measure finger and palm spans on the real table.
   */
  maxSpanMm: number
}

export const DEFAULT_CLUSTER: ClusterOptions = { epsMm: 40, maxGapSteps: 2.5, maxSpanMm: 50 }

const toSensor = (p: Return): Point => {
  const a = (p.angle * Math.PI) / 180
  return { x: p.distance * Math.cos(a), y: p.distance * Math.sin(a) }
}

/**
 * `toTable` is the registration (null when unregistered: no clusters), and
 * `inside` the table polygon in table mm. Both are the spatial service's, so
 * this module never holds a second copy of the calibration.
 */
export function clusters(returns: Return[], toTable: (sensor: Point) => Point | null, inside: (table: Point) => boolean, o: ClusterOptions = DEFAULT_CLUSTER): Cluster[] {
  const pts = [...returns].filter((p) => p.distance > 0).sort((a, b) => a.angle - b.angle)
  const runs: Return[][] = []
  for (const p of pts) {
    const run = runs[runs.length - 1]
    const prev = run?.[run.length - 1]
    if (prev && p.angle - prev.angle <= BIN_DEG * o.maxGapSteps && Math.abs(p.distance - prev.distance) <= o.epsMm) run.push(p)
    else runs.push([p])
  }
  // The seam: a rotation's angles run 0→360 after sorting, so a finger at
  // 359.6° and 0.3° would be two runs at opposite ends. Real rotations start
  // near 358° (wire take), so the seam is not hypothetical.
  if (runs.length > 1) {
    const first = runs[0]
    const last = runs[runs.length - 1]
    const a = last[last.length - 1]
    const b = first[0]
    if (b.angle + 360 - a.angle <= BIN_DEG * o.maxGapSteps && Math.abs(a.distance - b.distance) <= o.epsMm) {
      runs[0] = [...last, ...first]
      runs.pop()
    }
  }
  const out: Cluster[] = []
  for (const run of runs) {
    const first = toSensor(run[0])
    const last = toSensor(run[run.length - 1])
    const spanMm = Math.hypot(last.x - first.x, last.y - first.y)
    if (spanMm > o.maxSpanMm) continue
    // Position: mean of the returns' sensor points. With 1–3 returns on a
    // finger, a mean is the centre across the beam; along the beam it is the
    // finger's front surface (~8 mm short of its axis), a constant the
    // finger-touch registration absorbs (Ruling 6).
    const sensor = { x: run.reduce((s, p) => s + toSensor(p).x, 0) / run.length, y: run.reduce((s, p) => s + toSensor(p).y, 0) / run.length }
    const table = toTable(sensor)
    if (!table || !inside(table)) continue
    out.push({ sensor, table, n: run.length, spanMm, rangeMm: Math.hypot(sensor.x, sensor.y) })
  }
  return out
}

export type TouchEvent = {
  type: 'candidate' | 'down' | 'move' | 'up' | 'cancel'
  id: number
  table: Point
  spanMm: number
}

export interface TrackerOptions {
  /**
   * How far from its predicted position a track may find its cluster, mm.
   * 150, not the old 70 (packages/room/src/lidar.ts): a swipe moves 100+ mm
   * between 10 Hz rotations, and a 70 mm gate split one word into a string of
   * new touches (research). Prediction (position + last velocity) is what
   * lets the gate stay this size without swallowing a neighbouring finger.
   */
  gateMm: number
  /** Rotations a track must be seen to go `down`. Keyboard semantics; the ripple uses `candidate`. */
  confirm: number
  /** Consecutive missed rotations before a track ends. 2: one dropped far-edge rotation must not lift a held finger. */
  release: number
}

export const DEFAULT_TRACKER: TrackerOptions = { gateMm: 150, confirm: 2, release: 2 }

interface Track {
  id: number
  p: Point
  v: Point
  seen: number
  missed: number
  down: boolean
  span: number
}

/**
 * Event contract, per track id:
 *   candidate (first rotation) → down (after `confirm`) → move* → up
 *   candidate → cancel                (vanished before confirming)
 *   any → cancel                      (reset: new socket session, new baseline or registration)
 * `candidate` fires on the FIRST rotation (Ruling 2): ~120–150 ms end to end
 * instead of ~220–250 ms. A false candidate costs a ripple; keyboard consumers
 * wait for `down`.
 */
export function createTracker(o: TrackerOptions = DEFAULT_TRACKER) {
  let tracks: Track[] = []
  let nextId = 1
  let session: string | null = null

  const ev = (type: TouchEvent['type'], t: Track): TouchEvent => ({ type, id: t.id, table: { ...t.p }, spanMm: t.span })

  function reset(): TouchEvent[] {
    const out = tracks.map((t) => ev('cancel', t))
    tracks = []
    return out
  }

  return {
    reset,
    /** One rotation's clusters. A different `sourceSession` cancels every track first: a reconnect must not stitch two paths. */
    update(sourceSession: string, found: Cluster[]): TouchEvent[] {
      const out: TouchEvent[] = session !== null && session !== sourceSession ? reset() : []
      session = sourceSession
      // Global greedy assignment: all (track, cluster) pairs within the gate,
      // closest first. Track-by-track greedy let an early track steal the
      // cluster a later track was sitting on when two fingers were close.
      const pairs: { t: number; c: number; d: number }[] = []
      tracks.forEach((t, ti) => {
        const pred = { x: t.p.x + t.v.x, y: t.p.y + t.v.y }
        found.forEach((c, ci) => {
          const d = Math.hypot(c.table.x - pred.x, c.table.y - pred.y)
          if (d <= o.gateMm) pairs.push({ t: ti, c: ci, d })
        })
      })
      pairs.sort((a, b) => a.d - b.d)
      const usedT = new Set<number>()
      const usedC = new Set<number>()
      for (const { t: ti, c: ci } of pairs) {
        if (usedT.has(ti) || usedC.has(ci)) continue
        usedT.add(ti)
        usedC.add(ci)
        const t = tracks[ti]
        const c = found[ci]
        t.v = { x: c.table.x - t.p.x, y: c.table.y - t.p.y }
        t.p = { ...c.table }
        t.span = c.spanMm
        t.seen++
        t.missed = 0
        if (!t.down && t.seen >= o.confirm) {
          t.down = true
          out.push(ev('down', t))
        } else if (t.down) out.push(ev('move', t))
      }
      const kept: Track[] = []
      tracks.forEach((t, ti) => {
        if (usedT.has(ti)) return void kept.push(t)
        t.missed++
        // A miss means no measurement: don't keep extrapolating a swipe off
        // the table; the next match is gated around where it was last seen.
        t.v = { x: 0, y: 0 }
        if (t.missed < o.release) return void kept.push(t)
        out.push(ev(t.down ? 'up' : 'cancel', t))
      })
      tracks = kept
      found.forEach((c, ci) => {
        if (usedC.has(ci)) return
        const t: Track = { id: nextId++, p: { ...c.table }, v: { x: 0, y: 0 }, seen: 1, missed: 0, down: false, span: c.spanMm }
        tracks.push(t)
        out.push(ev('candidate', t))
        if (o.confirm <= 1) {
          t.down = true
          out.push(ev('down', t))
        }
      })
      return out
    },
    /** Current tracks, for the spatial frame's state. */
    tracks: () => tracks.map((t) => ({ id: t.id, table: { ...t.p }, spanMm: t.span, phase: t.down ? ('down' as const) : ('candidate' as const) })),
  }
}
export type Tracker = ReturnType<typeof createTracker>
