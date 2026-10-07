import type WebSocket from 'ws'
import { pool as defaultPool, type DevicePool } from './pool.ts'
import { DEADLINE_MS, type Room, type WriteResult } from './room.ts'
import { PATHS, type DisplayId, type LidarScan, type LockedBody, type RoomEvent, type RoomInfo, type SlotInfo } from './spec.ts'
import { keepAlive } from './socket.ts'

/**
 * The room as the organisers' spec describes it (also what our emulator
 * serves, which is how this client is tested before the room exists).
 *
 * Auth: `Authorization: Bearer <team token>` on HTTP, `?token=` on WebSockets
 * and on the MJPEG URL, per the spec.
 */
export interface LiveRoomOptions {
  base: string
  token: string
  kind?: 'live' | 'emulator'
  /** Where our own server proxies the camera stream for browsers (token stays here). */
  proxiedStreamUrl?: string
  /**
   * Every connection goes through the device pool (#73): refused outside
   * n:10–n:30 for the real room, always allowed for the emulator on
   * loopback. Tests pass their own pool; production uses the process's one.
   */
  pool?: DevicePool
}

export function createLiveRoom(o: LiveRoomOptions): Room {
  const base = o.base.replace(/\/$/, '')
  const wsBase = base.replace(/^http/, 'ws')
  const auth = { Authorization: `Bearer ${o.token}` }
  const sockets: (() => void)[] = []
  const drawSockets = new Map<DisplayId, WebSocket>()
  const pool = o.pool ?? defaultPool

  const get = async <T>(path: string): Promise<T> => {
    const res = await pool.fetch(`${base}${path}`, { headers: auth, signal: AbortSignal.timeout(DEADLINE_MS.http) }, `room ${path}`)
    if (!res.ok) throw new Error(`GET ${path}: ${res.status}`)
    return (await res.json()) as T
  }
  const write = async (path: string, body: unknown): Promise<WriteResult> => {
    let res: Response
    try {
      res = await pool.fetch(`${base}${path}`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(DEADLINE_MS.http),
      }, `room write ${path}`)
    } catch (e) {
      return { ok: false, reason: 'unavailable', error: `POST ${path}: ${e instanceof Error ? e.name : 'failed'}` }
    }
    if (res.ok) return { ok: true }
    if (res.status === 423) {
      // Outside our slot. Expected all day long for a shared room; the
      // writer keeps the desired state and applies it in our next slot.
      const b = (await res.json().catch(() => ({}))) as LockedBody
      return { ok: false, reason: 'locked', nextSlot: b.next_slot ?? null }
    }
    if (res.status === 429) {
      // The Hue bridge (behind the room) is rate limited; honour its hint.
      const after = Number(res.headers.get('retry-after'))
      return { ok: false, reason: 'rate-limited', retryAfterMs: Number.isFinite(after) && after > 0 ? after * 1000 : 1500 }
    }
    return { ok: false, reason: 'unavailable', error: `POST ${path}: ${res.status}` }
  }
  const subscribe = (path: string, onMessage: (data: string) => void) => {
    const stop = keepAlive(`${wsBase}${path}?token=${encodeURIComponent(o.token)}`, onMessage, { pool, owner: `room ${path}` })
    sockets.push(stop)
    return stop
  }

  return {
    kind: o.kind ?? 'live',
    info: () => get<RoomInfo>(PATHS.room),
    slots: () => get<SlotInfo[]>(PATHS.slots),
    events(onEvent) {
      return subscribe(PATHS.events, (d) => {
        try {
          onEvent(JSON.parse(d) as RoomEvent)
        } catch {
          /* a malformed event is skipped, never fatal */
        }
      })
    },
    lidar(onScan) {
      return subscribe(PATHS.lidar, (d) => {
        try {
          onScan(JSON.parse(d) as LidarScan)
        } catch {
          /* skip a corrupt rotation; the next one is 100 ms away */
        }
      })
    },
    async cameraFrame() {
      const res = await pool.fetch(`${base}${PATHS.cameraFrame}`, { headers: auth, signal: AbortSignal.timeout(DEADLINE_MS.camera) }, 'camera frame')
      if (!res.ok) throw new Error(`camera frame: ${res.status}`)
      return new Uint8Array(await res.arrayBuffer())
    },
    cameraStreamUrl: () => o.proxiedStreamUrl ?? null,
    show: (display, cmd) => write(PATHS.display(display), cmd),
    async draw(display, frame) {
      // One socket per display, opened on first use: drawing is per-frame
      // and an HTTP round trip each frame would cap it at a few fps.
      let ws = drawSockets.get(display)
      if (!ws || ws.readyState > 1) {
        // Outside the window the pool throws here; draw() reports that as unavailable, like any dead socket.
        try {
          ws = pool.webSocket(`${wsBase}${PATHS.draw(display)}?token=${encodeURIComponent(o.token)}`, undefined, `draw ${display}`)
        } catch (e) {
          return { ok: false, reason: 'unavailable', error: e instanceof Error ? e.message : 'draw socket refused' }
        }
        drawSockets.set(display, ws)
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, DEADLINE_MS.connect)
          ws!.once('open', () => (clearTimeout(t), resolve()))
          ws!.once('error', () => (clearTimeout(t), resolve()))
        })
      }
      if (ws.readyState !== 1) return { ok: false, reason: 'unavailable', error: `draw socket for ${display} not open` }
      ws.send(JSON.stringify(frame))
      return { ok: true }
    },
    light: (id, cmd) => write(PATHS.light(id), cmd),
    scene: (name) => write(PATHS.scene, { scene: name }),
    close() {
      sockets.forEach((s) => s())
      drawSockets.forEach((ws) => ws.close())
    },
  }
}
