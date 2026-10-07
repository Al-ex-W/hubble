import type { OverlayLine, Surface } from '@hubble/stage'
import { DEFAULT_SURFACE } from '@hubble/stage'
import { apply, residual, solveHomography, WINDOW_LABEL, type HardwareWindow, type Pair } from '@hubble/room'
import { LIDAR_TARGET_LAYER, LIDAR_TARGET_REFRESH_MS, lidarTargetLine } from '../../shared/lidarTarget.ts'
import type { Point } from './coordinates.ts'
import type { SpatialService } from './service.ts'
import type { Cluster } from './touch.ts'

/**
 * The lidar registration wizard (#lidar-wizard): project a numbered target,
 * wait for a finger held on it, record where the LIDAR saw that finger, and
 * after six targets fit and install the lidar → table registration.
 *
 * Why the finger and not anything cleverer: the lidar sees one plane and
 * nothing else, so the only thing both the projector and the lidar can agree
 * on is an object the person puts where the light is. A finger is the object
 * the touch is FOR, so its centroid bias (the lidar sees the finger's near
 * side) is the same bias every later touch has, and it calibrates out.
 *
 * Its own module, like the reference run (reference.ts), because its
 * invariants are the risky part:
 * - the target never outlives the run (a stuck white dot on a shared
 *   projector): cleared on every exit, refreshed under a display lease;
 * - fail closed: the old registration is dropped when a run starts, and a
 *   new one is installed only when all six fingers were seen AND the held-out
 *   pair passes. A half run leaves touch OFF, never on a stale map;
 * - one run at a time, only armed, only inside the hardware window. Like the
 *   reference grid, drawing goes to /table through the page the Pi loads from
 *   us, so the device pool can't see it; this module applies the pool's
 *   window itself (window.ts owns the minutes; we only read pool.window()).
 */

/** Projector px from each corner for the fit targets: far enough in that a finger at the dot is clear of the table's edge and the cloth's border. */
export const TARGET_INSET_PX = 150
/** The owner's tolerances for the live registration (task brief, 7 Oct). */
export const MAX_TABLE_ERROR_MM = 25
export const MAX_PROJECTOR_ERROR_PX = 15
/** A finger still for this long is a capture. Long enough that a hand passing through the plane on its way to the dot doesn't count. */
const HOLD_MS = 1200
/** Per target. A person who hasn't found the dot by then isn't going to; the run fails closed and can be restarted. */
const TIMEOUT_MS = 15_000
/** A finger moves less than this between rotations while "held" (C1 range noise is ±30 mm worst case, datasheet). */
const STILL_MM = 35
/** The finger may drop out of a rotation or two (a gap in the C1's angle steps): this much silence keeps the hold. */
const DROPOUT_MS = 350
/**
 * A capture must be this far (sensor mm) from every earlier one: the person's
 * hand still resting on the previous dot would otherwise be captured again.
 * The closest two targets (top-middle and a top corner) are ~690 mm apart.
 */
const EXCLUDE_MM = 100
/**
 * Nothing farther than this from the lidar is a finger on the projection: the
 * C1 sits at the table's edge (SPEC §2) and the projection is 1.55 × 0.97 m,
 * so its far corner is under 1.9 m away. People walking around the room
 * (the recording has one at 2.9 m) are beyond it.
 */
const MAX_RANGE_MM = 2200
/**
 * For the held-out targets, the four corner captures already predict where
 * the finger will be: only clusters this close to the prediction count. Wide
 * on purpose: the prediction is the point of the check, not its answer, and
 * a 150 mm window still rejects a hand resting on an earlier dot.
 */
const NEAR_MM = 150

export interface Targets {
  fit: Point[]
  check: Point[]
}

/** Six targets: four near the corners (the fit) and two held out (the centre and the top edge's middle), which the fit never sees. */
export function registrationTargets(surface: Pick<Surface, 'widthPx' | 'heightPx'> = DEFAULT_SURFACE, inset = TARGET_INSET_PX): Targets {
  const { widthPx: w, heightPx: h } = surface
  return {
    fit: [
      { x: inset, y: inset },
      { x: w - inset, y: inset },
      { x: w - inset, y: h - inset },
      { x: inset, y: h - inset },
    ],
    check: [
      { x: w / 2, y: h / 2 },
      { x: w / 2, y: inset },
    ],
  }
}

/** Where the corners' captures say the finger on `targetPx` will be, in sensor mm (projector px → sensor, fitted on the four corners). */
function predict(fitPx: Point[], sensors: Point[], targetPx: Point): Point | null {
  const h = solveHomography(fitPx.map((p, i) => ({ from: p, to: sensors[i]! })))
  const q = apply(h, targetPx)
  return Number.isFinite(q.x) && Number.isFinite(q.y) ? q : null
}

