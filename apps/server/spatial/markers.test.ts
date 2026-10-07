import { readFileSync } from 'node:fs'
import { apply, decode, type H } from '@hubble/room'
import { DEFAULT_SURFACE } from '@hubble/stage'
import { describe, expect, it } from 'vitest'
import { createMarkerDetector, markerBits } from '../../shared/markers/detect.ts'
import { CELL_PX, MARKER_CELLS, QUIET_CELLS, markerShapes, projectedMarkers, square, type Corners, type Marker } from '../../shared/markers/layout.ts'
import { inverse } from './coordinates.ts'
import { createLocalizer, fitMarkers, MAX_RMS } from './localize.ts'
import type { CameraRegistration } from './calibration.ts'
import { createSpatialService, MARKER_MIN_INTERVAL_MS } from './service.ts'
import { MarkerObservation } from './observations.ts'

/**
 * Reference markers, detected and fitted (#91).
 *
 * Fixtures: `fixtures/markers-2026-10-07/`, label **mechanical mutation of a
 * recording**: the recorded room frame `calibration-2026-10-07/off.jpg` with
 * markers composited by cv2 (scripts/markers-fixtures.py) at the camera map
 * the recorded dot run fits. The oracle is that map and cv2's own marker
 * bits, both in the manifest: never this code's detector, layout bits or fit.
 */
const dir = new URL('../fixtures/markers-2026-10-07/', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('manifest.json', dir), 'utf8')) as {
  projected: Marker[]
  anchors: { id: number; x: number; y: number }[]
  bits: Record<string, string>
  frames: { name: string; width: number; height: number; cameraToTable: H; expect: { ids: number[]; outlier?: number } }[]
}
const detector = createMarkerDetector()
const frame = (name: string) => decode(new Uint8Array(readFileSync(new URL(`${name}.jpg`, dir))))
const detected = new Map(manifest.frames.map((f) => [f.name, detector.detect(frame(f.name))]))
const truthOf = (name: string) => manifest.frames.find((f) => f.name === name)!
const physicalSide = 60 / DEFAULT_SURFACE.mmPerPx
const anchorTargets = () => new Map<number, Corners>(manifest.anchors.map((a) => [a.id, square(a.x, a.y, physicalSide)]))
const allTargets = () => {
  const t = anchorTargets()
  for (const m of manifest.projected) t.set(m.id, m.corners)
  return t
}

/** Worst error, table px, at the 12 projected marker centres: where the truth map and a fitted map disagree. Plain arithmetic, oracle side. */
function worstError(fitted: H, truth: H): number {
  const toCamera = inverse(truth)!
  return Math.max(...manifest.projected.map((m) => {
    const c = { x: (m.corners[0].x + m.corners[2].x) / 2, y: (m.corners[0].y + m.corners[2].y) / 2 }
    const p = apply(fitted, apply(toCamera, c))
    return Math.hypot(p.x - c.x, p.y - c.y)
  }))
}

// Pinned per variant, as measured on 2026-10-07. A detector change that
// finds fewer markers must fail loudly here before it fails on the table.
// q40 (heavy JPEG) loses 3 of 12 on bit errors: kept as the stress case.
const FOUND: Record<string, number[]> = {
  projected: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  'projected-q40': [1, 3, 4, 5, 6, 7, 8, 9, 11],
  'projected-occluded': [0, 1, 2, 3, 4, 7, 8, 9, 10, 11],
  physical: [40, 41, 42, 43],
  'projected-physical': [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 40, 41, 42, 43],
  'physical-moved': [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 40, 41, 42, 43],
  'ipad-oblique': [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 40, 41, 42, 43],
}

describe('the marker corpus', () => {
  it('has every variant and finds the pinned markers in each', () => {
    // Break caught: a shrinking corpus, or a detector regression (a
    // dictionary on the wrong module instance finds nothing at all).
    expect(manifest.frames.map((f) => f.name).sort()).toEqual(Object.keys(FOUND).sort())
    for (const f of manifest.frames) expect(detected.get(f.name)!.map((m) => m.id).sort((a, b) => a - b), f.name).toEqual(FOUND[f.name])
  })
})

