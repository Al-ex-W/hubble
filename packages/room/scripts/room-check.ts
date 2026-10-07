import { createLiveRoom } from '../src/live.ts'

/**
 * The first thing to run in the room (Tue 16:00): is everything we depend on
 * reachable, and what does the room really report? Prints facts, never
 * secrets. Exit code 1 if anything blocking failed.
 *
 *   ROOM_URL=http://room.local ROOM_TOKEN=… npm run room:check
 *   (defaults to the local emulator)
 */
try {
  process.loadEnvFile()
} catch {
  /* environment only */
}
const base = process.env.ROOM_URL ?? 'http://127.0.0.1:8790'
const token = process.env.ROOM_TOKEN ?? 'dev-token'
const room = createLiveRoom({ base, token })
let failed = false
const ok = (label: string, detail: string) => console.log(`  ✓ ${label.padEnd(22)} ${detail}`)
const bad = (label: string, detail: string, blocking = true) => {
  if (blocking) failed = true
  console.log(`  ${blocking ? '✗' : '!'} ${label.padEnd(22)} ${detail}`)
}
const timed = async <T>(p: Promise<T>) => {
  const t = Date.now()
  const v = await p
  return { v, ms: Date.now() - t }
}

console.log(`room: ${base}`)
try {
  const { v: info, ms } = await timed(room.info())
  ok('GET /api/room', `${ms} ms`)
  ok('displays', info.displays.map((d) => `${d.id} ${d.width}x${d.height}`).join(', ') || '(none listed)')
  ok('lights', `${info.lights.length}: ${info.lights.map((l) => l.id).join(', ')}`)
  ok('lidar pose', JSON.stringify(info.lidar))
  if (!info.displays.some((d) => d.id === 'table')) bad('table display', 'not listed')
} catch (e) {
  bad('GET /api/room', String(e))
}
try {
  const { v: slots } = await timed(room.slots())
  ok('slots', slots.map((s) => `${s.team} ${s.from.slice(11, 16)}–${s.until.slice(11, 16)}`).join(', ') || '(none)')
} catch (e) {
  bad('GET /api/slots', String(e), false)
}
try {
  const { v: f, ms } = await timed(room.cameraFrame())
  ok('camera frame', `${(f.length / 1024).toFixed(0)} KB JPEG in ${ms} ms`)
} catch (e) {
  bad('camera frame', String(e))
}
await new Promise<void>((resolve) => {
  let n = 0
  const t0 = Date.now()
  const stop = room.lidar((s) => {
    n++
    if (n === 10) {
      const pts = s.points.filter((p) => p.distance > 0).length
      ok('lidar', `${(10_000 / (Date.now() - t0)).toFixed(1)} Hz, ${s.points.length} points/rotation, ${pts} with a return`)
      stop?.()
      resolve()
    }
  })
  setTimeout(() => {
    if (n < 10) bad('lidar', `only ${n} rotations in 3 s`)
    stop?.()
    resolve()
  }, 3000)
})
// The model calls leave the room network: the one thing the spec does not promise.
for (const [name, url] of [
  ['internet: aiqu', 'https://llm.aiqu.ai/v1/models'],
  ['internet: elevenlabs', 'https://api.elevenlabs.io/v1/models'],
  ['internet: typesafe', 'https://api.typesafe.ai/v1/systemone'],
] as const) {
  try {
    const { v: r, ms } = await timed(fetch(url, { signal: AbortSignal.timeout(4000) }))
    ok(name, `HTTP ${r.status} in ${ms} ms`)
  } catch (e) {
    bad(name, e instanceof Error ? e.name : 'failed')
  }
}
room.close()
process.exit(failed ? 1 : 0)
