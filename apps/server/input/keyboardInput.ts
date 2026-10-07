import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { OverlayLine, OverlayShape } from '@hubble/stage'
import { keyboardMmFromTable, tableFromKeyboardMm, SWIPE_KEYBOARD_MM } from '@hubble/stage/swipe'
import { DEFAULTS, GestureMachine } from '../../shared/hands/gestures.ts'
import { regionAt } from '../../shared/hands/keyboardRegion.ts'
import type { SpatialService } from '../spatial/service.ts'
import { hitSpatialSurface, type SpatialFrame } from '../spatial/frame.ts'
import type { HandObservation } from '../spatial/observations.ts'
import { KEYBOARD_ID } from '../surfaces.ts'
import type { SwipeKeyboardOwner } from '../swipeKeyboard.ts'

/** One input owner above the draft reducer. Localization decides where; the
 * recorded gesture machine decides when; SwipeKeyboard decides what was typed.
 * No lidar evidence is consumed here: a pinch is deliberate camera input, not
 * a claim of contact. Keeping that distinction allows contact to become another
 * explicitly selected policy once paired recordings establish its semantics.
 *
 * That policy is `room-lidar` (the lidar-touch plan's T7, built in
 * docs/plans/2026-10-07-lidar-web.md Ruling 7): selected explicitly, never the
 * default, because the lidar plane sits 3–7 cm above the table and hover vs.
 * contact is unmeasured. This module only owns the SELECTION (one source owns
 * the keyboard at a time); the strokes themselves come from
 * input/lidarGestures.ts, which reads the mode per touch.
 */
/** Who owns the projected keyboard: the bench pointer, room-camera pinches, or lidar touches. */
export type KeyboardInputMode = 'pointer' | 'room-pinch' | 'room-lidar'

