import { DEADLINE_MS, type Room, type WriteResult } from './room.ts'
import { HUE_LIGHT_IDS, LIDAR_PI_PATHS, MAX_LIDAR_BYTES, PI_PATHS, PI_ROOM, parseLidarScan, type DisplayCommand, type DisplayId, type PiStatus, type RoomInfo } from './spec.ts'
import { hexToXy } from './legacy.ts'
import { keepAlive } from './socket.ts'
import { pool as defaultPool, type DevicePool } from './pool.ts'

/**
 * The real room as it is configured today: each Raspberry Pi serves its own
 * device and the lights are the Hue bridge's own API (spec.ts PI_ROOM; the
 * organisers dropped the gateway on 5 Oct). This is what `ROOM=live` means.
 *
 * No gating here, on purpose: whether we may write to the shared room is
 * decided in one place, the slot writer's arm switch (slot.ts), which the
 * operator flips. Since 5 Oct the room has no slots or tokens in code, so
 * nothing on the wire would stop us taking the projector from another team
 * (on 7 Oct it was showing another laptop's page): the arm switch is the
 * only thing that does, and two gates would disagree about why a write was
 * dropped.
 *
 * Every call has a deadline, and a dead Pi never takes the others down:
 * `info()` leaves a Pi that doesn't answer out instead of failing.
 */
export interface PiRoomOptions {
  /** Device addresses; defaults are the room's DHCP reservations. */
  hosts?: Partial<Record<keyof typeof PI_ROOM, string>>
  /** The Hue bridge's API user (ROOM-SETUP.md). A credential: env only, never the repo. Without it, lights are `unavailable`. */
  hueUser?: string
  /**
   * Where the lidar sits and where its 0° points, in table mm and degrees.
   * Measured on site (SPEC §4.3) by whoever owns the spatial service; until
   * then the caller passes the spec's default spot.
   */
  lidarPose: RoomInfo['lidar']
  table?: RoomInfo['table']
  /** The device pool (#73): every Pi and the Hue bridge only n:10–n:30. Tests pass their own. */
  pool?: DevicePool
}

// The Pi's wifi gives a camera frame in 0.5-8 s (H28, 7 Oct): the generic
// 5 s camera deadline cut off frames that were on their way.
const CAMERA_DEADLINE_MS = 10_000

