import type { OverlayLine } from '@hubble/stage'
import { DEFAULT_SURFACE } from '@hubble/stage'
import { decode, WINDOW_LABEL, type HardwareWindow } from '@hubble/room'
import { createMarkerDetector, markerBits } from '../../shared/markers/detect.ts'
import { markerShapes, projectedMarkers, REFERENCE_LAYER, REFERENCE_REFRESH_MS } from '../../shared/markers/layout.ts'
import type { SpatialService } from './service.ts'

/**
 * A reference run (#91): the "reference points" button. Projects the marker
 * grid on /table for a few seconds, and while it is up:
 * - the room camera's frames are fetched and their markers detected HERE
 *   (the server already fetches room frames; nothing new crosses the Wi-Fi
 *   but the frames themselves);
 * - the iPad page, if running, sees the same markers and posts its own;
 * - the localizer learns the printed markers' anchors from both.
 * Then the overlay is cleared, whatever happened.
 *
 * Its own module, not more lines in runtime.ts, because its invariants are
 * the risky part: the overlay never outlives the run (a stuck marker grid on
 * a shared projector), one run at a time (two runs would interleave their
 * clear()s), and a run never starts unarmed on the real room.
 *
 * And (Codex review of #95, findings 2 and 3) a run lives only inside the
 * hardware window and only while armed. Projecting goes to the room's
 * projector through the /table page its Pi loads FROM us, so no device
 * connection is opened and the device pool never sees it: the pool's window
 * rule can't stop it, so this module applies the same rule itself, reading
 * the window from the pool (window.ts, the one owner of the minutes), never
 * its own minutes. A run is refused when the window is shut, ends at the
 * window's close at the latest, and ends the moment output is disarmed.
 */

// Long enough for several room-camera stills at today's 1–3 s each after the
// settle, plus the iPad's ~2 Hz detections; short enough that the markers
// covering the table are a blink in a demo.
const DURATION_MS = 12_000

export interface ReferenceDeps {
  overlay(line: OverlayLine): void
  spatial: Pick<SpatialService, 'markers' | 'setProjecting'>
  /** The room camera's newest full frame as JPEG; null when there is no room camera. */
  frame: (() => Promise<Uint8Array>) | null
  /** Whether a projector write is allowed now (the room output is armed, or no real room). */
  mayProject(): boolean
  /**
   * The hardware window, from the device pool (pool.window()), on the real
   * room. Absent = no real room (emulator, tests): allowed at any time.
   */
  window?: () => HardwareWindow
  now?: () => number
  settleMs?: number
  durationMs?: number
  log?: (line: string) => void
}

export interface ReferenceState {
  on: boolean
  startedAt: number | null
  frames: number
  lastError: string | null
}

export function createReferenceRun(d: ReferenceDeps) {
  const bits = markerBits()
  const detector = createMarkerDetector()
  const shapes = markerShapes(projectedMarkers(DEFAULT_SURFACE), bits)
  let state: ReferenceState = { on: false, startedAt: null, frames: 0, lastError: null }
  let timer: ReturnType<typeof setTimeout> | null = null
  let refresher: ReturnType<typeof setInterval> | null = null
  const now = d.now ?? (() => Date.now())
  // Bumped per run, so a frame loop from an earlier run that is still
  // awaiting the camera can see it's stale and post nothing.
  let run = 0
  const session = `room-reference-${Date.now()}`
  let seq = 0

  const stop = () => {
    if (timer) clearTimeout(timer)
    timer = null
    if (refresher) clearInterval(refresher)
    refresher = null
    run++
    // Clear unconditionally, even if we think nothing is drawn: a server
    // restart mid-run leaves the hub's replay empty, but a display that
    // missed a clear is fixed by sending one more.
    d.overlay({ kind: 'overlay', layer: REFERENCE_LAYER, shapes: [] })
    if (state.on) d.spatial.setProjecting(false)
    state = { ...state, on: false }
  }

  async function grabLoop(mine: number, record?: (name: string, jpeg: Uint8Array) => void) {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
    // The kiosk needs to paint the grid and the camera to deliver a frame
    // with it, as for the dot calibration.
    await wait(d.settleMs ?? 1500)
    while (mine === run && d.frame) {
      // A real yield between frames. A camera that answers instantly (a
      // cached still, a test) would otherwise keep this loop in microtasks
      // forever: the stop timer, HTTP and every other macrotask starve.
      await wait(50)
      if (mine !== run) return
      // The window or the arm can end between two frames: no frame fetch
      // after that (the fetch itself is the pool's, which would refuse it
      // anyway; this ends the run instead of looping on refusals).
      if (refusal()) return void stop()
      try {
        const jpeg = await d.frame()
        if (mine !== run) return
        record?.(`reference-${state.frames}`, jpeg)
        const grey = decode(jpeg)
        const markers = detector.detect(grey)
        state = { ...state, frames: state.frames + 1 }
        d.spatial.markers({ source: 'room', session, seq: ++seq, geometry: 'room:full-frame', width: grey.width, height: grey.height, markers })
        d.log?.(`room camera: ${markers.length} markers (${markers.map((m) => m.id).join(',')})`)
      } catch (e) {
        state = { ...state, lastError: `camera: ${e instanceof Error ? e.message : String(e)}` }
        await wait(500)
      }
    }
  }

  /** Why a run may not be on right now, or null. Checked at start and on every refresh. */
  const refusal = (): string | null => {
    if (!d.mayProject()) return 'arm the room output first: projecting markers is a projector write'
    const w = d.window?.()
    if (w && !w.open) return `the hardware window is shut (${WINDOW_LABEL} Stockholm; next opens ${new Date(w.opensAt).toISOString()})`
    return null
  }

  return {
    /** Start a run. Refused (not thrown) when projecting isn't allowed or one is running. */
    start(opts: { record?: (name: string, jpeg: Uint8Array) => void } = {}): { ok: boolean; error?: string; state: ReferenceState } {
      if (state.on) return { ok: false, error: 'a reference run is already on the table', state }
      const why = refusal()
      if (why) return { ok: false, error: why, state }
      const mine = ++run
      state = { on: true, startedAt: now(), frames: 0, lastError: null }
      d.spatial.setProjecting(true)
      d.overlay({ kind: 'overlay', layer: REFERENCE_LAYER, shapes })
      // The run ends at its duration or the window's close, whichever is
      // first: a run started at n:29:55 must be off the table by n:30.
      const w = d.window?.()
      const until = Math.min(d.durationMs ?? DURATION_MS, w ? Math.max(0, w.closesAt - now()) : Number.POSITIVE_INFINITY)
      timer = setTimeout(stop, until)
      timer.unref?.()
      // The refresh is the display's lease (layout.ts REFERENCE_TTL_MS),
      // and also where a disarm or a window close that nobody told us
      // about (a slot ending, a clock edge the timer rounded) ends the run.
      refresher = setInterval(() => {
        if (mine !== run) return
        if (refusal()) return stop()
        d.overlay({ kind: 'overlay', layer: REFERENCE_LAYER, shapes })
      }, REFERENCE_REFRESH_MS)
      refresher.unref?.()
      if (d.frame) void grabLoop(mine, opts.record)
      return { ok: true, state }
    },
    stop() {
      stop()
      return state
    },
    /**
     * End a run if one is on; do nothing otherwise. For disarm and the
     * runtime's stop(): unlike stop(), it sends no clear when no run is on,
     * because disarming means "leave the room alone" and an idle clear would
     * be one more write to a display that isn't ours at that moment.
     */
    end() {
      if (state.on) stop()
      return state
    },
    state: () => ({ ...state }),
  }
}
