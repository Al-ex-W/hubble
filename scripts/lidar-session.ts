import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createLidarSource } from '@hubble/room'
import { TAKES, durationMs, type Cue } from './lidar-session/takes.ts'
import { preflight } from './lidar-session/preflight.ts'

/**
 * Guided lidar take (docs/plans/2026-10-07-lidar-touch.md, T1): records every
 * rotation like `lidar:record` AND a cue log on the same monotonic clock, so
 * each instructed tap/hover has a time a test can check against without
 * trusting the touch code.
 *
 *   LIDAR_URL=http://pi-lidar.local npm run lidar:session -- R4 [--say] [--out dir]
 *
 * Read-only: it opens the scan socket through the device pool (window-gated,
 * closed at the window's end, see packages/room/src/window.ts) and writes
 * nothing to any room device. It refuses to START a take that would run past
 * the close (AGENTS.md: never start hardware work hoping it will be quick), and
 * the pool closes the socket at the close regardless.
 *
 * `--say` speaks the cues on the laptop (macOS `say`): the person at the table
 * has their hands busy and can't read a terminal. The room has no sound
 * (SPEC), the laptop does.
 */
try { process.loadEnvFile() } catch { /* environment only */ }
const args = process.argv.slice(2)
const takeId = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--out')
const speak = args.includes('--say')
const take = takeId ? TAKES[takeId] : undefined
const url = process.env.LIDAR_URL
if (!take || !url) {
  throw new Error(`Usage: LIDAR_URL=http://pi-lidar.local npm run lidar:session -- <${Object.keys(TAKES).join('|')}> [--say] [--out dir]`)
}

const totalMs = durationMs(take)
const now = new Date()
// The window check lives in preflight.ts, which reads packages/room/src/window.ts
// (Stockholm time): an inline copy here once said :20 after the window moved.
const verdict = preflight({ nowMs: now.getTime(), takeMs: totalMs, url, takeId: take.id })
if (!verdict.ok) throw new Error(verdict.reason)

const stamp = now.toISOString().slice(0, 16).replace(/[-:T]/g, '')
const outIndex = args.indexOf('--out')
const dir = outIndex >= 0 ? args[outIndex + 1] : join('.hubble', 'lidar-evidence', 'touch', `${stamp}-${take.id}`)
mkdirSync(dir, { recursive: true })
// Exclusive creation ('wx'): a re-run never overwrites an earlier take.
const scansFd = openSync(join(dir, 'scans.jsonl'), 'wx')
const cuesFd = openSync(join(dir, 'cues.jsonl'), 'wx')

let frames = 0
let points = 0
const source = createLidarSource({
  url,
  onFrame(frame) {
    writeSync(scansFd, JSON.stringify(frame) + '\n')
    frames++
    points += frame.points.length
  },
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
// Don't start cues into a dead socket: an empty take labelled "taps" is worse
// than no take, because it looks like the touch code missed everything.
const waitStart = performance.now()
while (source.snapshot().state !== 'receiving') {
  if (performance.now() - waitStart > 5000) {
    source.stop()
    throw new Error(`No scans within 5 s (state ${source.snapshot().state}); nothing recorded as a take.`)
  }
  await sleep(50)
}

const say = (text: string) => {
  console.log(text)
  if (speak) spawn('say', ['-r', '200', text], { stdio: 'ignore', detached: true }).unref()
}

// One anchor pair ties the monotonic cue clock to wall time, for lining the
// phone video up afterwards (the clap is the fine alignment).
const startMono = performance.now()
const startEpoch = Date.now()
console.log(`Take ${take.id}: ${take.scene}`)
for (const cue of take.cues as Cue[]) {
  const wait = startMono + cue.atMs - performance.now()
  if (wait > 0) await sleep(wait)
  const atMonoMs = performance.now()
  writeSync(cuesFd, JSON.stringify({ ...cue, atMonoMs }) + '\n')
  say(cue.say)
}
// One more rotation's worth so the last lift is in the scans.
await sleep(300)
const health = source.snapshot()
source.stop()
closeSync(scansFd)
closeSync(cuesFd)

const sha = (f: string) => createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')
writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
  provenance: 'recording',
  schema: 'LidarFrame/v1 + Cue/v1',
  take: take.id,
  scene: take.scene,
  recordedAt: new Date(startEpoch).toISOString(),
  clock: 'scans.receivedAtMonoMs and cues.atMonoMs share this process\'s performance.now(); startEpochMs/startMonoMs anchor them to wall time; sourceTimeMs is the Pi\'s epoch clock (not synchronized)',
  startEpochMs: startEpoch,
  startMonoMs: startMono,
  frames,
  points,
  health,
  sha256: { 'scans.jsonl': sha('scans.jsonl'), 'cues.jsonl': sha('cues.jsonl') },
  truth: 'Cues are what was asked, not what happened. Independent truth: the phone video, annotated by a person into truth.json.',
}, null, 2) + '\n')
console.log(JSON.stringify({ dir, frames, points, state: health.state }))
process.exitCode = frames > 0 ? 0 : 1
