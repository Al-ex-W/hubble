import { createHash, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { createLidarSource, type LidarFrame, type LidarSourceHealth } from '@hubble/room'
import { DEFAULT_SURFACE } from '@hubble/stage'
import { createCalibration, type CameraSource } from './calibration.ts'
import { keyboardRoi } from './cameraRoi.ts'
import type { HandObservation, MarkerObservationT } from './observations.ts'
import { createLocalizer } from './localize.ts'
import type { Corners } from '../../shared/markers/layout.ts'
import { pinchRatioOf } from '../../shared/hands/features.ts'
import type { Point } from './coordinates.ts'
import { hitSpatialSurface, type LocalizedPoint, type SpatialFrame, type SpatialSurfaces, type SpatialTouch } from './frame.ts'
import { buildBaseline, foreground, type Baseline } from './baseline.ts'
import { createAutoBaseline } from './autoBaseline.ts'
import { clusters, createTracker, type Cluster, type TouchEvent } from './touch.ts'
import { measureFinger, type FingerCapture } from './capture.ts'

/**
 * A lidar touch as the spatial service reports it (#89): the tracker's event
 * plus where it lands on the projector. Consumers (the runtime's ripple, later
 * the keyboard) get positions from here and never map raw returns themselves.
 */
export type SpatialTouchEvent = TouchEvent & { projector: Point | null; sourceSession: string }

/** What the service needs of a lidar source: the real socket and the simulated one both fit. */
export interface LidarSourceLike { snapshot(): LidarSourceHealth; stop(): void }
export interface LidarHooks { onFrame(frame: LidarFrame): void; onHealth(health: LidarSourceHealth): void }
/** Builds a simulated source around the service's hooks, clock and staleness limit. */
export type SimSourceFactory = (hooks: LidarHooks & { now: () => number; staleMs: number }) => LidarSourceLike

/**
 * The table edge, inset: a return within 15 mm of the projection's edge is
 * too close to the cloth's border, the table's own edge, or a person's belly
 * leaning on it to mean a finger on the projection.
 */
const TABLE_INSET_MM = 15

/**
 * Silence longer than this means the lidar's evidence for every live track is
 * gone. One value, passed to the source as its staleMs AND used below to judge
 * the gap before a resumed rotation (Codex P2 on #90), so "stale" can't mean
 * two different things in the source and here. 350 ms is the source's own
 * default: ~3.5 C1 rotations at 10 Hz, past any normal Wi-Fi jitter.
 */
const LIDAR_STALE_MS = 350

// Marker ingestion limits (review of #95, finding 4). 100 ms: the iPad
// posts every 500 ms and the room camera delivers a still every 1–3 s, so
// 10/s per source is far above any honest producer and still bounds a
// flood. 16 sessions: an iPad reloaded through a whole demo day stays
// remembered, and the map can't grow without bound.
export const MARKER_MIN_INTERVAL_MS = 100
const MARKER_SESSIONS = 16

/** One reconciliation owner. Detectors submit measurements; features subscribe
 * to a complete frame. No feature remaps raw joints/returns or independently
 * samples calibration and surface state. The camera's table-plane projection
 * is not measured 3D, and the laser's scan plane is not pressure/contact.
 */
export function createSpatialService(opts: { lidarUrl?: string; registrationFile?: string; anchorsFile?: string; now?: () => number } = {}) {
  const now = opts.now ?? (() => performance.now())
  const calibration = createCalibration(opts.registrationFile, createHash('sha256').update(opts.lidarUrl ?? 'no-lidar').digest('hex'))
  const session = randomUUID()
  // Markers → camera maps (#91). The localizer decides; it installs through
  // this service's own calibration, so the marker path and the dot path end
  // in the same setCamera and nothing else holds a camera map.
  const localizer = createLocalizer({
    surface: DEFAULT_SURFACE,
    install: (source, value) => calibration.setCamera(value, source as CameraSource),
    installed: (source) => calibration.cameraFor(source as CameraSource),
    anchorsFile: opts.anchorsFile,
  })
  // Per source: the last seq of each session seen (a returning old session
  // can't replay its frames), and when the last frame was accepted (the
  // rate limit). Bounded: only the newest MARKER_SESSIONS per source.
  const markerProgress = new Map<CameraSource, { sessions: Map<string, number>; acceptedAt: number }>()
  let stopped = false
  let latest: { frame: LidarFrame; revision: number } | null = null
  let health: LidarSourceHealth | null = null
  // One lease per camera source (#91). `interval` is an EWMA of the
  // server's receipt intervals for that source: the measured rate the
  // selection below compares, not a rate the client claims.
  type Lease = { frame: HandObservation; at: number; revision: number; interval: number | null }
  const leases = new Map<CameraSource, Lease>()
  // The source the published frame reads from, kept until a clearly better
  // one is live: flapping between two sources would cancel every press
  // (keyboardInput treats a session change as a discontinuity).
  let selected: CameraSource | null = null
  let surfaces: SpatialSurfaces = { list: () => [], bounds: () => DEFAULT_SURFACE, subscribe: () => () => {} }
  let unsubscribeSurfaces = () => {}
  const observers = new Set<(frame: SpatialFrame) => void>()
  let value: SpatialFrame
  let key = ''
  let seq = 0
  let publishing = false
  const queued: { frame: SpatialFrame; readers: ((frame: SpatialFrame) => void)[] }[] = []
  // Lidar touch (#89). The baseline is in the lidar's own frame (angle, range),
  // so it survives a new registration (that only moves where the table is) and
  // a socket reconnect (a Wi-Fi drop doesn't move the lidar). It does NOT
  // survive a restart: it lives in memory only, because the table it learned
  // changes during the day (the MiniLab and iPad move between acts), and a
  // persisted baseline would silently hide whatever was moved onto its old
  // spot. Taking one is 3 s with hands clear. Since the demo boot (7 Oct)
  // it is also taken AUTOMATICALLY (autoBaseline.ts says when and why): 5 s
  // after receiving starts, and again after 20 s of a still table, never with
  // a touch down. The POST stays as the override.
  const auto = createAutoBaseline()
  let lidar: LidarSourceLike | null = null
  let simAttached = false
  let baseline: Baseline | null = null
  let capture: { frames: LidarFrame[]; done: (r: { ok: true; rotations: number } | { ok: false; reason: string }) => void } | null = null
  const tracker = createTracker()
  // A registration capture (#89 T4, docs/plans/2026-10-07-lidar-web.md): the
  // rotations of one held fingertip, collected from the same frame feed as the
  // baseline capture. Its own slot, not the baseline's: the two must never
  // share frames (a baseline learned with a finger on the table is blind there).
  let fingerFrames: LidarFrame[] | null = null
  const touchListeners = new Set<(e: SpatialTouchEvent) => void>()
  // The registration wizard's view (lidarWizard.ts): finger-sized foreground
  // clusters in the lidar's OWN frame, before any registration. It can't use
  // touches: those need the registration it is about to measure.
  const clusterListeners = new Set<(found: Cluster[], at: number) => void>()

  function publish(frame: SpatialFrame, readers = [...observers]) {
    // Keyboard commits can synchronously change surfaces while receiving a
    // frame. Recursive fan-out would deliver N+1 before N to later observers.
    // Drain in order; a private copy per observer prevents annotation/sorting
    // by one feature from corrupting another feature's evidence.
    // Capture readers at publication, not delivery. A subscription installed
    // inside another callback gets its current snapshot once; it must not also
    // inherit older publications still being drained to existing readers.
    queued.push({ frame, readers })
    if (publishing) return
    publishing = true
    try {
      while (queued.length) {
        const next = queued.shift()!
        for (const observer of next.readers) if (observers.has(observer)) observer(structuredClone(next.frame))
        // stop() may itself be called from a subscriber. Release listeners only
        // after the queued final state has reached them, including HTTP writers.
        if (next.frame.state === 'stopped') observers.clear()
      }
    } finally { publishing = false }
  }

  /**
   * Which source the published camera reads from: among sources with a
   * fresh frame under the current calibration whose geometry matches their
   * own map, the one with the shortest measured interval (best fps). The
   * current one is kept unless another is at least 25 % faster.
   */
  function choose(at: number, cal: ReturnType<typeof calibration.snapshot>): CameraSource | null {
    const usable = [...leases].filter(([src, l]) => {
      const map = cal.cameras[src]
      return at - l.at < 500 && l.revision === cal.revision && map && map.geometry === l.frame.geometry && map.width === l.frame.width && map.height === l.frame.height
    })
    if (!usable.length) return null
    const speed = (l: Lease) => l.interval ?? Number.POSITIVE_INFINITY
    usable.sort((a, b) => speed(a[1]) - speed(b[1]))
    const [bestSrc, best] = usable[0]!
    const current = usable.find(([src]) => src === selected)
    // "25 % faster" in RATE: fps_best ≥ 1.25 × fps_current, i.e. interval
    // below current / 1.25 (= 0.8×). Not 0.75× the interval: that asks for
    // 33⅓ % more fps, so a 13 fps iPad never took over from a 10 fps room
    // camera (Codex review of #95, finding 7).
    if (current && !(speed(best) < speed(current[1]) / 1.25)) return current[0]
    return bestSrc
  }

  function emitTouches(events: TouchEvent[], sourceSession: string) {
    for (const e of events) {
      const out: SpatialTouchEvent = { ...e, projector: calibration.tableToProjector(e.table), sourceSession }
      for (const l of touchListeners) l(out)
    }
  }
  /** Cancel every live track: the evidence it was built on is gone or changed. */
  function cancelTouches() {
    emitTouches(tracker.reset(), latest?.frame.sourceSession ?? '')
  }
  /** Inside the projection, inset, using the registered table → projector map. */
  function onTable(table: Point) {
    const p = calibration.tableToProjector(table)
    if (!p) return false
    const b = surfaces.bounds()
    const inset = TABLE_INSET_MM / b.mmPerPx
    return p.x >= inset && p.y >= inset && p.x <= b.widthPx - inset && p.y <= b.heightPx - inset
  }
  /** Why touch is off, or null when it's on. One place, read by the frame and by touch processing. */
  function touchBlocked(): string | null {
    if (!lidar) return 'No lidar configured (LIDAR_URL)'
    if (!calibration.snapshot().registration) return 'Lidar not registered to the table: run the registration'
    if (!baseline) return 'No empty-table baseline: clear the table and capture one'
    if (health?.state !== 'receiving') return `Lidar ${health?.state ?? 'unavailable'}`
    return null
  }
  function touchFrame(frame: LidarFrame) {
    if (!baseline || !calibration.snapshot().registration) return
    const found = clusters(foreground(frame.points, baseline), (sensor) => calibration.lidarToTable(sensor), onTable)
    emitTouches(tracker.update(frame.sourceSession, found), frame.sourceSession)
  }

  function refresh() {
    const at = now()
    const cal = calibration.snapshot()
    if (!stopped) selected = choose(at, cal) ?? selected
    // For the published frame: the selected source's lease, else (nothing
    // usable) the freshest lease, so the state still says why (stale,
    // uncalibrated, geometry-mismatch) instead of a bare "unavailable".
    const hands = (selected && leases.get(selected)) || [...leases.values()].sort((a, b) => b.at - a.at)[0] || null
    const source: CameraSource | null = hands ? ([...leases].find(([, l]) => l === hands)![0]) : null
    const sourceMap = source ? (cal.cameras[source] ?? null) : null
    const active = !stopped && hands && at - hands.at < 500 && hands.revision === cal.revision ? hands.frame : null
    const current = !stopped && health?.state === 'receiving' && latest?.frame.sourceSession === health.sourceSession && latest.revision === cal.revision ? latest.frame : null
    const geometry = surfaces.list().map(s => ({ id: s.id, kind: s.kind, instance: s.instance, box: { ...s.box }, z: s.z }))
    const bounds = { ...surfaces.bounds() }
    // Only evidence/lifecycle/geometry changes publish. Text updates do not
    // constitute a new spatial measurement, nor does a reader polling GET.
    // Expiry is part of the key: silence must publish without any new packet.
    const touches: SpatialTouch[] = stopped ? [] : tracker.tracks().map((t) => ({ ...t, projector: calibration.tableToProjector(t.table) }))
    const blocked = touchBlocked()
    const baselineState = { state: capture ? ('capturing' as const) : baseline ? ('ready' as const) : ('none' as const), rotations: baseline?.rotations ?? 0 }
    const nextKey = JSON.stringify([stopped, cal.revision, source, hands?.frame.session, hands?.frame.seq, !!active, [...leases].map(([k, l]) => [k, at - l.at < 500]), health, !!current, geometry, bounds, touches, blocked, baselineState])
    if (value && key === nextKey) return
    key = nextKey
    const locate = (projector: Point | null, table = projector ? calibration.projectorToTable(projector) : null): LocalizedPoint => {
      const surfaceId = projector ? hitSpatialSurface({ surfaces: geometry }, projector) : null
      const target = geometry.find(s => s.id === surfaceId)
      const localPx = projector && target ? { x: projector.x - target.box.x, y: projector.y - target.box.y } : null
      return { projector, table, surfaceId, surface: target && localPx ? {
        id: target.id, instance: target.instance, localPx,
        // Stage includes edges, including a zero-area answer awaiting layout.
        // Such an anchor can be hit but has no normalized interior yet.
        normalized: target.box.w > 0 && target.box.h > 0 ? { x: localPx.x / target.box.w, y: localPx.y / target.box.h } : null,
      } : null }
    }
    value = {
      schema: 'SpatialFrame/v2', session, seq: ++seq, atMonoMs: at,
      state: stopped ? 'stopped' : 'running',
      mode: 'diagnostic', calibrated: Boolean(Object.keys(cal.cameras).length && cal.registration),
      // Lidar touch (#89): a finger crossing the scan plane inside the
      // registered projection. Not pressure: a finger hovering below the
      // plane (30–67 mm, research) also counts. Fine for the ripple; the
      // keyboard's use of it is gated separately (plan Decision 12).
      touchEnabled: !stopped && blocked === null,
      reason: stopped ? 'Stopped' : blocked ?? 'Lidar touch: a finger crossing the scan plane, not pressure',
      coordinates: { table: 'millimetres, z=0 plane', projector: 'page pixels', height: 'unmeasured' },
      surface: bounds, surfaces: geometry, calibration: cal,
      camera: {
        state: !hands ? 'unavailable' : !active ? 'stale' : !sourceMap ? 'uncalibrated'
          : active.geometry !== sourceMap.geometry || active.width !== sourceMap.width || active.height !== sourceMap.height ? 'geometry-mismatch' : 'receiving',
        source,
        sources: [...leases].map(([id, l]) => ({ id, fresh: at - l.at < 500, fps: l.interval ? Math.round(1000 / l.interval) : null, calibrated: Boolean(cal.cameras[id]) })),
        frame: active ? structuredClone(active) : null,
        calibrationRevision: hands?.revision ?? null,
        receivedAtMonoMs: hands?.at ?? null, ageMs: hands ? at - hands.at : null, acquisitionAgeMs: null,
        fingers: (active?.hands ?? []).map(({ index, pinch }, i) => {
          const project = (p: Point) => calibration.cameraPoint(p, active!.width, active!.height, active!.geometry, source!)
          return {
            index: i, camera: { ...index }, ...locate(project(index)),
            pen: pinch ? locate(project({ x: (index.x + pinch.thumb.x) / 2, y: (index.y + pinch.thumb.y) / 2 })) : null,
            pinch: pinch && Math.hypot(pinch.wrist.x - pinch.middle.x, pinch.wrist.y - pinch.middle.y) > 1
              ? pinchRatioOf(index, pinch.thumb, pinch.wrist, pinch.middle) : null,
            heightMm: null, contact: 'unknown',
          }
        }),
      },
      lidar: {
        health: health ? { ...health } : null, frame: current ? structuredClone(current) : null,
        calibrationRevision: latest?.revision ?? null,
        baseline: baselineState,
        touches,
        returns: (current?.points ?? []).filter(p => p.distance > 0).map(p => {
          const a = p.angle * Math.PI / 180
          const sensor = { x: p.distance * Math.cos(a), y: p.distance * Math.sin(a) }
          const table = calibration.lidarToTable(sensor)
          return { sensor, ...locate(table ? calibration.tableToProjector(table) : null, table), quality: p.quality }
        }),
      },
    }
    publish(value)
  }

  refresh()
  // A new registration moves every track's table position under it: cancel
  // rather than let a touch jump across the table mid-gesture.
  const unsubscribeCalibration = calibration.subscribe(() => { if (!stopped) { cancelTouches(); refresh() } })
  // The lidar is ONE source at a time: the real socket (LIDAR_URL) or, on a
  // machine with no real lidar, the simulated one (attachSim below). `lidarHooks`
  // is what any source reports into, so a simulated rotation goes through exactly
  // the path a real one does: baseline, clusters, tracker, touches. Nothing
  // downstream can tell which it is, which is the point of the simulation.
  const lidarHooks: LidarHooks = {
    onFrame: frame => {
      if (stopped) return
      // A rotation after a stale gap: cancel the old tracks BEFORE this frame
      // is associated (Codex P2 on #90). The 50 ms health timer usually sees
      // the silence first and cancels via onHealth, but not always: when the
      // event loop was busy (or the clock jumped), the resumed packet arrives
      // before any timer ran, the source goes straight from receiving to
      // receiving with no stale report, and the tracker stitched the finger
      // after the gap onto the track from before it (candidate -> down -> move,
      // no cancel; the snapshot said stale meanwhile). A new tap near the old
      // spot then never rippled. Judged on the source's own receive clock, so
      // it is independent of whether any timer fired.
      const prev = latest?.frame
      if (prev && prev.sourceSession === frame.sourceSession && frame.receivedAtMonoMs - prev.receivedAtMonoMs >= LIDAR_STALE_MS) cancelTouches()
      latest = { frame, revision: calibration.snapshot().revision }
      health = lidar!.snapshot()
      if (capture) capture.frames.push(frame)
      if (baseline && clusterListeners.size) {
        const found = clusters(foreground(frame.points, baseline), (sensor) => sensor, () => true)
        for (const l of clusterListeners) l(found, frame.receivedAtMonoMs)
      }
      if (fingerFrames) fingerFrames.push(frame)
      touchFrame(frame)
      const touchDown = tracker.tracks().length > 0
      auto.frame(frame, frame.receivedAtMonoMs, touchDown)
      if (!capture && auto.shouldTake(frame.receivedAtMonoMs, !!baseline, touchDown)) {
        auto.took(frame.receivedAtMonoMs)
        void service.captureBaseline().then(r => { if (!r.ok) console.warn(`spatial: automatic baseline failed: ${r.reason}`) })
      }
      refresh()
    },
    onHealth: next => {
      health = next
      if (stopped) return
      // Silence or a dropped socket means no misses will ever arrive to end a
      // track, so a held touch would stay "down" forever. End it as cancel:
      // nobody observed a lift.
      if (next.state !== 'receiving') { cancelTouches(); if (next.state !== 'stale') auto.lost() }
      refresh()
    },
  }
  if (opts.lidarUrl) lidar = createLidarSource({ url: opts.lidarUrl, now, staleMs: LIDAR_STALE_MS, ...lidarHooks })

  // The source owns lidar progress and expiry; this timer also notices camera
  // silence. It never opens a device: all transport still uses the room pool.
  const tick = () => { if (!stopped) { if (lidar) health = lidar.snapshot(); refresh() } }
  const timer = setInterval(tick, 50)
  timer.unref()

  const service = {
    calibration,
    subscribe(observer: (frame: SpatialFrame) => void) {
      tick()
      if (stopped) { observer(structuredClone(value)); return () => {} }
      observers.add(observer)
      publish(value, [observer])
      return () => { observers.delete(observer) }
    },
    followSurfaces(source: SpatialSurfaces) {
      if (stopped) return
      unsubscribeSurfaces()
      surfaces = source
      unsubscribeSurfaces = source.subscribe(refresh)
      refresh()
    },
    observe(frame: HandObservation) {
      if (stopped) return false
      const src: CameraSource = frame.source ?? 'room'
      const hands = leases.get(src)
      // One short producer lease PER SOURCE; duplicates/reordered packets
      // neither extend it nor create confirmation votes. Clocks are compared
      // only within a source session, never browser performance.now against
      // Pi epoch time. Two tabs both claiming to be the room camera still
      // compete exactly as before; the iPad no longer competes with them.
      if (hands && now() - hands.at < 500) {
        if (hands.frame.session !== frame.session) return false
        if (frame.seq <= hands.frame.seq || frame.capturedAt <= hands.frame.capturedAt) return false
      } else if (hands?.frame.session === frame.session && (frame.seq <= hands.frame.seq || frame.capturedAt <= hands.frame.capturedAt)) return false
      const at = now()
      // EWMA of receipt intervals, only across a live lease of one session:
      // a gap after silence is not this source's frame rate.
      const gap = hands && hands.frame.session === frame.session && at - hands.at < 500 ? at - hands.at : null
      const interval = gap === null ? (hands?.interval ?? null) : hands?.interval == null ? gap : hands.interval + 0.2 * (gap - hands.interval)
      leases.set(src, { frame: structuredClone(frame), at, revision: calibration.snapshot().revision, interval })
      tick()
      return true
    },
    snapshot(): SpatialFrame { tick(); return structuredClone(value) },
    /**
     * One frame of reference markers from a camera (#91). Within a session
     * only a newer seq counts, and an older session coming back can't
     * replay (so a reordered or replayed packet can't vote twice in the
     * smoothing); at most one frame per MARKER_MIN_INTERVAL_MS per source
     * (review of #95, finding 4: the route is open to the LAN, and each
     * frame costs a RANSAC over up to 120 pairs). Returns that source's
     * localization state, or why it was refused.
     */
    markers(frame: MarkerObservationT): { ok: true; state: ReturnType<typeof localizer.frame> } | { ok: false; reason: 'stale' | 'rate' | 'stopped' } {
      if (stopped) return { ok: false, reason: 'stopped' }
      const at = now()
      let p = markerProgress.get(frame.source)
      if (!p) markerProgress.set(frame.source, (p = { sessions: new Map(), acceptedAt: Number.NEGATIVE_INFINITY }))
      const last = p.sessions.get(frame.session)
      if (last !== undefined && frame.seq <= last) return { ok: false, reason: 'stale' }
      if (at - p.acceptedAt < MARKER_MIN_INTERVAL_MS) return { ok: false, reason: 'rate' }
      p.acceptedAt = at
      p.sessions.delete(frame.session)
      p.sessions.set(frame.session, frame.seq)
      if (p.sessions.size > MARKER_SESSIONS) p.sessions.delete(p.sessions.keys().next().value!)
      return { ok: true, state: localizer.frame({ source: frame.source, session: frame.session, width: frame.width, height: frame.height, geometry: frame.geometry, markers: frame.markers.map((m) => ({ id: m.id, corners: m.corners as Corners })) }) }
    },
    /** A reference run starts or ends: projected marker ids count only during one. */
    setProjecting: (on: boolean) => localizer.setProjecting(on),
    /** What the localizer knows, for the operator and the iPad page. */
    localization() {
      const cal = calibration.snapshot()
      return {
        projecting: localizer.projecting(),
        anchors: localizer.anchors(),
        targets: localizer.targetIds(),
        sources: localizer.state(),
        calibrated: Object.keys(cal.cameras),
        revision: cal.revision,
      }
    },
    /**
     * Learn the empty table from the next `ms` of rotations (#89). The
     * operator clears the table first; nothing here can check that, which is
     * why the POST is the override and the automatic take (autoBaseline.ts) waits for a still table (a baseline taken with
     * a hand on the table makes that spot blind). Replaces the old baseline
     * only on success; live tracks are cancelled because their foreground was
     * judged against the old one.
     */
    captureBaseline(ms = 3000): Promise<{ ok: true; rotations: number } | { ok: false; reason: string }> {
      if (stopped || !lidar) return Promise.resolve({ ok: false, reason: 'No lidar configured (LIDAR_URL)' })
      if (capture) return Promise.resolve({ ok: false, reason: 'A baseline capture is already running' })
      return new Promise((resolve) => {
        const c: NonNullable<typeof capture> = { frames: [], done: resolve }
        capture = c
        refresh()
        setTimeout(() => {
          if (capture !== c) return
          capture = null
          const built = buildBaseline(c.frames)
          if (built.ok) {
            baseline = built.baseline
            cancelTouches()
          }
          refresh()
          resolve(built.ok ? { ok: true, rotations: built.baseline.rotations } : built)
        }, ms).unref()
      })
    },
    clearBaseline() {
      // Settle a pending capture first (Codex P2 on #90). Without this, a
      // capture started before the clear finished afterwards and installed
      // its baseline, turning touch back on behind the operator's "clear".
      // Nulling `capture` is the generation token: the capture's timer checks
      // `capture !== c` and drops its result; resolving here means the caller
      // awaiting it isn't left hanging forever.
      if (capture) {
        const c = capture
        capture = null
        c.done({ ok: false, reason: 'Baseline cleared during capture' })
      }
      baseline = null
      cancelTouches()
      refresh()
    },
    /**
     * Where one held fingertip is, in the lidar's own mm, over the next `ms`
     * (#89 T4). Needs the baseline (a finger is foreground) but NOT a
     * registration: this is how a registration is measured. The rulings
     * (one finger, held, still) are capture.ts's.
     */
    captureFinger(ms = 1500): Promise<FingerCapture | { ok: false; reason: 'unavailable'; detail: string; rotations: 0 }> {
      const unavailable = (detail: string) => Promise.resolve({ ok: false as const, reason: 'unavailable' as const, detail, rotations: 0 as const })
      if (stopped || !lidar) return unavailable('No lidar configured (LIDAR_URL)')
      if (!baseline) return unavailable('No empty-table baseline: clear the table and capture one first')
      if (capture) return unavailable('A baseline capture is running')
      if (fingerFrames) return unavailable('A finger capture is already running')
      const frames: LidarFrame[] = []
      fingerFrames = frames
      return new Promise((resolve) => {
        setTimeout(() => {
          if (fingerFrames === frames) fingerFrames = null
          // The baseline may have been cleared meanwhile: then there is no
          // foreground to judge, and the capture is void.
          resolve(baseline ? measureFinger(frames, baseline) : { ok: false, reason: 'unavailable', detail: 'Baseline cleared during the capture', rotations: 0 })
        }, ms).unref()
      })
    },
    /**
     * Use a SIMULATED lidar as the source (the overall view's touch simulation,
     * docs/plans/2026-10-07-overall-view.md). Refused whenever a real lidar is
     * configured: one service must never hold two scan sources, or a simulated
     * finger would be mixed into a real table's baseline and touches. The
     * refusal lives HERE, not only in the route, because this is the one place
     * that owns the source; a caller that skips the route still can't mix them.
     */
    attachSim(make: SimSourceFactory): { ok: true } | { ok: false; reason: string } {
      if (stopped) return { ok: false, reason: 'The spatial service is stopped' }
      if (opts.lidarUrl) return { ok: false, reason: 'A real lidar is configured (LIDAR_URL): the simulated lidar never runs beside it' }
      if (lidar) return { ok: true }
      // Before anything from the sim can register: its fit must stay in memory
      // (calibration.ts setVolatile says why), and a registration measured on
      // the real table is not valid for the virtual pose, so it is not used.
      calibration.setVolatile(true)
      if (calibration.snapshot().registration) calibration.clearRegistration()
      lidar = make({ ...lidarHooks, now, staleMs: LIDAR_STALE_MS })
      simAttached = true
      health = lidar.snapshot()
      refresh()
      return { ok: true }
    },
    /** Stop the simulated source. Everything it taught the service (baseline, tracks) is dropped: it was never the real table. */
    detachSim() {
      if (!simAttached || !lidar) return
      lidar.stop()
      lidar = null
      simAttached = false
      // The sim's registration is for the virtual pose only: drop it (still
      // volatile, so the file is untouched) and only then return to saving.
      calibration.clearRegistration()
      calibration.setVolatile(false)
      health = null
      latest = null
      baseline = null
      cancelTouches()
      auto.lost()
      refresh()
    },
    simAttached: () => simAttached,
    /** Lidar touch events, in table mm and projector px. Returns the unsubscribe. */
    onTouch(listener: (e: SpatialTouchEvent) => void) {
      touchListeners.add(listener)
      return () => { touchListeners.delete(listener) }
    },
    /**
     * Finger-sized foreground clusters per rotation, in lidar Cartesian mm,
     * with the rotation's receive time (#lidar-wizard). Only while a baseline
     * exists: without one, everything on the table is foreground.
     */
    onClusters(listener: (found: Cluster[], at: number) => void) {
      clusterListeners.add(listener)
      return () => { clusterListeners.delete(listener) }
    },
    /** Why lidar input can't be used right now (no lidar, no baseline, not receiving), or null. */
    lidarBlocked(): string | null {
      if (!lidar) return 'No lidar configured (LIDAR_URL)'
      if (!baseline) return 'No empty-table baseline: clear the table and capture one'
      if (health?.state !== 'receiving') return `Lidar ${health?.state ?? 'unavailable'}`
      return null
    },
    /**
     * The camera crop for the open keyboard (#84), from this service's own
     * two inputs: the surface set and the camera map. null = stream the full
     * frame (no keyboard open, or no camera calibration).
     */
    cameraRoi() {
      const kb = surfaces.list().find((s) => s.kind === 'keyboard')
      return keyboardRoi(kb ? kb.box : null, calibration.projectorToCamera, calibration.cameraFrame())
    },
    stop() {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      unsubscribeCalibration()
      unsubscribeSurfaces()
      lidar?.stop()
      cancelTouches()
      touchListeners.clear()
      clusterListeners.clear()
      capture?.done({ ok: false, reason: 'Stopped' })
      fingerFrames = null
      capture = null
      latest = null
      leases.clear()
      selected = null
      refresh()
    },
  }
  return service
}
export type SpatialService = ReturnType<typeof createSpatialService>
