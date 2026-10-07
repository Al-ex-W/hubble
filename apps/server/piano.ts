import jpeg from 'jpeg-js'
import type { PianoSnapshot, PianoState } from '../shared/piano.ts'
import type { KeybedTrack } from './keybed.ts'

/** Only runtime.ts consumes this owner. A preview is an observation, not a
 * live camera URL beside some unrelated polygons: frame and geometry must
 * commit together after the runtime's generation check. This also keeps
 * camera JPEGs out of the cheap general status endpoint. */
export function createPianoDetection(now: () => number) {
  let enabled = false
  let snapshot: PianoSnapshot | null = null
  let status: PianoState['status'] = 'off'
  let measuredAt: number | null = null
  let sequence = 0
  return {
    enabled: () => enabled,
    setEnabled(value: boolean) {
      if (value === enabled) return false
      enabled = value
      snapshot = null
      measuredAt = null
      status = value ? 'searching' : 'off'
      return true
    },
    accept(frame: Uint8Array, track: KeybedTrack | null, capturedAt: number) {
      // Lost returns the previous pose. Never turn those retained corners
      // into a fresh measurement merely because there are still 25 keys.
      const fresh = !!track?.keys && ['locked', 'tracked', 'refined', 'moved', 'occluded', 'detected'].includes(track.status)
      status = !track ? 'detector-unavailable' : fresh ? 'tracking' : track.keys ? 'last-known' : 'searching'
      const { width, height } = jpeg.decode(frame, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 16 })
      if (fresh) measuredAt = capturedAt
      snapshot = {
        id: ++sequence, capturedAt, width, height,
        image: `data:image/jpeg;base64,${Buffer.from(frame).toString('base64')}`,
        keys: track?.keys ?? [], keybed: track?.keybed ?? null, trackerStatus: track?.status ?? null,
      }
      return fresh
    },
    cameraFailed() { status = 'camera-unavailable' },
    state(available: boolean, calibrated: boolean): PianoState {
      // A stalled loop is also stale even if its last request succeeded.
      // Eight seconds allows one 5 s room deadline plus the 2 s interval.
      const current = status === 'tracking' && snapshot && now() - snapshot.capturedAt > 8000 ? 'last-known' : status
      return { enabled, available, calibrated, status: !enabled ? 'off' : !available ? 'no-camera' : current,
        ageMs: measuredAt === null ? null : Math.max(0, now() - measuredAt), snapshot }
    },
  }
}
