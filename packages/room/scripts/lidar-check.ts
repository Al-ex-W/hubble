import { createLidarSource } from '../src/lidarSource.ts'

/** Deliberately independent of room-check: no outputs, metadata or cloud APIs.
 * A scan count proves delivery only; contact and acquisition latency remain
 * unknown until the shared spatial calibration/paired recording is available. */
try { process.loadEnvFile() } catch { /* environment only */ }
const url = process.env.LIDAR_URL
if (!url) throw new Error('Set LIDAR_URL to the lidar Pi host or explicit WebSocket scan URL')
let frames = 0
let points = 0
let first: number | null = null
let last: number | null = null
const source = createLidarSource({ url, onFrame(frame) {
  frames++
  points += frame.points.length
  first ??= frame.receivedAtMonoMs
  last = frame.receivedAtMonoMs
} })
await new Promise<void>(resolve => setTimeout(resolve, 3000))
const health = source.snapshot()
source.stop()
console.log(JSON.stringify({ health, frames, points, receivedHz: first !== null && last !== null && last > first ? (frames - 1) * 1000 / (last - first) : null,
  calibrated: false, contactVerified: false, acquisitionAgeKnown: false }, null, 2))
process.exitCode = frames >= 10 && health.state === 'receiving' ? 0 : 1
