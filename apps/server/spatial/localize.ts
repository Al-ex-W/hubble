import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { apply, residual, solveHomography, type H, type Pair } from '@hubble/room'
import { PHYSICAL_IDS, PROJECTED_IDS, projectedMarkers, type Corners, type Marker } from '../../shared/markers/layout.ts'
import { inverse, validTransform, type Point } from './coordinates.ts'
import type { CameraRegistration } from './calibration.ts'

/**
 * Camera → table localization from reference markers (#91): the hard part,
 * isolated (AGENTS.md §3). Detectors (the iPad page, the server's room-camera
 * pass) only report marker corners in camera px. This module alone decides
 * whether those corners define a trustworthy camera map, and when that map
 * replaces the one the spatial calibration holds. Nothing else fits markers;
 * the dot calibration (calibration.ts) stays the room's fallback.
 *
 * "Table px" here means projector page px, the frame every camera map in
 * spatial/calibration.ts maps INTO (the dot calibration's own target).
 */

// Ruling (plan): a marker whose four corners don't all land within this many
// table px of where the layout says is an outlier (moved, misread, occluded
// corner). Contour corners from js-aruco2 measured 2.3 table px mean error on
// the composited fixtures, max 3.8; 6 leaves room for that and nothing more.
const INLIER_PX = 6
// Ruling (plan): the gate. Above this, the frame's fit is reported but never
// installed. The dot calibration's recorded run fits 3.75 rms; its own
// GOOD_RMS is 6. A marker map must be at least as good as a decent dot run.
export const MAX_RMS = 4
// Ruling (plan): fewer than 3 markers (12 points) can be fitted exactly
// with nothing left over to check it against.
const MIN_MARKERS = 3
// Ruling (plan): the inlier markers must span this share of the surface in
// both axes. Markers in one row fit a plane that is right along the row and
// arbitrary across it, with a beautiful RMS.
const MIN_SPREAD = 0.25
// Ruling (plan): install only when the new map moves some table point by at
// least this much. Every install bumps the calibration revision, and pinch
// typing's grant is bound to that revision (keyboardInput.ts): re-installing
// "the same map within noise" on every frame would make typing impossible.
export const SWITCH_PX = 3
// Ruling (plan): a frame that disagrees with the smoothed map by more than
// this means the camera moved (the iPad was nudged). Follow it: reset the
// filter instead of blending two different poses into a third, wrong one.
const RESET_PX = 15
// EMA weight of a new frame. 0.3 settles in ~5 frames (1–2 s on the room
// camera, under a second on the iPad) and averages corner noise ~2x down.
const ALPHA = 0.3
// Accepted frames needed after a reset before the first install: one lucky
// frame must not become the map.
const CONFIRM = 3

export interface Fit {
  ok: true
  /** Camera px → table px. */
  h: H
  /** RMS over the inlier markers' corners, table px. */
  rms: number
  markers: number[]
  rejected: number[]
}
export type FitResult = Fit | { ok: false; error: string; markers: number[]; rejected: number[]; rms?: number }

const pairsOf = (m: Marker, target: Corners): Pair[] => m.corners.map((c, i) => ({ from: c, to: target[i]! }))
const centre = (c: Corners) => ({ x: (c[0].x + c[1].x + c[2].x + c[3].x) / 4, y: (c[0].y + c[1].y + c[2].y + c[3].y) / 4 })

/**
 * Fit one frame's markers to their known table positions.
 *
 * RANSAC at marker level, exhaustively: every PAIR of markers (8 points)
 * proposes a map, and each marker votes as a whole (all four corners within
 * INLIER_PX). Exhaustive over pairs because there are at most 16 markers
 * (120 pairs): deterministic, so the tests can't flake and an on-site
 * result reproduces from its recording. Votes are per marker, not per
 * corner, because the failures we expect are whole markers: a printed one
 * moved since its anchor was learned, a misread id.
 */
