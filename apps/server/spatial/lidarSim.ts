import { createLidarStream, simulateScan, BIN_DEG, type Pose, type SimShape } from '@hubble/room'
import { DEFAULT_SURFACE, type Surface } from '@hubble/stage'
import type { Point } from './coordinates.ts'
import type { SimSourceFactory } from './service.ts'
import type { SpatialService } from './service.ts'

/**
 * A SIMULATED lidar for the overall view (docs/plans/2026-10-07-overall-view.md):
 * a mouse on the projector iframe becomes a fingertip in a synthesized RPLIDAR
 * C1 scan, fed into the SAME spatial service the real lidar feeds, so taps,
 * holds and drags are real lidar touches (ripples, gestures) and the
 * registration wizard can be completed by clicking its dots.
 *
 * Why a scan and not a shortcut straight to "a touch at px x,y": the owner's
 * point is that this is "equivalent to actually touching the lidar". Anything
 * shorter would skip the baseline, the clusterer, the tracker and the
 * registration fit, i.e. exactly the parts the owner wants to rehearse and
 * calibrate. So the only thing simulated is the sensor: rotations in, the
 * unchanged pipeline after.
 *
 * What is modelled (packages/room/src/simulate.ts, the room emulator's C1):
 * 0.72° steps with a random phase per rotation (a real C1's angles jitter,
 * and a 15 mm finger at 1.5 m is under one step wide: a fixed phase would
 * make some spots permanently invisible), the 15 mm range resolution, a
 * static room (four walls and a stand) so the automatic baseline has
 * something to learn, and a finger-sized cluster while the pointer is down.
 * What is NOT: pitch, cloth dips and the real noise (±30 mm datasheet): the
 * sim's noise is a few mm so a hold is a hold. It is a rehearsal rig, not a
 * measurement; AGENTS.md rule 6 ("simulate the hardware, then switch").
 */

/**
 * The virtual lidar's mount. Same default as the room's documented one
 * (index.ts lidarPose: the middle of the back edge, looking at the user,
 * table mm from the top-left, rotation clockwise from +x), because the
 * owner's rig is meant to be a believable stand-in for that mount. Not a
 * measurement. Overridable (HUBBLE_LIDAR_SIM_POSE="x,y,rotation") so the
 * registration wizard can be shown to RECOVER a pose it was not told.
 */
export const SIM_DEFAULT_POSE: Pose = { x: 775, y: 0, rotation: 90 }
/** A fingertip's radius, mm. 14 keeps a finger ≥ one angular step wide out to ~1.9 m (the wizard's limit is 2.2 m), so a held finger is never missed by the step grid alone. */
export const SIM_FINGER_RADIUS_MM = 14
/**
 * The sim's rotation rate. The C1 is 10 Hz nominal (datasheet), but the sim
 * runs on a setInterval, which drifts late: at exactly 10 Hz the baseline's
 * 3 s capture got 29 rotations and was refused ("need 30", found by the
 * overall-view test on its first run). 11 Hz keeps a 3 s capture above 30
 * with timer jitter to spare; a real C1 delivers its own rate.
 */
export const SIM_HZ = 11
/** Height of the sim finger above the cloth: well inside the scan plane (the beam is ~30 mm up), so it is seen. */
const FINGER_HEIGHT_MM = 60

/**
 * The static room, table mm: walls 2 m beyond the table on every side and
 * a stand off the table's right edge. Beyond the table so no baseline bin is
 * "open" inside the projection, and one object so the baseline is more than
 * empty space. Heights are above the plane, so the beam hits them.
 */
export const SIM_ROOM: SimShape[] = [
  { kind: 'rect', x: -2200, y: -1100, w: 6000, h: 100, heightMm: 300 },
  { kind: 'rect', x: -2200, y: 2900, w: 6000, h: 100, heightMm: 300 },
  { kind: 'rect', x: -2200, y: -1100, w: 100, h: 4100, heightMm: 300 },
  { kind: 'rect', x: 3700, y: -1100, w: 100, h: 4100, heightMm: 300 },
  { kind: 'rect', x: 2200, y: 1500, w: 200, h: 300, heightMm: 300 },
]

const rad = (deg: number) => (deg * Math.PI) / 180

/**
 * Projector px → the lidar's own Cartesian mm (the spatial frame's raw-return
 * convention: x = d·cos a, y = d·sin a), through the virtual pose. This is
 * the one conversion the simulation depends on, so it is its own function with
 * an independent oracle in the tests.
 *
 * px → table mm is the wizard's own ruling (table mm := px × mm/px; both
 * halves of a registration are measured against the same dots, so positions
 * are right whatever the true scale). Then the pose: the ray direction in
 * the table is `rotation + a` (`rotation − a` when mirrored), so the sensor
 * vector is the table offset rotated by −rotation (y flipped when mirrored).
 */
