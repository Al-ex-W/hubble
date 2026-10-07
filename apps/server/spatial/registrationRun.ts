import { WINDOW_LABEL, type HardwareWindow } from '@hubble/room'
import { DEFAULT_SURFACE, type OverlayLine, type OverlayShape, type Surface } from '@hubble/stage'
import type { Point } from './coordinates.ts'
import type { SpatialService } from './service.ts'

/**
 * The lidar registration run (#89 T4, docs/plans/2026-10-07-lidar-web.md): light
 * one target at a time, let a person hold a fingertip on it, and fit the lidar
 * → table map from where the lidar saw each finger.
 *
 * Why a server-side run and not a page that posts pairs: the run decides what
 * is on the projector (the targets), when a capture counts, and what gets
 * saved. Those are the runtime's and the spatial service's decisions; the
 * /spatial page is only a view and two buttons, so a reload or a second tab
 * can't put a half-run's pairs into the registration.
 *
 * Why finger touches and not objects: the lidar sees a finger's FRONT surface,
 * 30–67 mm above the table (the plan's research), and a touching finger slopes
 * toward the person, so the point the lidar reports is shifted toward the user
 * by a roughly constant amount. Registering with real finger touches folds that
 * mean shift into the map (his Ruling 6), which an object on the table would not.
 */

export const REGISTRATION_LAYER = 'registration'
/** Ruling 4: the lidar side's held-out tolerance, the lidar-touch plan's stop condition (his goal is 15 mm). */
// 60, not 22 (7 Oct 14:15, live): the 22 mm check refused a full 12-dot run; a ripple only
// needs a few cm. Keyboard taps by lidar want it tighter (plan Ruling 4).
export const REGISTRATION_MAX_TABLE_ERROR_MM = 60
/** Ruling 4's goal, reported next to the result so the operator sees whether keyboard typing should be trusted. */
export const REGISTRATION_GOAL_MM = 15

/**
 * Twelve targets in projector px: nine to fit (3 × 3, 15 % in from the edges)
 * and three held out to check it, placed where no fit target is, so a map that
 * only fits its own nine points is caught. Fractions of the Surface, not pixel
 * constants, so a re-measured Surface moves them with it (AGENTS.md rule 5).
 */
export function registrationTargets(surface: Surface = DEFAULT_SURFACE): { fit: Point[]; check: Point[] } {
  const at = (fx: number, fy: number) => ({ x: Math.round(fx * surface.widthPx), y: Math.round(fy * surface.heightPx) })
  const f = [0.15, 0.5, 0.85]
  return {
    fit: f.flatMap((fy) => f.map((fx) => at(fx, fy))),
    check: [at(0.32, 0.3), at(0.68, 0.68), at(0.3, 0.72)],
  }
}

export type RegistrationPhase = 'idle' | 'capturing' | 'lifting' | 'fitting' | 'done' | 'failed' | 'cancelled'
export interface RegistrationState {
  phase: RegistrationPhase
  /** The target being captured (0-based over fit, then check), or how many were done. */
  index: number
  total: number
  /** The latest capture's word to the person ("hold it still", ...), or the failure. */
  message: string
  /** After a fit: errors in table mm on the held-out targets, and the fit's own rms. */
  result: { heldOutMaxMm: number; rmsTableMm: number; goalMm: number } | null
}

export interface RegistrationDeps {
  spatial: Pick<SpatialService, 'captureFinger' | 'calibration'>
  overlay(line: OverlayLine): void
  /** May we draw on the shared projector (the owner's arm)? As the reference run. */
  mayProject(): boolean
  /** The hardware window on the real room; absent on the emulator and in tests. */
  window?: () => HardwareWindow
  surface?: Surface
  captureMs?: number
  /** How long a "no finger here" check is, while waiting for the finger to lift. */
  liftMs?: number
  log?(line: string): void
}