export function fitMarkers(seen: Marker[], targets: Map<number, Corners>, surface: { widthPx: number; heightPx: number }): FitResult {
  const usable = seen.filter((m) => targets.has(m.id))
  const ids = usable.map((m) => m.id)
  // A duplicated id is a misread (or a forged frame): the same marker twice
  // would vote twice, and three copies of two markers would pass the
  // three-marker minimum (review of #95, finding 4). The wire schema refuses
  // it too; this covers the server's own room-camera pass.
  if (new Set(ids).size !== ids.length) return { ok: false, error: 'the same marker id appears twice in one frame', markers: [], rejected: ids }
  if (usable.length < MIN_MARKERS) return { ok: false, error: `${usable.length} known markers in view, need ${MIN_MARKERS}`, markers: ids, rejected: [] }
  let best: { inliers: Marker[]; err: number } | null = null
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      let h: H
      try {
        h = solveHomography([...pairsOf(usable[i]!, targets.get(usable[i]!.id)!), ...pairsOf(usable[j]!, targets.get(usable[j]!.id)!)])
      } catch {
        continue
      }
      if (!validTransform(h)) continue
      let err = 0
      const inliers = usable.filter((m) => {
        const t = targets.get(m.id)!
        const worst = Math.max(...m.corners.map((c, k) => {
          const p = apply(h, c)
          return Math.hypot(p.x - t[k]!.x, p.y - t[k]!.y)
        }))
        if (worst <= INLIER_PX) err += worst
        return worst <= INLIER_PX
      })
      if (!best || inliers.length > best.inliers.length || (inliers.length === best.inliers.length && err < best.err)) best = { inliers, err }
    }
  }
  let inliers = best?.inliers ?? []
  // A pair of neighbouring markers extrapolated across the table magnifies
  // their corner noise, so the best pair's vote can miss good far markers.
  // Refit on the whole consensus and vote again until it stops changing
  // (in practice once): the consensus fit is far stiffer than any pair.
  for (let round = 0; round < 3 && inliers.length >= MIN_MARKERS; round++) {
    const h = solveHomography(inliers.flatMap((m) => pairsOf(m, targets.get(m.id)!)))
    const next = usable.filter((m) => {
      const t = targets.get(m.id)!
      return m.corners.every((c, k) => {
        const p = apply(h, c)
        return Math.hypot(p.x - t[k]!.x, p.y - t[k]!.y) <= INLIER_PX
      })
    })
    if (next.length < MIN_MARKERS || next.map((m) => m.id).join() === inliers.map((m) => m.id).join()) break
    inliers = next
  }
  const rejected = ids.filter((id) => !inliers.some((m) => m.id === id))
  if (inliers.length < MIN_MARKERS) return { ok: false, error: `only ${inliers.length} markers agree on one plane`, markers: inliers.map((m) => m.id), rejected }
  const centres = inliers.map((m) => centre(targets.get(m.id)!))
  const spanX = Math.max(...centres.map((c) => c.x)) - Math.min(...centres.map((c) => c.x))
  const spanY = Math.max(...centres.map((c) => c.y)) - Math.min(...centres.map((c) => c.y))
  if (spanX < MIN_SPREAD * surface.widthPx || spanY < MIN_SPREAD * surface.heightPx)
    return { ok: false, error: 'the markers in view are bunched in one strip: the plane across it is a guess', markers: inliers.map((m) => m.id), rejected }
  const pairs = inliers.flatMap((m) => pairsOf(m, targets.get(m.id)!))
  const h = solveHomography(pairs)
  const rms = residual(h, pairs)
  if (!validTransform(h) || !Number.isFinite(rms)) return { ok: false, error: 'the markers do not define an invertible plane map', markers: inliers.map((m) => m.id), rejected }
  return { ok: true, h, rms, markers: inliers.map((m) => m.id), rejected }
}

/** Table points every map comparison is made on: a 5×4 grid over the surface. */
function grid(surface: { widthPx: number; heightPx: number }): Point[] {
  const out: Point[] = []
  for (let y = 0; y < 4; y++) for (let x = 0; x < 5; x++) out.push({ x: (x / 4) * surface.widthPx, y: (y / 3) * surface.heightPx })
  return out
}

/** Largest distance, in table px, between where two camera→table maps send the same table point's camera image. */
export function mapDistance(a: H, b: H, surface: { widthPx: number; heightPx: number }): number {
  const bInv = inverse(b)
  if (!bInv) return Infinity
  return Math.max(...grid(surface).map((g) => {
    const p = apply(a, apply(bInv, g))
    return Math.hypot(p.x - g.x, p.y - g.y)
  }))
}

