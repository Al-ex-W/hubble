import type { DisplayCommand, DisplayId, DrawFrame, LidarScan, LightCommand, RoomEvent, RoomInfo, SlotInfo } from './spec.ts'

/**
 * The one interface the rest of Hubble uses to reach the room. Live, legacy,
 * emulated and replayed rooms all implement it, so the runtime, the sensor
 * fusion and the calibration code never know which one they are talking to,
 * and switching to the real room on site is a configuration change.
 */
export interface Room {
  readonly kind: 'live' | 'legacy' | 'emulator' | 'replay'
  info(): Promise<RoomInfo>
  slots(): Promise<SlotInfo[]>
  /** Subscribe; returns an unsubscribe. Reconnects on its own. */
  events(onEvent: (e: RoomEvent) => void): () => void
  /** Null for transports without a lidar (the legacy NUC API has none). */
  lidar(onScan: (s: LidarScan) => void): (() => void) | null
  cameraFrame(): Promise<Uint8Array>
  /** A URL a browser on our machine can open for MJPEG (proxied: the token stays server-side). */
  cameraStreamUrl(): string | null
  show(display: DisplayId, cmd: DisplayCommand): Promise<WriteResult>
  draw(display: DisplayId, frame: DrawFrame): Promise<WriteResult>
  light(id: string, cmd: LightCommand): Promise<WriteResult>
  scene(name: string): Promise<WriteResult>
  close(): void
}

/**
 * Every way a write can end. Being refused outside our slot or being rate
 * limited are normal in a shared room, not errors; and a transport that
 * cannot do something says so instead of pretending it worked (review: the
 * legacy fallback "succeeded" at showing pages it cannot show).
 */
export type WriteResult =
  | { ok: true }
  | { ok: false; reason: 'locked'; nextSlot: SlotInfo | null }
  | { ok: false; reason: 'rate-limited'; retryAfterMs: number }
  | { ok: false; reason: 'unavailable'; error: string }
  | { ok: false; reason: 'unsupported'; error: string }

/** Deadlines for every call, so a dead device can never stall the runtime. */
export const DEADLINE_MS = { http: 3000, camera: 5000, connect: 3000 } as const