export function pxToSensor(px: Point, pose: Pose, surface: Pick<Surface, 'mmPerPx'> = DEFAULT_SURFACE): Point {
  const dx = px.x * surface.mmPerPx - pose.x
  const dy = px.y * surface.mmPerPx - pose.y
  const r = rad(pose.rotation)
  const x = dx * Math.cos(r) + dy * Math.sin(r)
  const y = -dx * Math.sin(r) + dy * Math.cos(r)
  return { x, y: pose.mirrored ? -y : y }
}

/** The inverse of pxToSensor's pose step: a sensor point back to table mm. */
export function sensorToTable(s: Point, pose: Pose): Point {
  const y = pose.mirrored ? -s.y : s.y
  const r = rad(pose.rotation)
  return { x: pose.x + s.x * Math.cos(r) - y * Math.sin(r), y: pose.y + s.x * Math.sin(r) + y * Math.cos(r) }
}

/**
 * One rotation: the static room plus, when `finger` (projector px) is given,
 * a fingertip there. The finger's centre is pushed one radius AWAY from the
 * lidar so the near surface the C1 actually measures sits on the pointer: the
 * simulated touch lands where the mouse is, not 14 mm short of it (a real
 * finger's bias is absorbed by the registration, but a rehearsal rig whose
 * pointer is consistently off would only confuse).
 *
 * `seq` picks this rotation's angular phase (golden-ratio sequence: even
 * coverage of the step grid, and deterministic for tests).
 */
export function simulatedRotation(finger: Point | null, pose: Pose, seq: number, t: number, surface: Pick<Surface, 'mmPerPx'> = DEFAULT_SURFACE) {
  const shapes: SimShape[] = [...SIM_ROOM]
  if (finger) {
    const s = pxToSensor(finger, pose, surface)
    const d = Math.hypot(s.x, s.y) || 1
    const away = sensorToTable({ x: s.x + (s.x / d) * SIM_FINGER_RADIUS_MM, y: s.y + (s.y / d) * SIM_FINGER_RADIUS_MM }, pose)
    shapes.push({ kind: 'circle', x: away.x, y: away.y, r: SIM_FINGER_RADIUS_MM, heightMm: FINGER_HEIGHT_MM })
  }
  const phase = ((seq * 0.6180339887498949) % 1) * BIN_DEG
  // The C1 reports the angle it was actually at: rays at `a + phase`, labelled
  // `a + phase`. simulateScan labels `a` and shoots at rotation ± a, so turn
  // the mount by the phase (the other way when mirrored) and shift the labels.
  const scan = simulateScan(shapes, { pose: { ...pose, rotation: pose.rotation + (pose.mirrored ? -phase : phase) }, noiseMm: 4, seed: seq + 1 }, t)
  return { t: scan.t, points: scan.points.map((p) => ({ ...p, angle: +((p.angle + phase) % 360).toFixed(3) })) }
}

export type SimPointerPhase = 'down' | 'move' | 'up'
export type SimPointerResult = { ok: true; down: boolean } | { ok: false; status: 409; error: string }

export interface SimState {
  /** The sim lidar is producing rotations (the overall view is open and kept it alive). */
  running: boolean
  attached: boolean
  pose: Pose
  /** The one simulated finger, projector px, or null. */
  pointer: { id: string; px: Point } | null
}

/**
 * The simulated lidar's controller: owns the virtual pose, the single
 * pointer, and the 10 Hz rotation clock, and plugs into the spatial service
 * as its lidar source (SpatialService.attachSim: refused when a real lidar is
 * configured, which is the whole "never mix sim and real scans" rule).
 *
 * Lifecycle: `enable()` attaches (once) and starts rotating; the page keeps
 * it alive with `heartbeat()`; with no heartbeat for `idleMs` it PAUSES, not
 * detaches: a registration the owner just made must survive a closed tab.
 * `reset()` is the explicit end: detach, drop the registration and baseline.
 */
