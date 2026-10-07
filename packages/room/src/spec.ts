/**
 * The organisers' room API, as written in their spec (Draft 0.1, 2 Oct 2026,
 * https://aid-hackathon.kube.aixia.se/). The spec calls itself "a planned
 * framework, not a finished API", so this is the ONLY file that should change
 * when the live room turns out different: every deviation found on site is
 * fixed here and logged in DIFFERENCES.md with its recorded evidence.
 */

export type DisplayId = 'table' | 'tv-1' | 'tv-2'

/** `GET /api/room`. Field names beyond the spec's prose are our best guess, marked. */
export interface RoomInfo {
  displays: { id: DisplayId; width: number; height: number }[]
  lights: { id: string; kind?: 'spot' | 'strip' }[]
  /**
   * Where the lidar sits on the table and where its 0° points. The spec says
   * "its table position and 0° direction are measured on site and listed in
   * GET /api/room" without a shape. Assumed: millimetres from the table's
   * top-left corner (seen from above, user at the bottom edge), and the
   * direction of 0° in degrees clockwise from the +x axis.
   */
  lidar: { x: number; y: number; rotation: number; mirrored?: boolean }
  table?: { width: number; height: number }
  slot?: { team: string; until: string } | null
  status?: Record<string, unknown>
}

export interface SlotInfo {
  team: string
  from: string
  until: string
}

/** One lidar rotation, straight from the RPLIDAR C1. */
export interface LidarScan {
  /** Epoch ms. */
  t: number
  points: { angle: number; distance: number; quality: number }[]
}

/**
 * Measured on 2026-10-07; organiser source d4d9c4c serves each Pi directly.
 * Keep the gateway paths below for the emulator. Replacing PATHS.lidar would
 * silently break that transport while pretending the other live APIs worked.
 */
export const LIDAR_PI_PATHS = { scan: '/scan', status: '/status' } as const
export const MAX_LIDAR_BYTES = 1024 * 1024
export const MAX_LIDAR_POINTS = 8192

/** Wire validity only: >12 m and quality=0 both occur in the real recording.
 * Optical usability belongs to calibrated evidence processing, not decoding. */
export function parseLidarScan(raw: string): LidarScan | null {
  if (Buffer.byteLength(raw) > MAX_LIDAR_BYTES) return null
  let v: unknown
  try { v = JSON.parse(raw) } catch { return null }
  if (!v || typeof v !== 'object') return null
  const s = v as Partial<LidarScan>
  if (typeof s.t !== 'number' || !Number.isFinite(s.t) || s.t < 0 || !Array.isArray(s.points) || s.points.length > MAX_LIDAR_POINTS) return null
  for (const p of s.points) {
    if (!p || typeof p !== 'object' || !Number.isFinite(p.angle) || p.angle < 0 || p.angle >= 360
      || !Number.isFinite(p.distance) || p.distance < 0 || !Number.isInteger(p.quality) || p.quality < 0 || p.quality > 63) return null
  }
  return s as LidarScan
}

export type RoomEvent =
  | { type: 'button'; id: string; action: 'press' | string }
  | { type: 'slot'; team: string; until: string }

/**
 * `idle` (the room's rest picture) comes from the organisers' own spec in
 * their repo (third_party/aid-hackathon-room/docs/aid-2026/SPEC.md §4.2, 5),
 * which is newer than the public page.
 */
export type DisplayCommand = { type: 'url'; url: string } | { type: 'image'; url?: string; data?: string } | { type: 'blank' } | { type: 'idle' }

export interface DrawShapeCircle {
  shape: 'circle'
  x: number
  y: number
  r: number
  fill?: string
  stroke?: string
  width?: number
}
export interface DrawShapeRect {
  shape: 'rect'
  x: number
  y: number
  w: number
  h: number
  fill?: string
  stroke?: string
  width?: number
}
export interface DrawShapeLine {
  shape: 'line'
  x1: number
  y1: number
  x2: number
  y2: number
  stroke?: string
  width?: number
}
export interface DrawShapeText {
  shape: 'text'
  x: number
  y: number
  text: string
  size?: number
  fill?: string
}
/** `WS /api/displays/:id/draw`: one message per frame, coordinates 0–1, origin top-left. */
export interface DrawFrame {
  clear?: boolean
  shapes: (DrawShapeCircle | DrawShapeRect | DrawShapeLine | DrawShapeText)[]
}

/** `POST /api/lights/:id`. */
export interface LightCommand {
  on?: boolean
  bri?: number
  color?: string
}

/** Body of a 423 Locked answer to a write outside our slot. */
export interface LockedBody {
  error: string
  next_slot?: SlotInfo | null
}

export const PATHS = {
  room: '/api/room',
  slots: '/api/slots',
  openapi: '/api/openapi.json',
  lidar: '/api/lidar/scan',
  cameraStream: '/api/camera/stream',
  cameraFrame: '/api/camera/frame',
  events: '/api/events',
  display: (id: DisplayId) => `/api/displays/${id}`,
  draw: (id: DisplayId) => `/api/displays/${id}/draw`,
  light: (id: string) => `/api/lights/${encodeURIComponent(id)}`,
  scene: '/api/lights/scene',
} as const

/**
 * The room as it is configured today (organisers' repo 995f275, pinned at
 * third_party/aid-hackathon-room; SPEC.md §1, display/README.md,
 * ROOM-SETUP.md), checked on site 7 Oct 2026.
 *
 * Everything above this point is the Draft 0.1 gateway (`room.local`, team
 * tokens, slots in code), which the organisers dropped on 5 Oct: "Ingen
 * central server". Our emulator still speaks it and its tests guard the
 * runtime, so it stays; the real room is reached through these instead
 * (pis.ts). Each Pi serves its own device, and the lights are the Hue
 * bridge's own API.
 *
 * Addresses, not `<name>.local`: they are DHCP reservations on the room's
 * router (ROOM-SETUP.md), and mDNS lookups on the laptop added seconds on
 * this wifi. Every one can be overridden by env (apps/server/index.ts).
 */
export const PI_ROOM = {
  table: 'http://192.168.42.21', // pi-projector: the projector's HDMI and the BRIO
  'tv-1': 'http://192.168.42.22',
  'tv-2': 'http://192.168.42.23',
  lidar: 'ws://192.168.42.24', // pi-lidar
  hue: 'http://192.168.42.11', // the bridge, on cable
} as const

export const PI_PATHS = { show: '/show', status: '/status', cameraFrame: '/camera/frame', cameraStream: '/camera/stream' } as const

/**
 * Hue light names (ROOM-SETUP.md, "Hue") → the bridge's v1 light numbers.
 * The names are the ones the runtime's moods use; the numbers are the
 * bridge's own and only change if the lights are re-added.
 */
export const HUE_LIGHT_IDS: Record<string, string> = {
  'strip-tv-1': '1',
  'spot-1': '2',
  'spot-2': '3',
  'spot-3': '4',
  'spot-4': '5',
  'spot-5': '6',
  'spot-6': '7',
  'strip-tv-2': '8',
}

/**
 * `GET /status` on a display Pi, as recorded 7 Oct (packages/room/fixtures/
 * pis/*.json). `screen` is what the kiosk really draws at: 1920×1200 on the
 * projector, 1920×1080 on the TVs.
 */
export interface PiStatus {
  host: string
  mode: string
  url: string | null
  kiosk_connected: boolean
  screen: [number, number]
}
