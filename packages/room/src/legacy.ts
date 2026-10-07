import { pool as defaultPool, type DevicePool } from './pool.ts'
import { DEADLINE_MS, type Room, type WriteResult } from './room.ts'
import type { DisplayId, RoomInfo } from './spec.ts'

/**
 * The room's CURRENT code (aixia-ab/aid-hackathon-room, from AI Sweden's lab),
 * in case the planned spec is not live on Tuesday. Per the spec page it runs on
 * an Intel NUC over HTTPS on port 8443 with a self-signed certificate, has no
 * tokens or slots, and exposes /api/devices/*. It has no lidar endpoint.
 *
 * Request bodies are taken from the room's real code, pinned as a submodule
 * at third_party/aid-hackathon-room (backend/src/app.js, devices/huebridge.js;
 * see DIFFERENCES.md). The backend passes light state straight to the Hue v1
 * API (`PUT /lights/:id/state`), so colour must be CIE xy, not hex, and scenes
 * are activated per group by scene id.
 */
export interface LegacyRoomOptions {
  base: string // e.g. https://<nuc-ip>:8443
  /** The device pool (#73): refused outside n:10–n:30. Tests pass their own. */
  pool?: DevicePool
}

function call(pool: DevicePool, base: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: Buffer }> {
  const url = new URL(path, base)
  return new Promise((resolve, reject) => {
    // The NUC uses a self-signed certificate on the room's private network.
    // Accepting it is scoped to this one client, never process-wide.
    // pool.request throws outside the window; inside a Promise executor that becomes the rejection.
    const req = pool.request(url, { method, rejectUnauthorized: false, headers: { 'Content-Type': 'application/json' } } as import('node:https').RequestOptions, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }))
    }, `legacy ${method} ${path}`)
    req.setTimeout(DEADLINE_MS.http, () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    if (body !== undefined) req.write(JSON.stringify(body))
    req.end()
  })
}

export function createLegacyRoom(o: LegacyRoomOptions): Room {
  const pool = o.pool ?? defaultPool
  const write = async (method: string, path: string, body?: unknown): Promise<WriteResult> => {
    try {
      const r = await call(pool, o.base, method, path, body)
      return r.status < 300 ? { ok: true } : { ok: false, reason: 'unavailable', error: `${path}: ${r.status}` }
    } catch (e) {
      return { ok: false, reason: 'unavailable', error: e instanceof Error ? e.message : 'failed' }
    }
  }
  // Scenes are addressed by group + id in the backend; we take a name and
  // look it up once (GET /api/devices/hue/scenes lists { id, name, group }).
  let scenes: { id: string; name?: string; group?: string }[] | null = null
  return {
    kind: 'legacy',
    async info(): Promise<RoomInfo> {
      const r = await call(pool, o.base, 'GET', '/api/devices/status')
      const status = JSON.parse(r.body.toString() || '{}') as Record<string, unknown>
      // The legacy API knows nothing of resolutions or lidar pose. Report
      // none rather than invent them: callers must measure (calibration).
      return { displays: [], lights: [], lidar: { x: Number.NaN, y: Number.NaN, rotation: Number.NaN }, status }
    },
    slots: async () => [],
    events: () => () => undefined,
    lidar: () => null,
    async cameraFrame() {
      await call(pool, o.base, 'POST', '/api/devices/camera/snapshot')
      const r = await call(pool, o.base, 'GET', '/api/devices/camera/snapshot/latest')
      if (r.status >= 300 || r.body[0] !== 0xff || r.body[1] !== 0xd8) throw new Error(`legacy snapshot: ${r.status}, not a JPEG`)
      return new Uint8Array(r.body)
    },
    cameraStreamUrl: () => null,
    // The spec page says the current code plays *videos* on the projector and
    // screens; it has no web-page or image display. Pointing a video player at
    // our page URL would "succeed" and show nothing, so this is unsupported
    // until the organisers give us a kiosk browser on the Pis (review #11).
    show: async (_display: DisplayId) => ({ ok: false, reason: 'unsupported', error: 'the legacy room API cannot show web pages' }),
    draw: async () => ({ ok: false, reason: 'unsupported', error: 'legacy room has no draw socket' }),
    light(id, cmd) {
      const body: Record<string, unknown> = {}
      if (cmd.on !== undefined) body.on = cmd.on
      if (cmd.bri !== undefined) body.bri = Math.max(1, Math.min(254, Math.round(cmd.bri)))
      if (cmd.color) body.xy = hexToXy(cmd.color)
      return write('POST', `/api/devices/hue/lights/${encodeURIComponent(id)}/state`, body)
    },
    async scene(name) {
      if (!scenes) {
        try {
          scenes = JSON.parse((await call(pool, o.base, 'GET', '/api/devices/hue/scenes')).body.toString() || '[]')
        } catch {
          scenes = []
        }
      }
      const sc = scenes!.find((x) => x.name === name || x.id === name)
      if (!sc) return { ok: false, reason: 'unsupported', error: `no Hue scene named ${name}` }
      return write('POST', `/api/devices/hue/groups/${encodeURIComponent(sc.group ?? '0')}/scene`, { sceneId: sc.id })
    },
    close: () => undefined,
  }
}

/**
 * sRGB hex → Hue CIE xy (Philips' published conversion: gamma-expand, wide-gamut
 * D65 matrix, normalise). The Hue v1 API takes colour only as xy or hue/sat.
 */
export function hexToXy(hex: string): [number, number] {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92))
  const [r, g, b] = c
  const X = r * 0.664511 + g * 0.154324 + b * 0.162028
  const Y = r * 0.283881 + g * 0.668433 + b * 0.047685
  const Z = r * 0.000088 + g * 0.07231 + b * 0.986039
  const sum = X + Y + Z
  return sum === 0 ? [0.3227, 0.329] : [+(X / sum).toFixed(4), +(Y / sum).toFixed(4)]
}
