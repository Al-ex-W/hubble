import { regionAt } from '../../../shared/hands/keyboardRegion.ts'
export { regionAt } from '../../../shared/hands/keyboardRegion.ts'
import { features, type Features } from './features.ts'
import { GestureMachine, type GestureConfig, type GestureEvent, type Region } from './gestures.ts'
import { apply, type H } from './homography.ts'
import type { Frame, Pt } from './types.ts'

/**
 * Camera frames in; keyboard presses and table gestures out. Streaming (one
 * frame at a time), so the live camera and a recorded take run the same code.
 *
 * Two outputs, two owners:
 * - **presses** for the swipe keyboard: every finished press that started on
 *   the keys or the candidate row, as the whole path it drew (taps included:
 *   the keyboard's threshold, not this module's, decides tap vs swipe). The
 *   keyboard's own reducer (@hubble/stage/swipe, run by the server's
 *   runtime) decides what it
 *   means, exactly as for a mouse stroke, so the hand and the mouse can never
 *   disagree about "tap or swipe" or what delete takes back. A cancelled
 *   press (hand lost) is dropped: half a word decodes to a confident wrong word.
 * - **gestures** for the runtime: every event, in table (projector) px, the
 *   frame the surface set hit-tests in. What a drag or a wake *does* is the
 *   runtime's decision (#32), not this module's.
 */

export interface HandStep {
  f: Features
  events: GestureEvent[]
  /** Finished keyboard presses this frame, in keyboard mm. */
  presses: Pt[][]
  /** The same events in table px, for the server's input stream. */
  table: GestureEvent[]
  pinchClosed: boolean
  /** The press in progress, in keyboard mm (the live trail). */
  trail: Pt[]
}

export function createHandPipeline(opts: {
  camToKb: H
  scale: number
  /**
   * Keyboard mm → table px. A getter is read at every event, because the
   * keyboard can move while the camera runs (it is a surface a hand or the
   * runtime may move, #29/#32): a map captured when tracking started sent
   * every later table gesture to where the keyboard used to be (review #47).
   */
  kbToTable?: H | (() => H)
  gestures?: Partial<GestureConfig>
  /**
   * Whether a table-px point lies on a surface drawn over the keyboard that
   * owns its own presses (the launcher, #33). A press starting there is a
   * surface press (a drag pair the server's launcher reads), never a
   * keyboard press: otherwise the keyboard typed the letter under a
   * launcher item before the server could say the launcher took it (review
   * #48), and a flick there could never close it. Asked at the press's
   * first point only: the press keeps its owner to the end.
   */
  covered?: (tablePx: Pt) => boolean
}) {
  const map = () => (typeof opts.kbToTable === 'function' ? opts.kbToTable() : opts.kbToTable)
  const toTable = (p: Pt) => {
    const h = map()
    return h ? apply(h, p) : p
  }
  const region = (p: Pt): Region => (map() && opts.covered?.(toTable(p)) ? 'surface' : regionAt(p))
  const gm = new GestureMachine({ ...opts.gestures, scale: opts.scale, regionAt: region })
  const mapEvent = (e: GestureEvent): GestureEvent => {
    if (e.type === 'wake') return e.p ? { ...e, p: toTable(e.p) } : e
    if (e.type === 'stroke') return { ...e, points: e.points.map(toTable) }
    // The runtime gets a tap as where it happened; the path is keyboard evidence only.
    if (e.type === 'tap') return { type: 'tap', t: e.t, p: toTable(e.p), region: e.region, points: [] }
    return { ...e, p: toTable(e.p) } as GestureEvent
  }
  return {
    gestures: gm,
    push(frame: Frame): HandStep {
      const f = features(frame, opts.camToKb)
      const events = gm.push(f)
      const presses: Pt[][] = []
      for (const e of events) {
        const onKeyboard = 'region' in e && (e.region === 'keys' || e.region === 'candidates')
        // The whole press, tap or not: the keyboard's reducer is the one
        // owner of "tap or swipe" for the mouse and the hand alike, so it
        // gets the evidence (review #42: collapsing to one point made a
        // 23 mm press type "a" where the same mouse path typed "as").
        if (e.type === 'tap' && onKeyboard) presses.push(e.points)
        if (e.type === 'stroke' && onKeyboard && !e.cancelled) presses.push(e.points)
      }
      return { f, events, presses, table: events.map(mapEvent), pinchClosed: gm.pinchClosed, trail: gm.currentPress ? [...gm.currentPress.points] : [] }
    },
  }
}