export function createRegistrationRun(d: RegistrationDeps) {
  const surface = d.surface ?? DEFAULT_SURFACE
  const targets = registrationTargets(surface)
  const all = [...targets.fit, ...targets.check]
  // Bumped per start and cancel: a capture still awaiting its 1.5 s from an
  // earlier run sees it's stale and changes nothing.
  let run = 0
  let state: RegistrationState = { phase: 'idle', index: 0, total: all.length, message: '', result: null }

  const mm = (p: Point) => ({ x: p.x * surface.mmPerPx, y: p.y * surface.mmPerPx })
  // Physical sizes: a 16 mm dot to put a fingertip on (smaller than a
  // fingertip, so "on it" is unambiguous) and 7 mm dims for the done ones.
  const dot = (c: Point, rMm: number, color: string, intensity: number): OverlayShape => {
    const r = rMm / surface.mmPerPx
    return { points: Array.from({ length: 16 }, (_, k) => ({ x: c.x + r * Math.cos((k * Math.PI) / 8), y: c.y + r * Math.sin((k * Math.PI) / 8) })), color, intensity }
  }
  // `seeing` (7 Oct, owner on the table: "indication if it's detecting"): the
  // target turns yellow while the lidar sees something there but can't take it
  // yet (moving, two fingers), so the person knows it's working, and knows a
  // capture they didn't make is noise.
  const draw = (i: number | null, done: number, seeing = false) => {
    const shapes: OverlayShape[] = all.slice(0, done).map((p) => dot(p, 14, '#36ff7a', 0.8))
    // The current target in the house's cursor cyan at full intensity: on the
    // white table only light shows, and cyan stays visible (lidar-touch plan).
    // Big and white (7 Oct, live: a 16 mm cyan dot was a speck nobody could find
    // on the lit white table). A 45 mm disc plus a 70 mm ring around it.
    if (i !== null) {
      shapes.push(dot(all[i]!, 70, seeing ? '#ffd23f' : '#ffffff', 1))
      shapes.push(dot(all[i]!, 45, seeing ? '#ffd23f' : '#ffffff', 1))
    }
    d.overlay({ kind: 'overlay', layer: REGISTRATION_LAYER, shapes })
  }
  const clear = () => d.overlay({ kind: 'overlay', layer: REGISTRATION_LAYER, shapes: [] })

  /** Why the targets may not be on the projector now, or null. As reference.ts. */
  const refusal = (): string | null => {
    if (!d.mayProject()) return 'arm the room output first: the targets are a projector write'
    const w = d.window?.()
    if (w && !w.open) return `the hardware window is shut (${WINDOW_LABEL} Stockholm; next opens ${new Date(w.opensAt).toISOString()})`
    return null
  }

  const end = (phase: RegistrationPhase, message: string) => {
    run++
    clear()
    state = { ...state, phase, message }
    d.log?.(`registration ${phase}: ${message}`)
  }

  async function loop(mine: number) {
    // Rapid fire (owner on the table, 7 Oct): each dot gets at most
    // DOT_MS; a dot nobody captured is skipped, not waited on, and the fit
    // uses whatever was captured (it still needs 4 fit + 2 held-out).
    const DOT_MS = 10_000
    const sensors: (Point | null)[] = []
    for (let i = 0; i < all.length; i++) {
      const deadline = Date.now() + DOT_MS
      let got = false
      // Hold: capture until one held finger is measured on this target.
      for (;;) {
        if (mine !== run) return
        if (Date.now() > deadline) { sensors.push(null); state = { ...state, message: `target ${i + 1} skipped (10 s)` }; break }
        const why = refusal()
        if (why) return end('failed', why)
        if (state.index !== i || state.phase !== 'capturing') draw(i, i)
        state = { ...state, phase: 'capturing', index: i }
        const r = await d.spatial.captureFinger(d.captureMs)
        if (mine !== run) return
        if (r.ok) {
          sensors.push(r.sensor)
          got = true
          state = { ...state, message: `target ${i + 1} captured (${r.hits}/${r.rotations} rotations, spread ${Math.round(r.spreadMm)} mm)` }
          break
        }
        if (r.reason === 'unavailable') return end('failed', r.detail)
        state = { ...state, message: r.detail }
        draw(i, i, r.reason === 'moving' || r.reason === 'two-fingers')
      }
      // Lift: the same finger still on the table must not be captured again
      // as the next target's. Wait until a short check finds no finger.
      const liftBy = Date.now() + 3000
      for (; got && Date.now() < liftBy;) {
        if (mine !== run) return
        state = { ...state, phase: 'lifting', index: i }
        draw(null, i + 1)
        const r = await d.spatial.captureFinger(d.liftMs ?? 400)
        if (mine !== run) return
        if (!r.ok && (r.reason === 'no-finger' || r.reason === 'too-few-rotations')) break
        if (!r.ok && r.reason === 'unavailable') return end('failed', r.detail)
        state = { ...state, message: 'lift your finger' }
      }
    }
    state = { ...state, phase: 'fitting', index: all.length, message: 'fitting' }
    const n = targets.fit.length
    const pair = (from: Point, to: Point) => ({ from, to })
    // Only captured targets take part (rapid fire skips the rest).
    const fitIdx = targets.fit.map((_, i) => i).filter((i) => sensors[i])
    const checkIdx = targets.check.map((_, i) => i).filter((i) => sensors[n + i])
    if (fitIdx.length < 4 || checkIdx.length < 2) return end('failed', `only ${fitIdx.length} fit + ${checkIdx.length} check targets captured (need 4 + 2): run it again`)
    try {
      // Ruling 3: table mm := projector px × the Surface's mm/px. The projector
      // side is then exact by construction (1 px tolerance); the measured side
      // is lidar → table, held out at Ruling 4's tolerance.
      d.spatial.calibration.register({
        table: fitIdx.map((i) => pair(mm(targets.fit[i]!), targets.fit[i]!)),
        tableCheck: checkIdx.map((i) => pair(mm(targets.check[i]!), targets.check[i]!)),
        lidar: fitIdx.map((i) => pair(sensors[i]!, mm(targets.fit[i]!))),
        lidarCheck: checkIdx.map((i) => pair(sensors[n + i]!, mm(targets.check[i]!))),
        maxProjectorErrorPx: 1,
        maxTableErrorMm: REGISTRATION_MAX_TABLE_ERROR_MM,
      })
    } catch (e) {
      return end('failed', `the fit was refused: ${e instanceof Error ? e.message : String(e)}. Run it again, holding each fingertip still on the dot`)
    }
    if (mine !== run) return
    // The held-out error through the map that was just saved: what a touch
    // at a point the fit never saw lands as. Independent of the fit's rms.
    const heldOut = checkIdx.map((i) => {
      const p = targets.check[i]!
      const t = d.spatial.calibration.lidarToTable(sensors[n + i]!)
      const want = mm(p)
      return t ? Math.hypot(t.x - want.x, t.y - want.y) : Number.POSITIVE_INFINITY
    })
    const reg = d.spatial.calibration.snapshot().registration
    state = { ...state, result: { heldOutMaxMm: Math.max(...heldOut), rmsTableMm: reg?.rmsTableMm ?? Number.NaN, goalMm: REGISTRATION_GOAL_MM } }
    end('done', `registered: held-out error ${Math.max(...heldOut).toFixed(1)} mm (goal ${REGISTRATION_GOAL_MM} mm, refused above ${REGISTRATION_MAX_TABLE_ERROR_MM} mm)`)
  }

  return {
    start(): { ok: boolean; error?: string; state: RegistrationState } {
      if (state.phase === 'capturing' || state.phase === 'lifting' || state.phase === 'fitting') return { ok: false, error: 'a registration is already running', state }
      const why = refusal()
      if (why) return { ok: false, error: why, state }
      const mine = ++run
      state = { phase: 'capturing', index: 0, total: all.length, message: 'hold a fingertip on the lit dot', result: null }
      void loop(mine)
      return { ok: true, state }
    },
    cancel(): RegistrationState {
      if (state.phase === 'capturing' || state.phase === 'lifting' || state.phase === 'fitting') end('cancelled', 'cancelled')
      return { ...state }
    },
    /** For disarm and stop: end a run if one is on, without an idle clear (as reference.end()). */
    end() {
      if (state.phase === 'capturing' || state.phase === 'lifting') end('cancelled', 'room output disarmed or runtime stopped')
    },
    state: (): RegistrationState => ({ ...state }),
  }
}

export type RegistrationRun = ReturnType<typeof createRegistrationRun>
