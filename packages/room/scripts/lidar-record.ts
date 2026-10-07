import { closeSync, openSync, writeSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createLidarSource } from '../src/lidarSource.ts'

/**
 * Record transport evidence without room outputs. This intentionally labels the
 * scene as unannotated: an operator calling a take "touch" is not independent
 * contact truth. Pair this log with camera/visible timing before fitting policy.
 * Exclusive creation protects an earlier take from accidental overwrite.
 */
try { process.loadEnvFile() } catch { /* environment only */ }
const url = process.env.LIDAR_URL
const path = process.argv[2]
const seconds = Number(process.argv[3] ?? 15)
if (!url || !path || !Number.isFinite(seconds) || seconds < 1 || seconds > 60) {
  throw new Error('Usage: LIDAR_URL=http://pi-lidar.local npm run lidar:record -- output.jsonl [seconds: 1–60]')
}
// Reserve both files before observing, so failure cannot overwrite a prior
// manifest while leaving a new capture with a misleading old provenance label.
const fd = openSync(path, 'wx')
let manifestFd: number
try { manifestFd = openSync(`${path}.manifest.json`, 'wx') } catch (error) { closeSync(fd); throw error }
let frames = 0
let points = 0
let writeFailed = false
const source = createLidarSource({ url, onFrame(frame) {
  if (writeFailed) return
  try {
    writeSync(fd, JSON.stringify(frame) + '\n')
    frames++
    points += frame.points.length
  } catch { writeFailed = true }
} })
await new Promise<void>(resolve => setTimeout(resolve, seconds * 1000))
const health = source.snapshot()
source.stop()
closeSync(fd)
writeFileSync(manifestFd, JSON.stringify({ provenance: 'recording', schema: 'LidarFrame/v1',
  scene: 'Unannotated; no contact or empty-table ground truth', recordedAt: new Date().toISOString(),
  clock: 'sourceTimeMs: Pi epoch; receivedAtMonoMs: process monotonic; acquisition age unknown',
  sha256: createHash('sha256').update(readFileSync(path)).digest('hex'), frames, points, health, writeFailed }, null, 2) + '\n')
closeSync(manifestFd)
console.log(JSON.stringify({ path, frames, points, writeFailed, contactVerified: false }))
process.exitCode = frames > 0 && !writeFailed ? 0 : 1
