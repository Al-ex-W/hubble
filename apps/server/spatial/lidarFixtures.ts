import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { LidarFrame } from '@hubble/room'
import type { Point } from './coordinates.ts'

/**
 * Test support for the lidar touch tests (#89). Not imported by production code.
 *
 * WIRE: H41's recording of the real pi-lidar /scan (packages/room/fixtures/
 * lidar/2026-10-07-wire, provenance `recording`). An unannotated room, NOT an
 * empty table and NOT touch truth; the lidar's mount at the time is unknown.
 * What it IS good for: real angle jitter, real zero returns, real range noise,
 * real rotation seams, a real static object and a real mover.
 *
 * withFinger(): a MECHANICAL MUTATION of a recorded rotation: the returns whose
 * angle falls on a 15 mm fingertip at a given sensor position take the finger's
 * range (it occludes what was behind it). Nothing else changes; where the real
 * angle steps leave a gap on the finger, the finger is simply not seen, as on
 * the real C1. Replaced by the on-site takes (R1–R6) once they exist.
 */
const WIRE = fileURLToPath(new URL('../../../packages/room/fixtures/lidar/2026-10-07-wire/scans.jsonl', import.meta.url))

export function wireFrames(session = 'wire'): LidarFrame[] {
  return readFileSync(WIRE, 'utf8')
    .trim()
    .split('\n')
    .map((line, i) => {
      const scan = JSON.parse(JSON.parse(line).raw) as { t: number; points: LidarFrame['points'] }
      return { sourceSession: session, seq: i + 1, sourceTimeMs: scan.t, receivedAtMonoMs: i * 100, points: scan.points, acquisitionAgeMs: null }
    })
}

/** Sensor polar of a sensor-Cartesian point (the spatial frame's convention: x = d·cos a, y = d·sin a). */
export const polar = (p: Point) => ({ angle: ((Math.atan2(p.y, p.x) * 180) / Math.PI + 360) % 360, distance: Math.hypot(p.x, p.y) })

/** Put an object of `widthMm` (a finger: 15; a palm: 80) at sensor point `at` into one rotation. */
export function withObject(frame: LidarFrame, at: Point, widthMm = 15): LidarFrame {
  const { angle, distance } = polar(at)
  const half = (Math.atan(widthMm / 2 / distance) * 180) / Math.PI
  const points = frame.points.map((p) => {
    let d = Math.abs(p.angle - angle)
    d = Math.min(d, 360 - d)
    return d <= half ? { ...p, distance: Math.round(distance), quality: 30 } : p
  })
  return { ...frame, points }
}
export const withFinger = (frame: LidarFrame, at: Point) => withObject(frame, at, 15)

/**
 * A schema-derived registration for tests: the lidar sits 30 mm behind the
 * middle of the back edge of a 1550 × 970 mm projection (SPEC §2's default
 * mount, the research's band size), its 0° along the table's +x and its
 * clockwise angles toward the user (+y). Not a measurement.
 */
export const LIDAR_AT = { x: 775, y: -30 }
export const sensorToTable = (s: Point): Point => ({ x: s.x + LIDAR_AT.x, y: s.y + LIDAR_AT.y })
export const tableToSensor = (t: Point): Point => ({ x: t.x - LIDAR_AT.x, y: t.y - LIDAR_AT.y })
export const insideTable = (t: Point) => t.x >= 15 && t.y >= 15 && t.x <= 1550 - 15 && t.y <= 970 - 15