export function createPiRoom(o: PiRoomOptions): Room {
  const hosts = { ...PI_ROOM, ...o.hosts }
  const strip = (s: string) => s.replace(/\/$/, '')
  const sockets: (() => void)[] = []
  const pool = o.pool ?? defaultPool

  const send = async (url: string, init: RequestInit): Promise<WriteResult> => {
    let res: Response
    try {
      res = await pool.fetch(url, { ...init, signal: AbortSignal.timeout(DEADLINE_MS.http) }, `pi ${init.method} ${new URL(url).pathname}`)
    } catch (e) {
      return { ok: false, reason: 'unavailable', error: `${init.method} ${new URL(url).pathname}: ${e instanceof Error ? e.name : 'failed'}` }
    }
    if (res.status === 429) {
      const after = Number(res.headers.get('retry-after'))
      return { ok: false, reason: 'rate-limited', retryAfterMs: Number.isFinite(after) && after > 0 ? after * 1000 : 1500 }
    }
    if (!res.ok) return { ok: false, reason: 'unavailable', error: `${init.method} ${new URL(url).pathname}: ${res.status}` }
    return { ok: true }
  }

  /** The body `POST /show` wants for each command (display/README.md). */
  const showBody = (cmd: DisplayCommand): RequestInit | null => {
    const json = (b: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })
    if (cmd.type === 'url') return json({ url: cmd.url })
    if (cmd.type === 'blank') return json({ blank: true })
    if (cmd.type === 'idle') return json({ idle: true })
    if (cmd.type === 'image' && cmd.url) return json({ url: cmd.url })
    if (cmd.type === 'image' && cmd.data) {
      // A data URL → the raw image as the body, with its own type.
      const m = /^data:(image\/[\w+.-]+);base64,(.*)$/s.exec(cmd.data)
      if (!m) return null
      return { method: 'POST', headers: { 'Content-Type': m[1]! }, body: Buffer.from(m[2]!, 'base64') }
    }
    return null
  }

  const status = async (display: DisplayId): Promise<PiStatus | null> => {
    try {
      const res = await pool.fetch(`${strip(hosts[display])}${PI_PATHS.status}`, { signal: AbortSignal.timeout(DEADLINE_MS.http) }, `pi status ${display}`)
      if (!res.ok) return null
      const s = (await res.json()) as PiStatus
      return Array.isArray(s.screen) && s.screen.length === 2 ? s : null
    } catch {
      return null
    }
  }

  return {
    kind: 'live',
    async info() {
      const ids: DisplayId[] = ['table', 'tv-1', 'tv-2']
      const st = await Promise.all(ids.map(status))
      return {
        displays: ids.flatMap((id, i) => (st[i] ? [{ id, width: st[i]!.screen[0], height: st[i]!.screen[1] }] : [])),
        lights: Object.keys(HUE_LIGHT_IDS).map((id) => ({ id, kind: id.startsWith('strip') ? ('strip' as const) : ('spot' as const) })),
        lidar: o.lidarPose,
        table: o.table,
        // No slots in code any more (SPEC §1): the operator's arm switch is the slot.
        slot: null,
      }
    },
    slots: async () => [],
    // The Hue buttons aren't registered in the bridge yet (SPEC §2), and
    // there are no slot events: nothing to subscribe to.
    events: () => () => {},
    lidar(onScan) {
      const stop = keepAlive(
        `${strip(hosts.lidar)}${LIDAR_PI_PATHS.scan}`,
        (data) => {
          const s = parseLidarScan(data)
          if (s) onScan(s)
        },
        { maxPayload: MAX_LIDAR_BYTES, pool, owner: 'lidar scan' },
      )
      sockets.push(stop)
      return stop
    },
    async cameraFrame() {
      const res = await pool.fetch(`${strip(hosts.table)}${PI_PATHS.cameraFrame}`, { signal: AbortSignal.timeout(CAMERA_DEADLINE_MS) }, 'camera frame')
      if (!res.ok) throw new Error(`GET ${PI_PATHS.cameraFrame}: ${res.status}`)
      return new Uint8Array(await res.arrayBuffer())
    },
    // null, never the Pi's own MJPEG URL: a browser opening that would reach
    // the camera around the device pool, at any minute of the hour (#73).
    // Browsers see the camera through our server's proxy, which goes
    // through the pool.
    cameraStreamUrl: () => null,
    async show(display, cmd) {
      const init = showBody(cmd)
      if (!init) return { ok: false, reason: 'unsupported', error: `cannot show ${cmd.type} without a url or data` }
      return send(`${strip(hosts[display])}${PI_PATHS.show}`, init)
    },
    // The real displays have no draw socket (their nearest is WS /frames, whole images).
    draw: async () => ({ ok: false, reason: 'unsupported', error: 'the room displays have no draw socket' }),
    async light(id, cmd) {
      const n = HUE_LIGHT_IDS[id]
      if (!n) return { ok: false, reason: 'unsupported', error: `no Hue light named ${id}` }
      if (!o.hueUser) return { ok: false, reason: 'unavailable', error: 'no Hue API user (set ROOM_HUE_USER)' }
      const body: Record<string, unknown> = {}
      if (cmd.on !== undefined) body.on = cmd.on
      if (cmd.bri !== undefined) body.bri = Math.max(1, Math.min(254, Math.round(cmd.bri)))
      if (cmd.color) body.xy = hexToXy(cmd.color)
      const url = `${strip(hosts.hue)}/api/${encodeURIComponent(o.hueUser)}/lights/${n}/state`
      let res: Response
      try {
        res = await pool.fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(DEADLINE_MS.http) }, `hue light ${id}`)
      } catch (e) {
        return { ok: false, reason: 'unavailable', error: `hue light ${id}: ${e instanceof Error ? e.name : 'failed'}` }
      }
      // Hue v1 answers 200 with [{error: …}] for a refused change (bad user,
      // light unreachable): that is a failure, not a success.
      const out = (await res.json().catch(() => null)) as { error?: { description?: string } }[] | null
      const err = Array.isArray(out) ? out.find((r) => r.error)?.error : undefined
      if (!res.ok || err) return { ok: false, reason: 'unavailable', error: `hue light ${id}: ${err?.description ?? res.status}` }
      return { ok: true }
    },
    // Scenes are bridge ids per group; nothing in the runtime uses them today.
    scene: async () => ({ ok: false, reason: 'unsupported', error: 'scenes are not wired for the room bridge' }),
    close() {
      for (const s of sockets.splice(0)) s()
    },
  }
}
