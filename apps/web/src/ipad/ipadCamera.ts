import type { HandObservation, MarkerObservationT } from '../../../server/spatial/observations.ts'
import type { Hand } from '../hands/types.ts'
import type { Marker } from '../../../shared/markers/layout.ts'

/**
 * The iPad as a camera (#91), the parts of /ipad-camera that aren't React:
 * what leaves the iPad, and how often.
 *
 * What leaves: hand landmarks (index tip plus the three pinch joints, as the
 * room camera's observations) and marker corners. Never frames. That is the
 * whole point of the iPad: the room camera is slow because its frames cross
 * a 5 GHz channel shared with the venue (ROOM-SETUP.md:148); the iPad runs
 * MediaPipe and the marker detector itself and sends ~100 bytes per frame.
 */

/**
 * The geometry string the iPad's camera map is keyed by. Its size is part
 * of it: the spatial service refuses an observation whose frame doesn't
 * match the map's, so a camera that switches resolution (Safari may hand
 * out 1920×1080 one day and 1280×720 the next) is re-localized rather than
 * read with a map measured on other pixels.
 */
export const ipadGeometry = (width: number, height: number) => `ipad:${width}x${height}`

export function observationFromHands(hands: Hand[], width: number, height: number, meta: { session: string; seq: number; capturedAt: number; input: HandObservation['input'] }): HandObservation {
  const point = (h: Hand, i: number) => ({ x: h.lm[i]![0], y: h.lm[i]![1] })
  return {
    source: 'ipad',
    session: meta.session,
    seq: meta.seq,
    capturedAt: meta.capturedAt,
    geometry: ipadGeometry(width, height),
    width,
    height,
    input: meta.input,
    // At most two hands: the schema's limit, and MediaPipe's numHands.
    hands: hands.slice(0, 2).map((h) => ({ index: point(h, 8), pinch: { thumb: point(h, 4), wrist: point(h, 0), middle: point(h, 9) } })),
  }
}

/** The localizer's per-source state, as POST /api/spatial/markers answers. */
export interface LocalizationReply {
  last: { ok: boolean; rms: number | null; markers: number[]; rejected: number[]; error: string | null } | null
  confirmed: number
  installs: number
}

/**
 * Marker frames out, at most one in flight and at most every `everyMs`.
 * Why throttled: a camera map changes when the iPad is moved, not 30 times a
 * second; detection costs tens of ms per frame on the iPad, which would come
 * straight out of the hand tracker's frame rate. Why one in flight: a slow
 * reply must not queue frames that arrive at the server stale and out of
 * order (the server refuses a non-increasing seq anyway).
 */
export function createMarkerSender(opts: { everyMs?: number; fetcher?: typeof fetch; now?: () => number; session?: string } = {}) {
  const every = opts.everyMs ?? 500
  const fetcher = opts.fetcher ?? fetch
  const now = opts.now ?? (() => performance.now())
  const session = opts.session ?? crypto.randomUUID()
  let last = Number.NEGATIVE_INFINITY
  let busy = false
  let seq = 0
  return {
    /** Whether a frame should be detected now. Ask before paying for detection. */
    due: () => !busy && now() - last >= every,
    async send(markers: Marker[], width: number, height: number): Promise<LocalizationReply | null> {
      if (busy) return null
      busy = true
      last = now()
      const body: MarkerObservationT = { source: 'ipad', session, seq: ++seq, geometry: ipadGeometry(width, height), width, height, markers: markers.slice(0, 32) }
      try {
        const r = await fetcher('/api/spatial/markers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(2000) })
        return r.ok ? ((await r.json()) as LocalizationReply) : null
      } catch {
        return null
      } finally {
        busy = false
      }
    },
  }
}

/**
 * Why the camera can't start, in words the person holding the iPad can act
 * on. iOS Safari hides navigator.mediaDevices entirely outside a secure
 * context, so "undefined is not an object" is what they'd see otherwise.
 */
export function cameraBlocker(loc: { protocol: string; hostname: string; host: string }, secure: boolean, hasMedia: boolean): string | null {
  if (secure && hasMedia) return null
  if (!secure) return `The camera needs https. Open https://${loc.host}/ipad-camera instead (first time: install the certificate from http://${loc.host}/hubble-ca.crt, see the README).`
  return 'This browser has no camera API here (is this Safari? Settings → Safari → Camera must allow it).'
}

/**
 * Start the iPad's camera session; returns its stop. Its own function, not
 * the body of a React effect, because of two leaks the effect had (Codex
 * review of #95, findings 5 and 6):
 *
 * 5. Stopping the camera left pinch mode on. The grant stays with the
 *    server's keyboard input until released, so with no camera feeding it,
 *    the room camera's pinches (or nobody's) kept typing under the iPad's
 *    grant. stop() always calls `released()`, which returns to pointer mode.
 * 6. A stop DURING startup leaked: the effect's cleanup ran while
 *    getUserMedia (or the landmarker) was still pending, saw nothing to
 *    stop, and the stream arrived afterwards: the camera light stayed on and
 *    MediaPipe kept its GPU memory. Here every resource that arrives after
 *    stop() is disposed on arrival.
 *
 * Generic over the resources so tests drive it with delayed fakes; the page
 * passes getUserMedia, video.play, createLandmarker and its frame loop.
 */
export function startCamera<S extends { getTracks(): { stop(): void }[] }, L extends { close(): void }>(d: {
  wake(): Promise<{ release(): Promise<void> } | null>
  stream(): Promise<S>
  play(stream: S): Promise<void>
  landmarker(): Promise<L>
  /** Start the per-frame loop; returns its cancel. */
  run(lm: L): () => void
  /** Stop happened: give the keyboard input back (pointer mode). */
  released(): void
  status?(text: string): void
  error(e: unknown): void
}): () => void {
  let stopped = false
  let stream: S | null = null
  let lm: L | null = null
  let wake: { release(): Promise<void> } | null = null
  let cancel: (() => void) | null = null
  const stopTracks = (s: S) => { for (const t of s.getTracks()) t.stop() }
  void (async () => {
    try {
      // A screen that dims and locks stops the camera. Wake Lock is in
      // Safari since 16.4; older iPads need Auto-Lock off (README).
      const w = await d.wake().catch(() => null)
      if (stopped) return void w?.release().catch(() => undefined)
      wake = w
      const s = await d.stream()
      if (stopped) return stopTracks(s)
      stream = s
      await d.play(s)
      if (stopped) return
      d.status?.('loading the hand tracker…')
      const l = await d.landmarker()
      if (stopped) return l.close()
      lm = l
      cancel = d.run(l)
    } catch (e) {
      if (!stopped) d.error(e)
    }
  })()
  return () => {
    if (stopped) return
    stopped = true
    cancel?.()
    lm?.close()
    if (stream) stopTracks(stream)
    void wake?.release().catch(() => undefined)
    d.released()
  }
}
