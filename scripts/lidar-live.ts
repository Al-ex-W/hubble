import { createInterface } from 'node:readline/promises'
import { windowAt, WINDOW_LABEL } from '@hubble/room'

/**
 * One command from "lidar on the table" to "touch → ripple" (#lidar-wizard):
 *
 *   npm run lidar:live
 *
 * It talks ONLY to our own server (loopback): the server, already running
 * live, owns the lidar socket (through the device pool) and the projector
 * page. So this script opens no device connection itself; it still checks the
 * hardware window first, because everything it asks the server to do is
 * hardware work (AGENTS.md: check the clock before you start).
 *
 * Steps: window → server live + lidar receiving + output armed → empty-table
 * baseline (you press Enter when the table is clear) → the registration run
 * (six white dots, one at a time; hold a finger on each) → 30 s of touches
 * printed as they ripple.
 */
const BASE = process.env.HUBBLE_SERVER ?? 'http://127.0.0.1:8787'
// Loopback only: this script must never become a way around the device pool
// (devices.architecture.test.ts allows its fetch on that condition).
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(BASE).hostname)) throw new Error(`HUBBLE_SERVER must be our own server on loopback, not ${BASE}`)
const START = `ROOM=live HUBBLE_ROOM_CAMERA_URL=http://192.168.42.21 LIDAR_URL=http://192.168.42.24 npm run dev`
const rl = createInterface({ input: process.stdin, output: process.stdout })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const die = (msg: string): never => {
  console.error(`\n✗ ${msg}`)
  rl.close()
  process.exit(1)
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`).catch(() => null)
  if (!r) return die(`the server isn't answering at ${BASE}.\n  Start it live:\n    ${START}\n  then arm the room output on http://localhost:5173 and run this again.`)
  return (await r.json()) as T
}
async function post<T>(path: string, body: unknown = {}): Promise<{ ok: boolean; body: T }> {
  const r = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null)
  if (!r) return die(`the server stopped answering at ${BASE}`)
  return { ok: r.ok, body: (await r.json().catch(() => ({}))) as T }
}

// ---- 1. the window ----
const w = windowAt(Date.now())
const left = Math.round((w.closesAt - Date.now()) / 1000)
if (!w.open) die(`the hardware window is shut (${WINDOW_LABEL} Stockholm). Next opens ${new Date(w.opensAt).toLocaleTimeString('sv-SE')}.`)
// Baseline 3 s + six targets (~5 s each with walking) + 30 s of touches.
if (left < 120) die(`only ${left} s left in the window: not enough for a run. Wait for the next one.`)
console.log(`✓ hardware window open, ${Math.floor(left / 60)} min ${left % 60} s left (disconnect by :30)`)

// ---- 2. the server: live, lidar receiving, output armed ----
type Frame = { touchEnabled: boolean; reason: string; lidar: { health: { state: string } | null; touches: { id: number; projector: { x: number; y: number } | null }[] } }
const frame = await get<Frame>('/api/spatial')
if (/No lidar configured/.test(frame.reason)) die(`the server runs without a lidar. Restart it live:\n    ${START}`)
if (frame.lidar.health?.state !== 'receiving') die(`the lidar isn't streaming (state: ${frame.lidar.health?.state ?? 'none'}). Is pi-lidar up (192.168.42.24)? Check the server log.`)
console.log('✓ server live, lidar receiving')
const status = await get<{ output?: { requiresArm: boolean; active: boolean } }>('/api/operator/status')
if (status.output?.requiresArm && !status.output.active) {
  // Arming is the owner's go for projector writes; the owner is the one
  // running this and answering, so asking here IS asking the owner.
  const a = await rl.question('room output is NOT armed (the dots are a projector write). Arm it now? [y/N] ')
  if (!/^y/i.test(a.trim())) die('not armed: arm it on http://localhost:5173 and run this again.')
  const r = await post<{ active?: boolean }>('/api/operator/room', { armed: true })
  if (!r.body.active) die('arming did not take (no slot?). Check the room output on :5173.')
}
console.log('✓ room output armed')

// ---- 3. the empty-table baseline ----
await rl.question('\nClear the table: no hands, no objects in the lidar plane. Press Enter… ')
console.log('  learning the empty table (3 s)…')
const base = await post<{ ok: boolean; rotations?: number; reason?: string }>('/api/spatial/baseline', { ms: 3000 })
if (!base.body.ok) die(`baseline failed: ${base.body.reason}`)
console.log(`✓ baseline from ${base.body.rotations} rotations`)

// ---- 4. the registration run, progress polled ----
type Run = { phase: string; index: number; total: number; error: string | null; result: { rmsTableMm: number } | null; captured: unknown[] }
console.log('\nA white dot appears on the table. Hold ONE finger on it, still, ~1 s. Then the next one (6 in all).')
const running = post<Run>('/api/spatial/registration/wizard')
let last = ''
let done = false
void running.finally(() => { done = true })
while (!done) {
  const s = await get<Run>('/api/spatial/registration/wizard')
  const line = s.phase === 'target' ? `  → dot ${s.index}/${s.total}: hold a finger on it (${s.captured.length} captured)` : s.phase === 'fitting' ? '  → fitting…' : ''
  if (line && line !== last) console.log((last = line))
  await sleep(300)
}
const run = (await running).body
if (run.phase !== 'done') die(`registration failed: ${run.error}\n  Run it again (npm run lidar:live); the old registration was dropped, touch is off.`)
console.log(`✓ registered: held-out error ${run.result?.rmsTableMm.toFixed(1)} mm`)

// ---- 5. touches ----
const after = await get<Frame>('/api/spatial')
if (!after.touchEnabled) die(`touch is still off: ${after.reason}`)
console.log('\nTOUCH ANYWHERE: ripple. (printing touches for 30 s)')
const seen = new Set<number>()
const end = Date.now() + 30_000
while (Date.now() < end) {
  const f = await get<Frame>('/api/spatial')
  for (const t of f.lidar.touches) {
    if (seen.has(t.id)) continue
    seen.add(t.id)
    console.log(`  touch #${t.id} at ${t.projector ? `${Math.round(t.projector.x)},${Math.round(t.projector.y)} px` : '(off the table)'}`)
  }
  await sleep(100)
}
console.log(`\n${seen.size} touches in 30 s. Touch stays on while the server runs.`)
console.log('Remember: stop the live server (or switch to ROOM=emulator) by :30.')
rl.close()
