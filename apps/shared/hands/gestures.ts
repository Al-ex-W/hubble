import type { Features } from './features.ts'
import type { Pt } from './types.ts'

/**
 * Hand features in, gesture events out. Pure and frame-driven: the same
 * machine runs on a recording and on the live camera. Ported from
 * experiments/hands/src/gestures.ts (#28), where every rule below was found
 * on a real video or the lab's simulator.
 *
 * There is no touch sensor (the lidar can't prove contact, #11), so "pen
 * down" has to be a deliberate hand state: a pinch. Every threshold exists
 * because the raw signal flickers: MediaPipe's points jitter by a few pixels,
 * drop out for a frame or two, and a relaxed hand's thumb drifts towards the
 * index on its own.
 *
 * Positions are in keyboard mm (the decoder's frame); speeds and distances
 * that mean something physical are in REAL mm (keyboard mm × `scale`), so
 * the thresholds hold on the 22 mm printout and the 44 mm projection alike.
 */

/**
 * Where a press starts decides what it is, once:
 * - `keys` / `candidates`: the swipe keyboard's own rows;
 * - `surface`: anywhere else on the table: a drag that the runtime turns
 *   into moving a surface (#32), which hit-tests which one;
 * - `none`: nothing to act on (outside the table).
 * The keyboard geometry is injected (`regionAt`), so these rules never keep
 * their own copy of the widget's numbers (the lab's sheet.ts did).
 */
export type Region = 'keys' | 'candidates' | 'surface' | 'none'

export type GestureEvent =
  | { type: 'pen-down'; t: number; p: Pt; region: Region }
  | { type: 'pen-move'; t: number; p: Pt }
  | { type: 'stroke'; t: number; region: Region; points: Pt[]; cancelled: boolean }
  /**
   * `points` is the whole press, kept for the keyboard: its reducer has its
   * own tap threshold (22 mm) and must judge the real path, or a 23 mm press
   * this machine calls a tap typed "a" where the mouse typed "as" (review #42).
   */
  | { type: 'tap'; t: number; p: Pt; region: Region; points: Pt[] }
  | { type: 'drag-start'; t: number; p: Pt }
  | { type: 'drag-move'; t: number; p: Pt }
  | { type: 'drag-end'; t: number; p: Pt; flick: boolean; cancelled: boolean }
  /** `p`: the palm (keyboard mm here, table px after the pipeline), so the launcher opens by the hand (#33). */
  | { type: 'wake'; t: number; p?: Pt }

export interface GestureConfig {
  /** Real mm per keyboard mm (the printout's scale; 1 for the projection). */
  scale: number
  regionAt: (p: Pt) => Region
  // Pinch hysteresis: closing needs a clearly smaller ratio than opening, or
  // a pinch hovering at the threshold toggles the pen every few frames and
  // one word becomes three strokes.
  pinchClose: number
  pinchOpen: number
  /** Consecutive frames past a threshold before the pinch state flips. */
  confirmFrames: number
  /** A hand lost for less than this keeps its stroke: MediaPipe drops single frames mid-motion. */
  bridgeMs: number
  tapMaxMs: number
  /**
   * Keyboard mm: a press that never strays further than this from where it
   * started is a tap. Key units, not real mm, so it means "less than about
   * half a key" on the print and the table alike.
   */
  tapMaxMm: number
  wakeHoldMs: number
  /** Real mm/s: an open palm moving faster than this is a wave or a reach, not a wake. */
  wakeMaxSpeed: number
  /** Real mm/s at release: faster is a flick (dismiss). */
  flickSpeed: number
}

export const DEFAULTS: Omit<GestureConfig, 'regionAt'> = {
  scale: 1,
  // From the first real recording (IMG_3537, top-down iPhone over the
  // printout): pinched reads 0.05-0.12, and a natural release only opens to
  // 0.25-0.40, never the 0.45 first guessed (which missed every release and
  // turned 10 s of swiping into two strokes). Close below 0.16, open above
  // 0.24: both clear of the measured clusters, with a gap between so a pinch
  // hovering at one value can't toggle.
  pinchClose: 0.16,
  pinchOpen: 0.24,
  confirmFrames: 2,
  bridgeMs: 220,
  tapMaxMs: 450,
  tapMaxMm: 24,
  wakeHoldMs: 900,
  wakeMaxSpeed: 60,
  flickSpeed: 700,
}

interface Press {
  region: Region
  t0: number
  points: Pt[]
  times: number[]
}

export class GestureMachine {
  readonly cfg: GestureConfig
  private closed = false
  private streak = 0
  private press: Press | null = null
  private lastSeen = -Infinity
  private history: { t: number; p: Pt; palm: Pt | null }[] = []
  private holdStart: number | null = null
  private woke = false

  constructor(cfg: Partial<GestureConfig> & Pick<GestureConfig, 'regionAt'>) {
    this.cfg = { ...DEFAULTS, ...cfg }
  }

  get penDown(): boolean {
    return this.press !== null
  }
  get currentPress(): Readonly<Press> | null {
    return this.press
  }
  get pinchClosed(): boolean {
    return this.closed
  }