describe('the camera map from markers', () => {
  it('recovers the true map within half a table px on every variant', () => {
    // Break caught (1): corners off by the contour's pixel-index bias.
    // Without the subpixel edge refinement (detect.ts refineCorners) the
    // corners sit 1–2 camera px off, 7 of 12 markers are voted out as
    // outliers and the map is 7–9 px wrong at the markers (measured before
    // the fix). Break caught (2): corners reported in pixel-centre
    // coordinates while hands and dots use pixel edges: every map half a
    // camera pixel (~0.6–0.8 table px here) off.
    for (const f of manifest.frames) {
      const fit = fitMarkers(detected.get(f.name)!, allTargets(), DEFAULT_SURFACE)
      expect(fit.ok, `${f.name}: ${fit.ok ? '' : fit.error}`).toBe(true)
      if (!fit.ok) continue
      expect(fit.rms, f.name).toBeLessThan(MAX_RMS)
      expect(worstError(fit.h, f.cameraToTable), f.name).toBeLessThan(0.5)
      if (!f.expect.outlier) expect(fit.rejected, f.name).toEqual([])
    }
  })

  it('drops a printed marker that moved since its anchor was learned', () => {
    // Break caught: a fit over every marker (no consensus vote). Marker 42
    // moved 150 table px; included, it drags the whole map by several px
    // and the RMS still looks plausible because 15 other markers agree.
    const f = truthOf('physical-moved')
    const fit = fitMarkers(detected.get(f.name)!, allTargets(), DEFAULT_SURFACE)
    expect(fit.ok).toBe(true)
    if (!fit.ok) return
    expect(fit.rejected).toEqual([42])
    expect(worstError(fit.h, f.cameraToTable)).toBeLessThan(2)
  })

  it('refuses markers bunched in one strip', () => {
    // Break caught: the spread check removed. One row of four markers fits
    // a plane exactly along the row and arbitrarily across it, with a tiny
    // RMS: a confident wrong map.
    const row = detected.get('projected')!.filter((m) => m.id <= 3)
    const fit = fitMarkers(row, allTargets(), DEFAULT_SURFACE)
    expect(fit.ok).toBe(false)
  })

  it('localizes from printed markers alone once their anchors are known', () => {
    const fit = fitMarkers(detected.get('physical')!, anchorTargets(), DEFAULT_SURFACE)
    expect(fit.ok).toBe(true)
    if (fit.ok) expect(worstError(fit.h, truthOf('physical').cameraToTable)).toBeLessThan(2)
  })
})