export interface MarkerFrame {
  source: string
  /** The producer's session (the iPad page's load, a reference run). A new one restarts confirmation. */
  session?: string
  width: number
  height: number
  geometry: string
  markers: Marker[]
}

export interface SourceState {
  /** The last frame's outcome. */
  last: { at: number; ok: boolean; rms: number | null; markers: number[]; rejected: number[]; error: string | null } | null
  /** Accepted frames since the filter last reset. */
  confirmed: number
  /** The smoothed map's RMS (refit residual of the latest accepted frame), table px. */
  rms: number | null
  installedAt: number | null
  installs: number
}

interface Anchors {
  /** Learned table px corners of each printed marker, from projected-marker fits. */
  markers: Record<string, Corners>
  learnedAt: string
}

/**
 * Per source: fit, smooth, gate, install. Also learns where the printed
 * markers lie (anchors) while projected markers are up, so later frames can
 * localize from the printed ones alone.
 */
export function createLocalizer(d: {
  surface: { widthPx: number; heightPx: number }
  /** Install a camera map for a source. The spatial calibration owns it from here. */
  install(source: string, value: CameraRegistration): void
  /** The map the calibration holds for a source now (null: none). */
  installed(source: string): CameraRegistration | null
  anchorsFile?: string
  now?: () => number
  /**
   * Tests only: the per-frame fitter. The RMS gate below sits behind
   * fitMarkers' own inlier vote (INLIER_PX), and through that vote no
   * frame we could build reached an RMS above MAX_RMS (pair fits reject
   * the noisy markers first): removing the gate survived every test
   * (Codex review of #95, finding 8). The gate still matters, for a frame
   * with few markers whose errors the pairs can't separate, so it is
   * tested here directly with a fitter that reports such a fit.
   */
  fit?: typeof fitMarkers
}) {
  const now = d.now ?? (() => Date.now())
  const fit1 = d.fit ?? fitMarkers
  const gridPts = grid(d.surface)
  const projected = new Map(projectedMarkers(d.surface).map((m) => [m.id, m.corners]))
  let anchors: Anchors | null = null
  if (d.anchorsFile && existsSync(d.anchorsFile)) {
    try {
      const a = JSON.parse(readFileSync(d.anchorsFile, 'utf8')) as Anchors
      if (a && typeof a.markers === 'object') anchors = a
    } catch {
      // A torn or hand-edited file: no anchors, which a reference run re-learns.
    }
  }
  // While projected markers are on the table (a reference run), their ids
  // are valid targets. Outside one, a "projected" id in view is not ours
  // (nothing is drawing it), so it must not pull the fit.
  let projecting = false
  // Samples of each printed marker's table corners during the current run.
  let learning = new Map<number, Corners[]>()
  const states = new Map<string, SourceState & { smooth: Point[] | null; geometry: string; session: string | undefined }>()

  const targets = (): Map<number, Corners> => {
    const t = new Map<number, Corners>()
    if (projecting) for (const [id, c] of projected) t.set(id, c)
    for (const id of PHYSICAL_IDS) {
      const c = anchors?.markers[String(id)]
      if (c) t.set(id, c)
    }
    return t
  }

  const stateOf = (source: string) => {
    let s = states.get(source)
    if (!s) states.set(source, (s = { last: null, confirmed: 0, rms: null, installedAt: null, installs: 0, smooth: null, geometry: '', session: undefined }))
    return s
  }

  return {
    /** One frame of markers from one source. Returns that source's state after it. */
    frame(f: MarkerFrame): SourceState {
      const s = stateOf(f.source)
      const at = now()
      // A different camera geometry is a different camera as far as a map
      // goes: never blend a 1280×720 pose into a 1920×1080 one.
      // Likewise a new producer session (review of #95, finding 4): a
      // reloaded iPad page (or a second tab claiming to be the iPad) must
      // earn its own CONFIRM frames, not inherit the old session's votes.
      if (s.geometry !== `${f.geometry}:${f.width}x${f.height}` || s.session !== f.session) {
        s.geometry = `${f.geometry}:${f.width}x${f.height}`
        s.session = f.session
        s.smooth = null
        s.confirmed = 0
      }
      const fit = fit1(f.markers, targets(), d.surface)
      s.last = { at, ok: fit.ok, rms: fit.ok ? fit.rms : (fit.rms ?? null), markers: fit.markers, rejected: fit.rejected, error: fit.ok ? null : fit.error }
      if (!fit.ok || fit.rms > MAX_RMS) {
        if (fit.ok) s.last.error = `rms ${fit.rms.toFixed(1)} table px is above the ${MAX_RMS} px gate`
        return publicState(s)
      }
      // Anchor learning: only from fits that used projected markers, whose
      // positions the layout knows exactly. A fit from anchors alone must
      // not re-learn the anchors (it would only ever confirm itself).
      if (projecting && fit.markers.some((id) => projected.has(id))) {
        for (const m of f.markers) {
          if (!(PHYSICAL_IDS as readonly number[]).includes(m.id)) continue
          const table = m.corners.map((c) => apply(fit.h, c)) as Corners
          const list = learning.get(m.id) ?? []
          list.push(table)
          learning.set(m.id, list.slice(-30))
        }
      }
      // Smoothing on positions, not matrix entries: where the grid points
      // appear in the camera is what moves when the camera moves, and a
      // homography's nine numbers don't average into a homography between two.
      const inv = inverse(fit.h)!
      const seenGrid = gridPts.map((g) => apply(inv, g))
      if (s.smooth) {
        const prev = solveHomography(s.smooth.map((c, i) => ({ from: c, to: gridPts[i]! })))
        if (mapDistance(prev, fit.h, d.surface) > RESET_PX) {
          s.smooth = null
          s.confirmed = 0
        }
      }
      s.smooth = s.smooth ? s.smooth.map((c, i) => ({ x: c.x + ALPHA * (seenGrid[i]!.x - c.x), y: c.y + ALPHA * (seenGrid[i]!.y - c.y) })) : seenGrid
      s.confirmed++
      s.rms = fit.rms
      if (s.confirmed < CONFIRM) return publicState(s)
      const h = solveHomography(s.smooth.map((c, i) => ({ from: c, to: gridPts[i]! })))
      const current = d.installed(f.source)
      const sameFrame = current && current.width === f.width && current.height === f.height && current.geometry === f.geometry
      if (!sameFrame || mapDistance(current.h, h, d.surface) >= SWITCH_PX) {
        d.install(f.source, { h, width: f.width, height: f.height, geometry: f.geometry })
        s.installedAt = at
        s.installs++
      }
      return publicState(s)
    },
    /** Start or end a reference run (projected markers on the table). Ending one saves what it learned. */
    setProjecting(on: boolean) {
      if (on === projecting) return
      projecting = on
      if (on) {
        learning = new Map()
        return
      }
      const learned: Record<string, Corners> = { ...(anchors?.markers ?? {}) }
      let changed = false
      for (const [id, samples] of learning) {
        // Three agreeing frames at least; one frame's corners are not an anchor.
        if (samples.length < 3) continue
        const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
        learned[String(id)] = [0, 1, 2, 3].map((k) => ({ x: med(samples.map((c) => c[k]!.x)), y: med(samples.map((c) => c[k]!.y)) })) as Corners
        changed = true
      }
      learning = new Map()
      if (!changed) return
      anchors = { markers: learned, learnedAt: new Date(now()).toISOString() }
      if (d.anchorsFile) {
        // Same write discipline as the registration file: a torn write must
        // not destroy the last good anchors.
        mkdirSync(dirname(d.anchorsFile), { recursive: true })
        writeFileSync(`${d.anchorsFile}.tmp`, JSON.stringify(anchors, null, 1))
        renameSync(`${d.anchorsFile}.tmp`, d.anchorsFile)
      }
    },
    projecting: () => projecting,
    anchors: () => (anchors ? structuredClone(anchors) : null),
    state: () => Object.fromEntries([...states].map(([k, s]) => [k, publicState(s)])) as Record<string, SourceState>,
    /** For tests and the anchors route: which ids the fit would accept right now. */
    targetIds: () => [...targets().keys()],
  }
}

function publicState(s: SourceState): SourceState {
  return { last: s.last ? { ...s.last } : null, confirmed: s.confirmed, rms: s.rms, installedAt: s.installedAt, installs: s.installs }
}

export type Localizer = ReturnType<typeof createLocalizer>
export const ALL_MARKER_IDS = [...PROJECTED_IDS, ...PHYSICAL_IDS]
