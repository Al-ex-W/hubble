/**
 * `npm run demo`: the whole stack, ready for the room, with nothing to type
 * (owner, demo day 7 Oct: "0 of the bs setup"). Plan:
 * docs/plans/2026-10-07-demo-boot.md.
 *
 * - Every room URL comes from room.config.json, so nobody types env vars.
 *   An env var already set still wins (a rig override stays possible).
 * - The hardware window decides the mode, read from @hubble/room's windowAt
 *   (window.ts is its one owner; nothing here repeats the minutes). Inside it
 *   the room is live; outside it the stack starts offline (ROOM=none) and
 *   restarts live when the window opens.
 * - At the window's close the server's pool already refuses every device, so
 *   nothing is restarted: we only say so, and the UI stays up.
 * - Output is armed automatically once the server answers: the owner's
 *   standing go for the demo (Ruling in the plan). Writes still go through
 *   the pool, so they still only happen inside the window.
 * - A dead device never stops the boot: every URL is optional to the server,
 *   which reports a missing device as a red chip in the readiness strip.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { windowAt } from '@hubble/room'

const SERVER = `http://127.0.0.1:${process.env.PORT ?? 8787}`

type RoomConfig = {
  camera?: { base?: string }
  projector?: { base?: string }
  tvs?: Record<string, { base?: string }>
  lidar?: { base?: string; scan?: string }
}
function readConfig(): RoomConfig {
  try { return JSON.parse(readFileSync('room.config.json', 'utf8')) as RoomConfig } catch { return {} }
}

/** The live env from room.config.json; the known addresses if the file lacks one (camera .21, lidar .24). */
function liveEnv(): Record<string, string> {
  const c = readConfig()
  const camera = c.camera?.base ?? 'http://192.168.42.21'
  const env: Record<string, string> = {
    ROOM: 'live',
    ROOM_PI_TABLE: c.projector?.base ?? camera,
    HUBBLE_ROOM_CAMERA_URL: camera,
  }
  // The lidar stays unconnected for the demo (owner, 7 Oct 14:35: "keep the
  // lidar but leave it unconnected, we are only focusing on math and piano").
  // Its registration is saved in .hubble; HUBBLE_DEMO_LIDAR=1 connects it again.
  if (process.env.HUBBLE_DEMO_LIDAR === '1') {
    env.ROOM_PI_LIDAR = c.lidar?.base ?? 'http://192.168.42.24'
    env.LIDAR_URL = c.lidar?.scan ?? 'ws://192.168.42.24/scan'
  }
  if (c.tvs?.['tv-1']?.base) env.ROOM_PI_TV1 = c.tvs['tv-1'].base
  if (c.tvs?.['tv-2']?.base) env.ROOM_PI_TV2 = c.tvs['tv-2'].base
  // An explicit env var wins over the file.
  for (const k of Object.keys(env)) if (process.env[k]) env[k] = process.env[k]!
  return env
}

const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Stockholm' })

let child: ChildProcess | null = null
let live = false

function start(asLive: boolean) {
  live = asLive
  // ROOM=none must also clear the device URLs, or the server would still
  // dial the lidar and camera outside the window (the pool would refuse, but
  // the log would fill with refusals).
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (asLive) Object.assign(env, liveEnv())
  else {
    env.ROOM = 'none'
    for (const k of ['LIDAR_URL', 'HUBBLE_ROOM_CAMERA_URL', 'ROOM_PI_TABLE', 'ROOM_PI_LIDAR', 'ROOM_PI_TV1', 'ROOM_PI_TV2']) delete env[k]
  }
  child = spawn('npm', ['run', 'dev'], { env, stdio: 'inherit' })
  child.on('exit', (code) => { if (!stopping) { console.log(`demo: the stack exited (${code}); stopping`); process.exit(code ?? 1) } })
  if (asLive) void armWhenUp()
}

let stopping = false
function stop(): Promise<void> {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve()
    stopping = true
    child.once('exit', () => { stopping = false; resolve() })
    child.kill('SIGTERM')
  })
}

/** Arm room output once the server answers (Ruling: the owner's standing go). Retries for a minute, then says why. */
async function armWhenUp() {
  for (let i = 0; i < 60 && live; i++) {
    try {
      const r = await fetch(`${SERVER}/api/operator/room`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ armed: true }) })
      if (r.ok) { console.log('demo: room output armed'); void keepArmed(); return }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000))
  }
  if (live) console.log('demo: could not arm room output (server not answering); use the arm button on /')
}

/**
 * Re-arm whenever the server comes back disarmed. Why: every server restart
 * (tsx watch after an edit, a crash) starts with output DISARMED, and on 7 Oct
 * 13:15 that left the projector on someone else's page while we stood at the
 * table with no dots and no answers. Arming re-sends every display's page
 * (the slot writer reconciles), so this also puts /table back on the
 * projector. Only while live: at the window's close the stack restarts
 * offline and `live` goes false, which ends this loop.
 */
let keeping = false
async function keepArmed() {
  if (keeping) return
  keeping = true
  try {
    while (live) {
      await new Promise((r) => setTimeout(r, 3000))
      try {
        const s = (await (await fetch(`${SERVER}/api/operator/status`)).json()) as { output?: { active?: boolean } }
        if (s.output && s.output.active === false) {
          const r = await fetch(`${SERVER}/api/operator/room`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ armed: true }) })
          // Log only a real arm: a stray offline server on the port answers 200
          // with active:false (15:21, an old ROOM=none stack had taken :8787).
          const b = (await r.json().catch(() => ({}))) as { active?: boolean; room?: string | null }
          if (r.ok && b.active) console.log('demo: re-armed room output after a server restart')
          else console.log(`demo: re-arm refused (room=${b.room ?? 'none'}): is another Hubble stack holding :8787?`)
        }
      } catch {
        // the server is restarting; try again in 3 s
      }
    }
  } finally {
    keeping = false
  }
}

/** Wake at each window edge: open → restart live (if we were offline); close → say so, keep the UI up. */
function scheduleEdges() {
  const w = windowAt(Date.now())
  const next = w.open ? w.closesAt : w.opensAt
  setTimeout(async () => {
    const now = windowAt(Date.now())
    if (now.open) {
      console.log(`demo: hardware window open until ${hhmm(now.closesAt)}${live ? '' : ': restarting live'}`)
      if (!live) { await stop(); start(true) }
    } else {
      console.log(`demo: window closed: offline until ${hhmm(now.opensAt)}`)
    }
    scheduleEdges()
  }, Math.max(1000, next - Date.now() + 500))
}

const w = windowAt(Date.now())
if (w.open) {
  console.log(`demo: hardware window open until ${hhmm(w.closesAt)}: starting live (room.config.json)`)
  start(true)
} else {
  console.log(`demo: hardware window closed: starting offline (ROOM=none); it opens at ${hhmm(w.opensAt)} and the stack restarts live then`)
  start(false)
}
scheduleEdges()
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { void stop().then(() => process.exit(0)) })
