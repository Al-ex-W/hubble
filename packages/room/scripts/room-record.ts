import { mkdirSync, writeFileSync } from 'node:fs'
import { createLiveRoom } from '../src/live.ts'
import type { LidarScan, RoomEvent } from '../src/spec.ts'

/**
 * Records what the room really sends, for tests and replay (label:
 * recording). Do this in the first minutes on site, per the organisers'
 * advice to develop against recorded data: an empty table, a hand moving,
 * taps, a notebook placed, the MiniLab placed.
 *
 *   ROOM_URL=http://room.local ROOM_TOKEN=… npm run room:record -- empty-table 60
 */
try {
  process.loadEnvFile()
} catch {
  /* environment only */
}
const [name = 'session', seconds = '60'] = process.argv.slice(2)
const room = createLiveRoom({ base: process.env.ROOM_URL ?? 'http://127.0.0.1:8790', token: process.env.ROOM_TOKEN ?? 'dev-token' })
const dir = new URL(`../fixtures/${new Date().toISOString().slice(0, 10)}/${name}/`, import.meta.url)
mkdirSync(dir, { recursive: true })

const scans: LidarScan[] = []
const events: (RoomEvent & { at: number })[] = []
writeFileSync(new URL('room.json', dir), JSON.stringify(await room.info().catch((e) => ({ error: String(e) })), null, 1))
writeFileSync(new URL('slots.json', dir), JSON.stringify(await room.slots().catch(() => []), null, 1))
const stopL = room.lidar((s) => scans.push(s))
const stopE = room.events((e) => events.push({ ...e, at: Date.now() }))
let frames = 0
// 2 fps of full frames is enough to see objects and hands move, and keeps a
// minute of 4K stills to a size we can still commit.
const cam = setInterval(async () => {
  try {
    writeFileSync(new URL(`frame-${String(frames++).padStart(4, '0')}.jpg`, dir), await room.cameraFrame())
  } catch {
    /* a dropped frame is recorded as missing, not fatal */
  }
}, 500)
console.log(`recording ${seconds} s into ${dir.pathname}`)
await new Promise((r) => setTimeout(r, Number(seconds) * 1000))
clearInterval(cam)
stopL?.()
stopE()
writeFileSync(new URL('lidar.jsonl', dir), scans.map((s) => JSON.stringify(s)).join('\n') + '\n')
writeFileSync(new URL('events.json', dir), JSON.stringify(events, null, 1))
console.log(`done: ${scans.length} lidar rotations, ${frames} frames, ${events.length} events`)
room.close()
process.exit(0)