export interface WizardDeps {
  overlay(line: OverlayLine): void
  spatial: Pick<SpatialService, 'onClusters' | 'lidarBlocked' | 'calibration'>
  /** Whether a projector write is allowed now (armed, or no real room). */
  mayProject(): boolean
  /** The pool's window on the real room; absent = emulator/tests, any time. */
  window?: () => HardwareWindow
  surface?: Surface
  now?: () => number
  holdMs?: number
  timeoutMs?: number
  log?: (line: string) => void
}

export type CaptureResult = { ok: true; sensor: Point; rotations: number } | { ok: false; error: string }

export interface WizardState {
  on: boolean
  phase: 'idle' | 'target' | 'fitting' | 'done' | 'failed'
  /** 1-based index of the target being shown, and how many there are. */
  index: number
  total: number
  targetPx: Point | null
  captured: { targetPx: Point; sensor: Point }[]
  error: string | null
  result: { rmsTableMm: number; rmsProjectorPx: number } | null
  updatedAt: number
}

export function createLidarRegistration(d: WizardDeps) {
  const surface = d.surface ?? DEFAULT_SURFACE
  const now = d.now ?? (() => Date.now())
  const holdMs = d.holdMs ?? HOLD_MS
  const timeoutMs = d.timeoutMs ?? TIMEOUT_MS
  let state: WizardState = { on: false, phase: 'idle', index: 0, total: 0, targetPx: null, captured: [], error: null, result: null, updatedAt: now() }
  // The pending capture's own abort, so end() (disarm, stop) settles it now
  // rather than leaving a 15 s wait for a run that's already been stopped.
  let abort: ((why: string) => void) | null = null
  const set = (patch: Partial<WizardState>) => {
    state = { ...state, ...patch, updatedAt: now() }
  }
  const clear = () => d.overlay({ kind: 'overlay', layer: LIDAR_TARGET_LAYER, shapes: [] })

  /** Why a capture may not run now, or null. Checked at start and on every refresh. */
  const refusal = (): string | null => {
    if (!d.mayProject()) return 'arm the room output first: the target is a projector write'
    const w = d.window?.()
    if (w && !w.open) return `the hardware window is shut (${WINDOW_LABEL} Stockholm; next opens ${new Date(w.opensAt).toISOString()})`
    return d.spatial.lidarBlocked()
  }

  /**
   * Show one target and wait for a finger held still on it. Resolves with
   * the finger's lidar Cartesian centroid (mean over the hold), or why not.
   * Always clears the target before resolving.
   */
  function capture(targetPx: Point, opts: { label?: string; exclude?: Point[]; near?: Point | null } = {}): Promise<CaptureResult> {
    const why = refusal()
    if (why) return Promise.resolve({ ok: false, error: why })
    if (abort) return Promise.resolve({ ok: false, error: 'a capture is already running' })
    const line = lidarTargetLine(targetPx, surface, opts.label ?? 'hold a finger here')
    const exclude = opts.exclude ?? []
    return new Promise<CaptureResult>((resolve) => {
      // Every finger-sized cluster in the plane is a candidate hold at once
      // (a running mean, when its hold began, when it was last seen). The
      // first ONE that stays still for holdMs wins. Tracking only the first
      // cluster seen failed on the recording: a person walking 2.9 m away
      // was "the finger" for the centre target.
      type Hold = { sum: Point; n: number; since: number; seen: number }
      let holds: Hold[] = []
      const mean = (h: Hold) => ({ x: h.sum.x / h.n, y: h.sum.y / h.n })
      const finish = (r: CaptureResult) => {
        if (!abort) return
        abort = null
        off()
        clearTimeout(timer)
        clearInterval(refresher)
        clear()
        resolve(r)
      }
      abort = (error) => finish({ ok: false, error })
      const off = d.spatial.onClusters((found: Cluster[], at: number) => {
        const fingers = found.filter((c) => {
          const s = c.sensor
          if (Math.hypot(s.x, s.y) > MAX_RANGE_MM) return false
          if (opts.near && Math.hypot(s.x - opts.near.x, s.y - opts.near.y) > NEAR_MM) return false
          return exclude.every((e) => Math.hypot(s.x - e.x, s.y - e.y) >= EXCLUDE_MM)
        })
        const next: Hold[] = []
        for (const c of fingers) {
          const h = holds.find((h) => !next.includes(h) && Math.hypot(c.sensor.x - mean(h).x, c.sensor.y - mean(h).y) <= STILL_MM)
          if (!h) {
            next.push({ sum: { ...c.sensor }, n: 1, since: at, seen: at })
            continue
          }
          h.sum = { x: h.sum.x + c.sensor.x, y: h.sum.y + c.sensor.y }
          h.n++
          h.seen = at
          next.push(h)
          if (at - h.since >= holdMs) return finish({ ok: true, sensor: mean(h), rotations: h.n })
        }
        // A hold missed for a rotation or two (a gap in the C1's angle
        // steps) survives; longer silence means the finger left.
        holds = [...next, ...holds.filter((h) => !next.includes(h) && at - h.seen <= DROPOUT_MS)]
      })
      const timer = setTimeout(() => finish({ ok: false, error: `no finger held on the target within ${Math.round(timeoutMs / 1000)} s` }), timeoutMs)
      timer.unref?.()
      // The display's lease, and where a disarm or the window's close that
      // nobody told us about ends the capture.
      const refresher = setInterval(() => {
        const r = refusal()
        if (r) return finish({ ok: false, error: r })
        d.overlay(line)
      }, LIDAR_TARGET_REFRESH_MS)
      refresher.unref?.()
      d.overlay(line)
    })
  }

  async function run(): Promise<WizardState> {
    if (state.on) return { ...state, error: 'a registration run is already on' }
    const why = refusal()
    if (why) {
      set({ phase: 'failed', error: why })
      return { ...state }
    }
    const targets = registrationTargets(surface)
    const all = [...targets.fit, ...targets.check]
    set({ on: true, phase: 'target', index: 0, total: all.length, targetPx: null, captured: [], error: null, result: null })
    // Fail closed: the old registration goes now. If this run doesn't finish,
    // touch is OFF, not on a map we just decided to re-measure.
    if (d.spatial.calibration.snapshot().registration) d.spatial.calibration.clearRegistration()
    try {
      const sensors: Point[] = []
      for (const [i, targetPx] of all.entries()) {
        if (!state.on) throw new Error('stopped')
        set({ index: i + 1, targetPx })
        d.log?.(`target ${i + 1}/${all.length} at ${Math.round(targetPx.x)},${Math.round(targetPx.y)} px`)
        // Held-out targets: look near where the corners' fit puts them.
        const near = i >= targets.fit.length ? predict(targets.fit, sensors, targetPx) : null
        const r = await capture(targetPx, { label: `${i + 1} / ${all.length} · hold a finger here`, exclude: sensors, near })
        if (!r.ok) throw new Error(`target ${i + 1}: ${r.error}`)
        sensors.push(r.sensor)
        set({ captured: [...state.captured, { targetPx, sensor: r.sensor }] })
        d.log?.(`target ${i + 1}: finger at lidar ${Math.round(r.sensor.x)},${Math.round(r.sensor.y)} mm (${r.rotations} rotations)`)
      }
      if (!state.on) throw new Error('stopped')
      set({ phase: 'fitting', targetPx: null })
      // Ruling (plan): table mm := projector px × mm/px. Positions are right
      // regardless of the true mm/px, because touch maps lidar → table →
      // projector and both halves were measured against the same dots.
      const mm = (p: Point) => ({ x: p.x * surface.mmPerPx, y: p.y * surface.mmPerPx })
      const nFit = targets.fit.length
      const tablePairs: Pair[] = all.map((p) => ({ from: mm(p), to: p }))
      const lidarPairs: Pair[] = all.map((p, i) => ({ from: sensors[i]!, to: mm(p) }))
      // Our own read of the held-out error, for the message when it fails:
      // calibration.register() only says "exceeds the tolerance".
      const checkMm = residual(solveHomography(lidarPairs.slice(0, nFit)), lidarPairs.slice(nFit))
      try {
        const snap = d.spatial.calibration.register({
          table: tablePairs.slice(0, nFit),
          tableCheck: tablePairs.slice(nFit),
          lidar: lidarPairs.slice(0, nFit),
          lidarCheck: lidarPairs.slice(nFit),
          maxProjectorErrorPx: MAX_PROJECTOR_ERROR_PX,
          maxTableErrorMm: MAX_TABLE_ERROR_MM,
        })
        const reg = snap.registration!
        set({ on: false, phase: 'done', result: { rmsTableMm: reg.rmsTableMm, rmsProjectorPx: reg.rmsProjectorPx } })
        d.log?.(`registered: held-out error ${reg.rmsTableMm.toFixed(1)} mm`)
      } catch (e) {
        throw new Error(`fit refused: held-out error ${Number.isFinite(checkMm) ? checkMm.toFixed(1) : '?'} mm (max ${MAX_TABLE_ERROR_MM}): ${e instanceof Error ? e.message : String(e)}`)
      }
    } catch (e) {
      set({ on: false, phase: 'failed', targetPx: null, error: e instanceof Error ? e.message : String(e) })
      d.log?.(`failed: ${state.error}`)
    } finally {
      // Clear unconditionally, as the reference run does: one more clear to
      // a display that already dropped it costs nothing.
      clear()
    }
    return { ...state }
  }

  return {
    capture,
    run,
    state: () => ({ ...state, captured: [...state.captured] }),
    /** End a run or capture if one is on (disarm, stop); no write when idle. */
    end() {
      if (!state.on && !abort) return
      set({ on: false })
      abort?.('stopped')
    },
  }
}
export type LidarRegistration = ReturnType<typeof createLidarRegistration>