export function createKeyboardInput(d: {
  spatial: SpatialService
  keyboard: SwipeKeyboardOwner
  overlay(line: OverlayLine): void
  now?: () => number
  autoTick?: boolean
}) {
  const now = d.now ?? (() => performance.now())
  let mode: KeyboardInputMode = 'pointer'
  let token = randomUUID()
  let revision = 0
  let reason = 'pointer input'
  let machine: GestureMachine | null = null
  let binding = ''
  let armed = false
  let opens = 0
  let previous: { frame: HandObservation; receivedAt: number } | null = null
  let feedback = false
  let stopped = false
  let spatialFrame = d.spatial.snapshot()
  const current = () => spatialFrame.surfaces.find(s => s.id === KEYBOARD_ID)
  const signature = () => {
    const s = current()
    return JSON.stringify([s?.instance, s?.box, spatialFrame.surface, spatialFrame.calibration.revision])
  }
  const clear = () => {
    if (feedback) d.overlay({ kind: 'overlay', layer: 'keyboard-input', shapes: [] })
    feedback = false
  }
  const cancel = (why: string) => {
    machine = null
    armed = false
    opens = 0
    reason = why
    clear()
  }
  // This also runs on surface publication, so move-and-move-back or close-and-
  // reopen between camera samples cannot hide a changed interaction target.
  const check = () => {
    if (mode !== 'room-pinch') return
    if (binding && signature() !== binding) cancel('keyboard or calibration changed; open pinch to rearm')
    const start = machine?.currentPress?.points[0]
    const s = current()
    if (s && start && hitSpatialSurface(spatialFrame, tableFromKeyboardMm(s.box, start)) !== KEYBOARD_ID) cancel('keyboard covered')
    if (previous && now() - previous.receivedAt > DEFAULTS.bridgeMs) cancel('camera stalled; open pinch to rearm')
  }
  const observe = (frame: SpatialFrame) => {
    spatialFrame = frame
    if (mode !== 'room-pinch' || stopped) return
    check()
    if (frame.state !== 'running' || frame.camera.state !== 'receiving' || !frame.camera.frame) return cancel('one calibrated hand required')
    const sample = { frame: frame.camera.frame, receivedAt: frame.camera.receivedAtMonoMs! }
    // A producer cannot upgrade a queued diagnostic frame into an action by
    // fetching the latest map on arrival. It must have captured under this
    // explicit grant. A changed calibration therefore needs a fresh grant.
    if (sample.frame.input?.token !== token || sample.frame.input.revision !== revision || frame.calibration.revision !== revision) {
      cancel('input grant or calibration changed; enable pinch typing again')
      return
    }
    // Lidar, geometry and health changes publish the same camera measurement
    // again. They can cancel a press above, but must never confirm one. Only
    // a distinct progressing camera sample can vote in the gesture machine.
    if (previous?.frame.session === sample.frame.session && previous.frame.seq === sample.frame.seq) return
    if (previous && (previous.frame.session !== sample.frame.session || sample.receivedAt - previous.receivedAt > DEFAULTS.bridgeMs || sample.frame.capturedAt - previous.frame.capturedAt > DEFAULTS.bridgeMs)) cancel('camera discontinuity; open pinch to rearm')
    previous = sample
    const nextBinding = signature()
    if (binding !== nextBinding) cancel('open pinch to begin')
    binding = nextBinding
    const s = current()
    const hand = frame.camera.fingers.length === 1 ? frame.camera.fingers[0] : null
    if (!s || !hand?.pen?.projector || hand.pinch === null) return cancel('one calibrated hand required')
    const p = keyboardMmFromTable(s.box, hand.pen.projector)
    if (!armed) {
      opens = hand.pinch > DEFAULTS.pinchOpen ? opens + 1 : 0
      reason = 'open pinch to begin'
      if (opens < DEFAULTS.confirmFrames) return
      armed = true
    }
    machine ??= new GestureMachine({
      scale: s.box.w * spatialFrame.surface.mmPerPx / SWIPE_KEYBOARD_MM.w,
      regionAt: point => hitSpatialSurface(spatialFrame, tableFromKeyboardMm(s.box, point)) === KEYBOARD_ID ? regionAt(point) : 'none',
    })
    // Bound the evidence before allocating another sample. A stuck closed
    // hand must never leave an unbounded path or later commit a minute of motion.
    const press = machine.currentPress
    if (press && (sample.frame.capturedAt - press.t0 > 10_000 || press.points.length >= 1000)) return cancel('pinch held too long; open to rearm')
    const events = machine.push({ t: sample.frame.capturedAt, present: true, pen: p, pinch: hand.pinch, openPalm: false, palm: null, hands: 1 })
    for (const e of events) {
      if ((e.type === 'tap' || (e.type === 'stroke' && !e.cancelled)) && (e.region === 'keys' || e.region === 'candidates')) {
        // Release the transient owner before publishing draft changes; surface
        // subscribers may run synchronously while the reducer updates the text.
        clear()
        d.keyboard.stroke(e.points.map(point => tableFromKeyboardMm(s.box, point)))
      }
    }
    if (!machine) return
    const active = machine.currentPress
    const writing = active && (active.region === 'keys' || active.region === 'candidates')
    reason = writing ? 'pinching' : 'ready'
    if (hand.pen.surfaceId !== KEYBOARD_ID) { clear(); return }
    const points = writing
      ? active.points.slice(-48).map(point => tableFromKeyboardMm(s.box, point)) : []
    // Existing named overlays already fan out and replay latest state. These
    // are bounded physical-size dots, not a second keyboard renderer/state.
    const radius = (writing ? 3 : 2) / spatialFrame.surface.mmPerPx
    const shapes: OverlayShape[] = [...points, hand.pen.projector].map(point => ({
      points: Array.from({ length: 8 }, (_, i) => ({ x: point.x + radius * Math.cos(i * Math.PI / 4), y: point.y + radius * Math.sin(i * Math.PI / 4) })),
      color: writing ? '#36ff7a' : '#6cf0ff', intensity: 0.8,
    }))
    d.overlay({ kind: 'overlay', layer: 'keyboard-input', shapes })
    feedback = true
  }
  const unsubscribe = d.spatial.subscribe(observe)
  const timer = d.autoTick === false ? null : setInterval(check, 50)
  timer?.unref()
  return {
    state: () => ({ mode, token, revision, reason }),
    select(next: KeyboardInputMode, oldToken?: string) {
      if (stopped) throw new Error('keyboard input stopped')
      // Teardown from an old tab/run must not disable a newer operator grant.
      if (oldToken !== undefined && oldToken !== token) throw new Error('input grant was replaced')
      // Any camera with a map will do (#91): the room's or the iPad's. The
      // spatial service decides which one the frames come from.
      if (next === 'room-pinch' && (spatialFrame.state !== 'running' || !Object.keys(spatialFrame.calibration.cameras).length || !current())) throw new Error('open the keyboard and calibrate a camera first')
      // Lidar typing needs the lidar registered (no touch exists without it)
      // and a keyboard to type on; refusing here says why instead of a mode
      // that silently never types.
      if (next === 'room-lidar' && (spatialFrame.state !== 'running' || !spatialFrame.calibration.registration || !current())) throw new Error('open the keyboard and register the lidar first')
      cancel(next === 'pointer' ? 'pointer input' : next === 'room-lidar' ? 'lidar typing: swipe on the keys' : 'open pinch to begin')
      mode = next
      token = randomUUID()
      revision = spatialFrame.calibration.revision
      previous = null
      binding = ''
      return this.state()
    },
    acceptsPointer: () => !stopped && mode === 'pointer',
    tick: check,
    stop() {
      stopped = true
      if (timer) clearInterval(timer)
      unsubscribe()
      cancel('stopped')
    },
  }
}