describe('the projected marker layout', () => {
  it('keeps every marker and its lit margin on the surface, apart from the others', () => {
    // Break caught: a marker half off the page is never seen, and two
    // overlapping lit margins merge into one blob that hides both borders.
    // Oracle: rectangle arithmetic on the surface size.
    const ms = projectedMarkers(DEFAULT_SURFACE)
    expect(ms.map((m) => m.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    const m = CELL_PX * QUIET_CELLS
    const boxes = ms.map((k) => ({ x0: k.corners[0].x - m, y0: k.corners[0].y - m, x1: k.corners[2].x + m, y1: k.corners[2].y + m }))
    for (const b of boxes) {
      expect(b.x0).toBeGreaterThanOrEqual(0)
      expect(b.y0).toBeGreaterThanOrEqual(0)
      expect(b.x1).toBeLessThanOrEqual(DEFAULT_SURFACE.widthPx)
      expect(b.y1).toBeLessThanOrEqual(DEFAULT_SURFACE.heightPx)
      expect(b.x1 - b.x0).toBe(CELL_PX * (MARKER_CELLS + 2 * QUIET_CELLS))
    }
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!
        const b = boxes[j]!
        expect(a.x1 <= b.x0 || b.x1 <= a.x0 || a.y1 <= b.y0 || b.y1 <= a.y0).toBe(true)
      }
  })

  it('draws each marker with the bits cv2 renders for its id', () => {
    // Break caught: a transposed or mirrored bit order in markerShapes. The
    // projected marker would decode as a different id (or none), and the
    // fit would place it at another marker's position. Oracle: cv2's bits.
    const ms = projectedMarkers(DEFAULT_SURFACE)
    const shapes = markerShapes(ms, markerBits())
    for (const m of ms) {
      const x0 = m.corners[0].x
      const y0 = m.corners[0].y
      const drawn = Array.from({ length: 16 }, (_, k) => {
        const cx = x0 + CELL_PX * (1.5 + (k % 4))
        const cy = y0 + CELL_PX * (1.5 + Math.floor(k / 4))
        // The last shape painted over the cell's centre decides its colour.
        const top = shapes.filter((s) => s.points[0]!.x <= cx && cx <= s.points[2]!.x && s.points[0]!.y <= cy && cy <= s.points[2]!.y).at(-1)
        return top?.color === '#ffffff' ? '1' : '0'
      }).join('')
      expect(drawn, `marker ${m.id}`).toBe(manifest.bits[String(m.id)])
    }
  })
})

describe('the localizer over a stream of frames', () => {
  const setup = () => {
    let t = 0
    const maps = new Map<string, CameraRegistration>()
    const installs: string[] = []
    const loc = createLocalizer({
      surface: DEFAULT_SURFACE,
      now: () => (t += 100),
      installed: (s) => maps.get(s) ?? null,
      install: (s, v) => {
        maps.set(s, v)
        installs.push(s)
      },
    })
    const send = (name: string, source = 'room', jitter = 0) => {
      const f = truthOf(name)
      const markers = detected.get(name)!.map((m, i) => ({ id: m.id, corners: m.corners.map((c, k) => ({ x: c.x + jitter * Math.sin(i * 7 + k), y: c.y + jitter * Math.cos(i * 3 + k) })) as Corners }))
      return loc.frame({ source, width: f.width, height: f.height, geometry: name === 'ipad-oblique' ? 'ipad:1280x720' : 'room:full-frame', markers })
    }
    return { loc, maps, installs, send }
  }

  it('installs once after three agreeing frames, and not again for noise', () => {
    // Break caught (1): installing on the first frame lets one fluke become
    // the map. Break caught (2): the switch threshold removed. Every install
    // bumps the calibration revision, and pinch typing's grant is bound to
    // it: re-installing "the same map ±0.3 px" every frame cancels every
    // press mid-word (keyboardInput.ts).
    const { loc, maps, installs, send } = setup()
    loc.setProjecting(true)
    send('projected')
    send('projected')
    expect(installs).toEqual([])
    send('projected')
    expect(installs).toEqual(['room'])
    expect(worstError(maps.get('room')!.h, truthOf('projected').cameraToTable)).toBeLessThan(2)
    for (let i = 0; i < 10; i++) send('projected', 'room', 0.4)
    expect(installs).toEqual(['room'])
  })

  it('keeps each source on its own map', () => {
    // Break caught: one map for every camera. The iPad's pose applied to
    // the room camera's pixels (or the reverse) puts a fingertip metres off.
    const { loc, maps, send } = setup()
    loc.setProjecting(true)
    for (let i = 0; i < 3; i++) {
      send('projected', 'room')
      send('ipad-oblique', 'ipad')
    }
    expect(worstError(maps.get('room')!.h, truthOf('projected').cameraToTable)).toBeLessThan(2)
    expect(worstError(maps.get('ipad')!.h, truthOf('ipad-oblique').cameraToTable)).toBeLessThan(2)
    expect(maps.get('ipad')!.width).toBe(1280)
  })

  it('learns the printed anchors from a reference run, then localizes from them alone', () => {
    // Break caught (1): anchors never learned (or learned from anchor-only
    // fits, which can only confirm themselves). Break caught (2): projected
    // ids trusted when nothing is projecting: they must stop counting the
    // moment the run ends.
    const { loc, maps, send } = setup()
    expect(send('physical').last!.ok).toBe(false)
    loc.setProjecting(true)
    for (let i = 0; i < 4; i++) send('projected-physical')
    loc.setProjecting(false)
    const learned = loc.anchors()!.markers
    for (const a of manifest.anchors) {
      const c = learned[String(a.id)]!
      const mid = { x: (c[0].x + c[2].x) / 2, y: (c[0].y + c[2].y) / 2 }
      expect(Math.hypot(mid.x - a.x, mid.y - a.y), `anchor ${a.id}`).toBeLessThan(2)
    }
    expect(loc.targetIds().sort((a, b) => a - b)).toEqual([40, 41, 42, 43])
    maps.clear()
    for (let i = 0; i < 3; i++) send('physical')
    expect(worstError(maps.get('room')!.h, truthOf('physical').cameraToTable)).toBeLessThan(2)
  })

  it('never re-learns an anchor from a fit made of anchors alone', () => {
    // Break caught: learning from any accepted fit. A run where the
    // projector isn't showing our page fits from the printed markers only;
    // learning from that, a moved marker (42, 150 px away) would be written
    // back as its own new truth, and the anchors would drift with every
    // bump of the table, unchecked by anything the layout knows.
    const { loc, send } = setup()
    loc.setProjecting(true)
    for (let i = 0; i < 4; i++) send('projected-physical')
    loc.setProjecting(false)
    const before = loc.anchors()!.markers['42']
    const moved = detected.get('physical-moved')!.filter((m) => m.id >= 40)
    loc.setProjecting(true)
    for (let i = 0; i < 4; i++) {
      const r = loc.frame({ source: 'room', width: 1920, height: 1080, geometry: 'room:full-frame', markers: moved })
      expect(r.last!.ok).toBe(true)
      expect(r.last!.rejected).toEqual([42])
    }
    loc.setProjecting(false)
    expect(loc.anchors()!.markers['42']).toEqual(before)
  })
})

describe('the RMS gate', () => {
  it('reports a fit above MAX_RMS but never installs it', () => {
    // Label: synthetic. The fitter is replaced (createLocalizer's test seam)
    // by one that returns a real fit of the 'projected' frame with its RMS
    // overstated to MAX_RMS + 1: no recorded or mutated frame reaches the
    // gate through fitMarkers' inlier vote (localize.ts says why). Oracle:
    // the install callback's count. Break caught (review of #95, finding 8;
    // that mutant survived every test): the `fit.rms > MAX_RMS` gate
    // removed, so a loose fit becomes the camera map after three frames.
    const installs: string[] = []
    const loose: typeof fitMarkers = (seen, targets, surface) => {
      const f = fitMarkers(seen, targets, surface)
      return f.ok ? { ...f, rms: MAX_RMS + 1 } : f
    }
    const loc = createLocalizer({ surface: DEFAULT_SURFACE, now: () => 0, installed: () => null, install: (s) => installs.push(s), fit: loose })
    loc.setProjecting(true)
    const f = truthOf('projected')
    let last = null as ReturnType<typeof loc.frame>['last']
    for (let n = 0; n < 6; n++) last = loc.frame({ source: 'room', width: f.width, height: f.height, geometry: 'room:full-frame', markers: detected.get('projected')! }).last
    expect(last!.ok).toBe(true)
    expect(last!.error).toMatch(/gate/)
    expect(installs).toEqual([])
    // The control: the same frames through the real fitter do install.
    const ok: string[] = []
    const real = createLocalizer({ surface: DEFAULT_SURFACE, now: () => 0, installed: () => null, install: (s) => ok.push(s) })
    real.setProjecting(true)
    for (let n = 0; n < 6; n++) real.frame({ source: 'room', width: f.width, height: f.height, geometry: 'room:full-frame', markers: detected.get('projected')! })
    expect(ok.length).toBeGreaterThan(0)
  })
})

describe('marker ingestion (review of #95, finding 4)', () => {
  // Detections of the recorded-and-composited 'projected' frame; the
  // service's injected clock. Oracle: what the service accepts and whether
  // the calibration holds a room map, never the localizer's internals.
  const setup = () => {
    let t = 0
    const s = createSpatialService({ now: () => t })
    s.setProjecting(true)
    const f = truthOf('projected')
    const send = (session: string, seq: number, markers = detected.get('projected')!) => {
      t += MARKER_MIN_INTERVAL_MS
      return s.markers({ source: 'room', session, seq, geometry: 'room:full-frame', width: f.width, height: f.height, markers })
    }
    return { s, send, tick: (ms: number) => (t += ms) }
  }

  it('refuses duplicate ids, on the wire and in the fit', () => {
    // Break caught: [11, 0, 11] counted as three markers. Two real markers
    // and a copy would pass the three-marker minimum and vote twice. Two
    // guards, each with its own check: the schema (iPad route) and the fit
    // (the server's own room pass, which never goes through the schema).
    const corners = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]
    const wire = { source: 'ipad', session: 's', seq: 1, geometry: 'ipad:1280x720', width: 1280, height: 720 }
    expect(MarkerObservation.safeParse({ ...wire, markers: [11, 0, 11].map((id) => ({ id, corners })) }).success).toBe(false)
    expect(MarkerObservation.safeParse({ ...wire, markers: [11, 0, 1].map((id) => ({ id, corners })) }).success).toBe(true)
    const ms = detected.get('projected')!
    const three = [ms.find((m) => m.id === 0)!, ms.find((m) => m.id === 11)!]
    expect(fitMarkers([three[0]!, three[1]!, three[1]!], allTargets(), DEFAULT_SURFACE).ok).toBe(false)
    const { s, send } = setup()
    for (let i = 1; i <= 5; i++) {
      const r = send('a', i, [...ms, ms[0]!])
      expect(r.ok && r.state.last!.ok).toBe(false)
    }
    expect(s.calibration.cameraFor('room')).toBeNull()
    s.stop()
  })

  it('restarts confirmation when the producer session changes', () => {
    // Break caught: a reloaded (or second) producer inheriting the old
    // session's confirmation votes, so its very first frame installs.
    const { s, send } = setup()
    send('a', 1)
    send('a', 2)
    const r = send('b', 1)
    expect(r.ok && r.state.confirmed).toBe(1)
    s.stop()
  })

  it('refuses a replay from an earlier session, and a non-progressing seq', () => {
    // Break caught: progress kept for the latest session only, so
    // alternating a → b → a replays a's old frames as new votes.
    const { s, send } = setup()
    expect(send('a', 5).ok).toBe(true)
    expect(send('a', 5).ok).toBe(false)
    expect(send('b', 1).ok).toBe(true)
    const replay = send('a', 3)
    expect(replay.ok).toBe(false)
    expect(!replay.ok && replay.reason).toBe('stale')
    expect(send('a', 6).ok).toBe(true)
    s.stop()
  })

  it('accepts at most one frame per source per MARKER_MIN_INTERVAL_MS', () => {
    // Break caught: no rate limit on a LAN-open route whose every frame
    // costs a RANSAC over up to 120 marker pairs.
    const { s, send, tick } = setup()
    expect(send('a', 1).ok).toBe(true)
    tick(-MARKER_MIN_INTERVAL_MS + 10) // the next send lands 10 ms after the last
    const r = send('a', 2)
    expect(!r.ok && r.reason).toBe('rate')
    expect(send('a', 3).ok).toBe(true)
    s.stop()
  })
})
