/**
 * Check or re-apply our room setup (room.config.json at the repo root).
 *
 *   npm run room:check   read-only: what each device shows / is set to now, versus our config
 *   npm run room:apply   write our settings to the devices that differ
 *
 * Why it exists: the room's devices are shared by three teams and the
 * organisers, and any of them may switch the camera's mode, put autofocus
 * back on or show another page on the projector (all of which happened on
 * 7 Oct). Re-creating our setup by hand meant remembering curl commands; this
 * makes it one command and shows exactly what changed first.
 *
 * Writes only what differs, one device at a time, each with a deadline, so a
 * dead Pi doesn't stop the rest (AGENTS.md rule 6). apply touches shared
 * devices: run it in our slot, with the owner's go.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pool, WINDOW_LABEL } from '@hubble/room'

interface Config {
  camera: { base: string; mode: string; controls: Record<string, number> }
  projector: { base: string; show: { url: string } | null }
  tvs: Record<string, { base: string; show: { url: string } | null } | string>
  lidar: { base: string }
  lights: { bridge: string }
}

const cfg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'room.config.json'), 'utf8')) as Config
const apply = process.argv.includes('--apply')
// The room's Pis answer slowly over its wifi (1-8 s seen on 7 Oct).
const DEADLINE = 15000

async function get(url: string): Promise<unknown> {
  const r = await pool.fetch(url, { signal: AbortSignal.timeout(DEADLINE) }, 'room:check')
  if (!r.ok) throw new Error(`${r.status}`)
  return r.json()
}
async function post(url: string, body: unknown): Promise<void> {
  const r = await pool.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(DEADLINE) }, 'room:apply')
  if (!r.ok) throw new Error(`${r.status} ${await r.text().catch(() => '')}`.trim())
}
const line = (device: string, state: 'ok' | 'differs' | 'down' | 'set' | 'info', text: string) =>
  console.log(`${device.padEnd(10)} ${{ ok: 'ok     ', differs: 'DIFFERS', down: 'DOWN   ', set: 'SET    ', info: '       ' }[state]} ${text}`)

async function camera() {
  const c = cfg.camera
  try {
    const status = (await get(`${c.base}/camera/status`)) as { mode: string }
    if (status.mode === c.mode) line('camera', 'ok', `mode ${status.mode}`)
    else if (apply) {
      await post(`${c.base}/camera/mode`, { resolution: c.mode })
      line('camera', 'set', `mode ${status.mode} -> ${c.mode}`)
    } else line('camera', 'differs', `mode is ${status.mode}, want ${c.mode}`)

    const controls = (await get(`${c.base}/camera/controls`)) as { controls?: Record<string, { value: number }> } & Record<string, { value: number }>
    const now = controls.controls ?? controls
    const differ = Object.entries(c.controls).filter(([k, v]) => now[k]?.value !== v)
    // A fixed focus only holds with autofocus off; setting the value turns it off (spec).
    if (c.controls.focus_absolute !== undefined && now.focus_automatic_continuous?.value !== 0) differ.push(['focus_absolute', c.controls.focus_absolute])
    const seen = Object.keys(c.controls).map((k) => `${k} ${now[k]?.value}`).join(', ')
    if (!differ.length) line('camera', 'ok', `${seen}, autofocus ${now.focus_automatic_continuous?.value === 0 ? 'off' : 'ON'}`)
    else if (apply) {
      await post(`${c.base}/camera/controls`, Object.fromEntries(differ))
      line('camera', 'set', differ.map(([k, v]) => `${k} -> ${v}`).join(', ') + ' (autofocus off)')
    } else line('camera', 'differs', `${seen}, autofocus ${now.focus_automatic_continuous?.value === 0 ? 'off' : 'ON'}; want ${JSON.stringify(c.controls)}, autofocus off`)
  } catch (e) {
    line('camera', 'down', String((e as Error).message ?? e))
  }
}

async function display(name: string, base: string, want: { url: string } | null) {
  try {
    const s = (await get(`${base}/status`)) as { mode: string; url: string | null; kiosk_connected?: boolean }
    const showing = s.mode === 'url' ? s.url : s.mode
    if (!want) return line(name, 'info', `showing ${showing} (ours: leave it)`)
    if (s.mode === 'url' && s.url === want.url) return line(name, 'ok', `showing our ${want.url}${s.kiosk_connected ? '' : ' (kiosk NOT connected)'}`)
    if (apply) {
      await post(`${base}/show`, want)
      line(name, 'set', `${showing} -> ${want.url}`)
    } else line(name, 'differs', `showing ${showing}, want ${want.url}`)
  } catch (e) {
    line(name, 'down', String((e as Error).message ?? e))
  }
}

async function reachable(name: string, url: string) {
  try {
    const r = await pool.fetch(url, { signal: AbortSignal.timeout(DEADLINE) }, 'room:check')
    line(name, 'info', `up (${r.status}); nothing to apply`)
  } catch (e) {
    line(name, 'down', String((e as Error).message ?? e))
  }
}

// Every device call below goes through the device pool, which refuses
// outside the hardware window (#73). Say so once, up front, instead of six devices each
// printing DOWN at :45, which reads as a dead room.
const w = pool.window()
if (!w.open) {
  console.log(`room hardware is off limits outside ${WINDOW_LABEL} (Stockholm). Next window: ${new Date(w.opensAt).toLocaleTimeString('sv-SE')}.`)
  process.exit(1)
}
console.log(apply ? 'room:apply: writing our settings to devices that differ\n' : 'room:check: read-only (npm run room:apply to write)\n')
await Promise.all([
  camera(),
  display('projector', cfg.projector.base, cfg.projector.show),
  ...Object.entries(cfg.tvs)
    .filter(([k]) => !k.startsWith('_'))
    .map(([k, v]) => display(k, (v as { base: string }).base, (v as { show: { url: string } | null }).show)),
  reachable('lidar', `${cfg.lidar.base}/status`),
  reachable('hue', `${cfg.lights.bridge}/api/config`),
])
