import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { keepAlive } from './socket.ts'
import type { DevicePool } from './pool.ts'
import { LIDAR_PI_PATHS, MAX_LIDAR_BYTES, parseLidarScan, type LidarScan } from './spec.ts'

export interface LidarFrame {
  sourceSession: string
  seq: number
  sourceTimeMs: number
  receivedAtMonoMs: number
  points: LidarScan['points']
  /** One-way receipt cannot prove acquisition age: spatial fusion must bound it. */
  acquisitionAgeMs: null
}
export interface LidarSourceHealth {
  state: 'stopped' | 'disconnected' | 'awaiting-scan' | 'receiving' | 'stale'
  sourceSession: string | null
  accepted: number
  malformed: number
  nonProgressing: number
  lastFrameAtMonoMs: number | null
  lastSourceTimeMs: number | null
}

/**
 * Pure transport accounting, shared by the socket and recorded replay. "Receiving"
 * deliberately means recent progressing delivery, not touch-ready: the real Pi
 * recording contains a delayed burst and its wall clock differs from ours. A
 * calibration/fusion consumer still needs an acquisition-time uncertainty bound.
 *
 * A new socket invalidates old source time even if the Pi has not rebooted. This
 * makes reconnect a cancellation boundary instead of stitching two finger paths.
 */
export function createLidarStream(opts: { now: () => number; staleMs?: number; onFrame: (frame: LidarFrame) => void }) {
  const staleMs = opts.staleMs ?? 350
  if (!Number.isFinite(staleMs) || staleMs <= 0) throw new Error('staleMs must be positive')
  let connected = false
  let stopped = false
  let seq = 0
  const health: LidarSourceHealth = { state: 'disconnected', sourceSession: null, accepted: 0, malformed: 0, nonProgressing: 0, lastFrameAtMonoMs: null, lastSourceTimeMs: null }
  const snapshot = (): LidarSourceHealth => ({ ...health, state: stopped ? 'stopped' : !connected ? 'disconnected'
    : health.lastFrameAtMonoMs === null ? 'awaiting-scan'
    : opts.now() - health.lastFrameAtMonoMs >= staleMs ? 'stale' : 'receiving' })
  return {
    snapshot,
    connected(session: string) {
      if (stopped) return
      connected = true
      health.sourceSession = session
      health.lastFrameAtMonoMs = null
      health.lastSourceTimeMs = null
      seq = 0
    },
    disconnected() { connected = false },
    stop() { stopped = true; connected = false },
    receive(raw: string) {
      if (!connected || stopped) return
      const scan = parseLidarScan(raw)
      if (!scan) { health.malformed++; return }
      // Network activity is not sensor progress. Repeated or backwards times
      // neither refresh the deadline nor enter fusion as extra confirmations.
      if (health.lastSourceTimeMs !== null && scan.t <= health.lastSourceTimeMs) { health.nonProgressing++; return }
      health.lastSourceTimeMs = scan.t
      health.lastFrameAtMonoMs = opts.now()
      health.accepted++
      opts.onFrame({ sourceSession: health.sourceSession!, seq: ++seq, sourceTimeMs: scan.t,
        receivedAtMonoMs: health.lastFrameAtMonoMs, points: scan.points, acquisitionAgeMs: null })
    },
  }
}

export function lidarScanUrl(base: string): string {
  const url = new URL(base)
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) throw new Error('lidar URL must use HTTP or WebSocket')
  url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss:' : 'ws:'
  // A host URL selects the recorded per-Pi contract. An explicit path also
  // supports the old emulator without a second implementation or auto-probing.
  if (url.pathname === '/') url.pathname = LIDAR_PI_PATHS.scan
  url.hash = ''
  return url.toString()
}

/** Read-only; starting this source can never show a page, take a slot or set Hue. */
export function createLidarSource(opts: {
  url: string
  onFrame: (frame: LidarFrame) => void
  onHealth?: (health: LidarSourceHealth) => void
  staleMs?: number
  now?: () => number
  /** The device pool (#73): the scan socket only n:10–n:30, closed at :30. Tests pass their own. */
  pool?: DevicePool
}) {
  const url = lidarScanUrl(opts.url)
  const stream = createLidarStream({ ...opts, now: opts.now ?? (() => performance.now()) })
  let closed = false
  let lastReported = ''
  const report = () => {
    const h = stream.snapshot()
    // Report transitions and counters, without a timer emitting identical idle
    // states forever. The timer matters: silence has no message callback.
    const key = JSON.stringify(h)
    if (key !== lastReported) { lastReported = key; opts.onHealth?.(h) }
  }
  const stopSocket = keepAlive(url, (raw) => { if (!closed) { stream.receive(raw); report() } }, {
    pool: opts.pool,
    owner: 'lidar scan',
    maxPayload: MAX_LIDAR_BYTES,
    onHealth(h) {
      if (closed) return
      if (h.connected) stream.connected(randomUUID())
      else stream.disconnected()
      report()
    },
  })
  const timer = setInterval(report, 50)
  report()
  return {
    snapshot: stream.snapshot,
    stop() {
      if (closed) return
      closed = true
      clearInterval(timer)
      stopSocket()
      stream.stop()
      report()
    },
  }
}