  push(f: Features): GestureEvent[] {
    const out: GestureEvent[] = []
    if (!f.present || !f.pen) {
      if (this.press && f.t - this.lastSeen > this.cfg.bridgeMs) out.push(...this.end(f.t, true))
      this.holdStart = null
      return out
    }
    this.lastSeen = f.t
    this.history.push({ t: f.t, p: f.pen, palm: f.palm })
    while (this.history.length > 2 && f.t - this.history[0]!.t > 250) this.history.shift()
    this.pinchStep(f, out)
    this.wakeStep(f, out)
    return out
  }

  /** Real mm/s of the pen (or palm) over the last ~100 ms. */
  private speed(t: number, which: 'p' | 'palm' = 'p'): number {
    const now = this.history[this.history.length - 1]!
    let then = now
    for (let i = this.history.length - 1; i >= 0; i--) {
      then = this.history[i]!
      if (t - then.t >= 100) break
    }
    const a = which === 'p' ? now.p : now.palm
    const b = which === 'p' ? then.p : then.palm
    if (!a || !b || now.t === then.t) return 0
    return (Math.hypot(a.x - b.x, a.y - b.y) * this.cfg.scale * 1000) / (now.t - then.t)
  }

  private pinchStep(f: Features, out: GestureEvent[]) {
    const r = f.pinch!
    const past = this.closed ? r > this.cfg.pinchOpen : r < this.cfg.pinchClose
    this.streak = past ? this.streak + 1 : 0
    if (this.streak >= this.cfg.confirmFrames) {
      this.closed = !this.closed
      this.streak = 0
      if (this.closed) out.push(...this.begin(f.t, f.pen!))
      else if (this.press) out.push(...this.end(f.t, false))
    } else if (this.press && r <= this.cfg.pinchOpen) {
      // Frames that already read as open are the release in progress (it is
      // confirmed a frame or two later). They must not extend the press:
      // opening fingers drag the pinch point ~15 mm, which bent the tail of
      // every word and turned a tap on SEND into a short swipe.
      out.push(...this.move(f.t, f.pen!))
    }
  }

  private wakeStep(f: Features, out: GestureEvent[]) {
    // Never while writing or dragging: an open hand mid-press is a release.
    if (this.press || this.closed || !f.openPalm || this.speed(f.t, 'palm') > this.cfg.wakeMaxSpeed) {
      this.holdStart = null
      if (!f.openPalm) this.woke = false
      return
    }
    this.holdStart ??= f.t
    if (!this.woke && f.t - this.holdStart >= this.cfg.wakeHoldMs) {
      this.woke = true
      out.push(f.palm ? { type: 'wake', t: f.t, p: f.palm } : { type: 'wake', t: f.t })
    }
  }

  private begin(t: number, p: Pt): GestureEvent[] {
    const region = this.cfg.regionAt(p)
    this.press = { region, t0: t, points: [p], times: [t] }
    if (region === 'surface') return [{ type: 'drag-start', t, p }]
    return [{ type: 'pen-down', t, p, region }]
  }

  private move(t: number, p: Pt): GestureEvent[] {
    const s = this.press!
    s.points.push(p)
    s.times.push(t)
    return s.region === 'surface' ? [{ type: 'drag-move', t, p }] : [{ type: 'pen-move', t, p }]
  }

  private end(t: number, cancelled: boolean): GestureEvent[] {
    const s = this.press!
    this.press = null
    // A lost hand also forgets its pinch: when it comes back, it must close
    // again to write, rather than resuming a press from wherever it is.
    if (cancelled) this.closed = false
    const last = s.points[s.points.length - 1]!
    if (s.region === 'surface') {
      return [{ type: 'drag-end', t, p: last, flick: !cancelled && this.releaseSpeed(s) > this.cfg.flickSpeed, cancelled }]
    }
    // Furthest from the start, not path length: path length adds up a few
    // px of jitter per frame plus the pinch point's own drift as the fingers
    // close and open, and turned a held tap on SEND into a "swipe".
    const o = s.points[0]!
    let travel = 0
    for (const p of s.points) travel = Math.max(travel, Math.hypot(p.x - o.x, p.y - o.y))
    if (!cancelled && travel < this.cfg.tapMaxMm && t - s.t0 < this.cfg.tapMaxMs) return [{ type: 'tap', t, p: o, region: s.region, points: s.points }]
    return [{ type: 'stroke', t, region: s.region, points: s.points, cancelled }]
  }

  /**
   * Peak real mm/s over the press's last 250 ms. Not the speed at the moment
   * of release: the hand decelerates before the fingers have opened far
   * enough to read as released (two frames past the open threshold), so the
   * instantaneous speed there was ~0 even for a hard flick. A slow drag never
   * reaches the flick speed anywhere in that window.
   */
  private releaseSpeed(s: Press): number {
    const n = s.points.length
    const tEnd = s.times[n - 1]!
    let peak = 0
    for (let i = n - 1; i > 0 && tEnd - s.times[i]! <= 250; i--) {
      // Speed over ~60 ms spans, so one jittery frame can't fake a flick.
      let j = i - 1
      while (j > 0 && s.times[i]! - s.times[j]! < 60) j--
      const dt = s.times[i]! - s.times[j]!
      if (dt <= 0) continue
      const v = (Math.hypot(s.points[i]!.x - s.points[j]!.x, s.points[i]!.y - s.points[j]!.y) * this.cfg.scale * 1000) / dt
      peak = Math.max(peak, v)
    }
    return peak
  }
}