export function createLidarSim(o: {
  spatial: Pick<SpatialService, 'attachSim' | 'detachSim' | 'simAttached'>
  pose?: Pose
  surface?: Pick<Surface, 'mmPerPx' | 'widthPx' | 'heightPx'>
  /** Drive rotations from outside (tests): no interval is started. */
  manual?: boolean
  /** Pause after this long without a heartbeat or pointer event. */
  idleMs?: number
  /** A pointer silent this long is released (the tab died with the finger down). */
  pointerIdleMs?: number
  now?: () => number
}) {
  const surface = o.surface ?? DEFAULT_SURFACE
  const pose = o.pose ?? SIM_DEFAULT_POSE
  const idleMs = o.idleMs ?? 30_000
  const pointerIdleMs = o.pointerIdleMs ?? 3000
  const clock = o.now ?? (() => Date.now())
  let hooks: Parameters<SimSourceFactory>[0] | null = null
  let stream: ReturnType<typeof createLidarStream> | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let running = false
  let pointer: { id: string; px: Point; at: number } | null = null
  let beatAt = clock()
  let seq = 0
  let sessionN = 0
  const t0 = Math.floor(clock())

  const source: SimSourceFactory = (h) => {
    hooks = h
    stream = createLidarStream({ now: h.now, staleMs: h.staleMs, onFrame: h.onFrame })
    return { snapshot: () => stream!.snapshot(), stop() { stopTimer(); stream?.stop(); stream = null; hooks = null; running = false } }
  }
  const stopTimer = () => {
    if (timer) clearInterval(timer)
    timer = null
  }
  const report = () => hooks?.onHealth(stream!.snapshot())

  /** One rotation. Public for tests, which drive the clock themselves. */
  function tick() {
    if (!running || !stream) return
    const at = clock()
    if (pointer && at - pointer.at > pointerIdleMs) pointer = null
    if (at - beatAt > idleMs) return void pause()
    seq++
    stream.receive(JSON.stringify(simulatedRotation(pointer?.px ?? null, pose, seq, t0 + seq * (1000 / SIM_HZ), surface)))
    report()
  }
  function pause() {
    if (!running) return
    running = false
    pointer = null
    stopTimer()
    stream?.disconnected()
    report()
  }
  const inBounds = (p: Point) => Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.y >= 0 && p.x <= surface.widthPx && p.y <= surface.heightPx

  return {
    source,
    tick,
    pause,
    state: (): SimState => ({ running, attached: o.spatial.simAttached(), pose: { ...pose }, pointer: pointer ? { id: pointer.id, px: { ...pointer.px } } : null }),
    /** Start (or resume) producing rotations. Refused while a real lidar is the source. */
    enable(): { ok: true } | { ok: false; reason: string } {
      const a = o.spatial.attachSim(source)
      if (!a.ok) return a
      beatAt = clock()
      if (running || !stream) return { ok: true }
      running = true
      // A fresh session per resume, as a reconnect: the tracker treats a new
      // session as a discontinuity and an old track can't continue through it.
      stream.connected(`sim-${++sessionN}`)
      if (!o.manual) timer = setInterval(tick, 1000 / SIM_HZ)
      timer?.unref?.()
      report()
      return { ok: true }
    },
    heartbeat() { beatAt = clock() },
    /** Detach entirely: the registration and baseline made against the virtual pose are dropped with it. */
    reset() {
      pause()
      o.spatial.detachSim()
    },
    /**
     * One simulated finger. `down` takes the pointer (409 when another is
     * down and still alive: one mouse, one finger), `move` follows it, `up`
     * lifts it. A pointer no event has touched for `pointerIdleMs` is
     * considered gone, so a closed tab can't leave a finger on the table.
     */
    pointer(phase: SimPointerPhase, id: string, px: Point | null): SimPointerResult {
      if (!running) return { ok: false, status: 409, error: 'the simulated lidar is off: open the overall view to start it' }
      const at = clock()
      beatAt = at
      if (pointer && at - pointer.at > pointerIdleMs) pointer = null
      if (phase === 'up') {
        if (pointer?.id === id) pointer = null
        return { ok: true, down: pointer !== null }
      }
      if (!px || !inBounds(px)) return { ok: false, status: 409, error: 'px is outside the projector' }
      if (phase === 'down') {
        if (pointer && pointer.id !== id) return { ok: false, status: 409, error: 'another simulated finger is down: one pointer at a time' }
        pointer = { id, px: { ...px }, at }
      } else {
        if (!pointer || pointer.id !== id) return { ok: false, status: 409, error: 'that finger is not down (it timed out): press again' }
        pointer = { id, px: { ...px }, at }
      }
      return { ok: true, down: true }
    },
  }
}
export type LidarSim = ReturnType<typeof createLidarSim>

/** "x,y,rotation" → a pose, else the default (a typo must not stop the server booting). */
export function simPoseFrom(raw: string | undefined): Pose {
  const v = raw?.split(',').map(Number)
  return v && v.length === 3 && v.every(Number.isFinite) ? { x: v[0]!, y: v[1]!, rotation: v[2]! } : SIM_DEFAULT_POSE
}
